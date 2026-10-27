import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { BOSS_HOME, ensureDir } from '../tools/lib/paths.mjs'
import { parseCookieInput, saveCredentials, AuthError, REQUIRED } from '../tools/lib/auth.mjs'
import { cdpConnect } from './cdp.mjs'
import {
  LOGIN_URL, collectCookies, pickRequired, cookieHeader, isZhipinCookie,
  verifySession, describeVerdict,
} from './login-common.js'

/**
 * 用**本机的 Edge / Chrome** 登录（宿主弹不出 Electron 窗口时的兜底）
 *
 * ── 为什么需要这条路 ──────────────────────────────────────────────
 * DSH 0.2.x 里宿主插件跑在 Node 侧，`require('electron')` 拿到的只是一个可执行文件
 * 路径字符串，`BrowserWindow` 根本不存在。于是"弹个登录窗"这条最自然的做法在真实
 * 环境里直接失效 —— 而失效提示不能是"请手动抄 cookie"，那对一个几 KB 的
 * stoken 来说几乎不可完成。
 *
 * ── 做法 ────────────────────────────────────────────────────────
 * 用独立 profile 目录起一个 Edge/Chrome，带 `--remote-debugging-port=0`，
 * 导航到 BOSS **官方登录页**。用户在里面扫码（或手机号登录），
 * 我们通过 CDP 问这个浏览器"zhipin 域下的 cookie 有哪些"——HttpOnly 的也拿得到。
 *
 * ── 为什么必须独立 profile ───────────────────────────────────────
 * ① 复用你日常 profile 的话，浏览器已经在跑，新进程只会"转发给已有实例"然后退出，
 *    调试端口根本不会打开（这是这类功能最常见的"在我这儿不生效"的根因）。
 * ② 不碰你日常的登录态和标签页。
 * 代价是第一次要在这个新 profile 里扫一次码；之后它有持久化登录态，再点就是秒过。
 *
 * ── 安全边界 ────────────────────────────────────────────────────
 * 调试端口只监听 127.0.0.1，且拿到登录态后立刻 `Browser.close` 关掉浏览器。
 * 不留常驻调试端口 —— 那等于给本机任何程序开了个读账号的后门。
 */

const ARGS_BASE = [
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-sync',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--window-size=520,760',
]

const PORT_FILE = 'DevToolsActivePort'
const TICK_MS = 1200
const MAX_WAIT_MS = 10 * 60 * 1000
const ATTACH_TIMEOUT_MS = 25_000

