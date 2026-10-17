// test/anchors.test.js
// BLUE-3c/3d 回归锁：回忆物锚点（来源重验 + 熟悉度门槛 + ≤5% + 每天≤1）与 HA 规则接口位
// （默认禁用、只产候选、逐次授权标记、不接受外部覆盖字段）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_LIMITS,
  PRIVATE_ANCHOR_MIN_LEVEL,
  familiarityRank,
  isLevelAtLeast,
  listAnchors,
  sortAnchorsByTime,
  groupAnchorsByDay,
  decideAnchorReference,
  normalizeAnchorState,
  emptyAnchorState
} from '../src/core/presence/anchors.js'
import {
  normalizeHaRules,
  evaluateHaRules,
  HA_OPS
} from '../src/core/presence/ha-rules.js'

const T0 = Date.UTC(2026, 9, 17, 3, 0, 0)
const MIN = 60 * 1000
const ON = { anchorsEnabled: true }

/* ---------------- 回忆物：来源重验 ---------------- */

const ANCHORS = [
  { id: 'a-first', kind: 'first-contact', sourceIds: ['mem-1'], occurredAt: T0 - 86400000, trust: 'observed', text: '第一次见面' },
  { id: 'a-nick', kind: 'nickname', sourceIds: ['mem-2'], occurredAt: T0 - 3600000, trust: 'user-stated', text: '他让我这么叫' },
  { id: 'a-shared', kind: 'shared-reference', sourceIds: ['mem-3'], occurredAt: T0 - 7200000, trust: 'subjective', text: '一起看过的片子' }
]
/** 当前可访问的来源登记表 */
const EVIDENCE = [
  { id: 'mem-1' },
  { id: 'mem-2' },
  { id: 'mem-3', deletedAt: T0 - 60 * MIN }
]

test('默认关闭 / 未开启 anchorsEnabled → 空列表', () => {
  assert.deepEqual(listAnchors({ now: T0, relationLevel: 'intimate', anchors: ANCHORS, evidence: EVIDENCE, config: {} }), [])
  assert.deepEqual(listAnchors({ now: T0, relationLevel: 'intimate', anchors: ANCHORS, evidence: EVIDENCE, config: { anchorsEnabled: false } }), [])
})

test('已删除来源的锚点不出现（来源被撤回就整条消失）', () => {
  const out = listAnchors({ now: T0, relationLevel: 'intimate', anchors: ANCHORS, evidence: EVIDENCE, config: ON })
  assert.deepEqual(out.map((a) => a.id), ['a-first', 'a-nick'])
})

test('来源 ID 不在登记表里（不可访问）→ 该锚点不可用', () => {
  const orphan = [{ id: 'a9', kind: 'nickname', sourceIds: ['missing'], occurredAt: T0, trust: 'observed' }]
  assert.deepEqual(listAnchors({ now: T0, relationLevel: 'intimate', anchors: orphan, evidence: EVIDENCE, config: ON }), [])
})

test('熟悉度门槛：私密锚点要够熟，陌生时只剩 first-contact', () => {
  assert.equal(PRIVATE_ANCHOR_MIN_LEVEL, 'familiar')
  const stranger = listAnchors({ now: T0, relationLevel: 'stranger', anchors: ANCHORS, evidence: EVIDENCE, config: ON })
  assert.deepEqual(stranger.map((a) => a.id), ['a-first'])
  const familiar = listAnchors({ now: T0, relationLevel: 'familiar', anchors: ANCHORS, evidence: EVIDENCE, config: ON })
  assert.deepEqual(familiar.map((a) => a.id), ['a-first', 'a-nick'])
})

test('信任度/种类非法 → 丢弃；等级比较函数单调', () => {
  const bad = [
    { id: 'x1', kind: 'nope', sourceIds: ['mem-1'], trust: 'observed' },
    { id: 'x2', kind: 'nickname', sourceIds: ['mem-1'], trust: 'made-up' },
    { id: 'x3', kind: 'nickname', sourceIds: [], trust: 'observed' }
  ]
  assert.deepEqual(listAnchors({ now: T0, relationLevel: 'intimate', anchors: bad, evidence: EVIDENCE, config: ON }), [])
  assert.ok(familiarityRank('intimate') > familiarityRank('close'))
  assert.ok(isLevelAtLeast('close', 'familiar'))
  assert.equal(isLevelAtLeast('acquaintance', 'familiar'), false)
  assert.equal(isLevelAtLeast('unknown-key', 'familiar'), false)
})

/* ---------------- 回忆物：概率门与每日上限 ---------------- */

const POOL = () => ({ anchors: ANCHORS, evidence: EVIDENCE, config: ON, relationLevel: 'intimate' })

