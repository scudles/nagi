// src/main/rag/embed-local.js
// 本地嵌入适配器：onnxruntime-web（纯 WASM，零原生编译）+ 自研 BERT WordPiece
// 分词器（core/rag/wordpiece.js）+ bge-small-zh-v1.5 量化 ONNX（约 25MB，hf-mirror 下载）。
//
// 这条链路的每一个选择都为了绕开「原生模块」：
//   · onnxruntime-web 而不是 onnxruntime-node / @huggingface/transformers——
//     后两者分别拖原生 ABI 与 sharp，正是 Vosk/ffi-napi 给我们上过课的坑；
//   · 分词器自己写——@huggingface/tokenizers 现存版本是纯 JS 重写版（无 fromFile、
//     覆盖度存疑），BERT 分词是 150 行规则确定的代码；
//   · 模型文件运行时下载（同 sherpa 的 curl 优先双源回退），不进 asar。
//
// 铁律：任何一步失败（没下载 / wasm 起不来 / 模型损坏）都只让「本地嵌入」不可用，
// RAG 静默关闭——绝不拖垮主流程。加载结果按 60s 缓存，避免每次召回重试慢路径。

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { downloadSmart } from '../download.js'
import { WordPieceTokenizer } from '../../core/rag/wordpiece.js'

/** 模型仓库（Xenova 的 ONNX 导出；官方 BAAI 仓库只有 safetensors） */
export const EMBED_MODEL_ID = 'Xenova/bge-small-zh-v1.5'
/** 向量维度（bge-small-zh-v1.5 = 512） */
export const EMBED_DIM = 512
/** 单句最大 token 数（BERT 上限 512；超长截断） */
export const EMBED_MAX_TOKENS = 512

/** 下载源：hf-mirror 国内快，huggingface 兜底 */
const MODEL_BASES = [`https://hf-mirror.com/${EMBED_MODEL_ID}/resolve/main`, `https://huggingface.co/${EMBED_MODEL_ID}/resolve/main`]

/** 要下的文件（标称大小只作进度兜底，不做强校验——真校验是「能不能加载」） */
const MODEL_FILES = [
  { path: 'onnx/model_quantized.onnx', label: '量化模型', approx: 24010842 },
  { path: 'tokenizer.json', label: '分词器', approx: 439125 }
]

/** 模型目录：userData/rag/model */
export function embedLocalDir() {
  return join(app.getPath('userData'), 'rag', 'model')
}

function modelFile(rel) {
  return join(embedLocalDir(), ...rel.split('/'))
}

/**
 * 本地嵌入现状（设置页状态卡 + 服务挑选引擎用）。
 * @returns {{ready:boolean, dir:string, model:string, dim:number, files:Array, error:string}}
 */
export function embedLocalStatus() {
  const dir = embedLocalDir()
  const files = MODEL_FILES.map((f) => {
    let bytes = 0
    try {
      bytes = existsSync(modelFile(f.path)) ? readFileSync(modelFile(f.path)).length : 0
    } catch {
      bytes = 0
    }
    return { path: f.path, label: f.label, present: bytes > 1024, bytes }
  })
  const ready = files.every((f) => f.present)
  return {
    ready,
    dir,
    model: EMBED_MODEL_ID,
    dim: EMBED_DIM,
    files,
    error: ready ? '' : '模型未下载完整（设置页可一键下载，约 25MB）'
  }
}

/**
 * 下载模型（两个文件，多源回退，进度经 onProgress 回调）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function downloadEmbedModel(opts = {}) {
  const dir = embedLocalDir()
  mkdirSync(dir, { recursive: true })
  for (const f of MODEL_FILES) {
    const dest = modelFile(f.path)
    let bytes = 0
    try {
      bytes = existsSync(dest) ? readFileSync(dest).length : 0
    } catch {
      bytes = 0
    }
    if (bytes > 1024) continue // 已有就跳过（断点由 curl 管）
    mkdirSync(dirname(dest), { recursive: true })
    let lastError = ''
    let got = false
    for (const base of MODEL_BASES) {
      const r = await downloadSmart(`${base}/${f.path}`, dest, {
        ...opts,
        expectBytes: f.approx,
        onProgress: (p) => opts.onProgress?.({ file: f.path, ...p })
      })
      if (r.ok) {
        got = true
        break
      }
      lastError = r.error
    }
    if (!got) {
      try {
        rmSync(dest, { force: true }) // 半截文件别留着，否则下次误判「已存在」
      } catch{ /* B8:degrade — 半截文件删不掉，下次有校验兜住 */ }
      return { ok: false, error: `${f.label}下载失败：${lastError}` }
    }
  }
  // 下载完成后立刻试加载一次：文件齐了不代表能推理（损坏/版本不匹配）
  resetLocalEmbedder()
  try {
    await loadSession()
  } catch (err) {
    return { ok: false, error: '模型已下载但加载失败：' + (err && err.message ? err.message : String(err)) }
  }
  return { ok: true }
}

