import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 会话投递：把一段话塞进插件自己的专用会话。
 *
 * 关键语义（从 0.2.1 的 sessionController 源码读出来的）：
 *   · prompt() **不会创建会话** —— 会话不存在时它抛 SESSION_QUERY_SESSION_NOT_FOUND
 *   · 所以必须先 create({sessionId}) 把会话"物化"出来，再 prompt
 *   · create() 在已有 turn 的会话上可能铸一个新 id 返回，但**原 id 仍然可用**（走 resume）
 *   → 结论：id 固定，忽略 create 的返回值，永远 prompt 固定 id。
 */
export function createDelivery({ controller, dshHome, cwd, sessionId, log = () => {}, onSession = () => {} }) {
  const file = path.join(dshHome, 'boss-session.json')
  let state = { id: sessionId, startedAt: Date.now() }
  let ready = false
  let tail = Promise.resolve()

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof saved.id === 'string' && saved.id) state = saved
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('会话状态损坏，请检查 boss-session.json')
  }
  onSession(state.id)

  /**
   * 2026-10-27 的坑：`controller.prompt(request, signal)` 内部会调 `signal.throwIfAborted()`。
   *   只传第一个参数 → signal 是 undefined → 直接抛
   *   "Cannot read properties of undefined (reading 'throwIfAborted')"。
   *   症状是"会话建出来了、消息一条都发不进去"，而且只在投递那一刻才炸，很容易被当成没跑。
   *   这里统一兜底：没给 signal 就现做一个。
   */
  const withSignal = (signal) => signal ?? new AbortController().signal

  function save(next) {
    fs.mkdirSync(dshHome, { recursive: true })
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(next))
      fs.renameSync(tmp, file)
    } finally {
      try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  }

  return {
    get sessionId() { return state.id },
    get ready() { return ready },
    /**
     * 把会话「物化」出来（只建壳，不说话）。
     * 为什么需要它：prompt() 不会建会话。以前只有真正跑过一轮才会 create，
     *   所以装完没跑过一轮的时候，「工作区 → 未分组」里连个窗口都没有 ——
     *   主人想看产出、想在里面接着聊，根本找不到地方。
     */
    async ensure() {
      if (ready) return { id: state.id, created: false }
      try {
        const res = await controller.create({ sessionId: state.id, cwd })
        // create 可能铸一个新 id 返回（注释里写"原 id 仍可用"，但空会话上不保证）——记住它
        const minted = typeof res?.sessionId === 'string' && res.sessionId && res.sessionId !== state.id ? res.sessionId : null
        ready = true
        state = { ...state, ensuredAt: new Date().toISOString(), ...(minted ? { mintedId: minted } : {}) }
        save(state)   // 落盘：有没有建成功得看得见（以前全在内存里，失败时只能猜）
        return { id: state.id, created: true, minted }
      } catch (e) {
        state = { ...state, ensureError: String(e?.message ?? e) }
        try { save(state) } catch {}
        return { id: state.id, created: false, error: String(e?.message ?? e) }
      }
    },
    /**
     * 建好后打一句招呼，让它第一眼就知道自己是干嘛的。
     * introAt 落盘 → 重启不会重复叨叨。
     */
    async introduce(text) {
      const body = String(text ?? '').trim()
      if (!body) return { sent: false, reason: 'empty' }
      if (state.introAt) return { sent: false, reason: 'already' }
      const ensured = await this.ensure()
      if (ensured.error) return { sent: false, reason: ensured.error }
      // 建完立刻 prompt 有概率撞上会话还没 seed 完 —— 给它一秒半
      await new Promise((done) => setTimeout(done, 1500))
      const say = async (id) => controller.prompt({
        requestId: `boss-whale-intro-${Date.now()}`,
        sessionId: id,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      }, withSignal())
      try {
        await say(state.id)
        state = { ...state, introAt: new Date().toISOString(), deliveredAt: Date.now() }
        delete state.introError
        save(state)
        return { sent: true }
      } catch (e) {
        // 兜底：create 铸了新 id 时用新 id 再试一次；成功就把后续投递都迁到这个 id 上
        const alt = state.mintedId
        if (!alt) {
          state = { ...state, introError: String(e?.message ?? e) }
          try { save(state) } catch {}
          return { sent: false, reason: String(e?.message ?? e) }
        }
        try {
          await say(alt)
          state = { ...state, id: alt, introAt: new Date().toISOString(), deliveredAt: Date.now() }
          delete state.introError
          save(state)
          return { sent: true, movedTo: alt }
        } catch (e2) {
          const reason = String(e2?.message ?? e2)
          state = { ...state, introError: reason, firstError: String(e?.message ?? e) }
          try { save(state) } catch {}
          return { sent: false, reason }
        }
      }
    },
    send(request, signal) {
      const sig = withSignal(signal)
      const job = tail.then(async () => {
        sig.throwIfAborted?.()
        if (!ready) {
          try {
            await controller.create({ sessionId: state.id, cwd })
          } catch (e) {
            // 会话已存在但不可重建之类的软失败：prompt 仍可能成功，留给下一步判断
            log('[boss-whale] create 失败（继续尝试投递）：' + (e?.message ?? e))
          }
        }
        sig.throwIfAborted?.()
        await controller.prompt({ ...request, sessionId: state.id }, sig)
        ready = true
        state = { ...state, deliveredAt: Date.now() }
        try { save(state) } catch (e) { log('[boss-whale] 会话已投递，但状态保存失败：' + (e?.message ?? e)) }
      })
      tail = job.catch(() => {})
      return job
    },
  }
}
