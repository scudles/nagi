// src/core/llm/stream-normalize.js
// 把各家 OpenAI 兼容接口的流式输出，归一化成统一事件：
//   { type:'emotion', emotion }   —— 行首 [情绪] 标签（只出现一次）
//   { type:'text', text }         —— 正文增量（已剥掉标签）
//   { type:'done' }               —— 结束
// 纯逻辑，无 Electron/Node 依赖，可 node --test。

export const EMOTION_TAG_RE = /^\s*\[(calm|puzzled|smile|worry|pout|joy)\]\s*/i

/**
 * 行首 [情绪] 标签解析器。
 * 标签可能被拆到多个 chunk 里（"[", "cal", "m]"），所以需要缓冲。
 */
export class EmotionTagParser {
  constructor() {
    this.buffer = ''
    this.resolved = false
    this.emotion = null
  }

  /** @returns {{ emotion?: string, text: string }} */
  push(chunk) {
    const piece = chunk == null ? '' : String(chunk)
    if (this.resolved) return { text: piece }

    this.buffer += piece

    const m = this.buffer.match(EMOTION_TAG_RE)
    if (m) {
      this.resolved = true
      this.emotion = m[1].toLowerCase()
      const rest = this.buffer.slice(m[0].length)
      this.buffer = ''
      return { emotion: this.emotion, text: rest }
    }

    // 仍可能是一个还没写完的标签（如 "", " ", "[", "[ca"）
    if (this.buffer.length <= 24 && /^\s*\[?[a-zA-Z]*$/.test(this.buffer)) {
      return { text: '' }
    }

    // 不是标签，原样吐出
    this.resolved = true
    const out = this.buffer
    this.buffer = ''
    return { text: out }
  }

  /** 流结束时调用：把残留 buffer 吐出来 */
  flush() {
    if (this.resolved || !this.buffer) return { text: '' }
    this.resolved = true
    const out = this.buffer
    this.buffer = ''
    return { text: out }
  }
}

/**
 * 消费一个"文本增量流"，产出归一化事件。
 * @param {AsyncIterable<string>} chunks
 * @returns {AsyncGenerator<{type:string, text?:string, emotion?:string}>}
 */
export async function* normalizeStream(chunks) {
  const parser = new EmotionTagParser()
  let sawText = false
  for await (const chunk of chunks) {
    const { emotion, text } = parser.push(chunk)
    if (emotion) yield { type: 'emotion', emotion }
    if (text) {
      sawText = true
      yield { type: 'text', text }
    }
  }
  const rest = parser.flush()
  if (rest.text) yield { type: 'text', text: rest.text }
  if (!sawText && !parser.emotion) yield { type: 'text', text: '' }
  yield { type: 'done' }
}

/** 从一段完整文本里抽出情绪标签（非流式场景） */
export function extractEmotionTag(text) {
  const m = String(text || '').match(EMOTION_TAG_RE)
  if (!m) return { emotion: null, text: String(text || '') }
  return { emotion: m[1].toLowerCase(), text: String(text).slice(m[0].length) }
}
