// src/core/rag/index.js
// RAG 纯逻辑层统一出口。main / test / demo 都从这里引。

export { contentHash, normalizeText } from './hash.js'
export {
  CHUNK_KINDS,
  KIND_WEIGHT,
  MAX_CHUNK_CHARS,
  dayKey,
  makeChunkId,
  finalizeChunk,
  makeTurnChunk,
  makeFactChunk,
  makeSummaryChunk,
  makeDiaryChunk,
  normalizeChunk,
  clipText
} from './chunk.js'
export { dot, cosine, vecNorm, normalizeInPlace, decayFactor, DAY_MS } from './similarity.js'
export { VectorStore } from './vector-store.js'
export { SEARCH_DEFAULTS, COVERED_TURN_FACTOR, timeLabel, scoreCandidates, recall, formatRecall } from './recall.js'
export { planEmbedding, shouldSummarize, coveredTurnIds, pickTurnsToSummarize } from './ingest.js'
export { EMBED_ENGINES, pickEmbedEngine } from './embedding.js'
