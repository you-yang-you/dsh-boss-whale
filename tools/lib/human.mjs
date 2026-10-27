/**
 * 虚拟人浏览 —— 用真实的有头浏览器把岗位「看」回来。
 *
 * ── 为什么必须这么做 ─────────────────────────────────────────────
 * BOSS 的 joblist 接口不接受「浏览器里的 cookie 拿到 node 里回放」：
 *   · __zp_stoken__ 由页面 JS 生成，并和环境绑在一起；
 *   · node 直连没有 webdriver/UA/字体/WebGL 这些它要校验的东西；
 *   · 结果就是 code 37「您的环境存在异常」，换个 UA 也没用（实测过）。
 * 而且 headless 更糟：navigator.webdriver=true、UA 里带 HeadlessChrome，
 * 一进去就是 37，紧接着还会把 IP 也带进 35「IP地址存在异常行为」。
 *
 * 所以这里不抓接口，做的是一个"人"该做的事：
 *   打开浏览器 → 打开搜索页 → 慢慢往下滚 → 停一会儿 → 偶尔点开一个岗位看 →
 *   返回 → 记下看到的卡片 → 关窗口。
 * 节奏参数（滚动步长 / 停留时间 / 每次看几个）都在 cfg.human 里，可调慢不可调快。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 * · 只读：不点「立即沟通」，不投简历，不填任何表单。
 * · 一旦页面出现验证/异常，立刻停手并返回 risk，交给上层冷却。
 * · 每次跑完一定关窗口：留着调试端口等于给本机任何程序开了读账号的后门。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cdpConnect } from '../../lib/cdp.mjs'
import { locateBrowser } from '../../lib/browser-login.js'
import { BOSS_HOME, ensureDir } from './paths.mjs'
import { resolveCityCode } from './config.mjs'

const ORIGIN = 'https://www.zhipin.com'
const PORT_FILE = 'DevToolsActivePort'
const ATTACH_TIMEOUT_MS = 30_000

/**
 * 启动参数。
 * 关键是**没有 --headless**，以及关掉 AutomationControlled ——
 * 否则 navigator.webdriver 会是 true，等于举手说"我是脚本"。
 */
const ARGS = [
  '--remote-debugging-port=0',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-sync',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
]

/** 页面里出现这些词，说明不是"没岗位"，而是被拦了 */
const RISK_WORDS = ['环境存在异常', 'IP地址存在异常', '安全验证', '请完成验证', '访问受限', '操作过于频繁', '异常行为']
const CAPTCHA_WORDS = ['滑块', '拖动滑块', '完成验证', '人机验证', 'captcha']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (min, max) => min + Math.random() * Math.max(0, max - min)

/** 从 DevToolsActivePort 读真实端口 */
function readPortFile(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, PORT_FILE), 'utf8').split(/\r?\n/)
    const port = Number(lines[0])
    if (!Number.isFinite(port) || port <= 0) return null
    return { port, wsPath: (lines[1] ?? '').trim() }
  } catch { return null }
}

export function buildSearchPageUrl(cfg, keyword) {
  const city = resolveCityCode(cfg)
  const kw = String(keyword ?? (cfg?.search?.keywords ?? [])[0] ?? '')
  const params = new URLSearchParams({ query: kw })
  if (city.code) params.set('city', city.code)
  return { url: `${ORIGIN}/web/geek/job?${params.toString()}`, city, keyword: kw }
}

/**
 * 页面内提取器 —— 这一段是 `Runtime.evaluate` 的源码字符串，跑在页面里。
 *
 * 为什么不用固定的 class 选择器：BOSS 的 class 名改过好几轮，
 * 写死一个 `.job-card-wrapper` 哪天失效了就"抓到 0 条"，而且看起来像"今天没新岗位"。
 * 所以先用结构化的取，取不到就退到"凡是链接里带 /job_detail/ 的都算一张卡片"。
 */
