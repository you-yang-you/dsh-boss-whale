import fs from 'node:fs'
import { jobsPath, seenPath, draftsPath, appendJsonl, readJson, writeJsonAtomic } from './paths.mjs'
import { jobFingerprint } from './api.mjs'

/**
 * 去过重、排序、生成摘要。
 *
 * 去重的意义：BOSS 的搜索结果按刷新时间排，同一个岗位每天都会再出现一次。
 * 没有去重，你的日报永远是同一批岗位 —— 那就不叫"每天刷"，叫"每天看同一页"。
 *
 * 为什么用两个主键（id + 内容指纹）：
 * encryptJobId 由 jobId 和每次下发的 securityId 派生，HR 重新发布或令牌轮换，
 * 同一岗位就会拿到新 id。只按 id 去重时，日报里会反复出现同一条 —— 而且因为
 * 它"看起来是新 id"，你根本不会怀疑去重坏了。指纹不看 id，专门补这个洞。
 */

function backfillFps() {
  const out = {}
  let text = ''
  try {
    text = fs.readFileSync(jobsPath, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const job = JSON.parse(line)
      const fp = job.fp || jobFingerprint(job)
      if (fp && !out[fp]) out[fp] = job.at || new Date().toISOString()
    } catch {
      /* 跳过坏行，不值得为一行业绩记录中断去重 */
    }
  }
  return out
}

export function loadSeen() {
  const raw = readJson(seenPath, null) || {}
  const ids = raw.ids && typeof raw.ids === 'object' ? raw.ids : {}
  const fps = raw.fps && typeof raw.fps === 'object' ? raw.fps : {}
  // 旧格式（只有 ids）自动升级：从历史 jobs.jsonl 回填指纹，只需一次，
  // 因为下一次 saveSeen 会把 fps 一起写盘，此后 raw.fps 就存在了。
  if (!raw.fps && Object.keys(ids).length) Object.assign(fps, backfillFps())
  return { ids, fps, updatedAt: raw.updatedAt ?? null }
}

export function saveSeen(seen) {
  writeJsonAtomic(seenPath, { ids: seen.ids, fps: seen.fps ?? {}, updatedAt: new Date().toISOString() })
}

/**
 * @returns {{fresh: object[], old: object[], repost: object[]}}
 *   repost 是 old 的子集：id 没见过、但内容指纹见过 —— 即"同一岗位换了 id 重发"。
 */
export function splitNew(jobs, seen) {
  const fresh = []
  const old = []
  const repost = []
  for (const job of jobs) {
    const fp = job.fp || jobFingerprint(job)
    if (seen.ids[job.id]) {
      old.push(job)
      continue
    }
    if (fp && seen.fps?.[fp]) {
      repost.push(job)
      old.push(job)
      continue
    }
    fresh.push(job)
  }
  return { fresh, old, repost }
}

export function markSeen(seen, jobs, now = new Date()) {
  const iso = now.toISOString()
  if (!seen.fps) seen.fps = {}
  for (const job of jobs) {
    if (!seen.ids[job.id]) seen.ids[job.id] = iso
    const fp = job.fp || jobFingerprint(job)
    if (fp && !seen.fps[fp]) seen.fps[fp] = iso
  }
  // 顺手清掉 90 天前的记录，别让 seen.json 无限膨胀
  const cutoff = now.getTime() - 90 * 86400_000
  for (const bucket of [seen.ids, seen.fps]) {
    for (const [key, at] of Object.entries(bucket)) {
      const t = new Date(at).getTime()
      if (Number.isFinite(t) && t < cutoff) delete bucket[key]
    }
  }
  return seen
}

export function appendJobs(jobs) {
  appendJsonl(jobsPath, jobs)
}

export function appendDraft(draft) {
  appendJsonl(draftsPath, [draft])
}

