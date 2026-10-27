import crypto from 'node:crypto'
import { isTechLabel } from './human.mjs'
import { greetPath, readJson, writeJsonAtomic } from './paths.mjs'
import { localDate } from './plan.mjs'

/**
 * 打招呼 / 自动接话 —— **策略层**（这个文件不碰网络，纯记账 + 判断）
 *
 * 拆出来的理由：
 *   1. 能不能发、该不该发、发哪句，全是确定性逻辑，可以离线跑、可以单测；
 *   2. 真正发出去只有一个函数调用，路径错了也只影响那一步 —— 不会让"额度算错"
 *      和"接口 404"混在一个错误里（这两件事的修法完全不同）。
 *
 * 三条硬规则，写死在代码里，配置改不动：
 *   · 每天最多 2 条招呼（HARD_MAX_PER_DAY）。用户要的就是"两次及以下"，
 *     留一个能调成 50 的口子，就是把插件变成群发器。
 *   · 同一个人/同一个岗位（内容指纹）**永远**只打一次招呼，不因为重发换 id 就重打。
 *   · 出现要邮箱/微信/电话/简历/面试/薪资这些"只有本人能答"的话，立刻交回人工，
 *     半句都不替你说 —— 说错了是替你丢 offer，不是说错一句话。
 */

export const HARD_MAX_PER_DAY = 2
export const HARD_MAX_TURNS = 5

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function clampInt(v, lo, hi, dft) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dft
  return Math.min(hi, Math.max(lo, n))
}

const fmtTime = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '稍后'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 账本 ────────────────────────────────────────────────────────────────

export function loadLedger() {
  const raw = readJson(greetPath, null)
  const base = { version: 1, days: {}, greeted: {}, convs: {}, risk: null }
  if (!isObj(raw)) return base
  return {
    ...base,
    ...raw,
    days: isObj(raw.days) ? raw.days : {},
    greeted: isObj(raw.greeted) ? raw.greeted : {},
    convs: isObj(raw.convs) ? raw.convs : {},
  }
}

/**
 * 落盘并做保留期清理。
 * days 保留 60 天（够看趋势），greeted 保留 60 天（同一个人在两个月内被重发，
 * 概率已经很低；永久保留会让文件无限长，而"永久不重打"的收益并不比 60 天大）。
 */
export function saveLedger(ledger) {
  const now = Date.now()
  const cutoffDate = localDate(new Date(now - 60 * 86400_000))
  for (const k of Object.keys(ledger.days ?? {})) {
    if (k < cutoffDate) delete ledger.days[k]
  }
  const cutoff = now - 60 * 86400_000
  for (const [k, v] of Object.entries(ledger.greeted ?? {})) {
    const t = new Date(v?.at ?? 0).getTime()
    if (!Number.isFinite(t) || t < cutoff) delete ledger.greeted[k]
  }
  writeJsonAtomic(greetPath, ledger)
  return ledger
}

/** 今日额度快照 */
export function quota(cfg, ledger, now = new Date()) {
  const date = localDate(now)
  const max = clampInt(cfg?.greet?.maxPerDay, 0, HARD_MAX_PER_DAY, 0)
  const replyMax = clampInt(cfg?.greet?.maxRepliesPerDay, 0, 20, 6)
  const day = ledger?.days?.[date] ?? {}
  const used = Number(day.greeted ?? 0) || 0
  const replied = Number(day.replied ?? 0) || 0
  const riskUntil = ledger?.risk?.until ? new Date(ledger.risk.until) : null
  const risk = riskUntil && Number.isFinite(riskUntil.getTime()) && riskUntil.getTime() > now.getTime()
    ? { until: ledger.risk.until, reason: String(ledger.risk.reason ?? '') }
    : null
  return {
    date,
    max,
    used,
    left: Math.max(0, max - used),
    replyMax,
    replied,
    replyLeft: Math.max(0, replyMax - replied),
    risk,
  }
}

/** 同一个老板只维护一个会话：没有 boss id 就退到 securityId / 指纹，别用 name 当键 */
export function convKey(job) {
  return String(job?.encryptBossId || job?.bossId || job?.securityId || job?.fp || job?.id || '')
}

// ── 挑人 ────────────────────────────────────────────────────────────────

/**
 * 从今天的**新**岗位里挑一个打招呼。
 * @returns {{ok:boolean, code?:string, reason?:string, quota:object, job?:object, poolSize?:number}}
 */
