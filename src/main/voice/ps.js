// src/main/voice/ps.js
// PowerShell 桥：语音的两个「本机引擎」（SAPI 合成 / SAPI 识别）都靠它调起系统能力。
//
// 为什么不用 Node 原生模块：本机直接调 SAPI 要 node-gyp 原生扩展，安装与打包都会多一层坑；
// PowerShell 是 Windows 自带的，spawn 一下就能用——而应用自己 spawn 的 PowerShell
// 不受「开发工具拦截 Add-Type」影响（application-spawned 不受限，这一点 M3 已验证过）。
//
// 两个关键约定（都是踩过的坑）：
//   ① 串行队列：PowerShell 起一个进程要几百毫秒且很重，并发调用会互相拖慢甚至打满句柄；
//   ② 结果走 UTF-8 文件：控制台输出受系统代码页影响（中文 Windows = GBK），
//      中文识别结果走 stdout 必乱码 —— 一律写文件再读。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let queue = Promise.resolve()

/**
 * 把任务排进串行队列（同一时刻只有一个 PowerShell 在跑）。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serialize(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 跑一个 PowerShell 脚本。
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {{timeoutMs?:number, log?:Function}} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, error?:string}>}
 */
export function runPowerShell(scriptPath, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000
  const log = opts.log
  return new Promise((resolve) => {
    if (!scriptPath || !existsSync(scriptPath)) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: 'script not found: ' + scriptPath })
      return
    }
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: err.message })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve({ ok: false, code: null, stdout, stderr, error: 'timeout (' + timeoutMs + 'ms)' })
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr, error: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0 && log) log('[voice] PowerShell 退出码 ' + code + (stderr ? '：' + stderr.trim().slice(0, 300) : ''))
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 建一个临时工作目录（每次调用一个，用完即删） */
export function makeScratchDir(baseDir, tag = 'ps') {
  const dir = join(baseDir, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 安全删除临时目录（删不掉就留着，不影响功能） */
export function cleanupDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* %TEMP% 下偶尔被占用，留着无妨 */
  }
}

/** 读脚本写的 UTF-8 JSON 结果文件 */
export function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 把要朗读/识别的文本写成 UTF-8 文件（避免中文走命令行参数被代码页拆坏） */
export function writeTextFile(path, text) {
  writeFileSync(path, String(text ?? ''), 'utf8')
}
