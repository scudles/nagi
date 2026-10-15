// src/shared/rag-protocol.js
// RAG 长期记忆的 IPC 通道、广播事件与默认设置。
// 刻意独立成文件（不并进 protocol.js）：避开并行开发会话的撞车，同 voice-protocol.js 先例。

/** 渲染层 → 主进程（invoke） */
export const RAG_IPC = {
  STATUS: 'rag:status',
  RECALL_TEST: 'rag:recall-test',
  REBUILD: 'rag:rebuild',
  CLEAR: 'rag:clear',
  MODEL_STATUS: 'rag:model-status',
  MODEL_DOWNLOAD: 'rag:model-download'
}

/** 主进程 → 渲染层（广播） */
export const RAG_EVT = {
  PROGRESS: 'rag:progress'
}

/** 默认设置（settings.rag）。用户没保存过时全套生效 */
export const DEFAULT_RAG_SETTINGS = {
  enabled: true, // 总开关（关掉 = 行为与以前完全一致）
  provider: 'local', // local = 本机 WASM 模型 | openai = 云端 | none = 关闭
  autoSummary: true, // 每 N 轮做一次滚动摘要
  summaryEveryTurns: 20,
  threshold: 0.32, // 语义门限（raw cosine）
  halfLifeDays: 45, // 时间衰减半衰期
  maxResults: 6, // 每次最多召回几条
  budgetChars: 600, // 召回段落总字符预算
  recallTimeoutMs: 2500, // 召回超时（超时静默不注，不拖慢首响）
  embedModel: 'text-embedding-3-small' // 云端引擎用的模型名（本地引擎忽略）
}

/**
 * 合并用户设置与默认值，顺带做数值钳制——设置页的输入框什么都可能吐出来
 * （字符串、负数、NaN），在这里统一收敛，下游拿到的都是合法值。
 */
export function mergeRagSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }
  const clamp = (v, d, lo, hi) => Math.min(hi, Math.max(lo, num(v, d)))
  return {
    enabled: r.enabled !== false,
    provider: ['local', 'openai', 'none'].includes(r.provider) ? r.provider : 'local',
    autoSummary: r.autoSummary !== false,
    summaryEveryTurns: clamp(r.summaryEveryTurns, 20, 5, 200),
    threshold: clamp(r.threshold, 0.32, 0.1, 0.9),
    halfLifeDays: clamp(r.halfLifeDays, 45, 7, 365),
    maxResults: clamp(r.maxResults, 6, 1, 12),
    budgetChars: clamp(r.budgetChars, 600, 100, 2000),
    recallTimeoutMs: clamp(r.recallTimeoutMs, 2500, 500, 10000),
    embedModel:
      typeof r.embedModel === 'string' && r.embedModel.trim() ? r.embedModel.trim() : 'text-embedding-3-small'
  }
}
