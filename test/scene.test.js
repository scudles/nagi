// test/scene.test.js
// D2 场景化上下文（CONTRACTS §8 定版）：**只放有来源的事实**。
//
// 保护的不变量：
//   1) activity 只认三个白名单来源（monitor 分类 / media / simulated），且必须已授权、未过期；
//   2) 标题（foreground）不能升级成"他在做什么"的活动事实；
//   3) 未授权 / 过期 / 缺字段一律 null —— 宁缺勿造；
//   4) relevantMemoryRefs 只留未撤销且可追溯的引用。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCENE_ACTIVITY_TTL_MS,
  buildSceneContext,
  normalizeMemoryRefs,
  normalizeSceneActivity
} from '../src/core/context.js'

const NOW = new Date('2026-10-18T15:00:00').getTime()

const okActivity = (over = {}) => ({
  kind: 'app-category',
  value: '工作',
  at: NOW - 5000,
  origin: 'monitor',
  authorized: true,
  authorizedAt: NOW - 3600000,
  ...over
})

test('白名单来源：monitor / media / simulated 都可作为活动事实', () => {
  for (const origin of ['monitor', 'media', 'simulated']) {
    const a = normalizeSceneActivity(okActivity({ origin }), { now: NOW })
    assert.equal(a?.origin, origin)
    assert.equal(a.kind, 'app-category')
    assert.equal(a.value, '工作')
  }
})

test('标题不是活动事实：foreground 来源一律拒绝', () => {
  assert.equal(normalizeSceneActivity(okActivity({ origin: 'foreground', value: '某页面标题' }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ origin: 'title' }), { now: NOW }), null)
})

test('未授权 / 缺授权时间 / 过期 / 未来时间 / 空值 一律 null', () => {
  assert.equal(normalizeSceneActivity(okActivity({ authorized: false }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ authorized: undefined }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ authorizedAt: undefined }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ at: NOW - SCENE_ACTIVITY_TTL_MS - 1 }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ at: NOW + 5 * 60 * 1000 }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(okActivity({ value: '   ' }), { now: NOW }), null)
  assert.equal(normalizeSceneActivity(null, { now: NOW }), null)
})

test('活动值会被截断，不把长文本整段喂给模型', () => {
  const a = normalizeSceneActivity(okActivity({ value: 'x'.repeat(500) }), { now: NOW })
  assert.equal(a.value.length, 120)
})

test('记忆引用：撤权 / 不可追溯 / 无 id / 无来源 都剔除', () => {
  const refs = normalizeMemoryRefs([
    { id: 'm1', source: 'rag', text: '他喜欢下雨天' },
    { id: 'm2', source: 'rag', revoked: true },
    { id: 'm3', source: 'rag', traceable: false },
    { id: '', source: 'rag' },
    { id: 'm4' },
    { id: 'm5', source: 'journal', text: '上周去过那家店' }
  ])
  assert.deepEqual(refs.map((r) => r.id), ['m1', 'm5'])
  assert.equal(normalizeMemoryRefs(null).length, 0)
  // 有上限，不无限膨胀
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, source: 'rag' }))
  assert.equal(normalizeMemoryRefs(many).length, 8)
})

test('buildSceneContext：未授权时 activity 为 null，但仍给出时段与来源', () => {
  const scene = buildSceneContext({
    turnId: 't1',
    source: 'user',
    activity: okActivity({ authorized: false }),
    relationship: { level: { label: '熟悉' } },
    relevantMemoryRefs: [{ id: 'm1', source: 'rag' }],
    userNeed: 'listen',
    now: NOW
  })
  assert.equal(scene.turnId, 't1')
  assert.equal(scene.source, 'user')
  assert.equal(scene.activity, null, '未授权不得当事实')
  assert.ok(scene.timeSlot && scene.timeSlot.length > 0)
  assert.equal(scene.relationship.level.label, '熟悉')
  assert.deepEqual(scene.relevantMemoryRefs.map((r) => r.id), ['m1'])
  assert.equal(scene.userNeed, 'listen')
})

test('buildSceneContext：授权且新鲜的活动才进上下文', () => {
  const scene = buildSceneContext({ turnId: 't2', activity: okActivity(), now: NOW })
  assert.equal(scene.activity.origin, 'monitor')
  assert.equal(scene.userNeed, null)
})

/* ---------------- D2：事实 / 表达材料分离 ---------------- */

