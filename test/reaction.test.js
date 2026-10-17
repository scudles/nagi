// test/reaction.test.js
// 「她想一下再表现」的纯逻辑回归锁：
//   ① 思考闸门：只在场景切换 / 同场景待久了 / 长空闲三种时机才问，且有间隔与配额；
//   ② 解析：容忍 ```json 包裹与前后废话，坏 JSON 不炸；
//   ③ 校验（防守最重的一环）：情绪必须白名单、强度要钳制、话太长要丢、
//      微表情 id 必须在模型真实拥有的池子里；
//   ④ **允许什么也不做**：低强度 = 不做（这是防"过度解读"的核心）；
//   ⑤ 提示词里**只能有活动分类，不能有窗口标题/文件名**（用户选的隐私边界）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THINK,
  FEELS,
  MODES,
  buildReactionMessages,
  createThinkGate,
  extractReaction,
  parseReaction
} from '../src/core/presence/reaction.js'
import { TONE } from '../src/core/ambient.js'

function clock(start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, add: (ms) => (t += ms), set: (v) => (t = v) }
}

const FLASH = ['star', 'flower', 'sweat', 'puff']

/* ---------------- ① 思考闸门 ---------------- */

test('换了场景 → 值得想一次', () => {
  const c = clock()
  const g = createThinkGate({}, { now: c.now })
  g.noteCategory('work')
  assert.equal(g.shouldThink({ category: 'work' }), null, '同一个场景不该触发')
  const hit = g.shouldThink({ category: 'video' })
  assert.equal(hit?.reason, 'switch')
})

test('两次思考之间有最小间隔', () => {
  const c = clock()
  const g = createThinkGate({ minGapMs: 8 * 60 * 1000 }, { now: c.now })
  g.noteCategory('work')
  const hit = g.shouldThink({ category: 'video' })
  assert.ok(hit)
  g.noteThought(hit.reason, hit.category)
  assert.equal(g.shouldThink({ category: 'gaming' }), null, '刚想过就换场景也不该马上再想')
  c.add(8 * 60 * 1000 + 1)
  assert.ok(g.shouldThink({ category: 'gaming' }), '过了间隔就可以')
})

test('同一场景待久了 → 每 sceneHoldMs 至多想一次', () => {
  const c = clock()
  const g = createThinkGate({ minGapMs: 0, sceneHoldMs: 20 * 60 * 1000 }, { now: c.now })
  g.noteCategory('work')
  assert.equal(g.shouldThink({ category: 'work', sinceMs: 5 * 60 * 1000 }), null, '才 5 分钟')
  const hit = g.shouldThink({ category: 'work', sinceMs: 21 * 60 * 1000 })
  assert.equal(hit?.reason, 'dwell')
  g.noteThought(hit.reason, 'work')
  assert.equal(g.shouldThink({ category: 'work', sinceMs: 25 * 60 * 1000 }), null, '刚因为待久了想过')
  c.add(21 * 60 * 1000)
  assert.ok(g.shouldThink({ category: 'work', sinceMs: 46 * 60 * 1000 }), '再过一段可以再想')
})

test('长空闲 → 值得想一次（他是不是走了/在发呆）', () => {
  const c = clock()
  const g = createThinkGate({ minGapMs: 0, idleThinkMs: 10 * 60 * 1000 }, { now: c.now })
  g.noteCategory('work')
  assert.equal(g.shouldThink({ category: 'work', idleMs: 3 * 60 * 1000 }), null)
  const hit = g.shouldThink({ category: 'work', idleMs: 11 * 60 * 1000 })
  assert.equal(hit?.reason, 'idle')
})

test('勿扰 / 她正在说话时一律不想', () => {
  const c = clock()
  const g = createThinkGate({}, { now: c.now })
  g.noteCategory('work')
  assert.equal(g.shouldThink({ category: 'video', silent: true }), null)
  assert.equal(g.shouldThink({ category: 'video', busy: true }), null)
})

