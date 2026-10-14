import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmotionTagParser, normalizeStream, extractEmotionTag } from '../src/core/llm/stream-normalize.js'

test('完整标签一次到位', () => {
  const p = new EmotionTagParser()
  const r = p.push('[smile] 你好')
  assert.equal(r.emotion, 'smile')
  assert.equal(r.text, '你好')
  assert.equal(p.emotion, 'smile')
})

test('标签被拆成多个 chunk', () => {
  const p = new EmotionTagParser()
  assert.deepEqual(p.push('['), { text: '' })
  assert.deepEqual(p.push('po'), { text: '' })
  const r = p.push('ut] 哼。')
  assert.equal(r.emotion, 'pout')
  assert.equal(r.text, '哼。')
})

test('大括号风格标签', () => {
  const p = new EmotionTagParser()
  const r = p.push('[CALM]\n嗯。')
  assert.equal(r.emotion, 'calm')
  assert.equal(r.text, '嗯。')
})

test('没有标签时原样吐出', () => {
  const p = new EmotionTagParser()
  const r = p.push('今天心情不错')
  assert.equal(r.emotion, undefined)
  assert.equal(r.text, '今天心情不错')
})

test('中文开头的非标签立即放行', () => {
  const p = new EmotionTagParser()
  const r = p.push('……嗯，了解了。')
  assert.equal(r.text, '……嗯，了解了。')
  assert.equal(p.resolved, true)
})

test('非情绪方括号（如[1]）视为普通文本', () => {
  const p = new EmotionTagParser()
  const r = p.push('[1] 第一条')
  assert.equal(r.emotion, undefined)
  assert.equal(r.text, '[1] 第一条')
})

test('flush 吐出残留', () => {
  const p = new EmotionTagParser()
  p.push('[cal')
  const r = p.flush()
  assert.equal(r.text, '[cal')
})

test('normalizeStream 端到端', async () => {
  async function* gen() {
    yield '[' 
    yield 'wo'
    yield 'rry] 你已'
    yield '经坐了三小时。'
  }
  const events = []
  for await (const e of normalizeStream(gen())) events.push(e)
  assert.deepEqual(events[0], { type: 'emotion', emotion: 'worry' })
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assert.equal(text, '你已经坐了三小时。')
  assert.equal(events[events.length - 1].type, 'done')
})

test('extractEmotionTag 非流式', () => {
  assert.deepEqual(extractEmotionTag('[joy] 太好了'), { emotion: 'joy', text: '太好了' })
  assert.deepEqual(extractEmotionTag('普通回复'), { emotion: null, text: '普通回复' })
})