export function pickTarget(jobs, cfg, ledger, now = new Date()) {
  const q = quota(cfg, ledger, now)

  if (cfg?.greet?.enabled !== true) {
    return { ok: false, code: 'disabled', reason: '自动打招呼没开（设置 → 求职 → 自动沟通）', quota: q }
  }
  if (q.risk) {
    return { ok: false, code: 'risk', reason: `风控冷却到 ${fmtTime(q.risk.until)}（${q.risk.reason || '环境异常'}）`, quota: q }
  }
  if (q.max === 0) {
    return { ok: false, code: 'zero', reason: '今日上限设为 0：只出草稿，不发送', quota: q }
  }
  if (q.left <= 0) {
    return { ok: false, code: 'exhausted', reason: `今日已发 ${q.used}/${q.max} 条，不再发`, quota: q }
  }

  const minScore = Number(cfg?.greet?.minScore ?? 10)
  const seen = ledger?.greeted ?? {}
  const pool = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j) return false
    if ((Number(j.score) || 0) < minScore) return false
    // 没有 encryptJobId + securityId 就发不出去。注意不能拿 encryptBossId 顶 jobId ——
    // 那会把招呼打到"老板"这个对象上，接口要么报错要么打错人。
    if (!j.encryptJobId || !j.securityId) return false
    if (j.fp && seen[j.fp]) return false
    if (j.id && seen[j.id]) return false
    return true
  })

  if (!pool.length) {
    return {
      ok: false,
      code: 'no-target',
      reason: `没有够格的新岗位（≥${minScore} 分、且没打过招呼）`,
      quota: q,
    }
  }

  pool.sort((a, b) => (b.score - a.score) || ((b.salaryMid ?? 0) - (a.salaryMid ?? 0)))
  return { ok: true, quota: q, job: pool[0], poolSize: pool.length }
}

// ── 生成招呼语 ──────────────────────────────────────────────────────────

export const DEFAULT_TEMPLATES = [
  '您好，看到「{brand}」在招「{name}」，我做过 {kw} 相关的工作，想了解下团队和具体的活儿。方便的话我把简历发您。',
  '您好，对「{name}」比较感兴趣：{kw} 方向有几年经验，{skills} 都用过。想请教下这个岗位现在最急的是哪块？',
]

function fillSlots(tpl, job, cfg) {
  const kw = (job?.hits ?? [])[0] ?? (cfg?.search?.keywords ?? [])[0] ?? '相关'
  // 2026-10-27：labels 里混着「经验不限 / 学历不限」这类任职要求，
  //   不筛掉的话第二句话会变成「技术栈上 经验不限、学历不限 我都用过」✗
  const skills = [...(job?.skills ?? []), ...(job?.labels ?? [])]
    .filter(isTechLabel).slice(0, 3).join('、')
  const sig = String(cfg?.greet?.signature ?? '').trim()
  const raw = String(tpl ?? '')
  const text = raw
    .replace(/\{name\}/g, job?.name ?? '这个岗位')
    .replace(/\{brand\}/g, job?.brand ?? '贵司')
    .replace(/\{kw\}/g, kw)
    .replace(/\{skills\}/g, skills || kw)
    .replace(/\{city\}/g, job?.city ?? '')
    .replace(/\{signature\}/g, sig)
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  // 填了落款但模板里没写 {signature} 时自动补在末尾。
  // 不补的话症状是"设置页填了落款、发出去没有"—— 而且是静默的，最容易被当成没保存。
  if (sig && !raw.includes('{signature}')) return `${text} ${sig}`.trim()
  return text
}

/**
 * 挑模板：按岗位指纹做确定性哈希，同一个岗位永远同一句（不会一会儿一个口吻），
 * 不同岗位之间又会轮换（别让三个人收到一模一样的话）。
 */
export function composeGreeting(job, cfg) {
  const tpls = (Array.isArray(cfg?.greet?.templates) && cfg.greet.templates.length
    ? cfg.greet.templates.map(String)
    : DEFAULT_TEMPLATES).filter((s) => s.trim())
  const list = tpls.length ? tpls : DEFAULT_TEMPLATES
  const seed = String(job?.fp || job?.encryptJobId || job?.id || job?.name || 'x')
  const idx = parseInt(crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) % list.length
  let text = fillSlots(list[idx], job, cfg)
  if (text.length > 400) text = `${text.slice(0, 397)}…`
  return { text, template: idx }
}

// ── 记账 ────────────────────────────────────────────────────────────────

