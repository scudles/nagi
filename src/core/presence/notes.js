// src/core/presence/notes.js
// 便签候选（BLUE-3a）：决定「她要不要留下一张便签」以及便签里写什么。
//
// 契约（§4）：
//   · 候选只来自三类**可信事实**：完整 activity 生成、有效 reunion 候选、可信 action-trace 返回；
//     相同事件 ID 幂等；应用内每天最多 3 条、间隔 ≥30 分钟；勿扰/只陪着期间不展示；
//     新业务存储默认关闭（默认不落盘、不出候选）。
//   · **不虚构**：便签正文只能由「活动类型 + 时长 / 归来分档 / 工具名与返回状态」这些
//     依据推出；模拟活动必须带 provenance:'simulation' 与 activityId，界面上如实标注，
//     不得写成用户离开期间真实发生的外界经历，也不得说「帮你做好了」。
//   · 外部便签文件写入不在本模块：默认关闭，必须走已有的原生目录授权与逐次确认
//     （未实现安全桥接时只显示应用内候选，不伪装写入成功）。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

export const NOTES_LIMITS = {
  /** 应用内每天最多几条 */
  perDay: 3,
  /** 两条之间最少间隔（契约写死的 30 分钟） */
  minGapMs: 30 * 60 * 1000,
  /** 幂等表最多记多少个已处理事件 ID */
  seenMax: 200
}

/** 活动类型 → 不虚构的短描述（只描述她自己的内部状态，不描述外界） */
export const ACTIVITY_LABELS = {
  'simulated-reading': '读了会儿东西',
  'simulated-reflection': '想了一会儿事情',
  'quiet-wait': '安安静静地待着'
}

export function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 全新状态 */
export function emptyNoteState(now = Date.now()) {
  return { dayKey: dayKeyOf(now), count: 0, lastAt: 0, seen: [] }
}

/** 规范化外部状态（容忍残缺/脏数据） */
export function normalizeNoteState(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const seen = Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === 'string' && x).slice(-NOTES_LIMITS.seenMax) : []
  return {
    dayKey: typeof s.dayKey === 'string' && s.dayKey ? s.dayKey : dayKeyOf(now),
    count: Math.max(0, Math.floor(Number(s.count) || 0)),
    lastAt: Number.isFinite(s.lastAt) ? s.lastAt : 0,
    seen
  }
}

/** 人话时长：不精确到秒，只说大概（避免听起来像在记录你） */
export function humanDuration(ms) {
  const min = Math.max(1, Math.round(Number(ms) / 60000) || 0)
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const rest = min % 60
  if (h < 24) return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  return `${d} 天`
}

/**
 * 事件 → 候选正文与依据。返回 null 表示这个事件不构成便签（不生成、不补内容）。
 * @param {{kind:string,event:object}} input
 * @returns {{eventId:string, noteKind:string, at:number, text:string, provenance:string,
 *           activityId?:string, tier?:string, tool?:string, completionVerified?:boolean}|null}
 */
export function noteFromEvent({ kind, event } = {}) {
  if (!event || typeof event !== 'object') return null
  if (kind === 'activity') {
    // 只有「完整生成」的活动才算数（要有 id、有类型、有结束时点）
    if (!event.id || !ACTIVITY_LABELS[event.type] || !Number.isFinite(event.endedAt) || !Number.isFinite(event.startedAt)) return null
    const span = Math.max(0, event.endedAt - event.startedAt)
    return {
      eventId: String(event.id),
      noteKind: 'activity',
      at: event.endedAt,
      text: `你不在的时候，我${ACTIVITY_LABELS[event.type]}，大概 ${humanDuration(span)}。`,
      provenance: 'simulation',
      activityId: String(event.id)
    }
  }
  if (kind === 'reunion') {
    // 有效 reunion 候选才进来（分档与时长由 reunion 模块给定）；禁止推断用户去了哪里
    if (!event.id || !Number.isFinite(event.durationMs) || !event.tier) return null
    return {
      eventId: String(event.id),
      noteKind: 'reunion',
      at: Number.isFinite(event.at) ? event.at : Date.now(),
      text: `你回来了。刚才大概离开了 ${humanDuration(event.durationMs)}。`,
      provenance: 'observed',
      tier: event.tier
    }
  }
  if (kind === 'action') {
    // 可信 action-trace：只说「跑过、返回了」，外部效果未核实
    if (!event.id || !event.tool) return null
    const outcome = event.status === 'failed' ? '返回了失败' : '正常返回了'
    return {
      eventId: String(event.id),
      noteKind: 'action',
      at: Number.isFinite(event.at) ? event.at : Date.now(),
      text: `刚才我帮你跑过 ${event.tool}，它${outcome}；外部效果我没有核实。`,
      provenance: 'observed',
      tool: String(event.tool),
      completionVerified: false
    }
  }
  return null
}

/**
 * 是否该把这张便签显示出来（应用内）。
 *
 * 返回的 state 是**下一份**状态：只有真正采用时才记账（计数/间隔/幂等表），
 * 被拒时不改，避免「排队等配额」这种隐式积压。
 *
 * @param {{kind:string,event:object,now?:number,state:object,config?:object,privacy?:object}} input
 * @returns {{note:object|null, state:object, reason:string}}
 */
export function considerNote({ kind, event, now = Date.now(), state, config = {}, privacy = {} } = {}) {
  const cur = normalizeNoteState(state, now)
  // 新业务整体 opt-in：默认关闭时连候选都不产生
  if (config.notesEnabled !== true) return { note: null, state: cur, reason: 'disabled' }
  // 勿扰 / 只陪着：不展示（契约 §4）
  if (privacy.doNotDisturb === true || privacy.onlyPresence === true) return { note: null, state: cur, reason: 'do-not-disturb' }
  const note = noteFromEvent({ kind, event })
  if (!note) return { note: null, state: cur, reason: 'not-a-note' }
  // 幂等：同一个事件 ID 只出一次
  if (cur.seen.includes(note.eventId)) return { note: null, state: cur, reason: 'duplicate' }
  // 每日配额：跨本地日期重置
  const today = dayKeyOf(now)
  const count = cur.dayKey === today ? cur.count : 0
  if (count >= NOTES_LIMITS.perDay) return { note: null, state: { ...cur, dayKey: today, count }, reason: 'daily-limit' }
  // 间隔：距上一条不足 30 分钟就先不出
  if (cur.lastAt && now - cur.lastAt < NOTES_LIMITS.minGapMs) return { note: null, state: cur, reason: 'too-soon' }
  const seen = [...cur.seen, note.eventId].slice(-NOTES_LIMITS.seenMax)
  return {
    note: { id: note.eventId, ...note, at: now },
    state: { dayKey: today, count: count + 1, lastAt: now, seen },
    reason: 'accepted'
  }
}
