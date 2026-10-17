// B01 持久化中断窗口 —— 纯逻辑层测试（假 fs，零磁盘副作用）
// 核心断言：任何失败路径都不得删除原文件；调用序列恒为 写tmp→rename，没有 unlink(file)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atomicWriteJsonSync, atomicWriteSync } from '../src/core/persist-io.js'

/** 假 fs：记录调用序列，可对特定调用注入失败 */
function fakeFs({ failWrite = false, failRename = false, existsAfterWrite = true } = {}) {
  const calls = []
  const files = new Map()
  return {
    calls,
    files,
    existsSync: (f) => (f.endsWith('.tmp') ? existsAfterWrite : files.has(f)),
    writeFileSync: (f, data) => {
      calls.push(['write', f])
      if (failWrite) throw new Error('EACCES: injected write failure')
      files.set(f, data)
    },
    renameSync: (a, b) => {
      calls.push(['rename', a, b])
      if (failRename) throw new Error('EPERM: injected rename failure')
      files.set(b, files.get(a))
      files.delete(a)
    },
    unlinkSync: (f) => {
      calls.push(['unlink', f])
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`)
      files.delete(f)
    }
  }
}

test('成功路径：写 tmp 后 rename，序列里没有 unlink', () => {
  const fs = fakeFs()
  const r = atomicWriteSync(fs, 'D:/data/memory.json', '{"entries":[]}')
  assert.equal(r.ok, true)
  assert.deepEqual(fs.calls, [['write', 'D:/data/memory.json.tmp'], ['rename', 'D:/data/memory.json.tmp', 'D:/data/memory.json']])
  assert.equal(fs.calls.some((c) => c[0] === 'unlink'), false)
})

test('rename 失败时原文件不被删除（B01 核心回归：旧代码先 unlink 再 rename）', () => {
  const fs = fakeFs({ failRename: true })
  // 预置"上一版"原文件
  fs.files.set('D:/data/memory.json', '上一版内容')
  fs.files.set('D:/data/memory.json.tmp', '新内容') // 假装 tmp 已存在（不存在也能跑）
  const r = atomicWriteSync(fs, 'D:/data/memory.json', '新内容')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'rename')
  assert.match(r.error, /替换失败/)
  // 原文件必须还在，且内容没被碰
  assert.equal(fs.files.has('D:/data/memory.json'), true)
  assert.equal(fs.files.get('D:/data/memory.json'), '上一版内容')
  // 没有任何一次 unlink 指向原文件（只允许清理 tmp）
  assert.equal(fs.calls.filter((c) => c[0] === 'unlink' && c[1] === 'D:/data/memory.json').length, 0)
})

test('rename 失败会清理半截 tmp', () => {
  const fs = fakeFs({ failRename: true })
  const r = atomicWriteSync(fs, 'D:/data/memory.json', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.tmpCleaned, true)
  assert.equal(fs.files.has('D:/data/memory.json.tmp'), false)
})

test('tmp 清理本身失败不掩盖原始 rename 错误', () => {
  const fs = fakeFs({ failRename: true })
  fs.unlinkSync = () => { throw new Error('EBUSY: injected') }
  const r = atomicWriteSync(fs, 'D:/data/memory.json', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'rename')
  assert.match(r.error, /替换失败/)
  assert.equal(r.tmpCleaned, false)
})

test('tmp 写入失败：不 rename、原文件不动', () => {
  const fs = fakeFs({ failWrite: true })
  fs.files.set('D:/data/memory.json', '上一版内容')
  const r = atomicWriteSync(fs, 'D:/data/memory.json', '新内容')
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'write')
  assert.equal(fs.calls.some((c) => c[0] === 'rename'), false)
  assert.equal(fs.files.get('D:/data/memory.json'), '上一版内容')
})

test('atomicWriteJsonSync：正常序列化走同一条原子路径', () => {
  const fs = fakeFs()
  const r = atomicWriteJsonSync(fs, 'D:/data/mood.json', { label: 'calm' })
  assert.equal(r.ok, true)
  assert.equal(fs.files.get('D:/data/mood.json'), JSON.stringify({ label: 'calm' }, null, 2))
})

test('atomicWriteJsonSync：序列化失败（循环引用）返回 json 阶段错误', () => {
  const fs = fakeFs()
  const cyclic = {}
  cyclic.self = cyclic
  const r = atomicWriteJsonSync(fs, 'D:/data/mood.json', cyclic)
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'json')
  assert.equal(fs.calls.length, 0) // 一个 fs 调用都不该发生
})

test('Buffer payload（RAG vectors.bin 场景）原样写入', () => {
  const fs = fakeFs()
  const buf = Buffer.from([1, 2, 3])
  const r = atomicWriteSync(fs, 'D:/rag/vectors.bin', buf)
  assert.equal(r.ok, true)
  assert.ok(Buffer.isBuffer(fs.files.get('D:/rag/vectors.bin')))
  assert.deepEqual([...fs.files.get('D:/rag/vectors.bin')], [1, 2, 3])
})
