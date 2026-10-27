import { REQUIRED } from '../tools/lib/auth.mjs'

/**
 * 两条登录路线（Electron 内嵌窗口 / 系统浏览器）共用的东西。
 *
 * 抽出来的唯一理由是"判定标准必须只有一份"：三条关键字段、验证接口、三档结论。
 * 两份实现各写一遍的话，迟早出现"窗口登录认登录、浏览器登录不认"这种诡异差异，
 * 而两边都是"看着像成功了"的状态，非常难查。
 */

export const LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login'
export const VERIFY_URL = 'https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json'
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const ZHIPIN_HOST = /^https:\/\/([a-z0-9-]+\.)*(zhipin|weizhipin|bosszhipin)\.com(\/|$)/i
export const ZHIPIN_DOMAIN = /(^|\.)(zhipin|weizhipin|bosszhipin)\.com$/i
export { REQUIRED }

/** 同名多条 cookie（不同 path）时优先 path=/ 的那条，否则取先出现的 */
export function collectCookies(list, nowMs) {
  const map = new Map()
  const nowSec = nowMs / 1000
  for (const c of list ?? []) {
    if (!c?.name || !c?.value) continue
    if (typeof c.expirationDate === 'number' && c.expirationDate > 0 && c.expirationDate < nowSec) continue
    const prev = map.get(c.name)
    if (!prev) { map.set(c.name, c); continue }
    if (c.path === '/' && prev.path !== '/') map.set(c.name, c)
  }
  return map
}

/** 三个关键字段齐了才算"可能有登录态"，缺一个都不动 */
export function pickRequired(map) {
  return {
    names: REQUIRED.filter((k) => map.has(k)),
    missing: REQUIRED.filter((k) => !map.has(k)),
  }
}

export function cookieHeader(map) {
  return [...map.values()].map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 只保留 zhipin 域的 cookie，避免把浏览器里其它站的 cookie 一起写进磁盘 */
export function isZhipinCookie(c) {
  const d = String(c?.domain ?? '').replace(/^\./, '')
  return ZHIPIN_DOMAIN.test(d)
}

/**
 * 验证一次登录态。
 *
 * 用 getUserInfo 而不是直接抓 joblist：后者会消耗一次搜索额度、也更容易撞风控，
 * 而这个接口只读用户信息，未登录时明确返回 code 7。
 *
 * 三档结论，因为"验不通"和"没登录"是两件不同的事：
 *   ok:true      → code 0，确实登录了
 *   ok:false     → code 7 之类，明确没登录（这时不该报成功）
 *   ok:'unknown' → 网络失败 / code 37 风控。**不能当失败**：
 *                  node 直连没有 JS 环境，被风控拦下是常态，cookie 本身可能是好的。
 *                  判成失败会让用户反复扫码，永远扫不成功。
 */
export async function verifySession(header, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: 'unknown', message: '没有可用的 fetch' }
  try {
    const res = await fetchImpl(VERIFY_URL, {
      headers: {
        cookie: header,
        'user-agent': UA,
        referer: 'https://www.zhipin.com/web/geek/job',
        accept: 'application/json, text/plain, */*',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    })
    const body = await res.json().catch(() => null)
    const code = body?.code
    if (code === 0) {
      const d = body.zpData ?? {}
      const name = String(d.name ?? d.showName ?? d.nickName ?? d.realName ?? '').trim().slice(0, 40)
      const uid = String(d.uid ?? d.userId ?? d.encryptUserId ?? '').slice(0, 60)
      return { ok: true, account: { name: name || null, uid: uid || null } }
    }
    if (code === 7 || code === 1 || code === 3) {
      return { ok: false, message: `${body?.message ?? '当前登录状态已失效'}（code ${code}）` }
    }
    if (code === 37) {
      return { ok: 'unknown', message: 'code 37 环境异常（风控），不一定是登录没成功' }
    }
    return { ok: 'unknown', message: `${body?.message ?? '无法识别的响应'}（code ${code ?? '?'}）` }
  } catch (e) {
    return { ok: 'unknown', message: String(e?.name === 'TimeoutError' ? '请求超时' : (e?.message ?? e)).slice(0, 80) }
  }
}

/** 把验证结论翻成给用户看的 status/detail（两条登录路线共用同一套措辞） */
export function describeVerdict({ verdict, parsed, account, fp }) {
  if (verdict.ok === false) {
    return {
      status: 'unverified',
      detail: `已保存 ${parsed.count} 个 cookie 字段，但接口说没登录：${verdict.message}`,
    }
  }
  if (verdict.ok === 'unknown') {
    return {
      status: 'success',
      detail: `已登录并保存（${parsed.count} 个字段）—— 验证没走通：${verdict.message}，建议点「体检」再确认一次`,
    }
  }
  return {
    status: 'success',
    detail: `已登录${account?.name ? '：' + account.name : ''}，登录态已保存（${parsed.count} 个字段）`,
  }
}
