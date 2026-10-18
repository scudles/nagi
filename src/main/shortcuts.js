// src/main/shortcuts.js
// 全局热键：换装束 / 让她动一下。
//
// 为什么必须用全局热键而不是窗口内的按键监听：
//   桌宠是 skipTaskbar + showInactive 的悬浮窗，**不抢焦点**，键盘事件根本到不了它
//   （这正是我们想要的行为——不能因为她待在桌面上就抢走你的输入）。
//   所以要在任何应用前台时都能按到，只能用 globalShortcut。
//
// 注意：全局热键是**本地触发**，不是 Agent 的工具调用，因此不走安全门确认
//       （安全门管的是"模型请求做外部动作"，这里是你自己按的键）。
//
// 注册失败通常是组合键被别的软件占了 —— 逐个注册、逐个报告，不因为一个失败就全不注册。
import { globalShortcut } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'

export const DEFAULT_SHORTCUTS = {
  next: 'Control+Alt+O', // 下一个装束
  prev: 'Control+Alt+Shift+O', // 上一个装束
  act: 'Control+Alt+E' // 让她随机做个动作/表情
}

/** 给 UI 显示用的可读写法 */
export function prettyAccelerator(acc) {
  return String(acc || '')
    .replace(/Control/gi, 'Ctrl')
    .replace(/\+/g, ' + ')
}

let registered = []

/**
 * 注册热键。
 * @param {object} opts
 * @param {Record<string, Function>} opts.handlers  { next, prev, act }
 * @param {object} [opts.accelerators] 覆盖默认组合键
 * @param {boolean} [opts.enabled] false 时先全部注销
 * @returns {{ok:string[], failed:{key:string,acc:string}[], skipped:boolean}}
 */
export function registerShortcuts({ handlers = {}, accelerators = {}, enabled = true } = {}) {
  unregisterShortcuts()
  if (!enabled) return { ok: [], failed: [], skipped: true }

  const map = { ...DEFAULT_SHORTCUTS, ...accelerators }
  const ok = []
  const failed = []
  for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
    const acc = map[key]
    const fn = handlers[key]
    if (!acc || typeof fn !== 'function') continue
    let done = false
    try {
      done = globalShortcut.register(acc, () => {
        try {
          fn()
        } catch (__err) { reportCatch('shortcuts.registerShortcuts', CATCH_CLASS.VISIBLE, __err) }
      })
    } catch {
      done = false
    }
    if (done) {
      ok.push(key)
      registered.push(acc)
    } else {
      failed.push({ key, acc })
    }
  }
  return { ok, failed, skipped: false }
}

export function unregisterShortcuts() {
  for (const acc of registered) {
    try {
      globalShortcut.unregister(acc)
    } catch{ /* B8:degrade — 注销失败无副作用 */ }
  }
  registered = []
}

/** 当前进程里注册成功的组合键（设置页显示"已生效/被占用"用） */
export function activeShortcuts() {
  return [...registered]
}
