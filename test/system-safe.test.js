// test/system-safe.test.js
// run_command 两条执行路径单测（S01 修复，2026-10-15）：
//   受控路径 —— opts.safe 存在 → execFile(shell:false)，固定可执行文件 + 校验过的 argv
//   完整路径 —— 无 safe → exec() 完整 shell（仅用户确认后到达）
// 通过 mock.module 替换 node:child_process，不产生真实子进程。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const calls = { exec: [], execFile: [] }
let execFileBehavior = 'ok' // 'ok' | 'timeout'

mock.module('node:child_process', {
  namedExports: {
    exec: (cmd, opts, cb) => {
      calls.exec.push({ cmd, opts })
      cb(null, { stdout: 'shell-out', stderr: '' })
    },
    execFile: (file, args, opts, cb) => {
      calls.execFile.push({ file, args, opts })
      if (execFileBehavior === 'timeout') {
        const err = new Error('killed')
        err.killed = true
        cb(err)
        return
      }
      cb(null, { stdout: 'file-out', stderr: '' })
    },
    spawn: () => {
      throw new Error('spawn 不应在 run_command 路径被调用')
    }
  }
})

const { createSystemTools } = await import('../src/core/tools/system.js')

function reset() {
  calls.exec.length = 0
  calls.execFile.length = 0
  execFileBehavior = 'ok'
}

test('受控路径：execFile 收到固定可执行文件与校验过的 argv，不过 shell', async () => {
  reset()
  const sys = createSystemTools({})
  const r = await sys.run({ command: 'dir /a' }, { safe: { file: 'cmd.exe', args: ['/c', 'dir', '/a'] } })
  assert.equal(calls.execFile.length, 1)
  assert.equal(calls.exec.length, 0, '受控路径不得走 exec')
  assert.equal(calls.execFile[0].file, 'cmd.exe')
  assert.deepEqual(calls.execFile[0].args, ['/c', 'dir', '/a'])
  assert.notEqual(calls.execFile[0].opts.shell, true, '不得启用 shell')
  assert.equal(r.ok, true)
  assert.ok(r.data.stdout.includes('file-out'))
  assert.ok(r.summary.includes('dir /a'))
  assert.ok(r.summary.includes('已执行'))
})

test('完整路径：无 safe 时仍走 exec 全串（回归既有行为）', async () => {
  reset()
  const sys = createSystemTools({})
  const r = await sys.run({ command: 'echo hi && dir' })
  assert.equal(calls.exec.length, 1)
  assert.equal(calls.execFile.length, 0)
  assert.equal(calls.exec[0].cmd, 'echo hi && dir')
  assert.equal(r.ok, true)
  assert.ok(r.data.stdout.includes('shell-out'))
})

test('cwd 约束：授权目录外拒绝且不产生子进程，目录内放行', async () => {
  reset()
  const sys = createSystemTools({ cwd: 'D:/fallback', fileRoot: 'D:/work' })
  // 越权：模型请求的 cwd 在授权根之外
  const r = await sys.run({ command: 'node -v', cwd: 'D:/other' }, { safe: { file: 'node', args: ['-v'] } })
  assert.equal(r.ok, false)
  assert.ok(r.summary.includes('拒绝执行'), r.summary)
  assert.equal(calls.execFile.length + calls.exec.length, 0, '拒绝时不得产生任何子进程')
  // 授权目录内：放行
  const r2 = await sys.run({ command: 'node -v', cwd: 'D:/work/sub' }, { safe: { file: 'node', args: ['-v'] } })
  assert.equal(r2.ok, true)
  assert.equal(calls.execFile.length, 1)
  // 未配置授权目录：不采用模型请求的 cwd，回退 cfg.cwd，不拒绝
  const sys2 = createSystemTools({ cwd: 'D:/fallback' })
  const r3 = await sys2.run({ command: 'node -v', cwd: 'D:/other' }, { safe: { file: 'node', args: ['-v'] } })
  assert.equal(r3.ok, true)
  assert.equal(calls.execFile.length, 2)
  // 无任何 cwd：不设置（继承进程 cwd），不拒绝
  const sys3 = createSystemTools({})
  const r4 = await sys3.run({ command: 'dir' }, { safe: { file: 'cmd.exe', args: ['/c', 'dir'] } })
  assert.equal(r4.ok, true)
})

test('execFile 超时：返回超时 summary，ok=false', async () => {
  reset()
  execFileBehavior = 'timeout'
  const sys = createSystemTools({})
  const r = await sys.run({ command: 'dir', timeoutMs: 3000 }, { safe: { file: 'cmd.exe', args: ['/c', 'dir'] } })
  assert.equal(r.ok, false)
  assert.ok(r.summary.includes('超时'), r.summary)
  assert.ok(r.summary.includes('3000'))
})
