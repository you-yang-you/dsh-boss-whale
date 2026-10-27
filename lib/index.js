import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startScheduler } from './scheduler.js'
import { LoginHub } from './login-hub.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.mjs'
import { readConfig, writeConfig, DEFAULTS, merge, resolveCityCode } from '../tools/lib/config.mjs'
import {
  DSH_HOME, HOME, BOSS_HOME, configPath, credentialsPath, jobsPath, ensureDir, readJson, endpointsPath,
  planPath, writeJsonAtomic,
} from '../tools/lib/paths.mjs'
import { clearCooldown } from '../tools/lib/cooldown.mjs'
import { parseCookieInput, saveCredentials, credentialState, AuthError } from '../tools/lib/auth.mjs'
import { loadLedger, summarize, clearRisk, saveLedger, HARD_MAX_PER_DAY } from '../tools/lib/greet.mjs'

/**
 * dsh-boss-whale —— 宿主侧（设置壳 + 生物钟）
 *
 * 三件事：
 *   1. 设置页数据面：GET/POST /dsh-boss/api/settings ⇄ ~/.dsh/boss-whale.config.json
 *   2. 登录态：POST /dsh-boss/api/cookie → ~/.boss-ai/credentials.json（永不回显）
 *   3. 生物钟：startScheduler()，到点自己抓职位、自己投进会话
 *
 * 所有路由都过 DSH 的信任栅栏：Web 端口是回环地址，但任意网页都能向回环发请求，
 * 不加栅栏等于把配置和 cookie 开放给任何页面。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK_DIR = path.join(DSH_HOME, 'boss-work')
const API = '/dsh-boss/api'

let SCHED_STATUS = { ok: false, reason: '未初始化', at: null }

const NODE_EXE = (() => {
  try {
    return resolveNodeRuntime(DSH_HOME)
  } catch (e) {
    globalThis.__bossWhaleNodeError = String(e?.message ?? e)
    return null
  }
})()

function execNode(args, options, cb) {
  if (!NODE_EXE) {
    const msg = globalThis.__bossWhaleNodeError || '未找到可用的 node 运行时'
    cb?.(new Error(msg), '', msg)
    return null
  }
  return execFile(NODE_EXE, args, { ...options, env: { ...nodeEnv(DSH_HOME), ...options?.env } }, cb)
}

/** 工具链位置：① 设置里的 toolsPath ② 插件自带 tools/ */
function resolveBossMjs(cfg) {
  const c = cfg ?? readConfig()
  return c.toolsPath || path.join(HERE, '..', 'tools', 'boss.mjs')
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 读并解析 JSON body。
 *
 * 两版原稿都是 `JSON.parse(await readBody(req))` 扔在 try 里，结果是：
 * 用户手写错一个逗号 → 抛 SyntaxError → 外层 catch 回 500。
 * 500 的意思是"服务器坏了"，可实际是"你发的东西不对"，会把人往错误方向带。
 * 所以这里把三种失败分开：空体当 {}、格式错误 400、超过上限 413。
 */
async function readJsonBody(req, res, limit) {
  let text = ''
  try {
    text = await readBody(req, limit)
  } catch (e) {
    const tooBig = String(e?.message ?? '').includes('too large')
    json(res, tooBig ? 413 : 400, {
      ok: false,
      error: tooBig ? '请求体过大（上限 256KB）' : String(e?.message ?? e),
    })
    return { ok: false }
  }
  if (!text.trim()) return { ok: true, value: {} }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
      return { ok: false }
    }
    return { ok: true, value }
  } catch (e) {
    json(res, 400, { ok: false, error: `请求体不是合法 JSON：${String(e?.message ?? e).slice(0, 80)}` })
    return { ok: false }
  }
}

