import https from 'node:https'
import { classify, pace } from './api.mjs'
import { readCredentials } from './auth.mjs'
import { endpointsPath, readJson, writeJsonAtomic } from './paths.mjs'

const ORIGIN = 'https://www.zhipin.com'
const DEFAULT_REFERER = `${ORIGIN}/web/geek/chat`

/**
 * 打招呼 / 接话 —— **传输层**（唯一有副作用的文件）
 *
 * ⚠️ 关于路径：BOSS 的内部接口路径没有公开文档，会变，而且不同灰度账号拿到的
 * 路径也不完全一样。这里的做法是「候选 + 探测 + 可覆盖」，而不是写死一条然后祈祷：
 *
 *   1. 内置候选（下面 CANDIDATES）只是**起点**，不是承诺；
 *   2. 探测结果记到 ~/.boss-ai/endpoints.json，成功过一次就固定下来，不反复试错；
 *   3. 全部候选都不通时，明确报 `unknown-path` 并告诉你下一步把真实路径填到
 *      greet.greetPath / listPath / sendPath —— 而不是抛一个笼统的“发送失败”。
 *
 * 为什么这件事必须说清：路径错和风控拦的区别是「改一个配置」vs「停一天别动」，
 * 混在一起报错会让人朝完全错误的方向折腾。
 */

const CANDIDATES = {
  // 读会话列表：只读，随便试，试错没有副作用
  list: [
    { id: 'zpchat-geek-list', method: 'GET', path: '/wapi/zpchat/geek/getBossList', query: { page: '1', pageSize: '20' } },
    { id: 'zpgeek-chat-list', method: 'GET', path: '/wapi/zpgeek/chat/list', query: { page: '1', pageSize: '20' } },
  ],
  // 打招呼：会真的发出去，**不做探测**，第一次就是第一次
  greet: [
    { id: 'friend-add', method: 'POST', path: '/wapi/zpgeek/friend/add.json' },
  ],
  // 接话：同样有副作用，靠上一次成功的路径沿用
  send: [
    { id: 'zpchat-send', method: 'POST', path: '/wapi/zpchat/geek/sendMessage' },
  ],
}

