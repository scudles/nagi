// src/core/rag/chunk.js
// 档案条目（chunk）的构造与规范化。纯逻辑，可单测。
//
// 一条 chunk = 一段「能被向量找回来的文本」+ 元数据。
// kind 决定检索时的类型权重：fact 是提炼过的结论（权重最高），
// turn 是原始对话轮次，summary 是滚动摘要的压缩产物（降权）。

import { contentHash } from './hash.js'

/** 单条 chunk 文本上限（超出截断，防止把提示词撑爆） */
export const MAX_CHUNK_CHARS = 1200

/** 合法类型 */
export const CHUNK_KINDS = ['turn', 'fact', 'summary', 'diary', 'event']

/** 类型权重（设计文档 §3：fact ×1.15 / turn ×1.0 / summary ×0.8） */
export const KIND_WEIGHT = { fact: 1.15, turn: 1.0, summary: 0.8, diary: 0.9, event: 0.9 }

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期串：2026-10-15 */
export function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 稳定 id：t_20261015_ab12cd（类型 + 日期 + 内容哈希前 6 位）。
 * 同内容同日期只会有一条——去重已经保证了，所以不需要随机序号
 * （随机数会让同一句话每次入库拿到不同 id，重启后去重就失效了）。
 */
export function makeChunkId(kind, at, hash) {
  return `${kind[0]}_${dayKey(at).replace(/-/g, '')}_${String(hash).slice(0, 6)}`
}

function clip(s, max) {
  const t = String(s == null ? '' : s).trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 对外暴露的截断（与入库时一致）。用来「按原文忘掉一条」：
 * fact 入库时截到 300 字，忘的时候得拿同样的文本去算哈希才对得上。
 */
export function clipText(s, max = MAX_CHUNK_CHARS) {
  return clip(s, max)
}

/**
 * 定型：填默认字段、算哈希与 id。文本为空返回 null。
 * @param {{kind:string, role?:string, text:string, at?:number, weight?:number, meta?:object}} raw
 */
export function finalizeChunk(raw) {
  const text = clip(raw.text, MAX_CHUNK_CHARS)
  if (!text) return null
  const kind = CHUNK_KINDS.includes(raw.kind) ? raw.kind : 'turn'
  const at = Number.isFinite(raw.at) ? raw.at : Date.now()
  const hash = contentHash(text)
  if (!hash) return null
  return {
    id: makeChunkId(kind, at, hash),
    kind,
    role: raw.role || (kind === 'turn' ? 'both' : kind === 'fact' ? 'user' : 'assistant'),
    text,
    at,
    day: dayKey(at),
    weight: Number.isFinite(raw.weight) ? raw.weight : KIND_WEIGHT[kind] ?? 1,
    hash,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  }
}

/** 一轮对话 → 一条 turn chunk（user+assistant 整轮为一条，保住语境） */
export function makeTurnChunk({ user, assistant, at = Date.now(), mood = '', meta = {} } = {}) {
  const u = clip(user, 600)
  const a = clip(assistant, 600)
  if (!u && !a) return null
  const lines = []
  if (u) lines.push('他：' + u)
  if (a) lines.push('我：' + a)
  return finalizeChunk({
    kind: 'turn',
    role: 'both',
    text: lines.join('\n'),
    at,
    meta: mood ? { ...meta, mood } : meta
  })
}

/** 一条精选事实 → fact chunk（与 memory.json 同步一份，向量层做语义去重） */
export function makeFactChunk({ text, at = Date.now(), source = 'memory', meta = {} } = {}) {
  const t = clip(text, 300)
  if (!t) return null
  return finalizeChunk({ kind: 'fact', role: 'user', text: t, at, meta: { ...meta, source } })
}

/** 滚动摘要 → summary chunk；covers 记被压缩的轮次 id（原轮次据此降权） */
export function makeSummaryChunk({ text, covers = [], at = Date.now(), meta = {} } = {}) {
  const t = clip(text, 800)
  if (!t) return null
  return finalizeChunk({
    kind: 'summary',
    role: 'assistant',
    text: t,
    at,
    meta: { ...meta, covers: covers.slice(0, 60) }
  })
}

/** 日记 / 独白 → diary chunk（二期接线用） */
export function makeDiaryChunk({ text, at = Date.now(), meta = {} } = {}) {
  return finalizeChunk({ kind: 'diary', role: 'assistant', text, at, meta })
}

/**
 * 反规范化：把读盘得到的任意对象收敛成合法 chunk。非法返回 null。
 * 墓碑行（删除标记）原样返回 { tombstone, id, at }。
 */
export function normalizeChunk(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.tombstone) {
    return { tombstone: true, id: String(raw.id || ''), at: Number(raw.at) || 0 }
  }
  const text = typeof raw.text === 'string' ? raw.text : ''
  const kind = CHUNK_KINDS.includes(raw.kind) ? raw.kind : 'turn'
  const hash = typeof raw.hash === 'string' && raw.hash ? raw.hash : contentHash(text)
  if (!hash) return null
  const at = Number.isFinite(raw.at) ? raw.at : Date.now()
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeChunkId(kind, at, hash),
    kind,
    role: typeof raw.role === 'string' ? raw.role : 'both',
    text: clip(text, MAX_CHUNK_CHARS),
    at,
    day: typeof raw.day === 'string' ? raw.day : dayKey(at),
    weight: Number.isFinite(raw.weight) ? raw.weight : KIND_WEIGHT[kind] ?? 1,
    hash,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  }
}
