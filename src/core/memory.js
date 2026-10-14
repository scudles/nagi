// src/core/memory.js
// 长期记忆的纯逻辑：格式化进提示词、解析模型吐出的增删指令、合并去重。
// 文件读写（userData/memory.json）在 main/memory-store.js，这里不碰 IO，方便单测。

/** 记忆条目上限（超出丢最旧的） */
export const MEMORY_LIMIT = 60

/** 单条记忆最长字符（防止模型吐长句子把提示撑爆） */
const MAX_TEXT = 60

/** 让模型从一轮对话里抽取"值得长期记住的事"的提示词 */
export const MEMORY_EXTRACT_PROMPT = [
  '你在维护一个长期记忆清单，记录「关于用户、值得以后还记得的事实」。',
  '输入是一轮对话。只抽取以后还用得上的信息，例如：',
  '  他的身份/在做的事、长期偏好、习惯、明确的约定、提到过的重要人和物、身体或作息状况。',
  '不要抽取：一次性的闲聊、情绪化的话、你自己说过的话、能从当下语境临时推理出来的东西。',
  '每条不超过 30 字，用第三人称陈述（例：「在做一款叫凪的桌宠项目」）。',
  '最多输出 2 条。没有任何值得记的就输出空数组。',
  '',
  '严格只输出 JSON，不要解释、不要 markdown 代码块：',
  '{"add": ["..."], "remove": ["..."]}',
  'add = 新增的记忆；remove = 应当作废的旧记忆（必须与已有记忆原文完全一致，没有就留空数组）'
].join('\n')

/**
 * 记忆条目格式化为提示词用的短句数组。
 * @param {Array<{text?:string}>|string[]} entries
 * @returns {string[]}
 */
export function formatMemories(entries = []) {
  return entries
    .map((e) => (typeof e === 'string' ? e : e && e.text))
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim())
}

/**
 * 解析模型输出的 JSON（容错：去掉 ```json 围栏、截取首个 { ... } 片段）。
 * @returns {{add: string[], remove: string[]}}
 */
export function parseMemoryOps(raw) {
  const empty = { add: [], remove: [] }
  if (!raw || typeof raw !== 'string') return empty
  let s = raw.trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return empty
  let obj
  try {
    obj = JSON.parse(s.slice(start, end + 1))
  } catch {
    return empty
  }
  const pick = (v) =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, MAX_TEXT))
      : []
  return { add: pick(obj.add), remove: pick(obj.remove) }
}

/**
 * 应用增删指令，返回全新条目数组。纯函数。
 * - add：新条目入队；与已有条目（去空格后）相同则跳过
 * - remove：按原文精确匹配删除
 * - 超出上限丢最旧的（保留最新）
 * @param {Array<{id?:string,text:string,at?:number}>} entries
 * @param {{add?:string[],remove?:string[]}} ops
 * @param {number} now
 */
export function applyMemoryOps(entries = [], ops = {}, now = Date.now()) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim()
  const removeSet = new Set((ops.remove || []).map(norm))
  let out = entries
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .filter((e) => !removeSet.has(norm(e.text)))

  const seen = new Set(out.map((e) => norm(e.text)))
  for (const text of ops.add || []) {
    const n = norm(text)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push({ id: 'm' + now.toString(36) + '_' + out.length, text: text.trim(), at: now })
  }

  if (out.length > MEMORY_LIMIT) out = out.slice(out.length - MEMORY_LIMIT)
  return out
}
