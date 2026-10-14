// src/main/monitor/index.js
// 把「采集器 + 纯逻辑引擎 + 人格台词池 + 当前设置」装配成一个可启停的监测服务。
// 触发时通过 onProactive 回调把结果交回 agent.js（那里才碰情绪/广播/日记）。
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { createSampler } from './sampler.js'
import { createMonitorEngine } from '../../core/monitor/engine.js'
import { NagiPersona } from '../../core/persona.js'
import { getSettings } from '../settings-store.js'

const WINDOW_POLL_SEC = 5 // PowerShell 刷新率（窗口信息多久更新一次）

let timer = null
let engine = null
let sampler = null

/** 无头自测用的假采样器：固定「凌晨 2:30 + 正在用工作类程序」→ 必中 late_night_awake */
function createFakeSampler() {
  const d = new Date()
  d.setHours(2, 30, 0, 0)
  return {
    start() {},
    dispose() {},
    isRunning: () => true,
    async sample() {
      return { ts: d.getTime(), idleSec: 5, app: 'Code', title: 'selftest.js', pid: 0 }
    }
  }
}

/**
 * 启动监测（幂等）。
 * @param {{onProactive:(payload:object)=>void, log?:Function}} deps
 */
export function startMonitor({ onProactive, log = console.log } = {}) {
  if (timer) return
  const selftest = process.env.NAGI_SELFTEST_MONITOR === '1'
  const cfg = getSettings().privacy || {}

  sampler = selftest
    ? createFakeSampler()
    : createSampler({ scriptPath: join(resourcesDir, 'monitor-sampler.ps1'), intervalSec: WINDOW_POLL_SEC, log })
  sampler.start?.()

  engine = createMonitorEngine({
    sampler,
    getPrivacy: () => getSettings().privacy || {},
    pickText: (pool, vars) => NagiPersona.pickProactive(pool, vars),
    onProactive,
    log
  })

  const periodMs = selftest ? 1200 : Math.max(15, Number(cfg.sampleSec) || 20) * 1000
  timer = setInterval(() => {
    engine
      .tickOnce()
      .then((r) => {
        // 自测模式把每次判断的结果打出来，便于核对链路
        if (selftest) log('[monitor:tick] ' + JSON.stringify(r && r.stats ? { ...r, stats: { hour: r.stats.hour, active: r.stats.active, category: r.stats.category } } : r))
      })
      .catch((err) => log('[monitor] tick 出错：' + (err && err.message ? err.message : err)))
  }, periodMs)
  timer.unref?.()
  log(`[monitor] 活动监测已启动（每 ${Math.round(periodMs / 1000)} 秒看一眼${selftest ? '，自测模式' : ''}）`)
}

export function stopMonitor() {
  if (timer) clearInterval(timer)
  timer = null
  if (sampler) {
    try {
      sampler.dispose()
    } catch {
      /* ignore */
    }
  }
  sampler = null
  engine = null
}

export function monitorSnapshot() {
  return engine ? engine.snapshot() : null
}
