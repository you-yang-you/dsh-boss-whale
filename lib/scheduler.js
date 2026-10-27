import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createDelivery } from './delivery.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.mjs'
import { readConfig } from '../tools/lib/config.mjs'
import { credentialState } from '../tools/lib/auth.mjs'
import { makePlan, completePlan, normalizeWindows, inWindow } from '../tools/lib/plan.mjs'
import { planPath, logPath, readJson, writeJsonAtomic } from '../tools/lib/paths.mjs'

const TICK_MS = 60_000
/** 接话轮询：没必要每分钟看一次，5 分钟足够，也顺便把"秒回"这件事变得像人 */
const CHAT_TICK_MS = 5 * 60_000

/** 现在是否落在配置的时间窗口里（quietOnly 用） */
function insideWindow(cfg, now = new Date()) {
  const windows = normalizeWindows(cfg?.plan?.windows)
  return windows.some((w) => inWindow(w, now))
}

/**
 * 生物钟：插件自己每 60 秒看一眼"该不该跑一轮"，到点就抓职位并投进会话。
 *
 * 为什么放在插件里而不是靠对话框：DSH 的 agent 只在被 prompt 时才活一次。
 * 没有一个常驻 tick，"每天自动刷"就只能靠人记得点 —— 那就不是自动化了。
 */
