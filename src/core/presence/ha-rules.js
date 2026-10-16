// src/core/presence/ha-rules.js
// HA 规则引擎接口位（BLUE-3d）：把「设备信号 → 念头」这一步做成可测的纯函数。
//
// 契约（§4）：
//   · 配置 `presence.haRules = {enabled:false, rules:[]}`，**默认禁用**；本期只落契约与禁用态配置，
//     不接真机、不发任何请求；
//   · 规则只产生**候选**（Candidate），任何控制仍需按目标逐次授权；
//   · 禁止直调 HA REST；B06（extra 覆盖目标）缺口未修前不得启用主动控制。
//     因此本模块只输出「想做什么」，实体一律来自规则自身的 action.entityId，
//     不接受任何外部传入的覆盖字段。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。

export const HA_OPS = ['==', '!=', '<', '<=', '>', '>=']
/** 实体 ID 合法性（Home Assistant 的 domain.object_id 形式） */
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/i

export function emptyHaRulesConfig() {
  return { enabled: false, rules: [] }
}

/** 规范化规则列表：丢掉形状不对的规则，宁可少一条也不执行一条说不清的 */
export function normalizeHaRules(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).filter((r) => {
    if (!r || typeof r !== 'object') return false
    if (typeof r.id !== 'string' || !r.id) return false
    const w = r.when, a = r.action
    if (!w || typeof w !== 'object' || !ENTITY_RE.test(String(w.entityId || ''))) return false
    if (!HA_OPS.includes(w.op)) return false
    if (!(typeof w.value === 'number' || typeof w.value === 'string' || typeof w.value === 'boolean')) return false
    if (!a || typeof a !== 'object') return false
    if (typeof a.service !== 'string' || !a.service) return false
    if (!ENTITY_RE.test(String(a.entityId || ''))) return false
    return true
  }).map((r) => ({
    id: r.id,
    enabled: r.enabled !== false,
    when: { entityId: r.when.entityId, op: r.when.op, value: r.when.value },
    // 只取白名单字段：即便上游写了 entity_id 覆盖，也进不来
    action: { service: r.action.service, entityId: r.action.entityId }
  }))
  return { enabled: cfg.enabled === true, rules }
}

/** 读一次信号：signals 形如 { 'sensor.x': 23.5, 'binary_sensor.y': 'on' } */
function readSignal(signals, entityId) {
  if (!signals || typeof signals !== 'object') return undefined
  return signals[entityId]
}

function matches(op, actual, expected) {
  if (actual === undefined || actual === null) return false
  switch (op) {
    case '==': return String(actual) === String(expected)
    case '!=': return String(actual) !== String(expected)
    case '<': return Number(actual) < Number(expected)
    case '<=': return Number(actual) <= Number(expected)
    case '>': return Number(actual) > Number(expected)
    case '>=': return Number(actual) >= Number(expected)
    default: return false
  }
}

/**
 * 评估规则 → 候选列表。**只产候选**：不执行、不联网、不写设置。
 *
 * @param {{signals?:object,grants?:string[],now?:number,rules?:object,config?:object}} input
 *   config 可传 `presence.haRules` 整体（{enabled,rules}），也可传 {enabled} + rules 分开给
 *   grants：已获授权（逐个目标）的实体 ID 列表；未授权的候选仍产出但标记 requiresAuthorization
 * @returns {Array<{id,ruleId,entityId,service,reason,requiresAuthorization,at}>}
 */
export function evaluateHaRules({ signals = {}, grants = [], now = Date.now(), rules, config } = {}) {
  const source = config && typeof config === 'object' ? config : { enabled: false, rules: rules || [] }
  const cfg = normalizeHaRules(source)
  if (cfg.enabled !== true) return [] // 默认禁用：连候选都不产生
  const allowed = new Set((Array.isArray(grants) ? grants : []).filter((g) => typeof g === 'string' && g))
  const out = []
  for (const rule of cfg.rules) {
    if (!rule.enabled) continue
    const actual = readSignal(signals, rule.when.entityId)
    if (!matches(rule.when.op, actual, rule.when.value)) continue
    out.push({
      id: `${rule.id}:${rule.action.service}:${rule.action.entityId}`,
      ruleId: rule.id,
      entityId: rule.action.entityId,
      service: rule.action.service,
      reason: `${rule.when.entityId} ${rule.when.op} ${rule.when.value}`,
      // 逐次授权：没授权的只能算「想做的事」，绝不能直接执行
      requiresAuthorization: !allowed.has(rule.action.entityId),
      at: now
    })
  }
  return out
}
