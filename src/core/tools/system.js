// src/core/tools/system.js
// 系统工具：执行命令 / 打开应用。纯 Node 依赖。
// 注意：run_command 的黑名单与白名单判定在 core/safety/policy.js（loop 会先过一遍）。

import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const MAX_OUTPUT = 8 * 1024
const clip = (s) => (s && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…(输出过长，截断，共 ${s.length} 字符)` : s)

/**
 * @param {{cwd?:string}} cfg
 */
export function createSystemTools(cfg = {}) {
  return {
    /** run_command {command, cwd?, timeoutMs?} —— 阻塞到命令结束，返回合并输出 */
    async run(args) {
      const command = String(args.command || '').trim()
      if (!command) return { ok: false, summary: '缺少 command 参数' }
      const timeout = Math.min(Math.max(Number(args.timeoutMs) || 30000, 3000), 120000)
      const t0 = Date.now()
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: args.cwd || cfg.cwd || undefined,
          timeout,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })
        const out = clip(String(stdout || '')) + (stderr ? `\n[stderr]\n${clip(String(stderr))}` : '')
        return {
          ok: true,
          summary: `命令已执行（${Date.now() - t0}ms）：${command}\n${out || '(无输出)'}`,
          data: { stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - t0 },
          ms: Date.now() - t0
        }
      } catch (err) {
        const stdout = String(err.stdout || '')
        const stderr = String(err.stderr || '')
        // 非零退出码也算"执行了"，把输出带回给模型判断
        if (err.killed) {
          return { ok: false, summary: `命令超时（>${timeout}ms）：${command}`, data: { stdout, stderr } }
        }
        return {
          ok: false,
          summary: `命令退出码 ${err.code ?? '?'}（${Date.now() - t0}ms）：${command}\n${clip(stdout)}${stderr ? `\n[stderr]\n${clip(stderr)}` : ''}`,
          data: { stdout, stderr, code: err.code },
          ms: Date.now() - t0
        }
      }
    },

    /** open_app {name|path} —— 拉起应用后立即返回（Windows 用 start） */
    async open(args) {
      const target = String(args.path || args.name || '').trim()
      if (!target) return { ok: false, summary: '缺少 name 或 path 参数' }
      try {
        if (process.platform === 'win32') {
          // start "" "target"：第一个引号参数是窗口标题占位
          const child = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true })
          child.unref()
        } else {
          const child = spawn(target, [], { detached: true, stdio: 'ignore' })
          child.unref()
        }
        return { ok: true, summary: `已尝试打开：${target}` }
      } catch (err) {
        return { ok: false, summary: `打开失败：${err.message}` }
      }
    }
  }
}
