// src/core/voice/wav.js
// PCM ↔ WAV：渲染层用 Web Audio 采到的是 Float32 PCM，而系统识别引擎只吃 16-bit PCM WAV，
// 中间的编码/重采样/静音裁剪全在这里做——纯函数，可单测，不碰任何浏览器/Node API。
//
// 纯逻辑，无 Electron / Node 依赖，可 node --test。

/** 16-bit PCM WAV 的头长度 */
export const WAV_HEADER_BYTES = 44
/** 系统识别引擎最稳的采样率（SAPI 对 16k/22.05k 单声道支持最好） */
export const ASR_SAMPLE_RATE = 16000

/** 一组采样的均方根（0~1）：用来判断「这段是不是静音」 */
export function rms(samples) {
  const n = samples ? samples.length : 0
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = samples[i]
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** 峰值绝对值（0~1） */
export function peak(samples) {
  let m = 0
  const n = samples ? samples.length : 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i])
    if (a > m) m = a
  }
  return m
}

/** PCM 采样数 → 毫秒 */
export function pcmDurationMs(length, sampleRate) {
  if (!(sampleRate > 0)) return 0
  return Math.round(((length || 0) / sampleRate) * 1000)
}

/**
 * 线性插值重采样。识别引擎只认固定采样率，浏览器的 AudioContext 常给 44.1k/48k。
 * @param {Float32Array|number[]} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(samples, fromRate, toRate) {
  const n = samples ? samples.length : 0
  if (!n || !(fromRate > 0) || !(toRate > 0) || fromRate === toRate) {
    return samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
  }
  const ratio = fromRate / toRate
  const outLen = Math.max(1, Math.floor(n / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(n - 1, i0 + 1)
    const frac = src - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

/**
 * 掐掉首尾静音（很朴素的能量法，不追求 VAD 的准确率，够用即可）。
 * 中间不裁——说话中的自然停顿不该被剪掉。
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @param {{threshold?:number, padMs?:number}} [opts]
 * @returns {Float32Array}
 */
export function trimSilence(samples, sampleRate, opts = {}) {
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
  const threshold = opts.threshold ?? 0.012
  const padMs = opts.padMs ?? 120
  const n = src.length
  if (!n) return src

  const win = Math.max(1, Math.round(sampleRate * 0.02)) // 20ms 一窗
  const loud = (from, to) => {
    let s = 0
    let c = 0
    for (let i = from; i < to && i < n; i++) {
      s += src[i] * src[i]
      c++
    }
    return c ? Math.sqrt(s / c) >= threshold : false
  }

  let start = 0
  while (start < n && !loud(start, start + win)) start += win
  let end = n
  while (end > start && !loud(end - win, end)) end -= win
  if (start >= end) return new Float32Array(0) // 整段都是静音

  const pad = Math.round((padMs / 1000) * sampleRate)
  start = Math.max(0, start - pad)
  end = Math.min(n, end + pad)
  return src.subarray(start, end)
}

/**
 * 16-bit 小端 PCM 字节 → Float32 采样（[-1,1]）。
 * @param {Uint8Array|Buffer} bytes
 * @returns {Float32Array}
 */
export function pcmToFloat32(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const n = Math.floor(b.length / 2)
  const out = new Float32Array(n)
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true)
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff
  }
  return out
}

/**
 * 把任意采样率的 16-bit PCM WAV 转成 16k 单声道 WAV（识别引擎的统一输入格式）。
 * @param {Uint8Array|Buffer} wavBytes
 * @param {number} [targetRate]
 * @returns {{bytes:Uint8Array, sampleRate:number}|null}
 */
export function toAsrWav(wavBytes, targetRate = ASR_SAMPLE_RATE) {
  const parsed = extractPcm(wavBytes)
  if (!parsed || !parsed.pcm.length || parsed.bitsPerSample !== 16) return null
  const src = pcmToFloat32(parsed.pcm)
  // 多声道只取第一声道
  const mono =
    parsed.channels > 1
      ? (() => {
          const frames = Math.floor(src.length / parsed.channels)
          const out = new Float32Array(frames)
          for (let i = 0; i < frames; i++) out[i] = src[i * parsed.channels]
          return out
        })()
      : src
  const resampled = resample(mono, parsed.sampleRate || targetRate, targetRate)
  return { bytes: encodeWav(resampled, targetRate), sampleRate: targetRate }
}

/**
 * Float32 PCM（[-1,1]）→ 16-bit 单声道 WAV。
 * @param {Float32Array|number[]} samples
 * @param {number} [sampleRate]
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate = ASR_SAMPLE_RATE) {
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples || [])
  const n = src.length
  const bytes = WAV_HEADER_BYTES + n * 2
  const buf = new ArrayBuffer(bytes)
  const view = new DataView(buf)

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, bytes - 8, true) // 除 'RIFF' + size 外的总长
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM 子块大小
  view.setUint16(20, 1, true) // 格式=1（PCM）
  view.setUint16(22, 1, true) // 声道=1（单声道）
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // 字节率 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  writeStr(36, 'data')
  view.setUint32(40, n * 2, true)

  let off = WAV_HEADER_BYTES
  for (let i = 0; i < n; i++) {
    let v = src[i]
    v = v < -1 ? -1 : v > 1 ? 1 : v
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    off += 2
  }
  return new Uint8Array(buf)
}

/** 从 WAV 字节里读关键信息（校验/测试用） */
export function readWavHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b.length < WAV_HEADER_BYTES) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const str = (off, len) => {
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i))
    return s
  }
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)
  const dataBytes = view.getUint32(40, true)
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    frames: channels ? Math.round(dataBytes / (channels * (bitsPerSample / 8))) : 0
  }
}

/**
 * 剥掉 WAV 头，取出裸 PCM 数据（离线识别引擎只吃裸 PCM）。
 * 按块遍历而不是硬编码 44 —— 有些编码器会在 fmt 与 data 之间塞额外块。
 * @param {Uint8Array|Buffer} bytes
 * @returns {{pcm:Uint8Array, sampleRate:number, channels:number, bitsPerSample:number}|null}
 */
export function extractPcm(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b.length < 12) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const str = (off, len) => {
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i))
    return s
  }
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null

  let sampleRate = 0
  let channels = 1
  let bitsPerSample = 16
  let off = 12
  while (off + 8 <= b.length) {
    const id = str(off, 4)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ' && body + 16 <= b.length) {
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      const end = Math.min(b.length, body + size)
      return { pcm: b.subarray(body, end), sampleRate, channels, bitsPerSample }
    }
    off = body + size + (size % 2) // 块按偶数字节对齐
  }
  return null
}
