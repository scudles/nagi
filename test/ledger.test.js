import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExperienceLedger, trustTier } from '../src/core/ledger/store.js'
import { realRecordPorts, tempDir } from './helpers/store-ports.js'

function fixture() {
  // 临时目录放系统临时区：落在仓库里会让节点上的批量删除守卫把测试判失败（环境噪音）
  const dir = tempDir('nagi-ledger-')
  const write = (path, value) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  }
  // B7（P2-05）：core 不再自己拼路径，端口在测试里装配（真实 fs 指向临时目录）
  const open = (overrides = {}) => new ExperienceLedger({ ...realRecordPorts(dir), ...overrides })
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 环境守卫/回收站失败不算测试失败 */ } }
  return { dir, write, open, cleanup }
}

test('旧数据只索引原件，区分可观察经历、未经核实的推断与主观日记', () => {
  const { dir, write, open, cleanup } = fixture()
  try {
    write('journal/2026-10-14.json', { entries: [{ kind: 'chat', t: 1000, user: '你好', reply: '在呢' }] })
    write('monologue/diary-2026-10-14.md', '- 13:24 ［平静·40%］ （心里）今天有点开心\n')
    write('memory.json', { entries: [{ id: 'm1', text: '喜欢乌龙茶', at: 2000 }] })
    write('history.json', { messages: [{ role: 'user', content: '过去的一句话' }] })
    write('rag/chunks.jsonl', [
      { id: 'dead', kind: 'fact', text: '已遗忘', at: 100 },
      { tombstone: true, id: 'dead', at: 100 },
      { id: 'live', kind: 'fact', text: '模型猜测', at: 3000 }
    ].map(JSON.stringify).join('\n') + '\n')
    write('relation.json', { interactionCount: 3, firstMetAt: 100 })
    write('timeline/2026-10-14.json', { points: [{ t: 4000, mood: 'calm', i: 0.4 }] })

    const ledger = open()
    assert.deepEqual(ledger.migrateLegacy(), { migrated: true, count: 7 })
    const entries = ledger.list()
    assert.equal(entries.length, 7)
    assert.equal(entries.find((entry) => entry.source.type === 'journal').occurredAt, 1000)
    assert.equal(entries.find((entry) => entry.source.type === 'history').occurredAt, null)
    assert.equal(entries.find((entry) => entry.source.type === 'memory').certainty, 'unverified')
    assert.equal(entries.find((entry) => entry.source.type === 'diary').category, 'subjective')
    assert.equal(entries.find((entry) => entry.source.type === 'timeline').certainty, 'system-estimate')
    assert.equal(entries.some((entry) => entry.text === '已遗忘'), false)
    assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8').includes('喜欢乌龙茶'), true)
    assert.deepEqual(open().migrateLegacy(), { migrated: false, count: 0 })
  } finally { cleanup() }
})

test('迁移中断后重复执行不会复制条目，新增来源也有稳定身份', () => {
  const { dir, write, open, cleanup } = fixture()
  try {
    write('memory.json', { entries: [{ id: 'm1', text: '待核实', at: 1000 }] })
    const first = open()
    first.record({ category: 'claim', text: '待核实', source: { type: 'memory', ref: 'm1' }, certainty: 'unverified' })
    const retry = open()
    assert.deepEqual(retry.migrateLegacy(), { migrated: true, count: 0 })
    assert.equal(retry.list().length, 1)
    const created = retry.record({ category: 'experience', text: '新对话', source: { type: 'journal-live', ref: 'turn-1' }, occurredAt: 5000 })
    assert.equal(created.occurredAt, 5000)
    assert.equal(retry.record({ category: 'experience', text: '新对话', source: { type: 'journal-live', ref: 'turn-1' } }).id, created.id)
    assert.equal(open().list().length, 2)
    assert.equal(retry.deleteBySource('journal-live', 'turn-1', 6000), true)
    assert.equal(open().get(created.id).deletedAt, 6000)
    assert.equal(readFileSync(join(dir, 'ledger', 'entries.jsonl'), 'utf8').includes('新对话'), false)
  } finally { cleanup() }
})

test('旧文件损坏时不标记迁移完成；修复后可重试', () => {
  const { dir, write, open, cleanup } = fixture()
  try {
    write('memory.json', '{broken')
    const ledger = open()
    assert.throws(() => ledger.migrateLegacy(), SyntaxError)
    assert.equal(existsSync(join(dir, 'ledger', 'migration.json')), false)
    write('memory.json', { entries: [{ id: 'm2', text: '修复后可迁移' }] })
    assert.deepEqual(ledger.migrateLegacy(), { migrated: true, count: 1 })
  } finally { cleanup() }
})

test('三层可信分类与纠错导出：旧正文物理移除，保留审计关联', () => {
  const { dir, open, cleanup } = fixture()
  try {
    const ledger = open()
    const old = ledger.record({ category: 'claim', text: '旧错误事实',
      source: { type: 'memory-model', ref: 'm3' }, certainty: 'unverified' })
    assert.equal(trustTier(old), 'unverified')
    const changed = ledger.correct(old.id, '用户更正后的内容', 5000)
    assert.equal(changed.tier, 'recorded')
    assert.equal(changed.meta.corrects, old.id)
    assert.equal(ledger.get(old.id).text, '')
    assert.equal(ledger.get(old.id).deletedAt, 5000)
    assert.equal(ledger.list().length, 1)
    const bundle = ledger.exportBundle()
    assert.equal(bundle.entries.length, 2)
    assert.equal(bundle.entries.find((entry) => entry.id === old.id).meta.correctedBy, changed.id)
    assert.equal(readFileSync(join(dir, 'ledger', 'entries.jsonl'), 'utf8').includes('旧错误事实'), false)
  } finally { cleanup() }
})

test('注入时钟与随机数：同一份操作序列可完全复算（不读全局 Date.now / randomUUID）', () => {
  const { open, cleanup } = fixture()
  try {
    let now = 5000
    const ledger = open({ now: () => now, rng: () => 'fixed-ref' })
    const missing = ledger.record({ category: 'claim', text: '没给 ref 的经历', source: { type: 'journal-live' } })
    assert.equal(missing.source.ref, 'fixed-ref', '缺 ref 时用注入的 rng 兜底')
    assert.equal(missing.recordedAt, 5000)
    const first = ledger.record({ category: 'subjective', text: '旧想法', source: { type: 'diary', ref: 'd1' } })
    now = 9000
    const corrected = ledger.correct(first.id, '改过的想法')
    assert.equal(corrected.recordedAt, 9000)
    assert.equal(corrected.source.ref, 'fixed-ref')
    assert.equal(ledger.exportBundle().exportedAt, 9000)
  } finally { cleanup() }
})

test('迁移源端口拒绝白名单外的引用：目录里多了同名文件也不会被读走', () => {
  const { write, open, cleanup } = fixture()
  try {
    write('rag/chunks.jsonl', JSON.stringify({ id: 'c1', kind: 'fact', text: '该迁移', at: 1 }) + '\n')
    write('secrets.json', { entries: [{ id: 'x', text: '不该被迁移读走' }] })
    const ledger = open()
    assert.deepEqual(ledger.migrateLegacy(), { migrated: true, count: 1 })
    assert.equal(ledger.list().some((entry) => entry.text.includes('不该被迁移读走')), false)
  } finally { cleanup() }
})