export function startScheduler(ctx, opts) {
  const { dshHome, bossMjs, cwd, sessionId = 'boss-whale', log = () => {}, toolsPath, seedSession = true } = opts

  const NODE_EXE = resolveNodeRuntime(dshHome)
  const NODE_ENV = nodeEnv(dshHome)

  let running = false
  let stopped = false
  let lastError = null
  let lastRunAt = null
  let warnedNoCred = false
  let chatRunning = false
  let lastChatAt = null

  const readState = () => readJson(planPath, {}) || {}
  const writeState = (o) => writeJsonAtomic(planPath, o)

  function appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    } catch {}
  }

  const delivery = createDelivery({ controller: ctx.sessionController, dshHome, cwd, sessionId, log })

  // ── 2026-10-27：会话要在启动后自己冒出来，而不是"等它跑到第一轮才存在" ──
  //   以前没跑过一轮 → 工作区里连窗口都没有 → 主人想看产出、想接着聊，找不到地方。
  //   这里建壳 + 打一句招呼。重试三次：插件加载时 sessionController 可能还没就绪。
  let sessionReady = false
  let sessionError = null
  let sessionIntro = 'pending'
  function introText() {
    return [
      '【求职助手 · 专属会话】我是这个插件固定的会话，叫 boss-whale。',
      '',
      '这里会发生两件事：',
      '  1) 每跑完一轮抓取，岗位清单和招呼语草稿会落到这里；',
      '  2) 你可以直接在这问我：“今天抓了几条”“换个关键词再跑一轮”“为什么第 3 条排这么高”。',
      '',
      `常用命令（工作目录 ${cwd}）：`,
      '  · node tools/boss.mjs status —— 配置 / 登录态 / 今日进度',
      '  · node tools/boss.mjs plan —— 下一轮什么时候跑',
      '  · node tools/boss.mjs deps —— 体检（登录态、令牌、能不能真抓）',
      '  · node tools/boss.mjs daily --dry —— 跑一轮但不落盘、对外什么都不发',
      '',
      '安全边界（不用你提醒，本来就是这样）：',
      '  · 打招呼和自动接话默认是关的，只有配置里打开而且当天还有额度才会真的发出去；',
      '  · status / plan / deps / --dry 全是只读或零副作用，随便跑。',
      '',
      '先别急着干活 —— 回一句你现在能做的事就行。',
    ].join('\n')
  }
  async function bootstrapSession() {
    if (stopped) return
    const ensured = await delivery.ensure()
    sessionReady = sessionReady || !ensured.error
    sessionError = ensured.error ?? null
    // 建会话/首播失败必须留下痕迹：不写日志的话，"窗口没出来"是没法排查的
    appendLog({ kind: 'session-boot', id: sessionId, ready: sessionReady, error: sessionError })
    if (!sessionReady) return
    if (seedSession) {
      const res = await delivery.introduce(introText())
      sessionIntro = res.sent ? 'done' : String(res.reason ?? 'skipped')
      appendLog({ kind: 'session-intro', id: sessionId, sent: res.sent === true, reason: sessionIntro })
    }
  }
  const sessionTimers = [8_000, 35_000, 120_000].map((ms) =>
    setTimeout(() => { bootstrapSession().catch((e) => { sessionError = String(e?.message ?? e) }) }, ms))

  function runTool(args, timeout = 120_000) {
    return new Promise((resolve) => {
      if (!NODE_EXE) return resolve({ ok: false, out: '', err: '没有可用的 node 运行时' })
      execFile(NODE_EXE, [bossMjs, ...args], { timeout, windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: Number.isFinite(err?.code) ? err.code : (err ? 1 : 0),
          out: String(stdout ?? ''),
          err: String(stderr ?? ''),
        })
      })
    })
  }

  /**
   * 招呼结果要写进播报 —— 否则 agent 会以为"还没打招呼"，然后建议你再去打一遍，
   * 而额度可能已经用掉了。让人和 agent 看到的是同一件事，比多写一句提示重要。
   */
  function greetLines(greet) {
    if (!greet) return []
    const q = greet.quota ?? {}
    const left = q.max !== undefined ? `今日 ${q.used}/${q.max}` : ''
    if (greet.ok) {
      return [
        `✓ 本次已自动打招呼 1 条：${greet.job?.name ?? ''} · ${greet.job?.brand ?? ''}（${left}）`,
        `  已发出的话：${String(greet.text ?? '').slice(0, 120)}`,
      ]
    }
    if (greet.dry) return [`（招呼试算，未发送）${greet.reason ?? ''}`]
    const lines = [`✗ 本次没打招呼：${greet.reason ?? '未知原因'}${left ? `（${left}）` : ''}`]
    if (greet.code === 'unknown-path') {
      lines.push('  接口路径不对 —— 这不是你的错，去设置页填「招呼接口路径」再试一次。')
    }
    return lines
  }

  function promptText(digestText, plan, greet) {
    const g = greetLines(greet)
    const autoGreet = greet?.ok === true
    return [
      `【求职播报】${plan?.window ? `窗口 ${plan.window} · ` : ''}第 ${(plan?.runs ?? 0) + 1}/${plan?.runsPerDay ?? '?'} 轮。`,
      '',
      digestText,
      ...(g.length ? ['', ...g] : []),
      '',
      '按下面做，不要等我说话：',
      '1) 先判断这份日报有没有"值得今天动手"的条目；没有就一句话说清为什么（岗位太少/薪资不匹配/全是老岗位）。',
      '2) 有的话，挑最多 3 条，每条给一句「为什么值得看」+ 一条可以直接粘贴的招呼语（基于上面的草稿改，别改得浮夸）。',
      autoGreet
        ? '3) ⛔ 上面那条招呼插件已经替你发出去了。**不要再发第二条** —— 每天上限 2 条，这是防止账号被风控的硬线。剩下需要发消息的，由我本人点。'
        : '3) ⛔ 不要自己去 BOSS 上打招呼、投简历 —— 插件只做发现和整理，发消息由我本人点。',
      '4) 结尾用一行 `BOSS_WHALE_DONE` 收尾，方便我确认这一轮已经跑完。',
    ].join('\n')
  }

  async function tick() {
    if (stopped || running || !ctx.sessionController) return
    running = true
    try {
      const cfg = readConfig()
      const state = readState()
      const plan = makePlan(cfg, state)
      writeState({ ...state, plan: { ...plan, atText: plan.atText } })

      if (plan.action === 'done' || plan.action === 'wait') {
        if (plan.action === 'done') lastError = null
        return
      }
      if (plan.action === 'skip') {
        writeState(completePlan(state, plan))
        appendLog({ kind: 'skip', reason: plan.reason, window: plan.window })
        log(`[boss-whale] 本轮跳过：${plan.reason}`)
        return
      }

      // action === 'run'
      // ⚠️ 没登录态就别跑：否则每轮都失败一次，还把今日轮数白耗掉
      //   （失败也 completePlan 是必须的 —— 不然会每分钟重试一整页请求）
      const cred = credentialState()
      if (!cred.present || !cred.hasStoken) {
        if (!warnedNoCred) {
          warnedNoCred = true
          appendLog({ kind: 'no-credentials' })
          log('[boss-whale] 还没配置 BOSS 登录态，跳过本轮（去 设置 → 求职 粘贴 cookie）')
        }
        return
      }
      warnedNoCred = false

      // 只有开了自动沟通才带 --greet。额度由 greet.mjs 在落盘账本上算，
      // 所以就算这里多调几次，也不会超过每天 2 条。
      const args = ['daily', '--json']
      if (cfg.greet?.enabled === true) args.push('--greet')
      // 虚拟人是要真的开浏览器、真的滚动、真的停留的 —— 180 秒会把它中途掐死，
      // 掐死的表现是"这个进程没有返回结果"，看起来像故障，其实是等得不够。
      const res = await runTool(args, 420_000)
      let payload = null
      try { payload = JSON.parse(String(res.out).trim().split('\n').pop() ?? '{}') } catch {}

      if (!payload?.text) {
        const why = String(res.err || res.out || 'daily 没有返回结果').slice(0, 300)
        lastError = why
        appendLog({ kind: 'error', error: why })
        writeState(completePlan(state, plan))
        log('[boss-whale] 抓取失败：' + why)
        return
      }

      if (cfg.digest?.pushToSession === false) {
        appendLog({ kind: 'run-silent', fetched: payload.fetched, fresh: payload.fresh })
        writeState(completePlan(state, plan))
        return
      }

      await delivery.send({
        requestId: `boss-whale-${Date.now()}`,
        mode: 'queue',
        content: [{ type: 'text', text: promptText(payload.text, plan, payload.greet) }],
      })

      writeState(completePlan(state, plan))
      lastRunAt = Date.now()
      lastError = null
      appendLog({
        kind: 'run',
        fetched: payload.fetched,
        fresh: payload.fresh,
        errors: payload.errors ?? [],
        greet: payload.greet ? { ok: payload.greet.ok, code: payload.greet.code, job: payload.greet.job?.name ?? null } : null,
      })
      log(`[boss-whale] 已投递第 ${plan.runs + 1} 轮（新岗位 ${payload.fresh} 条）${payload.greet?.ok ? ' · 已打招呼 1 条' : ''}`)
    } catch (e) {
      lastError = String(e?.message ?? e)
      log('[boss-whale] tick 失败：' + lastError)
    } finally {
      running = false
    }
  }

  /**
   * 接话 tick：看对方回了没，按规则接一句或交回人工。
   *
   * 和抓岗位完全分开，理由：
   *   · 抓岗位是「到点跑一轮」，接话是「有动静才动」，两种节奏硬塞进一个 tick 会互相拖；
   *   · 接话失败（接口路径不对）不该把今日轮数耗掉。
   */
  function chatNotice(actions) {
    const lines = ['【BOSS 会话】']
    for (const a of actions.slice(0, 6)) {
      const who = a.boss || '对方'
      if (a.decision === 'reply') {
        lines.push(`↩ 已自动回 · ${who}：${String(a.text ?? '').slice(0, 40)}`)
        lines.push(`   我方：${String(a.sent ?? '').slice(0, 80)}`)
      } else if (a.decision === 'handoff') {
        lines.push(`⚠ 需要你本人 · ${who}：${String(a.text ?? '').slice(0, 60)}`)
        lines.push(`   原因：${a.reason}`)
      } else if (a.decision === 'close') {
        lines.push(`✓ 已结束 · ${who}：${String(a.text ?? '').slice(0, 40)}`)
      } else if (a.decision === 'send-failed') {
        lines.push(`✗ 发送失败 · ${who}：${a.error}`)
      }
    }
    lines.push('', '这些已经处理完，不用你再发一遍。要接手的话直接在这儿跟我说。')
    return lines.join('\n')
  }

  async function chatTick() {
    if (stopped || chatRunning || !ctx.sessionController) return
    const cfg = readConfig()
    if (cfg.greet?.enabled !== true || cfg.greet?.autoContinue !== true) return
    if (cfg.greet?.quietOnly !== false && !insideWindow(cfg)) return
    if (!credentialState().present) return

    chatRunning = true
    try {
      const res = await runTool(['replies', '--auto', '--json'], 120_000)
      let payload = null
      try { payload = JSON.parse(String(res.out).trim().split('\n').pop() ?? '{}') } catch {}
      if (!payload?.ok) {
        const why = String(payload?.error || res.err || res.out || 'replies 没有返回结果').slice(0, 200)
        appendLog({ kind: 'chat-error', error: why })
        log('[boss-whale] 接话失败：' + why)
        return
      }
      // hold 里只有"交回人工"值得播报；其他的（没开、今天用完）不该反复打扰
      const interesting = (payload.actions ?? []).filter(
        (a) => a.decision !== 'wait' && !(a.decision === 'hold' && !/交回/.test(String(a.reason ?? ''))),
      )
      lastChatAt = Date.now()
      if (!interesting.length) return
      await delivery.send({
        requestId: `boss-whale-chat-${Date.now()}`,
        mode: 'queue',
        content: [{ type: 'text', text: chatNotice(interesting) }],
      })
      appendLog({ kind: 'chat', actions: interesting.map((a) => a.decision) })
      log(`[boss-whale] 会话有 ${interesting.length} 条动静`)
    } catch (e) {
      appendLog({ kind: 'chat-error', error: String(e?.message ?? e) })
      log('[boss-whale] 接话 tick 失败：' + (e?.message ?? e))
    } finally {
      chatRunning = false
    }
  }

  const boot = setTimeout(() => { tick().catch(() => {}) }, 12_000)
  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  // 启动后先等一下再接话 tick：让抓岗位那一轮先落地，避免两个子进程同时抢 cookie/风控额度
  const chatBoot = setTimeout(() => { chatTick().catch(() => {}) }, 90_000)
  const chatTimer = setInterval(() => { chatTick().catch(() => {}) }, CHAT_TICK_MS)
  log(`[boss-whale] 生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId} · 接话 ${CHAT_TICK_MS / 60000}min 轮询）`)

  return {
    tick,
    chatTick,
    status() {
      const state = readState()
      const cd = state.cooldown ?? null
      return {
        ok: !lastError,
        lastError,
        lastRunAt,
        lastChatAt,
        state: { date: state.date ?? null, runs: state.runs ?? 0, lastAt: state.lastAt ?? null },
        plan: state.plan ?? null,
        // 冷却期要能被界面看见：不然用户只会看到"今天怎么没跑"，
        // 然后在设置页反复点「立即跑一轮」，把 IP 撞得更狠。
        cooldown: cd
          ? {
            kind: cd.kind ?? null,
            message: cd.message ?? '',
            until: cd.until ?? 0,
            remainingMin: Math.max(0, Math.ceil((Number(cd.until ?? 0) - Date.now()) / 60_000)),
            active: Number(cd.until ?? 0) > Date.now(),
          }
          : null,
        toolsPath: toolsPath || null,
        // 专属会话有没有冒出来 —— 看不见这块就别指望在里面聊了
        session: { id: sessionId, ready: sessionReady, intro: sessionIntro, error: sessionError },
      }
    },
    invalidate() {
      // 设置改了就立刻重算一次（窗口/次数变了要马上生效）
      tick().catch(() => {})
      // 顺手再试一次建会话：万一上次 sessionController 还没就绪，点一次「保存」就能补上
      bootstrapSession().catch(() => {})
    },
    stop() {
      stopped = true
      clearTimeout(boot)
      clearInterval(timer)
      clearTimeout(chatBoot)
      clearInterval(chatTimer)
      for (const t of sessionTimers) clearTimeout(t)
    },
  }
}
