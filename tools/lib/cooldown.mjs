/**
 * 冷却期 —— 被风控拦下之后，唯一正确的动作是「停手」。
 *
 * 失败后的默认行为是最容易写错的地方：抛个错、打行日志，
 * 然后 60 秒后的下一个 tick 又去撞同一个墙。撞三次，IP 就从
 * 「环境异常(37)」升级成「IP 存在异常行为(35)」—— 35 是 IP 级的，
 * 会连带影响你正常用浏览器上 BOSS。
 *
 * 所以这里把「停多久」落盘，让调度器、命令行、设置页看到的是同一个结论。
 * 同一类问题一天内重复出现会翻倍（封顶 12 小时），
 * 因为反复出现说明我们的节奏本身有问题，不是运气不好。
 */

export const COOLDOWN_MIN = {
  'ip-risk': 180,     // code 35：IP 被限流，最轻也要三小时
  'env-risk': 60,     // code 37：环境异常，通常换个方式就过
  captcha: 120,       // 人机验证：出现就说明被盯上了
  auth: 0,            // 登录失效：不需要等，重新登录就行
}

const DAY = 24 * 60 * 60 * 1000

/**
 * @returns {{active:boolean, kind:string|null, message:string, until:number, remainingMin:number, hits:number}}
 */
export function cooldownStatus(state, now = Date.now()) {
  const cd = state?.cooldown
  if (!cd || !cd.until) return { active: false, kind: null, message: '', until: 0, remainingMin: 0, hits: 0 }
  const until = Number(cd.until)
  const rest = until - now
  return {
    active: rest > 0,
    kind: cd.kind ?? null,
    message: String(cd.message ?? ''),
    until,
    remainingMin: rest > 0 ? Math.ceil(rest / 60_000) : 0,
    hits: Number(cd.hits ?? 1),
  }
}

/**
 * 记一次风控。minutes 不传就按 kind 取默认值，并按"24 小时内第几次"翻倍。
 */
export function applyCooldown(state, { kind, message, minutes, now = Date.now() } = {}) {
  const key = String(kind ?? 'env-risk')
  const base = COOLDOWN_MIN[key] ?? 60
  const prev = state?.cooldown ?? null
  const prevHits = Number(prev?.hits ?? 0)
  // 注意别写成 `prev?.at ? ...`：时间戳 0 是合法值，用真值判断会把它当"没记录"，
  // 症状是"同类再犯不翻倍"，而且只在测试里（now 传 0）才暴露。
  const hasPrev = prev?.at !== undefined && prev?.at !== null
  const withinDay = hasPrev ? now - Number(prev.at) < DAY : false
  // 只在"冷却期还没过就又去撞"时才升级惩罚。
  // 按规矩等满了再来，说明节奏没问题，只是运气/环境还不行 —— 那种情况不该罚，
  // 否则认真等的人会被越罚越久，最后变成"越守规矩越用不了"。
  const prevActive = hasPrev && Number(prev.until ?? 0) > now
  const hits = withinDay && prevActive ? prevHits + 1 : 1
  const factor = Math.min(4, Math.max(1, hits))          // 1x → 2x → 3x → 4x，封顶
  const mins = Math.max(0, Number(minutes ?? base * factor))
  const until = now + mins * 60_000
  return {
    ...state,
    cooldown: {
      kind: key,
      message: String(message ?? '').slice(0, 200),
      minutes: mins,
      hits,
      at: now,
      until,
    },
  }
}

/** 手动解除（设置页「解除冷却」按钮用） */
export function clearCooldown(state) {
  const next = { ...state }
  delete next.cooldown
  return next
}

export function formatCooldown(cd) {
  if (!cd?.active) return ''
  const mins = cd.remainingMin
  const text = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`
  const until = new Date(cd.until)
  const hh = String(until.getHours()).padStart(2, '0')
  const mm = String(until.getMinutes()).padStart(2, '0')
  return `冷却中（${cd.kind}），还要 ${text}，${hh}:${mm} 后才再动`
}
