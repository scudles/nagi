// src/core/store/document-io.js
// Store 与磁盘之间的窄端口：core 侧只认「文档键」，不认路径、不碰 fs、不读全局时钟。
//
// B7（P2-05）边界纪律：
//   core/store、core/signals、core/yearbook 里的一切必须是纯计算或编排，
//   真正的 fs / crypto（临时文件名）/ 时间源由调用方注入。
//   真实实现在 main 侧 src/main/store/document-io.js（全项目该文件族是唯一 fs 持有者）；
//   本文件提供纯内存实现，用于注入测试 —— 顺带保证「临时路径验证不写生产数据」。
//
// 端口契约（实现方必须全 fulfilled）：
//   exists(key)   -> boolean
//   read(key)     -> string | null  不存在返回 null
//   write(key, s) -> void           必须原子写（临时文件 + rename），写一半不留残
//   remove(key)   -> void           不存在不得抛错
//   keys()        -> string[]       已落盘的文档键
export const DOCUMENT_IO_CONTRACT = ['exists', 'read', 'write', 'remove', 'keys']

/** 端口体检：缺方法宁可早抛，也不要在半年后变成"读不到东西"的静默降级 */
export function isDocumentIo(io) {
  return Boolean(io) && DOCUMENT_IO_CONTRACT.every((key) => typeof io[key] === 'function')
}

/**
 * 依赖注入体检。required 由调用方按需声明：
 *   io  —— 需要落盘/读盘
 *   now —— 需要"此刻"（不得 Date.now() 兜底）
 *   rng —— 需要唯一标识（不得 randomUUID/Math.random 兜底）
 */
export function assertPorts(name, ports = {}, required = ['io', 'now', 'rng']) {
  const labels = {
    io: 'io（文档端口，core 不得直接触文件系统）',
    now: 'now()（core 不得读取全局时钟）',
    rng: 'rng()（core 不得读取全局随机）'
  }
  for (const key of required) {
    const value = ports[key]
    if (key === 'io' ? !isDocumentIo(value) : typeof value !== 'function') {
      throw new TypeError(`${name} 缺少注入依赖：${labels[key]}`)
    }
  }
  return ports
}

/** 读 JSON 文档；不存在或损坏 → fallback（损坏不抛，交由调用方决定可见性） */
export function readJsonDoc(io, key, fallback = null) {
  if (!isDocumentIo(io)) throw new TypeError('readJsonDoc 需要一个文档端口')
  const raw = io.read(key)
  if (raw === null || raw === undefined || raw === '') return fallback
  try { return JSON.parse(raw) }
  catch { return fallback }
}

/**
 * 内存文档端口：无 fs、无随机、无时钟。
 * 除了测试，也用于"换了后台也必须先注入才能跑"的体检场景。
 */
export function createMemoryDocumentIo({ initial = {}, rng } = {}) {
  const docs = new Map(Object.entries(initial))
  let seq = 0
  // 不引 Math.random：缺省实现用确定性计数器，保证同一序列可复算
  const nextId = rng || (() => `mem-${++seq}`)
  return {
    exists(key) { return docs.has(String(key)) },
    read(key) { return docs.has(String(key)) ? docs.get(String(key)) : null },
    write(key, value) {
      const safe = String(key)
      const temp = `${safe}.${nextId()}.tmp`
      docs.set(temp, String(value))
      docs.delete(temp)
      docs.set(safe, String(value))
    },
    remove(key) { docs.delete(String(key)) },
    keys() { return [...docs.keys()] }
  }
}

/** 只读快照：把任意端口包一层，任何写/删都抛 —— 用于证明「没写生产数据」 */
export function readOnlyDocumentIo(io) {
  return {
    exists: (key) => io.exists(key),
    read: (key) => io.read(key),
    keys: () => io.keys(),
    write() { throw new Error('只读端口：拒绝写入') },
    remove() { throw new Error('只读端口：拒绝删除') }
  }
}
