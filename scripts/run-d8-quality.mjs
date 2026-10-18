// D8 多轮真实输出：每场景独立 profile，复用 D9 的密钥隔离代理。
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.argv.includes('--key-stdin')) {
  let line = ''
  for await (const chunk of process.stdin) {
    line += String(chunk)
    if (line.includes('\n')) break
  }
  process.env.NAGI_D9_API_KEY = line.trim()
}
if (!String(process.env.NAGI_D9_API_KEY || '').trim()) throw new Error('缺少模型 API key')

const root = resolve(import.meta.dirname, '..')
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const ids = ['D8-STAB', 'D8-FACT', 'D8-TONE', 'D8-NOGRID', 'D8-REPEAT']
const only = process.argv.includes('--scene') ? process.argv[process.argv.indexOf('--scene') + 1] : null
if (only && !ids.includes(only)) throw new Error('未知 D8 场景：' + only)
const rows = []
for (const id of ids.filter((item) => !only || item === only)) {
  const report = `docs/d8-real-${id}.json`
  if (process.argv.includes('--resume') && existsSync(resolve(root, report))) {
    try {
      const saved = JSON.parse(readFileSync(resolve(root, report), 'utf8'))
      const scene = saved.scenes?.[0]
      if (saved.mode === 'real-model/isolated-profile' && saved.provider === 'deepseek/deepseek-flash' &&
          saved.gitHead === gitHead && scene?.scene === id && scene.reply && !scene.error) {
        rows.push({ scene: id, exitCode: 0, report, reused: true })
        console.log(`[D8 ${id}] 复用已采集样本`)
        continue
      }
    } catch { /* 重新采集 */ }
  }
  let output = '', errors = '', code = 1, attempts = 0
  for (attempts = 1; attempts <= 2; attempts++) {
    output = ''
    errors = ''
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'verify-d9.mjs'), '--suite', 'd8', '--scene', id, '--run', '1'], {
      cwd: root, env: { ...process.env, NAGI_D9_GIT_HEAD: gitHead }, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (part) => { output += String(part).slice(0, 3000) })
    child.stderr.on('data', (part) => { errors += String(part).slice(0, 3000) })
    code = await new Promise((done, reject) => { child.on('close', done); child.on('error', reject) })
    if (code === 0) break
    if (attempts < 2) {
      console.log(`[D8 ${id}] 上游未完成，重试一次`)
      await new Promise((done) => setTimeout(done, 3000))
    }
  }
  rows.push({ scene: id, exitCode: code, attempts: Math.min(attempts, 2), report,
    error: code ? errors.slice(-300) || output.slice(-300) : null })
  console.log(`[D8 ${id}] ${code === 0 ? '已采集' : '失败'}`)
  if (code !== 0) break
}
writeFileSync(resolve(root, 'docs/d8-real-index.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  gitHead, provider: 'deepseek', model: 'deepseek-flash', rows }, null, 2))
console.log(`D8 多轮样本采集 ${rows.filter((row) => row.exitCode === 0).length}/${rows.length}`)
if (rows.some((row) => row.exitCode !== 0)) process.exitCode = 1
delete process.env.NAGI_D9_API_KEY
