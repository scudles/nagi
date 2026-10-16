// src/core/presence/traces.js
// 行动留痕（BLUE-3b）：把 hook 发来的 action-trace 规范化成可持久化、可被回忆引用的记录。
//
// 契约（§3.2 / §4）：
//   · 载荷形状固定 {kind:'action-trace',version:1,id,at,turnRef,toolCallId,tool,ok,
//     status,completionVerified,result:{summary}}；只在 raw 工具真正返回/抛错后才有事件；
//   · **不把 ok 当外部效果成功**——completionVerified 恒为 false，摘要只说「工具已返回」；
//   · 不携带完整 args、二进制、原始 stdout；摘要截断 240 字符；
//   · 有上限（条数 + 天数），每次追加都清理；蓝区落盘前仍须过授权与脱敏。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

export const TRACE_LIMITS = {
  /** 最多保留多少条（硬上限，超出丢最早的） */
  max: 200,
  /** 最多保留多少天 */
  maxAgeDays: 7,
  /** 摘要截断长度（契约写死的 240） */
  summaryMax: 240
}

const STATUS = ['returned', 'failed']

/** 单个字段的清洗：字符串、去控制字符、限长 */
function clean(value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return max && s.length > max ? s.slice(0, max) : s
}

/**
 * 规范化一条 action-trace。
 * @param {object} raw hook 载荷
 * @param {number} [now] 兜底时间（原始 at 非有限数时用）
 * @returns {object|null} null = 载荷非法（缺 id/tool 或 status 不在枚举内），调用方丢弃
 */
export function normalizeActionTrace(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind !== undefined && raw.kind !== 'action-trace') return null
  const id = clean(raw.id, 128)
  const tool = clean(raw.tool, 64)
  if (!id || !tool) return null
  const status = STATUS.includes(raw.status) ? raw.status : raw.ok === false ? 'failed' : 'returned'
  const at = Number.isFinite(raw.at) ? raw.at : now
  return {
    kind: 'action-trace',
    version: 1,
    id,
    at,
    turnRef: clean(raw.turnRef, 128) || null,
    toolCallId: clean(raw.toolCallId, 128) || null,
    tool,
    ok: raw.ok !== false,
    status,
    // 恒 false：工具返回不等于外部效果生效（契约红线，不允许上游改写）
    completionVerified: false,
    result: { summary: clean(raw.result?.summary, TRACE_LIMITS.summaryMax) },
    // 留痕是应用实际动作的观察记录，不是用户经历的记录
    provenance: 'action',
    canReference: true
  }
}

/** 记录是否过期（天数上限） */
function expired(trace, now, maxAgeDays) {
  const at = Number.isFinite(trace?.at) ? trace.at : 0
  return now - at > maxAgeDays * 86400000
}

/**
 * 追加一条留痕：按 id 幂等、按天数与条数上限清理。
 * @param {object[]} list 现有列表（不修改入参）
 * @param {object} trace normalizeActionTrace 的产物
 * @param {{now?:number,max?:number,maxAgeDays?:number}} [opts]
 * @returns {{list:object[],added:boolean,evicted:number}}
 */
export function appendTrace(list, trace, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const max = Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : TRACE_LIMITS.max
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : TRACE_LIMITS.maxAgeDays
  const base = (Array.isArray(list) ? list : []).filter((t) => t && t.id && !expired(t, now, maxAgeDays))
  if (!trace || !trace.id) return { list: base, added: false, evicted: 0 }
  if (base.some((t) => t.id === trace.id)) return { list: base, added: false, evicted: 0 }
  const next = [...base, trace]
  const evicted = Math.max(0, next.length - max)
  return { list: evicted ? next.slice(evicted) : next, added: true, evicted }
}

/**
 * 规范化整个列表（装载/清理用）：丢掉非法项、去重、按上限与天数裁剪。
 */
export function normalizeTraceList(raw, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  let out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = normalizeActionTrace(item, now)
    if (!t) continue
    out = appendTrace(out, t, opts).list
  }
  return out
}

/**
 * 供回忆引用的一条留痕：只带事实（工具名、时间、返回/失败、未核实）。
 * @returns {{id:string,text:string,at:number,tool:string,trust:'observed',completionVerified:false}|null}
 */
export function traceReference(trace) {
  if (!trace || !trace.id) return null
  const when = Number.isFinite(trace.at) ? new Date(trace.at).toLocaleString() : '某个时候'
  const outcome = trace.status === 'failed'
    ? '它返回了失败'
    : trace.ok === false
      ? '它没有成功跑完'
      : '它正常返回了'
  // 措辞刻意保守：只说「跑过 / 返回了」，不说「已经帮你做好了」——外部效果未核实。
  return {
    id: trace.id,
    at: trace.at,
    tool: trace.tool,
    trust: 'observed',
    completionVerified: false,
    text: `${when} 我帮你跑过 ${trace.tool}，${outcome}；外部效果没有核实。`
  }
}
