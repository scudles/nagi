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

// 这些操作会写入、控制外部目标，或读取比文件授权根更敏感的信息。
// 逐次确认绑定本次工具名和参数；不保存跨目标的笼统许可。
//
// 2026-10-17 放宽（用户指示，见 DECISIONS）：**只读观察类不再逐次确认**。
// browser_open / browser_scrape / web_search / home_list / home_get / reminder_list
// 只是「看」，不改变任何状态，此前每看一次都要点确认条，严重拖累日常使用，故移出本名单。
// 仍逐次确认的是「写入 / 对外 / 不可逆」，其中两项特别说明：
//   · screenshot / clipboard_read —— 剪贴板里可能正躺着密码，截屏可能拍到银行页或私密窗口，
//     而窗口标题黑名单只保护「活动监测」，保护不到这两条通道，故维持确认。
//   · reminder_add / reminder_cancel 虽是 LOW 风险，但会真的新增/撤销提醒（写），维持确认。
export const CONFIRM_TOOLS = new Set([
  'browser_act', 'screenshot', 'clipboard_read', 'clipboard_write', 'file_write',
  'open_app', 'home_set', 'home_scene', 'reminder_add', 'reminder_cancel'
])

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
 *
 * 安全约束（2026-10-15 S01 修复，不可放宽）：
 * 1. run_command 只有命中「受控只读命令映射」才免确认，且必须通过元字符校验；
 * 2. 不在映射内的命令串一律 HIGH 确认，无任何开关可绕过；
 * 3. 模型永远只能指定「受控命令 + 受限参数」，不能指定可执行文件本身。
 *
 * @param {{name:string,args:object}} call
 * @param {{allowedTools?:string[]}} opts
 */
export function needsConfirm(call, opts = {}) {
  const risk = getToolRisk(call.name)
  if (call.name === 'run_command') {
    if (isCommandBlocked(call.args?.command)) return { confirm: true, blocked: true, risk }
    const safe = planSafeCommand(call.args?.command)
    if (safe) return { confirm: false, blocked: false, risk: RISK.LOW, safe }
    return { confirm: true, blocked: false, risk: RISK.HIGH } // 其余 shell 命令一律确认
  }
  if (CONFIRM_TOOLS.has(call.name)) return { confirm: true, blocked: false, risk }
  if (risk === RISK.HIGH) return { confirm: true, blocked: false, risk } // 不再有开关
  if (opts.allowedTools && !opts.allowedTools.includes(call.name) && risk !== RISK.LOW) {
    return { confirm: true, blocked: false, risk }
  }
  return { confirm: false, blocked: false, risk }
}

/**
 * 受控只读命令映射：模型可免确认执行的唯一入口。
 * 键 = 规范化后的完整命令前缀；win = Windows 实际 argv（execFile shell:false 执行）。
 * 扩充条件：只读、无副作用、键本身不含任何 shell 元字符。
 */
const SAFE_COMMANDS = {
  dir: { win: ['cmd.exe', ['/c', 'dir']] },
  ipconfig: { win: ['ipconfig', []] },
  tasklist: { win: ['tasklist', []] },
  systeminfo: { win: ['systeminfo', []] },
  where: { win: ['where', []] },
  ver: { win: ['cmd.exe', ['/c', 'ver']] },
  'node -v': { win: ['node', ['-v']] },
  'npm -v': { win: ['npm', ['-v']] },
  'git status': { win: ['git', ['status']] }
}

/** 受限参数：仅字母数字与路径字符，禁空格/通配符/引号/一切元字符 */
const SAFE_ARG = /^(?:[A-Za-z0-9_.-]+|\/[A-Za-z]+)$/

/** shell 元字符（cmd 与 bash 交集）：出现即无免确认资格 */
const SHELL_META = /[&|;<>`$(){}[\]*?~^!'"\n\r]/

/**
 * 生成受控执行计划。只有完整命中「受控命令 + 全受限参数」才返回计划，否则 null。
 * 注意：必须先查原始串再规范化——`\s+` 会把换行抹成空格，
 * 若先规范化，'dir\ntype x' 这类换行分隔命令就能混过元字符检查。
 * @returns {{file:string,args:string[]}|null}
 */
export function planSafeCommand(cmd) {
  const raw = String(cmd || '')
  if (!raw.trim() || SHELL_META.test(raw)) return null
  const s = raw.trim().replace(/\s+/g, ' ')
  const lower = s.toLowerCase()
  for (const [key, spec] of Object.entries(SAFE_COMMANDS)) {
    if (lower === key) return { file: spec.win[0], args: [...spec.win[1]] }
    if (lower.startsWith(key + ' ')) {
      const rest = s.slice(key.length + 1).split(' ')
      if (rest.length && rest.every((t) => t !== '..' && SAFE_ARG.test(t))) {
        return { file: spec.win[0], args: [...spec.win[1], ...rest] }
      }
    }
  }
  return null
}
