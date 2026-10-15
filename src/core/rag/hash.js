// src/core/rag/hash.js
// 内容哈希：RAG「同一句话不存两遍」靠它。
//
// 为什么是 FNV-1a 而不是 node:crypto：纯函数、零依赖、跨进程行为确定；
// 个人助理量级（估 5 万条）下，两个不同种子的 32 位哈希拼成 64 位等效，
// 碰撞概率可忽略（真要较真，碰撞的后果也只是「少存一条」，不是数据错误）。

/** 规范化：去掉所有空白再比——「你好 呀」和「你好呀」是同一句 */
export function normalizeText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '')
}

/** FNV-1a 32 位（换 seed 出第二个哈希） */
function fnv1a(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * 内容哈希。空文本返回 ''。
 * @param {string} text
 * @returns {string} 形如 'k3f9a1x8d2' 的稳定串
 */
export function contentHash(text) {
  const n = normalizeText(text)
  if (!n) return ''
  return fnv1a(n, 0x811c9dc5) + fnv1a(n, 0x9e3779b9)
}
