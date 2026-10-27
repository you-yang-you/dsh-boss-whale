import crypto from 'node:crypto'
import http from 'node:http'

/**
 * 极简 WebSocket + Chrome DevTools Protocol 客户端（零依赖）
 *
 * ── 为什么不直接用现成的库 ────────────────────────────────────────
 * 这个插件装在别人机器上，多一个依赖就多一次 `npm install` 失败的机会，
 * 而它要干的事其实很小：连上本地 127.0.0.1 的调试端口，问一次"有哪些 cookie"。
 *
 * ── 为什么不依赖全局 WebSocket ────────────────────────────────────
 * 宿主跑在 Electron 主进程里，Node 版本随 Electron 走（20/22 都有）。
 * `globalThis.WebSocket` 只在 Node 22 才稳定存在，用它会变成
 * "在我机器上能跑、在别人机器上 undefined" —— 这类问题最难查。
 * 自己拿 node:net/http 说一遍 RFC6455 的握手和帧格式，就跟 Node 版本无关了。
 *
 * ── 只实现需要的部分 ─────────────────────────────────────────────
 * 文本帧、分片续帧、ping/pong、close。不做压缩、不做二进制（CDP 都是 JSON 文本）。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 单帧上限：CDP 的 cookie 列表再大也不会到这个量级，超了说明对端不是 CDP，直接断 */
const MAX_FRAME = 16 * 1024 * 1024

/** 客户端帧必须加掩码（RFC6455 5.3），漏了这一步服务端会当场断开连接 */
export function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8')
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x80 | (opcode & 0x0f) // FIN + opcode
  const mask = crypto.randomBytes(4)
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, body])
}

/**
 * 增量帧解析器。
 * 一个 TCP 包里可能是半帧、也可能塞了好几帧，所以必须能"喂一段、出几条"，
 * 不能假设一次 read 正好是一帧（这是手写 WS 最常见的崩法）。
 */
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.frag = null
    this.oversize = false
  }

  /** @returns {{texts: string[], pings: Buffer[], closed: boolean}} */
  push(chunk) {
    const out = { texts: [], pings: [], closed: false }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk

    for (;;) {
      const b = this.buf
      if (b.length < 2) break

      const fin = (b[0] & 0x80) !== 0
      const op = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2

      if (len === 126) {
        if (b.length < 4) break
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) break
        const big = b.readBigUInt64BE(2)
        if (big > BigInt(MAX_FRAME)) { this.oversize = true; out.closed = true; this.buf = Buffer.alloc(0); break }
        len = Number(big)
        off = 10
      }

      let maskKey = null
      if (masked) {
        if (b.length < off + 4) break
        maskKey = b.subarray(off, off + 4)
        off += 4
      }
      if (b.length < off + len) break

      let payload = b.subarray(off, off + len)
      if (maskKey) {
        const un = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3]
        payload = un
      }
      this.buf = b.subarray(off + len)

      if (op === 0x8) { out.closed = true; break }
      if (op === 0x9) { out.pings.push(payload); continue }
      if (op === 0xa) continue

      if (op === 0x1 || op === 0x2) {
        if (fin) out.texts.push(payload.toString('utf8'))
        else this.frag = [payload]
      } else if (op === 0x0) {
        if (!this.frag) continue // 没有开头的续帧，丢掉（不该出现）
        this.frag.push(payload)
        if (fin) { out.texts.push(Buffer.concat(this.frag).toString('utf8')); this.frag = null }
      }
    }
    return out
  }
}

/**
 * 建立一条 WebSocket 连接。
 *
 * ⚠️ **故意不发 Origin 头**：Chrome 111+ 起，DevTools 端点会拒绝带 Origin 的连接
 * （除非启动时加了 `--remote-allow-origins`）。本地进程直连、不带 Origin 是放行的，
 * 所以这里最省事的做法反而是"看起来不完整"的那一种。
 */
export function wsConnect(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      reject(new Error(`调试地址不合法：${url}`))
      return
    }
    if (u.protocol !== 'ws:') {
      reject(new Error(`只支持 ws:// 调试地址，收到 ${u.protocol}`))
      return
    }

    const key = crypto.randomBytes(16).toString('base64')
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64')
    let settled = false

    const req = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { req.destroy() } catch {}
      reject(new Error('连不上浏览器调试端口（超时）'))
    }, timeoutMs)

    req.on('upgrade', (res, socket, head) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (res.headers['sec-websocket-accept'] !== expect) {
        try { socket.destroy() } catch {}
        reject(new Error('浏览器调试端口握手校验失败（可能是别的东西占了这个端口）'))
        return
      }
      socket.setNoDelay?.(true)

      const parser = new FrameParser()
      const api = {
        onMessage: null,
        onClose: null,
        closed: false,
        send(text) {
          if (api.closed) return false
          try { socket.write(encodeFrame(text)); return true } catch { return false }
        },
        ping() {
          if (api.closed) return
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)) } catch {}
        },
        close() {
          if (api.closed) return
          api.closed = true
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)) } catch {}
          try { socket.destroy() } catch {}
        },
      }

      const drain = (chunk) => {
        const r = parser.push(chunk)
        for (const t of r.texts) {
          try { api.onMessage?.(t) } catch {}
        }
        // 对方 ping 必须回 pong，否则 Chrome 会认为连接死了并主动断（表现为"明明连上了却突然没消息"）
        for (const _ of r.pings) api.ping()
        if (r.closed) {
          if (!api.closed) { api.closed = true; try { socket.destroy() } catch {} }
          try { api.onClose?.() } catch {}
        }
      }

      socket.on('data', (c) => { if (!api.closed) drain(c) })
      socket.on('error', () => { if (!api.closed) { api.closed = true; try { api.onClose?.() } catch {} } })
      socket.on('close', () => { if (!api.closed) { api.closed = true; try { api.onClose?.() } catch {} } })

      if (head?.length) drain(head)
      resolve(api)
    })

    req.on('response', (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { res.resume() } catch {}
      reject(new Error(`调试端口没有接受 WebSocket 升级（HTTP ${res.statusCode}）`))
    })

    req.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`连不上浏览器调试端口：${String(e?.message ?? e).slice(0, 80)}`))
    })

    req.end()
  })
}

/** 把 ws 连接包成"发命令 / 收结果"的形态 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    /** 连接断开时回调（上层用它判断"用户把浏览器关了"） */
    this.onDisconnect = null
    ws.onMessage = (text) => this._onMessage(text)
    ws.onClose = () => {
      this._failAll(new Error('浏览器调试连接已断开'))
      try { this.onDisconnect?.() } catch {}
    }
  }

  _onMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? 'CDP 报错'}`))
      else p.resolve(msg.result ?? {})
      return
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) {
        try { fn(msg.params ?? {}) } catch {}
      }
    }
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  call(method, params = {}, { timeoutMs = 10_000 } = {}) {
    if (this.ws.closed) return Promise.reject(new Error('浏览器调试连接已断开'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      if (!this.ws.send(JSON.stringify({ id, method, params }))) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('写不进调试连接'))
      }
    })
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  close() {
    this._failAll(new Error('已关闭'))
    try { this.ws.close() } catch {}
  }
}

export async function cdpConnect(wsUrl, opts = {}) {
  const ws = await wsConnect(wsUrl, opts)
  return new Cdp(ws)
}
