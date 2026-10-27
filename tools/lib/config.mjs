import { configPath, readJson, writeJsonAtomic } from './paths.mjs'

/**
 * 单一真相：默认配置。
 * 宿主半边（lib/index.js）和命令行（tools/boss.mjs）都从这里读，
 * 保证「设置页看到的」和「调度器用的」是同一份结构。
 */
export const DEFAULTS = {
  version: 1,
  // 搜索条件
  search: {
    keywords: ['前端开发'],
    city: '北京',
    cityCode: '',          // 留空则按 city 名查表
    salaryMin: 0,          // 单位 K；0 = 不限
    experience: '',        // 例如 '3-5年'，留空不限
    degree: '',            // 例如 '本科'
    exclude: ['外包', '驻场', '销售', '实习', '兼职'],
    pages: 2,
    pageSize: 30,
  },
  // 抓取礼貌参数（别把账号刷成异常）
  fetch: {
    /**
     * 怎么拿到岗位：
     *   'human' —— 真实浏览器里像人一样浏览，读渲染后的页面（默认，唯一稳的）
     *   'api'   —— node 直连接口（快，但 BOSS 会判 code 37 环境异常，基本不可用）
     * 留着 'api' 是为了出问题时做对照，不是给人日常用的。
     */
    mode: 'human',
    minGapSec: 6,          // 两次请求之间的最小间隔
    jitterSec: 4,          // 随机抖动上限
    maxPagesPerRun: 4,
    timeoutMs: 20000,
  },
  /**
   * 虚拟人的"手感"。
   *
   * 这里所有参数都只影响**慢**，没有让它变快的开关 ——
   * 快就等于暴露。真要省时间，应该减少轮数，而不是压缩每一步的停留。
   */
  human: {
    enabled: true,
    visible: true,         // 有头窗口（headless 会被直接识别：webdriver=true + HeadlessChrome UA）
    offscreen: false,      // true = 窗口挪到屏幕外（看不见但仍是"有头"）
    slow: true,            // 每步 1.5–4 秒的思考停顿；false 只用于调试
    dwellSec: 8,           // 每屏读完后的停留基准
    scrollSteps: 5,        // 每屏滚动几段
    peekPerRun: 1,         // 每轮点开几个岗位看看（0 = 只看列表）
    pagesPerRun: 1,        // 每个关键词看几屏
  },
  // 生物钟
  plan: {
    windows: [{ start: '09:30', end: '11:00' }],
    runsPerDay: 2,
    minGapMin: 180,
    skipChance: 0.1,
  },
  digest: {
    topN: 8,
    pushToSession: true,
    // 插件起来就把专属会话（工作区 → 未分组 → boss-whale）建出来并打一句招呼。
    //   关掉 = 只在报送消息里出现，不占会话列表。
    seedSession: true,
    keepDays: 30,
  },
  /**
   * 自动沟通 —— 默认全关。
   *
   * 这里的设计原则只有一条：**宁可一条不发，也不要发出一堆不像人写的招呼**。
   * 所以 maxPerDay 的硬上限是 2（不是"建议 2"，是代码里 clamp 到 2），
   * 0 表示"只出草稿、绝不发送"。用户要的是"每天两次及以下，或者干脆不打招呼"，
   * 那就不给它留"手滑调成 50"的口子。
   */
  greet: {
    enabled: false,          // 总开关：关着就只出草稿
    maxPerDay: 2,            // 0 = 只出草稿；硬上限 2
    minScore: 10,            // 低于这个匹配分不打招呼
    autoContinue: false,     // 打完招呼后，对方回话就自动接一句
    maxTurns: 2,             // 每个会话最多自动接几句（之后交回给人）
    maxRepliesPerDay: 6,     // 自动接话的每日总预算
    quietOnly: true,         // 只在 plan.windows 里发（别在凌晨三点跟 HR 聊）
    signature: '',           // 落款，可选，例如「张三 · 5 年前端」
    // 高级：接口路径。留空 = 按内置候选探测；探测失败时把浏览器 DevTools 里的真实路径填这里
    greetPath: '',
    listPath: '',
    sendPath: '',
    templates: [
      '您好，看到「{brand}」在招「{name}」，我做过 {kw} 相关的工作，想了解下团队和具体的活儿。方便的话我把简历发您。',
      '您好，对「{name}」比较感兴趣：{kw} 方向有几年经验，{skills} 都用过。想请教下这个岗位现在最急的是哪块？',
    ],
  },
  persona: {
    name: '求职助手',
  },
  toolsPath: '',
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

export function readConfig() {
  const user = readJson(configPath, {}) || {}
  return { ...merge(DEFAULTS, user), __hasUserFile: Object.keys(user).length > 0 }
}

export function writeConfig(next) {
  const clean = { ...next }
  delete clean.__hasUserFile
  writeJsonAtomic(configPath, clean)
  return clean
}

/** 城市名 → BOSS 的城市编码。查不到就让用户直接填 cityCode。 */
export const CITIES = {
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  天津: '101030100',
  西安: '101110100',
  苏州: '101190400',
  武汉: '101200100',
  厦门: '101230200',
  长沙: '101250100',
  成都: '101270100',
  郑州: '101180100',
  重庆: '101040100',
  青岛: '101120200',
  南京: '101190100',
  宁波: '101210400',
  东莞: '101281600',
  佛山: '101280800',
  合肥: '101220100',
  福州: '101230100',
  济南: '101120100',
  大连: '101070200',
  沈阳: '101070100',
  无锡: '101190200',
  珠海: '101280700',
  昆明: '101290100',
  南昌: '101240100',
  贵阳: '101260100',
  石家庄: '101090100',
  太原: '101100100',
  长春: '101060100',
  哈尔滨: '101050100',
  海口: '101310100',
}

export function resolveCityCode(cfg) {
  const raw = String(cfg?.search?.cityCode ?? '').trim()
  if (/^\d{6,12}$/.test(raw)) return { code: raw, name: String(cfg?.search?.city ?? '') || '自定义' }
  const name = String(cfg?.search?.city ?? '').trim() || '全国'
  const code = CITIES[name]
  if (!code) return { code: '', name, error: `认不出城市「${name}」：请改用 cityCode（在 BOSS 搜索页的 URL 里能看到）或填全国` }
  return { code, name }
}