export default {
  name: 'dsh-boss-whale',
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {
    // ── 信任栅栏 ─────────────────────────────────────────────────────────
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }

    function isTrustedReq(req) {
      if (isLoopbackReq(req)) return true
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }

    function rejected(req, res, { strict = true } = {}) {
      if (isTrustedReq(req) === false) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (strict) { json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        if (strict) { json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true }
        return false
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }

    /** 跑一条 CLI 子命令并解析它的 JSON 输出（新加的路由都用它，省得每个都抄一遍 execNode） */
    function runJson(args, timeout = 120_000) {
      return new Promise((resolve) => {
        const tools = resolveBossMjs(readConfig())
        if (!fs.existsSync(tools)) {
          resolve({ ok: false, error: `找不到 boss.mjs：${tools}` })
          return
        }
        execNode([tools, ...args], { timeout, windowsHide: true }, (err, stdout) => {
          const text = String(stdout ?? '').trim()
          let payload = null
          try { payload = JSON.parse(text.split('\n').pop() ?? '{}') } catch {}
          if (!payload || typeof payload !== 'object') {
            resolve({ ok: false, error: String(err?.message ?? text ?? '没有返回结果').slice(0, 400), out: text.slice(0, 400) })
            return
          }
          resolve(payload)
        })
      })
    }

    // ── 设置 ────────────────────────────────────────────────────────────
    route('exact', `${API}/settings`, async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig()
        const city = resolveCityCode(cfg)
        json(res, 200, {
          ok: true,
          config: cfg,
          defaults: DEFAULTS,
          credentials: credentialState(),
          city: { name: city.name, code: city.code, error: city.error ?? null },
          configPath,
          scheduler: SCHED_STATUS,
        })
        return
      }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }

      const parsed = await readJsonBody(req, res)
      if (!parsed.ok) return
      const body = parsed.value
      const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
      const cur = readConfig()
      delete cur.__hasUserFile

      // 白名单直接从 DEFAULTS 推导，而不是另抄一份：
      // 抄的那份迟早和 DEFAULTS 走散（漏一个键），症状是"保存成功、重启后值又回来了"，
      // 而且全程不报错 —— 这类静默失效能查一整天。
      //
      // 嵌套层也要查：只查顶层的话，greet.maxPerDay 拼成 greet.maxPerDayy 能存进去、
      // 不报错、也不生效 —— 和顶层拼错是同一类坑，只是更隐蔽。
      const KNOWN = new Set(Object.keys(DEFAULTS))
      const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
      const filtered = {}
      const ignored = []
      for (const [k, v] of Object.entries(incoming)) {
        if (!KNOWN.has(k)) {
          if (!k.startsWith('__')) ignored.push(k) // __hasUserFile 这类内部字段被原样回传是正常的
          continue
        }
        const dft = DEFAULTS[k]
        if (isPlain(v) && isPlain(dft)) {
          const knownSub = new Set(Object.keys(dft))
          const clean = {}
          for (const [sk, sv] of Object.entries(v)) {
            if (knownSub.has(sk)) clean[sk] = sv
            else ignored.push(`${k}.${sk}`)
          }
          filtered[k] = clean
        } else {
          filtered[k] = v
        }
      }
      const next = merge(cur, filtered)

      // 范围校验：别让设置页把值写成负数或离谱数
      const s = next.search ?? {}
      s.keywords = (Array.isArray(s.keywords) ? s.keywords : String(s.keywords ?? '').split(/[,，\s]+/))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      s.exclude = (Array.isArray(s.exclude) ? s.exclude : String(s.exclude ?? '').split(/[,，\s]+/))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      s.pages = Math.min(4, Math.max(1, Number(s.pages) || 1))
      s.pageSize = Math.min(30, Math.max(10, Number(s.pageSize) || 30))
      s.salaryMin = Math.min(500, Math.max(0, Number(s.salaryMin) || 0))
      next.search = s

      const f = next.fetch ?? {}
      // 只认两个值。写错一个字母就回 400，而不是让它在下游变成"神秘什么都没抓到"。
      if (f.mode !== undefined && !['human', 'api'].includes(String(f.mode))) {
        json(res, 400, { ok: false, error: 'fetch.mode 只能是 human 或 api' })
        return
      }
      f.mode = ['human', 'api'].includes(String(f.mode)) ? String(f.mode) : DEFAULTS.fetch.mode
      f.minGapSec = Math.min(120, Math.max(2, Number(f.minGapSec) || 6))
      f.jitterSec = Math.min(60, Math.max(0, Number(f.jitterSec) || 4))
      f.maxPagesPerRun = Math.min(4, Math.max(1, Number(f.maxPagesPerRun) || 4))
      f.timeoutMs = Math.min(60000, Math.max(5000, Number(f.timeoutMs) || 20000))
      next.fetch = f

      // 虚拟人的节奏参数：全部只允许"调更慢"，不允许调成 0 步/1 秒那种
      // 把自己伪装成脚本的配置。界面能改的，服务端都必须再 clamp 一次。
      const hu = next.human ?? {}
      hu.enabled = hu.enabled !== false
      hu.visible = hu.visible !== false
      hu.offscreen = hu.offscreen === true
      hu.slow = hu.slow !== false
      hu.handoff = hu.handoff !== false
      hu.scrollSteps = Math.min(12, Math.max(2, Number(hu.scrollSteps) || 5))
      hu.dwellSec = Math.min(120, Math.max(1, Number(hu.dwellSec) || 8))
      hu.peekPerRun = Math.min(3, Math.max(0, Number(hu.peekPerRun) || 0))
      hu.pagesPerRun = Math.min(3, Math.max(1, Number(hu.pagesPerRun) || 1))
      delete hu.handoffPollMs
      next.human = hu

      const p = next.plan ?? {}
      const runsPerDay = Number(p.runsPerDay)
      if (!Number.isFinite(runsPerDay) || runsPerDay < 1 || runsPerDay > 12) {
        json(res, 400, { ok: false, error: '每日轮数须为 1–12' })
        return
      }
      p.runsPerDay = Math.round(runsPerDay)
      p.minGapMin = Math.min(720, Math.max(10, Number(p.minGapMin) || 180))
      p.skipChance = Math.min(0.95, Math.max(0, Number(p.skipChance) || 0))
      if (!Array.isArray(p.windows) || !p.windows.length) {
        json(res, 400, { ok: false, error: '至少要有一个时间窗口' })
        return
      }
      p.windows = p.windows.slice(0, 4)
      next.plan = p

      const d = next.digest ?? {}
      d.topN = Math.min(30, Math.max(1, Number(d.topN) || 8))
      d.pushToSession = d.pushToSession !== false
      next.digest = d

      /**
       * 自动沟通：这里是**服务端**的最后一道闸。
       * 前端已经用小键盘（0/1/2）限制过了，但配置是磁盘上的一个 JSON，
       * 谁都能手改成 50。所以 maxPerDay 在这里再 clamp 一次 ——
       * "每天两次及以下"是产品约束，不是输入提示。
       */
      const g = next.greet ?? {}
      g.enabled = g.enabled === true
      g.maxPerDay = Math.min(HARD_MAX_PER_DAY, Math.max(0, Math.round(Number(g.maxPerDay) || 0)))
      g.minScore = Math.min(100, Math.max(0, Number(g.minScore) || 10))
      g.autoContinue = g.autoContinue === true
      g.maxTurns = Math.min(5, Math.max(0, Math.round(Number(g.maxTurns) || 0)))
      g.maxRepliesPerDay = Math.min(20, Math.max(0, Math.round(Number(g.maxRepliesPerDay) || 0)))
      g.quietOnly = g.quietOnly !== false
      g.signature = String(g.signature ?? '').slice(0, 40)
      for (const k of ['greetPath', 'listPath', 'sendPath']) {
        const v = String(g[k] ?? '').trim().slice(0, 200)
        // 只接受站内路径。写成整条 URL 时会拼成 https://www.zhipin.comhttps://... —— 这类错很难自己看出来
        if (v && !v.startsWith('/')) {
          json(res, 400, { ok: false, error: `${k} 必须是站内路径（以 / 开头），例如 /wapi/zpgeek/friend/add.json` })
          return
        }
        g[k] = v
      }
      g.templates = (Array.isArray(g.templates) ? g.templates : [])
        .map((x) => String(x ?? '').trim().slice(0, 400))
        .filter(Boolean)
        .slice(0, 6)
      if (!g.templates.length) g.templates = [...DEFAULTS.greet.templates]
      next.greet = g

      writeConfig(next)
      // 时间窗口/轮数变了 → 让生物钟立刻重算
      try { sched?.invalidate() } catch {}
      const city = resolveCityCode(next)
      json(res, 200, {
        ok: true,
        config: next,
        city: { name: city.name, code: city.code, error: city.error ?? null },
        warn: city.code ? null : (city.error ?? null),
        // 未知键不静默丢：拼错一个键名时会在这里看到，否则就是"点了保存没反应"
        ignored: ignored.length ? ignored : undefined,
      })
    })

    // ── 扫码登录 ────────────────────────────────────────────────────────
    /**
     * 两条路线，自动选（细节见 lib/login-hub.js）：
     *   ① 宿主开 Electron 窗口载入 BOSS **官方登录页**（不离开 DSH，体验最好）
     *   ② 宿主拿不到 Electron 时，用本机 Edge/Chrome + CDP 读登录态
     *
     * 为什么不自己在设置页画二维码：BOSS 的二维码接口没有公开契约，猜路径的代价是
     * "二维码画出来了但永远不成功" —— 比没有入口更误导人。
     *
     * 三个动作都是 POST：start 开窗、poll 顺带驱动一次 cookie 检查、cancel 关窗/关浏览器。
     * 返回体统一 200 + ok 字段（和其他路由一致），异常消息原样带给界面 —— 这里最常见的
     * 失败原因是"环境缺件"，必须说清楚，否则用户只会看到"点了没反应"。
     */
    const loginHub = new LoginHub({ log: (m) => { try { console.log(m) } catch {} } })
    const qrFail = (res, e) => json(res, 200, {
      ok: false,
      code: e?.code ?? null,
      error: e instanceof AuthError ? e.message : String(e?.message ?? e).slice(0, 200),
    })

    route('exact', `${API}/auth/qr/start`, async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      let body = { ok: true, value: {} }
      try { body = await readJsonBody(req, res) } catch {}
      if (body && body.ok === false) return
      try { json(res, 200, await loginHub.start({ mode: String(body?.value?.mode ?? 'auto') })) } catch (e) { qrFail(res, e) }
    })

    route('exact', `${API}/auth/qr/poll`, async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      try { json(res, 200, loginHub.poll(String(body.value.id ?? ''))) } catch (e) { qrFail(res, e) }
    })

    route('exact', `${API}/auth/qr/cancel`, async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      try { json(res, 200, loginHub.cancel(String(body.value.id ?? ''))) } catch (e) { qrFail(res, e) }
    })

    // ── 登录态（cookie）────────────────────────────────────────────────
    route('exact', `${API}/cookie`, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = await readJsonBody(req, res)
        if (!body.ok) return
        const parsedCookie = parseCookieInput(body.value.cookie ?? body.value.text ?? '')
        const rec = saveCredentials(parsedCookie.cookie)
        json(res, 200, {
          ok: true,
          credentials: credentialState(),
          detail: `已保存 ${parsedCookie.count} 个 cookie 字段（指纹 ${rec.fp}）`,
          warn: parsedCookie.missing.length ? `缺少 ${parsedCookie.missing.join('、')} —— 接口可能回 code 37` : null,
        })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof AuthError ? error.message : '保存失败，请检查输入' })
      }
    })

    // ── 体检（真实抓一次）────────────────────────────────────────────────
    route('exact', `${API}/deps`, async (req, res) => {
      const cfg = readConfig()
      const tools = resolveBossMjs(cfg)
      if (!fs.existsSync(tools)) {
        json(res, 200, { ok: false, error: `找不到 boss.mjs：${tools}`, items: [], scheduler: SCHED_STATUS })
        return
      }
      execNode([tools, 'selftest', '--json'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          json(res, 200, { ...parsed, scheduler: sched?.status?.() ?? SCHED_STATUS })
        } catch {
          json(res, 200, {
            ok: false,
            error: String(stderr || err?.message || 'selftest 跑失败').slice(0, 400),
            items: [],
            scheduler: sched?.status?.() ?? SCHED_STATUS,
          })
        }
      })
    })

    // ── 立即跑一轮 ───────────────────────────────────────────────────────
    // 不带参数 = 正常跑一轮（记今日轮数之外的独立动作，会落盘）。
    // 带 keyword = 试跑：只换这一次的关键词，不写配置、不记入去重。
    //   「不记入去重」是关键 —— 否则你随手试一个词，那批岗位就被标成"看过"，
    //   定时任务的日报再也刷不出它们，等于自己把日报饿死。
    route('exact', `${API}/run`, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      const opt = body.value
      const keyword = String(opt.keyword ?? '').trim()
      const pages = Number(opt.pages)

      const cfg = readConfig()
      const tools = resolveBossMjs(cfg)
      if (!fs.existsSync(tools)) { json(res, 200, { ok: false, error: `找不到 boss.mjs：${tools}` }); return }

      const args = [tools, 'daily', '--json']
      if (keyword) { args.push(`--keyword=${keyword}`, '--dry') }
      if (Number.isFinite(pages) && pages > 0) args.push(`--pages=${Math.min(4, Math.round(pages))}`)

      execNode(args, { timeout: 180_000, windowsHide: true }, (err, stdout, stderr) => {
        let payload = null
        try { payload = JSON.parse(String(stdout || '').trim().split('\n').pop() ?? '{}') } catch {}
        if (!payload?.text) {
          json(res, 200, {
            ok: false,
            error: String(stderr || err?.message || '抓取没有返回结果').slice(0, 400),
            out: String(stdout ?? '').slice(0, 400),
          })
          return
        }
        json(res, 200, {
          ok: true,
          dry: !!payload.dry,
          keywords: payload.keywords ?? [],
          fetched: payload.fetched,
          fresh: payload.fresh,
          repost: payload.repost ?? 0,
          errors: payload.errors ?? [],
          text: payload.text,
        })
      })
    })

    // ── 自动沟通 ────────────────────────────────────────────────────────
    // 状态：额度、每个会话聊到哪、接口路径探测结果 —— 设置页要能看见"为什么今天没发"
    route('exact', `${API}/greet/status`, async (req, res) => {
      const cfg = readConfig()
      const ledger = loadLedger()
      json(res, 200, {
        ok: true,
        ...summarize(ledger, cfg),
        enabled: cfg.greet?.enabled === true,
        autoContinue: cfg.greet?.autoContinue === true,
        endpoints: readJson(endpointsPath, {}) || {},
      })
    })

    /**
     * 试算 / 真发一条。
     * 默认 dry：只挑人、只写话，不发送 —— 这个按钮可以随便点。
     * 真发必须显式带 confirm:true：一旦能"顺手点一下"发出去，额度就会莫名其妙少一条。
     */
    route('exact', `${API}/greet/run`, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readJsonBody(req, res)
      if (!body.ok) return
      const confirm = body.value?.confirm === true
      const args = confirm ? ['greet', '--json'] : ['greet', '--dry', '--json']
      const payload = await runJson(args, 120_000)
      json(res, 200, { ...payload, dry: !confirm })
    })

    route('exact', `${API}/greet/clear-risk`, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const ledger = loadLedger()
      clearRisk(ledger)
      saveLedger(ledger)
      // 抓取侧的冷却期也要一起清 —— 界面上这是同一个「解除冷却」按钮，
      // 只清一半会让人以为按了没用（列表能读了，但一轮还是不跑）。
      const state = readJson(planPath, {}) || {}
      if (state.cooldown) writeJsonAtomic(planPath, clearCooldown(state))
      json(res, 200, { ok: true })
    })

    // 只看不发：真正的自动接话由调度器按 5 分钟轮询、按规则决定，不给页面一个"批量回"的按钮
    route('exact', `${API}/replies`, async (req, res) => {
      const payload = await runJson(['replies', '--json'], 120_000)
      json(res, 200, payload)
    })

    route('exact', `${API}/probe`, async (req, res) => {
      const payload = await runJson(['probe', '--json'], 120_000)
      json(res, 200, payload)
    })

    // ── 开窗过验证 ──────────────────────────────────────────────────────
    /**
     * 起一个独立进程，把浏览器停在搜索页，让人手动过验证/登录。
     *
     * 为什么不在这个请求里等：过验证是人的节奏（几十秒到几分钟），
     * 压在 HTTP 请求上会让界面一直转圈，超时后用户以为没成功又点一次 —— 于是开两个窗口。
     * 所以 detached 出去、立刻返回，那个进程自己等到窗口被关掉才退出。
     */
    route('exact', `${API}/browse`, async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!NODE_EXE) { json(res, 200, { ok: false, error: globalThis.__bossWhaleNodeError || '未找到 node 运行时' }); return }
      try {
        const child = spawn(NODE_EXE, [resolveBossMjs(readConfig()), 'browse'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...nodeEnv(DSH_HOME) },
        })
        child.unref()
        json(res, 200, { ok: true })
      } catch (e) {
        json(res, 200, { ok: false, error: String(e?.message ?? e).slice(0, 200) })
      }
    })

    // ── 状态 ────────────────────────────────────────────────────────────
    route('exact', `${API}/status`, async (req, res) => {
      const cfg = readConfig()
      const stored = (() => {
        try { return fs.readFileSync(jobsPath, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
      })()
      const seenFile = readJson(path.join(BOSS_HOME, 'seen.json'), {}) || {}
      const seen = seenFile.ids ?? {}
      const fps = seenFile.fps ?? {}
      json(res, 200, {
        ok: true,
        credentials: credentialState(),
        scheduler: sched?.status?.() ?? SCHED_STATUS,
        stored,
        seen: Object.keys(seen).length,
        fingerprints: Object.keys(fps).length,
        city: resolveCityCode(cfg),
        engage: summarize(loadLedger(), cfg),
      })
    })

    // ── 最近抓到的岗位（设置页列表用）───────────────────────────────────
    route('exact', `${API}/jobs`, async (req, res) => {
      const limit = 40
      let rows = []
      try {
        const text = fs.readFileSync(jobsPath, 'utf8')
        const lines = text.split('\n').filter(Boolean)
        rows = lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
      } catch {}
      json(res, 200, { ok: true, jobs: rows })
    })

    // ── 生物钟 ──────────────────────────────────────────────────────────
    ensureDir(WORK_DIR)
    let sched = null
    try {
      sched = startScheduler(ctx, {
        dshHome: DSH_HOME,
        bossMjs: resolveBossMjs(readConfig()),
        cwd: WORK_DIR,
        sessionId: 'boss-whale',
        // 启动后把专属会话建出来（digest.seedSession = false 就只干活、不建会话）
        seedSession: readConfig().digest?.seedSession !== false,
        log: (m) => { try { console.log(m) } catch {} },
      })
      SCHED_STATUS = { ok: true, reason: '已启动（每 60 秒 tick）', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[boss-whale] 生物钟启动失败：' + (e?.message ?? e)) } catch {}
    }

    ctx.effect(() => () => {
      try { sched?.stop() } catch {}
      try { loginHub.dispose() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try {
      console.log(`[boss-whale] 设置页已挂载：设置 → 求职 · 配置 ${configPath} · 凭据 ${credentialsPath} · 工作目录 ${WORK_DIR}`)
    } catch {}
  },
}
