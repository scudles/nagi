// src/core/rag/ingest.js
// 入库计划与摘要触发的纯逻辑（IO 在 main/rag/store-io.js，这里不碰文件）。

/**
 * 从待嵌队列里挑出真正要嵌入的：内容哈希去重 + 批量上限。
 * 队列条目即 pending.jsonl 里的一行（含 hash/text）。
 * @param {Array<{hash:string,text:string}>} queue
 * @param {import('./vector-store.js').VectorStore} store
 * @param {{maxBatch?:number}} [opts]
 * @returns {{toEmbed:Array, skip:Array}}
 */
export function planEmbedding(queue = [], store, { maxBatch = 8 } = {}) {
  const toEmbed = []
  const skip = []
  for (const item of queue) {
    if (!item || !item.hash || !item.text) {
      skip.push(item)
      continue
    }
    if (store.hasHash(item.hash)) {
      skip.push(item)
      continue
    }
    toEmbed.push(item)
    if (toEmbed.length >= maxBatch) break
  }
  return { toEmbed, skip }
}

/** 滚动摘要该不该做（每 N 轮一次，设置里可关） */
export function shouldSummarize({ turnsSince = 0, every = 20, enabled = true } = {}) {
  return !!enabled && turnsSince >= every
}

/** 所有 summary chunk 覆盖过的轮次 id 集合（原轮次据此降权，见 recall.js） */
export function coveredTurnIds(store) {
  const ids = new Set()
  if (!store) return ids
  for (const c of store.liveChunks()) {
    if (c.kind !== 'summary' || !c.meta || !Array.isArray(c.meta.covers)) continue
    for (const id of c.meta.covers) ids.add(id)
  }
  return ids
}

/**
 * 挑待摘要的轮次：最近 count 条活着的 turn，排除已被摘要覆盖的。
 * @returns {Array} chunk 数组（按时间升序）
 */
export function pickTurnsToSummarize(store, { count = 20, covered = new Set() } = {}) {
  if (!store) return []
  const turns = store.liveChunks().filter((c) => c.kind === 'turn' && !covered.has(c.id))
  return turns.slice(-count)
}