test('小时/每日配额：到了上限就不想（花钱的事要有上限）', () => {
  const c = clock()
  const g = createThinkGate({ minGapMs: 0, hourMax: 2, dayMax: 99 }, { now: c.now })
  g.noteCategory('a')
  for (let i = 0; i < 2; i++) {
    const hit = g.shouldThink({ category: 'x' + i })
    assert.ok(hit, `第 ${i + 1} 次应当允许`)
    g.noteThought(hit.reason, hit.category)
  }
  assert.equal(g.shouldThink({ category: 'zzz' }), null, '到小时上限应当停下')
  c.add(60 * 60 * 1000)
  assert.ok(g.shouldThink({ category: 'zzz' }), '下一个小时重置')
})

test('安静基调（你在专注做事）把间隔放宽', () => {
  const c = clock()
  const base = { minGapMs: 8 * 60 * 1000, quietFactor: 2 }
  const normal = createThinkGate(base, { now: c.now })
  const quiet = createThinkGate(base, { now: c.now })
  normal.noteCategory('work')
  quiet.noteCategory('work')
  normal.noteThought('switch', 'work')
  quiet.noteThought('switch', 'work')
  c.add(9 * 60 * 1000)
  assert.ok(normal.shouldThink({ category: 'video', tone: TONE.NORMAL }), '普通基调 9 分钟后可以')
  assert.equal(quiet.shouldThink({ category: 'video', tone: TONE.QUIET }), null, '安静基调要等更久')
  c.add(9 * 60 * 1000)
  assert.ok(quiet.shouldThink({ category: 'video', tone: TONE.QUIET }))
})

test('noteThought 即使失败也要记账（否则会连着重试打满配额）', () => {
  const c = clock()
  const g = createThinkGate({ minGapMs: 0, hourMax: 1 }, { now: c.now })
  g.noteCategory('a')
  g.noteThought(null, 'a')
  assert.equal(g.shouldThink({ category: 'b' }), null)
})

/* ---------------- ② 解析 ---------------- */

test('解析：纯 JSON / ```json 包裹 / 前后有废话 都能取出', () => {
  const body = '{"read":"他在写代码","feel":"worry","strength":0.4,"mode":"sustain","why":"坐太久了","say":null}'
  for (const text of [body, '```json\n' + body + '\n```', `我的判断是：${body} 就这样。`]) {
    const r = extractReaction(text)
    assert.equal(r.ok, true, `解析失败：${text.slice(0, 20)}`)
    assert.equal(r.raw.feel, 'worry')
  }
})

test('解析：坏 JSON / 空响应不炸，只是 ok=false', () => {
  for (const bad of ['', null, undefined, '不是 json', '{ 缺逗号 }', '[]', '123']) {
    const r = extractReaction(bad)
    assert.equal(r.ok, false, `${String(bad)} 应当解析失败`)
    assert.equal(r.raw, null)
  }
})

/* ---------------- ③ 校验 ---------------- */

test('校验：情绪不在白名单就丢掉，不会让渲染层去设一个不存在的表情', () => {
  const r = parseReaction({ feel: 'angry', strength: 0.8, mode: 'sustain' }, { availableFlash: FLASH })
  assert.equal(r.act, 'none', '非法情绪应当退化为"不做"')
  assert.ok(r.dropped.some((d) => d.startsWith('feel:')))
})

test('校验：强度被钳到 [0,1]，持续表情还有上限', () => {
  const hi = parseReaction({ feel: 'worry', strength: 5, mode: 'sustain' }, { availableFlash: FLASH })
  assert.equal(hi.act, 'sustain')
  assert.ok(hi.strength <= DEFAULT_THINK.maxSustainStrength, `强度应被压到 ${DEFAULT_THINK.maxSustainStrength}，实际 ${hi.strength}`)
  const lo = parseReaction({ feel: 'worry', strength: -3, mode: 'sustain' }, { availableFlash: FLASH })
  assert.equal(lo.strength, 0)
})

test('校验：话太长就丢掉（她主动开口应该是短句）', () => {
  const short = parseReaction({ feel: 'worry', strength: 0.5, mode: 'sustain', say: '起来走两步吧。' }, { availableFlash: FLASH })
  assert.equal(short.say, '起来走两步吧。')
  const long = parseReaction(
    { feel: 'worry', strength: 0.5, mode: 'sustain', say: '你已经坐了很久了，人一直坐着对腰不好，而且眼睛也需要休息'.repeat(3) },
    { availableFlash: FLASH }
  )
  assert.equal(long.say, null)
  assert.ok(long.dropped.includes('say:过长'))
})

