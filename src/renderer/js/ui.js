// src/renderer/js/ui.js
// 界面原语：气泡、独白面板、消息流、工具日志、状态提示、确认条。

const $ = (sel) => document.querySelector(sel)

export const els = {
  body: document.body,
  canvas: $('#live2d-canvas'),
  placeholder: $('#pet-placeholder'),
  bubble: $('#bubble'),
  bubbleInner: $('#bubble .bubble-inner'),
  petStatus: $('#pet-status'),
  messages: $('#messages'),
  toolLog: $('#tool-log'),
  confirmBar: $('#confirm-bar'),
  moodLabel: $('#mood-label'),
  brainLabel: $('#brain-label'),
  input: $('#input'),
  btnSend: $('#btn-send')
}

const EMOTION_LABEL = { calm: '平静', puzzled: '疑惑', smile: '微笑', worry: '担心', pout: '闹别扭', joy: '开心' }
const STATE_LABEL = { thinking: '思考中…', acting: '操作中…', waiting: '等待你确认…', idle: '' }

let bubbleTimer = null

/* ---------------- 桌宠气泡 ---------------- */
export function showBubble(text, { autoHide = 6000 } = {}) {
  els.bubbleInner.textContent = text
  els.bubble.classList.remove('hidden')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (autoHide) bubbleTimer = setTimeout(hideBubble, autoHide)
}
export function appendBubble(text) {
  els.bubbleInner.textContent += text
  els.bubble.classList.remove('hidden')
}
export function hideBubble() {
  els.bubble.classList.add('hidden')
}

/* ---------------- 状态 ---------------- */
export function setStatus(state, detail) {
  const label = STATE_LABEL[state] || state || ''
  if (!label) {
    els.petStatus.classList.add('hidden')
    return
  }
  els.petStatus.textContent = detail ? `${label} ${detail}` : label
  els.petStatus.classList.remove('hidden')
}

export function setMood(emotion) {
  const label = EMOTION_LABEL[emotion] || emotion || '平静'
  if (els.moodLabel) els.moodLabel.textContent = `情绪：${label}`
  // 工作台凪面板上的情绪读数
  const np = document.getElementById('np-mood')
  if (np) np.textContent = label
}

export function setBrain(label) {
  if (els.brainLabel) els.brainLabel.textContent = `大脑：${label}`
}

/* ---------------- 消息流（工作台） ---------------- */
export function addMessage(who, text = '') {
  const row = document.createElement('div')
  row.className = `msg ${who}`
  const w = document.createElement('div')
  w.className = 'who'
  w.textContent = who === 'nagi' ? '凪' : who === 'user' ? '你' : who === 'tool' ? '工具' : who === 'error' ? '错误' : ''
  const b = document.createElement('div')
  b.className = 'body'
  b.textContent = text
  row.append(w, b)
  els.messages.appendChild(row)
  scrollMessages()
  return {
    row,
    body: b,
    append(t) {
      b.textContent += t
      scrollMessages()
    },
    set(t) {
      b.textContent = t
      scrollMessages()
    }
  }
}

function scrollMessages() {
  els.messages.scrollTop = els.messages.scrollHeight
}

/* ---------------- 工具日志 ---------------- */
export function addToolLog(text) {
  const row = document.createElement('div')
  row.className = 'tl-row'
  row.textContent = text
  els.toolLog.appendChild(row)
  els.toolLog.scrollTop = els.toolLog.scrollHeight
}

/** 正在进行的工具调用卡片：id → { card, meta }，结果回来时按 id 更新 */
const toolCards = new Map()

/**
 * 工具执行卡片（M4）：调用时建一张可展开的卡（看参数），结果回来时更新状态与摘要。
 * 比一行纯文本更容易看清「她到底调了什么、成没成」。
 */
