// src/core/tools/system.js
// 系统工具：执行命令 / 打开应用。纯 Node 依赖。
// 注意：run_command 的黑名单与受控只读命令判定在 core/safety/policy.js（loop 会先过一遍）。
// 两条执行路径（S01 修复，2026-10-15）：
//   - 受控路径：opts.safe 存在 → execFile(shell:false)，固定可执行文件 + 校验过的 argv
//   - 完整路径：用户确认后的高风险命令 → exec() 完整 shell（保留"帮我跑个命令"能力）

import { exec, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { isPathWithin } from '../safety/policy.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const MAX_OUTPUT = 8 * 1024
const clip = (s) => (s && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…(输出过长，截断，共 ${s.length} 字符)` : s)

function okResult(command, stdout, stderr, t0) {
  const out = clip(String(stdout || '')) + (stderr ? `\n[stderr]\n${clip(String(stderr))}` : '')
  return {
    ok: true,
    summary: `命令已执行（${Date.now() - t0}ms）：${command}\n${out || '(无输出)'}`,
    data: { stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - t0 },
    ms: Date.now() - t0
  }
}

function errResult(command, err, t0, timeout) {
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

/**
 * cwd 约束：模型请求的工作目录必须落在授权根内。
 * @returns {string|undefined|null} undefined = 不设置（继承进程 cwd）；null = 拒绝执行（越权）
 */
function resolveCwd(requested, fallback, fileRoot) {
  if (!requested) return fallback || undefined
  if (!fileRoot) return fallback || undefined // 未配置授权目录：不采用模型请求的 cwd
  return isPathWithin(fileRoot, requested) ? requested : null
}

/**
 * @param {{cwd?:string, fileRoot?:string}} cfg
 */
export function createSystemTools(cfg = {}) {
  return {
    /**
     * run_command {command, cwd?, timeoutMs?} —— 阻塞到命令结束，返回合并输出。
     * @param {object} args
     * @param {{safe?:{file:string,args:string[]}}} opts safe 存在时走受控路径（execFile，不过 shell）
     */
    async run(args, opts = {}) {
      const command = String(args.command || '').trim()
      if (!command) return { ok: false, summary: '缺少 command 参数' }
      const timeout = Math.min(Math.max(Number(args.timeoutMs) || 30000, 3000), 120000)
      const t0 = Date.now()
      const cwd = resolveCwd(args.cwd, cfg.cwd, cfg.fileRoot)
      if (cwd === null) {
        return { ok: false, summary: `拒绝执行：工作目录 ${args.cwd} 不在授权目录内` }
      }

      if (opts.safe) {
        // 受控路径：固定可执行文件 + 校验过的 argv，不过 shell
        try {
          const { stdout, stderr } = await execFileAsync(opts.safe.file, opts.safe.args, {
            cwd: cwd || undefined,
            windowsHide: true,
            timeout,
            maxBuffer: 1024 * 1024
          })
          return okResult(command, stdout, stderr, t0)
        } catch (err) {
          return errResult(command, err, t0, timeout)
        }
      }

      // 高风险路径（仅在校验/确认后到达）：维持完整 shell 能力
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: cwd || undefined,
          timeout,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })
        return okResult(command, stdout, stderr, t0)
      } catch (err) {
        return errResult(command, err, t0, timeout)
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
