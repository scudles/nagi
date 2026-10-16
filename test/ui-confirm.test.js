// test/ui-confirm.test.js
// B05：确认条 / 待处理显示的 UI 生命周期回归（模拟 Agent 事件驱动真实 renderer 模块）。
// 场景来源：HANDOFF B05 输入「取消后确认 UI 可能仍留在屏幕，旧操作卡也可能持续显示等待」。
// 保护的契约（仅 UI 层，不改红区 token / 取消 / 授权规则）：
//   1) 取消（ERROR）或超时（TOOL_RESULT 用户拒绝）后，确认条关闭且不回传批准；
//   2) 旧按钮不能批准下一操作：被替换/失效后点击无效果；
//   3) 取消后能再次发送；
//   4) 多窗口只接受一次响应：别处已处理后，本窗显示失效而不是假装成功；
//   5) 执行中被取消的旧操作卡标记「已取消」，不永远转圈。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EVT, AGENT_EVENT } from '../src/shared/protocol.js'

/* ---------------- 最小 DOM 桩 ---------------- */
class El {
  constructor(tag = 'div') {
    this.tag = tag
    this.children = []
    this.classes = new Set()
    this.style = {}
    this.listeners = {}
    this.onclick = null
    this.scrollTop = 0
    this.scrollHeight = 0
    this.disabled = false
    this.value = ''
    this.open = false
    this._text = ''
  }
  get classList() {
    const s = this.classes
    return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get className() { return [...this.classes].join(' ') }
  // 真实 DOM 里 innerHTML/textContent 赋值会移除子节点——旧按钮随之从文档脱落
  set innerHTML(_v) { this.children = [] }
  get innerHTML() { return '' }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() { return this._text }
  appendChild(c) { this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.appendChild(c) }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
}

function makeDom() {
  const byId = new Map()
  const el = (id, cls = '') => { const e = new El(); e.id = id; if (cls) e.className = cls; byId.set(id, e); return e }
  const bubble = el('bubble', 'bubble hidden')
  const bubbleInner = new El()
  bubbleInner.id = 'bubble-inner'
  bubble.appendChild(bubbleInner)
  el('live2d-canvas')
  el('pet-placeholder', 'pet-placeholder hidden')
  el('pet-status', 'pet-status hidden')
  const messages = el('messages')
  const toolLog = el('tool-log')
  const confirmBar = el('confirm-bar', 'confirm-bar hidden')
  el('mood-label')
  el('brain-label')
  const input = el('input')
  const btnSend = el('btn-send')
  const dom = {
    querySelector: (sel) => (sel === '#bubble .bubble-inner' ? bubbleInner : byId.get(sel.replace(/^#/, '')) || null),
    createElement: (tag) => new El(tag),
    getElementById: () => null,
    body: new El()
  }
  return { dom, confirmBar, toolLog, messages, input, btnSend }
}

/* ---------------- 假主进程（确认门 + 广播） ---------------- */
let agentListeners = []
const sentTexts = []
const sendResolvers = []
const confirmLog = [] // 主进程实际收到的回传 { id, approved, ok }
const pendingConfirms = new Set()

function installWindow() {
  agentListeners = []
  sentTexts.length = 0
  sendResolvers.length = 0
  confirmLog.length = 0
  pendingConfirms.clear()
  global.window = {
    nagi: {
      on: (ch, fn) => { if (ch === EVT.AGENT) agentListeners.push(fn); return () => {} },
      chat: {
        send: (text) => new Promise((resolve) => { sentTexts.push(text); sendResolvers.push(resolve) }),
        // 模拟 createConfirmationGate.resolve：只接受第一个有效响应
        confirm: (id, approved) => {
          const ok = pendingConfirms.delete(id)
          confirmLog.push({ id, approved, ok })
          return ok ? { ok: true } : { ok: false, error: '没有等待中的确认' }
        }
      }
    }
  }
}

function emit(e) { for (const fn of agentListeners) fn(e) }
const tick = () => new Promise((r) => setTimeout(r, 0))
function confirmEvent(id, name = 'run_command') {
  pendingConfirms.add(id)
  return { type: AGENT_EVENT.CONFIRM, id, name, args: { command: 'echo hi' }, risk: 'high', description: '执行命令：echo hi' }
}
const lastLog = (dom) => dom.toolLog.children.at(-1)?.textContent || ''
const allowButton = (dom) => dom.confirmBar.children[1] // [info, allow, deny]
const denyButton = (dom) => dom.confirmBar.children[2]

/** 重置共享 DOM 的可见状态（模块是单例，测试间必须清场） */
function resetDom(dom) {
  dom.toolLog.children.length = 0
  dom.messages.children.length = 0
  dom.confirmBar.children.length = 0
  dom.confirmBar.className = 'confirm-bar hidden'
  dom.input.value = ''
  dom.btnSend.disabled = false
}

/* ---------------- 导入真实 renderer 模块（窗口 A） ---------------- */
const domA = makeDom()
global.document = domA.dom
const ui = await import('../src/renderer/js/ui.js')
const chat = await import('../src/renderer/js/chat.js')

/* ---------------- 场景 ---------------- */

test('取消（ERROR）后：确认条关闭、不回传批准、能再次发送', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  assert.equal(chat.sendText('第一句'), true) // 发出即占用发送位
  emit({ type: AGENT_EVENT.STATUS, state: 'thinking' })
  emit(confirmEvent('c1'))
  assert.equal(domA.confirmBar.classList.contains('hidden'), false, '确认条应显示')
  assert.equal(ui.isConfirmActive(), true)

  // 取消：主进程先广播 ERROR，再让 chat.send 的 invoke 返回
  emit({ type: AGENT_EVENT.ERROR, message: '已取消' })
  assert.equal(domA.confirmBar.classList.contains('hidden'), true, '取消后确认条应关闭')
  assert.equal(domA.confirmBar.children.length, 0, '旧按钮应被移除')
  sendResolvers.shift()({ ok: false, error: '已取消' })
  await tick()

  assert.equal(confirmLog.length, 0, '取消后不得回传批准')
  assert.equal(lastLog(domA), '确认已失效：run_command')
  assert.equal(domA.btnSend.disabled, false, '取消后发送按钮应恢复')

  assert.equal(chat.sendText('第二句'), true, '取消后应能再次发送')
  assert.deepEqual(sentTexts, ['第一句', '第二句'])
})

test('超时（TOOL_RESULT 用户拒绝）后：确认条失效、不回传', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  emit(confirmEvent('c2'))
  assert.equal(domA.confirmBar.classList.contains('hidden'), false, '确认条应显示')

  // 主进程 30s 超时 → 同意门 resolve(false) → 循环发出 TOOL_RESULT(用户拒绝)
  emit({ type: AGENT_EVENT.TOOL_RESULT, id: 't1', name: 'run_command', ok: false, summary: '用户拒绝执行该操作', ms: 1 })
  assert.equal(domA.confirmBar.classList.contains('hidden'), true, '超时后确认条应失效')
  await tick()

  assert.equal(confirmLog.length, 0, '超时后不得回传批准')
  assert.equal(lastLog(domA), '确认已失效：run_command')
})

test('旧按钮不能批准下一操作：失效/替换后点击无效果', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  emit(confirmEvent('c3a'))
  const oldAllow = allowButton(domA)
  assert.equal(oldAllow.textContent, '允许')

  // 旧确认随回合取消而失效
  emit({ type: AGENT_EVENT.ERROR, message: '已取消' })
  await tick()
  assert.equal(confirmLog.length, 0)

  // 新回合的新确认：应是新建的按钮
  emit(confirmEvent('c3b'))
  assert.equal(domA.confirmBar.classList.contains('hidden'), false)
  const newAllow = allowButton(domA)
  assert.notEqual(newAllow, oldAllow, '新确认应渲染新按钮')

  // 迟到的旧按钮点击：无效果
  oldAllow.onclick()
  await tick()
  assert.equal(confirmLog.length, 0, '旧按钮点击不得产生回传')
  assert.equal(domA.confirmBar.classList.contains('hidden'), false, '旧按钮点击不得影响新确认条')

  // 新按钮正常批准
  newAllow.onclick()
  await tick()
  assert.deepEqual(confirmLog, [{ id: 'c3b', approved: true, ok: true }])
  assert.equal(lastLog(domA), '允许：run_command')
  assert.equal(domA.confirmBar.classList.contains('hidden'), true)
})

test('正常批准/拒绝路径仍按预期回传（回归护栏）', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  emit(confirmEvent('c4a'))
  allowButton(domA).onclick()
  await tick()
  assert.deepEqual(confirmLog, [{ id: 'c4a', approved: true, ok: true }])
  assert.equal(lastLog(domA), '允许：run_command')
  assert.equal(domA.confirmBar.classList.contains('hidden'), true)

  emit({ type: AGENT_EVENT.STATUS, state: 'acting' })
  emit({ type: AGENT_EVENT.TOOL_RESULT, id: 't1', name: 'run_command', ok: true, summary: 'ok', ms: 3 })

  emit(confirmEvent('c4b'))
  denyButton(domA).onclick()
  await tick()
  assert.deepEqual(confirmLog[1], { id: 'c4b', approved: false, ok: true })
  assert.equal(lastLog(domA), '拒绝：run_command')
})

