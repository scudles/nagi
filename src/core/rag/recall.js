// src/core/rag/recall.js
// 召回策略：cosine → 时间衰减 → 类型权重 → 阈值 → MMR → 预算截断。纯函数，可单测。
//
// 一个刻意为之的设计决定：阈值卡在「语义相似度」上，衰减与权重只影响排序。
// 若按「衰减后分数 < 0.32 丢弃」，一年前的相关记忆会被 0.5^(365/45) ≈ 0.0036
// 乘到阈值以下——等于静默删除，违背「旧的沉但不消失」。宁可少注，不可注错：
// 注错记忆就是人格漂移（承接《人格设定增补》的反漂移护栏）。

import { dot, decayFactor, DAY_MS } from './similarity.js'

/** 召回默认参数（设置页可改，见 shared/rag-protocol.js） */
export const SEARCH_DEFAULTS = {
  threshold: 0.32, // 语义门限（raw cosine，衰减前）
  halfLifeDays: 45, // 时间衰减半衰期（天）
  lambda: 0.7, // MMR：相关性 vs 多样性
  maxResults: 6, // 最多召回几条
  budgetChars: 600, // 召回段落总字符预算（约 300–400 token）
  now: Date.now()
}

/** 摘要覆盖的原轮次降权系数（设计文档 §4：仍可检索，但排后面） */
export const COVERED_TURN_FACTOR = 0.8

const pad = (n) => String(n).padStart(2, '0')

/**
 * 带时间感的标签——「经历」的关键就是时间感：
 * 今天 / 昨天 / 三天前 / 上周 / 三个月前…（附 MM-DD 兜底定位）
 */
export function timeLabel(at, now = Date.now()) {
  const t = Number(at)
  if (!Number.isFinite(t)) return '很久以前'
  const d = new Date(t)
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const days = Math.floor((now - t) / DAY_MS)
  if (days <= 0) return `今天（${md}）`
  if (days === 1) return `昨天（${md}）`
  if (days < 7) return `${days} 天前（${md}）`
  if (days < 14) return `上周（${md}）`
  if (days < 30) return `${Math.floor(days / 7)} 周前（${md}）`
  if (days < 60) return `上个月（${md}）`
  if (days < 365) return `${Math.floor(days / 30)} 个月前（${md}）`
  return `${Math.floor(days / 365)} 年前（${md}）`
}

/**
 * 全表打分。向量入库时已归一化 → cosine = 点积（快路径）。
 * @param {import('./vector-store.js').VectorStore} store
 * @param {Float32Array} queryVec 已归一化的查询向量
 * @param {object} [opts] 覆盖 SEARCH_DEFAULTS；opts.covered = 被摘要覆盖的轮次 id 集合
 * @returns {Array<{row:number,id:string,kind:string,text:string,at:number,sim:number,score:number}>} 按 score 降序
 */
export function scoreCandidates(store, queryVec, opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts }
  const out = []
  if (!store || !queryVec || !queryVec.length) return out
  const dim = store.dim
  for (let r = 0; r < store.count; r++) {
    if (store.dead.has(r)) continue
    const sim = dot(queryVec, store.vec.subarray(r * dim, (r + 1) * dim))
    if (sim < o.threshold) continue // 语义门限先过（衰减前的原始相似度）
    const c = store.chunks[r]
    const ageDays = (o.now - c.at) / DAY_MS
    const base = Number.isFinite(c.weight) ? c.weight : 1
    const covered = o.covered && o.covered.has(c.id) ? COVERED_TURN_FACTOR : 1
    const score = sim * base * covered * decayFactor(ageDays, o.halfLifeDays)
    out.push({ row: r, id: c.id, kind: c.kind, text: c.text, at: c.at, meta: c.meta, sim, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * MMR 去冗余：λ=0.7。避免 5 条召回全是同一件事的复读——
 * 候选已按 score 降序，依次算「与已选集合的最大相似度」做惩罚。
 */
function mmrSelect(cands, store, { lambda, k }) {
  const dim = store.dim
  const selected = []
  const pool = cands.slice()
  const top = pool.length ? pool[0].score : 1
  while (pool.length && selected.length < k) {
    let best = -Infinity
    let bi = 0
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      let maxSim = 0
      for (const s of selected) {
        const d = dot(
          store.vec.subarray(c.row * dim, (c.row + 1) * dim),
          store.vec.subarray(s.row * dim, (s.row + 1) * dim)
        )
        if (d > maxSim) maxSim = d
      }
      const mmr = lambda * (c.score / top) - (1 - lambda) * maxSim
      if (mmr > best) {
        best = mmr
        bi = i
      }
    }
    selected.push(pool.splice(bi, 1)[0])
  }
  return selected
}

/**
 * 召回主入口。
 * @returns {Array<{id,kind,text,at,sim,score,label,piece}>}
 *   piece = 直接进提示词的片段（形如 「三个月前（08-12）：他：…；我：…」）
 */
export function recall(store, queryVec, opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts }
  if (!store || store.liveCount === 0) return []
  const cands = scoreCandidates(store, queryVec, o)
  if (!cands.length) return []
  const picked = mmrSelect(cands, store, { lambda: o.lambda, k: o.maxResults })
  const out = []
  let used = 0
  for (const c of picked) {
    const label = timeLabel(c.at, o.now)
    let body = String(c.text).replace(/\s*\n\s*/g, '；') // 一轮对话压成一行
    if (body.length > 200) body = body.slice(0, 200) + '…'
    const source = c.kind === 'diary'
      ? c.meta?.kind === 'spoken' ? '当时说过：' : '心里记下、未对用户说出：'
      : ''
    const piece = `「${label}：${source}${body}」`
    if (out.length && used + piece.length > o.budgetChars) break
    out.push({ ...c, label, piece })
    used += piece.length
    if (used >= o.budgetChars) break
  }
  return out
}

/**
 * 格式化成提示词段落。空数组 → 空串（与现状逐字一致，不破坏既有断言）。
 * 元素是 recall() 的结果对象，也可以直接是片段字符串（context.js 那样传）。
 */
export function formatRecall(results = []) {
  if (!results.length) return ''
  const pieces = results.map((r) => (typeof r === 'string' ? r : r && r.piece)).filter(Boolean)
  if (!pieces.length) return ''
  const hasInnerDiary = results.some((r) => r && typeof r === 'object' && r.kind === 'diary' && r.meta?.kind !== 'spoken')
  return [
    '- 你想起的相关往事（这些是检索到的记忆，不是刚发生的事；用得上的自然带一句，不必逐条复读）：',
    ...(hasInnerDiary ? ['  心里独白只是你自己的回忆线索；不要逐字说出，也不要当作曾对他说过的话。'] : []),
    ...pieces.map((p) => `  ${p}`)
  ].join('\n')
}
