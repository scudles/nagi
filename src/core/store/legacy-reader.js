// src/core/store/legacy-reader.js
// 迁移源只读端口：一次性把旧版本散落的文件读回来。
//
// 迁移必须遍历目录（journal/ 下有多少个日期文件是运行时才知道的），
// 所以这一层比文档端口"矮"：core 给出的是**相对引用**（如 'journal/2026-10-01.json'），
// 绝对路径与"是否允许读"完全由 main 侧实现决定（越界引用必须拒绝）。
//
// 契约：
//   exists(ref)      -> boolean
//   list(ref)        -> string[]   目录项文件名；不存在或不是目录 → []
//   read(ref)        -> string | null
//   readObjects(ref) -> object[]   JSONL；坏行跳过
import { parseJsonLines } from './record-io.js'

export const LEGACY_READER_CONTRACT = ['exists', 'list', 'read', 'readObjects']

export function isLegacyReader(reader) {
  return Boolean(reader) && LEGACY_READER_CONTRACT.every((key) => typeof reader[key] === 'function')
}

/** 什么都没有：迁移会被跳过，而不是假装成功 */
export function createEmptyLegacyReader() {
  return {
    exists: () => false,
    list: () => [],
    read: () => null,
    readObjects: () => []
  }
}

/**
 * 内存迁移源：{ 'journal/2026-10-01.json': '文本内容' }。
 * 目录项由引用的第一段推导，测试里可以直接摆出旧版本的目录形状。
 */
export function createMemoryLegacyReader({ files = {}, objects = {} } = {}) {
  const table = new Map(Object.entries(files))
  for (const [ref, rows] of Object.entries(objects)) {
    table.set(ref, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }
  const childNames = (dir) => {
    const prefix = dir.replace(/\/+$/, '') + '/'
    return [...table.keys()].filter((ref) => ref.startsWith(prefix))
      .map((ref) => ref.slice(prefix.length).split('/')[0])
      .filter((name) => !name.includes('/'))
  }
  return {
    exists(ref) { return table.has(String(ref)) || childNames(String(ref)).length > 0 },
    list(ref) { return [...new Set(childNames(String(ref)))] },
    read(ref) { return table.has(String(ref)) ? table.get(String(ref)) : null },
    readObjects(ref) { return parseJsonLines(table.get(String(ref)) ?? '') }
  }
}
