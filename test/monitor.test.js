// test/monitor.test.js
// M3 活动监测单测：隐私护栏 / 统计器 / 规则库 / 节流 / 编排引擎。
// 全部纯逻辑 + 假时钟，无时间依赖 flaky。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { matchPattern, isBlocked, gateSample, redact, collectionAllowed, DEFAULT_BLACKLIST, repairBlacklist } from '../src/core/monitor/privacy.js'
import { createTracker, classify, CATEGORY } from '../src/core/monitor/tracker.js'
import { evaluateRules, RULE_PARAMS } from '../src/core/monitor/rules.js'
import { createThrottle, MIN_GAP_MS } from '../src/core/monitor/throttle.js'
import { createMonitorEngine } from '../src/core/monitor/engine.js'

function fakeClock(start = '2026-10-14T14:00:00') {
  let t = new Date(start).getTime()
  return { now: () => t, advance: (ms) => { t += ms } }
}

/* ================= 隐私护栏 ================= */

test('matchPattern：裸词=包含，带 *=通配且锚定', () => {
  assert.equal(matchPattern('Hello World', 'world'), true) // 大小写不敏感
  assert.equal(matchPattern('我的银行账户', '银行'), true) // 裸词子串
  assert.equal(matchPattern('*密码*'.replace(/\*/g, ''), '密码'), true)
  assert.equal(matchPattern('登录 - 密码', '*密码*'), true)
  assert.equal(matchPattern('密码管理器', '密码*'), true) // 以「密码」开头
  assert.equal(matchPattern('我的密码', '密码*'), false) // 锚定开头，不误伤
  assert.equal(matchPattern('输入密码', '*密码'), true) // 以「密码」结尾
  assert.equal(matchPattern('任意文本', ''), false) // 空模式
  assert.equal(matchPattern('', '密码'), false) // 空文本
})

test('isBlocked：app 名与窗口标题一起匹配', () => {
  assert.equal(isBlocked({ app: 'chrome', title: '银行转账' }, ['*银行*']), true)
  assert.equal(isBlocked({ app: '1Password', title: '' }, ['*1password*']), true)
  assert.equal(isBlocked({ app: 'vscode', title: 'main.js' }, ['*银行*', '*密码*']), false)
  assert.equal(isBlocked({ app: 'vscode', title: 'x' }, []), false)
  assert.equal(isBlocked(null, ['x']), false)
})

test('gateSample：开关 / 勿扰 / 黑名单三态', () => {
  const sample = { app: 'chrome', title: '网银 - 密码' }
  assert.equal(gateSample(sample, { monitorEnabled: false }).reason, 'disabled')
  assert.equal(gateSample(sample, { monitorEnabled: true, doNotDisturb: true }).reason, 'dnd')
  assert.equal(gateSample(sample, { monitorEnabled: true, blacklist: ['*密码*'] }).reason, 'blacklist')
  assert.equal(gateSample(sample, { monitorEnabled: true, blacklist: [] }).skip, false)
})

test('redact：对外不泄露 app 名与标题原文', () => {
  const r = redact({ ts: 1, idleSec: 3, app: 'chrome', title: '银行转账', category: 'browser' })
  assert.deepEqual(r, { ts: 1, idleSec: 3, app: null, category: 'browser' })
  assert.equal(redact(null), null)
})

test('默认黑名单覆盖密码/银行/隐私类关键词', () => {
  assert.ok(DEFAULT_BLACKLIST.some((p) => matchPattern('password', p)))
  assert.ok(DEFAULT_BLACKLIST.some((p) => matchPattern('招商银行', p)))
  assert.ok(DEFAULT_BLACKLIST.some((p) => matchPattern('无痕窗口', p)))
})

test('repairBlacklist：旧版写入的乱码黑名单被还原，正常自定义保留', () => {
  // 旧版本把中文以「UTF-8 字节当 GBK 读」的形态落盘（*密码* → *瀵嗙爜*）
  const mojibake = new TextDecoder('gbk').decode(Buffer.from('*密码*', 'utf8'))
  const dirty = ['*瀵嗙爜*', '*password*']
  assert.notEqual(mojibake, '*密码*')
  const fixed = repairBlacklist([mojibake, '*password*'], DEFAULT_BLACKLIST)
  assert.deepEqual(fixed, DEFAULT_BLACKLIST)
  // 用户自定义（非乱码）条目必须原样保留
  const custom = ['*我的私密文档*', '*password*']
  assert.deepEqual(repairBlacklist(custom, DEFAULT_BLACKLIST), custom)
  // 空值 → 默认
  assert.deepEqual(repairBlacklist(null, DEFAULT_BLACKLIST), DEFAULT_BLACKLIST)
  assert.deepEqual(repairBlacklist([], DEFAULT_BLACKLIST), DEFAULT_BLACKLIST)
  // 还原后中文规则真的能匹配上（乱码时匹配不上）
  assert.ok(!DEFAULT_BLACKLIST.some((p) => matchPattern('瀵嗙爜', p)))
  assert.ok(fixed.some((p) => matchPattern('我的密码本', p)))
})