/* ---------------- WASM 推理链（单例缓存） ---------------- */

let ortPromise = null
let tokenizerPromise = null
let sessionPromise = null
let loadFailedAt = 0 // 加载失败后的冷静期，避免每次召回都重试慢路径

const RETRY_GAP_MS = 60000

function loadFailed() {
  return loadFailedAt > 0 && Date.now() - loadFailedAt < RETRY_GAP_MS
}

/** 清空缓存（下载完成 / 手动重试时调用） */
export function resetLocalEmbedder() {
  ortPromise = null
  tokenizerPromise = null
  sessionPromise = null
  loadFailedAt = 0
}

/**
 * 加载 onnxruntime-web。两个本机实测要点：
 *   ① wasmPaths 必须是 file:// URL——Windows 下传裸路径会被当成协议名（protocol 'e:'）报错；
 *   ② 单线程：主进程里没有 Worker 池，多线程 wasm 反而拖慢启动。
 */
async function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      let mod = null
      try {
        mod = await import('onnxruntime-web')
      } catch {
        mod = null
      }
      if (!mod) {
        const { createRequire } = await import('node:module')
        const require = createRequire(import.meta.url)
        mod = require('onnxruntime-web')
      }
      const ort = mod.default || mod
      const distDir = join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist')
      if (existsSync(distDir)) {
        ort.env.wasm.wasmPaths = pathToFileURL(distDir + '/').href
      }
      ort.env.wasm.numThreads = 1
      ort.env.logLevel = 'error'
      return ort
    })()
  }
  return ortPromise
}

async function loadTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const file = modelFile('tokenizer.json')
      const json = JSON.parse(readFileSync(file, 'utf8'))
      return WordPieceTokenizer.fromJSON(json)
    })()
  }
  return tokenizerPromise
}

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt()
      const bytes = new Uint8Array(readFileSync(modelFile('onnx/model_quantized.onnx')))
      return ort.InferenceSession.create(bytes)
    })()
  }
  return sessionPromise
}

/**
 * 嵌入一段文本 → 512 维 Float32（CLS pooling + L2 归一化）。
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function localEmbedOne(text) {
  if (loadFailed()) throw new Error('本地嵌入加载失败冷静期中')
  try {
    const [tok, session, ort] = await Promise.all([loadTokenizer(), loadSession(), loadOrt()])
    const enc = tok.encode(String(text || ''), { maxLength: EMBED_MAX_TOKENS })
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(enc.ids, BigInt), [1, enc.ids.length]),
      token_type_ids: new ort.Tensor('int64', BigInt64Array.from(enc.typeIds, BigInt), [1, enc.typeIds.length]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(enc.attentionMask, BigInt), [
        1,
        enc.attentionMask.length
      ])
    }
    const out = await session.run(feeds)
    const hidden = out.last_hidden_state || out[session.outputNames[0]]
    const dim = hidden.dims[2]
    const cls = Float32Array.from(hidden.data.subarray(0, dim)) // CLS pooling：取 [CLS] 位
    const n = Math.sqrt(cls.reduce((s, x) => s + x * x, 0))
    if (n > 0) for (let i = 0; i < cls.length; i++) cls[i] /= n
    return cls
  } catch (err) {
    loadFailedAt = Date.now()
    sessionPromise = null
    throw err
  }
}

/**
 * 批量嵌入（逐条跑：batch=1 在 WASM 里最快，且长文本互不阻塞）。
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function localEmbed(texts = []) {
  const out = []
  for (const t of texts) out.push(await localEmbedOne(t))
  return out
}

/** 后台预热：模型加载约 0.3–1s，应用启动后先把这事做了，别等用户开口 */
export async function prewarmEmbedLocal({ log = () => {} } = {}) {
  if (!embedLocalStatus().ready) return false
  try {
    const t0 = Date.now()
    await Promise.all([loadTokenizer(), loadSession()])
    log(`[rag] 本地嵌入已预热（${Date.now() - t0}ms）`)
    return true
  } catch (err) {
    loadFailedAt = Date.now()
    sessionPromise = null
    log(`[rag] 本地嵌入预热失败（RAG 将静默关闭）：${err && err.message}`)
    return false
  }
}
