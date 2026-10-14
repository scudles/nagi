// src/core/voice/lip.js
// 口型时间轴：把「这一句 + 这段音频的时长」变成 ParamMouthOpenY 的采样函数。
//
// 为什么不用真·音素分析：桌宠要的是「看着像在说话」，不是唇语精准。按音节估一个大概的
// 张口-闭嘴节奏，再叠一点确定性抖动，观感就够了，而且完全可单测、可复现（无随机源、无音频解码）。
//
// 纯逻辑，无 Electron / Node 依赖，可 node --test。

export const LIP_DEFAULTS = {
  /** 一次「张口—闭嘴」的最短时长：再快就成抽搐了，用上限约束音节数 */
  minSlotMs: 110,
  /** 每个音节末尾的闭嘴留白占比（说话本来就有缝） */
  gapRatio: 0.18,
  minAmp: 0.5,
  maxAmp: 1
}

/** 32 位整数散列 → [0,1)：给口型幅度一个确定性伪随机源（同 seed 必得同结果） */
function hash01(n, seed = 0) {
  let h = (Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((seed | 0) + 1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/**
 * 粗估「要张几次嘴」：中文按字（一字一音节），英文/数字按字符数折半。
 * @param {string} text
 * @returns {number} 至少 1
 */
export function estimateUnits(text) {
  const s = String(text || '')
  const cjk = s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)
  let n = cjk ? cjk.length : 0
  const rest = s.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ')
  const words = rest.match(/[A-Za-z0-9]+/g)
  if (words) for (const w of words) n += Math.max(1, Math.round(w.length / 2))
  return Math.max(1, Math.round(n))
}

/**
 * 建一条口型轨道。
 * @param {{text?:string, durationMs?:number, seed?:number, minSlotMs?:number, gapRatio?:number}} opts
 * @returns {{durationMs:number, units:number, slotMs:number, at:(t:number)=>number, sample:(ts:number[])=>number[]}}
 */
export function createLipTrack(opts = {}) {
  const d = Math.max(0, Number(opts.durationMs) || 0)
  const minSlotMs = opts.minSlotMs ?? LIP_DEFAULTS.minSlotMs
  const gapRatio = opts.gapRatio ?? LIP_DEFAULTS.gapRatio
  const seed = opts.seed ?? 1

  const byText = estimateUnits(opts.text)
  const maxUnits = Math.max(1, Math.floor(d / minSlotMs))
  const units = Math.max(1, Math.min(byText, maxUnits))
  const slotMs = units > 0 ? d / units : 0
  const openMs = slotMs * (1 - gapRatio)

  // 每个音节一个基准幅度（确定性）：避免"每个字都张一样大"的机械感
  const amps = new Array(units)
  for (let i = 0; i < units; i++) {
    amps[i] = LIP_DEFAULTS.minAmp + (LIP_DEFAULTS.maxAmp - LIP_DEFAULTS.minAmp) * hash01(i, seed)
  }

  function at(t) {
    if (!(d > 0) || !(t >= 0) || t >= d) return 0
    const idx = Math.min(units - 1, Math.floor(t / slotMs))
    const local = t - idx * slotMs
    if (local >= openMs) return 0 // 音节之间的闭嘴缝
    const phase = openMs > 0 ? local / openMs : 0
    const v = amps[idx] * Math.sin(Math.PI * phase) // 半正弦包络：开→合
    return v < 0 ? 0 : v > 1 ? 1 : v
  }

  return {
    durationMs: d,
    units,
    slotMs,
    at,
    sample(times) {
      return (Array.isArray(times) ? times : []).map(at)
    }
  }
}
