// test/intent.test.js
// D2 表达意图（CONTRACTS §5 枚举 + §8 定版优先级）的纯策略层。
//
// 保护的不变量：
//   1) 一轮只选一个意图，且保留 source（crisis/user/rule/model/default）；
//   2) 优先级：安全/危机 > 用户明确要求 > 澄清规则 > 模型建议 > 默认；
//   3) reminisce **必须**有可追溯引用，否则回退并记录 fallbackFrom；
//   4) directive 只写功能性约束，不写任何固定台词/句式；
//   5) 非法枚举与未知输入一律回退，不抛错。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENT,
  INTENT_SOURCE,
  INTENT_KINDS,
  detectUserNeed,
  intentDirective,
  isIntentKind,
  parseIntentHint,
  resolveIntent
} from '../src/core/agent/intent.js'

test('规则层：把用户明说的需求判成对应意图', () => {
  const cases = [
    ['别分析了，听我说就行', INTENT.LISTEN],
    ['不用给建议，陪我待一会儿', INTENT.LISTEN],
    ['别再提这件事了，换个话题', INTENT.BOUNDARY],
    ['帮我改一下这个文件', INTENT.SOLVE],
    ['你还记得上次我们去的那家店吗', INTENT.REMINISCE],
    ['怎么办？', INTENT.CLARIFY]
  ]
  for (const [text, kind] of cases) {
    const got = detectUserNeed(text)
    assert.equal(got?.kind, kind, text)
    assert.ok([INTENT_SOURCE.USER, INTENT_SOURCE.RULE].includes(got.source), text + ' 必须有来源')
  }
  // 闲聊不硬判
  for (const text of ['今天天气不错', '嗯', '']) {
    assert.equal(detectUserNeed(text), null, text)
  }
})

test('优先级：危机压倒一切（即使他说“帮我写文件”）', () => {
  const r = resolveIntent({ userText: '帮我写个文件，我已经吃了很多药', crisis: true })
  assert.equal(r.kind, INTENT.LISTEN)
  assert.equal(r.source, INTENT_SOURCE.CRISIS)
})

test('优先级：用户明确要求压过模型建议', () => {
  const r = resolveIntent({
    userText: '别分析了，听我说',
    modelHint: { kind: INTENT.SOLVE, confidence: 0.99 }
  })
  assert.equal(r.kind, INTENT.LISTEN)
  assert.equal(r.source, INTENT_SOURCE.USER)
})

test('reminisce 必须有可追溯引用；没有则回退并记录 fallbackFrom', () => {
  const noRefs = resolveIntent({ userText: '你还记得上次那件事吗', hasGroundedMemory: false })
  assert.equal(noRefs.kind, INTENT.BRIEF_ACK)
  assert.equal(noRefs.source, INTENT_SOURCE.RULE)
  assert.equal(noRefs.fallbackFrom, INTENT.REMINISCE)

  const withRefs = resolveIntent({ userText: '你还记得上次那件事吗', hasGroundedMemory: true })
  assert.equal(withRefs.kind, INTENT.REMINISCE)
  assert.equal(withRefs.source, INTENT_SOURCE.USER)
  assert.equal(withRefs.fallbackFrom, null)
})

test('模型建议：合法枚举才采纳，非法/缺字段一律回退默认', () => {
  const ok = resolveIntent({ userText: '嗯', modelHint: { kind: INTENT.CLARIFY, confidence: 0.6 } })
  assert.equal(ok.kind, INTENT.CLARIFY)
  assert.equal(ok.source, INTENT_SOURCE.MODEL)
  assert.equal(ok.confidence, 0.6)

  const bad = resolveIntent({ userText: '嗯', modelHint: { kind: 'chitchat' } })
  assert.equal(bad.kind, INTENT.BRIEF_ACK)
  assert.equal(bad.source, INTENT_SOURCE.DEFAULT)

  const noField = resolveIntent({ userText: '嗯', modelHint: {} })
  assert.equal(noField.kind, INTENT.BRIEF_ACK)
})

test('模型建议 reminiscence 同样受引用门槛约束', () => {
  const r = resolveIntent({ userText: '嗯', modelHint: { kind: INTENT.REMINISCE, confidence: 0.8 } })
  assert.equal(r.kind, INTENT.BRIEF_ACK)
  assert.equal(r.source, INTENT_SOURCE.MODEL)
  assert.equal(r.fallbackFrom, INTENT.REMINISCE)
})

test('普通输入默认 brief-ack', () => {
  for (const text of ['今天好累', '嗯嗯', '']) {
    const r = resolveIntent({ userText: text })
    assert.equal(r.kind, INTENT.BRIEF_ACK)
    assert.equal(r.source, INTENT_SOURCE.DEFAULT)
  }
})

test('六意图都有功能性约束，且不含固定台词', () => {
  for (const kind of INTENT_KINDS) {
    const d = intentDirective(kind)
    assert.ok(d && d.length > 8, kind)
    // 红线：directive 不许写成句子模板（不出现引号包起来的口语台词）。
    // 「」在白名单里是**段落名引用**（如「记得的事」），不算台词；这里只拦双引号。
    assert.equal(/[“”"]/.test(d), false, kind + ' 里出现了引号台词')
  }
  // 未知意图回退到 brief-ack 的约束，不抛错
  assert.equal(intentDirective('nope'), intentDirective(INTENT.BRIEF_ACK))
})

test('parseIntentHint：情绪 + 可选意图，非法意图当没有', () => {
  assert.deepEqual(parseIntentHint('[calm|listen]你好'), { emotion: 'calm', intent: 'listen', rest: '你好' })
  assert.deepEqual(parseIntentHint('[joy]嗯'), { emotion: 'joy', intent: null, rest: '嗯' })
  assert.deepEqual(parseIntentHint('[calm|chitchat]嗯'), { emotion: 'calm', intent: null, rest: '嗯' })
  assert.deepEqual(parseIntentHint('没有标签'), { emotion: null, intent: null, rest: '没有标签' })
})

test('isIntentKind 只认六值', () => {
  for (const k of INTENT_KINDS) assert.equal(isIntentKind(k), true)
  for (const k of ['', 'brief', 'SOLVE', null, undefined]) assert.equal(isIntentKind(k), false)
})
