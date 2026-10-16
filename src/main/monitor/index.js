// src/main/monitor/index.js
// 把「采集器 + 纯逻辑引擎 + 人格台词池 + 当前设置」装配成一个可启停的监测服务。
// 触发时通过 onProactive 回调把结果交回 agent.js（那里才碰情绪/广播/日记）。
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { createSampler } from './sampler.js'
import { createMonitorEngine } from '../../core/monitor/engine.js'
import { collectionAllowed } from '../../core/monitor/privacy.js'
import { NagiPersona } from '../../core/persona.js'
import { getSettings } from '../settings-store.js'

const WINDOW_POLL_SEC = 5 // PowerShell 刷新率（窗口信息多久更新一次）

let timer = null
let engine = null
let sampler = null
let syncSamplerNow = () => {}

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

  // 诊断钩子（NAGI_DEBUG_MONITOR=1）：确认「窗口信息真的到了引擎」。
  // 只打应用名 + 标题长度 + 类别，不打标题原文——保持「标题不进日志」的隐私原则。
  if (!selftest && process.env.NAGI_DEBUG_MONITOR === '1') {
    const inner = sampler
    sampler = {
      start: (...a) => inner.start?.(...a),
      dispose: (...a) => inner.dispose?.(...a),
      isRunning: () => (inner.isRunning ? inner.isRunning() : false),
      async sample() {
        const s = await inner.sample()
        log(
          '[monitor:sample] ' +
            JSON.stringify({
              idleSec: s?.idleSec ?? null,
              app: s?.app ?? null,
              titleLen: s?.title ? String(s.title).length : 0,
              category: s?.category ?? null
            })
        )
        return s
      }
    }
  }

  /** 采样进程随隐私开关起停：关掉监测 / 勿扰时不该继续读窗口 */
  function syncSampler() {
    if (selftest || !sampler) return
    const live = collectionAllowed(getSettings().privacy || {})
    if (live && !sampler.isRunning()) sampler.start?.()
    else if (!live && sampler.isRunning()) sampler.dispose?.()
  }

  syncSamplerNow = syncSampler

  syncSampler() // 启动时若已关闭监测，就不拉起采样进程

  engine = createMonitorEngine({
    sampler,
    getPrivacy: () => getSettings().privacy || {},
    pickText: (pool, vars) => NagiPersona.pickProactive(pool, vars),
    onProactive,
    log
  })

  const periodMs = selftest ? 1200 : Math.max(15, Number(cfg.sampleSec) || 20) * 1000
  timer = setInterval(() => {
    syncSampler()
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
  syncSamplerNow = () => {}
}

export function refreshMonitorPrivacy() {
  syncSamplerNow()
}

export function monitorSnapshot() {
  return engine ? engine.snapshot() : null
}
