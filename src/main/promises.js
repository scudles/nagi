// 承诺簿只保存可核实的过程与结果；不保存命令正文、文件内容或网页查询参数。
import { app } from 'electron'
import { PromiseBook } from '../core/promises/book.js'
import { reportCatch } from './maintenance.js'
import { CATCH_CLASS } from '../core/maintenance/catch-audit.js'

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

export function createReminderPromise(it, { sourceIds = [] } = {}) {
  return getPromiseBook().create({ id: reminderId(it.id), kind: 'reminder', title: it.text,
    source: { type: 'reminder', id: it.id }, sourceIds, dueAt: it.at, at: it.createdAt })
}

export function markReminder(id, status, evidence = null, at = Date.now()) {
  return getPromiseBook().transition(reminderId(id), status, evidence, at)
}

export function rescheduleReminder(id, dueAt, at = Date.now()) {
  return getPromiseBook().updateDueAt(reminderId(id), dueAt, at)
}

const FINISHED_STATES = new Set(['completed', 'delivered', 'failed', 'cancelled', 'missed'])

/**
 * §11.4：某条经历被遗忘时，处理与它有**可核验来源 ID** 的承诺。
 *
 * 作者裁决：**不得静默取消**。
 *  - 用户另行设置的提醒 → 原样保留（到期照交付），返回可供 UI 提示「可一并取消」的清单，
 *    并标记 detached，使其不再被人格回忆 / 关系锚点 / 模型上下文读取。
 *  - 已经结束记录（完成/送达/失败/已取消/已错过）→ 自动降级为最小履约记录（正文与证据细节清除）。
 *  - 没有来源 ID 的旧记录 → 一律不动，交由提醒管理界面提示用户自行检查（禁止按正文相似度猜测）。
 *
 * @returns {{ kept:Array, redacted:Array, unknownHint:boolean }}
 */
export function detachForgottenSource(sourceId, at = Date.now()) {
  const store = getPromiseBook()
  const linked = store.bySourceId(sourceId)
  const kept = []
  const redacted = []
  for (const item of linked) {
    if (item.kind === 'reminder' && !FINISHED_STATES.has(item.status)) {
      kept.push({ id: item.id, kind: item.kind, status: item.status,
        title: item.title, dueAt: item.dueAt ?? null })
      store.detach(item.id, at)
    } else {
      try {
        redacted.push({ id: item.id, kind: item.kind, status: item.status })
        store.redact(item.id, at)
      } catch (err) {
        redacted.pop()
        console.warn('[promise] 关联承诺降级失败：' + (err?.message || String(err)))
      }
    }
  }
  // 旧数据里可能存在没有 sourceIds 的同源承诺——只能提示，不能代劳。
  const unknownHint = store.list().some((item) => item.linkStatus === 'unknown')
  return { kept, redacted, unknownHint }
}

/**
 * 用户选择「一并取消」：清正文 + 级联取消提醒本体与派生内容。
 * 只有仍在提醒链路里的（可执行取消流程）才走这里；已结束的用 `removePromise`。
 *
 * 顺序很关键（§11.4 + B8-PROMISE-01）：
 *   ① 先取消**提醒本体**。外部动作没成就不动承诺簿——用户看到的仍是可管理的原状态，
 *      可以原样重试；绝不能不取消提醒却把承诺记成"已取消"。
 *   ② 再改承诺簿（标记取消 + 降级最小履约记录）。这一步写盘失败要如实说，
 *      因为此时提醒可能已经取消了，记录却是旧的——半完成状态必须可见、可重试。
 *
 * @param {string} promiseId
 * @param {{cancelReminder?:(arg:{id:string})=>{ok:boolean,removed?:number,error?:string}}} [deps]
 * @returns {{ok:true,id:string,status:string,reminderMissing?:boolean}
 *          |{ok:false,error:string,retryable?:boolean,reminderCancelled?:boolean,finished?:boolean}}
 */
export function cancelLinkedPromise(promiseId, { cancelReminder } = {}, at = Date.now()) {
  const store = getPromiseBook()
  const item = store.get(promiseId)
  if (!item) return { ok: false, error: '找不到这条承诺' }
  if (FINISHED_STATES.has(item.status)) {
    // 已结束的记录不再走取消流程（取消一个"已完成"没有意义），
    // 指向删除入口，避免用户点了没反应还以为取消了。
    return { ok: false, finished: true, error: '这条记录已经结束，请改用删除入口' }
  }

  // ① 提醒本体先取消
  let reminder = null
  if (item.source?.type === 'reminder' && typeof cancelReminder === 'function') {
    try {
      reminder = cancelReminder({ id: item.source.id })
    } catch (err) {
      reportCatch('promises.cancelLinkedPromise.reminder', CATCH_CLASS.PROMISE, err)
      return { ok: false, retryable: true, id: promiseId,
        error: `提醒本体取消失败：${err?.message || err}。承诺没有改动，可以重试。` }
    }
    if (reminder && reminder.ok === false) {
      reportCatch('promises.cancelLinkedPromise.reminder', CATCH_CLASS.PROMISE,
        new Error(reminder.error || '取消返回失败'))
      return { ok: false, retryable: true, id: promiseId,
        error: `提醒本体取消失败：${reminder.error || '未知原因'}。承诺没有改动，可以重试。` }
    }
  }
  // 提醒本来就不在列表里（removed === 0）不算失败：目标状态已经达成。
  // 但要说出来，不能让用户以为刚删掉了什么。
  const reminderMissing = Boolean(reminder && reminder.ok === true && reminder.removed === 0)

  // ② 承诺簿：标记取消 + 降级为最小履约记录
  try {
    store.transition(promiseId, 'cancelled', { kind: 'cancelled-with-forgotten-source' }, at)
    store.redact(promiseId, at)
  } catch (err) {
    reportCatch('promises.cancelLinkedPromise.book', CATCH_CLASS.MUST_PERSIST, err)
    return { ok: false, retryable: true, reminderCancelled: true, id: promiseId,
      error: `承诺记录没能更新：${err?.message || err}。提醒本体已取消，可重试以补齐记录。` }
  }
  return { ok: true, id: promiseId, status: 'cancelled', reminderMissing }
}

/** 已结束记录的删除入口：删本地记录，**不重放**外部操作。 */
export function removePromise(promiseId) {
  try {
    return getPromiseBook().remove(promiseId)
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
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
      source: { type: 'agent-tool', name }, sourceIds: opts.sourceIds || [] })
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
