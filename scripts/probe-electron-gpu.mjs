// 临时探针：试各种开关组合，看本机 Electron 能不能起来（GPU 进程崩溃排查用）
// 用法：node scripts/probe-electron-gpu.mjs <组合名>
//   组合： plain | nosandbox | swiftshader | nosandbox+swiftshader
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const combo = process.argv[2] || 'plain'

const FLAGS = {
  plain: [],
  flagonly: [],
  nosandbox: ['--no-sandbox'],
  swiftshader: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  'nosandbox+swiftshader': [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
  ]
}

const ENV = {
  plain: {},
  flagonly: { NAGI_RENDERER_SANDBOX: '0' },
  nosandbox: { NAGI_RENDERER_SANDBOX: '0' },
  swiftshader: {},
  'nosandbox+swiftshader': { NAGI_RENDERER_SANDBOX: '0' }
}

const dir = mkdtempSync(join(tmpdir(), 'nagi-gpu-probe-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'x' },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
    },
    null,
    2
  ),
  'utf8'
)

const env = { ...process.env, ...(ENV[combo] || {}) }
delete env.ELECTRON_RUN_AS_NODE

const args = [
  '.',
  `--user-data-dir=${dir}`,
  '--remote-debugging-port=9333',
  ...(FLAGS[combo] || [])
]
console.log(`组合 ${combo}：env=${JSON.stringify(ENV[combo] || {})} flags=${JSON.stringify(FLAGS[combo] || [])}`)

const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
const lines = []
const push = (tag) => (buf) => {
  for (const l of String(buf).split(/\r?\n/)) if (l.trim()) lines.push(`[${tag}] ${l}`)
}
child.stdout.on('data', push('out'))
child.stderr.on('data', push('err'))

const ms = Number(process.env.PROBE_MS || 14000)
await new Promise((r) => setTimeout(r, ms))

const alive = child.exitCode === null
console.log(`\n--- ${ms}ms 后：进程${alive ? '仍存活' : `已退出(${child.exitCode})`}，日志 ${lines.length} 行 ---`)
console.log(lines.slice(-40).join('\n'))
if (!alive || lines.length === 0) {
  console.log('\n(没有可用输出 = 大概率没起来)')
}
try {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
} catch {}
process.exit(0)
