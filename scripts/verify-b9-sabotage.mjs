// B9 防腐检查：在临时副本中单点破坏关键不变量，要求对应测试从绿变红。
// 不修改工作区源码；不运行 Electron 设备项。
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(root, '.b9-sabotage-'))
const cases = [
  { id: 'B9-KEY-crisis', file: 'src/core/agent/offline.js',
    from: 'if (safetyLevel === SAFETY_LEVEL.CRISIS) {',
    to: 'if (false && safetyLevel === SAFETY_LEVEL.CRISIS) {',
    tests: ['test/offline-crisis.test.js'] },
  { id: 'B9-KEY-dnd', file: 'src/core/companion/budget.js',
    from: "if (privacy.doNotDisturb === true) return { allowed: false, reason: 'dnd', state }",
    to: "if (false && privacy.doNotDisturb === true) return { allowed: false, reason: 'dnd', state }",
    tests: ['test/companion-budget.test.js'] },
  { id: 'B9-SABO-forget', file: 'src/main/ledger-actions.js',
    from: 'const notePruned = pruneNotesReferencing([entry.text, ...parts])',
    to: 'const notePruned = { removed: 0 }',
    tests: ['test/forget-e2e.test.js'] },
  { id: 'B9-SABO-title', file: 'src/core/signals/title-outbound.js',
    from: 'if (privacy.titleOutbound === false) return',
    to: 'if (false && privacy.titleOutbound === false) return',
    tests: ['test/title-outbound.test.js'] },
  { id: 'B9-SABO-reminder', file: 'src/core/reminders/delivery.js',
    from: 'if (!state.notified && !state.unavailable) {',
    to: 'if (true) {',
    tests: ['test/reminder-delivery.test.js'] },
  { id: 'B9-SABO-rag-queue', file: 'src/main/rag/index.js',
    from: 'const remain = this.io.readPending().filter((x) => !done.has(x.id) && !this.revoked.has(x.id))',
    to: 'const remain = queue.filter((x) => !done.has(x.id) && !this.revoked.has(x.id))',
    tests: ['test/rag-revocation.test.js'] },
  { id: 'B9-SABO-reunion-release', file: 'src/core/agent/reunion-coordinator.js',
    from: 'if (active === controller) active = null',
    to: 'if (false && active === controller) active = null',
    tests: ['test/reunion-coordinator.test.js'] },
  { id: 'B9-SABO-intent-safety', file: 'src/core/agent/intent.js',
    from: 'if (crisis) {',
    to: 'if (false && crisis) {',
    tests: ['test/intent.test.js'] },
  { id: 'B9-SABO-tone-lifecycle', file: 'src/core/emotion/tone.js',
    from: 'beginTurn() {',
    to: 'beginTurn() { return',
    tests: ['test/emotion-tone.test.js'] },
  { id: 'B9-SABO-hook-order', file: 'src/core/face/hook-registry.js',
    from: 'for (const id of order) active.get(id)?.()',
    to: 'for (const id of [...order].reverse()) active.get(id)?.()',
    tests: ['test/live2d-hook-registry.test.js'] },
  { id: 'B9-X10-companion', file: 'src/core/companion/budget.js',
    from: 'const IGNORE_AFTER_MS = 20 * 60000',
    to: 'const IGNORE_AFTER_MS = 200 * 60000',
    tests: ['test/companion-budget.test.js'] },
  { id: 'B9-DIV10-companion', file: 'src/core/companion/budget.js',
    from: 'const IGNORE_AFTER_MS = 20 * 60000',
    to: 'const IGNORE_AFTER_MS = 2 * 60000',
    tests: ['test/companion-budget.test.js'] },
  { id: 'B9-X10-pose-angle', file: 'src/core/pose.js',
    from: 'ParamAngleX: -4,', to: 'ParamAngleX: -40,',
    tests: ['test/pose-guard.test.js'] },
  { id: 'B9-DIV10-pose-angle', file: 'src/core/pose.js',
    from: 'ParamAngleX: -4,', to: 'ParamAngleX: -0.4,',
    tests: ['test/pose-guard.test.js'] }
]

function run(tests) {
  try {
    const output = execFileSync(process.execPath,
      ['--experimental-test-module-mocks', '--test', ...tests],
      { cwd: temp, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
    return { exitCode: 0, failed: Number(output.match(/(?:#|ℹ) fail (\d+)/)?.[1] || 0) }
  } catch (err) {
    const output = String(err.stdout || '') + String(err.stderr || '')
    return { exitCode: Number.isInteger(err.status) ? err.status : -1,
      failed: Number(output.match(/(?:#|ℹ) fail (\d+)/)?.[1] || 0),
      error: output.match(/(?:error:|failureType:|ERR_)[^\r\n]*/)?.[0]?.slice(0, 180) || err.message.slice(0, 180),
      detail: output.slice(-700) }
  }
}

const results = []
try {
  cpSync(join(root, 'src'), join(temp, 'src'), { recursive: true })
  cpSync(join(root, 'test'), join(temp, 'test'), { recursive: true })
  cpSync(join(root, 'scripts', 'fixtures'), join(temp, 'scripts', 'fixtures'), { recursive: true })
  cpSync(join(root, 'package.json'), join(temp, 'package.json'))
  cpSync(join(root, 'cloud-config.js'), join(temp, 'cloud-config.js'))
  for (const item of cases) {
    const path = join(temp, item.file)
    const original = readFileSync(path, 'utf8')
    const occurrences = original.split(item.from).length - 1
    if (occurrences !== 1) throw new Error(`${item.id}: 预期精确命中 1 处，实际 ${occurrences}`)
    const baseline = run(item.tests)
    writeFileSync(path, original.replace(item.from, item.to))
    const sabotaged = run(item.tests)
    writeFileSync(path, original)
    const detected = baseline.exitCode === 0 && sabotaged.exitCode !== 0 &&
      (sabotaged.failed > 0 || /ERR_ASSERTION|testCodeFailure/.test(sabotaged.error || ''))
    results.push({ id: item.id, tests: item.tests, baseline, sabotaged, detected })
    console.log(`${item.id}: ${detected ? '检测到破坏' : '未检出或基线异常'}`)
  }
} finally {
  const safe = resolve(temp)
  if (!safe.startsWith(root + sep) || !basename(safe).startsWith('.b9-sabotage-')) {
    throw new Error('拒绝清理非 B9 临时副本')
  }
  rmSync(safe, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}

const report = { generatedAt: new Date().toISOString(), kind: 'policy/mock-io mutation audit',
  deviceCoverage: 'not-run', total: results.length, detected: results.filter((r) => r.detected).length, results }
writeFileSync(join(root, 'docs', 'b9-sabotage-audit.json'), JSON.stringify(report, null, 2))
console.log(`B9 破坏检测 ${report.detected}/${report.total}`)
if (report.detected !== report.total) process.exitCode = 1