const EXTRACT_SRC = `(() => {
  const txt = (el) => (el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const abs = (h) => { try { return new URL(h, location.origin).href } catch { return '' } }
  const out = []
  const push = (o) => { if (o && o.url && out.every((x) => x.url !== o.url)) out.push(o) }

  // ① 结构化：优先 class 语义，其次任意 li 里带 job_detail 链接
  const cards = Array.from(document.querySelectorAll(
    'li.job-card-wrapper, li.job-card-box, .job-list-box > li, .job-list > li'
  ))
  for (const li of cards) {
    const a = li.querySelector('a[href*="/job_detail/"]') || li.querySelector('a[href]')
    if (!a) continue
    const pick = (...sels) => {
      for (const s of sels) { const el = li.querySelector(s); if (el && txt(el)) return txt(el) }
      return ''
    }
    const tags = Array.from(li.querySelectorAll('.tag-list li, .job-card-footer .tag-list span, .job-label-list span'))
      .map(txt).filter(Boolean).slice(0, 8)
    push({
      name: pick('.job-name', '.job-title', 'span[class*="job-name"]'),
      salaryDesc: pick('.salary', 'span[class*="salary"]'),
      brand: pick('.company-name', '.boss-name', 'h3[class*="company"]', 'span[class*="company-name"]'),
      city: pick('.job-area', 'span[class*="job-area"]'),
      tags,
      boss: pick('.info-public em', '.boss-info', 'span[class*="boss"]'),
      url: abs(a.getAttribute('href')),
      text: txt(li).slice(0, 300),
    })
  }

  // ② 兜底：直接扫所有岗位详情链接，用最近的容器当卡片
  if (!out.length) {
    for (const a of Array.from(document.querySelectorAll('a[href*="/job_detail/"]'))) {
      const box = a.closest('li') || a.closest('div[class*="card"]') || a.parentElement
      const t = txt(box || a)
      if (!t) continue
      push({ name: '', salaryDesc: '', brand: '', city: '', tags: [], boss: '', url: abs(a.getAttribute('href')), text: t.slice(0, 300) })
    }
  }
  return {
    count: out.length,
    items: out.slice(0, 60),
    title: document.title,
    bodyText: txt(document.body).slice(0, 1500),
    url: location.href,
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }
})()`

/** 判页面是不是被拦了 / 是不是掉登录了 */
export function readPageVerdict(page) {
  if (!page) return { kind: 'unknown', message: '页面没读出内容' }
  const body = String(page.bodyText ?? '')
  const url = String(page.url ?? '')
  const count = Number(page.count ?? 0)

  // 已经读到卡片就当成正常页面。
  // 理由：这些词偶尔会出现在广告位、页脚、客服话术里，一旦"看到关键词就停工"，
  // 就会出现"明明抓到了 20 条却报风控"的假警报 —— 那比漏判更让人不敢用。
  if (count > 0) return { kind: 'ok', message: '' }

  const hitCaptcha = CAPTCHA_WORDS.find((w) => body.includes(w))
  if (hitCaptcha && !/登录|注册/.test(body)) {
    return { kind: 'captcha', message: `页面要人机验证（出现「${hitCaptcha}」）` }
  }
  const hitRisk = RISK_WORDS.find((w) => body.includes(w))
  if (hitRisk) {
    const ip = /IP/.test(hitRisk)
    return { kind: ip ? 'ip-risk' : 'env-risk', message: `页面直接写「${hitRisk}」` }
  }
  if (/\/web\/user|login|passport/.test(url)) {
    return { kind: 'auth', message: '被重定向到登录页：登录态掉了' }
  }
  if (/登录|注册/.test(body) && /扫码|验证码/.test(body)) {
    return { kind: 'auth', message: '页面要求登录（登录态大概率失效）' }
  }
  return { kind: 'ok', message: '' }
}

/**
 * 2026-10-27：卡片的 `.tag-list` 里混着两类东西 —— 【任职要求】和【技术标签】。
 *   以前直接拿前 4 个当 skills → 招呼语写成「技术栈上 经验不限、学历不限 我都用过」这种鬼话 ✗
 *   这里只留像技术名词的那些，要求类的一个都不要。
 */
