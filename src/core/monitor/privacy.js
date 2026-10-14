// src/core/monitor/privacy.js
// 凪 · 活动监测的隐私三护栏（M3）。
//   ① 黑名单：命中即丢弃该条样本，绝不进入统计与后续任何环节
//   ② 勿扰开关：一键停采（运行时开关，不落盘）
//   ③ 不落盘 / 不泄露：采集到的窗口标题原文只用于当场分类，
//      统计层只留下「应用类别 + 时长」，日记/日志/LLM 上下文都拿不到标题原文
//
// 纯逻辑、无 Electron / Node 依赖，可单测。

/** 转义正则元字符 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 通配匹配（大小写不敏感、支持 * ）。语义取「裸词=包含，带 *=通配且锚定」：
 *   '密码'    → 子串包含（不锚定）
 *   '*密码*'  → 任意位置包含
 *   '银行*'   → 以「银行」开头
 *   '*银行'   → 以「银行」结尾
 * 空模式 / 空文本一律不匹配。
 */
export function matchPattern(text, pattern) {
  const t = String(text || '').toLowerCase()
  const p = String(pattern || '').trim().toLowerCase()
  if (!p || !t) return false
  if (!p.includes('*')) return t.includes(p)
  const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$')
  return re.test(t)
}

/** 一条样本是否命中任一条黑名单（按 app 名 + 窗口标题一起匹配） */
export function isBlocked(sample, blacklist) {
  const list = Array.isArray(blacklist) ? blacklist : []
  if (!list.length || !sample) return false
  const hay = [sample.app, sample.title].filter(Boolean).join(' ')
  if (!hay) return false
  return list.some((p) => matchPattern(hay, p))
}

/**
 * 隐私总闸：这条样本能不能进入统计。
 * @returns {{skip:boolean, reason?:'disabled'|'dnd'|'blacklist'}}
 */
export function gateSample(sample, privacy) {
  const cfg = privacy || {}
  if (cfg.monitorEnabled === false) return { skip: true, reason: 'disabled' }
  if (cfg.doNotDisturb === true) return { skip: true, reason: 'dnd' }
  if (isBlocked(sample, cfg.blacklist)) return { skip: true, reason: 'blacklist' }
  return { skip: false }
}

/**
 * 是否允许「采集」本身（而不只是丢弃采集结果）。
 * 关掉监测 / 打开勿扰时必须为 false —— 否则采样进程仍会继续读取你的窗口标题，
 * 只是把结果扔掉而已；那不算「停采」。采样前先过这道闸，才是真的不看。
 */
export function collectionAllowed(privacy) {
  const cfg = privacy || {}
  return cfg.monitorEnabled !== false && cfg.doNotDisturb !== true
}

/**
 * 脱敏：任何要「离开内存」（写日记 / 打日志 / 喂给 LLM）的样本都必须过这里。
 * 结果只保留她需要知道的最小信息：时间、空闲秒数、应用类别——不含标题原文。
 */
export function redact(sample) {
  if (!sample) return null
  return {
    ts: sample.ts ?? null,
    idleSec: Number.isFinite(sample.idleSec) ? sample.idleSec : null,
    app: null, // 连应用名也不外传，只留类别
    category: sample.category || 'other'
  }
}

/** 默认黑名单（首次安装即可用；用户可在设置页增删） */
export const DEFAULT_BLACKLIST = [
  '*密码*', '*password*', '*passwd*', '*凭据*',
  '*1password*', '*keepass*', '*bitwarden*', '*lastpass*',
  '*银行*', '*bank*', '*支付*', '*支付宝*', '*微信支付*', '*收银*',
  '*身份证*', '*信用卡*', '*私密*', '*隐私*', '*private*', '*incognito*', '*无痕*'
]
