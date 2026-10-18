// B7 现状审计：只读扫描待拆分 store 的直接 IO/时钟/随机依赖。
// 默认只报告，迁移完成后用 --strict 把残留依赖作为失败门禁。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = [
  'src/core/ledger/store.js',
  'src/core/yearbook/store.js',
  'src/core/signals/calendar-store.js',
  'src/core/signals/music-store.js',
  'src/core/signals/geo-store.js'
]
const checks = [
  ['directFs', /(?:from\s*['"](?:node:)?fs['"]|require\(['"](?:node:)?fs['"]\))/],
  ['directElectron', /(?:from\s*['"]electron['"]|require\(['"]electron['"]\))/],
  ['globalClock', /\bDate\.now\s*\(/],
  ['globalRandom', /\bMath\.random\s*\(|\brandomUUID\s*\(/],
  ['globalProcess', /\bprocess\s*\./]
]

const findings = targets.map((path) => {
  const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/)
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[i])) continue
    for (const [rule, pattern] of checks) if (pattern.test(lines[i])) violations.push({ line: i + 1, rule })
  }
  return { path, violations }
})
const total = findings.reduce((sum, item) => sum + item.violations.length, 0)
const report = { generatedAt: new Date().toISOString(), mode: process.argv.includes('--strict') ? 'strict' : 'audit',
  scope: 'B7 待拆分 store 的直接边界依赖；静态审计，不代替注入/行为测试', total, findings }
const out = resolve(root, 'docs', 'b7-boundary-audit.json')
writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`B7 边界审计：${targets.length} 个文件、${total} 处直接依赖；报告 ${out}`)
if (process.argv.includes('--strict') && total) process.exitCode = 1
