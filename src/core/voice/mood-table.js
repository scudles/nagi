// src/core/voice/mood-table.js
// 六种情绪的语音偏移**唯一出处**（D50）。
//
// 为什么单独一个文件：这套数字原来有两份——`engines.js` 的 `MOOD_SPEECH`（旧路径）
// 和 `voice-profile.js` 的 `VOICE_PROFILE.emotions`（新路径）。两份各自演进的结果是
// 旧表幅度只有新表的一半、`worry` 甚至方向相反（旧表"略快"、新表"放慢低沉"）：
// 用户切一下「语音情绪映射」开关，听到的不是同一个人。那张"两表别改错"的备忘本身
// 就是漏洞存在的证据——真正该做的是让它**只有一份**。
//
// 规则（改之前先认同）：
//   · 这里只放**六情绪**的偏移；时段（夜/午后）、语气标记、强度缩放仍归
//     `voice-profile.js`（旧路径没有这些维度，也不该有）。
//   · `volume` 轴只有新路径会兑现（`mergeVoiceParams` 的音量取自基准，旧路径从不
//     因情绪改音量）。放在这里是为了两份表能直接对照，不是让旧表改音量。
//   · 纯数据，无 IO / 无 Electron / 无 Node 依赖，可 node --test。

/** 情绪 → 叠加在引擎基准声线（NAGI_VOICE）之上的净增减 */
export const MOOD_OFFSETS = {
  calm:    { rate:   0, pitch:   0, volume:  0 },
  smile:   { rate:   6, pitch:   4, volume:  1 },
  joy:     { rate:  16, pitch:  10, volume:  3 },
  puzzled: { rate:  -3, pitch:   7, volume:  0 },
  worry:   { rate: -10, pitch:  -6, volume: -6 },
  pout:    { rate: -15, pitch: -11, volume: -3 }
}

/** 六个情绪名（顺序即"平静 → 越来越开心 / 越来越别扭"的陈列顺序） */
export const MOOD_KEYS = Object.keys(MOOD_OFFSETS)

/** 深拷贝一份，避免调用方拿到同一引用后互相污染（两份表都不该被就地改） */
export function cloneMoodOffsets() {
  return Object.fromEntries(MOOD_KEYS.map((k) => [k, { ...MOOD_OFFSETS[k] }]))
}
