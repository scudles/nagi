// src/main/store/legacy-reader.js
// 迁移源只读端口的真实 fs 实现（B7 P2-05）。
//
// 迁移是"读旧 AdminQueen版本散落文件"的唯一入口，所以这里比别处更严：
//   · 引用必须先落在 root 内（拒绝 ../../ 之类的路径穿越）
//   · 且必须命中白名单前缀（只允许旧版本那几处已知位置）
// 被拒绝的引用按"不存在"处理：迁移跳过，绝不因为目录里多了个文件就去读它。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export function createFsLegacyReader({ root, allow = [] } = {}) {
  const base = resolve(String(root))
  const allowed = allow.map((entry) => String(entry).replace(/^\/+|\/+$/g, ''))
  const guard = (ref) => {
    const abs = resolve(base, String(ref))
    if (abs !== base && !abs.startsWith(base + sep)) {
      throw new Error(`迁移源引用越界：${String(ref)}`)
    }
    // 注意：Windows 上 resolve() 返回的是反斜杠路径，白名单比较必须先把分隔符统一成正斜杠，
    // 否则 'journal/2026-10-14.json' 会被算成白名单外并静默按"不存在"跳过（迁移悄悄半途而废）。
    const rel = abs === base ? '' : abs.slice(base.length + 1).split(sep).join('/')
    if (rel && !allowed.some((prefix) => rel === prefix || rel.startsWith(prefix + '/'))) {
      throw new Error(`迁移源引用不在白名单内：${rel}`)
    }
    return abs
  }
  // B8:degrade —— 迁移源本就可能缺失（全新安装）；被守卫拒绝的引用同样按"没有"处理，
  // 这样"目录里多出一个陌生文件"不会变成崩溃，也不会变成读进去。
  const readOne = (ref) => {
    try {
      const abs = guard(ref)
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null
    } catch { return null }
  }
  return {
    exists(ref) {
      try { return existsSync(guard(ref)) }
      catch { return false }
    },
    list(ref) {
      try {
        const abs = guard(ref)
        if (!existsSync(abs) || !statSync(abs).isDirectory()) return []
        return readdirSync(abs)
      } catch { return [] }
    },
    read: readOne,
    readObjects(ref) {
      const text = readOne(ref)
      return text == null ? [] : text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }
  }
}

/** 旧版本数据只在这几处；别的位置就算有同名文件也不属于迁移源 */
export function userDataLegacyReader(userDataDir) {
  return createFsLegacyReader({
    root: String(userDataDir),
    allow: ['journal', 'monologue', 'timeline', 'rag', 'memory.json', 'history.json', 'relation.json']
  })
}
