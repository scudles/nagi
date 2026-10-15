// src/core/rag/vector-store.js
// 向量库的纯逻辑核心：内存索引 + 序列化/反序列化 + 崩溃对齐修复。
// 文件落地（userData/rag/ 四件套）在 main/rag/store-io.js，这里一行 IO 都不碰。
//
// 布局约定（设计文档 §1.2）：
//   · 第 i 行 Float32×dim 向量 ↔ 第 i 行 chunks.jsonl，行号严格对齐；
//   · 追加写；删除 = 追加「零向量行 + tombstone 行」，行号不错位；
//   · compact 才重写两文件（照抄 persist.js 的「临时文件 + rename」原子写）。
//
// 崩溃恢复（关键，P4 破坏性用例的地基）：
//   写入顺序是「先 chunk 行、后向量行」，所以半截状态只可能是
//   「chunk 行在、向量行不在」。恢复时 n = min(向量行数, chunk 行数)，
//   两边都截到 n：多出来的 chunk 行对应的文本还在 pending.jsonl 里，
//   重启后重新嵌入，不丢；多出来的向量行直接丢弃。绝不会白屏或崩溃。

import { normalizeChunk } from './chunk.js'
import { normalizeInPlace } from './similarity.js'

export class VectorStore {
  /**
   * @param {{dim:number}} opts dim = 向量维度（由嵌入引擎决定，bge-small-zh = 512）
   */
  constructor({ dim }) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error('VectorStore: dim 必须为正整数')
    }
    this.dim = dim
    this.capacity = 0 // 已分配行数（≥ count）
    this.count = 0 // 实际行数（含墓碑行）
    this.vec = new Float32Array(0)
    this.chunks = [] // 与行号对齐
    this.byId = new Map() // id -> row
    this.byHash = new Map() // 内容哈希 -> row
    this.dead = new Set() // 墓碑行号
  }

  get rowBytes() {
    return this.dim * 4
  }

  /** 活着的条目数 */
  get liveCount() {
    return this.count - this.dead.size
  }

  /** 扩容（倍增，最少 1024 行起） */
  _ensure(rows) {
    if (rows <= this.capacity) return
    let cap = Math.max(1024, this.capacity)
    while (cap < rows) cap *= 2
    const next = new Float32Array(cap * this.dim)
    next.set(this.vec.subarray(0, this.count * this.dim))
    this.vec = next
    this.capacity = cap
  }

  /**
   * 追加一条。向量会在此处 L2 归一化（检索侧就是纯点积）。
   * @returns {{ok:true,row:number}|{ok:false,reason:string}}
   */
  append(chunk, vector) {
    if (!chunk || !chunk.hash) return { ok: false, reason: 'chunk 无效' }
    if (!vector || vector.length !== this.dim) return { ok: false, reason: '向量维度不符' }
    // 幂等：已存在且活着 → 跳过；已存在但被墓碑（用户忘掉过）→ 允许重新入库
    const oldByHash = this.byHash.get(chunk.hash)
    if (oldByHash !== undefined && !this.dead.has(oldByHash)) return { ok: false, reason: '内容已存在' }
    const oldById = this.byId.get(chunk.id)
    if (oldById !== undefined && !this.dead.has(oldById)) return { ok: false, reason: 'id 已存在' }
    const row = this.count
    this._ensure(row + 1)
    this.vec.set(vector, row * this.dim)
    normalizeInPlace(this.vec.subarray(row * this.dim, (row + 1) * this.dim))
    this.chunks[row] = chunk
    this.count = row + 1
    this.byId.set(chunk.id, row)
    this.byHash.set(chunk.hash, row)
    return { ok: true, row }
  }

  /**
   * 删除（墓碑）。调用方负责把 chunkLines() 对应行写成 tombstone 落盘。
   * @returns {boolean} 是否真的删掉了一条
   */
  remove(id) {
    const row = this.byId.get(id)
    if (row === undefined || this.dead.has(row)) return false
    this.dead.add(row)
    this.vec.fill(0, row * this.dim, (row + 1) * this.dim)
    return true
  }

  /** 该内容是否已在库（只看活行；被忘掉的可以重新记住） */
  hasHash(hash) {
    const row = this.byHash.get(hash)
    return row !== undefined && !this.dead.has(row)
  }

  hasId(id) {
    const row = this.byId.get(id)
    return row !== undefined && !this.dead.has(row)
  }

  chunkById(id) {
    const row = this.byId.get(id)
    return row === undefined ? null : this.chunks[row]
  }

  /** 某一行的向量视图（入库归一化后的 Float32；追加落盘用） */
  rowVector(row) {
    return this.vec.subarray(row * this.dim, (row + 1) * this.dim)
  }

  rowById(id) {
    return this.byId.get(id)
  }

  rowOfHash(hash) {
    return this.byHash.get(hash)
  }

  isDead(row) {
    return this.dead.has(row)
  }

  /** 活 chunk 列表（压缩 / 摘要挑选用） */
  liveChunks() {
    const out = []
    for (let r = 0; r < this.count; r++) {
      if (!this.dead.has(r)) out.push(this.chunks[r])
    }
    return out
  }

  /** 序列化：当前全部行（含墓碑零行），与 chunks.jsonl 行号对齐 */
  vectorsBytes() {
    const bytes = this.count * this.rowBytes
    return new Uint8Array(this.vec.buffer, this.vec.byteOffset, bytes).slice()
  }

  /** 序列化：chunk 行（墓碑行写成 { tombstone, id, at }） */
  chunkLines() {
    const out = []
    for (let r = 0; r < this.count; r++) {
      const c = this.chunks[r]
      out.push(JSON.stringify(this.dead.has(r) ? { tombstone: true, id: c.id, at: c.at } : c))
    }
    return out
  }

  /**
   * 从磁盘恢复（含崩溃对齐修复）。
   * @param {{dim:number, vectorsBytes:Uint8Array|null, chunkLines:string[]}} raw
   * @returns {{store:VectorStore, repaired:{droppedVectorRows:number, droppedChunkLines:number, badLines:number}}}
   *   repaired 非零 → 调用方应重写两文件对齐（见 store-io.load）
   */
  static open({ dim, vectorsBytes, chunkLines = [] }) {
    const store = new VectorStore({ dim })
    const repaired = { droppedVectorRows: 0, droppedChunkLines: 0, badLines: 0 }
    const rowBytes = store.rowBytes
    const bytes = vectorsBytes instanceof Uint8Array ? vectorsBytes : new Uint8Array(vectorsBytes || 0)
    const vecRows = Math.floor(bytes.length / rowBytes)

    // append-only 文件里，坏行只可能是最后一行 → 从第一处坏行起全部截掉。
    // 特例：文件末尾的那个换行会产生一个空行，那是正常的，跳过它。
    let end = chunkLines.length
    if (end > 0 && String(chunkLines[end - 1] == null ? '' : chunkLines[end - 1]).trim() === '') end--
    const chunks = []
    for (let i = 0; i < end; i++) {
      const line = String(chunkLines[i] == null ? '' : chunkLines[i]).trim()
      if (!line) {
        repaired.badLines++
        break
      }
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {
        repaired.badLines++
        break
      }
      const c = normalizeChunk(obj)
      if (!c) {
        repaired.badLines++
        break
      }
      chunks.push(c)
    }

    const n = Math.min(vecRows, chunks.length)
    repaired.droppedVectorRows = vecRows - n
    repaired.droppedChunkLines = chunks.length - n

    store._ensure(n)
    if (n > 0) {
      store.vec.set(new Float32Array(bytes.buffer, bytes.byteOffset, n * store.dim))
    }
    store.count = n
    for (let r = 0; r < n; r++) {
      const c = chunks[r]
      store.chunks[r] = c
      if (c.tombstone) {
        // 墓碑行本身是占位死行；它还要把「前面同 id 的真身」一并标记死
        // （append-only 删除的语义：删除 = 追加一行墓碑，不动旧行）。
        store.dead.add(r)
        if (c.id) {
          const orig = store.byId.get(c.id)
          if (orig !== undefined && !store.dead.has(orig)) {
            store.dead.add(orig)
            store.vec.fill(0, orig * store.dim, (orig + 1) * store.dim)
            // byId 保持指向真身行：chunkById 仍拿得到原 chunk（虽已死）
          } else if (orig === undefined) {
            store.byId.set(c.id, r) // 真身不在（极端损坏）：至少记着 id
          }
        }
      } else {
        store.byId.set(c.id, r)
        store.byHash.set(c.hash, r)
      }
    }
    return { store, repaired }
  }

  /**
   * 压缩计划：丢掉墓碑行，返回重写用的向量与 chunk 行。
   * @returns {{vectors:Uint8Array, lines:string[], keep:number[]}}
   */
  compactPlan() {
    const keep = []
    for (let r = 0; r < this.count; r++) {
      if (!this.dead.has(r)) keep.push(r)
    }
    const out = new Float32Array(keep.length * this.dim)
    const lines = []
    keep.forEach((r, i) => {
      out.set(this.vec.subarray(r * this.dim, (r + 1) * this.dim), i * this.dim)
      lines.push(JSON.stringify(this.chunks[r]))
    })
    return { vectors: new Uint8Array(out.buffer), lines, keep }
  }

  /**
   * 就地应用压缩结果（紧凑后所有行号前移，索引重建）。
   * 必须在文件重写成功之后调用——写盘失败时内存仍与旧文件一致。
   */
  applyCompact(plan) {
    const n = plan.keep.length
    this._ensure(n)
    this.vec.set(new Float32Array(plan.vectors.buffer, plan.vectors.byteOffset, n * this.dim))
    this.count = n
    this.chunks = plan.keep.map((r) => this.chunks[r])
    this.dead = new Set()
    this.byId = new Map()
    this.byHash = new Map()
    for (let r = 0; r < n; r++) {
      this.byId.set(this.chunks[r].id, r)
      this.byHash.set(this.chunks[r].hash, r)
    }
  }
}
