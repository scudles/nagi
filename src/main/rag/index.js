// src/main/rag/index.js
// RAG 服务门面：入库（ingest）/ 召回（recall）/ 待嵌补齐（backfill）/ 重建（rebuild）/
// 滚动摘要 / 状态（status）/ 清空（clear）。主进程单例，agent.js 与 IPC 都用它。
//
// 贯穿全线的容错原则：RAG 任何组件失效，她照样能说话。
//   · 嵌入引擎不可用 → recall 静默返回空（行为与今天完全一致）；
//   · 向量文件损坏 / 维度不符 → 文本全保留，标记需要重建，不崩不白屏；
//   · 入库只写 pending.jsonl（纯文本追加），嵌入是后台的事，失败下轮再来。

import { app } from 'electron'
import { join } from 'node:path'
import { createClient, chatStream } from '../../core/llm/openai-compatible.js'
import { apiKeyForLlm, isLocalLlm, resolveLlm } from '../../core/llm/providers.js'
import { initCloudBrain, cloudBrainStatus, cloudChatStream } from '../../core/llm/cloud-workbuddy.js'
import { getSettings } from '../settings-store.js'
import { getSecret, hasSecret } from '../keystore.js'
import { SECRET_KEYS } from '../../shared/protocol.js'
import { mergeRagSettings } from '../../shared/rag-protocol.js'
import {
  VectorStore,
  makeTurnChunk,
  makeFactChunk,
  makeDiaryChunk,
  makeSummaryChunk,
  contentHash,
  planEmbedding,
  shouldSummarize,
  coveredTurnIds,
  pickTurnsToSummarize,
  formatRecall,
  clipText,
  MAX_CHUNK_CHARS,
  recall as recallCore,
  EMBED_ENGINES
} from '../../core/rag/index.js'
import { RagStoreIo } from './store-io.js'
import { recordLedger } from '../ledger.js'
import {
  embedLocalStatus,
  downloadEmbedModel,
  localEmbed,
  prewarmEmbedLocal,
  resetLocalEmbedder,
  EMBED_DIM
} from './embed-local.js'
import { openaiEmbed, openaiEmbedAvailable, OPENAI_EMBED_DIM } from './embed-openai.js'

/** 待嵌队列软上限（超过就暂停入库，防止用户从不装模型时无限增长） */
const PENDING_SOFT_CAP = 5000
/** 启动后多久开始预热 + 补齐（和语音预热同一思路：别等用户开口） */
const BOOT_DELAY_MS = 8000

/* ---------------- 滚动摘要用的一次性 LLM 调用 ----------------
 * 刻意不复用 agent.js 的 callModelOnce：那边不导出，且 RagService 要被 IPC 层
 * 单独持有；这里自带一份同样的「有 key 走 key、没 key 走云端」逻辑，失败返回空串。 */

async function callLlmOnce(messages, temperature = 0.4) {
  const settings = getSettings()
  const llm = resolveLlm(settings.llm || {})
  const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
  const useCloud = llm.provider === 'workbuddy'
  const collect = async (stream) => {
    let out = ''
    for await (const evt of stream) {
      if (evt.type === 'delta') out += evt.text || ''
      else if (evt.type === 'done') break
    }
    return out.trim()
  }
  try {
    if (useCloud) {
      if (!cloudBrainStatus().ok) {
        try {
          await initCloudBrain()
        } catch {
          /* 初始化失败交给空结果 */
        }
      }
      if (!cloudBrainStatus().ok) return ''
      return await collect(await cloudChatStream({ messages }))
    }
    if (!hasKey && !isLocalLlm(llm)) return ''
    const client = createClient({ apiKey: apiKeyForLlm(llm, hasKey && !isLocalLlm(llm) ? getSecret(SECRET_KEYS.LLM_API_KEY) : null), baseURL: llm.baseURL })
    return await collect(await chatStream(client, { model: llm.model, messages, temperature }))
  } catch {
    return ''
  }
}

/* ---------------- 服务 ---------------- */

