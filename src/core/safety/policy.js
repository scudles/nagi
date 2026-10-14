// src/core/safety/policy.js
// 工具风险分级、命令黑名单、目录边界。纯逻辑，可单测。

import { RISK } from '../../shared/protocol.js'

/** 工具 → 默认风险等级 */
export const TOOL_RISK = {
  // 只读
  browser_scrape: RISK.LOW,
  browser_open: RISK.LOW,
  file_read: RISK.LOW,
  file_list: RISK.LOW,
  web_search: RISK.LOW,
  screenshot: RISK.LOW,
  clipboard_read: RISK.LOW,
  home_list: RISK.LOW,
  home_get: RISK.LOW,
  notify: RISK.LOW,
  reminder_list: RISK.LOW,
  reminder_add: RISK.LOW,
  reminder_cancel: RISK.LOW,

  // 可逆写
  browser_act: RISK.MEDIUM,
  file_write: RISK.MEDIUM,
  open_app: RISK.MEDIUM,
  clipboard_write: RISK.MEDIUM,
  home_set: RISK.MEDIUM,
  home_scene: RISK.MEDIUM,

  // 不可逆 / 对外 / 涉及钱
  run_command: RISK.HIGH
}

/** 危险命令黑名单（子串匹配，命中即拒绝，无论是否确认） */
export const COMMAND_BLACKLIST = [
  'format ',
  'diskpart',
  'rm -rf /',
  'rmdir /s /q c:',
  'del /f /s /q c:',
  'rd /s /q c:',
  'reg delete',
  'reg add hklm',
  'bcdedit',
  'vssadmin delete',
  'cipher /w',
  'takeown /f c:',
  'net user',
  'shutdown',
  'mkfs',
  ':(){:|:&};:'
]

export function getToolRisk(name) {
  return TOOL_RISK[name] || RISK.HIGH // 未知工具按最高风险处理
}

/** 命令是否被永久拒绝 */
export function isCommandBlocked(cmd) {
  const s = String(cmd || '').toLowerCase().replace(/\s+/g, ' ')
  return COMMAND_BLACKLIST.some((b) => s.includes(b.toLowerCase()))
}

/** 规范化路径并判断是否在允许根目录内 */
export function isPathWithin(root, target) {
  if (!root) return false
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = norm(root)
  const t = norm(target)
  return t === r || t.startsWith(r + '/')
}

/**
 * 判断一次工具调用是否需要用户确认。
 * @param {{name:string,args:object}} call
 * @param {{confirmHighRisk?:boolean, allowedTools?:string[]}} opts
 */
export function needsConfirm(call, opts = {}) {
  const risk = getToolRisk(call.name)
  if (call.name === 'run_command') {
    if (isCommandBlocked(call.args?.command)) return { confirm: true, blocked: true, risk }
    // 白名单内的只读命令可免确认
    if (isWhitelistedCommand(call.args?.command)) return { confirm: false, blocked: false, risk: RISK.LOW }
  }
  if (risk === RISK.HIGH && opts.confirmHighRisk !== false) return { confirm: true, blocked: false, risk }
  if (opts.allowedTools && !opts.allowedTools.includes(call.name) && risk !== RISK.LOW) {
    return { confirm: true, blocked: false, risk }
  }
  return { confirm: false, blocked: false, risk }
}

/** 安全只读命令白名单（免确认） */
export const COMMAND_WHITELIST = [
  /^dir\b/i,
  /^ls\b/i,
  /^echo\b/i,
  /^type\b/i,
  /^cat\b/i,
  /^ipconfig\b/i,
  /^systeminfo\b/i,
  /^tasklist\b/i,
  /^where\b/i,
  /^which\b/i,
  /^node -v$/i,
  /^npm -v$/i,
  /^git status\b/i
]

export function isWhitelistedCommand(cmd) {
  const s = String(cmd || '').trim()
  if (isCommandBlocked(s)) return false
  return COMMAND_WHITELIST.some((re) => re.test(s))
}