export function recordGreeting(ledger, job, text, now = new Date()) {
  const date = localDate(now)
  const iso = now.toISOString()
  ledger.days = ledger.days ?? {}
  const day = ledger.days[date] ?? { greeted: 0, replied: 0 }
  day.greeted = Number(day.greeted ?? 0) + 1
  ledger.days[date] = day

  ledger.greeted = ledger.greeted ?? {}
  const stamp = { at: iso, name: job?.name ?? '', brand: job?.brand ?? '', encryptJobId: job?.encryptJobId ?? '' }
  if (job?.fp) ledger.greeted[job.fp] = stamp
  if (job?.id) ledger.greeted[job.id] = stamp

  ledger.convs = ledger.convs ?? {}
  const key = convKey(job)
  if (key) {
    ledger.convs[key] = {
      ...(ledger.convs[key] ?? {}),
      job: { name: job?.name ?? '', brand: job?.brand ?? '', url: job?.url ?? '' },
      status: 'greeted',
      turn: 0,
      greetedAt: iso,
      lastAt: iso,
      ours: [text],
      theirs: [],
    }
  }
  return ledger
}

export function recordReply(ledger, key, text, now = new Date()) {
  const date = localDate(now)
  const iso = now.toISOString()
  ledger.days = ledger.days ?? {}
  const day = ledger.days[date] ?? { greeted: 0, replied: 0 }
  day.replied = Number(day.replied ?? 0) + 1
  ledger.days[date] = day

  const conv = ledger.convs?.[key]
  if (conv) {
    conv.turn = Number(conv.turn ?? 0) + 1
    conv.status = 'chatting'
    conv.lastAt = iso
    conv.ours = [...(conv.ours ?? []), text].slice(-12)
  }
  return ledger
}

/** 风控冷却：宁可停一天，也别在人家已经报警的时候继续敲门 */
export function recordRisk(ledger, reason, minutes = 60, now = new Date()) {
  ledger.risk = {
    until: new Date(now.getTime() + Math.max(5, minutes) * 60_000).toISOString(),
    reason: String(reason ?? '').slice(0, 160),
    at: now.toISOString(),
  }
  return ledger
}

export function clearRisk(ledger) {
  ledger.risk = null
  return ledger
}

// ── 接话 ────────────────────────────────────────────────────────────────

/**
 * 对方这句话该不该自动回、回什么。
 *
 * 分类器只认"不需要承诺"的话。碰到要简历/要联系方式/约面试/谈薪资，
 * 一律 handoff（交回本人）—— 自动回这类话最可能的后果是替你答应了不该答的事。
 */
const REPLY_RULES = [
  { kind: 'rejected', re: /(已招满|招满了|不匹配|不太合适|不合适|暂不考虑|已经找到|已入职|不招了|勿扰|谢谢关注|岗位已关闭)/ },
  { kind: 'ask_resume', re: /(简历|附件|作品集|发一份|发我一份|发过来|resume)/i },
  { kind: 'ask_contact', re: /(微信|weixin|vx|电话|手机号|联系方式|加个|加下|qq|钉钉|企微)/i },
  { kind: 'ask_interview', re: /(面试|面谈|约个时间|什么时候方便|过来聊|线下面|视频面|到公司)/ },
  { kind: 'ask_salary', re: /(薪资|待遇|期望|多少钱|年包|总包|base|package|月薪)/i },
]

export function classifyBossReply(text) {
  const t = String(text ?? '')
  if (!t.trim()) return { kind: 'empty' }
  for (const rule of REPLY_RULES) {
    if (rule.re.test(t)) return { kind: rule.kind }
  }
  return { kind: 'generic' }
}

const HANDFF_TEXT = {
  ask_resume: '对方要简历 —— 附件得你本人发',
  ask_contact: '对方在要联系方式 —— 微信/电话只能你自己给',
  ask_interview: '对方在约面试 —— 时间要你自己定',
  ask_salary: '对方在谈钱 —— 薪资口径必须你自己说',
}

const GENERIC_REPLIES = [
  '好的，谢谢您回复。我这边主要做 {kw}，想先了解下这个岗位现在最急的是哪块？我再针对性说下我的经历。',
  '收到，谢谢。方便的话说下团队规模和技术栈？我看看跟我的经历对不对得上。',
]

function fillReply(tpl, conv, cfg, job) {
  const kw = (cfg?.search?.keywords ?? [])[0] ?? '这个方向'
  return String(tpl)
    .replace(/\{kw\}/g, kw)
    .replace(/\{name\}/g, job?.name ?? conv?.job?.name ?? '这个岗位')
    .replace(/\{brand\}/g, job?.brand ?? conv?.job?.brand ?? '贵司')
    .trim()
}

