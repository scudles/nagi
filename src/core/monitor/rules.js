// src/core/monitor/rules.js
// 凪 · 主动规则库（M3，纯函数）。
// 每条规则只做两件事：判断「此刻该不该开口」（evaluate），以及给出情绪倾向与台词池键。
// 具体措辞由 persona.proactive 池即兴挑选（同一条规则多次触发也不会说同一句话）。
//
// 设计原则（对齐《凪_人格设定》的「引导式自由」）：
//   · 规则是机制（阈值、情绪、频率），不是剧本
//   · pool 只给「方向」，池子够大 + 随机 + 反重复，避免模板感
//   · 优先级从上到下，命中第一条即返回

import { CATEGORY } from './tracker.js'

/** 阈值集中放这里，方便调参与被单测断言 */
export const RULE_PARAMS = {
  AWAY_MIN: 5, // 离开超过 5 分钟再回来才打招呼
  SIT_MIN: 90, // 连续盯着屏幕 90 分钟 → 提醒起身
  LATE_NIGHT_FROM: 1, // 凌晨 1 点 …
  LATE_NIGHT_TO: 5, // … 到 5 点之间还在用 → 劝睡
  GAMING_MIN: 60, // 连续游戏 60 分钟 → 吐槽
  VIDEO_MIN: 75, // 连续看视频 75 分钟 → 提醒
  DEEP_FOCUS_MIN: 120 // 连续专注工作 120 分钟 → 安静陪一句
}

/** 规则表：evaluate(stats) → vars 对象（命中）或 null（不命中） */
export const RULES = [
  {
    id: 'welcome_back',
    mood: 'smile',
    pool: 'welcomeBack',
    cooldownMin: 8,
    dailyLimit: 6,
    evaluate(s) {
      if (!s.justReturned || !s.active) return null
      if (s.awayMinutes < RULE_PARAMS.AWAY_MIN) return null
      return { away: Math.round(s.awayMinutes) }
    }
  },
  {
    id: 'late_night_awake',
    mood: 'worry',
    pool: 'lateNight',
    cooldownMin: 45,
    dailyLimit: 3,
    evaluate(s) {
      if (!s.active) return null
      if (s.hour < RULE_PARAMS.LATE_NIGHT_FROM || s.hour >= RULE_PARAMS.LATE_NIGHT_TO) return null
      return {}
    }
  },
  {
    id: 'sit_too_long',
    mood: 'worry',
    pool: 'sitWarn',
    cooldownMin: 45,
    dailyLimit: 4,
    evaluate(s) {
      if (!s.active || s.sessionMinutes < RULE_PARAMS.SIT_MIN) return null
      // 正在打游戏/看视频时交给对应规则，不重复念叨
      if (s.category === CATEGORY.GAMING || s.category === CATEGORY.VIDEO) return null
      return { min: Math.round(s.sessionMinutes) }
    }
  },
  {
    id: 'gaming_too_long',
    mood: 'puzzled',
    pool: 'gamingLong',
    cooldownMin: 60,
    dailyLimit: 3,
    evaluate(s) {
      if (s.category !== CATEGORY.GAMING || s.categoryStreakMin < RULE_PARAMS.GAMING_MIN) return null
      return { min: Math.round(s.categoryStreakMin) }
    }
  },
  {
    id: 'video_too_long',
    mood: 'puzzled',
    pool: 'videoLong',
    cooldownMin: 60,
    dailyLimit: 3,
    evaluate(s) {
      if (s.category !== CATEGORY.VIDEO || s.categoryStreakMin < RULE_PARAMS.VIDEO_MIN) return null
      return { min: Math.round(s.categoryStreakMin) }
    }
  },
  {
    id: 'deep_focus',
    mood: 'calm',
    pool: 'deepFocus',
    cooldownMin: 150,
    dailyLimit: 2,
    evaluate(s) {
      if (s.category !== CATEGORY.WORK || s.categoryStreakMin < RULE_PARAMS.DEEP_FOCUS_MIN) return null
      return {}
    }
  }
]

/**
 * 评估当前统计，返回第一条命中的规则。
 * @param {object} stats createTracker().stats() 的输出
 * @returns {{rule:object, vars:object}|null}
 */
export function evaluateRules(stats, rules = RULES) {
  if (!stats) return null
  for (const rule of rules) {
    let vars = null
    try {
      vars = rule.evaluate(stats)
    } catch {
      vars = null
    }
    if (vars) return { rule, vars }
  }
  return null
}
