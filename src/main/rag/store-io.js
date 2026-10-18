// src/main/rag/store-io.js
// userData/rag/ 四件套的文件落地：
//   meta.json（维度/模型对齐信息）· vectors.bin（Float32 连续二进制，追加写）
//   chunks.jsonl（元数据一行一条，追加写；删除 = tombstone 行）· pending.jsonl（待嵌队列）
//
// 刻意不引 electron——目录由调用方注入，这样单测（node --test）和演示脚本
// 都能拿真实文件系统跑全链路。单例在 index.js 里用 app.getPath('userData') 拼。
// 原子写走 core/persist-io.js（B01：旧的"先 unlink 原文件再 rename"在两步之间
// 崩溃会丢光旧数据，已改为直接 rename 替换）。

import * as fsApi from 'node:fs'
import { reportCatch } from '../maintenance.js'
import { CATCH_CLASS } from '../../core/maintenance/catch-audit.js'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { VectorStore } from '../../core/rag/vector-store.js'
import { atomicWriteSync } from '../../core/persist-io.js'

const META_VERSION = 1

/** 原子写：临时文件 + rename（失败不碰原文件；纯逻辑见 core/persist-io.js）。
 *  保持"失败抛错"的原有语义——调用方（load 对齐修复 / writeMeta 等）依赖异常传播。 */
function atomicWrite(file, buf) {
  mkdirSync(dirname(file), { recursive: true })
  const r = atomicWriteSync(fsApi, file, buf)
  if (!r.ok) throw new Error(r.error)
  return r
}

function readText(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch (err) {
    // B8：读存储失败**不等于**"这个文件本来就没有"。
    // 旧实现直接返回空串，于是"meta 读不出来"会被上层当成"全新库"，
    // 用户看到的现象是"记忆突然清空了"。这里按不可静默持久化上报，
    // 让轨迹里能查到是哪一次读失败把空串喂上去的。
    reportCatch('rag.store-io.readText', CATCH_CLASS.MUST_PERSIST, err)
    return ''
  }
}

export class RagStoreIo {
  /**
   * @param {string} dir userData/rag
   */
  constructor(dir) {
    this.dir = dir
    this.meta = { version: META_VERSION, model: '', dim: 0, updatedAt: 0 }
    this._metaLoaded = false
  }

  get vectorsFile() {
    return join(this.dir, 'vectors.bin')
  }
  get chunksFile() {
    return join(this.dir, 'chunks.jsonl')
  }
  get pendingFile() {
    return join(this.dir, 'pending.jsonl')
  }
  get metaFile() {
    return join(this.dir, 'meta.json')
  }
  get revokedFile() {
    return join(this.dir, 'revoked.json')
  }

  readRevoked() {
    if (!existsSync(this.revokedFile)) return new Set()
    const ids = JSON.parse(readFileSync(this.revokedFile, 'utf8'))
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('撤销清单损坏，记忆检索已暂停')
    return new Set(ids)
  }

  writeRevoked(ids) {
    atomicWrite(this.revokedFile, JSON.stringify([...ids]))
  }

  /** 读 meta（损坏/缺失都当默认值，绝不抛） */
  loadMeta() {
    let meta = { ...this.meta }
    try {
      if (existsSync(this.metaFile)) {
        const raw = JSON.parse(readFileSync(this.metaFile, 'utf8'))
        if (raw && typeof raw === 'object') meta = { ...meta, ...raw }
      }
    } catch {
      /* meta 损坏不影响主数据 */
    }
    this.meta = meta
    this._metaLoaded = true
    return meta
  }

  writeMeta(patch = {}) {
    this.meta = { ...this.meta, ...patch, updatedAt: Date.now() }
    atomicWrite(this.metaFile, JSON.stringify(this.meta, null, 2))
    return this.meta
  }

