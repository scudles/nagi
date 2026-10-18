// src/main/monitor/sampler.js
// 采集器：把「系统空闲秒数」与「当前前台窗口」合成一条样本。
//   空闲时间：Electron powerMonitor（零依赖、最可靠）
//   前台窗口：常驻 PowerShell 采样进程（resources/monitor-sampler.ps1）
//      —— 拿不到（脚本缺失 / 进程启动失败 / 输出陈旧）时自动降级为「仅空闲」，
//         监测不会因此整体失效，只是少了「在用什么程序」这一维。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { powerMonitor } from 'electron'

/** 窗口信息超过这个时长没刷新就视为陈旧（避免卡在最后一个窗口上不放） */
const STALE_MS = 15000

export function createSampler({ scriptPath, intervalSec = 5, log = () => {} } = {}) {
  let child = null
  let running = false
  let buffer = ''
  let latest = null // { ts, pid, app, title }

  function parseLine(line) {
    if (!line) return
    const parts = line.split('\t')
    const ts = Number(parts[0]) || Date.now()
    const pid = Number(parts[1]) || 0
    const app = parts[2] || ''
    const title = parts.slice(3).join('\t') || ''
    latest = { ts, pid, app, title }
  }

  function start() {
    if (running) return
    if (!scriptPath || !existsSync(scriptPath)) {
      log('[monitor] 未找到窗口采样脚本，降级为「仅系统空闲」模式')
      return
    }
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Interval', String(intervalSec)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      running = true
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          parseLine(buffer.slice(0, i).trim())
          buffer = buffer.slice(i + 1)
        }
        if (buffer.length > 8192) buffer = '' // 防御：异常长行
      })
      child.on('error', (err) => {
        log('[monitor] 窗口采样进程启动失败：' + err.message)
        running = false
        child = null
      })
      child.on('exit', (code) => {
        if (running) log('[monitor] 窗口采样进程退出（code=' + code + '），降级为「仅系统空闲」')
        running = false
        child = null
      })
    } catch (err) {
      log('[monitor] 窗口采样进程异常：' + err.message)
      running = false
      child = null
    }
  }

  /** 取一条样本（idle 实时读，窗口信息取最近一次采样） */
  async function sample() {
    let idleSec = 0
    try {
      idleSec = powerMonitor.getSystemIdleTime()
    } catch {
      idleSec = 0
    }
    const now = Date.now()
    const fresh = latest && now - latest.ts < STALE_MS
    return {
      ts: now,
      idleSec,
      app: fresh ? latest.app || null : null,
      title: fresh ? latest.title || null : null,
      pid: fresh ? latest.pid || null : null
    }
  }

  function dispose() {
    if (child) {
      try {
        child.kill()
      } catch{ /* B8:degrade — 子进程已退出或不存在 */ }
      child = null
    }
    running = false
  }

  return { start, sample, dispose, isRunning: () => running }
}
