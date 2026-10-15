// src/core/rag/embedding.js
// 嵌入引擎注册表（与 TTS/ASR 同款思路：接口抽象、可无缝切换、
// 都没就绪时静默关闭）。真正的适配器在 main/rag/（要碰 IO/网络），
// 这里只放能力声明与挑选逻辑——core 层保持零依赖可单测。
//
// 适配器契约（main/rag/ 里实现）：
//   { id, dim, label, embed(texts: string[]) -> Promise<Float32Array[]> }

export const EMBED_ENGINES = {
  none: {
    id: 'none',
    label: '关闭（不建记忆档案）',
    offline: true,
    needsKey: false,
    needsModel: false,
    needsNetwork: false,
    dim: 0,
    note: '不存档也不召回，她的行为和以前完全一样。'
  },
  local: {
    id: 'local',
    label: '本地模型 bge-small-zh（推荐）',
    offline: true,
    needsKey: false,
    needsModel: true,
    needsNetwork: false,
    dim: 512,
    // bge v1.5 中文模型的 query 侧指令：加在查询前（文档侧不加）检索更准
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    note: '中文检索的小模型，首次需下载约 25MB；装好后完全离线、免费、隐私最好——对话内容不出本机。'
  },
  openai: {
    id: 'openai',
    label: '云端 embeddings（OpenAI 兼容）',
    offline: false,
    needsKey: true,
    needsModel: false,
    needsNetwork: true,
    dim: 1536,
    note: '零下载，但每一轮对话都要先发给第三方公司才能检索——与「绝不上传」的底线冲突，按量付费，断网不可用。默认不建议。'
  }
}

/**
 * 按「用户选择 + 实际可用性」挑引擎。选中的引擎不可用时退回 none
 * （RAG 关闭不该影响她说话——这是贯穿全线的容错原则）。
 * @returns {'none'|'local'|'openai'}
 */
export function pickEmbedEngine({ provider = 'local', localReady = false, hasKey = false } = {}) {
  if (provider === 'openai') return hasKey ? 'openai' : 'none'
  if (provider === 'local') return localReady ? 'local' : 'none'
  return 'none'
}