function httpJson(url, { cookie, ua, timeoutMs = 20000, method = 'GET', body, referer } = {}) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null
    const req = https.request(
      url,
      {
        method,
        headers: {
          'user-agent': ua || 'Mozilla/5.0',
          cookie: cookie || '',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: referer || DEFAULT_REFERER,
          'x-requested-with': 'XMLHttpRequest',
          ...(payload
            ? { 'content-type': 'application/json;charset=UTF-8', 'content-length': String(payload.length) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          location: String(res.headers?.location ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', (err) => resolve({ status: 0, location: '', body: String(err?.message ?? err) }))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 把 HTTP 结果翻译成一句能照着改的话（路径错 ≠ 风控 ≠ 没登录） */
function verdictOf(res) {
  if (res.status === 404) {
    return { kind: 'unknown-path', message: `接口路径不存在（HTTP 404）：${'这条候选不是当前灰度用的路径'}` }
  }
  if (res.status === 0) return { kind: 'network', message: res.body || '连不上 zhipin.com' }
  const body = String(res.body ?? '')
  const verdict = classify(res.status, body)
  if (verdict.kind === 'parse') {
    // HTML 而不是 JSON，八成是路径不对或被导到验证页
    if (/<html|<!DOCTYPE/i.test(body)) {
      return { kind: 'unknown-path', message: `返回的是网页不是 JSON（HTTP ${res.status}）：路径不对，或被导到了验证页` }
    }
    return { ...verdict, message: `${verdict.message}：${body.slice(0, 120)}` }
  }
  return verdict
}

function loadCache() {
  return readJson(endpointsPath, {}) || {}
}

function saveCache(kind, entry) {
  const cache = loadCache()
  cache[kind] = { path: entry.path, id: entry.id, at: new Date().toISOString() }
  writeJsonAtomic(endpointsPath, cache)
  return cache
}

const OVERRIDE_KEY = { list: 'listPath', greet: 'greetPath', send: 'sendPath' }

/**
 * 决定这次用哪条路：① 用户填的覆盖路径 ② 上次成功的 ③ 内置第一条
 * @returns {{id:string, method:string, path:string, source:'config'|'cache'|'default'}}
 */
export function resolveEndpoint(kind, cfg) {
  const override = String(cfg?.greet?.[OVERRIDE_KEY[kind]] ?? '').trim()
  if (override) {
    const hit = CANDIDATES[kind].find((e) => e.path === override)
    return { id: hit?.id ?? 'custom', method: hit?.method ?? (kind === 'list' ? 'GET' : 'POST'), path: override, source: 'config' }
  }
  const cache = loadCache()[kind]
  if (cache?.path) {
    const hit = CANDIDATES[kind].find((e) => e.path === cache.path)
    if (hit) return { ...hit, source: 'cache' }
    return { id: cache.id ?? 'custom', method: kind === 'list' ? 'GET' : 'POST', path: cache.path, source: 'cache' }
  }
  return { ...CANDIDATES[kind][0], source: 'default' }
}

function buildUrl(entry, extraQuery) {
  const url = new URL(`${ORIGIN}${entry.path}`)
  for (const [k, v] of Object.entries({ ...(entry.query ?? {}), ...(extraQuery ?? {}) })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return url.toString()
}

async function call(kind, { cfg, cred, method, body, query, referer }) {
  const credentials = cred ?? readCredentials()
  if (!credentials?.cookie) {
    return { ok: false, kind: 'auth', message: '本机还没有 BOSS 登录态：请到 设置 → 求职 粘贴 cookie' }
  }
  const entry = resolveEndpoint(kind, cfg)
  await pace(cfg?.fetch)
  const res = await httpJson(buildUrl(entry, query), {
    cookie: credentials.cookie,
    ua: credentials.ua,
    timeoutMs: Math.max(5000, Number(cfg?.fetch?.timeoutMs ?? 20000)),
    method: method ?? entry.method ?? 'GET',
    body,
    referer,
  })
  const verdict = verdictOf(res)
  if (verdict.kind !== 'ok') {
    return { ok: false, ...verdict, endpoint: entry, status: res.status, snippet: String(res.body ?? '').slice(0, 200) }
  }
  saveCache(kind, entry)
  return { ok: true, json: verdict.json, endpoint: entry }
}

// ── 打招呼 ──────────────────────────────────────────────────────────────

/**
 * 发一条招呼。**一次只发一条**，不做批量循环 —— 循环是群发的起点。
 * @returns {{ok:boolean, kind?:string, message?:string, text?:string, endpoint?:object, snippet?:string}}
 */
export async function greetJob({ job, text, cfg, cred }) {
  if (!job?.encryptJobId || !job?.securityId) {
    return { ok: false, kind: 'bad-target', message: '这条岗位缺 encryptJobId / securityId，发不出去（不是登录问题）' }
  }
  const res = await call('greet', {
    cfg,
    cred,
    body: { securityId: job.securityId, jobId: job.encryptJobId },
    referer: job.url || DEFAULT_REFERER,
  })
  if (!res.ok) return res
  return { ok: true, text, endpoint: res.endpoint, json: res.json }
}

// ── 会话列表 ────────────────────────────────────────────────────────────

/** 从可能长得不一样的结构里把会话数组挖出来（BOSS 改字段名的时候至少不会直接崩） */
function pickArray(zpData) {
  if (Array.isArray(zpData)) return zpData
  if (!zpData || typeof zpData !== 'object') return []
  for (const key of ['bossList', 'chatList', 'list', 'sessions', 'sessionList', 'result']) {
    if (Array.isArray(zpData[key])) return zpData[key]
  }
  return []
}

const str = (v) => (v === undefined || v === null ? '' : String(v))

function normalizeConv(raw) {
  const key = str(raw.encryptBossId || raw.encryptUid || raw.uid || raw.bossId || raw.securityId)
  const lastMsg = str(raw.lastMessage ?? raw.lastMsg ?? raw.lastMessageText ?? raw.msg ?? '')
  const lastTime = str(raw.lastTime ?? raw.lastTS ?? raw.lastTimestamp ?? raw.updateTime ?? '')
  const explicitSelf = raw.isSelf ?? raw.self ?? raw.lastIsSelf ?? raw.lastMsgIsSelf
  return {
    key,
    bossName: str(raw.bossName ?? raw.name),
    brand: str(raw.brandName ?? raw.companyName),
    jobName: str(raw.jobName ?? raw.jobTitle),
    securityId: str(raw.securityId),
    encryptBossId: str(raw.encryptBossId || raw.encryptUid || raw.uid),
    lastMsg,
    lastTime,
    unread: Number(raw.unreadMsgCount ?? raw.unread ?? 0) || 0,
    // 有些灰度账号会直接给 isSelf；没给就只能靠"和我们发过的文本比对"来判方向
    selfFlag: typeof explicitSelf === 'boolean' ? explicitSelf : null,
  }
}

export async function listConversations({ cfg, cred, page = 1 } = {}) {
  const res = await call('list', { cfg, cred, query: { page: String(page), pageSize: '20' } })
  if (!res.ok) return res
  const convs = pickArray(res.json?.zpData).map(normalizeConv).filter((c) => c.key)
  return { ok: true, convs, endpoint: res.endpoint }
}

// ── 接话 ────────────────────────────────────────────────────────────────

export async function sendReply({ conv, text, cfg, cred }) {
  if (!conv?.key) return { ok: false, kind: 'bad-target', message: '会话没有可用标识，发不出去' }
  const res = await call('send', {
    cfg,
    cred,
    body: {
      uid: conv.key,
      encryptBossId: conv.encryptBossId || conv.key,
      securityId: conv.securityId || '',
      content: text,
      type: 1,
      ...(conv.securityId ? { securityId: conv.securityId } : {}),
    },
    referer: DEFAULT_REFERER,
  })
  if (!res.ok) return res
  return { ok: true, text, endpoint: res.endpoint, json: res.json }
}

// ── 探测（只读） ─────────────────────────────────────────────────────────

/**
 * 只探测读接口 —— 会发消息的接口**不探测**。
 * 「探测」一个打招呼接口，本身就是给一个陌生人发了一条招呼，这不叫探测。
 */
export async function probe(cfg, cred) {
  const credentials = cred ?? readCredentials()
  if (!credentials?.cookie) return { ok: false, kind: 'auth', message: '没有登录态，无法探测', results: [] }
  const results = []
  for (const entry of CANDIDATES.list) {
    await pace(cfg?.fetch)
    const res = await httpJson(buildUrl(entry), {
      cookie: credentials.cookie,
      ua: credentials.ua,
      timeoutMs: Math.max(5000, Number(cfg?.fetch?.timeoutMs ?? 20000)),
      method: 'GET',
      referer: DEFAULT_REFERER,
    })
    const verdict = verdictOf(res)
    const convs = verdict.kind === 'ok' ? pickArray(verdict.json?.zpData).map(normalizeConv).filter((c) => c.key) : []
    results.push({
      id: entry.id,
      path: entry.path,
      ok: verdict.kind === 'ok',
      kind: verdict.kind,
      message: verdict.kind === 'ok' ? `通了，解析出 ${convs.length} 个会话` : verdict.message,
      status: res.status,
      snippet: String(res.body ?? '').slice(0, 160),
    })
    if (verdict.kind === 'ok') {
      saveCache('list', entry)
      break
    }
    if (verdict.kind === 'risk' || verdict.kind === 'auth') break // 这类再试只会更糟
  }
  return { ok: results.some((r) => r.ok), results }
}

export function cachedEndpoints() {
  return loadCache()
}
