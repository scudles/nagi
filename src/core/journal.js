// src/core/journal.js
// 「今天发生了什么」——事件流水的纯逻辑。
//
// 为什么需要它：日记要写得像「她真的过了这一天」，就得有个地方如实记下这一天发生的事——
// 他和她说了什么、她主动开过几次口、她把哪件提醒交给了他、他戳过她几次。
// 对话历史（history.json）只留最近 40 条、没有时间戳，撑不起「今天」这个概念。
//
// 隐私：只记聊天文本与行为类别，绝不记窗口标题原文（沿用活动监测的隐私原则）。
// 这个文件不碰 IO、不碰 Electron，方便单测。

export const JOURNAL = {
  MAX_ENTRIES: 300, // 单日条目上限（超出丢最旧的）
  MAX_TEXT: 60, // 单段文本截断长度
  KEEP_DAYS: 7 // 保留天数（清理在 main/journal.js 做）
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期键：2026-10-15 */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地时刻：23:10 */
export function hhmm(ts = Date.now()) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function clip(s, n = JOURNAL.MAX_TEXT) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 归一化条目数组（读盘/写盘共用）：丢掉形状不对的，截断过长文本。
 * @param {Array} raw
 */
export function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const kind = typeof e.kind === 'string' ? e.kind : ''
    if (!kind) continue
    const t = Number.isFinite(e.t) ? e.t : null
    if (!t) continue
    out.push({
      t,
      kind,
      text: clip(e.text),
      user: e.user != null ? clip(e.user) : undefined,
      reply: e.reply != null ? clip(e.reply) : undefined
    })
  }
  return out
}

/**
 * 追加一条事件，返回新数组（纯函数，超上限丢最旧）。
 * @param {Array} entries
 * @param {{t?:number,kind:string,text?:string,user?:string,reply?:string}} evt
 */
export function appendEntry(entries = [], evt = {}, cap = JOURNAL.MAX_ENTRIES) {
  if (!evt || typeof evt.kind !== 'string' || !evt.kind) return entries
  const t = Number.isFinite(evt.t) ? evt.t : Date.now()
  const next = [
    ...entries,
    { t, kind: evt.kind, text: clip(evt.text), user: evt.user != null ? clip(evt.user) : undefined, reply: evt.reply != null ? clip(evt.reply) : undefined }
  ]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * 一条事件 → 一句人话（给日记生成的上下文用）。
 * @param {{t:number,kind:string,text?:string,user?:string,reply?:string}} evt
 */
export function eventLine(evt) {
  if (!evt || !evt.kind || !Number.isFinite(evt.t)) return ''
  const t = hhmm(evt.t)
  switch (evt.kind) {
    case 'chat': {
      const u = clip(evt.user, 50)
      const r = clip(evt.reply, 50)
      if (!u && !r) return ''
      return `${t} 他：${u || '（说了句什么）'}${r ? ' ／ 我：' + r : ''}`
    }
    case 'proactive':
      return evt.text ? `${t} 我忍不住开了口：${clip(evt.text, 50)}` : `${t} 我忍不住开了口`
    case 'reminder':
      return evt.text ? `${t} 我提醒他：${clip(evt.text, 50)}` : ''
    case 'poke':
      return `${t} 他戳了戳我`
    default:
      return evt.text ? `${t} ${clip(evt.text, 50)}` : ''
  }
}

/**
 * 该删哪些旧流水文件（保留最近 keepDays 天；返回日期键数组）。
 * @param {string[]} dates 文件名里的日期键（YYYY-MM-DD）
 */
export function pruneOld(dates = [], now = Date.now(), keepDays = JOURNAL.KEEP_DAYS) {
  const cutoff = dateKey(now - keepDays * 86400000)
  return (Array.isArray(dates) ? dates : [])
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => d < cutoff)
    .sort()
}