export class RagService {
  /**
   * @param {{dir:string, getSettings:Function, log?:Function}} opts
   */
  constructor({ dir, getSettings: get, log = () => {} }) {
    this.dir = dir
    this.getSettings = get
    this.log = log
    this.io = new RagStoreIo(dir)
    this.store = new VectorStore({ dim: EMBED_DIM })
    this.ready = false
    this.initError = ''
    this.dimMismatch = false
    this.lastError = ''
    this.embedding = false
    this.embedTimer = null
    this.bootTimer = null
    this.pendingCount = 0
    this.turnsSinceSummary = 0
    this.summarizing = false
    this._covered = null
  }

  get cfg() {
    return mergeRagSettings(this.getSettings().rag)
  }

  /** 启动：载库 + 定时预热/补齐。app ready 之后调用一次 */
  init() {
    if (this.ready) return this
    try {
      const emb = this._pickEmbedder()
      const { store, repaired, dimMismatch } = this.io.load(emb ? emb.dim : EMBED_DIM)
      this.store = store
      this.dimMismatch = dimMismatch
      this.ready = true
      this.pendingCount = this.io.readPending().length
      if (repaired.droppedVectorRows || repaired.droppedChunkLines || repaired.badLines) {
        this.log(
          `[rag] 检测到半截写入，已对齐修复（丢向量行 ${repaired.droppedVectorRows} / 丢 chunk 行 ${repaired.droppedChunkLines} / 坏行 ${repaired.badLines}）`
        )
      }
      if (dimMismatch) {
        this.log('[rag] 索引维度与当前引擎不符，召回暂停（设置页可一键重建）')
      } else {
        this.log(`[rag] 记忆档案就绪：${store.liveCount} 条（待嵌 ${this.pendingCount}）`)
      }
      // 预热 + backfill：应用刚起来、用户还没开口的时候把模型加载和队列补齐做掉
      this.bootTimer = setTimeout(() => {
        this.bootTimer = null
        void this._boot()
      }, BOOT_DELAY_MS)
      this.bootTimer.unref?.()
    } catch (err) {
      this.initError = err && err.message ? err.message : String(err)
      this.ready = false
      this.log(`[rag] 初始化失败（RAG 关闭）：${this.initError}`)
    }
    return this
  }

  async _boot() {
    if (!this.ready) return
    if (this.cfg.provider === 'local') {
      await prewarmEmbedLocal({ log: this.log })
    }
    await this.embedPending()
  }

  /** 挑当前可用的嵌入引擎（不可用返回 null → RAG 静默关闭） */
  _pickEmbedder() {
    const cfg = this.cfg
    if (!cfg.enabled || cfg.provider === 'none') return null
    if (cfg.provider === 'openai') {
      return openaiEmbedAvailable() ? { id: 'openai', dim: OPENAI_EMBED_DIM, embed: openaiEmbed } : null
    }
    // local
    return embedLocalStatus().ready ? { id: 'local', dim: EMBED_DIM, embed: localEmbed } : null
  }

  /* ---------------- 入库 ---------------- */

  /**
   * 一轮对话进档案。只写 pending（纯文本追加），嵌入是后台的事。
   * @returns {{ok:boolean, id?:string, dup?:boolean, reason?:string}}
   */
  ingestTurn({ user, assistant, mood = '', at = Date.now() }) {
    if (!this.ready || !this.cfg.enabled) return { ok: false, reason: 'off' }
    const chunk = makeTurnChunk({ user, assistant, mood, at })
    if (!chunk) return { ok: false, reason: 'empty' }
    return this._ingestChunk(chunk)
  }

  /** 一条精选事实进档案（与 memory.json 同步；向量层做语义去重） */
  ingestFact({ text, at = Date.now() }) {
    if (!this.ready || !this.cfg.enabled) return { ok: false, reason: 'off' }
    const chunk = makeFactChunk({ text, at })
    if (!chunk) return { ok: false, reason: 'empty' }
    return this._ingestChunk(chunk)
  }

