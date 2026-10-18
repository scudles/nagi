// src/core/store/record-io.js
// 行式（JSONL）存储端口：追加为主、必要时整卷重写。
//
// 账本用它，是因为「正常追加」与「纠错/删除要抹掉旧正文」是两种完全不同的写：
// 前者只 append 一行，后者必须重写当前态。把这两件事的落盘方式收敛到一个端口，
// core 侧才能既保持追加顺序、又不必知道自己在哪个目录。
//
// 契约：
//   readObjects(key) -> object[]         坏行跳过（由调用方决定是否上报）
//   append(key, obj) -> void             行尾追加一行 JSON
//   rewrite(key, objects) -> void        整卷原子重写（临时文件 + rename）
//   exists(key)      -> boolean
//   remove(key)      -> void
import { DOCUMENT_IO_CONTRACT, isDocumentIo, createMemoryDocumentIo } from './document-io.js'

export const RECORD_IO_CONTRACT = ['readObjects', 'append', 'rewrite', 'exists', 'remove']

export function isRecordIo(io) {
  return Boolean(io) && RECORD_IO_CONTRACT.every((key) => typeof io[key] === 'function')
}

/** 把 JSONL 文本切成对象；坏行交给 onBadLine 处理（core 侧接 reportCatch） */
export function parseJsonLines(text, onBadLine = () => {}) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) }
    catch (err) { onBadLine(err, line) }
  }
  return rows
}

/**
 * 内存行式端口：基于文档端口实现，无 fs、无随机、无时钟。
 * append 与 rewrite 的语义与真实 fs 实现保持一致（rewrite 临键 + 落地）。
 */
export function createMemoryRecordIo({ initial = {} } = {}) {
  const docs = createMemoryDocumentIo({ initial })
  const dump = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  return {
    exists: (key) => docs.exists(key),
    readObjects: (key) => parseJsonLines(docs.read(key) ?? ''),
    append(key, row) {
      const next = (docs.read(key) ?? '') + JSON.stringify(row) + '\n'
      docs.write(key, next)
    },
    rewrite(key, rows) { docs.write(key, dump(rows)) },
    remove: (key) => docs.remove(key)
  }
}

export { isDocumentIo }
