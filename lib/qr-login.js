import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { parseCookieInput, saveCredentials, AuthError, REQUIRED } from '../tools/lib/auth.mjs'
import {
  LOGIN_URL, ZHIPIN_HOST, collectCookies, cookieHeader, pickRequired,
  verifySession, describeVerdict,
} from './login-common.js'

/**
 * 扫码登录（宿主侧）
 *
 * ── 为什么不是"在设置页里画一个二维码"──────────────────────────────
 * B 站有公开的扫码三件套（generate / poll / 拿 Set-Cookie），所以 bili-whale
 * 能在设置页里画二维码。BOSS 没有：它的登录页是 `zhipin-sign` 签名应用，
 * 二维码由前端画布渲染，生成接口名不可猜测（我试过十余个候选路径全是 404）。
 *
 * 猜接口的代价很高：扫错一个路径 = 请求打到了不该打的端点；猜对了也没用，
 * 因为二维码落地后还要配套的轮询接口和 stoken 交换，任何一环对不上就是
 * "二维码画出来了但永远不成功"——这比没有二维码更误导人。
 *
 * ── 所以走这条路 ───────────────────────────────────────────────────
 * 用 Electron 内嵌窗口打开**官方登录页**，用户在窗口里正常扫码，
 * 我们从 Chromium 的 cookie store 里读登录态（含 HttpOnly，document.cookie 读不到的那种），
 * 落盘后自动关窗。用户看到的仍然是"扫一下就登录好了"，只是二维码在弹窗里。
 *
 * ── 为什么独立 partition ──────────────────────────────────────────
 * 不复用 DSH 自己的 session：① 不污染 DSH；② 用 persist: 分区让 BOSS 认得
 * 这是"同一台机器的同一个浏览器"，反复登录不会次次触发风控。
 */

const PARTITION = 'persist:boss-whale-login'
const TICK_MS = 1200
const MAX_WAIT_MS = 10 * 60 * 1000

/**
 * 拿 electron 主进程模块。
 *
 * 纯 node 下 `require('electron')` 不报错，而是返回一个**可执行文件路径字符串** ——
 * 这正是最容易被忽略的失败形态：拿到的不是 undefined，`el.BrowserWindow` 却是 undefined，
 * 于是报错信息变成"cannot read property of string"，跟真正的原因（不在 Electron 里）毫无关系。
 * 所以这里显式要求 `BrowserWindow` 是个函数。
 */
function loadElectron() {
  const requires = []
  try { requires.push(createRequire(import.meta.url)) } catch {}
  // import.meta.url 在被 CJS 打包时可能不可用；execPath 一定是绝对路径，总能建出 require
  try { requires.push(createRequire(process.execPath)) } catch {}
  if (typeof globalThis.require === 'function') requires.push(globalThis.require)
  for (const req of requires) {
    try {
      const el = req('electron')
      if (el && typeof el === 'object' && typeof el.BrowserWindow === 'function') return el
    } catch {}
  }
  return null
}

export class QrLogin {
  // loadBrowser 可注入：测试里用假的 BrowserWindow 就能把整套状态机跑完，
  // 不必真的弹窗（弹窗也是这个模块最容易出错的地方 —— 关闭事件会把 success 改成 cancelled）
  constructor({ save = saveCredentials, fetchImpl = globalThis.fetch, now = Date.now, loadBrowser = loadElectron } = {}) {
    this.save = save
    this.fetch = fetchImpl
    this.now = now
    this.loadBrowser = loadBrowser
    this.current = null
    this.disposed = false
  }