/** 关键词命中打分：职位名 > 技能 > 标签 */
export function scoreJob(job, cfg) {
  const kw = (cfg?.search?.keywords ?? []).map((s) => String(s).trim()).filter(Boolean)
  const exclude = (cfg?.search?.exclude ?? []).map((s) => String(s).trim()).filter(Boolean)
  const hay = (s) => String(s ?? '').toLowerCase()
  const name = hay(job.name)
  const skills = hay([...(job.skills ?? []), ...(job.labels ?? [])].join(' '))

  let score = 0
  const hits = []
  for (const k of kw) {
    const kk = hay(k)
    if (!kk) continue
    if (name.includes(kk)) { score += 10; hits.push(k) }
    else if (skills.includes(kk)) { score += 6; hits.push(k) }
  }
  for (const x of exclude) {
    const xx = hay(x)
    if (xx && (name.includes(xx) || hay(job.brand).includes(xx))) score -= 50
  }
  const minSalary = Number(cfg?.search?.salaryMin ?? 0)
  if (minSalary > 0) {
    if (job.salaryMid === null) score -= 2
    else if (job.salaryMid >= minSalary) score += 4
    else score -= 30
  }
  return { score, hits }
}

export function rankJobs(jobs, cfg) {
  return jobs
    .map((job) => ({ ...job, ...scoreJob(job, cfg) }))
    .sort((a, b) => (b.score - a.score) || ((b.salaryMid ?? 0) - (a.salaryMid ?? 0)))
    .filter((job) => job.score > -10)
}

/** 本地模板生成招呼语草稿（不调模型：稳、免费、也不会把话说得很像机器人群发） */
export function draftGreeting(job, cfg) {
  const kw = (job.hits ?? [])[0] ?? (cfg?.search?.keywords ?? [])[0] ?? '这个方向'
  const bits = []
  bits.push(`您好，看到贵司在招「${job.name}」，我在${kw}方向有相关经验，想了解一下岗位细节。`)
  // 2026-10-27：没读到真实薪资（BOSS 用自定义字体把数字编成乱码）就别念出来 ——
  //   念出来的效果是把一堆乱码塞给 HR ✗
  if (/\d/.test(String(job.salaryDesc ?? ''))) bits.push(`薪资范围 ${job.salaryDesc} 与我的预期接近。`)
  const tech = (job.skills ?? []).filter((s) => /\d|[A-Za-z]/.test(String(s)) || String(s).length <= 6)
  if (tech.length) bits.push(`技术栈上 ${tech.slice(0, 3).join('、')} 我都用过。`)
  bits.push('方便的话我把简历发您，谢谢。')
  return bits.join('')
}