test('概率门：roll ≥ p 不引用，不给第二次机会、不改内容', () => {
  const miss = decideAnchorReference({ ...POOL(), now: T0, state: emptyAnchorState(T0), rng: () => 0.5 })
  assert.equal(miss.anchor, null)
  assert.equal(miss.reason, 'probability')
  assert.equal(miss.state.count, 0, '没提就不记账')
  const hit = decideAnchorReference({ ...POOL(), now: T0, state: emptyAnchorState(T0), rng: () => 0.01 })
  assert.equal(hit.reason, 'accepted')
  assert.equal(hit.anchor.id, 'a-first')
})

test('概率上限写死 5%：配置写大了也按 5% 生效', () => {
  assert.equal(ANCHOR_LIMITS.referenceProbability, 0.05)
  const big = { ...POOL(), config: { ...ON, anchorProbability: 0.9 } }
  // 0.04 < 0.05 → 通过；0.06 ≥ 0.05 → 不通过（若没夹住，0.06 < 0.9 就会被误导通过）
  const pass = decideAnchorReference({ ...big, now: T0, state: emptyAnchorState(T0), rng: () => 0.04 })
  assert.equal(pass.reason, 'accepted')
  const blocked = decideAnchorReference({ ...big, now: T0, state: emptyAnchorState(T0), rng: () => 0.06 })
  assert.equal(blocked.reason, 'probability')
})

test('每天最多 1 次；跨日期重置', () => {
  const first = decideAnchorReference({ ...POOL(), now: T0, state: emptyAnchorState(T0), rng: () => 0 })
  assert.equal(first.reason, 'accepted')
  const second = decideAnchorReference({ ...POOL(), now: T0 + 5 * MIN, state: first.state, rng: () => 0 })
  assert.equal(second.reason, 'daily-limit')
  assert.equal(second.anchor, null)
  const nextDay = decideAnchorReference({ ...POOL(), now: T0 + 24 * 60 * MIN, state: second.state, rng: () => 0 })
  assert.equal(nextDay.reason, 'accepted')
})

test('没有可用锚点时不掷骰子（不为凑概率制造回忆）', () => {
  let called = 0
  const rng = () => { called++; return 0 }
  // 陌生等级下 first-contact 仍可用 → 会掷
  const usable = decideAnchorReference({ anchors: ANCHORS, evidence: EVIDENCE, now: T0, state: emptyAnchorState(T0), config: ON, relationLevel: 'stranger', rng })
  assert.equal(usable.reason, 'accepted')
  // 全部来源被删 → 没有可用锚点，连 rng 都不该调用
  const deleted = EVIDENCE.map((e) => ({ ...e, deletedAt: T0 }))
  const none = decideAnchorReference({ anchors: ANCHORS, evidence: deleted, now: T0, state: emptyAnchorState(T0), config: ON, relationLevel: 'intimate', rng })
  assert.equal(none.reason, 'no-anchor')
  assert.equal(called, 1, '无锚点时不得调用 rng')
})

test('状态规范化容错', () => {
  const s = normalizeAnchorState({ dayKey: 1, count: -5, lastAt: NaN, lastAnchorId: 7 }, T0)
  assert.equal(typeof s.dayKey, 'string')
  assert.equal(s.count, 0)
  assert.equal(s.lastAt, 0)
  assert.equal(s.lastAnchorId, null)
})

/* ---------------- HA 规则接口位 ---------------- */

const RULES = {
  enabled: true,
  rules: [
    { id: 'r1', enabled: true, when: { entityId: 'sensor.temp', op: '>', value: 30 }, action: { service: 'turn_on', entityId: 'fan.living_room' } },
    { id: 'r2', enabled: true, when: { entityId: 'binary_sensor.door', op: '==', value: 'on' }, action: { service: 'turn_on', entityId: 'light.hall' } },
    { id: 'r3', enabled: false, when: { entityId: 'sensor.temp', op: '>', value: 0 }, action: { service: 'turn_on', entityId: 'switch.x' } }
  ]
}

test('默认禁用：即便有规则也不产生候选', () => {
  assert.deepEqual(evaluateHaRules({ signals: { 'sensor.temp': 35 }, config: { enabled: false, rules: RULES.rules } }), [])
  assert.deepEqual(evaluateHaRules({ signals: { 'sensor.temp': 35 } }), [])
})

test('启用后按条件产候选；关闭的规则不产', () => {
  const out = evaluateHaRules({ signals: { 'sensor.temp': 35 }, now: T0, config: RULES })
  assert.equal(out.length, 1)
  assert.equal(out[0].entityId, 'fan.living_room')
  assert.equal(out[0].ruleId, 'r1')
  assert.equal(out[0].service, 'turn_on')
})

test('未授权目标：候选仍产出但标记 requiresAuthorization（逐次授权，绝不直接执行）', () => {
  const out = evaluateHaRules({ signals: { 'sensor.temp': 35 }, grants: [], now: T0, config: RULES })
  assert.equal(out[0].requiresAuthorization, true)
  const granted = evaluateHaRules({ signals: { 'sensor.temp': 35 }, grants: ['fan.living_room'], now: T0, config: RULES })
  assert.equal(granted[0].requiresAuthorization, false)
})

