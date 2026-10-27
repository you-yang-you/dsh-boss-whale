#!/usr/bin/env node
/**
 * dsh-boss-whale 命令行（宿主半边的设置页和调度器都通过它干活）
 *
 *   node tools/boss.mjs selftest [--json]      体检：配置 / 登录态 / 城市 / 真实抓一次
 *   node tools/boss.mjs deps [--json]          selftest 的别名（设置页按钮调这个）
 *   node tools/boss.mjs login --cookie "..."   写入登录态（也支持 --stdin / --file）
 *   node tools/boss.mjs search [--json]        抓一轮，打印明细（不落盘）
 *   node tools/boss.mjs daily [--json]        抓一轮 + 去重 + 落盘 + 生成日报（调度器调这个）
 *   node tools/boss.mjs daily --keyword=React --dry
 *                                             试跑：临时换关键词、只看不记（不写 seen / jobs）
 *   node tools/boss.mjs daily --greet          抓完顺带打一条招呼（受 greet.maxPerDay 约束）
 *   node tools/boss.mjs greet [--dry] [--json] 只做打招呼这件事（从已抓到的岗位里挑）
 *   node tools/boss.mjs replies [--auto]       看对方回复；--auto = 按规则自动接一句
 *   node tools/boss.mjs probe [--json]         探测读接口路径（只读，不会发消息）
 *   node tools/boss.mjs plan [--json]          看下一轮应该什么时候跑
 *   node tools/boss.mjs status [--json]        看配置 / 登录态 / 今日进度
 */
import fs from 'node:fs'
import {
  BOSS_HOME, DSH_HOME, configPath, credentialsPath, jobsPath, seenPath, planPath, ensureDir, writeJsonAtomic,
} from './lib/paths.mjs'
import { readConfig, resolveCityCode, merge } from './lib/config.mjs'
import { parseCookieInput, saveCredentials, credentialState, AuthError } from './lib/auth.mjs'
import { fetchAll, fetchPage, normalize, STOP_KINDS } from './lib/api.mjs'
import { browseForJobs, HumanSession, buildSearchPageUrl, readPageVerdict, EXTRACT_SRC } from './lib/human.mjs'
import { applyCooldown, cooldownStatus, clearCooldown, formatCooldown } from './lib/cooldown.mjs'
import { loadSeen, saveSeen, splitNew, markSeen, appendJobs, buildDigest, rankJobs } from './lib/store.mjs'
import { makePlan } from './lib/plan.mjs'
import { readJson } from './lib/paths.mjs'
import {
  loadLedger, saveLedger, pickTarget, composeGreeting, recordGreeting, recordReply,
  recordRisk, clearRisk, replyDecision, markConv, quota, summarize, inboundSignal,
} from './lib/greet.mjs'
import { greetJob, listConversations, sendReply, probe, cachedEndpoints } from './lib/chats.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const json = argv.includes('--json')
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const next = argv[argv.indexOf(hit) + 1]
  return next && !next.startsWith('--') ? next : true
}

