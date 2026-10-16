// src/core/tools/files.js
// 文件工具：读取 / 写入 / 列目录。所有路径强制限制在授权根目录（fileRoot）内。
// 纯 Node 依赖（fs/promises + path），无 Electron。

import { readFile, writeFile, mkdir, readdir, stat, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
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

/** 实际文件访问前再校验物理路径；路径中的符号链接不得指向授权根外。 */
export async function resolveRealWithin(fileRoot, p) {
  const abs = resolveWithin(fileRoot, p)
  const rootReal = await realpath(fileRoot)
  const targetReal = await realpath(abs)
  if (!isPathWithin(rootReal, targetReal)) throw new PathOutsideRootError(p, fileRoot)
  return targetReal
}

/** 写入先逐级创建/校验真实父目录，然后在同目录原子替换目标。 */
async function writableTarget(fileRoot, p) {
  const abs = resolveWithin(fileRoot, p)
  const rootReal = await realpath(fileRoot)
  const parts = relative(resolve(fileRoot), dirname(abs)).split(sep).filter(Boolean)
  let parent = rootReal
  for (const part of parts) {
    const next = join(parent, part)
    try {
      const info = await lstat(next)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PathOutsideRootError(p, fileRoot)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      await mkdir(next)
    }
    parent = await realpath(next)
    if (!isPathWithin(rootReal, parent)) throw new PathOutsideRootError(p, fileRoot)
  }
  const target = join(parent, basename(abs))
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new PathOutsideRootError(p, fileRoot)
    const actual = await realpath(target)
    if (!isPathWithin(rootReal, actual)) throw new PathOutsideRootError(p, fileRoot)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return target
}

/**
 * @param {{fileRoot:string}} cfg
 * @returns {{read:Function, write:Function, list:Function}}
 */
export function createFileTools(cfg) {
  const guard = (p) => resolveRealWithin(cfg.fileRoot, p)

  return {
    /** file_read {path, maxBytes?} */
    async read(args) {
      const abs = await guard(args.path)
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
      const abs = await writableTarget(cfg.fileRoot, args.path)
      const content = args.content == null ? '' : String(args.content)
      let next = content
      if (args.append) {
        try {
          next = (await readFile(abs, 'utf8')) + content
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      }
      const temp = join(dirname(abs), `.${basename(abs)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temp, next, { encoding: 'utf8', flag: 'wx' })
        await rename(temp, abs)
      } finally {
        await unlink(temp).catch(() => {})
      }
      return { ok: true, summary: `已${args.append ? '追加' : '写入'} ${args.path}（${Buffer.byteLength(content, 'utf8')} 字节）`, data: { path: abs } }
    },

    /** file_list {path?, depth?} */
    async list(args) {
      const abs = await guard(args.path || '.')
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
          if (ent.isSymbolicLink()) {
            out.push(`${r}  (链接，未跟随)`)
          } else if (ent.isDirectory()) {
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
