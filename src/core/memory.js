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
 * 合并增删指令并报告真实变化。纯函数。
 *
 * 与 applyMemoryOps 的区别：除了条目数组，还返回 changed/added/removed，
 * 供持久层按「内容变化」判断写盘（修复满额淘汰后数量不变导致不落盘的问题）。
 *
 * @param {Array<{id?:string,text:string,at?:number}>} entries
 * @param {{add?:string[],remove?:string[]}} ops
 * @param {number} now
 * @returns {{entries:Array, changed:boolean, added:string[], removed:string[]}}
 *   added   = 实际进入清单的新文本（去重跳过、超限淘汰不算"成功新增"）
 *   removed = 实际被删掉的旧文本
 *   changed = 清单内容是否发生变化（含满额淘汰与无效条目清理）
 */
export function mergeMemoryEntries(entries = [], ops = {}, now = Date.now()) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim()
  const removeSet = new Set((ops.remove || []).map(norm))
  const removed = entries
    .filter((e) => e && typeof e.text === 'string' && removeSet.has(norm(e.text)))
    .map((e) => e.text.trim())
  let out = entries
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .filter((e) => !removeSet.has(norm(e.text)))

  const seen = new Set(out.map((e) => norm(e.text)))
  const added = []
  for (const text of ops.add || []) {
    const n = norm(text)
    if (!n || seen.has(n)) continue
    seen.add(n)
    const entry = { id: 'm' + now.toString(36) + '_' + out.length, text: text.trim(), at: now }
    out.push(entry)
    added.push(entry.text)
  }

  if (out.length > MEMORY_LIMIT) out = out.slice(out.length - MEMORY_LIMIT)
  const changed = JSON.stringify(entries) !== JSON.stringify(out)
  return { entries: out, changed, added, removed }
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
  return mergeMemoryEntries(entries, ops, now).entries
}
