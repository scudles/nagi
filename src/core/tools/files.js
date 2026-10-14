// src/core/tools/files.js
// 文件工具：读取 / 写入 / 列目录。所有路径强制限制在授权根目录（fileRoot）内。
// 纯 Node 依赖（fs/promises + path），无 Electron。

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { isPathWithin } from '../safety/policy.js'

const MAX_READ_BYTES = 64 * 1024

export class PathOutsideRootError extends Error {
  constructor(path, root) {
    super(`路径越界：${path} 不在授权目录 ${root} 内`)
    this.name = 'PathOutsideRootError'
  }
}

/** 把相对/绝对路径收敛到 fileRoot 内的绝对路径 */
export function resolveWithin(fileRoot, p) {
  if (!fileRoot) throw new Error('未配置文件工具的授权目录（fileRoot），请在设置里指定')
  if (!p || typeof p !== 'string') throw new Error('缺少 path 参数')
  const abs = resolve(fileRoot, p)
  if (!isPathWithin(fileRoot, abs)) throw new PathOutsideRootError(p, fileRoot)
  return normalize(abs)
}

/**
 * @param {{fileRoot:string}} cfg
 * @returns {{read:Function, write:Function, list:Function}}
 */
export function createFileTools(cfg) {
  const guard = (p) => resolveWithin(cfg.fileRoot, p)

  return {
    /** file_read {path, maxBytes?} */
    async read(args) {
      const abs = guard(args.path)
      const info = await stat(abs)
      if (info.isDirectory()) {
        return { ok: false, summary: `${args.path} 是目录，请用 file_list 列目录` }
      }
      const limit = Math.min(Number(args.maxBytes) || MAX_READ_BYTES, MAX_READ_BYTES)
      const fh = await import('node:fs/promises').then((m) => m.open(abs, 'r'))
      try {
        const buf = Buffer.alloc(Math.min(limit, info.size))
        await fh.read(buf, 0, buf.length, 0)
        const text = buf.toString('utf8')
        const truncated = info.size > buf.length
        return {
          ok: true,
          summary: `${args.path}（${info.size} 字节${truncated ? '，已截断' : ''}）：\n${text.slice(0, 4000)}`,
          data: { path: abs, size: info.size, truncated, text }
        }
      } finally {
        await fh.close()
      }
    },

    /** file_write {path, content, append?} */
    async write(args) {
      const abs = guard(args.path)
      const content = args.content == null ? '' : String(args.content)
      await mkdir(dirname(abs), { recursive: true })
      if (args.append) {
        const old = await readFile(abs, 'utf8').catch(() => '')
        await writeFile(abs, old + content, 'utf8')
      } else {
        await writeFile(abs, content, 'utf8')
      }
      return { ok: true, summary: `已${args.append ? '追加' : '写入'} ${args.path}（${Buffer.byteLength(content, 'utf8')} 字节）`, data: { path: abs } }
    },

    /** file_list {path?, depth?} */
    async list(args) {
      const abs = guard(args.path || '.')
      const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3)
      const out = []
      const walk = async (dir, rel, d) => {
        let entries = []
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (e) {
          out.push(`${rel}/  (无法读取: ${e.message})`)
          return
        }
        for (const ent of entries.slice(0, 200)) {
          const full = join(dir, ent.name)
          const r = rel ? `${rel}/${ent.name}` : ent.name
          if (ent.isDirectory()) {
            out.push(`${r}/`)
            if (d < depth) await walk(full, r, d + 1)
          } else {
            try {
              const st = await stat(full)
              out.push(`${r}  (${st.size}B)`)
            } catch {
              out.push(r)
            }
          }
        }
      }
      await walk(abs, '', 1)
      const lines = out.slice(0, 120)
      return {
        ok: true,
        summary: `${args.path || '.'} 下 ${lines.length}${out.length > 120 ? '+' : ''} 项：\n` + lines.join('\n'),
        data: { entries: out }
      }
    }
  }
}

/** 供确认描述用 */
export function relTo(root, p) {
  try {
    const a = resolve(root, p)
    return a.slice(root.length).replace(/^[\\/]/, '') || '.'
  } catch {
    return p
  }
}

export { join, sep }