  /** 对外的状态。注意：**只回字段名，永不回 cookie 值** */
  state(s) {
    if (!s) return { ok: true, status: 'idle', url: LOGIN_URL }
    return {
      ok: true,
      id: s.id,
      status: s.status,
      url: LOGIN_URL,
      windowOpen: !!(s.win && !s.win.isDestroyed?.()),
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
    if (this.disposed) throw new AuthError('登录服务已关闭，请重启 DSH 后再试')
    const el = this.loadBrowser()
    if (!el) {
      // code 是给上层分支用的：宿主拿不到 Electron 就自动降级到系统浏览器，
      // 而不是把"请手动抄 cookie"丢给用户（那对一个几 KB 的 stoken 基本不可完成）
      throw new AuthError('当前环境弹不出登录窗口（不是 DSH 桌面端），改用系统浏览器', 'no-electron')
    }

    this.cancel()

    let win
    try {
      win = new el.BrowserWindow({
        width: 460,
        height: 720,
        minWidth: 380,
        minHeight: 520,
        title: 'BOSS 直聘 · 扫码登录',
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: false,
        },
      })
    } catch (e) {
      throw new AuthError(`创建登录窗口失败：${String(e?.message ?? e).slice(0, 120)}`)
    }

    const s = {
      id: randomUUID(),
      status: 'waiting',
      win,
      ses: win.webContents.session,
      names: [],
      missing: [...REQUIRED],
      startedAt: this.now(),
      timer: null,
      checking: false,
      settled: false,
      account: null,
      detail: '登录窗口已打开，用手机 BOSS 直聘 App 扫码（也可以在窗口里用手机号登录）',
      error: null,
      fp: null,
    }
    this.current = s

    win.on('closed', () => {
      if (s.timer) { clearInterval(s.timer); s.timer = null }
      if (!s.settled) {
        s.settled = true
        s.status = 'cancelled'
        s.detail = '登录窗口被关掉了，没有拿到登录态'
      }
    })

    // 登录页里的外链（帮助中心、下载 App 之类）交给系统浏览器，别在登录窗口里跳走
    try {
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (ZHIPIN_HOST.test(url)) return { action: 'allow' }
        // openExternal 返回 Promise，漏 catch 在 node 里是 unhandled rejection（会打出警告甚至中断进程）
        try {
          const p = el.shell?.openExternal?.(url)
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch {}
        return { action: 'deny' }
      })
    } catch {}

    // 不 await：页面可能要好几秒才出来，让它自己加载，前端轮询状态即可。
    // 真正的失败（DNS/证书）会在 did-fail-load 里体现，而不是靠这里 reject。
    win.loadURL(LOGIN_URL).catch((e) => {
      if (s.settled) return
      s.status = 'error'
      s.error = `登录页打不开：${String(e?.message ?? e).slice(0, 120)}`
      this._finish(s)
    })

    try {
      win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        if (s.settled) return
        if (code === -3) return // ERR_ABORTED：页面自己跳转，正常现象
        s.status = 'error'
        s.error = `登录页加载失败（${code} ${desc}）${url ? '：' + url : ''}`
        this._finish(s)
      })
    } catch {}

    s.timer = setInterval(() => { this._check(s).catch(() => {}) }, TICK_MS)
    // 开窗瞬间先探一次：partition 里如果还留着上次的登录态，应当秒成功而不是让用户白扫一遍
    this._check(s).catch(() => {})

    return this.state(s)
  }

  poll(id) {
    const s = this.current
    if (!s) return this.state(null)
    if (id && s.id !== id) throw new AuthError('这次登录流程已经结束，请重新点「扫码登录」')
    if (!s.settled && s.status === 'waiting') this._check(s).catch(() => {})
    if (!s.settled && this.now() - s.startedAt > MAX_WAIT_MS) {
      s.status = 'expired'
      s.detail = '等了 10 分钟还没扫码，已停止等待（窗口还开着，扫完仍会自动登录）'
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

  /** 关窗 + 停表。先置 settled 再 close，否则 closed 事件会把成功状态改写成 cancelled */
  _finish(s) {
    s.settled = true
    if (s.timer) { clearInterval(s.timer); s.timer = null }
    try { if (s.win && !s.win.isDestroyed()) s.win.close() } catch {}
  }

  async _check(s) {
    if (this.disposed || s.settled || s.checking) return
    if (!s.win || s.win.isDestroyed?.()) return
    s.checking = true
    try {
      let list = []
      try {
        // 用 url 而不是 domain 过滤：domain 匹配在 Windows 上对 `.zhipin.com` / 无点写法不一致，
        // 而 url 过滤走的是 Chromium 自己的匹配逻辑，和浏览器里看到的一致。HttpOnly 也能读到。
        list = await s.ses.cookies.get({ url: 'https://www.zhipin.com' })
      } catch {
        return
      }
      const map = collectCookies(list, this.now())
      const req = pickRequired(map)
      s.names = req.names
      s.missing = req.missing
      // 三个关键字段齐了才认为"可能有登录态"。缺任何一个都不动 —— 未登录时 __zp_stoken__
      // 也可能已经被下发（它是反爬令牌，不是登录凭证），只看它一定会误判。
      if (s.missing.length) return

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

      const verdict = await this._verify(header)
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

  /** 判定标准只有一份（login-common.js）：窗口登录和浏览器登录共用，避免两边口径走散 */
  _verify(header) {
    return verifySession(header, { fetchImpl: this.fetch })
  }
}

export { LOGIN_URL, PARTITION, collectCookies }