const NOT_TECH = /不限|学历|大专|本科|硕士|博士|中专|高中|初中|在校|应届|\d+年|招\d+人|\d+人|不要\d+|\d+小时|大小周|倒班|值班|出差|加班|五险一金|双休|单休|弹性|包吃|包住|餐补|房补|补贴|年终|绩效|提成|带薪|体检|旅游|培训|晋升|出国|节日|福利|生日|通勤|试用期|急招|面议|全职|兼职|实习|辞职|离职/
export function isTechLabel(value) {
  const v = String(value ?? '').trim()
  if (!v || v.length > 12) return false
  if (NOT_TECH.test(v)) return false
  if (/^[\d\s·、,，]+$/.test(v)) return false
  return /[A-Za-z]/.test(v) || v.length <= 6
}

/**
 * BOSS 把薪资里的数字编成自定义字体的私用区字符（U+E000–U+F8FF），
 * DOM 里读出来是乱码（页面上看着正常）。没法安全还原 → 宁可空着，
 * 也别让招呼语念出「薪资范围  -K 与我的预期接近」✗
 */
export function cleanSalary(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  return /\d/.test(v) ? v : ''
}

/** 一张卡片的长相 → 我们的 job 结构（缺的字段留给上层 normalize 补） */
export function cardToRaw(item) {
  const text = String(item?.text ?? '')
  const salary = (text.match(/\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk千](?:·\d+薪)?/) ?? [''])[0]
  const city = (text.match(/[北京上海广州深圳杭州成都武汉南京西安苏州天津重庆长沙郑州青岛合肥福州济南大连沈阳无锡珠海昆明南昌贵阳石家庄太原长春哈尔滨海口]{2,3}[·\s]?[^\s|]{0,8}/) ?? [''])[0]
  const tags = Array.isArray(item?.tags) ? item.tags : []
  return {
    jobName: item?.name || '',
    brandName: item?.brand || '',
    salaryDesc: cleanSalary(item?.salaryDesc) || cleanSalary(salary) || '',
    cityName: item?.city || city || '',
    jobLabels: tags,
    skills: tags.filter(isTechLabel).slice(0, 4),
    bossName: item?.boss || '',
    url: item?.url || '',
    // 只有 URL 里能拿到 encryptJobId；DOM 里通常没有，交给上层用指纹去重
    encryptJobId: (String(item?.url ?? '').match(/job_detail\/([^./?]+)\.html/) ?? [])[1] ?? '',
  }
}

class HumanSession {
  constructor({ cfg, log, browser = null, launcher = null }) {
    this.cfg = cfg ?? {}
    this.log = log ?? (() => {})
    this.browser = browser ?? locateBrowser()
    this.launcher = launcher          // 测试注入用
    this.child = null
    this.cdp = null
    this.port = null
    this.profileDir = path.join(BOSS_HOME, 'browser-profile')
    this.startedAt = 0
    this.steps = []
  }

  get human() {
    const h = this.cfg.human ?? {}
    return {
      visible: h.visible !== false,           // 默认真的有窗口（有头才会被人当人）
      offscreen: h.offscreen === true,
      dwellMs: Number(h.dwellSec ?? 8) * 1000,
      scrollSteps: Math.min(12, Math.max(2, Number(h.scrollSteps ?? 5))),
      peek: Math.min(3, Math.max(0, Number(h.peekPerRun ?? 1))),
      slow: h.slow !== false,
      handoff: h.handoff !== false,           // 撞到验证时把方向盘交给人
      handoffWaitSec: Math.min(900, Math.max(30, Number(h.handoffWaitSec ?? 180))),
      handoffPollMs: Math.max(100, Number(h.handoffPollMs ?? 3000)),
    }
  }

