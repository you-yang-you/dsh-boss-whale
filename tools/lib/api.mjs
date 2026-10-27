import https from 'node:https'
import crypto from 'node:crypto'
import { readCredentials } from './auth.mjs'
import { resolveCityCode } from './config.mjs'

const ORIGIN = 'https://www.zhipin.com'
const SEARCH_PATH = '/wapi/zpgeek/search/joblist.json'

/** 礼貌节流：两次请求之间至少隔 minGap，再叠一段随机抖动（别让账号看起来像脚本） */
let lastAt = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pace(fetchCfg) {
  const gap = Math.max(1, Number(fetchCfg?.minGapSec ?? 6)) * 1000
  const jitter = Math.max(0, Number(fetchCfg?.jitterSec ?? 4)) * 1000
  const wait = lastAt + gap + Math.random() * jitter - Date.now()
  if (wait > 0) await sleep(wait)
  lastAt = Date.now()
}

function request(url, { cookie, ua, timeoutMs }) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'user-agent': ua,
          cookie,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: `${ORIGIN}/web/geek/job?query=&city=100010000`,
          'x-requested-with': 'XMLHttpRequest',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            location: res.headers?.location ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    req.on('error', (err) => resolve({ status: 0, error: String(err?.message ?? err), body: '' }))
  })
}

/** 把 BOSS 的各种失败折成一句话：用户看得懂，也能照着改 */
function classify(status, body) {
  if (status === 0) return { kind: 'network', message: body || '连不上 zhipin.com' }
  if (status >= 300 && status < 400) {
    return { kind: 'auth', message: '被重定向到登录页：cookie 已失效，请在浏览器重新登录后复制新的 cookie' }
  }
  let json = null
  try { json = JSON.parse(body) } catch {}
  if (!json) {
    if (/安全验证|验证码|geetest|captcha/i.test(body)) {
      return { kind: 'risk', message: '触发了人机校验（页面返回验证码）：本次不是抓取失败，是频率或环境被盯上了 —— 停一小时再试' }
    }
    return { kind: 'parse', message: `返回的不是 JSON（HTTP ${status}）` }
  }
  const code = Number(json.code)
  const msg = String(json.message ?? json.msg ?? '')
  if (code === 0) return { kind: 'ok', json }

  // 35 与 37 是两件事，混在一起说会把人引到错的动作上：
  //   35 = IP 级别被限流（停手，等；重新登录没用）
  //   37 = 环境异常（浏览器 cookie 拿到 node 回放必然触发，改走虚拟人；也不是"cookie 过期"）
  if (code === 35 || /IP地址存在异常|IP 地址存在异常/.test(msg)) {
    return {
      kind: 'ip-risk',
      message: `code 35：您的 IP 存在异常行为（${msg || 'IP 被限流'}）—— 这是 IP 级别限流，跟 cookie 无关。别重新登录，停几小时再用「虚拟人」模式`,
    }
  }
  if (code === 37 || /环境存在异常|环境异常/.test(msg)) {
    return {
      kind: 'env-risk',
      message: `code 37：环境异常（${msg || '环境不匹配'}）—— 浏览器里的 cookie 拿到 node 里回放会被判成非人类环境，换 cookie 也没用；改用「虚拟人」浏览模式`,
    }
  }
  if (code === 1 || /登录|未登录|请先/.test(msg)) {
    return { kind: 'auth', message: `未登录或登录态失效（code ${code} ${msg}）` }
  }
  return { kind: 'api', message: `接口返回 code ${code}：${msg || '无说明'}`, json }
}

/** 遇到这些就不要再往下抓了（再抓只会更糟） */
export const STOP_KINDS = new Set(['auth', 'risk', 'ip-risk', 'env-risk', 'captcha'])

function parseSalary(desc) {
  const text = String(desc ?? '')
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)\s*[Kk千]/)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    return { salaryMin: lo, salaryMax: hi, salaryMid: (lo + hi) / 2, unit: 'K' }
  }
  const months = text.match(/(\d+)\s*薪/)
  const single = text.match(/(\d+(?:\.\d+)?)\s*[Kk]/)
  if (single) {
    const v = Number(single[1])
    return { salaryMin: v, salaryMax: v, salaryMid: v, unit: 'K', months: months ? Number(months[1]) : null }
  }
  return { salaryMin: null, salaryMax: null, salaryMid: null, unit: null }
}

/**
 * 岗位内容指纹 —— 与 encryptJobId 无关的"同一件事"判定。
 *
 * 为什么需要两个主键：encryptJobId 由 jobId + 每次下发的 securityId 派生，
 * HR 重新发布、或换了安全令牌，同一个岗位就会拿到新 id。只按 id 去重，
 * 日报里会反复出现同一个岗位。指纹不看 id，只看"公司+职位+城市+薪资"。
 *
 * 有意保留 salaryDesc：薪资改了说明是值得再看一眼的变化，不该被折叠。
 * 也不做过度归一（比如抹掉城市区县）：宁可少折叠一条，也不要误吞一条真实岗位。
 */
