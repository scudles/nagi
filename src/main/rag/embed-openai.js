// src/main/rag/embed-openai.js
// 云端 embeddings 适配器（任何 OpenAI 兼容 /v1/embeddings 端点）。
//
// 这是显式可选项，不是默认：选它意味着每一轮对话内容都要先发给第三方公司才能检索，
// 与「绝不上传」的底线冲突，且按量付费、断网不可用。设置页有明确告知。
// 复用现有 LLM Key（很多厂商同一个 key 也开 embeddings）。

import { getSecret, hasSecret } from '../keystore.js'
import { getSettings } from '../settings-store.js'
import { SECRET_KEYS } from '../../shared/protocol.js'

/** text-embedding-3-small 的维度；换模型要同步改（服务按 dim 判断是否需要重建索引） */
export const OPENAI_EMBED_DIM = 1536

export function openaiEmbedAvailable() {
  return hasSecret(SECRET_KEYS.LLM_API_KEY)
}

/**
 * 批量嵌入（向量同样 L2 归一化，与本地引擎一致）。
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function openaiEmbed(texts = [], { timeoutMs = 15000 } = {}) {
  const settings = getSettings()
  const llm = settings.llm || {}
  const baseURL = (llm.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const key = getSecret(SECRET_KEYS.LLM_API_KEY)
  if (!key) throw new Error('没有 API Key，云端嵌入不可用')
  const model = (settings.rag && settings.rag.embedModel) || 'text-embedding-3-small'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('嵌入请求超时')), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
    const json = await res.json()
    const list = (json.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0))
    if (!list.length) throw new Error('embeddings 返回为空')
    return list.map((d) => {
      const v = Float32Array.from(d.embedding || [])
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
      if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n
      return v
    })
  } finally {
    clearTimeout(timer)
  }
}
