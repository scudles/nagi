// src/core/voice/sherpa-frame.js
// sherpa-onnx 离线 WebSocket 服务的线协议（纯逻辑，可单测）。
//
// 这是本轮唯一一个「看文档才没踩死」的地方，所以单独抽出来锁住。
// 官方 offline-websocket-server-impl.h 里的协议注释：
//   客户端发二进制流，**首条消息至少 8 字节**：
//     前 4 字节 little-endian int32 = 采样率
//     次 4 字节 little-endian int32 = 后续样本的**总字节数**（不是样本个数！）
//     其余字节 = 音频样本，每个样本是 **float32**，归一化到 [-1, 1]
//   服务端收齐后解码，**回一条文本消息**（JSON，取 .text）；客户端再发 "Done" 结束。
//
// 踩过的坑：直接发 WAV 原始字节（带 RIFF 头、16-bit PCM）会被服务端立刻以 1006 关闭——
// 它既不认 RIFF 头，也不认 16-bit，只认「8 字节头 + float32 裸样本」。

import { ASR_SAMPLE_RATE } from './wav.js'

/** 服务端要的采样率（Paraformer 中文模型固定 16k） */
export const SHERPA_SAMPLE_RATE = ASR_SAMPLE_RATE

/** 线协议头的字节数：采样率(4) + 样本字节数(4) */
export const SHERPA_HEADER_BYTES = 8

/** 结束标记：客户端发完所有音频后要发的文本消息 */
export const SHERPA_DONE = 'Done'

/**
 * 把 float32 归一化样本打成 sherpa WS 服务端要的一帧。
 * @param {Float32Array|number[]} samples 归一化到 [-1,1] 的样本
 * @param {number} [sampleRate]
 * @returns {Uint8Array} 8 字节头 + float32 小端样本
 */
export function buildSherpaFrame(samples, sampleRate = SHERPA_SAMPLE_RATE) {
  const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
  const out = new Uint8Array(SHERPA_HEADER_BYTES + f32.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setInt32(0, Math.round(sampleRate) || SHERPA_SAMPLE_RATE, true)
  view.setInt32(4, f32.byteLength, true)
  out.set(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength), SHERPA_HEADER_BYTES)
  return out
}

/**
 * 读回一帧的头部（测试与诊断用）。
 * @param {Uint8Array|ArrayBuffer} frame
 * @returns {{sampleRate:number, byteSize:number}|null}
 */
export function readSherpaHeader(frame) {
  const b = frame instanceof Uint8Array ? frame : new Uint8Array(frame || 0)
  if (b.length < SHERPA_HEADER_BYTES) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { sampleRate: view.getInt32(0, true), byteSize: view.getInt32(4, true) }
}

/**
 * 解析服务端回的文本消息。
 * 正常是 {"text": "...", "tokens": [...], ...}；解析不了就把它当纯文本（容错）。
 * @param {string|Uint8Array|Buffer} raw
 * @returns {{text:string, json:object|null}}
 */
export function parseSherpaReply(raw) {
  const s = typeof raw === 'string' ? raw : String(raw ?? '')
  let json = null
  try {
    const j = JSON.parse(s)
    if (j && typeof j === 'object') json = j
  } catch {
    json = null
  }
  const text = json ? String(json.text ?? '') : s
  // 服务端偶尔会在正文里塞引号/空行，统一收一收
  return { text: text.replace(/\s+/g, ' ').trim(), json }
}
