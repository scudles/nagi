// src/core/rag/similarity.js
// 相似度与时间衰减的纯函数。
//
// 注意：写入时向量已做 L2 归一化，所以库里 cosine = 点积（检索走快路径）；
// 但 cosine() 仍按完整公式实现——单测和外部传入的向量不假定已归一。

export const DAY_MS = 86400000

/** 点积 */
export function dot(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** L2 范数 */
export function vecNorm(a) {
  return Math.sqrt(dot(a, a))
}

/** 余弦相似度（任一为零向量 → 0，不除零） */
export function cosine(a, b) {
  const na = vecNorm(a)
  const nb = vecNorm(b)
  if (!na || !nb) return 0
  return dot(a, b) / (na * nb)
}

/** 原地 L2 归一化（零向量原样返回） */
export function normalizeInPlace(v) {
  const n = vecNorm(v)
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= n
  }
  return v
}

/**
 * 时间衰减：halfLifeDays 天半衰（默认 45 天）。
 *
 * ⚠ 它只参与排序，不决定去留——阈值卡在语义相似度上（见 recall.js）。
 * 若用「衰减后分数 < 阈值」淘汰，一年前的相关记忆会被 0.5^(365/45) ≈ 0.0036
 * 乘到阈值以下，等于静默删除，违背「旧的沉但不消失」。
 */
export function decayFactor(ageDays, halfLifeDays = 45) {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1
  const hl = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 45
  return Math.pow(0.5, ageDays / hl)
}
