// D9 真模型首轮：16 个样本逐个启动全新隔离 profile，避免前一条样本的记忆污染下一条。
// 只采集原始输出与客观时间；六维评分必须按 EVAL §0 人工填写。
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.argv.includes('--key-stdin')) {
  let line = ''
  for await (const chunk of process.stdin) {
    line += String(chunk)
    if (line.includes('\n')) break
  }
  process.env.NAGI_D9_API_KEY = line.trim()
}
if (!String(process.env.NAGI_D9_API_KEY || '').trim()) {
  throw new Error('缺少 NAGI_D9_API_KEY；请通过环境变量或 --key-stdin 提供')
}

const root = resolve(import.meta.dirname, '..')
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const ids = ['A1', 'A3', 'B1', 'B2', 'C4', 'D1', 'E1', 'F3']
const onlyProbe = process.argv.includes('--probe')
const resume = process.argv.includes('--resume')
const rows = []
outer: for (const id of ids) for (const run of [1, 2]) {
  if (onlyProbe && (id !== 'A1' || run !== 1)) continue
  const report = `docs/d9-real-${id}-${run}.json`
  if (resume && existsSync(resolve(root, report))) {
    try {
      const saved = JSON.parse(readFileSync(resolve(root, report), 'utf8'))
      const scene = saved.scenes?.[0]
      if (saved.mode === 'real-model/isolated-profile' && saved.provider === 'deepseek/deepseek-flash' &&
          saved.gitHead === gitHead && scene?.scene === id && scene?.run === run && scene.reply && !scene.error) {
        rows.push({ scene: id, run, exitCode: 0, report, reused: true, error: null })
        console.log(`[D9 ${id}·${run}] 复用已采集样本`)
        continue
      }
    } catch { /* 重新采集 */ }
  }
  let output = ''
  let errors = ''
  let code = 1
  let attempts = 0
  for (attempts = 1; attempts <= 2; attempts++) {
    output = ''
    errors = ''
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'verify-d9.mjs'), '--scene', id, '--run', String(run)], {
      cwd: root,
      env: { ...process.env, NAGI_D9_GIT_HEAD: gitHead },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (part) => { output += String(part).slice(0, 3000) })
    child.stderr.on('data', (part) => { errors += String(part).slice(0, 3000) })
    code = await new Promise((done, reject) => { child.on('close', done); child.on('error', reject) })
    if (code === 0) break
    if (attempts < 2) {
      console.log(`[D9 ${id}·${run}] 上游未完成，重试一次`)
      await new Promise((done) => setTimeout(done, 3000))
    }
  }
  rows.push({ scene: id, run, exitCode: code, attempts: Math.min(attempts, 2), report, error: code ? errors.slice(-300) || output.slice(-300) : null })
  console.log(`[D9 ${id}·${run}] ${code === 0 ? '已采集' : '失败'}`)
  if (code !== 0) break outer
}

const indexPath = resolve(root, 'docs', 'd9-real-index.json')
writeFileSync(indexPath, JSON.stringify({ generatedAt: new Date().toISOString(), gitHead,
  provider: 'deepseek', model: 'deepseek-flash', scoring: 'pending-human-review', rows }, null, 2))
const passed = rows.filter((row) => row.exitCode === 0).length
console.log(`D9 真模型样本采集 ${passed}/${rows.length}；人工六维评分仍待填写。索引：${indexPath}`)
if (passed !== rows.length) process.exitCode = 1
delete process.env.NAGI_D9_API_KEY
