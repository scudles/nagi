// src/core/voice/segmenter.js
// 分句缓冲：把 LLM 的 token 流切成「可朗读的句子」。
//
// 为什么需要它：整段生成完再合成，首响 = 整段时长；按句切开、第一句一成形就送去合成，
// 首响就从「整段」降到「首句」——这是流式语音体验的关键（也是 NFR「首响约 1s」的前提）。
//
// 纯逻辑，无 Electron / Node 依赖，可 node --test。

import { EMOTION_TAG_RE } from '../llm/stream-normalize.js'

/** 句末标点：到这里就可以断句 */
const HARD_END = /[。！？!?…；;\n]/
/** 句中标点：实在等不到句末、又太长时，退而求其次在软标点处断 */
const SOFT_END = /[，,、：:]/
/** 句末的收尾符：应当跟着上一句走，不能切到下一句开头 */
const CLOSERS = /[」』"'”’）)】\]]/

export const SEG_DEFAULTS = {
  /** 短于这个长度不单独成句（避免「嗯。」「哦。」这种碎句把 TTS 打得太散） */
  minChars: 6,
  /** 超过这个长度还没句末标点，就找软标点断 */
  maxChars: 60
}

/**
 * 在缓冲里找一个可切的断点。
 * @returns {number} 切点下标（不含）；-1 表示还得再等更多 token
 */
function findCut(s, minChars, maxChars) {
  // ① 找最早的「合格句末标点」（合 = 切出来的句子不短于 minChars，避免切出「嗯。」这种碎句）
  let hard = -1
  for (let i = 0; i < s.length; i++) {
    if (!HARD_END.test(s[i])) continue
    let end = i + 1
    while (end < s.length && CLOSERS.test(s[end])) end++ // 句末引号/括号跟着上一句
    if (s.slice(0, end).trim().length >= minChars) {
      hard = end
      break
    }
  }
  // 句末标点就在 maxChars 以内 → 直接按它断
  if (hard > 0 && hard <= maxChars) return hard

  // ② 要么还没等到句末标点、要么句子太长 → 到 maxChars 就该动手了
  if (s.length >= maxChars) {
    const limit = hard > 0 ? Math.min(hard, maxChars) : Math.min(s.length, maxChars)
    for (let i = limit - 1; i >= minChars; i--) {
      if (SOFT_END.test(s[i])) {
        let end = i + 1
        while (end < s.length && CLOSERS.test(s[end])) end++
        return end
      }
    }
    return limit // 连软标点都没有（长串英文/数字）→ 硬切
  }

  // ③ 还没到 maxChars、也没有合格句末标点 → 继续等 token
  return -1
}

/**
 * 创建一个分句器。
 * @param {{minChars?:number, maxChars?:number}} [opts]
 */
export function createSegmenter(opts = {}) {
  const minChars = opts.minChars ?? SEG_DEFAULTS.minChars
  const maxChars = opts.maxChars ?? SEG_DEFAULTS.maxChars
  let buf = ''

  return {
    /**
     * 喂入一个 token 增量，返回这次能吐出的完整句（可能 0~n 句）。
     * @param {string} chunk
     * @returns {string[]}
     */
    push(chunk) {
      buf += chunk == null ? '' : String(chunk)
      const out = []
      let guard = 0
      while (guard++ < 500) {
        const cut = findCut(buf, minChars, maxChars)
        if (cut <= 0) break
        const seg = buf.slice(0, cut).trim()
        buf = buf.slice(cut)
        if (seg) out.push(seg)
      }
      return out
    },

    /** 流结束时调用：吐出最后残留的一句（没有则 null） */
    flush() {
      const rest = buf.trim()
      buf = ''
      return rest || null
    },

    /** 还没成句的残留（调试用） */
    get pending() {
      return buf
    }
  }
}

/**
 * 把一段完整文本切成句子（非流式场景，例如历史消息重播 / 主动搭话）。
 * @param {string} text
 * @param {{minChars?:number, maxChars?:number}} [opts]
 * @returns {string[]}
 */
export function splitSentences(text, opts = {}) {
  const seg = createSegmenter(opts)
  const out = seg.push(text)
  const rest = seg.flush()
  if (rest) out.push(rest)
  return out
}

/**
 * 把回复正文清洗成「适合朗读的文本」——保留语气与停顿，删掉不该念出来的东西。
 * 代码块、行内代码、Markdown 标记、行首情绪标签、裸 URL 一律不朗读。
 * @param {string} text
 * @returns {string}
 */
export function toSpeechText(text) {
  let s = String(text || '')
  s = s.replace(EMOTION_TAG_RE, '') // 行首 [smile] 情绪标签
  s = s.replace(/```[\s\S]*?```/g, ' ') // 围栏代码块（含语言标记）
  s = s.replace(/`([^`]*)`/g, '$1') // 行内代码：念内容不念反引号
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片 → 只留文字
  s = s.replace(/https?:\/\/\S+/g, '') // 裸 URL 不念
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题 #
  s = s.replace(/^\s*[-*+]\s+/gm, '') // 列表符
  s = s.replace(/^\s*>\s?/gm, '') // 引用符
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
  s = s.replace(/[*_~]/g, '') // 其余强调符（** / __ / ~~）
  s = s.replace(/[ \t\u3000]+/g, ' ') // 压缩空格（不动换行，换行是语气停顿）
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}