export function addToolCard({ id, phase, name, args, risk, ok, ms, summary }) {
  const box = els.toolLog
  if (!box) return
  if (phase === 'call') {
    const card = document.createElement('details')
    card.className = 'tl-card running'
    const sum = document.createElement('summary')
    const nm = document.createElement('span')
    nm.className = 'tl-name'
    nm.textContent = name
    sum.appendChild(nm)
    if (risk && risk !== 'low') {
      const rg = document.createElement('span')
      rg.className = 'tl-risk tl-risk-' + risk
      rg.textContent = risk
      sum.appendChild(rg)
    }
    const meta = document.createElement('span')
    meta.className = 'tl-meta'
    meta.textContent = '执行中…'
    sum.appendChild(meta)
    const pre = document.createElement('pre')
    pre.className = 'tl-args'
    pre.textContent = JSON.stringify(args || {}, null, 2)
    card.append(sum, pre)
    box.appendChild(card)
    if (id) toolCards.set(id, { card, meta })
    box.scrollTop = box.scrollHeight
    return
  }

  const rec = id ? toolCards.get(id) : null
  if (!rec) {
    // 没配上调用卡（事件丢失/重放）——补一条纯文本，别把结果吞了
    addToolLog(`${ok ? '✔' : '✘'} ${name} ${ms != null ? ms + 'ms' : ''} ${summary || ''}`)
    return
  }
  toolCards.delete(id)
  rec.card.classList.remove('running')
  rec.card.classList.add(ok ? 'ok' : 'fail')
  rec.meta.textContent = `${ok ? '完成' : '失败'}${ms != null ? ' · ' + ms + 'ms' : ''}`
  if (summary) {
    const pre = document.createElement('pre')
    pre.className = 'tl-result'
    pre.textContent = String(summary)
    rec.card.appendChild(pre)
    if (String(summary).length > 60) rec.card.open = true
  }
  box.scrollTop = box.scrollHeight
}

/**
 * 回合结束/取消：把还在「执行中…」的卡片标记为已停止——
 * 取消后旧操作卡不许永远转圈（B05：待处理显示的失效）。
 */
export function markToolCardsStopped(reason = '已停止') {
  for (const [, rec] of toolCards) {
    rec.card.classList.remove('running')
    rec.card.classList.add('stopped')
    rec.meta.textContent = reason
  }
  toolCards.clear()
}

/* ---------------- 确认条 ----------------
 * 生命周期（B05）：确认条只对「当前仍在等待的确认」有效。
 *   - 同一时刻只允许一条；新确认到来先作废旧条（旧按钮随之失灵）；
 *   - 回合结束 / 取消 / 超时 / 别处已处理时，由 dismissConfirm 作废：
 *     Promise 以 null 落款，调用方据此跳过回传——失效的按钮批不了任何操作。
 */
let activeConfirm = null // { id, name, resolve, active }

export function showConfirm({ id, name, description, risk }) {
  // 新确认到来：先把上一条作废（它的按钮立即失灵，不能拿去批准新操作）
  dismissConfirm()
  return new Promise((resolve) => {
    const state = { id, name, resolve, active: true }
    activeConfirm = state
    els.confirmBar.innerHTML = ''
    const info = document.createElement('div')
    info.className = 'grow'
    info.textContent = `⚠ 高风险操作：${description || name}（${risk}）`
    const allow = document.createElement('button')
    allow.className = 'allow'
    allow.textContent = '允许'
    const deny = document.createElement('button')
    deny.className = 'deny'
    deny.textContent = '拒绝'
    const done = (v) => {
      if (!state.active) return // 已失效：迟到点击不生效
      state.active = false
      if (activeConfirm === state) activeConfirm = null
      els.confirmBar.classList.add('hidden')
      els.confirmBar.innerHTML = ''
      resolve(v)
    }
    allow.onclick = () => done(true)
    deny.onclick = () => done(false)
    els.confirmBar.append(info, allow, deny)
    els.confirmBar.classList.remove('hidden')
  })
}

/**
 * 作废当前确认条（回合结束/取消/超时/被新确认替换/别处已处理）。
 * 返回是否真有作废；Promise 以 null 落款，旧按钮同时失灵。
 */
export function dismissConfirm() {
  const state = activeConfirm
  if (!state) return false
  state.active = false
  activeConfirm = null
  els.confirmBar.classList.add('hidden')
  els.confirmBar.innerHTML = ''
  state.resolve(null)
  return true
}

/** 是否正显示着确认条（测试/调试用） */
export function isConfirmActive() {
  return !!activeConfirm
}
