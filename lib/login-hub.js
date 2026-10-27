import { QrLogin } from './qr-login.js'
import { BrowserLogin } from './browser-login.js'
import { AuthError } from '../tools/lib/auth.mjs'
import { LOGIN_URL } from './login-common.js'

/**
 * 登录入口的"总机"：两条路线，按可用性自动选
 *
 *   ① window  —— Electron 内嵌官方登录窗（体验最好：不离开 DSH）
 *   ② browser —— 本机 Edge/Chrome + CDP（宿主没有 Electron 时的兜底）
 *
 * ── 为什么要有个总机，而不是在路由里写 if ─────────────────────────
 * "哪条路线正在跑"是个状态。路由里 if 的话，poll/cancel 也要各自 if 一遍，
 * 三处判断迟早不同步（典型症状：poll 去问了错的实例，界面永远停在"等待扫码"）。
 * 放一个地方持有 active，三条路由都只跟它说话。
 *
 * ── 降级只在"这条路根本走不通"时发生 ────────────────────────────
 * 只有 no-electron / no-browser 这类"环境缺件"才自动换下一条。
 * 起浏览器失败、连不上调试端口这类是**真实故障**，必须原样报出来 ——
 * 统统吞掉再降级的话，用户只会看到一句含糊的"登录失败"，完全无法排查。
 */
export class LoginHub {
  constructor({ windowLogin = null, browserLogin = null, log = () => {} } = {}) {
    this.windowLogin = windowLogin ?? new QrLogin()
    this.browserLogin = browserLogin ?? new BrowserLogin()
    this.log = log
    this.active = null
  }

  idle() {
    return { ok: true, status: 'idle', mode: null, url: LOGIN_URL, names: [], missing: [] }
  }

  async start({ mode = 'auto' } = {}) {
    this.cancel()
    const order = mode === 'browser' ? ['browser']
      : mode === 'window' ? ['window']
        : ['window', 'browser']

    const errors = []
    for (const kind of order) {
      const inst = kind === 'window' ? this.windowLogin : this.browserLogin
      try {
        const st = await inst.start()
        this.active = { kind, inst }
        return this._decorate(st, kind, errors)
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 200)
        errors.push({ kind, code: e?.code ?? null, message: msg })
        this.log(`[boss-whale] 登录路线 ${kind} 失败：${msg}`)

        // "环境缺件"才降级（no-electron / no-browser）
        const unavailable = e?.code === 'no-electron' || e?.code === 'no-browser'
        const hasNext = kind !== order[order.length - 1]

        if (unavailable && hasNext) {
          this.log(`[boss-whale] ${kind} 不可用，改试下一条路线`)
          continue
        }
        if (unavailable) {
          // 指定了单一模式时，把真实原因原样给它（用户点的是"用浏览器"，就该知道浏览器为什么不行）
          if (order.length === 1) throw e
          throw new AuthError(
            '当前环境弹不出登录窗口（不是 DSH 桌面端），也没找到可用的 Edge/Chrome；'
            + `请用下面的「粘贴 cookie」方式登录（${errors.map((x) => x.message).join('；')}）`,
            'no-login-route',
          )
        }
        // 真实故障（起不来 / 连不上 / 被安全软件拦）不降级，原样抛出
        throw errors.length > 1
          ? new AuthError(`${errors[0].message}；改用另一种方式也不行：${msg}`, e?.code ?? 'login-failed')
          : e
      }
    }

    throw new AuthError('没有可用的登录方式', 'no-login-route')
  }

  _decorate(st, kind, errors) {
    if (!st) return st
    const out = { ...st, mode: kind }
    // 降级发生过就把原因带上，否则用户会疑惑"为什么突然开了个浏览器"
    if (errors.length) {
      const why = errors[0]
      out.fallback = {
        from: why.kind,
        reason: why.message,
        note: why.kind === 'window' ? `内置登录窗口用不了（${why.message}），已改用 ${st.browser ?? '系统浏览器'}` : why.message,
      }
      out.detail = out.detail ? `${out.fallback.note} · ${out.detail}` : out.fallback.note
    }
    return out
  }

  poll(id) {
    if (!this.active) return this.idle()
    const st = this.active.inst.poll(id)
    return st ? { ...st, mode: this.active.kind } : st
  }

  cancel(id) {
    if (!this.active) return this.idle()
    const kind = this.active.kind
    const st = this.active.inst.cancel(id)
    // cancel 之后如果流程已经结束（返回 idle），总机也要清空，否则下次 poll 会问到一个空壳
    if (!st || st.status === 'idle') this.active = null
    return st ? { ...st, mode: kind } : st
  }

  dispose() {
    for (const inst of [this.windowLogin, this.browserLogin]) {
      try { inst.dispose() } catch {}
    }
    this.active = null
  }
}
