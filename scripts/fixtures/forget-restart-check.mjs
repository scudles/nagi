// C5-RESTART-01 的独立进程探针：在全新模块实例里加载同一 profile。
import { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = process.argv[2]
if (!userData) throw new Error('缺少隔离 profile 路径')
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })

const { getRag } = await import('../../src/main/rag/index.js')
const { loadMemories, memoryLines } = await import('../../src/main/persist.js')
const { listNotes } = await import('../../src/main/presence-notes.js')
const rag = getRag().init()
loadMemories()
const found = await rag.recall('香菜')
const history = readFileSync(join(userData, 'history.json'), 'utf8')
process.stdout.write(JSON.stringify({
  memory: memoryLines().some((line) => line.includes('香菜')),
  history: history.includes('香菜'),
  notes: listNotes().notes.some((note) => note.text.includes('香菜')),
  rag: found.results.some((row) => String(row.text || '').includes('香菜'))
}))
rag.dispose()