test('执行中被取消的旧操作卡标记「已取消」，不永远转圈', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  emit({ type: AGENT_EVENT.TOOL_CALL, id: 't1', name: 'run_command', args: { command: 'sleep 99' }, risk: 'high' })
  const card = domA.toolLog.children[0]
  const meta = card.children[0].children.at(-1) // summary 末位是 meta
  assert.equal(card.classList.contains('running'), true)
  assert.equal(meta.textContent, '执行中…')

  emit({ type: AGENT_EVENT.ERROR, message: '已取消' })
  assert.equal(card.classList.contains('running'), false)
  assert.equal(card.classList.contains('stopped'), true)
  assert.equal(meta.textContent, '已取消')
})

test('多窗口：同一条确认只接受一次响应，别处已处理后本窗显示失效', async () => {
  installWindow()
  resetDom(domA)
  chat.initChat()

  // 窗口 B：另一套 DOM + 另一份 ui/chat 模块实例（各自窗口各自界面）
  const domB = makeDom()
  global.document = domB.dom
  const uiB = await import('../src/renderer/js/ui.js?win=b')
  const forward = {}
  for (const k of Object.keys(uiB)) forward[k] = uiB[k]
  mock.module('../src/renderer/js/ui.js', { exports: forward })
  const chatB = await import('../src/renderer/js/chat.js?win=b')
  global.document = domA.dom
  chatB.initChat()

  // 同一条确认广播到两个窗口：两边都显示确认条
  emit(confirmEvent('c6'))
  assert.equal(domA.confirmBar.classList.contains('hidden'), false, '窗口 A 应显示确认条')
  assert.equal(domB.confirmBar.classList.contains('hidden'), false, '窗口 B 应显示确认条')

  // 窗口 A 先响应
  allowButton(domA).onclick()
  await tick()
  assert.deepEqual(confirmLog, [{ id: 'c6', approved: true, ok: true }])
  assert.equal(domA.confirmBar.classList.contains('hidden'), true)
  assert.equal(lastLog(domA), '允许：run_command')

  // 窗口 B 迟一步响应（竞态）：主进程拒绝，UI 显示失效而不是假装成功
  allowButton(domB).onclick()
  await tick()
  assert.equal(confirmLog.length, 2)
  assert.equal(confirmLog[1].ok, false, '主进程只接受第一次响应')
  assert.equal(lastLog(domB), '确认已失效（超时或已在别处处理）：run_command')
  assert.equal(domB.confirmBar.classList.contains('hidden'), true)

  // 主进程继续循环：STATUS acting 广播后，两边确认条都已失效
  emit({ type: AGENT_EVENT.STATUS, state: 'acting' })
  assert.equal(ui.isConfirmActive(), false)
  assert.equal(uiB.isConfirmActive(), false)
})
