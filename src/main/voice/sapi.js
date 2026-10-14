// src/main/voice/sapi.js
// 「本机引擎」适配器：Windows 自带的 SAPI 合成与识别。
// 优点：零密钥、零依赖、完全离线；缺点：合成音质偏机械、识别是老引擎精度一般。
// 所以它在本工程里的定位是「保底」——在线引擎挂了、断网了，她依然开得了口、听得见。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { resourcesDir } from '../paths.js'
import {
  runPowerShell,
  readJsonFile,
  makeScratchDir,
  cleanupDir,
  writeTextFile,
  serialize
} from './ps.js'

const ttsScript = () => join(resourcesDir, 'voice', 'tts-sapi.ps1')
const asrScript = () => join(resourcesDir, 'voice', 'asr-sapi.ps1')
const scratchRoot = () => join(app.getPath('temp'), 'nagi-voice')

/** 已安装语音清单（进程内缓存，启动后不变） */
let voicesCache = null
/** 已安装识别引擎清单（同上） */
let recognizersCache = null

/** 语音合成用的默认音色偏好顺序：优先中文女声 */
const PREFERRED_VOICES = ['Microsoft Huihui Desktop', 'Microsoft Huihui', 'Microsoft Yaoyao']

/**
 * 列出系统已安装的 SAPI 语音。
 * @returns {Promise<Array<{name:string, culture:string, gender:string, age:string}>>}
 */
export async function listSapiVoices({ log } = {}) {
  if (voicesCache) return voicesCache
  return serialize(async () => {
    if (voicesCache) return voicesCache
    const dir = makeScratchDir(scratchRoot(), 'voices')
    try {
      const resultFile = join(dir, 'r.json')
      const r = await runPowerShell(ttsScript(), ['-Mode', 'voices', '-ResultFile', resultFile], {
        timeoutMs: 20000,
        log
      })
      const data = readJsonFile(resultFile)
      const list = data && Array.isArray(data.voices) ? data.voices : []
      if (!r.ok && !list.length) log && log('[voice] 读取系统语音失败：' + (r.error || data?.error || '未知'))
      voicesCache = list
      return list
    } finally {
      cleanupDir(dir)
    }
  })
}

/** 挑一个中文音色：优先偏好表，其次任意 zh-CN，最后交给脚本默认 */
async function pickSapiVoice(wanted, { log } = {}) {
  if (wanted) return wanted
  const list = await listSapiVoices({ log })
  for (const p of PREFERRED_VOICES) {
    const hit = list.find((v) => v.name === p)
    if (hit) return hit.name
  }
  const zh = list.find((v) => /^zh/i.test(v.culture || ''))
  return zh ? zh.name : ''
}

/**
 * 用本机语音合成一段文本。
 * @param {{text:string, voice?:string, rate?:number, volume?:number}} opts rate/volume 同 SAPI（rate -10..10）
 * @returns {Promise<{ok:boolean, bytes?:Buffer, format?:string, error?:string, voice?:string}>}
 */
export async function sapiSpeak({ text, voice, rate = 0, volume = 100 } = {}, { log } = {}) {
  const clean = String(text || '').trim()
  if (!clean) return { ok: false, error: '空文本' }

  return serialize(async () => {
    const dir = makeScratchDir(scratchRoot(), 'tts')
    try {
      const textFile = join(dir, 'in.txt')
      const wavFile = join(dir, 'out.wav')
      const resultFile = join(dir, 'r.json')
      writeTextFile(textFile, clean)

      const useVoice = await pickSapiVoice(voice, { log })
      const args = [
        '-Mode', 'speak',
        '-TextFile', textFile,
        '-OutFile', wavFile,
        '-ResultFile', resultFile,
        '-Rate', String(Math.max(-10, Math.min(10, Math.round(rate)))),
        '-Volume', String(Math.max(0, Math.min(100, Math.round(volume))))
      ]
      if (useVoice) args.push('-Voice', useVoice)

      const r = await runPowerShell(ttsScript(), args, { timeoutMs: 30000, log })
      const data = readJsonFile(resultFile)
      if (!data || !data.ok) {
        return { ok: false, error: (data && data.error) || r.error || '本机语音合成失败' }
      }
      const bytes = readFileSync(wavFile)
      return { ok: true, bytes, format: 'audio/wav', voice: data.voice || useVoice }
    } catch (err) {
      return { ok: false, error: err.message }
    } finally {
      cleanupDir(dir)
    }
  })
}

/**
 * 列出已安装的识别引擎。
 * @returns {Promise<Array<{id:string, culture:string, description:string}>>}
 */
export async function listRecognizers({ log } = {}) {
  if (recognizersCache) return recognizersCache
  return serialize(async () => {
    if (recognizersCache) return recognizersCache
    const dir = makeScratchDir(scratchRoot(), 'recog')
    try {
      const out = join(dir, 'r.json')
      await runPowerShell(asrScript(), ['-ListRecognizers', out], { timeoutMs: 20000, log })
      const data = readJsonFile(out)
      recognizersCache = data && Array.isArray(data.recognizers) ? data.recognizers : []
      return recognizersCache
    } finally {
      cleanupDir(dir)
    }
  })
}

/** 本机识别是否可用（有 zh-CN 引擎就算可用） */
export async function sapiAsrAvailable({ log } = {}) {
  try {
    const list = await listRecognizers({ log })
    return list.some((r) => /^zh/i.test(r.culture || ''))
  } catch {
    return false
  }
}

/**
 * 用本机识别引擎转写一段 16-bit PCM WAV。
 * @param {{wavBytes:Buffer|Uint8Array, culture?:string}} opts
 * @returns {Promise<{ok:boolean, text?:string, confidence?:number, error?:string}>}
 */
export async function sapiRecognize({ wavBytes, culture = 'zh-CN' } = {}, { log } = {}) {
  const buf = wavBytes ? Buffer.from(wavBytes) : null
  if (!buf || !buf.length) return { ok: false, error: '没有音频数据' }

  return serialize(async () => {
    const dir = makeScratchDir(scratchRoot(), 'asr')
    try {
      const wavFile = join(dir, 'in.wav')
      const resultFile = join(dir, 'r.json')
      writeFileSync(wavFile, buf)

      const r = await runPowerShell(
        asrScript(),
        ['-WavFile', wavFile, '-ResultFile', resultFile, '-Culture', culture],
        { timeoutMs: 45000, log }
      )
      const data = readJsonFile(resultFile)
      if (!data || !data.ok) {
        return { ok: false, error: (data && data.error) || r.error || '本机识别失败' }
      }
      return { ok: true, text: data.text || '', confidence: data.confidence || 0 }
    } catch (err) {
      return { ok: false, error: err.message }
    } finally {
      cleanupDir(dir)
    }
  })
}