function out(obj, text) {
  if (json) process.stdout.write(`${JSON.stringify(obj)}\n`)
  else process.stdout.write(`${text ?? JSON.stringify(obj, null, 2)}\n`)
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function cmdSelftest() {
  const cfg = readConfig()
  const cred = credentialState()
  const city = resolveCityCode(cfg)
  const items = []

  items.push({
    name: '配置文件',
    ok: fs.existsSync(configPath),
    detail: fs.existsSync(configPath) ? configPath : '还没有：在 设置 → 求职 里点一次「保存」',
  })
  ensureDir(BOSS_HOME)
  items.push({ name: '数据目录', ok: true, detail: BOSS_HOME })
  items.push({ name: 'DSH_HOME', ok: fs.existsSync(DSH_HOME), detail: DSH_HOME })
  items.push({
    name: 'BOSS 登录态',
    ok: cred.present,
    detail: cred.present ? `已保存（${cred.savedAt ?? '时间未知'} · 指纹 ${cred.fp}）` : '没有：在 设置 → 求职 里粘贴 cookie',
  })
  items.push({
    name: '反爬令牌 __zp_stoken__',
    ok: cred.hasStoken,
    detail: cred.hasStoken ? '在（接口能用它过校验）' : '缺：cookie 没复制全，接口会回 code 37',
  })
  items.push({
    name: '城市编码',
    ok: !!city.code,
    detail: city.code ? `${city.name} → ${city.code}` : (city.error ?? '未配置'),
  })

  // 真抓一次：只有这一步能证明"cookie 真的能用"
  let live = { ok: false, detail: '跳过（没有登录态）' }
  if (cred.present && city.code) {
    try {
      const res = await fetchPage(cfg, 1)
      live = res.ok
        ? { ok: true, detail: `第 1 页拿到 ${res.jobs.length} 条岗位（共 ${res.total} 条结果）` }
        : { ok: false, detail: res.message }
    } catch (e) {
      live = { ok: false, detail: String(e?.message ?? e) }
    }
    // 2026-10-27：虚拟人模式下这一项不再是"故障"。
    //   你把 cookie 拿到 node 里回放 → 一律被判非人类环境（code 37/35），换 cookie 也没用；
    //   既然已经选了 human 模式，这条路就是**主动放弃**的，标红会让人以为"又坏了"。
    //   仍然照抓一次（想知道接口通不通随时可以切回来），但结果降级为"仅供参考"。
    if (cfg.fetch?.mode === 'human') {
      items.push({
        name: '真实抓取（虚拟人模式下可忽略）',
        ok: true,
        detail: live.ok
          ? `${live.detail} —— 接口这会儿居然能用，但虚拟人模式不走它`
          : `${live.detail} —— 预期结果：你已经改成「虚拟人」浏览，不依赖接口回放 ✓`,
      })
    } else {
      items.push({ name: '真实抓取', ...live })
    }
  } else {
    items.push({ name: '真实抓取', ...live })
  }

  const ok = items.every((i) => i.ok)
  const payload = { ok, items, node: process.version, at: new Date().toISOString() }
  out(payload, [
    `体检结果：${ok ? '✓ 全部通过' : '✗ 有项目未通过'}`,
    ...items.map((i) => `  ${i.ok ? '✓' : '✗'} ${i.name} —— ${i.detail}`),
  ].join('\n'))
  process.exitCode = ok ? 0 : 1
}

async function cmdLogin() {
  let text = flag('cookie')
  if (flag('stdin')) text = await readStdin()
  else if (typeof flag('file') === 'string') text = fs.readFileSync(flag('file'), 'utf8')
  if (!text || text === true) {
    out({ ok: false, error: '用法：login --cookie "a=b; c=d" 或 login --stdin' })
    process.exitCode = 2
    return
  }
  try {
    const parsed = parseCookieInput(text)
    const rec = saveCredentials(parsed.cookie)
    const warn = parsed.missing.length
      ? `缺少字段：${parsed.missing.join('、')} —— 这些没复制到，接口很可能回 code 37`
      : null
    out({ ok: true, count: parsed.count, fp: rec.fp, warn }, `✓ 已保存登录态（${parsed.count} 个 cookie 字段）${warn ? `\n⚠️ ${warn}` : ''}`)
  } catch (e) {
    out({ ok: false, error: e instanceof AuthError ? e.message : String(e?.message ?? e) })
    process.exitCode = 2
  }
}

/**
 * 统一的"拿一批岗位"，两种模式共用一条返回结构。
 *
 * human（默认）：开真浏览器像人一样浏览，读渲染后的 DOM。
 * api（对照用）：node 直连接口 —— 已被证明会被判 code 37，留着只为排查。
 */
async function harvest(cfg, { pages } = {}) {
  const mode = String(flag('mode') ?? cfg?.fetch?.mode ?? 'human').toLowerCase()

  if (mode === 'api') {
    const res = await fetchAll(cfg, Number.isFinite(pages) && pages > 0 ? { pages } : undefined)
    return { ...res, mode: 'api' }
  }

  const log = (m) => { if (!json) process.stderr.write(`${m}\n`) }
  // 有人在终端前面看着，就把"过验证"这一步交给他；调度器跑的时候（--json）永远不交，
  // 因为那时候没人应答，干等只会白占一个进程。
  const interactive = flag('interactive') === true
    || process.env.BOSS_WHALE_INTERACTIVE === '1'
    || (process.stdout.isTTY === true && !json)
  const res = await browseForJobs({ cfg, keywords: cfg.search?.keywords, maxPages: pages, log, interactive })

  // 卡片 → 标准结构（补指纹/去重键）。缺名字也缺公司的多半是取到导航/广告，丢掉。
  const jobs = []
  for (const raw of res.jobs) {
    const job = normalize(raw)
    if (!job.name && !job.brand) continue
    jobs.push(job)
  }
  return {
    ok: res.ok && jobs.length > 0,
    jobs,
    errors: res.errors,
    pages: res.pages,
    mode: 'human',
    stopped: res.stopped ?? null,
    elapsedMs: res.elapsedMs,
    steps: res.steps,
  }
}

/**
 * 被风控拦了就落一次冷却期。
 * 这是"虚拟人"能长期活着的前提：撞一次墙必须真的停，
 * 否则下一次 tick（60 秒后）会继续撞，把 37 升级成 35。
 */
function noteRisk(res) {
  const hit = (res.errors ?? []).find((e) => STOP_KINDS.has(e.kind))
  if (!hit) return null
  const state = readJson(planPath, {}) || {}
  const next = applyCooldown(state, { kind: hit.kind, message: hit.message })
  writeJsonAtomic(planPath, next)
  return cooldownStatus(next)
}

async function cmdSearch() {
  const cfg = readConfig()
  const res = await harvest(cfg, { pages: Number(flag('pages') ?? cfg.search?.pages ?? 2) })
  const digest = buildDigest({ jobs: res.jobs, fresh: res.jobs, errors: res.errors, cfg })
  out({ ok: res.ok, mode: res.mode, count: res.jobs.length, errors: res.errors, jobs: res.jobs, text: digest.text }, digest.text)
  process.exitCode = res.ok ? 0 : 1
}

async function cmdDaily() {
  let cfg = readConfig()

  // 试跑支持：--keyword 临时换关键词、--dry 不落盘。
  // 两者必须成对使用（宿主就是这么调的）：只看不记，才敢随手试一个词。
  const kw = flag('keyword')
  const dry = flag('dry') === true
  if (typeof kw === 'string' && kw.trim()) {
    cfg = merge(cfg, {
      search: {
        keywords: String(kw).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
      },
    })
  }

  // 冷却期内直接拒绝：连一次页面都不打开。
  // 试跑（--dry）也挡 —— "我就点一下看看" 正是把人送进 35 的动作。
  const cd = cooldownStatus(readJson(planPath, {}) || {})
  if (cd.active && flag('force') !== true) {
    const text = [
      `⏸ ${formatCooldown(cd)}`,
      `原因：${cd.message || '上次被风控拦下'}`,
      '',
      '现在唯一该做的是等。反复重试会让 IP 从「环境异常」升级成「IP 异常」，那时候连你自己用浏览器都会受影响。',
      '确认已经等够了、想强行试一次，加 --force。',
    ].join('\n')
    out({ ok: false, cooldown: cd, blocked: true, text }, text)
    process.exitCode = 2
    return
  }

  const pagesFlag = Number(flag('pages'))
  const res = await harvest(cfg, Number.isFinite(pagesFlag) && pagesFlag > 0 ? { pages: pagesFlag } : undefined)
  const risk = noteRisk(res)

  const seen = loadSeen()
  const { fresh, repost } = splitNew(res.jobs, seen)
  if (res.jobs.length && !dry) {
    appendJobs(fresh)
    markSeen(seen, res.jobs)
    saveSeen(seen)
  }
  const digest = buildDigest({ jobs: res.jobs, fresh, repost, errors: res.errors, cfg })

  // 打招呼只在「真跑 + 显式 --greet」时才发生。
  // 试跑（--dry）绝不能发：试跑的目的是随手试个关键词，不该有对外副作用。
  let greet = null
  if (!dry && flag('greet') === true && res.ok) {
    greet = await attemptGreet({ jobs: rankJobs(fresh, cfg), cfg, ledger: loadLedger() })
  }

  const extra = risk?.active ? `\n\n${formatCooldown(risk)}` : ''
  out(
    {
      ok: res.ok,
      dry,
      mode: res.mode,
      keywords: cfg.search?.keywords ?? [],
      fetched: res.jobs.length,
      fresh: fresh.length,
      repost: repost.length,
      errors: res.errors,
      stopped: res.stopped ?? null,
      elapsedMs: res.elapsedMs ?? null,
      cooldown: risk ?? null,
      text: digest.text + extra,
      draft: digest.draft ?? null,
      greet,
    },
    [digest.text + extra, greet ? `\n${greetText(greet)}` : ''].join(''),
  )
  process.exitCode = res.ok ? 0 : 1
}

// ── 自动沟通的编排（daily --greet / greet / replies 共用）──────────────────

const brief = (job) => ({
  name: job?.name ?? '',
  brand: job?.brand ?? '',
  salaryDesc: job?.salaryDesc ?? '',
  url: job?.url ?? '',
  score: job?.score ?? 0,
  fp: job?.fp ?? '',
  id: job?.id ?? '',
})

/** 已经落盘的新岗位（greet 单独跑时用；daily 里直接用本轮 fresh，不必重读文件） */
function recentJobs(limit = 150) {
  try {
    const lines = fs.readFileSync(jobsPath, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 尝试打一条招呼。
 * @returns {{attempted:boolean, ok?:boolean, code?:string, reason?:string, job?:object, text?:string, quota:object}}
 */
async function attemptGreet({ jobs, cfg, ledger, dry = false }) {
  const pick = pickTarget(jobs, cfg, ledger)
  if (!pick.ok) {
    return { attempted: false, code: pick.code, reason: pick.reason, quota: pick.quota }
  }
  const { text } = composeGreeting(pick.job, cfg)
  const payload = { job: brief(pick.job), text, poolSize: pick.poolSize }

  if (dry) {
    return { attempted: false, dry: true, code: 'dry', reason: '试算：只挑人、只写话，不发送', ...payload, quota: pick.quota }
  }

  const res = await greetJob({ job: pick.job, text, cfg })
  if (!res.ok) {
    // 风控要记账（否则下一轮 tick 还会再敲一次门）；路径错只报错，不记风控
    if (res.kind === 'risk') {
      recordRisk(ledger, res.message, 60)
      saveLedger(ledger)
    }
    return {
      attempted: true,
      ok: false,
      code: res.kind ?? 'send-failed',
      reason: res.message,
      endpoint: res.endpoint ?? null,
      snippet: res.snippet ?? '',
      ...payload,
      quota: quota(cfg, ledger),
    }
  }

  recordGreeting(ledger, pick.job, text)
  saveLedger(ledger)
  return { attempted: true, ok: true, code: 'sent', reason: '已发出', endpoint: res.endpoint ?? null, ...payload, quota: quota(cfg, ledger) }
}

function greetText(r) {
  const lines = []
  const q = r.quota ?? {}
  if (r.ok) {
    lines.push(`✓ 已打招呼：${r.job.name} · ${r.job.brand}${r.job.salaryDesc ? ` · ${r.job.salaryDesc}` : ''}`)
    lines.push(r.text)
    if (r.job.url) lines.push(r.job.url)
  } else if (r.dry) {
    lines.push(`（试算，未发送）目标：${r.job.name} · ${r.job.brand}${r.job.salaryDesc ? ` · ${r.job.salaryDesc}` : ''}`)
    lines.push(`候选池 ${r.poolSize} 条 · 匹配分 ${r.job.score}`)
    lines.push(r.text)
  } else {
    lines.push(`✗ ${r.reason ?? '没发出去'}`)
    if (r.code === 'unknown-path') {
      lines.push('  接口路径不对：把浏览器 DevTools → Network 里「打招呼」那条请求的路径，')
      lines.push('  填到设置页的「招呼接口路径」（greet.greetPath）再试。')
    }
    if (r.snippet) lines.push(`  返回片段：${r.snippet}`)
  }
  if (q.max !== undefined) {
    lines.push(`今日额度：${q.used}/${q.max}${q.risk ? ` · 风控冷却到 ${q.risk.until}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 开一个窗口停在那里，什么都不抓，只是让人来过验证 / 重新登录。
 *
 * 这是「虚拟人」唯一需要真人的地方：撞到人机验证时，它自己过不去（也不该去绕），
 * 但也不能就让整件事停摆。把窗口留给用户，人点两下，之后几小时的自动浏览就通了。
 * 这里只观察页面状态，不点任何按钮 —— 过验证是人的动作。
 */
// 2026-10-27：只 cmdBrowse 用。以前它依赖一个根本不存在的 sleep ——
//   开窗命令每次都在"已经打开窗口"之后立刻 ReferenceError 崩掉，
//   窗口留在那儿没人接管（看起来像卡住），实际一行 hover 都没跑。
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function cmdBrowse() {
  const cfg = readConfig()
  const kw = flag('keyword') ?? (cfg.search?.keywords ?? [])[0]
  const { url, city } = buildSearchPageUrl(cfg, kw)
  if (!city.code) {
    out({ ok: false, error: city.error }, city.error)
    process.exitCode = 1
    return
  }
  const log = (m) => process.stderr.write(`${m}\n`)
  const session = new HumanSession({ cfg, log })
  let ready = false
  try {
    await session.open()
    await session.goto(url, { waitMs: 3200 })
    log('')
    log('窗口已经打开，停在 BOSS 搜索页。要做的就是让这个页面「正常」：')
    log('  · 弹了验证 → 拖一下滑块 / 按要求点几下')
    log('  · 跳登录页 → 扫码或手机号登录')
    log('  · 都正常了 → 直接关掉窗口，我会自己退出（最多等 15 分钟）')
    log('')
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      await sleep(3000)
      let page = null
      try { page = await session.evaluate(EXTRACT_SRC) } catch { break }   // 窗口被关掉
      const v = readPageVerdict(page)
      if (!ready && v.kind === 'ok' && Number(page?.count ?? 0) > 0) {
        ready = true
        log(`✓ 页面已经正常了（读到 ${page.count} 张岗位卡片）。现在关掉窗口就行。`)
      }
    }
  } catch (e) {
    out({ ok: false, error: String(e?.message ?? e).slice(0, 200) }, `✗ 打不开浏览器：${e?.message ?? e}`)
    process.exitCode = 1
    return
  } finally {
    await session.close().catch(() => {})
  }
  out(
    { ok: ready, url },
    ready ? '✓ 页面已经能正常看到岗位，关掉窗口后自动浏览就会顺了。' : '窗口已关闭（没检测到"正常页面"）。如果验证还没过，再点一次。',
  )
}

async function cmdGreet() {
  const cfg = readConfig()
  const dry = flag('dry') === true
  const ledger = loadLedger()
  const jobs = rankJobs(recentJobs(), cfg)
  const result = await attemptGreet({ jobs, cfg, ledger, dry })
  const payload = { ok: result.ok === true, dry, ...result, pool: jobs.length }
  out(payload, greetText(result))
}

/**
 * 看回复 / 自动接话。
 *
 * 三个容易踩的点，都在这里处理掉了：
 *   ① 方向判断只能靠猜（列表接口不保证给"谁说的"），所以：文本等于我们发过的最后一句 → 我方；
 *      文本 + 时间都没变 → 这条处理过，跳过（幂等，否则每 5 分钟回一遍同样的话）。
 *   ② **只读模式绝不能写账本**。以前这里无论是 --auto 还是只看，都把 lastBossText 落盘，
 *      结果是"你点了一次『看回复』，自动接话就永远接不上那条消息了" —— 看一眼把功能看坏了。
 *   ③ 自动发送失败不能每 5 分钟重试一次（会变成对同一个 HR 反复敲门）。
 *      失败就直接交给人工，只播报一次。
 */
async function cmdReplies() {
  const cfg = readConfig()
  const auto = flag('auto') === true
  // 只读模式在副本上算，绝不落盘
  const ledger = auto ? loadLedger() : structuredClone(loadLedger())
  const listed = await listConversations({ cfg })

  if (!listed.ok) {
    out(
      { ok: false, code: listed.kind, error: listed.message, endpoint: listed.endpoint ?? null },
      `✗ 读不到会话：${listed.message}\n  接口：${listed.endpoint?.path ?? '(未定)'}`,
    )
    return
  }

  const actions = []
  for (const c of listed.convs.slice(0, 8)) {
    /**
     * ⚠️ 只处理**我们打过招呼**的会话。
     *
     * 不加这一条的话，会话列表里你几个月前跟别人聊的、别处投的简历、甚至猎头群发，
     * 全都会被当成"该接一句"的候选 —— 然后插件就去回一句几年前的对话。
     * 用户要的是"打完招呼把话接下去"，不是"接管我所有聊天"。
     */
    const prev = ledger.convs?.[c.key]
    if (!prev) continue

    const signal = inboundSignal(prev, c)
    if (signal.mine || signal.seen) continue

    const now = new Date().toISOString()
    ledger.convs[c.key] = {
      ...prev,
      key: c.key,
      securityId: c.securityId || prev.securityId || '',
      encryptBossId: c.encryptBossId || prev.encryptBossId || c.key,
      job: { name: c.jobName || prev.job?.name || '', brand: c.brand || prev.job?.brand || '', url: prev.job?.url ?? '' },
      lastBossText: c.lastMsg,
      lastBossTime: c.lastTime,
      lastBossAt: now,
      lastFromBoss: true,
      status: prev.status === 'greeted' ? 'chatting' : prev.status,
    }

    const decision = replyDecision({ key: c.key }, cfg, ledger)
    const base = { key: c.key, boss: c.bossName || c.brand, text: c.lastMsg, decision: decision.action, reason: decision.reason }

    if (decision.action === 'reply') {
      if (!auto) {
        actions.push({ ...base, wouldReply: decision.text })
        continue
      }
      const sent = await sendReply({ conv: { ...c }, text: decision.text, cfg })
      if (!sent.ok) {
        if (sent.kind === 'risk') recordRisk(ledger, sent.message, 60)
        // 交回人工：这条消息就此打住，不再自动重试（重试就是反复敲门）
        markConv(ledger, c.key, { status: 'handoff', handoffReason: `自动回复失败：${sent.message}` })
        actions.push({ ...base, decision: 'send-failed', code: sent.kind, error: sent.message })
        if (sent.kind === 'risk') break
        continue
      }
      recordReply(ledger, c.key, decision.text)
      actions.push({ ...base, sent: decision.text })
    } else if (decision.action === 'handoff' || decision.action === 'close') {
      markConv(ledger, c.key, { status: decision.action === 'close' ? 'closed' : 'handoff', handoffReason: decision.reason })
      actions.push({ ...base })
    } else {
      actions.push({ ...base })
    }
  }

  if (auto) saveLedger(ledger)
  const payload = { ok: true, auto, count: listed.convs.length, actions, quota: quota(cfg, ledger), endpoint: listed.endpoint ?? null }

  const lines = [`会话 ${listed.convs.length} 个 · 有新动静 ${actions.length} 条${auto ? '' : '（只读：没有落盘，也不会发送）'}`]
  for (const a of actions) {
    const tag = { reply: '↩ 自动回', handoff: '⚠ 交回你', close: '✓ 结束', wait: '… 等', hold: '· 停', 'send-failed': '✗ 失败' }[a.decision] ?? a.decision
    lines.push(`  ${tag} · ${a.boss}：${String(a.text).slice(0, 40)}`)
    lines.push(`     ${a.reason}`)
    if (a.sent) lines.push(`     已发：${a.sent}`)
    if (a.wouldReply) lines.push(`     会发（加 --auto 才真发）：${a.wouldReply}`)
    if (a.error) lines.push(`     失败：${a.error}`)
  }
  if (actions.length === 1 && actions[0].decision === 'wait') lines.push('  （对方还没回话，或最后一句是我们说的）')
  out(payload, lines.join('\n'))
}

async function cmdProbe() {
  const cfg = readConfig()
  const res = await probe(cfg)
  const payload = { ok: res.ok, results: res.results ?? [], cached: cachedEndpoints() }
  const lines = [res.ok ? '✓ 至少一条读接口通了' : `✗ 读接口都没通：${res.message ?? ''}`]
  for (const r of res.results ?? []) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.path} → ${r.message}`)
  out(payload, lines.join('\n'))
}

function cmdRisk() {
  const ledger = loadLedger()
  const sub = flag('clear') === true || String(flag('clear') ?? '') === '1'
  if (sub) clearRisk(ledger)
  saveLedger(ledger)

  // 抓取侧的冷却期也要能手工解除（等够了 / 换了网络）
  const state = readJson(planPath, {}) || {}
  const before = cooldownStatus(state)
  if (sub && before.active) writeJsonAtomic(planPath, clearCooldown(state))
  const after = cooldownStatus(readJson(planPath, {}) || {})

  out(
    { ok: true, greetRisk: ledger.risk ?? null, cooldown: after },
    [
      ledger.risk ? `招呼侧冷却到 ${ledger.risk.until}（${ledger.risk.reason}）` : '招呼侧：当前没有风控冷却',
      after.active ? `抓取侧：${formatCooldown(after)}` : '抓取侧：当前没有冷却',
    ].join('\n'),
  )
}

function cmdPlan() {
  const cfg = readConfig()
  const state = readJson(planPath, {}) || {}
  const plan = makePlan(cfg, state)
  out(plan, [
    `下一轮：${plan.action}${plan.atText ? ` · ${plan.atText}` : ''}`,
    `今日进度：${plan.runs}/${plan.runsPerDay}`,
    plan.reason ? `原因：${plan.reason}` : '',
  ].filter(Boolean).join('\n'))
}

function cmdStatus() {
  const cfg = readConfig()
  const cred = credentialState()
  const state = readJson(planPath, {}) || {}
  const seen = loadSeen()
  const ledger = loadLedger()
  const g = summarize(ledger, cfg)
  const cd = cooldownStatus(state)
  const jobsLines = (() => {
    try { return fs.readFileSync(jobsPath, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
  })()
  const payload = {
    ok: true,
    configPath,
    credentialsPath,
    jobsPath,
    seenPath,
    search: cfg.search,
    fetch: { mode: cfg.fetch?.mode ?? 'human' },
    human: cfg.human ?? {},
    plan: cfg.plan,
    greet: cfg.greet,
    credentials: cred,
    today: { date: state.date ?? null, runs: state.runs ?? 0, lastAt: state.lastAt ?? null },
    jobs: { stored: jobsLines, seen: Object.keys(seen.ids).length, fingerprints: Object.keys(seen.fps ?? {}).length },
    cooldown: cd,
    engage: g,
  }
  const gr = cfg.greet ?? {}
  out(payload, [
    `配置：${configPath}`,
    `条件：${(cfg.search?.keywords ?? []).join(' / ')} · ${cfg.search?.city}`,
    `登录态：${cred.present ? `已保存（指纹 ${cred.fp}）` : '无'}`,
    `浏览方式：${(cfg.fetch?.mode ?? 'human') === 'human' ? '虚拟人（真浏览器）' : '接口直连（会被判 code 37）'}`,
    cd.active ? `⏸ ${formatCooldown(cd)}` : '风控冷却：无',
    `今日：${state.runs ?? 0}/${cfg.plan?.runsPerDay ?? 2} 轮`,
    `已记录岗位：${jobsLines} 条 · 去重表 id ${Object.keys(seen.ids).length} / 指纹 ${Object.keys(seen.fps ?? {}).length}`,
    `自动沟通：${gr.enabled ? '开' : '关'} · 今日招呼 ${g.quota.used}/${g.quota.max}`
      + `${gr.autoContinue ? ` · 自动接话 ${g.quota.replied}/${g.quota.replyMax}` : ' · 不自动接话'}`
      + `${g.quota.risk ? ` · ⚠ 风控冷却到 ${g.quota.risk.until}` : ''}`,
  ].join('\n'))
}

const table = {
  selftest: cmdSelftest,
  deps: cmdSelftest,
  login: cmdLogin,
  search: cmdSearch,
  daily: cmdDaily,
  browse: cmdBrowse,
  greet: cmdGreet,
  replies: cmdReplies,
  probe: cmdProbe,
  risk: cmdRisk,
  plan: cmdPlan,
  status: cmdStatus,
}

const run = table[cmd]
if (!run) {
  process.stderr.write(`未知命令：${cmd}\n可用：${Object.keys(table).join(' / ')}\n`)
  process.exitCode = 2
} else {
  Promise.resolve()
    .then(run)
    .catch((e) => {
      out({ ok: false, error: String(e?.message ?? e) })
      process.exitCode = 1
    })
}