test('sceneFactsBlock：只写可证实事实，并声明材料只能参考', async () => {
  const { sceneFactsBlock } = await import('../src/core/context.js')
  const scene = buildSceneContext({
    turnId: 't3',
    activity: okActivity({ origin: 'simulated', value: '离开 12 分钟' }),
    relationship: { level: { label: '熟悉' }, daysKnown: 12 },
    relevantMemoryRefs: [{ id: 'm1', source: 'rag' }],
    now: NOW
  })
  const block = sceneFactsBlock(scene)
  assert.match(block, /【可证实的事实】/)
  assert.match(block, /表达材料/)
  assert.match(block, /模拟状态，不是他真实经历/, 'simulated 必须标源，不许说成真实经历')
  assert.match(block, /认识 12 天/)
  // 事实段里不许混进任何记忆正文
  assert.equal(/他喜欢下雨天/.test(block), false)
})

test('sceneFactsBlock：没有事实时返回空串（调用方不要塞空段）', async () => {
  const { sceneFactsBlock } = await import('../src/core/context.js')
  assert.equal(sceneFactsBlock(null), '')
  assert.equal(sceneFactsBlock({}), '')
})

/* ---------------- D2：三类来源的挑选（媒体 > monitor > 模拟） ---------------- */

test('媒体优先，且播放/暂停照实标（不能把暂停说成正在播）', async () => {
  const { pickSceneActivity } = await import('../src/core/context.js')
  const media = (playbackStatus) => ({
    authorized: true,
    authorizedAt: NOW - 3600000,
    observation: { available: true, title: '某一首歌', artist: '某人', playbackStatus, observedAt: NOW - 5000 }
  })
  const playing = pickSceneActivity({
    media: media('playing'),
    monitor: { category: 'work', at: NOW - 5000, authorizedAt: NOW - 3600000 },
    now: NOW
  })
  assert.equal(playing.origin, 'media')
  assert.match(playing.value, /^正在播放：/)
  assert.match(playing.value, /某一首歌 \/ 某人/)

  const paused = pickSceneActivity({ media: media('paused'), now: NOW })
  assert.match(paused.value, /^已暂停：/, '暂停必须照实写')
})

test('媒体未授权/被勿扰暂停/观测过期 → 退回 monitor 分类，绝不编造', async () => {
  const { pickSceneActivity } = await import('../src/core/context.js')
  const monitor = { category: 'video', at: NOW - 2000, authorizedAt: NOW - 3600000 }
  const unauthed = pickSceneActivity({
    media: { authorized: false, observation: { available: true, title: 'x', playbackStatus: 'playing', observedAt: NOW } },
    monitor,
    now: NOW
  })
  assert.equal(unauthed.origin, 'monitor')
  assert.equal(unauthed.value, '在看视频')

  const dnd = pickSceneActivity({
    media: { authorized: true, paused: 'do-not-disturb', authorizedAt: NOW - 1000, observation: { available: true, title: 'x', playbackStatus: 'playing', observedAt: NOW } },
    monitor,
    now: NOW
  })
  assert.equal(dnd.origin, 'monitor')

  const stale = pickSceneActivity({
    media: null,
    monitor: { ...monitor, at: NOW - SCENE_ACTIVITY_TTL_MS - 1 },
    presence: null,
    now: NOW
  })
  assert.equal(stale, null, '过期事实一律 null')
})

test('monitor 缺授权时间时不冒充（返回模拟或 null，不用当前时间顶替）', async () => {
  const { pickSceneActivity } = await import('../src/core/context.js')
  const noAuth = pickSceneActivity({ monitor: { category: 'work', at: NOW - 1000, authorizedAt: 0 }, now: NOW })
  assert.equal(noAuth, null)
  const simulated = pickSceneActivity({
    monitor: { category: 'work', at: NOW - 1000, authorizedAt: 0 },
    presence: { value: '电脑离开过一段时间', at: NOW - 1000, authorizedAt: NOW - 5000 },
    now: NOW
  })
  assert.equal(simulated.origin, 'simulated', '模拟活动必须标源')
})

test('标题不参与活动事实：即使传了 foreground 形状也进不来', async () => {
  const { pickSceneActivity } = await import('../src/core/context.js')
  const out = pickSceneActivity({
    media: null,
    monitor: { category: 'other', at: NOW, authorizedAt: NOW - 1000, title: '某页面标题' },
    now: NOW
  })
  assert.equal(out.value, '在用电脑')
  assert.equal(out.value.includes('某页面标题'), false)
})