test('信号缺失/条件不满足 → 无候选', () => {
  assert.deepEqual(evaluateHaRules({ signals: {}, now: T0, config: RULES }), [])
  assert.deepEqual(evaluateHaRules({ signals: { 'sensor.temp': 10 }, now: T0, config: RULES }), [])
})

test('规范化只留白名单字段：外部覆盖字段与非法实体进不来', () => {
  const dirty = {
    enabled: true,
    rules: [
      { id: 'bad1', when: { entityId: 'not-an-entity', op: '>' , value: 1 }, action: { service: 'turn_on', entityId: 'light.a' } },
      { id: 'bad2', when: { entityId: 'sensor.a', op: '~~', value: 1 }, action: { service: 'turn_on', entityId: 'light.a' } },
      { id: 'ok', when: { entityId: 'sensor.a', op: '>', value: 1, extra: { entity_id: 'lock.front_door' } }, action: { service: 'turn_on', entityId: 'light.a', data: { entity_id: 'lock.front_door' } } }
    ]
  }
  const cfg = normalizeHaRules(dirty)
  assert.deepEqual(cfg.rules.map((r) => r.id), ['ok'])
  assert.deepEqual(Object.keys(cfg.rules[0].when), ['entityId', 'op', 'value'])
  assert.deepEqual(Object.keys(cfg.rules[0].action), ['service', 'entityId'])
  const out = evaluateHaRules({ signals: { 'sensor.a': 5 }, config: dirty })
  assert.equal(out.length, 1)
  assert.equal(out[0].entityId, 'light.a', '实体只能来自规则自身 action.entityId')
  assert.equal(JSON.stringify(out[0]).includes('lock.front_door'), false)
})

test('操作符枚举固定', () => {
  assert.deepEqual(HA_OPS, ['==', '!=', '<', '<=', '>', '>='])
})

/* ---------------- 时间线视图（D 项，只读） ---------------- */

const T = (n) => Date.UTC(2026, 9, 17) + n * 86400000 // 10-17 起算的第 n 天

test('时间线排序：最近的在前，且不修改入参', () => {
  const input = [{ id: 'a', occurredAt: T(0) }, { id: 'c', occurredAt: T(2) }, { id: 'b', occurredAt: T(1) }]
  const frozen = JSON.parse(JSON.stringify(input))
  const sorted = sortAnchorsByTime(input)
  assert.deepEqual(sorted.map((x) => x.id), ['c', 'b', 'a'])
  assert.deepEqual(input, frozen, '不得就地修改入参数组')
})

test('时间缺失/非法：排最后、保持原相对顺序、不补默认值', () => {
  const input = [
    { id: 'no-time' },
    { id: 'bad', occurredAt: 'yesterday' },
    { id: 'nan', occurredAt: NaN },
    { id: 'ok', occurredAt: T(0) },
    { id: 'no-time-2' }
  ]
  const sorted = sortAnchorsByTime(input)
  assert.equal(sorted.at(-1).id, 'no-time-2')
  assert.deepEqual(sorted.slice(0, 1).map((x) => x.id), ['ok'])
  assert.deepEqual(sorted.slice(1).map((x) => x.id), ['no-time', 'bad', 'nan', 'no-time-2'])
  // 不猜时间：occurredAt 仍是原样，没被填成 now
  assert.equal(sorted.find((x) => x.id === 'no-time').occurredAt, undefined)
})

test('按天分组：同一天聚在一起，组内时间倒序', () => {
  const input = [
    { id: 'a', occurredAt: T(0) + 3600000 },
    { id: 'b', occurredAt: T(1) },
    { id: 'c', occurredAt: T(0) },
    { id: 'd', occurredAt: T(1) + 7200000 }
  ]
  const groups = groupAnchorsByDay(input)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].items.map((x) => x.id), ['d', 'b'], '10-19 组内倒序')
  assert.deepEqual(groups[1].items.map((x) => x.id), ['a', 'c'], '10-18 组内倒序')
  for (const g of groups) assert.match(g.day, /^\d{4}-\d{2}-\d{2}$/)
})

test('按天分组：时间不明单独一组，day 为空串', () => {
  const groups = groupAnchorsByDay([{ id: 'x' }, { id: 'y', occurredAt: T(0) }])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].day !== '', true)
  assert.equal(groups[1].day, '')
  assert.deepEqual(groups[1].items.map((x) => x.id), ['x'])
})

test('时间线是只读的：不产生新锚点、不改变任何字段', () => {
  const input = [{ id: 'a', kind: 'nickname', trust: 'user-stated', occurredAt: T(0), text: '小名' }]
  const out = sortAnchorsByTime(input)
  assert.equal(out.length, input.length)
  assert.deepEqual(out[0], input[0])
  // 脏输入安全
  assert.deepEqual(sortAnchorsByTime(null), [])
  assert.deepEqual(sortAnchorsByTime([null, undefined, 'x']).length, 3)
  assert.deepEqual(groupAnchorsByDay(undefined), [])
})