test('校验：微表情 id 必须在模型真实拥有池子里', () => {
  const ok = parseReaction({ mode: 'flash', flash: 'star', strength: 0.9 }, { availableFlash: FLASH })
  assert.equal(ok.act, 'flash')
  assert.equal(ok.flash, 'star')
  const bad = parseReaction({ mode: 'flash', flash: 'nope', strength: 0.9 }, { availableFlash: FLASH })
  assert.equal(bad.act, 'none', '不存在的微表情不该被放行')
  assert.ok(bad.dropped.some((d) => d.startsWith('flash:')))
})

test('校验：不知道池子里有什么时，一律不放行 flash（宁可不动）', () => {
  const r = parseReaction({ mode: 'flash', flash: 'star', strength: 0.9 }, { availableFlash: [] })
  assert.equal(r.act, 'none')
})

/* ---------------- ④ 允许什么都不做 ---------------- */

test('低强度 = 不做（防过度解读的核心）', () => {
  const r = parseReaction({ feel: 'worry', strength: 0.05, mode: 'sustain' }, { availableFlash: FLASH })
  assert.equal(r.act, 'none')
  assert.equal(r.strength, 0)
})

test('模型自己给 null / 空 → 不做（最常见的正确答案）', () => {
  for (const raw of [{}, { feel: null, strength: 0 }, { feel: '', mode: 'sustain' }, { read: '他在写代码' }]) {
    const r = parseReaction(raw, { availableFlash: FLASH })
    assert.equal(r.act, 'none', `${JSON.stringify(raw)} 应当是不做`)
  }
})

test('低强度但指定了 flash → 允许闪一下（比持续更轻）', () => {
  const r = parseReaction({ feel: 'puzzled', strength: 0.2, mode: 'flash', flash: 'puff' }, { availableFlash: FLASH })
  assert.equal(r.act, 'flash')
  assert.equal(r.flash, 'puff')
})

test('坏输入（null / 字符串 / 数组）不炸', () => {
  for (const bad of [null, undefined, 'x', [], 0]) {
    const r = parseReaction(bad, { availableFlash: FLASH })
    assert.equal(r.act, 'none')
    assert.equal(r.strength, 0)
  }
})

test('why 与 read 会被截断，不会把长文塞进界面', () => {
  const long = '很'.repeat(500)
  const r = parseReaction({ feel: 'worry', strength: 0.5, mode: 'sustain', why: long, read: long }, { availableFlash: FLASH })
  assert.ok(r.why.length <= 80)
  assert.ok(r.read.length <= 80)
})

/* ---------------- ⑤ 提示词的隐私边界 ---------------- */

test('提示词里只有活动分类，绝不出现窗口标题/文件名', () => {
  const msgs = buildReactionMessages({
    category: 'work',
    sinceMin: 35,
    idleMin: 2,
    hour: 14,
    moodLabel: '平静',
    flashOptions: FLASH,
    // 就算调用方误传了标题，也不该进提示词
    title: '财报_机密_v3.xlsx - Excel',
    app: 'EXCEL.EXE',
    windowTitle: '机密文件'
  })
  const text = msgs.map((m) => m.content).join('\n')
  assert.ok(text.includes('在工作或写东西'), '应当包含分类描述')
  for (const leak of ['财报', '机密', 'Excel', 'EXCEL', 'windowTitle']) {
    assert.equal(text.includes(leak), false, `提示词泄露了「${leak}」`)
  }
})

test('提示词明确允许"什么都不做"，并禁止脑补心情', () => {
  const text = buildReactionMessages({ category: 'work', flashOptions: FLASH })
    .map((m) => m.content)
    .join('\n')
  assert.ok(text.includes('不要') && (text.includes('不做') || text.includes('null')))
  assert.ok(text.includes('不要脑补'), '必须明确禁止脑补心情')
  assert.ok(text.includes('JSON'))
})

test('提示词把可选情绪与可选微表情都告诉了模型', () => {
  const text = buildReactionMessages({ category: 'video', flashOptions: FLASH }).map((m) => m.content).join('\n')
  for (const f of FEELS) assert.ok(text.includes(f), `漏了情绪 ${f}`)
  for (const id of FLASH) assert.ok(text.includes(id), `漏了微表情 ${id}`)
  for (const m of MODES) assert.ok(text.includes(m), `漏了模式 ${m}`)
})