  /**
   * 载入向量库（含崩溃对齐修复）。
   * @param {number} dim 当前嵌入引擎的维度
   * @returns {{store:VectorStore, repaired:object, dimMismatch:boolean}}
   *   dimMismatch=true → 库里向量的维度与当前引擎不符（或维度未知）。
   *   此时文本全部保留（供 rebuild），但向量按垃圾处理，recall 关闭。
   */
  load(dim) {
    mkdirSync(this.dir, { recursive: true })
    const meta = this.loadMeta()
    const vecBytes = existsSync(this.vectorsFile) ? new Uint8Array(readFileSync(this.vectorsFile)) : new Uint8Array(0)
    const chunkText = readText(this.chunksFile)
    const chunkLines = chunkText ? chunkText.split('\n') : []

    const fresh = vecBytes.length === 0 && chunkLines.length === 0
    let useDim = dim
    let dimMismatch = false
    if (!fresh && meta.dim !== dim) {
      // 维度未知或与当前引擎不符：用 dim=1 打开——不为读向量，只为把
      // chunks.jsonl 里的文本全部读出（vecRows 会被算得很大，n 取 chunk 行数，
      // 一条文本都不丢）。recall 因 dimMismatch 关闭，直到 rebuild() 重新嵌入。
      useDim = 1
      dimMismatch = true
    }

    const { store, repaired } = VectorStore.open({ dim: useDim, vectorsBytes: vecBytes, chunkLines })

    // 对齐修复：把「chunk 行在、向量行不在」之类的半截状态截齐。
    // 被截掉的文本还在 pending.jsonl 里，重启后会重新嵌入，不丢。
    if (!dimMismatch && (repaired.droppedVectorRows || repaired.droppedChunkLines || repaired.badLines)) {
      this.rewriteAll(store)
    }
    if (!dimMismatch && meta.dim !== dim) this.writeMeta({ dim })
    return { store, repaired, dimMismatch }
  }

  /**
   * 追加一条已嵌入的 chunk。
   * ⚠ 顺序刻意「先 chunk 行、后向量行」：崩溃半截状态只可能是
   * 「行在、向量不在」，恢复时按 min(向量行数, chunk 行数) 截掉该行，
   * 对应文本仍在 pending.jsonl，会重新嵌入。
   */
  appendEmbedded(chunk, vector) {
    // 维度必须跟着第一次写入就落进 meta：否则「没走过 load 就直接追加」的库
    // 重启时 meta.dim 还是 0，会被误判成维度不符（RAG 静默关闭）。
    const dim = vector.length
    if (!this._metaLoaded) this.loadMeta()
    if (this.meta.dim !== dim) this.writeMeta({ dim })
    appendFileSync(this.chunksFile, JSON.stringify(chunk) + '\n')
    appendFileSync(this.vectorsFile, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))
  }

  /** 追加墓碑（删除）：零向量行 + tombstone 行，行号不错位 */
  appendTombstone(chunk, rowBytes) {
    appendFileSync(this.chunksFile, JSON.stringify({ tombstone: true, id: chunk.id, at: chunk.at }) + '\n')
    appendFileSync(this.vectorsFile, Buffer.alloc(rowBytes))
  }

  /** 读待嵌队列（pending.jsonl；半行丢弃——那句话下轮还会写进来） */
  readPending() {
    const text = readText(this.pendingFile)
    if (!text) return []
    const out = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t)
        if (obj && typeof obj.text === 'string' && obj.hash) out.push(obj)
      } catch {
        /* 半行丢弃 */
      }
    }
    return out
  }

  /** 追加进待嵌队列 */
  appendPending(items) {
    if (!items || !items.length) return
    appendFileSync(this.pendingFile, items.map((c) => JSON.stringify({ ...c, vec: false })).join('\n') + '\n')
  }

  /** 重写待嵌队列（嵌入成功后摘掉已入档的） */
  rewritePending(items) {
    if (!items || !items.length) {
      try {
        if (existsSync(this.pendingFile)) unlinkSync(this.pendingFile)
      } catch {
        /* ignore */
      }
      return
    }
    atomicWrite(this.pendingFile, items.map((c) => JSON.stringify(c)).join('\n') + '\n')
  }

  /** 原子重写全部（compact / 对齐修复用）；内存态一起紧凑 */
  rewriteAll(store) {
    const plan = store.compactPlan()
    atomicWrite(this.vectorsFile, Buffer.from(plan.vectors))
    atomicWrite(this.chunksFile, plan.lines.join('\n') + (plan.lines.length ? '\n' : ''))
    store.applyCompact(plan)
    this.writeMeta({ dim: store.dim, count: store.count })
  }

  /** compact：有墓碑才重写（无墓碑跳过高代价 IO） */
  compact(store) {
    if (!store.dead.size) return { ok: true, skipped: true }
    this.rewriteAll(store)
    return { ok: true, skipped: false, rows: store.count }
  }

  /** 磁盘占用（字节） */
  diskUsage() {
    let bytes = 0
    for (const f of [this.vectorsFile, this.chunksFile, this.pendingFile, this.metaFile, this.revokedFile]) {
      try {
        if (existsSync(f)) bytes += statSync(f).size
      } catch {
        /* ignore */
      }
    }
    return bytes
  }

  /** 清空档案（设置页二次确认后才调） */
  clear() {
    for (const f of [this.vectorsFile, this.chunksFile, this.pendingFile, this.metaFile, this.revokedFile]) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
    this.meta = { version: META_VERSION, model: '', dim: 0, updatedAt: 0 }
  }
}
