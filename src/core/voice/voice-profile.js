// src/core/voice/voice-profile.js
// 语音情绪参数映射（BLUE-1）：情绪 + 强度 + 昼夜时段 + 语气标记 → {voice, rate, pitch, volume}
//
// 位置：core 纯逻辑，无 Electron / Node 依赖，可 node --test。
// 接线：main/extensions/voice-profile.js 把它注册进 presence 的语音参数 hook；
//       编排层（main/voice）在 settings.presence.voiceProfileEnabled === true 时调用，
//       返回 null 或抛错都安全回退到既有默认参数（契约「安全回退」条款）。
//
// 时钟：本模块不自行读时钟——时段维度由入参 rhythm 注入（circadian 用可注入时钟算好），
//       测试直接传 rhythm 对象即完全确定，无隐藏时间依赖。
//
// 与 MOOD_SPEECH 的关系：**同源**（D50）。两表原来各自演进，旧表幅度只有新表一半、
//       worry 方向还相反，用户切一下开关就像换了个人；现在六情绪的偏移只存在于
//       `mood-table.js` 一份，两表都从它取。差别只剩维度：新表多强度缩放 / 昼夜时段 /
//       语气标记，旧表只有情绪本身。切开关改变的是"她今天的状态细不细"，不是她是谁。
//
// 参数语义（与 engines.js 一致）：rate/pitch 为百分比，各引擎自行折算（SAPI 的 Rate 是 -10~10，
//       编排层按 /10 折算）；volume 0~100。所有输出都收敛到 hooks 校验域内。

import { NAGI_VOICE } from './engines.js'
import { cloneMoodOffsets } from './mood-table.js'

/**
 * 可调常量表：所有数值集中在这里，听完真机反馈只改这张表，不动逻辑。
 * 偏移量均为「叠加在引擎基准声线（NAGI_VOICE）之上」的净增减。
 */
export const VOICE_PROFILE = {
  /**
   * 情绪 → 偏移（intensity 缩放后叠加）。任务书卡 B：joy 加快上扬、pout 放慢、worry 放慢低沉。
   *
   * 数值取自 `mood-table.js`（D50：六情绪唯一出处，与旧表 MOOD_SPEECH 同源）。
   * 2026-10-17 整体加大幅度（OBS-1：用户真机初听反馈「情绪起伏偏弱、整体过于含蓄」）：
   * 原来满强度下 joy 只比 calm 快 8 个百分点，降到 0.5 强度只剩 4，听感上和 calm 是同一张脸。
   * 现在把两极拉开到 31（joy +16 ↔ pout -15），并让相邻情绪在「语速 / 音高 / 音量」三个轴上
   * 至少有一轴拉开 5 以上——听感分得出来，但不至于夸张到出怪声（真机复听后仍只改那张表）。
   * 注意：基准音量已是 100（满），所以正向 volume 偏移在默认音量下会被夹掉，
   * 「更明亮」主要靠 rate/pitch 兑现，负向 volume 才真的变小声。
   */
  emotions: cloneMoodOffsets(),
  /** 昼夜时段 → 偏移（rhythm.enabled !== true 时不施加；夜晚降音量放慢、午后犯困拉长） */
  periods: {
    // 2026-10-17 同上：夜晚从 -28 压到 -34（她怕吵到你的意图要听得出来），午后犯困拉长加深
    night:     { rate: -10, pitch:  -3, volume: -34 },
    morning:   { rate:   3, pitch:   1, volume:   0 },
    noon:      { rate:   0, pitch:   0, volume:   0 },
    afternoon: { rate:  -7, pitch:  -2, volume:  -2 },
    evening:   { rate:  -4, pitch:  -1, volume:  -6 }
  },
  /** 语气标记 → 微调（转发通道，当前无生产方；未知标记静默忽略） */
  toneTags: {
    gentle:  { rate: -3, pitch: -2, volume: -4 },
    serious: { rate: -3, pitch: -3, volume:  0 },
    playful: { rate:  8, pitch:  5, volume:  1 },
    tired:   { rate: -8, pitch: -3, volume: -6 }
  }
}

/** 编排层只会传 edge / sapi（合成链已过滤）；未知引擎交回默认路径（返回 null） */
const BASE_VOICES = NAGI_VOICE

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)
const clampPct = (v) => Math.max(-50, Math.min(50, Math.round(Number(v) || 0)))
const clampVol = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))

/**
 * 情绪 + 强度 + 时段 + 语气 → 该引擎的绝对语音参数。
 *
 * @param {{emotion?:string, intensity?:number, rhythm?:object, toneTag?:string, engine?:string}} input
 *   emotion  MOOD_SPEECH 域内的情绪名（未知值按 calm 处理）
 *   intensity 情绪强度 0~1（0 = 不施加情绪偏移；非有限数按 0）
 *   rhythm   presence 快照里的 rhythm（{enabled, period, ...}；null / enabled!==true 时不施加时段偏移）
 *   toneTag  语气标记（未知值忽略）
 *   engine   目标引擎 id（edge / sapi；未知 → 返回 null 走安全回退）
 * @param {{userRate?:number, userVolume?:number}} [opts]
 *   用户在设置页的全局偏移（与编排层 paramsFor 同语义：rate 叠加在基准上、volume 直接覆盖）
 * @returns {{voice:string, rate:number, pitch:number, volume:number}|null}
 *   voice 恒为 ''（空串 = 沿用当前音色，由编排层 `supplied.voice || voice` 兑现）
 */
export function resolveVoiceProfile(input, opts = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const engine = typeof input.engine === 'string' ? input.engine : ''
    const base = BASE_VOICES[engine]
    if (!base) return null

    // 基准：引擎预设 + 用户偏移（试听的显式参数走另一条路，到不了这里）
    const userRate = Number.isFinite(opts.userRate) ? opts.userRate : 0
    const userVolume = Number.isFinite(opts.userVolume) ? opts.userVolume : 100
    let rate = (Number(base.rate) || 0) + userRate
    let pitch = Number(base.pitch) || 0
    let volume = userVolume

    // 情绪 × 强度
    const emotion = typeof input.emotion === 'string' ? input.emotion : 'calm'
    const e = VOICE_PROFILE.emotions[emotion] || VOICE_PROFILE.emotions.calm
    const scale = clamp01(input.intensity)
    rate += (Number(e.rate) || 0) * scale
    pitch += (Number(e.pitch) || 0) * scale
    volume += (Number(e.volume) || 0) * scale

    // 昼夜时段（尊重设置开关：rhythm.enabled 为 false 时不施加）
    const rhythm = input.rhythm
    if (rhythm && typeof rhythm === 'object' && rhythm.enabled === true) {
      const p = VOICE_PROFILE.periods[rhythm.period]
      if (p) {
        rate += Number(p.rate) || 0
        pitch += Number(p.pitch) || 0
        volume += Number(p.volume) || 0
      }
    }

    // 语气标记（未知静默忽略）
    if (typeof input.toneTag === 'string' && input.toneTag) {
      const t = VOICE_PROFILE.toneTags[input.toneTag]
      if (t) {
        rate += Number(t.rate) || 0
        pitch += Number(t.pitch) || 0
        volume += Number(t.volume) || 0
      }
    }

    return { voice: '', rate: clampPct(rate), pitch: clampPct(pitch), volume: clampVol(volume) }
  } catch {
    return null // 映射失败安全回退：编排层拿到 null 会走既有默认参数
  }
}
