// scripts/b8-catch-audit.mjs
// B8（P2-04）：空 catch 的审计器 + 逐点分类打标器（唯一出处）。
//
// 两件事：
//  1. `node scripts/b8-catch-audit.mjs scan`   —— 扫描 src，列出所有空 catch 是否已被处理
//     （"处理"= 已接 reportCatch，或带了 /* B8:<class> — <理由> */ 显式分级）。
//     任何**新写的**空 catch 没有这两样之一就退出非 0 —— 防-null-catch 回潮。
//  2. `node scripts/b8-catch-audit.mjs ledger` —— 生成 docs/b8-catch-ledger.json 台账。
//
// 为什么要显式打标而不是"我看过了"：
//   "岁月无声"的失败和"缓存没命中"的失败在代码里长得一模一样，
//   只有写下来的分类能在半年后告诉别人（和我自己）当时为什么允许它静默。
//
// renderer/ 与 vendor/ 不在本次入账范围：渲染层由红区负责（三区分工），
// 这里只做清单统计，要接上报需先过红区裁决。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['src/main', 'src/core']
const SKIP = new Set([
  'src/core/maintenance/catch-audit.js',
  'src/core/maintenance/event-trace.js',
  'src/main/maintenance.js'
])

const CATCH_RE = /catch\s*(\([^)]*\))?\s*\{([^{}]*?)\}/gs
const ONLY_COMMENT = /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)?(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*$/
const MARKER_RE = /B8:\s*(degrade|visible|must-persist|promise|semantic)\s*[—-]/

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (name.endsWith('.js')) acc.push(p)
  }
  return acc
}

/** 列出所有空 catch 及其处置状态 */
export function scanCatches(root = ROOT) {
  const out = []
  for (const d of SCAN_DIRS) {
    const abs = join(root, d)
    for (const file of walk(abs)) {
      const rel = file.slice(root.length + 1).replace(/\\/g, '/')
      if (SKIP.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(CATCH_RE)) {
        const body = m[2]
        if (!ONLY_COMMENT.test(body.trim())) continue
        const line = src.slice(0, m.index).split('\n').length
        const noted = body.includes('reportCatch(')
        const mark = body.match(MARKER_RE)
        out.push({ file: rel, line, reported: noted, cls: mark ? mark[1] : null, body: body.trim().slice(0, 160) })
      }
    }
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sites = scanCatches()
  const cmd = process.argv[2] || 'scan'
  if (cmd === 'ledger') {
    writeFileSync(join(ROOT, 'docs', 'b8-catch-ledger.json'),
      JSON.stringify({ generatedBy: 'scripts/b8-catch-audit.mjs', total: sites.length, sites }, null, 2), 'utf8')
    console.log(`台账已生成：${sites.length} 处`)
  } else {
    const unhandled = sites.filter((s) => !s.reported && !s.cls)
    const counts = {}
    for (const s of sites) {
      const k = s.reported ? 'reported' : (s.cls || 'unhandled')
      counts[k] = (counts[k] || 0) + 1
    }
    console.log(`空 catch 合计 ${sites.length} 处：`, counts)
    if (unhandled.length) {
      for (const u of unhandled) console.error(`  [未分级] ${u.file}:${u.line}  ${u.body.slice(0, 80)}`)
      console.error(`\n${unhandled.length} 处空 catch 既没接上报也没标分级。补一条 /* B8:<类> — 理由 */，或接 reportCatch。`)
      process.exit(1)
    }
    console.log('全部空 catch 已处置。')
  }
}
