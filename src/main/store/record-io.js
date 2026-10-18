// src/main/store/record-io.js
// 行式存储端口的真实 fs 实现（B7 P2-05）：账本的追加/重写只在这里碰磁盘。
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseJsonLines } from '../../core/store/record-io.js'
import { reportCatch, CATCH_CLASS } from '../maintenance.js'

// B8：坏行必须留下痕迹——跳过一行旧档就等于把一段共同经历悄悄抹了，
// 之前这个上报点在 core/ledger/store.js 里；B7 把落盘挪到端口之后，诊断随之挪到这里。
const defaultBadLine = (err) => reportCatch('store.readJsonLines', CATCH_CLASS.MUST_PERSIST, err)

export function createFsRecordIo({ root, files, rng = randomUUID, onBadLine = defaultBadLine } = {}) {
  const base = resolve(String(root))
  const table = { ...files }
  const pathOf = (key) => {
    const rel = table[String(key)]
    if (!rel) throw new Error(`未登记的行式存储键：${String(key)}`)
    return join(base, rel)
  }
  return {
    exists(key) { return existsSync(pathOf(key)) },
    readObjects(key) {
      const path = pathOf(key)
      if (!existsSync(path)) return []
      return parseJsonLines(readFileSync(path, 'utf8'), onBadLine)
    },
    append(key, row) {
      const path = pathOf(key)
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
    },
    rewrite(key, rows) {
      const path = pathOf(key)
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${rng()}.tmp`
      const body = rows.map((row) => JSON.stringify(row)).join('\n')
      writeFileSync(temp, body ? body + '\n' : '', 'utf8')
      renameSync(temp, path)
    },
    remove(key) { rmSync(pathOf(key), { force: true }) }
  }
}

/** 账本自己的两个文档：条目流 + 迁移标记 */
export function ledgerRecordIo(userDataDir, options = {}) {
  return createFsRecordIo({
    root: join(String(userDataDir), 'ledger'),
    files: { 'entries': 'entries.jsonl', 'migration': 'migration.json' },
    ...options
  })
}
