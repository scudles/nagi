// src/main/voice/index.js
// 语音编排：把「纯逻辑（分句 / 口型 / 引擎表）」与「适配器（edge-tts / 本机 SAPI）」装配起来。
//
// 两个设计决定：
//   ① 按句取用（pull）：调用方先 startSpeech(text) 拿到「这次要念几句」，
//      再逐句 pullUtterance(sessionId, i)。于是渲染层可以「念第 1 句的同时预取第 2 句」，
//      首响 = 首句合成时间；也让打断变得简单（本机丢弃 session 即可）。
//   ② 引擎熔断 + 降级：edge-tts 是非官方接口，失败是常态而不是异常。
//      连续失败就把它短暂摘掉，改走本机 SAPI —— 她不会因为接口抽风而变成哑巴。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from '../settings-store.js'
import { presenceHooks } from '../presence-hooks.js'
import { getPresenceSnapshot } from '../presence.js'
export { registerVoiceParamsProvider } from '../presence-hooks.js'
import { toSpeechText, splitSentences, TTS_ENGINES, ASR_ENGINES, NAGI_VOICE, mergeVoiceParams, pickEngine } from '../../core/voice/index.js'
import { edgeSpeakOnce, EDGE_DEFAULT_VOICE } from './edge.js'
import { sapiSpeak, sapiRecognize, listSapiVoices, listRecognizers, sapiAsrAvailable } from './sapi.js'
import { recognizeWithSherpa, sherpaStatus, sherpaServerState, stopSherpaServer, prewarmSherpa } from './sherpa.js'

const IS_WINDOWS = process.platform === 'win32'
/** 会话保留时长：念完/被打断后留一会儿再回收，避免预取的请求落空 */
const SESSION_TTL_MS = 5 * 60 * 1000
/** 连续失败几次就把该引擎摘掉 */
const BREAK_AFTER_FAILS = 2
/** 摘掉多久（超时自动复位，让接口恢复后能自己回来） */
const BREAK_MS = 90 * 1000

const sessions = new Map()
/** 引擎健康度（熔断器） */
const health = {
  edge: { fails: 0, downUntil: 0, lastError: '' }
}

let log = (...a) => console.log(...a)
export function setVoiceLogger(fn) {
  if (typeof fn === 'function') log = fn
}

/* ---------------- 引擎可用性 ---------------- */

function edgeUsable() {
  const h = health.edge
  if (h.downUntil && Date.now() < h.downUntil) return false
  return true
}

function markEngineFail(id, error) {
  const h = health[id]
  if (!h) return
  h.fails++
  h.lastError = error || ''
  if (h.fails >= BREAK_AFTER_FAILS) {
    h.downUntil = Date.now() + BREAK_MS
    h.fails = 0
    log(`[voice] ${id} 连续失败，暂时摘掉 ${Math.round(BREAK_MS / 1000)}s：${h.lastError}`)
  }
}

function markEngineOk(id) {
  const h = health[id]
  if (!h) return
  h.fails = 0
  h.downUntil = 0
}

/** 当前设置里的语音配置（带默认值兜底） */
export function voiceConfig() {
  const s = getSettings() || {}
  const v = s.voice || {}
  return {
    ttsEnabled: v.ttsEnabled !== false,
    ttsEngine: v.ttsEngine || 'edge',
    voiceByEngine: v.voiceByEngine || {},
    rate: Number.isFinite(v.rate) ? v.rate : 0, // 在凪基准声线上的额外偏移（%）
    volume: Number.isFinite(v.volume) ? v.volume : 100,
    speakOnReply: v.speakOnReply !== false, // 她回复完自动开口
    speakOnProactive: v.speakOnProactive !== false, // 主动搭话 / 日程提醒也念
    asrEngine: v.asrEngine || 'sherpa',
    asrCulture: v.asrCulture || 'zh-CN'
  }
}

/** 某引擎该用的音色 */
function voiceFor(engine, cfg) {
  const wanted = cfg.voiceByEngine?.[engine]
  if (wanted) return wanted
  if (engine === 'edge') return NAGI_VOICE.edge.voice || EDGE_DEFAULT_VOICE
  if (engine === 'sapi') return NAGI_VOICE.sapi.voice || ''
  return (NAGI_VOICE[engine] || {}).voice || ''
}

