import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { credentialsPath, readJson, writeJsonAtomic, ensureDir } from './paths.mjs'

/**
 * BOSS 的登录态就是 cookie。
 *
 * 必须整体从浏览器复制（Application → Cookies → https://www.zhipin.com）：
 * 关键字段是 `__zp_stoken__`（反爬令牌，JS 生成）+ `bst` / `wt2` / `zp_at` / `lastCity`。
 * 只复制 document.cookie 会丢字段（部分是 HttpOnly），所以这里只接受"粘贴整串/整行"。
 */

export const REQUIRED = ['__zp_stoken__', 'bst', 'wt2']

export class AuthError extends Error {
  /**
   * code 让上层能"按原因分支"，而不是拿 message 去正则匹配。
   * 例：登录拿不到 Electron 窗口时（code=no-electron）应当自动降级到系统浏览器，
   * 而 message 是给人看的中文，随时可能改一个字 —— 靠它分支是最脆的写法。
   */
  constructor(message, code = null) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

/** 把用户粘进来的东西解析成 Cookie 头字符串 */
export function parseCookieInput(input) {
  let text = String(input ?? '').trim()
  if (!text) throw new AuthError('cookie 是空的')

  // 允许直接粘 {"cookie":"..."} / {"cookies":"..."} / 数组形式
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      const picked = Array.isArray(parsed)
        ? parsed.map((x) => (typeof x === 'string' ? x : `${x.name ?? x.key}=${x.value ?? ''}`)).join('; ')
        : String(parsed.cookie ?? parsed.cookies ?? parsed.value ?? '')
      if (picked) text = picked
    } catch {
      throw new AuthError('看起来是 JSON，但解析失败；请直接粘贴 `a=b; c=d` 形式的 cookie')
    }
  }

  const pairs = []
  for (const line of text.split(/[\r\n]+/)) {
    for (const part of line.split(';')) {
      const seg = part.trim()
      if (!seg) continue
      const eq = seg.indexOf('=')
      if (eq <= 0) continue
      const key = seg.slice(0, eq).trim()
      const value = seg.slice(eq + 1).trim()
      if (!key || !/^[A-Za-z0-9_.\-]+$/.test(key)) continue
      if (!value) continue
      pairs.push([key, value])
    }
  }
  if (!pairs.length) throw new AuthError('没解析出任何 `key=value`；请重新复制 cookie')

  const dict = new Map(pairs)
  const missing = REQUIRED.filter((k) => !dict.has(k))
  const cookie = [...dict.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  if (cookie.length < 40) throw new AuthError('cookie 太短，像是没复制全')
  return { cookie, count: dict.size, missing }
}

export function saveCredentials(cookie) {
  ensureDir(path.dirname(credentialsPath))
  const rec = {
    cookie,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    savedAt: new Date().toISOString(),
    fp: crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12),
  }
  writeJsonAtomic(credentialsPath, rec)
  try { fs.chmodSync(credentialsPath, 0o600) } catch {}
  return rec
}

export function readCredentials() {
  const rec = readJson(credentialsPath, null)
  if (!rec?.cookie) return null
  return rec
}

/** 只回「有没有、够不够」，绝不回显 cookie 内容 */
export function credentialState() {
  const rec = readCredentials()
  if (!rec) return { present: false, hasStoken: false, hasBst: false, savedAt: null, fp: null }
  const dict = new Map(
    rec.cookie.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
      const eq = s.indexOf('=')
      return [s.slice(0, eq), s.slice(eq + 1)]
    }),
  )
  return {
    present: true,
    hasStoken: dict.has('__zp_stoken__'),
    hasBst: dict.has('bst'),
    savedAt: rec.savedAt ?? null,
    fp: rec.fp ?? null,
  }
}
