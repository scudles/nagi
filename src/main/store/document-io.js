// src/main/store/document-io.js
// 文档端口的真实 fs 实现 —— B7（P2-05）边界拆分后，signals/ledger/yearbook
// 的落盘路径只在这里出现；core 侧一律拿「文档键」，不知道自己在哪个目录。
//
// 纪律：临时文件名用注入的 rng（默认 randomUUID），写完 rename，绝不在目标文件上截断写。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * @param {object} opts
 * @param {string} opts.root  落盘根目录（真实实现才关心路径）
 * @param {Record<string,string>} opts.files 文档键 → 相对 root 的路径
 * @param {() => string} [opts.rng]
 */
export function createFsDocumentIo({ root, files, rng = randomUUID }) {
  const base = resolve(String(root))
  const table = { ...files }
  const pathOf = (key) => {
    const rel = table[String(key)]
    if (!rel) throw new Error(`未登记的文档键：${String(key)}`)
    return join(base, rel)
  }
  return {
    exists(key) { return existsSync(pathOf(key)) },
    read(key) {
      const path = pathOf(key)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    write(key, value) {
      const path = pathOf(key)
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${rng()}.tmp`
      writeFileSync(temp, String(value), 'utf8')
      renameSync(temp, path)
    },
    remove(key) { rmSync(pathOf(key), { force: true }) },
    keys() { return Object.keys(table).filter((key) => existsSync(pathOf(key))) }
  }
}

/** signals 三兄弟共用的落盘根目录与文件表 */
export function signalsDocumentIo(userDataDir, { rng = randomUUID } = {}) {
  return createFsDocumentIo({
    root: join(String(userDataDir), 'signals'),
    files: {
      'geo-consent': 'geo.json',
      'music-consent': 'music.json',
      'calendar-ics': 'calendar.ics',
      'calendar-meta': 'calendar.json'
    },
    rng
  })
}
