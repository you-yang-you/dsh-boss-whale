/**
 * 生物钟的纯函数部分（宿主和命令行共用，方便单测）。
 *
 * 和 bili-whale 的差别：那边是「夜里随机醒几次」，这里是「白天的固定窗口里跑 N 轮」——
 * 求职这件事要可预期（早上刷一轮、下午补一轮），不需要随机浪漫。
 */
import { cooldownStatus } from './cooldown.mjs'

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function parseHM(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h === 24 && min === 0) return 24 * 60
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function normalizeWindows(windows) {
  const list = Array.isArray(windows) ? windows : []
  const out = []
  for (const w of list) {
    const start = parseHM(w?.start)
    const end = parseHM(w?.end)
    if (start === null || end === null) continue
    if (start === end) continue
    out.push({ start, end, text: `${w.start}-${w.end}` })
  }
  return out.length ? out : [{ start: 9 * 60 + 30, end: 11 * 60, text: '09:30-11:00' }]
}

/** 当前分钟是否落在窗口里（支持跨零点：22:00-02:00） */
export function inWindow(win, date) {
  const cur = date.getHours() * 60 + date.getMinutes()
  if (win.start < win.end) return cur >= win.start && cur < win.end
  return cur >= win.start || cur < win.end
}

function atMinutes(base, minutes) {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setMinutes(minutes)
  return d
}

/** 下一个窗口起点（今天还没到的，或明天的） */
export function nextWindowStart(windows, now) {
  let best = null
  for (const w of windows) {
    const today = atMinutes(now, w.start)
    let candidate = today
    if (candidate.getTime() <= now.getTime()) {
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      candidate = tomorrow
    }
    if (!best || candidate < best) best = candidate
  }
  return best ?? new Date(now.getTime() + 3600_000)
}

const fmt = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 决定「现在该干什么」。
 * @returns {{action:'run'|'skip'|'wait'|'done', date:string, atMs:number, atText:string, runs:number, runsPerDay:number, window:string|null, reason:string}}
 */
export function makePlan(cfg, state = {}, now = Date.now()) {
  const date = localDate(new Date(now))
  const plan = cfg?.plan ?? {}
  const runsPerDay = Math.min(12, Math.max(1, Number(plan.runsPerDay ?? 2) || 2))
  const minGapMs = Math.max(10, Number(plan.minGapMin ?? 180) || 180) * 60_000
  const skipChance = Math.min(0.95, Math.max(0, Number(plan.skipChance ?? 0)))
  const windows = normalizeWindows(plan.windows)

  const sameDay = state?.date === date
  const runs = sameDay ? Number(state.runs ?? 0) : 0
  const lastAt = sameDay ? Number(state.lastAt ?? 0) : 0

  const base = { date, runs, runsPerDay, atMs: now, atText: fmt(new Date(now)), window: null, reason: '' }

  if (runs >= runsPerDay) {
    return { ...base, action: 'done', reason: `今日已完成 ${runs}/${runsPerDay} 轮` }
  }

  // 被风控拦过就在冷却期内彻底停手。放在窗口判断之前：
  // 否则冷却期正好跨进窗口时，会被判成 "该跑了"，每 60 秒撞一次墙。
  const cd = cooldownStatus(state, now)
  if (cd.active) {
    return {
      ...base,
      action: 'wait',
      atMs: cd.until,
      atText: fmt(new Date(cd.until)),
      reason: `风控冷却中（${cd.kind}），还要 ${cd.remainingMin} 分钟${cd.message ? `：${cd.message}` : ''}`,
    }
  }

  const nowDate = new Date(now)
  const cur = windows.find((w) => inWindow(w, nowDate))
  if (!cur) {
    const next = nextWindowStart(windows, nowDate)
    return {
      ...base,
      action: 'wait',
      atMs: next.getTime(),
      atText: fmt(next),
      reason: next.getTime() - now > 0 && localDate(next) !== date ? `不在时间窗口，明天 ${fmt(next)} 再跑` : `不在时间窗口，${fmt(next)} 再跑`,
    }
  }

  const nextAllowed = lastAt ? lastAt + minGapMs : 0
  if (now < nextAllowed) {
    return {
      ...base,
      action: 'wait',
      atMs: nextAllowed,
      atText: fmt(new Date(nextAllowed)),
      window: cur.text,
      reason: `距上一轮不足 ${Math.round(minGapMs / 60_000)} 分钟`,
    }
  }

  const skip = Math.random() < skipChance
  return {
    ...base,
    action: skip ? 'skip' : 'run',
    window: cur.text,
    reason: skip ? '这一轮按概率跳过（跳过也算一轮，避免死循环重抽）' : `窗口 ${cur.text} 内，第 ${runs + 1}/${runsPerDay} 轮`,
  }
}

/** 跑完一轮（含跳过）后的新状态 */
export function completePlan(state, plan, now = Date.now()) {
  const date = localDate(new Date(now))
  const sameDay = state?.date === date
  const runs = (sameDay ? Number(state.runs ?? 0) : 0) + 1
  return {
    ...state,
    date,
    runs,
    lastAt: now,
    lastAction: plan?.action ?? 'run',
    lastReason: plan?.reason ?? '',
    history: [...(Array.isArray(state?.history) ? state.history : []).slice(-30), {
      date,
      at: new Date(now).toISOString(),
      action: plan?.action ?? 'run',
    }],
  }
}