/**
 * 决定一个会话的下一步。
 * @returns {{action:'reply'|'handoff'|'close'|'wait'|'hold', reason:string, text?:string, kind?:string}}
 */
export function replyDecision(conv, cfg, ledger, now = new Date()) {
  const q = quota(cfg, ledger, now)
  const key = conv?.key ?? ''
  const state = ledger?.convs?.[key] ?? conv

  if (cfg?.greet?.enabled !== true) return { action: 'hold', reason: '自动沟通没开' }
  if (cfg?.greet?.autoContinue !== true) return { action: 'hold', reason: '自动接话没开' }
  if (q.risk) return { action: 'hold', reason: `风控冷却到 ${fmtTime(q.risk.until)}` }
  if (state?.status === 'handoff') return { action: 'hold', reason: '已交回人工' }
  if (state?.status === 'closed') return { action: 'hold', reason: '会话已关闭' }
  if (!state?.lastFromBoss) return { action: 'wait', reason: '对方还没回话' }
  if (state?.ours?.length && state?.lastBossAt && state?.lastOurAt && state.lastBossAt <= state.lastOurAt) {
    return { action: 'wait', reason: '最后一句是我方，等对方说' }
  }

  const cls = classifyBossReply(state?.lastBossText)
  if (cls.kind === 'empty') return { action: 'wait', reason: '对方消息为空' }
  if (cls.kind === 'rejected') {
    return { action: 'close', reason: '对方已明确拒绝，不再回（争这一句没有意义）', kind: cls.kind }
  }
  if (HANDFF_TEXT[cls.kind]) {
    return { action: 'handoff', reason: HANDFF_TEXT[cls.kind], kind: cls.kind }
  }

  const maxTurns = clampInt(cfg?.greet?.maxTurns, 0, HARD_MAX_TURNS, 2)
  if (Number(state?.turn ?? 0) >= maxTurns) {
    return { action: 'handoff', reason: `已自动接了 ${state.turn} 句，剩下的你自己聊`, kind: 'max-turns' }
  }
  if (q.replyLeft <= 0) {
    return { action: 'hold', reason: `今日自动接话已用满 ${q.replied}/${q.replyMax}`, kind: 'budget' }
  }

  const idx = Number(state?.turn ?? 0) % GENERIC_REPLIES.length
  const text = fillReply(GENERIC_REPLIES[idx], state, cfg, state?.job)
  return { action: 'reply', reason: '对方的是一般性问题，回一句继续往下聊', text, kind: 'generic' }
}

/** 给会话打标记（handoff / closed），让下一轮 tick 不再重复处理 */
export function markConv(ledger, key, patch) {
  ledger.convs = ledger.convs ?? {}
  ledger.convs[key] = { ...(ledger.convs[key] ?? {}), ...patch }
  return ledger
}

/**
 * 这条消息要不要处理？—— 方向 + 幂等，两个判断都是猜，所以放在一个地方、写清楚。
 *
 * mine  —— 最后一句是我方说的（列表接口给了 isSelf，或文本等于我们发过的最后一句）
 * seen  —— 同一条消息（文本 + 时间都没变）已经处理过
 *
 * 两个都判断不出来时（返回 mine:false, seen:false）才交给下一步决策；
 * 拿不准的时候倾向于"不动"，因为多发一句的代价比漏回一句大。
 */
export function inboundSignal(prev, item) {
  const ours = Array.isArray(prev?.ours) ? prev.ours : []
  const text = String(item?.lastMsg ?? '')
  if (item?.selfFlag === true) return { mine: true, seen: false }
  if (text && ours.length && text === String(ours[ours.length - 1])) return { mine: true, seen: false }
  if (!text) return { mine: false, seen: true }
  if (prev?.lastBossText === text && prev?.lastBossTime === item?.lastTime) return { mine: false, seen: true }
  return { mine: false, seen: false }
}

export function summarize(ledger, cfg, now = new Date()) {
  const q = quota(cfg, ledger, now)
  const convs = Object.entries(ledger?.convs ?? {}).map(([key, v]) => ({
    key,
    status: v.status ?? 'unknown',
    turn: Number(v.turn ?? 0),
    job: v.job ?? null,
    lastAt: v.lastAt ?? null,
    lastBossText: v.lastBossText ?? '',
  }))
  return { quota: q, convs: convs.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 20) }
}
