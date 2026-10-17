#!/usr/bin/env node
// FIX-2 复现脚本：外部进程「替换路径」的检查/使用竞态（TOCTOU）。
//
// 背景（TASKS FIX-2）：run_command/open_app 被指"替换外部进程路径的检查/使用竞态"。
// 本脚本用端到端方式量化该窗口是否可复现：
//
//   A. 时序注入：在校验（resolveCwd 的 realpath）与使用（execFile 发起子进程）
//      之间，并发攻击者疯狂把授权目录换成指向外部的 junction。
//      命中 = execFile 实际启动目录变成了外部（校验值与使用值不一致）。
//   B. 软链欺骗：预先直接把 sub 建成指向外部的 junction，看 resolveCwd 的
//      isPathWithin 校验能否识别（现有校验对软链是否有效）。
//   C. open_app 行为核对：确认它没有"检查→使用"路径对（字符串即目标）。
//
// 用真实子进程（cmd /c cd 打印实际工作目录），不 mock 任何模块。
// 退出码：0 = 跑完（无论是否命中，结论看报告）；2 = 环境/脚本错误。

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemTools } from '../src/core/tools/system.js'

const ROUNDS = Number(process.argv[2]) || 100
const SWAPS_PER_ROUND = 200

const base = mkdtempSync(join(tmpdir(), 'nagi-fix2-'))
const work = join(base, 'work')
const outside = join(base, 'outside')
const sub = join(work, 'sub')
mkdirSync(work, { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(sub, { recursive: true })

const sys = createSystemTools({ fileRoot: work })
const report = { rounds: ROUNDS, timingHits: 0, symlinkRejected: null, samples: [] }

/** 把 sub 换成指向外部的目录 junction（Windows 非管理员可建） */
function swapToJunction() {
  rmSync(sub, { recursive: true, force: true })
  symlinkSync(outside, sub, 'junction')
}

/** 恢复 sub 为真实目录 */
function restoreRealDir() {
  if (existsSync(sub)) rmSync(sub, { recursive: true, force: true })
  mkdirSync(sub, { recursive: true })
}

/** 攻击者协程：在 await 边界之间拼命替换 */
async function attacker() {
  for (let i = 0; i < SWAPS_PER_ROUND; i++) {
    try {
      swapToJunction()
      restoreRealDir()
    } catch {
      /* 删除/建立竞态本身会偶发失败，忽略 */
    }
    await new Promise((r) => setImmediate(r))
  }
}

async function runOnce() {
  // cd 会打印子进程实际启动的工作目录：命中 = 输出 outside 而不是 work\sub
  restoreRealDir()
  const atk = attacker()
  const r = await sys.run({ command: 'dir', cwd: 'sub' }, { safe: { file: 'cmd.exe', args: ['/c', 'cd'] } })
  await atk
  return r
}

try {
  // A. 时序注入
  for (let i = 0; i < ROUNDS; i++) {
    const r = await runOnce()
    const out = String(r.data?.stdout || '')
    const resolved = out.trim().toLowerCase()
    const leaked = resolved.includes(outside.toLowerCase())
    if (leaked) {
      report.timingHits++
      if (report.samples.length < 5) report.samples.push({ round: i, stdout: out.trim(), ok: r.ok })
    }
  }

  // B. 软链欺骗：sub 直接就是 junction → 校验必须拒绝
  swapToJunction()
  const rb = await sys.run({ command: 'dir', cwd: 'sub' }, { safe: { file: 'cmd.exe', args: ['/c', 'cd'] } })
  report.symlinkRejected = rb.ok === false
  report.symlinkSummary = rb.summary
  restoreRealDir()

  // C. open_app 无检查→使用路径对（静态事实，这里只做一次无害调用留证）
  const rc = await sys.open({ name: 'cmd.exe' })
  report.openAppNote = `open_app({name}) 直接 spawn，无路径校验步骤（ok=${rc.ok}）`

  // 报告留证在临时区（不被 finally 清理），便于回溯
  const reportPath = join(tmpdir(), 'nagi-fix2-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n报告已留证：${reportPath}`)
  console.log(report.timingHits > 0
    ? `结论：时序注入命中 ${report.timingHits}/${ROUNDS} 次 —— FIX-2 可复现，需要修复`
    : `结论：时序注入 ${ROUNDS} 轮 0 命中 —— 窗口在真实代码路径中不可利用（resolveCwd 返回到 execFile 发起之间无 await 让出）`)
} catch (err) {
  console.error('脚本错误：', err)
  process.exitCode = 2
} finally {
  rmSync(base, { recursive: true, force: true })
}
