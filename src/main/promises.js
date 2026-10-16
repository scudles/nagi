// 承诺簿只保存可核实的过程与结果；不保存命令正文、文件内容或网页查询参数。
import { app } from 'electron'
import { PromiseBook } from '../core/promises/book.js'

let book = null
export function getPromiseBook() {
  if (!book) book = new PromiseBook(app.getPath('userData')).load()
  return book
}

const reminderId = (id) => `reminder:${id}`

export function syncReminderPromises(items) {
  const store = getPromiseBook()
  for (const it of items) {
    if (store.get(reminderId(it.id))) continue
    const status = it.doneAt || it.firedAt ? 'legacy-unknown' : it.missedAt ? 'missed' : 'scheduled'
    store.create({ id: reminderId(it.id), kind: 'reminder', title: it.text,
      source: { type: 'legacy-reminder', id: it.id }, dueAt: it.at, status,
      at: it.createdAt || Date.now() })
  }
}

export function createReminderPromise(it) {
  return getPromiseBook().create({ id: reminderId(it.id), kind: 'reminder', title: it.text,
    source: { type: 'reminder', id: it.id }, dueAt: it.at, at: it.createdAt })
}

export function markReminder(id, status, evidence = null, at = Date.now()) {
  return getPromiseBook().transition(reminderId(id), status, evidence, at)
}

export function rescheduleReminder(id, dueAt, at = Date.now()) {
  return getPromiseBook().updateDueAt(reminderId(id), dueAt, at)
}

const EFFECT_TOOLS = new Set(['file_write', 'run_command', 'open_app', 'browser_open', 'browser_act',
  'clipboard_write', 'notify', 'home_set', 'home_scene'])

function safeTitle(name, args) {
  switch (name) {
    case 'file_write': return `写入文件：${String(args.path || '').slice(0, 240)}`
    case 'run_command': return '执行已授权命令'
    case 'open_app': return `打开应用：${String(args.name || args.path || '').slice(0, 160)}`
    case 'browser_open': {
      try { return `打开网页：${new URL(args.url).origin}` } catch { return '打开网页' }
    }
    case 'browser_act': return `浏览器操作：${String(args.action || '').slice(0, 40)}`
    case 'home_set': return `控制设备：${String(args.entity_id || '').slice(0, 120)}`
    case 'home_scene': return `触发场景：${String(args.entity_id || '').slice(0, 120)}`
    case 'clipboard_write': return '写入剪贴板'
    case 'notify': return '发出系统通知'
    default: return name
  }
}

/** 执行前先落盘；中断后重启会显示“已尝试，结果未确认”。 */
export async function runRecordedTool(execute, name, args = {}, opts = {}) {
  if (!EFFECT_TOOLS.has(name)) return execute(name, args, opts)
  let entry
  try {
    const store = getPromiseBook()
    entry = store.create({ kind: 'agent-tool', title: safeTitle(name, args),
      source: { type: 'agent-tool', name } })
    store.transition(entry.id, 'attempting', { kind: 'execution-started' })
  } catch (err) {
    return { ok: false, summary: `承诺记录失败，未执行操作：${err.message}` }
  }

  let result
  try { result = await execute(name, args, opts) }
  catch (err) { result = { ok: false, summary: `执行异常：${err.message}` } }
  result ||= { ok: false, summary: '工具没有返回结果' }
  const store = getPromiseBook()
  try {
    if (result.ok === false) {
      store.transition(entry.id, 'failed', { kind: 'tool-error', detail: String(result.summary || '').slice(0, 240) })
    } else if (name === 'file_write') {
      store.transition(entry.id, 'completed', { kind: 'file-write-result', path: String(args.path || '').slice(0, 240), bytes: Buffer.byteLength(String(args.content || ''), 'utf8') })
    } else if (name === 'notify') {
      store.transition(entry.id, 'delivered', { kind: 'notification-dispatched' })
    } else {
      store.transition(entry.id, 'attempted', { kind: 'tool-returned', tool: name })
      result = { ...result, summary: `${result.summary || '工具调用返回成功'}；外部效果尚未核实，承诺簿记为“已尝试”。` }
    }
  } catch (err) {
    result = { ...result, summary: `${result.summary || '操作已返回'}；承诺记录写入失败，结果状态待核实：${err.message}` }
  }
  return result
}
