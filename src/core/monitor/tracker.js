// src/core/monitor/tracker.js
// 凪 · 活动统计器（M3，纯逻辑 / 可注入时钟）。
// 输入：一串「前台窗口样本」；输出：她做判断真正需要的几个数字——
//   · 连续盯着屏幕多久（久坐）
//   · 离开了多久 / 是不是刚回来
//   · 当前在用什么类别的程序、这一类连续用了多久
// 关键：原始窗口标题只在 classify 时用一次，**不进入任何对外状态**。

/** 应用类别（她对外只谈类别，不谈具体窗口） */
export const CATEGORY = {
  GAMING: 'gaming',
  VIDEO: 'video',
  WORK: 'work',
  SOCIAL: 'social',
  BROWSER: 'browser',
  OTHER: 'other'
}

// 关键词表（小写子串匹配；先匹配 app 名，再匹配窗口标题）
const KEYWORDS = {
  [CATEGORY.GAMING]: [
    'steam', 'epic games', 'epicgames', 'battle.net', 'blizzard', '暴雪', 'wegame', 'riot',
    'league of legends', '英雄联盟', 'valorant', '无畏契约', 'cs2', 'csgo', 'dota', 'dota2',
    'genshin', '原神', 'minecraft', '我的世界', 'honkai', '崩坏', 'starrail', '绝区零',
    '游戏', 'game', 'ubisoft', 'ea app', 'origin', 'xbox', 'playstation'
  ],
  [CATEGORY.VIDEO]: [
    'youtube', 'bilibili', '哔哩哔哩', '哔哩', 'netflix', 'iqiyi', '爱奇艺', '腾讯视频',
    '优酷', '芒果', 'vlc', 'potplayer', 'mpc-hc', 'mpc', 'kmplayer', '抖音', 'tiktok',
    '快手', 'twitch', '斗鱼', '虎牙', '西瓜视频', '播放器', 'player'
  ],
  [CATEGORY.WORK]: [
    'code', 'vscode', 'visual studio', 'idea', 'pycharm', 'webstorm', 'goland', 'clion',
    'sublime', 'notepad', 'vim', 'emacs', 'terminal', 'powershell', 'cmd', 'git bash',
    'word', 'excel', 'powerpoint', 'wps', 'office', 'outlook', 'onenote', 'obsidian',
    'typora', 'notion', 'figma', 'photoshop', 'illustrator', 'blender', 'premiere', 'zotero',
    '钉钉', '企业微信', 'teams', 'slack', 'zoom', '腾讯会议', '飞书文档', 'jupyter', 'matlab'
  ],
  [CATEGORY.SOCIAL]: [
    'wechat', 'weixin', '微信', 'qq', 'telegram', 'discord', 'weibo', '微博', 'twitter',
    'facebook', 'instagram', 'whatsapp', 'line', '飞书', 'feishu', 'dingtalk', '钉钉聊天'
  ],
  [CATEGORY.BROWSER]: ['chrome', 'edge', 'firefox', 'brave', 'opera', 'safari', '浏览器', 'explorer']
}

/** 把一条样本归到某个类别（app 优先，其次标题；都不中 → other） */
export function classify(sample) {
  if (!sample) return CATEGORY.OTHER
  const app = String(sample.app || '').toLowerCase()
  const title = String(sample.title || '').toLowerCase()
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    if (app && words.some((w) => app.includes(w))) return cat
  }
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    if (title && words.some((w) => title.includes(w))) return cat
  }
  return CATEGORY.OTHER
}

/**
 * 创建一个活动统计器。
 * @param {object} [opts]
 * @param {() => number} [opts.now] 时钟（单测注入假时钟）
 * @param {number} [opts.idleThresholdSec] 低于此空闲秒数视为「在用电脑」（默认 60s）
 * @param {number} [opts.awayThresholdSec] 高于此空闲秒数视为「已离开」（默认 300s）
 */
export function createTracker({
  now = () => Date.now(),
  idleThresholdSec = 60,
  awayThresholdSec = 300
} = {}) {
  const state = {
    lastTs: 0,
    activeSince: 0, // 当前连续活跃起点
    awaySince: null, // 离开起点（null = 没离开）
    lastReturnedAt: null, // 最近一次「离开→回来」发生的时刻
    lastAwayMinutes: 0, // 最近一次离开的总时长（回来后仍保留，供 welcome_back 用）
    category: null,
    categorySince: 0,
    lastCategory: null,
    samples: 0
  }

  /**
   * 记入一条样本。
   * @returns {{returned:boolean, becameActive:boolean}}
   */
  function record(sample) {
    const t = Number.isFinite(sample?.ts) ? sample.ts : now()
    const idle = Number.isFinite(sample?.idleSec) ? sample.idleSec : 0
    const active = idle < idleThresholdSec
    const category = classify(sample)
    const events = { returned: false, becameActive: false }

    if (active) {
      if (state.awaySince != null) {
        // 刚从「离开」回到「活跃」：把这段离开的时长留下来
        events.returned = true
        state.lastReturnedAt = t
        state.lastAwayMinutes = Math.max(0, (t - state.awaySince) / 60000)
      }
      if (state.activeSince === 0) {
        state.activeSince = t
        events.becameActive = true
      }
      state.awaySince = null
      if (category !== state.category) {
        state.category = category
        state.categorySince = t
      }
    } else {
      // 空闲：结束当前活跃段，必要时记录离开起点
      if (idle >= awayThresholdSec && state.awaySince == null) {
        state.awaySince = t - idle * 1000 // 近似：空闲是从 (t - idle) 开始的
      }
      state.activeSince = 0
      state.category = null
      state.categorySince = 0
    }

    state.lastTs = t
    state.lastCategory = category
    state.samples++
    return events
  }

  /** 当前统计快照（喂给规则库） */
  function stats() {
    const t = state.lastTs || now()
    const hour = new Date(t).getHours()
    const active = state.activeSince !== 0
    const sessionMinutes = active ? Math.max(0, (t - state.activeSince) / 60000) : 0
    const awayMinutes =
      state.awaySince != null
        ? Math.max(0, (t - state.awaySince) / 60000) // 仍在离开中
        : active
          ? state.lastAwayMinutes // 刚回来：报告刚才离开了多久
          : 0
    const categoryStreakMin = active && state.category ? Math.max(0, (t - state.categorySince) / 60000) : 0
    return {
      ts: t,
      hour,
      active,
      sessionMinutes,
      awayMinutes,
      category: active ? state.category : null,
      categoryStreakMin,
      justReturned: state.lastReturnedAt != null && t - state.lastReturnedAt < 1500,
      samples: state.samples
    }
  }

  function reset() {
    state.lastTs = 0
    state.activeSince = 0
    state.awaySince = null
    state.lastReturnedAt = null
    state.lastAwayMinutes = 0
    state.category = null
    state.categorySince = 0
    state.lastCategory = null
    state.samples = 0
  }

  return { record, stats, reset }
}
