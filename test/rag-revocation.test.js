import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeSummaryChunk, makeTurnChunk } from '../src/core/rag/chunk.js'

mock.module('electron', { exports: {
  app: { getPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
} })
const { RagService } = await import('../src/main/rag/index.js')

function service(dir) {
  return new RagService({ dir, getSettings: () => ({ rag: { enabled: true, provider: 'none' } }) }).init()
}

test('忘记待嵌轮次会清掉 pending 与依赖摘要，重启不能恢复', () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-rag-revoke-'))
  try {
    const rag = service(dir)
    const turn = rag.ingestTurn({ user: '只用于撤销测试的旧内容', assistant: '收到', at: 1000 })
    assert.equal(turn.ok, true)
    const summary = makeSummaryChunk({ text: '旧内容摘要', covers: [turn.id], at: 2000 })
    assert.equal(rag._ingestChunk(summary).ok, true)
    assert.equal(rag.status().pending, 2)
    assert.equal(rag.forget(turn.id).ok, true)
    assert.equal(rag.status().pending, 0)
    assert.equal(readFileSync(join(dir, 'revoked.json'), 'utf8').includes(summary.id), true)
    assert.equal(service(dir).status().pending, 0)
    rag.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('忘记已嵌入轮次会物理清除正文并保持撤销状态', () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-rag-revoke-'))
  try {
    const rag = service(dir)
    const chunk = makeTurnChunk({ user: '不能再召回的原话', assistant: '知道了', at: 1000 })
    const vector = new Float32Array(rag.store.dim)
    vector[0] = 1
    const appended = rag.store.append(chunk, vector)
    assert.equal(appended.ok, true)
    rag.io.appendEmbedded(chunk, vector)
    assert.equal(rag.forget(chunk.id).ok, true)
    assert.equal(rag.store.liveCount, 0)
    assert.equal(readFileSync(join(dir, 'chunks.jsonl'), 'utf8').includes('不能再召回的原话'), false)
    assert.equal(service(dir).store.liveCount, 0)
    rag.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('嵌入推理进行中撤销，完成后不会把旧文字重新写回', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.nagi-rag-revoke-'))
  try {
    const rag = service(dir)
    const turn = rag.ingestTurn({ user: '等待中的旧内容', assistant: '旧回复', at: 1000 })
    let finishEmbed
    let started
    const began = new Promise((resolve) => { started = resolve })
    rag._pickEmbedder = () => ({ id: 'local', dim: rag.store.dim, embed: () => {
      started()
      return new Promise((resolve) => { finishEmbed = resolve })
    } })
    const running = rag.embedPending()
    await began
    assert.equal(rag.forget(turn.id).ok, true)
    const vec = new Float32Array(rag.store.dim)
    vec[0] = 1
    finishEmbed([vec])
    await running
    assert.equal(rag.store.liveCount, 0)
    assert.equal(rag.io.readPending().length, 0)
    assert.equal(service(dir).store.liveCount, 0)
    rag.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