/** 把「凪基准 + 情绪微调 + 用户偏移」合成该引擎能吃的参数 */
function paramsFor(engine, mood, cfg) {
  const base = { ...(NAGI_VOICE[engine] || {}), rate: (NAGI_VOICE[engine]?.rate || 0) + cfg.rate, volume: cfg.volume }
  const merged = mergeVoiceParams(base, mood)
  if (engine === 'sapi') {
    // SAPI 的 Rate 是 -10..10，百分比按 /10 折算
    return { rate: Math.max(-10, Math.min(10, Math.round(merged.rate / 10))), volume: merged.volume }
  }
  return { rate: merged.rate, pitch: merged.pitch, volume: merged.volume }
}

/* ---------------- TTS ---------------- */

/**
 * 开一次朗读会话。
 * @param {string} text 原始回复（会自动清洗成朗读文本）
 * @param {{mood?:string, engine?:string}} [opts]
 * @returns {{ok:boolean, sessionId?:string, total?:number, engine?:string, error?:string, sentences?:string[]}}
 */
export function startSpeech(text, opts = {}) {
  const cfg = voiceConfig()
  const clean = toSpeechText(text)
  const sentences = splitSentences(clean).map((s) => s.trim()).filter(Boolean)
  if (!sentences.length) return { ok: false, error: '没有可朗读的内容' }

  reapSessions()
  const id = randomUUID().slice(0, 8)
  const preferred = opts.engine || cfg.ttsEngine
  const engine = pickEngine('tts', preferred, { edge: edgeUsable(), sapi: IS_WINDOWS, cloud: false, gptsovits: false })
  if (!engine) return { ok: false, error: '没有可用的语音引擎' }

  sessions.set(id, {
    id,
    sentences,
    cache: new Map(),
    engine,
    mood: opts.mood || 'calm',
    intensity: opts.intensity, toneTag: opts.toneTag,
    cfg,
    createdAt: Date.now(),
    usedAt: Date.now()
  })
  return { ok: true, sessionId: id, total: sentences.length, engine, sentences }
}