  /** 日记原文进档案；保留「心里想」与「真的说过」的边界。 */
  ingestDiary({ text, at = Date.now(), kind = 'inner', mood = '', intensity = 0 } = {}) {
    if (!this.ready || !this.cfg.enabled) return { ok: false, reason: 'off' }
    const chunk = makeDiaryChunk({ text, at, meta: { kind, mood, intensity } })
    if (!chunk) return { ok: false, reason: 'empty' }
    return this._ingestChunk(chunk)
  }

  _ingestChunk(chunk) {
    if (this.store.hasHash(chunk.hash)) return { ok: true, dup: true }
    if (this.pendingCount >= PENDING_SOFT_CAP) {
      this.lastError = `待嵌队列已满（${PENDING_SOFT_CAP}），暂停入库；装好模型后会一起补上`
      return { ok: false, reason: 'pending-full' }
    }
    try {
      this.io.appendPending([chunk])
      this.pendingCount++
      this._covered = null
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err)
      return { ok: false, reason: this.lastError }
    }
    this.turnsSinceSummary++
    this._scheduleEmbed(1200)
    this._maybeSummarize()
    return { ok: true, id: chunk.id }
  }

  /** 忘掉一条（按 id）。墓碑落盘，compact 时才真正消失 */
  forget(id) {
    if (!this.ready) return { ok: false, error: '未就绪' }
    const chunk = this.store.chunkById(id)
    if (!chunk || chunk.tombstone) return { ok: false, error: '没有这条' }
    this.store.remove(id)
    try {
      this.io.appendTombstone(chunk, this.store.rowBytes)
      this._covered = null
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  /**
   * 忘掉一条（按内容）。原文总可以对上——但入库时会截断（fact 截 300 字），
   * 所以原文和截断后的文本都试一遍，避免「记得进去、忘不掉」。
   */
  forgetText(text) {
    const t = String(text == null ? '' : text)
    if (!t.trim()) return { ok: false, error: '空文本' }
    for (const cand of new Set([t, clipText(t, 300), clipText(t, MAX_CHUNK_CHARS)])) {
      const row = this.store.rowOfHash(contentHash(cand))
      if (row !== undefined && !this.store.isDead(row)) {
        return this.forget(this.store.chunks[row].id)
      }
    }
    return { ok: false, error: '没有这条' }
  }

  /* ---------------- 召回 ---------------- */

  /**
   * 检索与 query 相关的往事。
   * @returns {Promise<{enabled:boolean, ready:boolean, results:Array, text:string, reason?:string}>}
   *   text = 直接进提示词的段落（空串 = 与现状逐字一致）
   */
  async recall(query, opts = {}) {
    const cfg = this.cfg
    if (!this.ready || !cfg.enabled) return { enabled: false, ready: false, results: [], text: '' }
    const emb = this._pickEmbedder()
    if (!emb) {
      return { enabled: true, ready: false, results: [], text: '', reason: '嵌入引擎不可用（模型未下载或没有 Key）' }
    }
    if (this.dimMismatch || emb.dim !== this.store.dim) {
      return { enabled: true, ready: false, results: [], text: '', reason: '索引维度与当前引擎不符，请在设置页重建' }
    }
    const q = String(query == null ? '' : query).trim()
    if (!q) return { enabled: true, ready: true, results: [], text: '' }
    try {
      const prefix = (EMBED_ENGINES[emb.id] && EMBED_ENGINES[emb.id].queryPrefix) || ''
      const vec = await this._withTimeout(
        Promise.resolve(emb.embed([prefix + q])).then((vs) => vs[0]),
        cfg.recallTimeoutMs,
        '召回超时'
      )
      const results = recallCore(this.store, vec, {
        threshold: cfg.threshold,
        halfLifeDays: cfg.halfLifeDays,
        maxResults: cfg.maxResults,
        budgetChars: cfg.budgetChars,
        now: opts.now || Date.now(),
        covered: this._coveredSet()
      })
      return { enabled: true, ready: true, results, text: formatRecall(results) }
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err)
      return { enabled: true, ready: false, results: [], text: '', reason: this.lastError }
    }
  }

  _withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(msg)), ms)
        t.unref?.()
      })
    ])
  }

  /** 被摘要覆盖的轮次集合（带缓存，入库/嵌入后失效） */
  _coveredSet() {
    if (!this._covered) this._covered = coveredTurnIds(this.store)
    return this._covered
  }

  /* ---------------- 待嵌队列 ---------------- */

  _scheduleEmbed(delay = 1200) {
    if (this.embedTimer) clearTimeout(this.embedTimer)
    this.embedTimer = setTimeout(() => {
      this.embedTimer = null
      void this.embedPending()
    }, delay)
    this.embedTimer.unref?.()
  }

  /** 把 pending 里的文本嵌入进正式索引（批量 8 条，失败下轮再来） */
  async embedPending() {
    if (this.embedding || !this.ready) return { ok: false, reason: 'busy' }
    const emb = this._pickEmbedder()
    if (!emb) return { ok: false, reason: 'no-engine' }
    if (this.dimMismatch || emb.dim !== this.store.dim) return { ok: false, reason: 'dim-mismatch' }
    this.embedding = true
    try {
      const queue = this.io.readPending()
      if (!queue.length) {
        this.pendingCount = 0
        return { ok: true, embedded: 0 }
      }
      const { toEmbed, skip } = planEmbedding(queue, this.store, { maxBatch: 8 })
      const done = new Set(skip.map((x) => x.id))
      let embedded = 0
      for (const item of toEmbed) {
        try {
          const [v] = await emb.embed([item.text])
          const r = this.store.append(item, v)
          if (r.ok) {
            this.io.appendEmbedded(item, this.store.rowVector(r.row))
            embedded++
          }
          done.add(item.id) // 已在库（去重跳过）或刚入库，都算处理掉
        } catch (err) {
          // 推理失败：整批停在这一条，剩下的留轮次重试（别把文本弄丢）
          this.lastError = err && err.message ? err.message : String(err)
          this.log(`[rag] 嵌入失败（保留待重试）：${this.lastError}`)
          break
        }
      }
      const remain = queue.filter((x) => !done.has(x.id))
      this.io.rewritePending(remain)
      this.pendingCount = remain.length
      this._covered = null
      if (remain.length) this._scheduleEmbed(5000)
      return { ok: true, embedded, remain: remain.length }
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err)
      return { ok: false, error: this.lastError }
    } finally {
      this.embedding = false
    }
  }

  /* ---------------- 滚动摘要 ---------------- */

  _maybeSummarize() {
    const cfg = this.cfg
    if (this.summarizing) return
    if (!shouldSummarize({ turnsSince: this.turnsSinceSummary, every: cfg.summaryEveryTurns, enabled: cfg.autoSummary })) {
      return
    }
    this.turnsSinceSummary = 0
    void this._runSummary()
  }

  /** 把最近 20 轮压成一条摘要 chunk；原轮次不删，只是被覆盖降权 */
  async _runSummary() {
    this.summarizing = true
    try {
      const covered = this._coveredSet()
      const turns = pickTurnsToSummarize(this.store, { count: 20, covered })
      if (turns.length < 8) return { ok: false, reason: 'too-few' }
      const text = await callLlmOnce(
        [
          {
            role: 'system',
            content:
              '你在把一段对话历史压缩成摘要，供主人（他）和助手（我）日后回忆。' +
              '保留：具体事件、约定、他的状况与情绪、提到的重要人和物。丢掉：寒暄、重复、没有信息量的对话。' +
              '用第三人称（他/我），150 字以内，直接输出摘要本身。'
          },
          { role: 'user', content: turns.map((c) => c.text).join('\n') }
        ],
        0.4
      )
      if (!text) return { ok: false, reason: 'llm-empty' }
      const chunk = makeSummaryChunk({ text, covers: turns.map((c) => c.id), at: Date.now() })
      const r = this._ingestChunk(chunk)
      if (r.ok && r.id) recordLedger({ category: 'subjective', text,
        source: { type: 'rag-summary', ref: r.id }, occurredAt: chunk.at,
        certainty: 'model-summary', ragIds: [r.id], meta: { covers: turns.map((c) => c.id) } })
      if (r.ok) this.log(`[rag] 滚动摘要一条（覆盖 ${turns.length} 轮）`)
      return r
    } finally {
      this.summarizing = false
    }
  }

  /* ---------------- 维护 ---------------- */

  /** compact：清掉墓碑（用户点「整理记忆」或墓碑超 30% 时） */
  compact() {
    if (!this.ready) return { ok: false, error: '未就绪' }
    try {
      const r = this.io.compact(this.store)
      return { ok: true, skipped: r.skipped, rows: this.store.count, dead: this.store.dead.size }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  /**
   * 重建索引：换了嵌入引擎（维度变了）或向量文件损坏时用。
   * 文本全部保留（从 chunks.jsonl 读出），按当前引擎重新嵌入。
   */
  async rebuild() {
    if (!this.ready) return { ok: false, error: '未就绪' }
    const emb = this._pickEmbedder()
    if (!emb) return { ok: false, error: '当前嵌入引擎不可用（先下载模型或配置 Key）' }
    const chunks = this.store.liveChunks()
    this.store = new VectorStore({ dim: emb.dim })
    this.dimMismatch = false
    this._covered = null
    try {
      this.io.rewriteAll(this.store) // 空库落盘（向量 + chunk 行都清空）
      this.io.appendPending(chunks) // 原文本全部转去待嵌队列
      this.pendingCount = chunks.length
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
    this._scheduleEmbed(500)
    this.log(`[rag] 重建索引：${chunks.length} 条待重新嵌入（引擎 ${emb.id}，${emb.dim} 维）`)
    return { ok: true, count: chunks.length, engine: emb.id, dim: emb.dim }
  }

  /** 清空档案（设置页二次确认后才调；连同磁盘文件） */
  clear() {
    try {
      this.io.clear()
      this.store = new VectorStore({ dim: this.store.dim })
      this.pendingCount = 0
      this.turnsSinceSummary = 0
      this._covered = null
      this.dimMismatch = false
      resetLocalEmbedder()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  /* ---------------- 状态 ---------------- */

  status() {
    const cfg = this.cfg
    const emb = this._pickEmbedder()
    return {
      enabled: cfg.enabled,
      provider: cfg.provider,
      engine: emb ? emb.id : 'none',
      ready: this.ready && !!emb && !this.dimMismatch,
      hasData: this.store.liveCount > 0,
      dim: this.store.dim,
      chunks: this.store.liveCount,
      dead: this.store.dead.size,
      pending: this.pendingCount,
      disk: this.io.diskUsage(),
      dimMismatch: this.dimMismatch,
      turnsSinceSummary: this.turnsSinceSummary,
      lastError: this.lastError,
      initError: this.initError,
      model: embedLocalStatus(),
      settings: cfg
    }
  }

  /** 设置页「测一下召回」：直接跑一遍，返回结果供展示 */
  async recallTest(query) {
    const r = await this.recall(query)
    return {
      ok: r.ready,
      reason: r.reason || '',
      count: r.results.length,
      results: r.results.map((x) => ({ id: x.id, kind: x.kind, score: Number(x.score.toFixed(4)), sim: Number(x.sim.toFixed(4)), label: x.label, text: x.text })),
      text: r.text
    }
  }

  dispose() {
    if (this.embedTimer) clearTimeout(this.embedTimer)
    if (this.bootTimer) clearTimeout(this.bootTimer)
    this.embedTimer = null
    this.bootTimer = null
  }
}

/* ---------------- 单例 ---------------- */

let singleton = null

/** 懒构造（要用 userData 路径，app ready 之后才安全） */
export function getRag() {
  if (!singleton) {
    singleton = new RagService({
      dir: join(app.getPath('userData'), 'rag'),
      getSettings,
      log: (m) => console.log(m)
    })
  }
  return singleton
}

/** 主进程启动时调用一次 */
export function initRag() {
  return getRag().init()
}
