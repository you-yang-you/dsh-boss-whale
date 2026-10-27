import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const HOME = os.homedir()
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 凭据与抓取数据放这里（跟 .dsh 分开：换机器只拷这一份就能带着登录态走） */
export const BOSS_HOME = path.join(HOME, '.boss-ai')
export const credentialsPath = path.join(BOSS_HOME, 'credentials.json')
export const jobsPath = path.join(BOSS_HOME, 'jobs.jsonl')
export const seenPath = path.join(BOSS_HOME, 'seen.json')
export const draftsPath = path.join(BOSS_HOME, 'drafts.jsonl')
/** 打招呼/接话的账本：额度、已打过的人、每个会话聊到第几句、风控冷却 */
export const greetPath = path.join(BOSS_HOME, 'greet.json')
/** 探测出来的接口路径（缓存，不用每次重试候选） */
export const endpointsPath = path.join(BOSS_HOME, 'endpoints.json')

/** 配置放 .dsh 下（和设置页、调度器共用同一份，不搞两套配置） */
export const configPath = path.join(DSH_HOME, 'boss-whale.config.json')
export const planPath = path.join(DSH_HOME, 'boss-whale-plan.json')
export const logPath = path.join(DSH_HOME, 'boss-whale-log.jsonl')
export const workDir = path.join(DSH_HOME, 'boss-work')

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

export function appendJsonl(file, rows) {
  if (!rows?.length) return
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}