/** 回收过期会话 */
function reapSessions() {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.usedAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

/** 真正合成一句（含引擎降级） */
async function synthesizeSentence(sentence, session) {
  const cfg = session.cfg
  const chain = [session.engine, ...['edge', 'sapi']].filter((v, i, a) => a.indexOf(v) === i)
  let lastError = ''

  for (const engine of chain) {
    if (engine === 'edge' && !edgeUsable()) continue
    if (engine === 'sapi' && !IS_WINDOWS) continue
    if (engine !== 'edge' && engine !== 'sapi') continue

    let params = paramsFor(engine, session.mood, cfg)
    let voice = voiceFor(engine, cfg)
    if (!session.explicitParams && getSettings().presence?.voiceProfileEnabled === true) {
      const snapshot = getPresenceSnapshot()
      const supplied = presenceHooks.resolveVoiceParams({emotion:session.mood,
        intensity:Number.isFinite(session.intensity)?session.intensity:(snapshot?.mood?.intensity||0),
        rhythm:snapshot?.rhythm||null,toneTag:session.toneTag||null,engine})
      if (supplied) {
        voice = supplied.voice || voice
        params = {rate:engine==='sapi'?Math.round(supplied.rate/10):supplied.rate,pitch:supplied.pitch,volume:supplied.volume}
      }
    }

    let r
    if (engine === 'edge') {
      r = await edgeSpeakOnce({ text: sentence, voice, ...params }, { log })
    } else {
      r = await sapiSpeak({ text: sentence, voice, rate: params.rate, volume: params.volume }, { log })
    }

    if (r.ok) {
      markEngineOk(engine)
      return { ok: true, bytes: r.bytes, format: r.format || TTS_ENGINES[engine].format, engine }
    }
    lastError = r.error || ''
    if (engine === 'edge') markEngineFail('edge', lastError)
  }
  return { ok: false, error: lastError || '语音合成失败' }
}

/**
 * 取第 index 句的音频。
 * @param {string} sessionId
 * @param {number} index
 * @returns {Promise<{ok:boolean, done?:boolean, bytes?:Buffer, format?:string, engine?:string, index?:number, total?:number, error?:string}>}
 */
export async function pullUtterance(sessionId, index = 0) {
  const s = sessions.get(sessionId)
  if (!s) return { ok: false, error: '朗读会话不存在或已过期' }
  s.usedAt = Date.now()
  const i = Math.max(0, Math.floor(Number(index) || 0))
  if (i >= s.sentences.length) return { ok: true, done: true, total: s.sentences.length, index: i }

  const cached = s.cache.get(i)
  if (cached) return { ok: true, ...cached, index: i, total: s.sentences.length }

  const r = await synthesizeSentence(s.sentences[i], s)
  if (!r.ok) return { ok: false, error: r.error, index: i, total: s.sentences.length }
  s.cache.set(i, r)
  return { ok: true, ...r, index: i, total: s.sentences.length }
}

/** 丢弃一次朗读会话（打断） */
export function dropSpeech(sessionId) {
  if (!sessionId) {
    sessions.clear()
    return true
  }
  return sessions.delete(sessionId)
}

/**
 * 顺序念完整段（无头自测 / 不需要流式的场景用）。
 * @returns {Promise<{ok:boolean, count:number, engines:string[], bytesTotal:number, error?:string}>}
 */
export async function speakAll(text, opts = {}) {
  const started = startSpeech(text, opts)
  if (!started.ok) return { ok: false, count: 0, engines: [], bytesTotal: 0, error: started.error }
  const engines = []
  let bytesTotal = 0
  try {
    for (let i = 0; i < started.total; i++) {
      const u = await pullUtterance(started.sessionId, i)
      if (!u.ok) return { ok: false, count: i, engines, bytesTotal, error: u.error }
      bytesTotal += u.bytes ? u.bytes.length : 0
      if (u.engine && !engines.includes(u.engine)) engines.push(u.engine)
    }
    return { ok: true, count: started.total, engines, bytesTotal }
  } finally {
    dropSpeech(started.sessionId)
  }
}

/**
 * 一次性合成整段文本（**不切句**）。设置页「试听」用。
 * 试听要的是「这段文本整体听起来什么样」，切成多句反而听不完整；
 * 顺带还能在**保存设置之前**用传入的音色/语速听效果。
 *
 * @param {string} text
 * @param {{engine?:string, mood?:string, rate?:number, volume?:number, voice?:string}} [opts]
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, format?:string, engine?:string, durationMs?:number, error?:string}>}
 */
export async function synthesizeOnce(text, opts = {}) {
  const base = voiceConfig()
  const clean = toSpeechText(text)
  if (!clean) return { ok: false, error: '没有可朗读的内容' }

  const engine = pickEngine('tts', opts.engine || base.ttsEngine, {
    edge: edgeUsable(),
    sapi: IS_WINDOWS,
    cloud: false,
    gptsovits: false
  })
  if (!engine) return { ok: false, error: '没有可用的语音引擎' }

  // 用传入参数覆盖配置：试听时还没保存设置，但用户就想听当前选择的效果
  const cfg = {
    ...base,
    rate: Number.isFinite(opts.rate) ? opts.rate : base.rate,
    volume: Number.isFinite(opts.volume) ? opts.volume : base.volume,
    voiceByEngine: opts.voice ? { ...base.voiceByEngine, [engine]: opts.voice } : base.voiceByEngine
  }
  return synthesizeSentence(clean, { engine, mood: opts.mood || 'calm', cfg, intensity:opts.intensity,toneTag:opts.toneTag,
    explicitParams:['voice','rate','volume'].some(key=>opts[key]!==undefined) })
}

/* ---------------- ASR ---------------- */
/**
 * 转写一段 16-bit PCM WAV。
 * @param {Buffer|Uint8Array} wavBytes
 * @param {{engine?:string, culture?:string}} [opts]
 * @returns {Promise<{ok:boolean, text?:string, confidence?:number, engine?:string, error?:string}>}
 */
export async function recognizeAudio(wavBytes, opts = {}) {
  const cfg = voiceConfig()
  const preferred = opts.engine || cfg.asrEngine
  const culture = opts.culture || cfg.asrCulture
  const sherpaReady = sherpaStatus().ready
  const engine = pickEngine('asr', preferred, { sherpa: sherpaReady, sapi: IS_WINDOWS, cloud: false })
  if (!engine) return { ok: false, error: '没有可用的识别引擎' }

  if (engine === 'sherpa') {
    const r = await recognizeWithSherpa(wavBytes, { log })
    if (r.ok) return { ...r, engine }
    log('[voice] 离线模型识别失败，回退本机识别：' + r.error)
  }
  if (IS_WINDOWS) {
    const r = await sapiRecognize({ wavBytes, culture }, { log })
    if (r.ok) return { ...r, engine: 'sapi' }
    return { ok: false, error: r.error, engine: 'sapi' }
  }
  return { ok: false, error: '没有可用的识别引擎' }
}

/* ---------------- 状态 ---------------- */

/**
 * 语音能力快照（设置页展示用）。
 * @returns {Promise<object>}
 */
export async function voiceStatus() {
  const cfg = voiceConfig()
  const [voices, recognizers] = await Promise.all([
    IS_WINDOWS ? listSapiVoices({ log }).catch(() => []) : Promise.resolve([]),
    IS_WINDOWS ? listRecognizers({ log }).catch(() => []) : Promise.resolve([])
  ])
  const sapiAsr = recognizers.some((r) => /^zh/i.test(r.culture || ''))
  const edgeUp = edgeUsable()
  const sapiTtsUp = IS_WINDOWS && voices.length > 0
  const sh = sherpaStatus()

  return {
    tts: {
      engine: pickEngine('tts', cfg.ttsEngine, { edge: edgeUp, sapi: sapiTtsUp, cloud: false, gptsovits: false }),
      configured: cfg.ttsEngine,
      enabled: cfg.ttsEnabled,
      available: { edge: edgeUp, sapi: sapiTtsUp, cloud: false, gptsovits: false },
      edgeError: health.edge.lastError
    },
    asr: {
      engine: pickEngine('asr', cfg.asrEngine, { sherpa: sh.ready, sapi: sapiAsr, cloud: false }),
      configured: cfg.asrEngine,
      available: { sherpa: sh.ready, sapi: sapiAsr, cloud: false }
    },
    sapiVoices: voices,
    recognizers,
    sherpa: { ...sh, server: sherpaServerState() },
    engines: { tts: TTS_ENGINES, asr: ASR_ENGINES }
  }
}

/** 释放语音侧资源（应用退出时调用；离线识别服务是长驻子进程） */
export function disposeVoice() {
  return stopSherpaServer()
}

/**
 * 预热语音侧的重资源。目前只有「离线识别服务」。
 * 只在用户确实选了离线模型、且已经装好时才预热 —— 否则白吃 150MB 内存。
 * @param {{log?:Function, delayMs?:number}} [opts]
 * @returns {Promise<{prewarmed:boolean, reason?:string}>}
 */
export async function prewarmVoice(opts = {}) {
  const cfg = voiceConfig()
  if (cfg.asrEngine !== 'sherpa') return { prewarmed: false, reason: '当前识别引擎不是离线模型' }
  if (process.env.NAGI_NO_PREWARM === '1') return { prewarmed: false, reason: '环境变量已禁用预热' }
  const ok = await prewarmSherpa({ log: opts.log || log, delayMs: opts.delayMs ?? 8000 })
  return { prewarmed: ok, reason: ok ? '' : '离线识别未安装或启动失败' }
}

/* ---------------- 离线模型（设置页调用） ---------------- */

export {
  downloadSherpa,
  downloadSherpaCli,
  downloadSherpaModel,
  sherpaStatus,
  sherpaServerState,
  stopSherpaServer,
  prewarmSherpa
} from './sherpa.js'