/** 浏览器候选：先 Edge（Windows 上必然存在），再 Chrome / Chromium */
export function locateBrowser({ exists = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  const win = [
    ['Edge', path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Chrome', path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chromium', path.join(env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe')],
  ]
  const mac = [
    ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ]
  const nix = [
    ['Chrome', '/usr/bin/google-chrome'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Edge', '/usr/bin/microsoft-edge'],
  ]

  // 手动指定优先（用户机器上浏览器装在奇怪位置时，不用改代码）
  const forced = String(env.BOSS_WHALE_BROWSER ?? '').trim()
  if (forced) return { name: path.basename(forced).replace(/\.exe$/i, ''), bin: forced, forced: true }

  const list = platform === 'win32' ? win : platform === 'darwin' ? mac : nix
  for (const [name, bin] of list) {
    // 环境变量缺失时会拼出相对路径（比如 'Microsoft\Edge\...'），这种一定不存在，跳过即可
    if (!bin || !path.isAbsolute(bin)) continue
    try { if (exists(bin)) return { name, bin } } catch {}
  }
  return null
}

function readPortFile(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, PORT_FILE), 'utf8').split(/\r?\n/)
    const port = Number(lines[0])
    if (!Number.isFinite(port) || port <= 0) return null
    return { port, wsPath: (lines[1] ?? '').trim() }
  } catch {
    return null
  }
}

async function httpJson(url, { timeoutMs = 2500 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 额外的浏览器参数（可选）。用途：
 *   - 需要代理才能访问外网：`--proxy-server=http://127.0.0.1:7890`
 *   - 无显示器的机器上跑：`--headless=new`（扫不了码，但可以先把登录态灌进去）
 * 解析时支持引号，否则带空格的参数会被拆坏。
 */
export function splitArgs(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const out = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  // 把残留的引号全去掉：`--proxy-server="http://x"` 会被切成一个整体 token，
  // 但引号嵌在 '=' 后面，只 trim 首尾是取不掉的（这个 bug 的表现是参数带着引号传给浏览器）
  return out.map((s) => s.replace(/["']/g, '')).filter(Boolean)
}

/**
 * 起浏览器 + 连上调试端口。返回一个句柄，让上层只管"问 cookie"和"关掉"。
 * 这段是整个功能里最容易失败的地方（进程起不来 / 端口没开 / 页面还没建），
 * 所以每一步失败都带具体原因，不返回一个空对象让上层去猜。
 */
async function launchDefault({ bin, name, profileDir, onDisconnect, extraArgs = [] }) {
  ensureDir(profileDir)

  // 上次没关干净、或者浏览器还开着：直接复用它，别再起第二个
  let port = null
  let reattached = false
  const existing = readPortFile(profileDir)
  if (existing) {
    try { await httpJson(`http://127.0.0.1:${existing.port}/json/version`, { timeoutMs: 1200 }); port = existing.port; reattached = true } catch {}
  }

  let child = null
  if (!port) {
    try { fs.rmSync(path.join(profileDir, PORT_FILE), { force: true }) } catch {}
    try {
      child = spawn(bin, [...ARGS_BASE, ...extraArgs, `--user-data-dir=${profileDir}`, LOGIN_URL], {
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (e) {
      throw new AuthError(`起不来浏览器（${name}）：${String(e?.message ?? e).slice(0, 100)}`, 'browser-launch')
    }

    let spawnError = null
    child.on('error', (e) => { spawnError = e })
    child.on('exit', (code) => {
      if (code != null && code !== 0) spawnError = spawnError ?? new Error(`浏览器进程退出了（code ${code}）`)
    })

    const deadline = Date.now() + ATTACH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError) break
      const p = readPortFile(profileDir)
      if (p) {
        try { await httpJson(`http://127.0.0.1:${p.port}/json/version`, { timeoutMs: 1200 }); port = p.port; break } catch {}
      }
      await sleep(150)
    }
    if (!port) {
      try { child?.kill() } catch {}
      throw new AuthError(
        spawnError
          ? `起不来浏览器（${name}）：${String(spawnError.message ?? spawnError).slice(0, 120)}`
          : `浏览器起来了，但调试端口没开（${name}，等了 ${ATTACH_TIMEOUT_MS / 1000}s）。可能被安全软件拦了。`,
        'browser-launch',
      )
    }
  }

  // 找到那个页面 target。刚启动时可能还没有页面，所以这里要重试而不是"一次不成就放弃"
  let wsUrl = null
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  while (Date.now() < deadline && !wsUrl) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`)
      const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      // 优先挑已经导航到 zhipin 的那个；没有就挑第一个页面（新标签页也行）
      const hit = pages.find((t) => /zhipin\.com/i.test(String(t.url ?? ''))) ?? pages[0]
      if (hit) wsUrl = hit.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await sleep(200)
  }
  if (!wsUrl) {
    try { child?.kill() } catch {}
    throw new AuthError(`浏览器开了，但没找到可调试的页面（端口 ${port}）`, 'browser-attach')
  }

  let cdp
  try {
    cdp = await cdpConnect(wsUrl, { timeoutMs: 8000 })
  } catch (e) {
    try { child?.kill() } catch {}
    throw new AuthError(`连不上浏览器调试端口：${String(e?.message ?? e).slice(0, 120)}`, 'browser-attach')
  }

  if (onDisconnect) cdp.onDisconnect = onDisconnect

  try { await cdp.call('Network.enable', {}, { timeoutMs: 5000 }) } catch {}

  const getCookies = async () => {
    // Storage.getCookies 是新接口；Network.getAllCookies 虽被标 deprecated 但一直能用。
    // 两个都试，是因为不同 Chromium 版本/策略下可用性不一样 —— 只试一个的话，
    // 用户机器上就是"连上了但永远读不到 cookie"，比连不上更难查。
    try {
      const r = await cdp.call('Storage.getCookies', {}, { timeoutMs: 5000 })
      if (Array.isArray(r?.cookies)) return r.cookies
    } catch {}
    const r = await cdp.call('Network.getAllCookies', {}, { timeoutMs: 5000 })
    return Array.isArray(r?.cookies) ? r.cookies : []
  }

  return {
    name,
    port,
    reattached,
    getCookies,
    async close() {
      try { await cdp.call('Browser.close', {}, { timeoutMs: 1500 }) } catch {}
      try { cdp.close() } catch {}
      // Browser.close 有极小的概率不生效（比如浏览器卡在模态框上），补一刀
      await sleep(120)
      try { if (child && child.exitCode == null) child.kill() } catch {}
    },
  }
}

export class BrowserLogin {
  constructor({
    save = saveCredentials,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    locate = locateBrowser,
    launch = launchDefault,
    profileDir = path.join(BOSS_HOME, 'browser-profile'),
    env = process.env,
  } = {}) {
    this.save = save
    this.fetch = fetchImpl
    this.now = now
    this.locate = locate
    this.launch = launch
    this.profileDir = profileDir
    this.env = env
    this.current = null
    this.disposed = false
  }

  state(s) {
    if (!s) return { ok: true, status: 'idle', mode: 'browser', url: LOGIN_URL, browser: null }
    return {
      ok: true,
      id: s.id,
      status: s.status,
      mode: 'browser',
      url: LOGIN_URL,
      browser: s.browser ?? null,
      reattached: !!s.reattached,
      windowOpen: s.status === 'waiting',
      names: [...s.names],
      missing: [...s.missing],
      account: s.account ?? null,
      detail: s.detail ?? null,
      error: s.error ?? null,
      fp: s.fp ?? null,
      elapsedMs: this.now() - s.startedAt,
    }
  }

  async start() {
    if (this.disposed) throw new AuthError('登录服务已关闭，请重启 DSH 后再试', 'disposed')
    if (String(this.env.BOSS_WHALE_NO_BROWSER ?? '') === '1') {
      throw new AuthError('系统浏览器登录已禁用（BOSS_WHALE_NO_BROWSER=1）', 'no-browser')
    }
    const found = this.locate()
    if (!found) {
      throw new AuthError('没找到可用的浏览器（Edge / Chrome / Chromium 都没有）', 'no-browser')
    }

    this.cancel()

    const s = {
      id: randomUUID(),
      status: 'waiting',
      browser: found.name,
      handle: null,
      names: [],
      missing: [...REQUIRED],
      startedAt: this.now(),
      timer: null,
      checking: false,
      settled: false,
      account: null,
      detail: `正在打开 ${found.name}…（第一次会是一个新的浏览器配置，需要在这里扫一次码）`,
      error: null,
      fp: null,
      reattached: false,
    }
    this.current = s

    // 不 await：起浏览器要几秒，前端每 1.2s 轮询状态就够了。
    // 真正的失败会在下面 catch 里落到 status:'error'，而不是让 HTTP 请求挂在那儿。
    this._boot(s, found).catch((e) => {
      if (s.settled) return
      s.status = 'error'
      s.error = e instanceof AuthError ? e.message : String(e?.message ?? e).slice(0, 200)
      this._finish(s)
    })

    return this.state(s)
  }

  async _boot(s, found) {
    const handle = await this.launch({
      bin: found.bin,
      name: found.name,
      profileDir: this.profileDir,
      extraArgs: splitArgs(this.env.BOSS_WHALE_BROWSER_ARGS),
      onDisconnect: () => {
        if (s.settled) return
        s.status = 'cancelled'
        s.detail = '浏览器窗口关掉了，还没拿到登录态'
        s.settled = true
        if (s.timer) { clearInterval(s.timer); s.timer = null }
      },
    })
    if (s.settled) { try { await handle.close() } catch {}; return }

    s.handle = handle
    s.reattached = !!handle.reattached
    s.detail = handle.reattached
      ? `已接上正在运行的 ${found.name}，在里面确认已登录（已登录过就不用再扫）`
      : `${found.name} 已打开，用手机 BOSS 直聘 App 扫码（也可以在里面用手机号登录）`

    s.timer = setInterval(() => { this._check(s).catch(() => {}) }, TICK_MS)
    this._check(s).catch(() => {})
  }

  poll(id) {
    const s = this.current
    if (!s) return this.state(null)
    if (id && s.id !== id) throw new AuthError('这次登录流程已经结束，请重新点「扫码登录」', 'stale')
    if (!s.settled && s.status === 'waiting') this._check(s).catch(() => {})
    if (!s.settled && this.now() - s.startedAt > MAX_WAIT_MS) {
      s.status = 'expired'
      s.detail = '等了 10 分钟还没登录，已停止等待（浏览器还开着，登录完成后仍会自动保存）'
      if (s.timer) { clearInterval(s.timer); s.timer = null }
      s.settled = true
    }
    return this.state(s)
  }

  cancel(id) {
    const s = this.current
    if (!s) return this.state(null)
    if (id && s.id !== id) return this.state(s)
    if (!s.settled && s.status === 'waiting') {
      s.status = 'cancelled'
      s.detail = '已取消'
    }
    this._finish(s)
    this.current = null
    return this.state(null)
  }

  dispose() {
    this.disposed = true
    try { this.cancel() } catch {}
  }

  /** 先置 settled 再关浏览器：close 会触发 disconnect 回调，不先置就会被改写成 cancelled */
  _finish(s) {
    s.settled = true
    if (s.timer) { clearInterval(s.timer); s.timer = null }
    const h = s.handle
    s.handle = null
    if (h) Promise.resolve().then(() => h.close()).catch(() => {})
  }

  async _check(s) {
    if (this.disposed || s.settled || s.checking) return
    if (!s.handle) return
    s.checking = true
    try {
      let list = []
      try {
        list = await s.handle.getCookies()
      } catch {
        return
      }
      const map = collectCookies((list ?? []).filter(isZhipinCookie), this.now())
      const { names, missing } = pickRequired(map)
      s.names = names
      s.missing = missing
      // 三个关键字段齐了才认为"可能有登录态"。缺任何一个都不动 —— 未登录时 __zp_stoken__
      // 也可能已经被下发（它是反爬令牌，不是登录凭证），只看它一定会误判。
      if (missing.length) return

      const header = cookieHeader(map)
      let parsed
      try {
        parsed = parseCookieInput(header)
      } catch (e) {
        s.status = 'error'
        s.error = `读到的 cookie 不完整：${String(e?.message ?? e).slice(0, 100)}`
        this._finish(s)
        return
      }

      const verdict = await verifySession(header, { fetchImpl: this.fetch })
      const text = describeVerdict({ verdict, parsed, account: verdict.account, fp: null })

      // 先落盘再报状态：状态给 success 但没存下去是最坏的情况（看着成功了，抓取却说未登录）
      let rec = null
      try {
        rec = this.save(parsed.cookie)
      } catch (e) {
        s.status = 'error'
        s.error = `登录态拿到了，但写不进磁盘：${String(e?.message ?? e).slice(0, 120)}`
        this._finish(s)
        return
      }

      s.account = verdict.account ?? null
      s.fp = rec?.fp ?? null
      s.status = text.status
      s.detail = text.detail
      this._finish(s)
    } finally {
      s.checking = false
    }
  }
}

export { LOGIN_URL }
