// test/memory.test.js
// 长期记忆纯逻辑单测：解析模型的增删指令、去重合并、上限裁剪、变化报告（D01 修复）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMemoryOps, formatMemories, parseMemoryOps, mergeMemoryEntries, MEMORY_LIMIT } from '../src/core/memory.js'

test('parseMemoryOps 解析纯 JSON', () => {
  const r = parseMemoryOps('{"add":["在做桌宠项目"],"remove":["养猫"]}')
  assert.deepEqual(r.add, ['在做桌宠项目'])
  assert.deepEqual(r.remove, ['养猫'])
})

test('parseMemoryOps 容错 markdown 围栏与前后废话', () => {
  const r = parseMemoryOps('好的，结果是：\n```json\n{"add":["喜欢深夜写代码"],"remove":[]}\n```\n以上。')
  assert.deepEqual(r.add, ['喜欢深夜写代码'])
})

test('parseMemoryOps 对垃圾输入返回空指令而不抛错', () => {
  for (const bad of [null, '', '不是 JSON', '{"add": "字符串不是数组"}', '[1,2,3]']) {
    assert.deepEqual(parseMemoryOps(bad), { add: [], remove: [] })
  }
})

test('applyMemoryOps 新增并去重（忽略空白差异）', () => {
  const base = [{ id: 'a', text: '在做桌宠项目' }]
  const out = applyMemoryOps(base, { add: ['在做 桌宠项目', '习惯熬夜'] }, 1000)
  assert.equal(out.length, 2)
  assert.equal(out[1].text, '习惯熬夜')
  assert.equal(out[1].at, 1000)
  assert.ok(out[1].id)
})

test('applyMemoryOps 按原文删除，不存在的条目不受影响', () => {
  const base = [{ id: 'a', text: '养猫' }, { id: 'b', text: '习惯熬夜' }]
  const out = applyMemoryOps(base, { remove: ['养猫', '不存在的'] }, 1)
  assert.deepEqual(out.map((e) => e.text), ['习惯熬夜'])
})

test('applyMemoryOps 超出上限丢最旧的', () => {
  const base = Array.from({ length: MEMORY_LIMIT }, (_, i) => ({ id: 'm' + i, text: '旧' + i }))
  const out = applyMemoryOps(base, { add: ['最新的一条'] }, 1)
  assert.equal(out.length, MEMORY_LIMIT)
  assert.equal(out[out.length - 1].text, '最新的一条')
  assert.equal(out[0].text, '旧1') // 最旧的一条（旧0）被挤掉
})

test('applyMemoryOps 过滤空文本条目', () => {
  const out = applyMemoryOps([{ id: 'a', text: '  ' }, { id: 'b', text: '' }], { add: [''] }, 1)
  assert.equal(out.length, 0)
})

test('formatMemories 同时接受对象数组与字符串数组', () => {
  assert.deepEqual(formatMemories([{ text: 'A' }, 'B', { text: '  ' }, null]), ['A', 'B'])
})

test('mergeMemoryEntries：满额淘汰也算变化（D01：数量不变也必须落盘）', () => {
  const base = Array.from({ length: MEMORY_LIMIT }, (_, i) => ({ id: 'm' + i, text: '旧' + i }))
  const r = mergeMemoryEntries(base, { add: ['最新的一条'] }, 1)
  assert.equal(r.changed, true, '满额后数量不变但内容变了，changed 必须为 true')
  assert.deepEqual(r.added, ['最新的一条'])
  assert.equal(r.entries.length, MEMORY_LIMIT)
  assert.equal(r.entries[0].text, '旧1') // 最旧的旧0 被挤掉
  assert.equal(r.entries[r.entries.length - 1].text, '最新的一条')
})

test('mergeMemoryEntries：重复文本（空白差异）不算新增', () => {
  const base = [{ id: 'a', text: '在做桌宠项目' }]
  const r = mergeMemoryEntries(base, { add: ['在做 桌宠项目'] }, 1)
  assert.equal(r.changed, false)
  assert.deepEqual(r.added, [])
  assert.equal(r.entries.length, 1)
})

test('mergeMemoryEntries：删除不存在的文本无变化', () => {
  const base = [{ id: 'a', text: '养猫' }]
  const r = mergeMemoryEntries(base, { remove: ['不存在的'] }, 1)
  assert.equal(r.changed, false)
  assert.deepEqual(r.removed, [])
})

test('mergeMemoryEntries：added 只含真正新增的文本', () => {
  const base = [{ id: 'a', text: '养猫' }]
  const r = mergeMemoryEntries(base, { add: ['养猫', '习惯熬夜', ''] }, 1)
  assert.deepEqual(r.added, ['习惯熬夜'])
  assert.equal(r.changed, true)
})

test('mergeMemoryEntries：removed 报告真实被删文本，applyMemoryOps 行为不变', () => {
  const base = [{ id: 'a', text: '养猫' }, { id: 'b', text: '习惯熬夜' }]
  const r = mergeMemoryEntries(base, { remove: ['养猫'] }, 1)
  assert.deepEqual(r.removed, ['养猫'])
  assert.deepEqual(r.entries.map((e) => e.text), ['习惯熬夜'])
  // 委托实现的 applyMemoryOps 与旧行为一致
  assert.deepEqual(applyMemoryOps(base, { remove: ['养猫'] }, 1), r.entries)
})
