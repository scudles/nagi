// src/core/agent/offline.js
// 占位大脑（没有 API key / 断网 / 云端未就绪）的**正文定稿**。
//
// 为什么单独一层（Codex 二轮复判的打回点）：
//   `mockRun` 原来先取 `NagiPersona.reply()` 的普通台词，只用禁词式 guard 判一下，
//   合格就展示；而 crisis 的 guard 规则只拦"liminal/独占/依赖"这几类措辞，
//   所以"……我现在接不上大脑。等接上了，我再好好回你。"能顺利通过，
//   于是一个说"我已经吃了很多药"的人，收到的是一句程序自嘲。
//   更糟的是首次启动的 announce 尾句是**审核之后**才拼上去的——尾句从来没被检查过。
//
// 这里的职责只有一个：**先定稿，再交出去审**。
//   · crisis（L2/L3）：不取任何角色台词，直接用按级别的确定性安全指引；
//   · 普通轮：角色台词（+ 首次启动的自嘲尾句，如果这次是首轮）。
// 危机轮**永不**追加自嘲尾句——那会把安全指引稀释成一次"我没接上大脑"的道歉。

import { SAFETY_LEVEL, crisisGuidance } from './generation.js'

/** 首次启动的自嘲尾句（只在普通轮出现） */
export const OFFLINE_SELF_DEPRECATION =
  '（……现在的我只有这么点脑子。接上真大脑，我会说得更像样。）'

/**
 * @param {object} o
 * @param {string} [o.personaText] 角色台词（危机轮不会用到，但调用方仍可传）
 * @param {boolean} [o.announce]   是否首次启动（要追加自嘲尾句）
 * @param {string} [o.safetyLevel] SAFETY_LEVEL
 * @param {string|null} [o.level]  危机级别 'L2'|'L3'
 * @returns {{text:string, crisis:boolean, announced:boolean}}
 */
export function composeOfflineReply({
  personaText = '',
  announce = false,
  safetyLevel = SAFETY_LEVEL.NORMAL,
  level = null
} = {}) {
  if (safetyLevel === SAFETY_LEVEL.CRISIS) {
    // 危机轮：确定性指引，且不追加任何角色台词/自嘲
    return { text: crisisGuidance(level), crisis: true, announced: false }
  }
  const base = String(personaText || '')
  const announced = announce === true && base.length > 0
  return {
    text: announced ? base + '\n' + OFFLINE_SELF_DEPRECATION : base,
    crisis: false,
    announced
  }
}
