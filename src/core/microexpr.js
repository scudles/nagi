// src/core/microexpr.js
// 瞬时微表情：把模型里那些"一次性特效表情"用起来。
//
// 为什么需要单独一层（而不是塞进 nagi-emotion.json）：
//   情绪状态机是**长期底色**——它持续存在、会衰减、还会被写进 LLM 提示词
//   （"她现在很开心"）。而"星星眼""吐舌""炸毛"是**瞬时反应**，1~2 秒就该收回。
//   两者生命周期根本不同，硬塞进情绪会污染状态机（她"星星眼"持续三分钟、还被告知模型
//   "她此刻心情非常好"），所以单独做成一层，只在渲染层闪一下。
//
// 实现上走**参数保持层 + add**（不是 expression）：
//   · expression 是独占的，用它会顶掉当前情绪表情；
//   · add 是叠加，情绪的脸还在，只是临时多了一双星星眼；
//   · 池里的参数刻意避开情绪/装束已经在用的那些（见 nagi-microexpr.json 的 note）。
//
// 本文件只做纯逻辑（选哪个、多久），不碰模型。
import { TONE } from './ambient.js'

/** 解析微表情配置；坏数据降级为空池（表现层就没得闪，而不是崩） */
export function parseMicroExpr(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const errors = []
  const hold = Array.isArray(src.holdMs) && src.holdMs.length === 2 ? src.holdMs.map(Number) : [1200, 2200]
  const holdMs = [Math.max(400, Math.min(hold[0], hold[1])), Math.max(600, Math.max(hold[0], hold[1]))]
  const pool = []
  for (const e of Array.isArray(src.pool) ? src.pool : []) {
    if (!e || !e.id || !e.params || typeof e.params !== 'object' || !Object.keys(e.params).length) {
      errors.push(`微表情无效：${JSON.stringify(e)?.slice(0, 60)}`)
      continue
    }
    pool.push({
      id: String(e.id),
      name: String(e.name || e.id),
      params: { ...e.params },
      tones: Array.isArray(e.tones) && e.tones.length ? e.tones.map(String) : [TONE.NORMAL],
      weight: Math.max(0.1, Number(e.weight) || 1),
      why: String(e.why || '')
    })
  }
  return { pool, holdMs, ok: errors.length === 0, errors }
}

/**
 * 挑一个微表情。
 * @param {object} cfg parseMicroExpr 的结果
 * @param {object} [opts]
 * @param {string} [opts.tone] 待机基调（quiet/normal/attentive）
 * @param {string} [opts.avoid] 上一次闪过的 id（尽量别连着两次一样）
 * @param {() => number} [opts.rng] 随机源（单测注入）
 * @returns {{id:string,name:string,params:object,why:string,holdMs:number}|null}
 */
export function pickMicroExpr(cfg, { tone = TONE.NORMAL, avoid = null, rng = Math.random } = {}) {
  const pool = (cfg?.pool || []).filter((e) => e.tones.includes(tone))
  const candidates = pool.length > 1 && avoid ? pool.filter((e) => e.id !== avoid) : pool
  if (!candidates.length) return null
  const total = candidates.reduce((s, e) => s + e.weight, 0)
  let r = rng() * total
  let hit = candidates[candidates.length - 1]
  for (const e of candidates) {
    r -= e.weight
    if (r <= 0) {
      hit = e
      break
    }
  }
  const hold = cfg?.holdMs || [1200, 2200]
  return {
    id: hit.id,
    name: hit.name,
    params: { ...hit.params },
    why: hit.why,
    holdMs: Math.round(hold[0] + rng() * (hold[1] - hold[0]))
  }
}

/** 包络：这次微表情在 t 毫秒时的强度（0..1）。淡入淡出都留时间，不硬闪。 */
export function microEnvelope(elapsedMs, holdMs, fadeIn = 160, fadeOut = 260) {
  const t = Number(elapsedMs)
  const hold = Math.max(fadeIn + fadeOut, Number(holdMs) || 0)
  if (!Number.isFinite(t) || t < 0) return 0
  if (t < fadeIn) return t / fadeIn
  if (t < hold - fadeOut) return 1
  if (t < hold) return 1 - (t - (hold - fadeOut)) / fadeOut
  return 0
}