/* ================= 统计器 ================= */

test('classify：app 优先于标题，未知归 other', () => {
  assert.equal(classify({ app: 'Code', title: 'main.js' }), CATEGORY.WORK)
  assert.equal(classify({ app: 'chrome', title: 'steam 商店' }), CATEGORY.BROWSER) // app 先匹配
  assert.equal(classify({ app: 'unknown.exe', title: '原神 - 启动器' }), CATEGORY.GAMING) // 回落标题
  assert.equal(classify({ app: 'foo', title: 'bar' }), CATEGORY.OTHER)
  assert.equal(classify(null), CATEGORY.OTHER)
})

test('tracker：连续活跃累计 sessionMinutes', () => {
  const clock = fakeClock()
  const tk = createTracker({ now: clock.now })
  tk.record({ ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' })
  clock.advance(95 * 60000)
  tk.record({ ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' })
  const s = tk.stats()
  assert.equal(s.active, true)
  assert.equal(s.sessionMinutes, 95)
  assert.equal(s.category, CATEGORY.WORK)
})

test('tracker：离开再回来 → justReturned + awayMinutes', () => {
  const clock = fakeClock()
  const tk = createTracker({ now: clock.now })
  tk.record({ ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' })
  clock.advance(10 * 60000)
  const ev1 = tk.record({ ts: clock.now(), idleSec: 400, app: 'Code', title: 'x' }) // 空闲 400s ≥ 300 → 离开
  assert.equal(ev1.returned, false)
  assert.equal(tk.stats().active, false)
  clock.advance(1000)
  const ev2 = tk.record({ ts: clock.now(), idleSec: 0, app: 'Code', title: 'x' }) // 回来
  assert.equal(ev2.returned, true)
  const s = tk.stats()
  assert.equal(s.justReturned, true)
  assert.ok(s.awayMinutes > 6 && s.awayMinutes < 7) // ≈ 400s
})

test('tracker：切换类别重置 categoryStreakMin', () => {
  const clock = fakeClock()
  const tk = createTracker({ now: clock.now })
  tk.record({ ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' })
  clock.advance(70 * 60000)
  tk.record({ ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' })
  assert.equal(Math.round(tk.stats().categoryStreakMin), 70)
  tk.record({ ts: clock.now(), idleSec: 5, app: 'steam', title: 'CS2' })
  assert.equal(tk.stats().category, CATEGORY.GAMING)
  assert.equal(Math.round(tk.stats().categoryStreakMin), 0)
})

/* ================= 规则库 ================= */

const BASE_STATS = {
  ts: new Date('2026-10-14T14:00:00').getTime(),
  hour: 14,
  active: true,
  sessionMinutes: 10,
  awayMinutes: 0,
  category: 'other',
  categoryStreakMin: 0,
  justReturned: false,
  samples: 1
}
const hitId = (patch) => {
  const r = evaluateRules({ ...BASE_STATS, ...patch })
  return r ? r.rule.id : null
}

test('规则：深夜还在用 → late_night_awake', () => {
  assert.equal(hitId({ hour: 2 }), 'late_night_awake')
  assert.equal(hitId({ hour: 4 }), 'late_night_awake')
  assert.equal(hitId({ hour: 6 }), null) // 5 点以后不劝睡
  assert.equal(hitId({ hour: 2, active: false }), null) // 不在电脑前不触发
})

test('规则：久坐 → sit_too_long（游戏/视频除外）', () => {
  assert.equal(hitId({ sessionMinutes: RULE_PARAMS.SIT_MIN + 5, category: 'work' }), 'sit_too_long')
  assert.equal(hitId({ sessionMinutes: RULE_PARAMS.SIT_MIN - 5, category: 'work' }), null)
  // 游戏久坐交给游戏规则，不重复念叨
  assert.equal(hitId({ sessionMinutes: RULE_PARAMS.SIT_MIN + 5, category: 'gaming' }), null)
})

test('规则：连续游戏 / 视频 → puzzled', () => {
  assert.equal(hitId({ category: 'gaming', categoryStreakMin: RULE_PARAMS.GAMING_MIN + 1 }), 'gaming_too_long')
  assert.equal(hitId({ category: 'gaming', categoryStreakMin: RULE_PARAMS.GAMING_MIN - 1 }), null)
  assert.equal(hitId({ category: 'video', categoryStreakMin: RULE_PARAMS.VIDEO_MIN + 1 }), 'video_too_long')
})

test('规则：离开又回来 → welcome_back（优先级最高）', () => {
  assert.equal(hitId({ justReturned: true, awayMinutes: RULE_PARAMS.AWAY_MIN + 2 }), 'welcome_back')
  assert.equal(hitId({ justReturned: true, awayMinutes: RULE_PARAMS.AWAY_MIN - 2 }), null) // 走太短不打招呼
})

test('规则：深度专注 → deep_focus（低优先，最后兜底）', () => {
  assert.equal(hitId({ category: 'work', categoryStreakMin: RULE_PARAMS.DEEP_FOCUS_MIN + 1 }), 'deep_focus')
})

test('规则：平静状态不触发任何规则', () => {
  assert.equal(evaluateRules({ ...BASE_STATS }), null)
})

/* ================= 节流 ================= */

test('节流：全局最小间隔拦住连珠炮', () => {
  const clock = fakeClock()
  const th = createThrottle({ now: clock.now })
  const rule = { id: 'r', cooldownMin: 0, dailyLimit: 0 }
  assert.equal(th.allow(rule), true)
  th.note(rule)
  assert.equal(th.allow(rule), false) // 同刻第二发被全局间隔拦
  clock.advance(MIN_GAP_MS + 1)
  assert.equal(th.allow(rule), true)
})

test('节流：单规则冷却', () => {
  const clock = fakeClock()
  const th = createThrottle({ now: clock.now, minGapMs: 0 })
  const rule = { id: 'r', cooldownMin: 30, dailyLimit: 0 }
  assert.equal(th.allow(rule), true)
  th.note(rule)
  clock.advance(10 * 60000)
  assert.equal(th.allow(rule), false) // 冷却 30 分钟未过
  clock.advance(21 * 60000)
  assert.equal(th.allow(rule), true)
})

test('节流：每日上限 + 跨日重置', () => {
  const clock = fakeClock()
  const th = createThrottle({ now: clock.now, minGapMs: 0 })
  const rule = { id: 'r', cooldownMin: 0, dailyLimit: 2 }
  th.note(rule)
  th.note(rule)
  assert.equal(th.allow(rule), false) // 已达上限 2
  clock.advance(24 * 3600 * 1000) // 次日
  assert.equal(th.allow(rule), true)
})

/* ================= 编排引擎（端到端，全假实现） ================= */

function engineWith({ sample, privacy, pickText = () => '[x]', clock }) {
  const fired = []
  const eng = createMonitorEngine({
    sampler: { async sample() { return typeof sample === 'function' ? sample() : sample } },
    getPrivacy: () => privacy,
    pickText,
    onProactive: (p) => fired.push(p),
    now: clock.now
  })
  return { eng, fired }
}

test('engine：开关关闭 / 勿扰 → 直接跳过，不采样不触发', async () => {
  const clock = fakeClock('2026-10-14T02:30:00')
  const e1 = engineWith({ sample: { ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' }, privacy: { monitorEnabled: false }, clock })
  assert.equal((await e1.eng.tickOnce()).skipped, 'disabled')
  const e2 = engineWith({ sample: { ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' }, privacy: { monitorEnabled: true, doNotDisturb: true }, clock })
  assert.equal((await e2.eng.tickOnce()).skipped, 'dnd')
  assert.equal(e1.fired.length + e2.fired.length, 0)
  const e3 = engineWith({ sample: { ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' }, privacy: { onlyPresence: true }, clock })
  assert.equal((await e3.eng.tickOnce()).skipped, 'only-presence')
})

test('engine：主进程因打扰预算拒绝开口时，不记作送达或消耗规则冷却', async () => {
  const clock = fakeClock('2026-10-14T02:30:00')
  let attempts = 0
  const eng = createMonitorEngine({
    sampler: { async sample() { return { ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' } } },
    getPrivacy: () => ({}), pickText: () => '候选台词', now: clock.now,
    onProactive: () => { attempts++; return false }
  })
  assert.equal((await eng.tickOnce()).suppressed, 'late_night_awake')
  assert.equal((await eng.tickOnce()).suppressed, 'late_night_awake')
  assert.equal(attempts, 2)
  assert.equal(eng.snapshot(), null)
})

test('engine：黑名单样本被丢弃', async () => {
  const clock = fakeClock('2026-10-14T02:30:00')
  const { eng, fired } = engineWith({
    sample: { ts: clock.now(), idleSec: 5, app: 'chrome', title: '网银 - 密码' },
    privacy: { monitorEnabled: true, blacklist: ['*密码*'] },
    clock
  })
  assert.equal((await eng.tickOnce()).skipped, 'blacklist')
  assert.equal(fired.length, 0)
})

test('engine：深夜还在用 → 触发一次主动搭话，第二次同刻被节流', async () => {
  const clock = fakeClock('2026-10-14T02:30:00')
  const { eng, fired } = engineWith({
    sample: { ts: clock.now(), idleSec: 5, app: 'Code', title: 'main.js' },
    privacy: { monitorEnabled: true, blacklist: [] },
    pickText: (pool) => `[${pool}]`,
    clock
  })
  const r1 = await eng.tickOnce()
  assert.equal(r1.ruleId, 'late_night_awake')
  assert.equal(fired.length, 1)
  assert.equal(fired[0].mood, 'worry')
  assert.equal(fired[0].text, '[lateNight]')
  const r2 = await eng.tickOnce()
  assert.equal(r2.throttled, 'late_night_awake')
  assert.equal(fired.length, 1)
})

test('engine：选不出台词则不发（不消耗节流额度）', async () => {
  const clock = fakeClock('2026-10-14T02:30:00')
  const { eng, fired } = engineWith({
    sample: { ts: clock.now(), idleSec: 5, app: 'Code', title: 'x' },
    privacy: { monitorEnabled: true, blacklist: [] },
    pickText: () => '',
    clock
  })
  const r = await eng.tickOnce()
  assert.equal(r.empty, 'late_night_awake')
  assert.equal(fired.length, 0)
})

test('engine：采样失败不抛错，返回 error', async () => {
  const clock = fakeClock()
  const eng = createMonitorEngine({
    sampler: { async sample() { throw new Error('boom') } },
    getPrivacy: () => ({ monitorEnabled: true }),
    now: clock.now
  })
  const r = await eng.tickOnce()
  assert.equal(r.error, 'sample')
})

/* ================= 停采：关掉就不看（真机验证沉淀） ================= */

test('collectionAllowed：关闭监测 / 勿扰时不采', () => {
  assert.equal(collectionAllowed({ monitorEnabled: true }), true)
  assert.equal(collectionAllowed({ monitorEnabled: true, doNotDisturb: false }), true)
  assert.equal(collectionAllowed({ monitorEnabled: false }), false)
  assert.equal(collectionAllowed({ monitorEnabled: true, doNotDisturb: true }), false)
  assert.equal(collectionAllowed({}), true) // 缺省视为允许（与 gateSample 一致）
})

test('engine：关闭监测时「不采样」而不是采完丢弃', async () => {
  let sampled = 0
  const eng = createMonitorEngine({
    sampler: { async sample() { sampled++; return { ts: 0, idleSec: 0, app: 'x', title: 'y' } } },
    getPrivacy: () => ({ monitorEnabled: false })
  })
  const r = await eng.tickOnce()
  assert.equal(r.skipped, 'disabled')
  assert.equal(sampled, 0, '采样器不该被调用——否则窗口标题仍被读到，只是结果被丢掉')
})

test('engine：勿扰模式下同样不采样', async () => {
  let sampled = 0
  const eng = createMonitorEngine({
    sampler: { async sample() { sampled++; return { ts: 0, idleSec: 0 } } },
    getPrivacy: () => ({ monitorEnabled: true, doNotDisturb: true })
  })
  const r = await eng.tickOnce()
  assert.equal(r.skipped, 'dnd')
  assert.equal(sampled, 0)
})

/* ================= 采样脚本契约（真机验证沉淀） ================= */

const __dirname = dirname(fileURLToPath(import.meta.url))

test('monitor-sampler.ps1：必须以 UTF-8 带 BOM 保存', () => {
  const buf = readFileSync(join(__dirname, '..', 'resources', 'monitor-sampler.ps1'))
  assert.equal(
    buf.subarray(0, 3).toString('hex'),
    'efbbbf',
    '采样脚本必须带 UTF-8 BOM：Windows PowerShell 5.1 无 BOM 时按系统代码页（中文 Windows 为 GBK）解析，' +
      '中文注释会被拆错字节并吞掉换行，导致后续语句静默失效（实测踩坑）'
  )
  const text = buf.toString('utf8')
  assert.ok(text.includes('GetForegroundWindow'), '应含 P/Invoke 取前台窗口')
  assert.ok(text.includes('UTF8Encoding'), '须显式以 UTF-8 写 stdout（否则中文标题到达 Node 变乱码、黑名单失效）')
  assert.ok(text.includes('OpenStandardOutput'), '须直接写标准输出流，不依赖 Console.OutputEncoding')
  assert.ok(text.includes('while ($true)'), '应为常驻采样循环')
})
