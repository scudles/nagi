// test/helpers/store-ports.js
// B7（P2-05）测试装配：把真实 fs 端口指向临时目录，或换成内存端口。
//
// 为什么要两份：
//   · 真实 fs 端口 —— 保留"写完盘确实落在文件里"这类断言，同时证明不碰生产 userData；
//   · 内存端口   —— 快，且能干净地注入失败（写盘失败不必去造 ENOENT 路径）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsDocumentIo } from '../../src/main/store/document-io.js'
import { createFsRecordIo } from '../../src/main/store/record-io.js'
import { createFsLegacyReader } from '../../src/main/store/legacy-reader.js'
import { createMemoryDocumentIo } from '../../src/core/store/document-io.js'
import { createMemoryRecordIo } from '../../src/core/store/record-io.js'
import { createMemoryLegacyReader } from '../../src/core/store/legacy-reader.js'

/** 迁移源白名单（与 main 侧 userDataLegacyReader 必须一致） */
export const LEGACY_ALLOW = ['journal', 'monologue', 'timeline', 'rag', 'memory.json', 'history.json', 'relation.json']

/** 确定性 id 生成器：同一份测试每次跑出的 id 一致，便于比对 */
export function counterRng(prefix = 'id') {
  let n = 0
  return () => `${prefix}-${++n}`
}

export function realRecordPorts(dir, { now = () => 1000, rng = counterRng() } = {}) {
  return {
    recIo: createFsRecordIo({
      root: join(dir, 'ledger'),
      files: { entries: 'entries.jsonl', migration: 'migration.json' }
    }),
    legacy: createFsLegacyReader({ root: dir, allow: LEGACY_ALLOW }),
    now,
    rng
  }
}

export function realYearbookPorts(dir, { now = () => 1000, rng = counterRng() } = {}) {
  return {
    io: createFsDocumentIo({ root: dir, files: { 'yearbook-pages': 'yearbook/pages.json' } }),
    now,
    rng
  }
}

export function memoryRecordPorts({ now = () => 1000, rng = counterRng(), initial = {}, legacyFiles = {} } = {}) {
  return {
    recIo: createMemoryRecordIo({ initial }),
    legacy: createMemoryLegacyReader({ files: legacyFiles }),
    now,
    rng
  }
}

export function memoryYearbookPorts({ now = () => 1000, rng = counterRng() } = {}) {
  return { io: createMemoryDocumentIo(), now, rng }
}

/** 把任意端口包一层，让 write/remove 按开关抛错 —— 失败注入不用再造 ENOENT 路径 */
export function failingPorts(base, { write = null, remove = null, after = 0 } = {}) {
  let writes = 0
  const shouldThrow = (error) => {
    if (!error) return false
    return ++writes > after
  }
  return {
    ...base,
    write(key, value) {
      if (shouldThrow(write)) throw write
      return base.write(key, value)
    },
    remove(key) {
      if (shouldThrow(remove)) throw remove
      return base.remove(key)
    }
  }
}

export function tempDir(tag = 'nagi-b7-') {
  return mkdtempSync(join(tmpdir(), tag))
}