export function buildDigest({ jobs, fresh, errors, cfg, repost = [], now = new Date() }) {
  const topN = Math.min(30, Math.max(1, Number(cfg?.digest?.topN ?? 8)))
  // 只排"新"的。以前这里有个 `fresh.length ? fresh : jobs` 的兜底，
  // 结果是：当天没有新岗位时，它把整页旧岗位重印一遍 —— 去重等于白做。
  const ranked = rankJobs(fresh, cfg)
  const top = ranked.slice(0, topN)
  const lines = []
  const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  lines.push(`【求职日报 ${dateText}】`)
  lines.push(`条件：${(cfg.search?.keywords ?? []).join(' / ') || '不限'} · ${cfg.search?.city ?? '全国'}${Number(cfg.search?.salaryMin) > 0 ? ` · ${cfg.search.salaryMin}K 以上` : ''}`)
  const repostNote = repost.length ? `（含 ${repost.length} 条同一岗位换了 id 重发，已折叠）` : ''
  lines.push(`抓到 ${jobs.length} 条，其中新岗位 ${fresh.length} 条${repostNote}${errors.length ? `；有 ${errors.length} 个错误` : ''}`)

  if (errors.length) {
    lines.push('')
    lines.push('⚠️ 抓取异常：')
    for (const e of errors.slice(0, 3)) lines.push(`  · 第 ${e.page} 页：${e.message}`)
  }

  if (!top.length) {
    lines.push('')
    const first = errors[0]
    // 这里的每一句都对应一个**完全不同的动作**。
    // 以前只有 auth / risk 两支，captcha、ip-risk 掉进了最后的兜底，
    // 于是被拦下时会说"今天没有符合条件的新岗位，可以放宽关键词" —— 让人去改条件，
    // 而真正该做的是停手。这种文案比不说话更坏。
    const advice = {
      auth: () => [
        '⚠️ 登录态不可用 —— 去 设置 → 求职 扫码登录（或粘贴 cookie），再跑一轮。',
      ],
      'ip-risk': () => [
        '⚠️ IP 被限流了 —— 这不是你的操作问题，也不该重新登录。',
        '   停手，至少等三小时。这段时间里你自己用浏览器打开 BOSS 多半也会被要求验证，那是同一件事。',
      ],
      'env-risk': () => [
        '⚠️ 环境异常 —— 这是"把浏览器 cookie 拿到 node 里回放"的必然结果，换 cookie 没用。',
        '   设置 → 求职 → 浏览方式改成「虚拟人」，再跑。',
      ],
      captcha: () => [
        '⚠️ 页面弹了人机验证 —— 虚拟人已经停手，不会再撞。',
        '   去 设置 → 求职 点「开窗过验证 / 登录」（或在终端跑 `node tools/boss.mjs browse`），',
        '   在窗口里过一下验证，过完关掉窗口，再跑一轮。',
        '   期间它会安静等着，不会每小时去试一次。',
      ],
      risk: () => ['⚠️ 被风控拦了 —— 停手等，别反复重试。'],
      'no-browser': () => [
        '⚠️ 没找到 Edge / Chrome —— 装一个，或用 BOSS_WHALE_BROWSER 指向浏览器可执行文件。',
      ],
      browser: () => [
        '⚠️ 浏览器没起来或被挡住了 —— 看上面的错误。常见原因：安全软件拦了调试端口，或已有同名浏览器实例占着配置目录。',
      ],
      empty: () => [
        '⚠️ 页面打开了但没读到岗位卡片 —— 可能还没渲染完，也可能是页面改版。',
        '   先确认你自己用浏览器打开那个搜索页能看到岗位；能看到就说明是选择器要更新了。',
      ],
    }[first?.kind]

    if (advice) lines.push(...advice())
    else if (fresh.length) {
      // 有新岗位，但全被 score 过滤掉了 —— 说明是筛选条件太紧，不是没抓到
      lines.push(`抓到 ${fresh.length} 条新岗位，但都被筛选条件挡掉了（薪资低于下限，或命中了 search.exclude）。`)
      lines.push('要么抬 salaryMin，要么删掉太宽的排除词。')
    } else if (jobs.length) {
      // 抓到了，但全是看过的 —— 这是"今天真没新东西"，不是"抓取失败"
      lines.push(`今天没有新岗位：抓到的 ${jobs.length} 条都是看过的${repost.length ? `，其中 ${repost.length} 条是同一岗位换了 id 重新发布` : ''}。`)
      lines.push('想看更多就放宽关键词、换城市，或把 search.exclude 里太宽的词删掉。')
    } else {
      lines.push('今天没有符合条件的新岗位。可以放宽关键词、抬高薪资上限或换城市。')
    }
    return { text: lines.join('\n'), top: [], draft: null }
  }

  lines.push('')
  lines.push(`按匹配度排前 ${top.length} 条：`)
  top.forEach((job, i) => {
    const extra = [job.experience, job.degree, job.scale].filter(Boolean).join(' / ')
    lines.push(`${i + 1}. ${job.name} · ${job.brand}${job.salaryDesc ? ` · ${job.salaryDesc}` : ''}`)
    lines.push(`   ${job.city}${extra ? ` | ${extra}` : ''}${job.hits?.length ? ` | 命中 ${job.hits.join('/')}` : ''}`)
    lines.push(`   ${job.url}`)
  })

  const first = top[0]
  const draft = draftGreeting(first, cfg)
  lines.push('')
  lines.push(`给的招呼语草稿（针对第 1 条 · ${first.name} · ${first.brand}）：`)
  lines.push(draft)

  return { text: lines.join('\n'), top, draft, draftFor: first }
}
