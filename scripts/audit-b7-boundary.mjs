// B7（P2-05）边界检查：core 侧不得直接持有 IO / 全局时钟 / 全局随机。
//
// 两种范围：
//   gate（默认、也是门禁）：本批已完成迁移的五个 store + core/store 端口祖нина
//           这些地方已经有替代路径（注入 io/now/rng），再写回 Date.now() 就是回潮。
//   core ：src/core 全量，只出报告不出门禁。剩余的那些 Date.now() 是另一个量级的工程，
//           先把家底摆出来，别假装已经清干净。
//
// 用法：
//   node scripts/audit-b7-boundary.mjs            生成报告（docs/b7-boundary-audit.json）
//   node scripts/audit-b7-boundary.mjs --strict   有残留则退出码 1
//   import { scanBoundary } from './scripts/audit-b7-boundary.mjs'   由测试直接调用
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const BOUNDARY_RULES = [
  ['directFs', /(?:from\s*['"](?:node:)?fs['"]|require\(['"](?:node:)?fs['"]\))/, '直接触文件系统：应走注入的存储端口'],
  ['directCrypto', /\bfrom\s*['"](?:node:)?crypto['"]/, '直接用 crypto：多半是 randomUUID/sha，应走注入的 rng 或纯计算'],
  ['directElectron', /(?:from\s*['"]electron['"]|require\(['"]electron['"]\))/, 'core 不得依赖 Electron'],
  ['globalClock', /\bDate\.now\s*\(/, '读全局时钟：时间必须由调用方注入 now()'],
  ['globalRandom', /\bMath\.random\s*\(|\brandomUUID\s*\(/, '读全局随机：唯一 id 必须由调用方注入 rng()']
]

/** 门禁范围：已完成迁移、且已有替代路径的地方（回潮即失败） */
export const MIGRATED_GATE = [
  'src/core/ledger/store.js',
  'src/core/yearbook/store.js',
  'src/core/signals/calendar-store.js',
  'src/core/signals/music-store.js',
  'src/core/signals/geo-store.js',
  'src/core/store/document-io.js',
  'src/core/store/record-io.js',
  'src/core/store/legacy-reader.js',
  // —— core 边界存量迁移第一批（DECISIONS D69）：signals 纯函数层 + 导出组装层 ——
  // 这一批的共同点是"只差一个 now 就能算"，因此替代路径统一是 requireNow()
  // （src/core/clock.js）；缺 now 当场抛，不许退回全局时钟。
  'src/core/clock.js',
  'src/core/signals/calendar.js',
  'src/core/signals/foreground.js',
  'src/core/signals/music.js',
  'src/core/signals/players.js',
  'src/core/export/build.js'
]

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/
const ALLOW_MARK = /\/\*\s*B7:allow:([a-zA-Z]+)\s*—/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith('.js')) out.push(path)
  }
  return out
}

/** 扫描单个文件，返回违规数组 */
export function scanFile(file, root = process.cwd()) {
  const violations = []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (COMMENT_LINE.test(line)) continue
    const allow = line.match(ALLOW_MARK)?.[1]
    for (const [rule, pattern, why] of BOUNDARY_RULES) {
      if (!pattern.test(line) || allow === rule) continue
      violations.push({ line: i + 1, rule, why, text: line.trim().slice(0, 120) })
    }
  }
  return { path: relative(root, file).split(/\\/).join('/'), violations }
}

/** 扫描一个目录下的所有 .js */
export function scanBoundary(dir, root = process.cwd()) {
  const findings = []
  for (const file of walk(dir)) {
    const result = scanFile(file, root)
    if (result.violations.length) findings.push(result)
  }
  return findings
}

export function run({ root, scope = 'gate', strict = false, write = true } = {}) {
  const base = root || resolve(import.meta.dirname, '..')
  const targets = scope === 'core'
    ? walk(join(base, 'src', 'core'))
    : MIGRATED_GATE.map((entry) => join(base, ...entry.split('/')))
  const findings = scope === 'core'
    ? scanBoundary(join(base, 'src', 'core'), base)
    : targets.map((file) => scanFile(file, base)).filter((item) => item.violations.length)
  const total = findings.reduce((sum, item) => sum + item.violations.length, 0)
  const report = {
    generatedAt: new Date().toISOString(),
    mode: strict ? 'strict' : 'audit',
    scope: scope === 'core'
      ? 'src/core 全量：只报告不出门禁——剩余的缺的不是决心，是排期'
      : 'B7 已迁移的五个 store 与 core/store 端口：这里的越界依赖必须归零，否则视为回潮',
    gate: scope === 'gate',
    total,
    findings
  }
  const outName = scope === 'core' ? 'b7-boundary-core-report.json' : 'b7-boundary-audit.json'
  if (write) writeFileSync(join(base, 'docs', outName), JSON.stringify(report, null, 2) + '\n')
  return { total, findings, report }
}

import { fileURLToPath } from 'node:url'

const selfPath = typeof process.argv[1] === 'string'
  ? resolve(process.argv[1])
  : null
const invokedDirectly = selfPath && fileURLToPath(import.meta.url) === selfPath
if (invokedDirectly) {
  const strict = process.argv.includes('--strict')
  const scope = process.argv.includes('--scope=core') ? 'core' : 'gate'
  const { total, findings } = run({ strict, scope })
  console.log(`B7 边界检查（${scope === 'core' ? 'src/core 全量，只报告' : '已迁移文件，门禁'}）：${total} 处越界依赖`)
  for (const item of findings) {
    console.log(`  ${item.path}: ${item.violations.map((v) => `${v.line}行 ${v.rule}`).join('，')}`)
  }
  if (strict && scope === 'gate' && total) process.exitCode = 1
}