  /**
   * 撞到人机验证时，把方向盘交回给人。
   *
   * 这是整套设计里唯一"必须有人在场"的环节，也是它跟普通爬虫最重要的区别：
   * 爬虫撞到验证只有两条路 —— 硬刚（找死）或放弃（永远拿不到数据）。
   * 而一个"虚拟人"可以抬手让真人过一下验证，然后接着干。
   *
   * 只做等待和观察，不做任何点击/拖动 —— 自动过验证属于绕过风控，不碰。
   */
  async waitForHuman(verdict, waitSec) {
    this.log('')
    this.log(`⚠️ 浏览器窗口里要求验证：${verdict.message}`)
    this.log(`   请在窗口里手动过一下（拖滑块 / 扫码登录都行）。我每 3 秒看一眼，最多等 ${Math.round(waitSec / 60 * 10) / 10} 分钟。`)
    this.log('   过完就自动继续；不想等了直接关窗口，我会当作收工。')
    const deadline = Date.now() + waitSec * 1000
    const pollMs = this.human.handoffPollMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      let page = null
      try { page = await this.evaluate(EXTRACT_SRC) } catch { return { recovered: false, message: '浏览器已被关掉' } }
      const v = readPageVerdict(page)
      if (v.kind === 'ok' && Number(page?.count ?? 0) > 0) {
        this.log(`   ✓ 验证过了，读到 ${page.count} 张卡片，继续。`)
        return { recovered: true, page }
      }
      if (v.kind === 'auth') {
        this.log('   页面跳到了登录页 —— 如果登录完了，等下会自动继续。')
      }
    }
    return { recovered: false, message: `等了 ${waitSec} 秒还没过验证` }
  }

  /** 人的"想一下"：慢模式下 1.5–4 秒，快模式 0.6–1.4 秒 */
  async think(scale = 1) {
    const h = this.human
    const base = h.slow ? jitter(1500, 4000) : jitter(600, 1400)
    await sleep(Math.round(base * scale))
  }

  async open() {
    if (this.launcher) {
      const h = await this.launcher({ profileDir: this.profileDir })
      this.cdp = h.cdp
      this.port = h.port
      this.child = h.child ?? null
      return
    }
    if (!this.browser) {
      const e = new Error('没找到 Edge/Chrome：装一个，或设 BOSS_WHALE_BROWSER 指向浏览器可执行文件')
      e.code = 'no-browser'
      throw e
    }
    ensureDir(this.profileDir)

    // 先看有没有已经开着的实例。
    // 两种常见情况都会走到这里：① 用户在设置页连点了两次 ② 上次关 DSH 时窗口还留着。
    // 直接再 spawn 一个的结果是"新进程把请求转给旧实例然后自己退出"，调试端口根本不新开，
    // 报错会变成"端口没开"—— 和真正的原因（有窗口没关）毫无关系。
    const existing = readPortFile(this.profileDir)
    if (existing?.port) {
      const alive = await fetch(`http://127.0.0.1:${existing.port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      }).then((r) => r.ok).catch(() => false)
      if (alive) {
        this.log('[虚拟人] 已经有一个浏览器在跑，直接接上它')
        this.port = existing.port
        const list = await (await fetch(`http://127.0.0.1:${existing.port}/json/list`)).json()
        const page = list.find((t) => t.type === 'page' && /zhipin\.com/.test(t.url))
          ?? list.find((t) => t.type === 'page')
        if (!page) throw new Error('已有浏览器里没有可用标签页')
        this.cdp = await cdpConnect(page.webSocketDebuggerUrl)
        await this.cdp.call('Page.enable', {}, { timeoutMs: 10_000 })
        return
      }
    }

    try { fs.rmSync(path.join(this.profileDir, PORT_FILE), { force: true }) } catch {}

    const h = this.human
    const args = [...ARGS, `--user-data-dir=${this.profileDir}`, '--window-size=1280,900']
    if (h.offscreen) args.push('--window-position=-32000,-32000')
    args.push('about:blank')

    this.child = spawn(this.browser.bin, args, { stdio: 'ignore', windowsHide: false })
    this.child.on('error', (e) => this.log(`[虚拟人] 浏览器启动失败：${e.message}`))

    const deadline = Date.now() + ATTACH_TIMEOUT_MS
    let info = null
    while (Date.now() < deadline && !info) {
      await sleep(250)
      info = readPortFile(this.profileDir)
    }
    if (!info) {
      const e = new Error('浏览器起来了但调试端口没开（可能被安全软件拦了，或这个配置目录正被另一个浏览器窗口占用）')
      e.code = 'no-port'
      throw e
    }
    this.port = info.port
    const list = await (await fetch(`http://127.0.0.1:${info.port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && /^about:blank/.test(t.url)) ?? list.find((t) => t.type === 'page')
    if (!page) throw new Error('浏览器里没有可用标签页')
    this.cdp = await cdpConnect(page.webSocketDebuggerUrl)
    await this.cdp.call('Page.enable', {}, { timeoutMs: 10_000 })
    return
  }

  async evaluate(expression, { timeoutMs = 20_000 } = {}) {
    const r = await this.cdp.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, { timeoutMs })
    if (r.exceptionDetails) throw new Error(`页面脚本报错：${r.exceptionDetails.text ?? '未知'}`)
    return r.result?.value
  }

  async goto(url, { waitMs = 2600 } = {}) {
    await this.cdp.call('Page.navigate', { url }, { timeoutMs: 25_000 })
    // 不用 Page.loadEventFired 死等：BOSS 是 SPA，load 之后还要拉数据渲染
    await sleep(waitMs)
    for (let i = 0; i < 8; i += 1) {
      const ready = await this.evaluate(`document.readyState === 'complete' || document.querySelectorAll('a[href*="/job_detail/"]').length > 0`)
      if (ready) break
      await sleep(600)
    }
  }

  /**
   * 像人一样滚动：不是一次跳到底，而是几段小步，中间停。
   * 用 Input.dispatchMouseEvent 发真实滚轮事件，页面拿到的 wheel 事件与手滚一致。
   */
  async scrollLikeHuman() {
    const { scrollSteps } = this.human
    const box = await this.evaluate('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null)
    const x = Math.round((box?.w ?? 1280) * jitter(0.35, 0.65))
    const y = Math.round((box?.h ?? 900) * jitter(0.4, 0.7))
    for (let i = 0; i < scrollSteps; i += 1) {
      const deltaY = Math.round(jitter(260, 640))
      await this.cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0,
      }).catch(() => {})
      this.steps.push({ at: Date.now(), kind: 'scroll', deltaY })
      await sleep(Math.round(jitter(700, 2100)))
      // 偶尔往上回一点：真人会回看，一条直线到底反而像脚本
      if (Math.random() < 0.18) {
        await this.cdp.call('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, deltaX: 0, deltaY: -Math.round(jitter(150, 320)), modifiers: 0,
        }).catch(() => {})
        await sleep(Math.round(jitter(500, 1200)))
      }
    }
  }

  /** 点开一个岗位，看一会儿，再退回来 */
  async peekOne(url) {
    if (!url) return null
    this.log(`[虚拟人] 点开一个岗位看看：${String(url).slice(0, 70)}`)
    const before = await this.cdp.call('Page.getNavigationHistory').catch(() => null)
    await this.goto(url, { waitMs: 2400 })
    await sleep(Math.round(jitter(2500, 6000)))
    await this.scrollLikeHuman()
    await this.think(1.2)
    if (before?.entries?.length) {
      // 用历史回退，而不是再 navigate 一次 —— 页面会以为你是点「返回」回来的
      const idx = Math.max(0, (before.currentIndex ?? 1) - 1)
      await this.cdp.call('Page.navigateToHistoryEntry', { entryId: before.entries[idx].id }).catch(() => {})
      await sleep(Math.round(jitter(1500, 2600)))
    }
    return true
  }

  async close() {
    if (this.child) {
      try { await this.cdp?.call('Browser.close', {}, { timeoutMs: 2500 }) } catch {}
      await sleep(400)
      try { if (!this.child.killed) this.child.kill() } catch {}
    } else {
      // 接的是"本来就开着的"浏览器：只断开调试连接，不关人家的窗口 ——
      // 那不是我们开的，关掉等于替用户丢东西。
      try { this.cdp?.close() } catch {}
    }
    this.cdp = null
    this.child = null
  }
}

/**
 * 跑一轮"浏览"。返回结构刻意和 fetchAll 一致（jobs / errors / ok），
 * 这样上层的去重、打分、日报一行都不用改。
 */
export async function browseForJobs({ cfg, keywords, maxPages, log, browser, launcher, interactive = false }) {
  const started = Date.now()
  const kwList = (Array.isArray(keywords) && keywords.length ? keywords : (cfg?.search?.keywords ?? [])).slice(0, 3)
  const pages = Math.min(3, Math.max(1, Number(maxPages ?? cfg?.human?.pagesPerRun ?? cfg?.search?.pages ?? 2)))
  const session = new HumanSession({ cfg, log, browser, launcher })
  const jobs = []
  const errors = []
  let pagesVisited = 0

  try {
    await session.open()
    for (const kw of kwList) {
      const { url, city } = buildSearchPageUrl(cfg, kw)
      if (!city.code) {
        errors.push({ page: 0, kind: 'config', message: city.error })
        break
      }
      log(`[虚拟人] 打开搜索页：${kw} · ${city.name}`)
      await session.goto(url, { waitMs: 3200 })
      await session.think(0.8)

      const seenUrls = new Set()
      for (let p = 1; p <= pages; p += 1) {
        let page = null
        let blocked = null
        let handovers = 0

        // 同屏最多重看两次：撞到验证 → 交给人 → 过了再读同一屏。
        // 限制次数是为了不出现"人一直不过验证、它一直等"的死循环。
        for (;;) {
          await session.scrollLikeHuman()
          page = await session.evaluate(EXTRACT_SRC).catch((e) => ({ count: 0, bodyText: '', url: '', error: String(e.message) }))
          const verdict = readPageVerdict(page)
          if (verdict.kind === 'ok') break

          const canHand = interactive && session.human.handoff && handovers < 2
            && ['captcha', 'ip-risk', 'env-risk'].includes(verdict.kind)
          if (!canHand) {
            blocked = verdict
            break
          }
          handovers += 1
          const w = await session.waitForHuman(verdict, session.human.handoffWaitSec)
          if (!w.recovered) {
            blocked = { ...verdict, message: `${verdict.message}；${w.message}` }
            break
          }
          // 过了验证后，窗口尺寸/页面可能变了，重新滚一遍再读
          page = await session.evaluate(EXTRACT_SRC).catch(() => null)
          if (page && Number(page.count) > 0) break
        }
        pagesVisited += 1

        if (blocked) {
          errors.push({ page: p, kind: blocked.kind, message: blocked.message, keyword: kw })
          log(`[虚拟人] 停手：${blocked.message}`)
          return { ok: false, jobs, errors, pages: pagesVisited, elapsedMs: Date.now() - started, stopped: blocked.kind, steps: session.steps.length }
        }
        if (!page?.count) {
          errors.push({ page: p, kind: 'empty', message: `第 ${p} 屏没读到岗位卡片（可能还没加载完，也可能这个关键词真的没有）`, keyword: kw })
        } else {
          for (const item of page.items) {
            if (seenUrls.has(item.url)) continue
            seenUrls.add(item.url)
            jobs.push(cardToRaw(item))
          }
          log(`[虚拟人] 第 ${p} 屏读到 ${page.count} 张卡片`)
        }

        if (p < pages) {
          // 翻页：滚到底，找「下一页」按钮点它，而不是改 URL 参数
          const clicked = await session.evaluate(`(() => {
            const btn = document.querySelector('.options-pages a:last-child, a[ka*="page-next"], .pagination a:last-child')
            if (!btn) return false
            btn.click(); return true
          })()`).catch(() => false)
          if (!clicked) break
          await sleep(Math.round(jitter(2500, 5200)))
        }
      }

      // 看完这一轮，偶尔点一个岗位进去看看（更像人，也顺带确认详情页是否正常）
      if (session.human.peek > 0 && jobs.length) {
        const pick = jobs[Math.round(jitter(0, Math.max(0, jobs.length - 1)))]
        await session.peekOne(pick?.url)
      }
      await session.think(1.4)
    }

    return { ok: jobs.length > 0, jobs, errors, pages: pagesVisited, elapsedMs: Date.now() - started, steps: session.steps.length }
  } catch (e) {
    const code = e?.code ?? null
    errors.push({ page: 0, kind: code === 'no-browser' ? 'no-browser' : 'browser', message: String(e?.message ?? e).slice(0, 200) })
    return { ok: false, jobs, errors, pages: pagesVisited, elapsedMs: Date.now() - started, steps: session.steps.length }
  } finally {
    await session.close().catch(() => {})
  }
}

export { HumanSession, EXTRACT_SRC, RISK_WORDS }