const FP_DROP = /[\s\u3000（）()【】\[\]{}「」『』·、,，.。:：;；!！?？/\\|~～\-—_+&'"“”‘’]/g

export function jobFingerprint(job) {
  const n = (s) => String(s ?? '').toLowerCase().replace(FP_DROP, '')
  const body = [n(job.brand), n(job.name), n(job.city), n(job.salaryDesc)].join('|')
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)
}

function normalize(raw) {
  const encryptId = String(raw.encryptJobId ?? raw.encryptBossId ?? '')
  const salary = parseSalary(raw.salaryDesc)
  const job = {
    name: String(raw.jobName ?? ''),
    brand: String(raw.brandName ?? ''),
    industry: String(raw.brandIndustry ?? ''),
    scale: String(raw.brandScaleName ?? ''),
    stage: String(raw.brandStageName ?? ''),
    salaryDesc: String(raw.salaryDesc ?? ''),
    ...salary,
    city: [raw.cityName, raw.areaDistrict, raw.businessDistrict].filter(Boolean).join('·'),
    experience: String(raw.jobExperience ?? ''),
    degree: String(raw.jobDegree ?? ''),
    labels: Array.isArray(raw.jobLabels) ? raw.jobLabels.map(String) : [],
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    welfare: Array.isArray(raw.welfareList) ? raw.welfareList.map(String).slice(0, 6) : [],
    boss: [raw.bossName, raw.bossTitle].filter(Boolean).join(' · '),
    securityId: String(raw.securityId ?? ''),
    // 打招呼要用的四个原始标识，单独留出来。
    // 不能让下游从 id 猜：encryptJobId（岗位）和 encryptBossId（老板）长得一样但是两个东西，
    // 拿错了要么接口报错，要么把招呼打到错的对象上。
    encryptJobId: String(raw.encryptJobId ?? ''),
    encryptBossId: String(raw.encryptBossId ?? ''),
    bossId: String(raw.bossId ?? raw.encryptBossId ?? ''),
    lid: String(raw.lid ?? ''),
    url: encryptId
      ? `${ORIGIN}/job_detail/${encryptId}.html?securityId=${encodeURIComponent(String(raw.securityId ?? ''))}`
      : `${ORIGIN}/web/geek/job?query=${encodeURIComponent(String(raw.jobName ?? ''))}`,
    at: new Date().toISOString(),
  }
  // 指纹先算，id 缺失时直接用它兜底 —— 两者同源，不会出现"两套判断标准"
  job.fp = jobFingerprint(job)
  job.id = encryptId || job.fp
  return job
}

export function buildSearchUrl(cfg, page = 1) {
  const city = resolveCityCode(cfg)
  if (!city.code) throw new Error(city.error)
  const s = cfg.search ?? {}
  const params = new URLSearchParams({
    scene: '1',
    query: String((s.keywords ?? []).join(' ') || ''),
    city: city.code,
    page: String(page),
    pageSize: String(Math.min(30, Math.max(10, Number(s.pageSize ?? 30)))),
  })
  if (s.experience) params.set('experience', String(s.experience))
  if (s.degree) params.set('degree', String(s.degree))
  return { url: `${ORIGIN}${SEARCH_PATH}?${params.toString()}`, city }
}

/** 单页抓取（不落盘） */
export async function fetchPage(cfg, page, cred) {
  const credentials = cred ?? readCredentials()
  if (!credentials) {
    return { ok: false, kind: 'auth', message: '本机还没有 BOSS 登录态：请到 设置 → 求职 粘贴 cookie' }
  }
  const { url } = buildSearchUrl(cfg, page)
  await pace(cfg.fetch)
  const raw = await request(url, {
    cookie: credentials.cookie,
    ua: credentials.ua ?? 'Mozilla/5.0',
    timeoutMs: Math.max(5000, Number(cfg.fetch?.timeoutMs ?? 20000)),
  })
  const verdict = classify(raw.status, raw.body)
  if (verdict.kind !== 'ok') {
    if (verdict.kind === 'parse') verdict.message += `：${String(raw.body).slice(0, 120)}`
    return { ok: false, ...verdict }
  }
  const list = verdict.json?.zpData?.jobList
  if (!Array.isArray(list)) {
    return { ok: false, kind: 'parse', message: '返回结构里没有 zpData.jobList（接口可能改版了）' }
  }
  return { ok: true, page, jobs: list.map(normalize), total: Number(verdict.json?.zpData?.totalCount ?? 0) }
}

/** 多页抓取 */
export async function fetchAll(cfg, { pages } = {}) {
  const want = Math.min(
    Math.max(1, Number(cfg.fetch?.maxPagesPerRun ?? 4)),
    Math.max(1, Number(pages ?? cfg.search?.pages ?? 2)),
  )
  const all = []
  const errors = []
  for (let p = 1; p <= want; p += 1) {
    const res = await fetchPage(cfg, p)
    if (!res.ok) {
      errors.push({ page: p, kind: res.kind, message: res.message })
      if (STOP_KINDS.has(res.kind)) break   // 这类错误再抓只会更糟
      continue
    }
    all.push(...res.jobs)
    if (res.jobs.length < 10) break
  }
  return { ok: errors.length === 0 || all.length > 0, jobs: all, errors, pages: want }
}

export { classify, normalize, parseSalary, request, pace }
