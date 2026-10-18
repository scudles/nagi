// src/main/monitor/index.js
// 把「采集器 + 纯逻辑引擎 + 人格台词池 + 当前设置」装配成一个可启停的监测服务。
// 触发时通过 onProactive 回调把结果交回 agent.js（那里才碰情绪/广播/日记）。
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { createSampler } from './sampler.js'
import { createMonitorEngine } from '../../core/monitor/engine.js'
import { collectionAllowed, isBlocked } from '../../core/monitor/privacy.js'
import { NagiPersona } from '../../core/persona.js'
import { getSettings, saveSettings } from '../settings-store.js'

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
/**
 * @param {{onProactive:Function, onPresenceSample?:Function, log?:Function,
 *          composeText?: (args:{intent:string, vars:object, mood:string}) => Promise<string>}} opts
 *
 * composeText：2026-10-17 新增。主动搭话的内容原先从 persona 的固定池抽取，
 * 现在改由 LLM 现场生成（新人设的无台词铁律），走依赖注入是因为
 * **agent.js 已经 import 了本模块**，反向 import 会造成循环依赖。
 * 不传或生成失败都返回空串 → 引擎跳过、她这次不开口（不回退到任何预设句子）。
 */
export function startMonitor({ onProactive, onPresenceSample, log = console.log, composeText = null } = {}) {
  if (timer) return
  // 裁决 B：启动时补齐授权戳（设置页读到的是主进程打的戳，不是界面现编的）
  syncAuthorizationStamp()
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
    pickText: async (pool, vars, rule) =>
      composeText
        ? await composeText({ intent: pool, vars: vars || {}, mood: rule?.mood || 'calm' })
        : '',
    onProactive,
    onPresenceSample,
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

/**
 * 作者裁决 B（CONTRACTS 作者裁决登记）：维护 `privacy.monitorAuthorizedAt`。
 *
 * 设置页要显示「监测于 <时间> 授权」，就得有一个**可信的授权时刻**；
 * 这个戳只能由主进程在"监测真的开着"时打，不能由界面拿当前时间去填。
 * 规则：
 *   · 开启监测且还没有戳 → 打一次；
 *   · 关掉监测 → 清零（下次再开重新记）；
 *   · 勿扰 / 只陪着是**临时**状态，不重置授权时间。
 */
function syncAuthorizationStamp() {
  const privacy = getSettings().privacy || {}
  const enabled = privacy.monitorEnabled !== false
  const at = Number(privacy.monitorAuthorizedAt) || 0
  try {
    if (enabled && at <= 0) saveSettings({ privacy: { monitorAuthorizedAt: Date.now() } })
    else if (!enabled && at > 0) saveSettings({ privacy: { monitorAuthorizedAt: 0 } })
  } catch {
    /* 打戳失败就退回"不显示"，绝不用当前时间冒充 */
  }
}

export function refreshMonitorPrivacy() {
  syncAuthorizationStamp()
  syncSamplerNow()
}

export function monitorSnapshot() {
  return engine ? engine.snapshot() : null
}

/**
 * 当前前台窗口样本（供「此刻」上下文使用，2026-10-18）。
 *
 * 为什么从这里借：monitor-sampler.ps1 本来就在每 5 秒采一次前台窗口，
 * 数据现成；媒体会话（SMTC）只覆盖注册了会话的播放器，
 * 浏览器里的视频页面只有这条路看得见。
 *
 * 返回 null 表示「不该给」——监测没起来 / 已停 / 隐私闸门关闭（勿扰、只陪着、总开关）。
 * **隐私闸门在这里再判一次**：调用方（agent 每轮对话）不知道用户何时切了勿扰。
 */
export async function foregroundSample() {
  if (!sampler) return null
  const privacy = getSettings().privacy || {}
  if (!collectionAllowed(privacy)) return null
  let s = null
  try {
    s = await sampler.sample()
  } catch {
    return null
  }
  if (!s) return null
  // 黑名单（密码/银行/支付/无痕…）：命中即整条丢弃，标题绝不外传
  if (isBlocked(s, privacy.blacklist)) return null
  return s
}
