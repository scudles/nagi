// src/main/voice/edge.js
// edge-tts 适配器：微软 Edge「朗读」用的神经音色，免密钥、音质好。
//
// ⚠ 两个必须记住的点（都实测踩过）：
//   ① 端点已迁移：老的 wss://speech.platform.bing.com/... 现在一律 403，
//      必须用 wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1；
//   ② 握手要签名：Sec-MS-GEC = SHA256(窗口化Windows时间戳 + TrustedClientToken) 大写十六进制，
//      外加 Sec-MS-GEC-Version。少一个就是 403。
//
// 它是「非官方接口」，微软随时可能改——所以调用方必须准备好回退到本机 SAPI（见 index.js）。
// 复用项目已有的 ws 依赖（智能家居 WebSocket 也用它），不新增任何包。

import WebSocket from 'ws'
import { createHash, randomUUID } from 'node:crypto'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'
/** 与真实 Edge 版本对齐；微软会校验这个字段的形态 */
const GEC_VERSION = '1-143.0.3650.96'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
/** 24kHz 48kbps 单声道 MP3：体积小、渲染层 <audio> 直接能放 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/**
 * Sec-MS-GEC 签名。
 * ticks = floor(now/1000) + 11644473600（Windows FILETIME 纪元偏移），按 5 分钟窗口取整，
 * 再乘 1e7 变成 100ns 单位，拼上 TrustedClientToken 做 SHA-256。
 * @param {number} [nowMs]
 * @param {string} [token]
 * @returns {string} 大写十六进制
 */
export function secMsGec(nowMs = Date.now(), token = TRUSTED_CLIENT_TOKEN) {
  const ticks = Math.floor(nowMs / 1000) + 11644473600
  const rounded = ticks - (ticks % 300)
  const windowsTicks = rounded * 10000000
  return createHash('sha256').update(`${windowsTicks}${token}`, 'ascii').digest('hex').toUpperCase()
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const clampPct = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))

/** 组装 SSML（rate/pitch 用百分比，volume 用百分比） */
export function buildSsml({ text, voice = EDGE_DEFAULT_VOICE, rate = 0, pitch = 0, volume = 100 } = {}) {
  const r = clampPct(rate, -50, 50)
  const p = clampPct(pitch, -50, 50)
  const v = clampPct(volume, 0, 100)
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${voice}'><prosody rate='${r}%' pitch='${p}%' volume='${v}%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  )
}

function configMessage() {
  return (
    `X-Timestamp:${new Date().toString()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: OUTPUT_FORMAT
          }
        }
      }
    })
  )
}

function ssmlMessage(requestId, ssml) {
  return (
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`
  )
}

/** 从二进制帧里剥出音频负载：前 2 字节是大端头长度，之后是文本头，再之后是音频 */
function audioPayload(frame) {
  if (!frame || frame.length < 2) return null
  const headerLen = frame.readUInt16BE(0)
  const header = frame.subarray(2, 2 + headerLen).toString('latin1')
  if (!header.includes('Path:audio')) return null
  return frame.subarray(2 + headerLen)
}

/**
 * 合成一段文本（一次性拿到完整音频）。
 * 句子级调用：调用方先分句，再逐句合成 → 首句一好就能开口，不必等整段。
 *
 * @param {{text:string, voice?:string, rate?:number, pitch?:number, volume?:number}} opts
 * @param {{timeoutMs?:number, log?:Function, onFirstChunk?:Function}} [ctx]
 * @returns {Promise<{ok:boolean, bytes?:Buffer, format?:string, error?:string, firstChunkMs?:number}>}
 */
export function edgeSpeakOnce(opts = {}, ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? 20000
  const log = ctx.log
  const text = String(opts.text || '').trim()

  return new Promise((resolve) => {
    if (!text) return resolve({ ok: false, error: '空文本' })

    const voice = opts.voice || EDGE_DEFAULT_VOICE
    const gec = secMsGec()
    const requestId = randomUUID().replace(/-/g, '')
    const url =
      `${WSS_URL}?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${requestId}`

    let ws
    try {
      ws = new WebSocket(url, { headers: { Origin: ORIGIN, 'User-Agent': USER_AGENT } })
    } catch (err) {
      return resolve({ ok: false, error: 'edge-tts 连接失败：' + err.message })
    }

    const chunks = []
    let settled = false
    const startedAt = Date.now()
    let firstChunkMs = null

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch{ /* B8:degrade — ws 已关闭或不存在 */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, error: 'edge-tts 超时' }), timeoutMs)
    timer.unref?.()

    ws.on('open', () => {
      try {
        ws.send(configMessage())
        ws.send(ssmlMessage(requestId, buildSsml({ text, voice, rate: opts.rate, pitch: opts.pitch, volume: opts.volume })))
      } catch (err) {
        finish({ ok: false, error: 'edge-tts 发送失败：' + err.message })
      }
    })

    ws.on('unexpected-response', (_req, res) => {
      finish({ ok: false, error: 'edge-tts 握手被拒 HTTP ' + res.statusCode + '（接口可能已变更）' })
      try {
        res.destroy()
      } catch{ /* B8:degrade — 销毁已失败的请求 */ }
    })

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) {
          const bytes = Buffer.concat(chunks)
          finish(
            bytes.length
              ? { ok: true, bytes, format: 'audio/mpeg', firstChunkMs }
              : { ok: false, error: 'edge-tts 返回空音频' }
          )
        }
        return
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const payload = audioPayload(frame)
      if (!payload || !payload.length) return
      if (firstChunkMs == null) {
        firstChunkMs = Date.now() - startedAt
        ctx.onFirstChunk?.(firstChunkMs)
      }
      chunks.push(payload)
    })

    ws.on('error', (err) => {
      if (log) log('[voice] edge-tts 出错：' + (err.code || err.message))
      finish({ ok: false, error: 'edge-tts 连接错误：' + (err.code || err.message) })
    })

    ws.on('close', () => finish({ ok: false, error: 'edge-tts 提前关闭' }))
  })
}
