// src/renderer/js/main.js
// 渲染层入口：根据 ?mode=pet|workbench 初始化布局，装配 Live2D、对话与设置页。
//
// 两个形态各自加载一份 Live2D（桌宠窗 / 工作台凪面板），共用同一套驱动逻辑（live2d.js）；
// 因为是两个渲染进程，模块状态互不干扰。

import { PROVIDER_PRESETS, SECRET_KEYS, MODE, EMOTIONS, EVT } from '../../shared/protocol.js'
import { VOICE_EVT, mergeVoiceSettings } from '../../shared/voice-protocol.js'
import { RAG_EVT, mergeRagSettings } from '../../shared/rag-protocol.js'
import { ollamaTagsUrl } from '../../core/llm/ollama.js'
import { EDGE_VOICES, TTS_ENGINES, ASR_ENGINES } from '../../core/voice/index.js'
import { toSegments } from '../../core/relation/timeline.js'
import { presenceConfig } from '../../core/presence/circadian.js'
import { NOTES_EVENT } from '../../shared/notes-protocol.js'
import * as ui from './ui.js'
import { initChat, sendText } from './chat.js'
import * as l2d from './live2d.js'
import { initDiary } from './diary.js'
import { initVoice } from './voice.js'
import * as presence from './presence.js'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === MODE.WORKBENCH ? MODE.WORKBENCH : params.get('mode') === 'diary' ? 'diary' : MODE.PET
document.body.dataset.mode = mode

let settings = null
let llmDraftProfiles = {}
let llmDraftProvider = null
let l2dReady = false
let currentMood = null // 主进程情绪状态机的最新快照
let chatEmotion = null // 本轮对话流式情绪（只记录，回复返回后才翻脸）
let lastMoodKey = null // 用于区分「情绪真的变了」和「心跳重复广播」

/* ---------------- 待机醒目：一段时间没互动就放大一点、换个姿势 ---------------- */
const IDLE_AFTER_MS = 3 * 60 * 1000
const IDLE_BOOST = 1.15
let lastActivityAt = Date.now()
let idleBoosted = false
let idleTimer = null

function noteActivity() {
  lastActivityAt = Date.now()
  if (idleBoosted) {
    idleBoosted = false
    if (l2dReady) l2d.setScale(settings?.live2d?.scale || 1)
  }
}

function startIdleWatch() {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    if (!l2dReady) return
    if (settings?.live2d?.idleBoost === false) return
    const idle = Date.now() - lastActivityAt
    if (!idleBoosted && idle > IDLE_AFTER_MS) {
      idleBoosted = true
      l2d.setScale((settings?.live2d?.scale || 1) * IDLE_BOOST)
      // 深夜安静（night 的 motion 建议 'quiet'）：只放大提醒还在，不播动作
      if (!presence.randomMotionSuppressed()) l2d.playMotion('Idle')
    } else if (idleBoosted) {
      // 待机中偶尔再动一下，别像块背景板（深夜抑制随机动作）
      if (!presence.randomMotionSuppressed() && Math.random() < 0.35) l2d.playMotion('Idle')
    }
  }, 20000)
}

boot().catch((err) => {
  console.error('[nagi] 启动失败：', err)
  ui.addMessage('error', '启动失败：' + err.message)
})

function applyMood(snap) {
  if (!snap) return
  currentMood = snap
  ui.setMood(snap.mood)
  if (!l2dReady) return
  // 情绪真变了才带动作；心跳重复广播时只保持面容（否则每 15 秒手舞足蹈一次）
  const key = snap.mood + '|' + snap.expr
  const changed = key !== lastMoodKey
  lastMoodKey = key
  l2d.setEmotion(snap.expr, { motion: changed })
}

/* ---------------- 归来便签入口（BLUE-2；便签数据走 BLUE-3） ----------------
 * 归来（离开够久）时在桌宠/工作台显示一个小入口。本期只有入口与空态面板——
 * 不伪造便签内容；BLUE-3 落地候选与配额后往里填。
 */
let notesEntryTimer = null

function showNotesEntry(durationMs) {
  const btn = document.getElementById('notes-entry')
  if (!btn) return
  const mins = Math.max(1, Math.round((Number(durationMs) || 0) / 60000))
  btn.textContent = `📝 她留了张便签（你离开了约 ${mins} 分钟）`
  btn.title = '点开看看她独自待着时留下的东西'
  btn.classList.remove('hidden')
  clearTimeout(notesEntryTimer)
  // 10 分钟后淡出：不长期挡画面；下次归来会重新出现
  notesEntryTimer = setTimeout(() => btn.classList.add('hidden'), 10 * 60 * 1000)
}

/* ---------------- 她留下的东西（BLUE-3：便签 / 行动留痕 / 回忆物） ---------------- */

const NOTE_KIND_LABEL = { activity: '独处', reunion: '归来', action: '行动' }

function notesTimeText(at) {
  if (!Number.isFinite(at)) return ''
  return new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 渲染查看器内容（数据来自主进程只读列表；写不写、存不存都由设置开关决定） */
function renderNotesPanel(body, data) {
  body.textContent = ''
  const enabled = data?.enabled || {}
  const anyOn = enabled.notes || enabled.traces || enabled.anchors
  if (!anyOn) {
    const p = document.createElement('p')
    p.className = 'dim'
    p.style.margin = '0'
    p.textContent = '「她留下的东西」现在是关着的。到「设置 → 她留下的东西」里打开，她会把独处时的点滴、帮你做过的事安静地记在这里。'
    body.appendChild(p)
    return
  }
  const section = (title, empty, items) => {
    const h = document.createElement('div')
    h.className = 'np-sec'
    h.textContent = title
    body.appendChild(h)
    if (!items.length) {
      const e = document.createElement('p')
      e.className = 'dim'
      e.style.margin = '0 0 10px'
      e.textContent = empty
      body.appendChild(e)
      return
    }
    for (const it of items) body.appendChild(it)
  }

  // 便签
  if (enabled.notes) {
    const items = (data.notes || []).slice().reverse().map((n) => {
      const el = document.createElement('div')
      el.className = 'np-item'
      const meta = document.createElement('div')
      meta.className = 'np-meta'
      meta.textContent = `${notesTimeText(n.at)} · ${NOTE_KIND_LABEL[n.noteKind] || n.noteKind}${n.provenance === 'simulation' ? ' · 模拟活动' : ''}`
      const text = document.createElement('div')
      text.className = 'np-text'
      text.textContent = n.text
      el.append(meta, text)
      return el
    })
    section('便签', '还没有便签。她需要一点独处的时间。', items)
  }

  // 行动留痕
  if (enabled.traces) {
    const items = (data.traces || []).slice().reverse().map((t) => {
      const el = document.createElement('div')
      el.className = 'np-item'
      const meta = document.createElement('div')
      meta.className = 'np-meta'
      meta.textContent = `${notesTimeText(t.at)} · ${t.tool} · ${t.status === 'failed' ? '返回失败' : '已返回'}`
      const text = document.createElement('div')
      text.className = 'np-text'
      text.textContent = t.summary || '（没有摘要）'
      el.append(meta, text)
      return el
    })
    section('帮你做过的事', '还没有记录。她替你跑过工具之后会记一笔（只说跑过、返回，不代表外部效果已生效）。', items)
  }

  // 回忆物（只读展示：她可能想起来的共同经历；是否提起由概率门决定，不会硬凑）
  if (enabled.anchors) {
    const items = (data.anchors || []).slice(0, 8).map((a) => {
      const el = document.createElement('div')
      el.className = 'np-item'
      const meta = document.createElement('div')
      meta.className = 'np-meta'
      meta.textContent = `${notesTimeText(a.occurredAt)} · ${a.trust === 'user-stated' ? '你说过的' : a.trust === 'observed' ? '有来源的' : '她自己的感受'}`
      const text = document.createElement('div')
      text.className = 'np-text'
      text.textContent = a.text || '（无正文）'
      el.append(meta, text)
      return el
    })
    section('可能想起来的', '还没有可回想的共同经历。', items)
  }

  // 边界说明：外部文件写入未实现（不伪装成功）
  const foot = document.createElement('p')
  foot.className = 'dim np-foot'
  foot.textContent = '所有内容只留在本机这一份应用数据里；来源被忘记的，这里也会跟着消失。'
  body.appendChild(foot)
}

async function refreshNotesPanel(body) {
  try {
    const data = await window.nagi.notes.list()
    renderNotesPanel(body, data)
  } catch (err) {
    body.textContent = '读取失败：' + (err?.message || String(err))
  }
}

function toggleNotesPanel() {
  const old = document.getElementById('notes-panel')
  if (old) {
    old.remove()
    return
  }
  const card = document.createElement('div')
  card.id = 'notes-panel'
  card.className = 'notes-panel'
  const title = document.createElement('div')
  title.className = 'np-title'
  title.textContent = '她留下的东西'
  const body = document.createElement('div')
  body.className = 'np-body dim'
  body.textContent = '读取中…'
  const close = document.createElement('button')
  close.id = 'notes-panel-close'
  close.textContent = '关上'
  close.addEventListener('click', () => card.remove())
  card.append(title, body, close)
  document.body.appendChild(card)
  // 点外面也关上（一次性监听；入口按钮本身不触发关闭）
  setTimeout(() => {
    document.addEventListener('pointerdown', (e) => {
      if (!card.contains(e.target) && e.target.id !== 'notes-entry') card.remove()
    }, { once: true })
  }, 0)
  // 变化时刷新（主进程广播同一份权威列表）
  const offNotes = window.nagi.on(NOTES_EVENT, (data) => {
    if (document.getElementById('notes-panel') === card) renderNotesPanel(body, data)
    else offNotes()
  })
  void refreshNotesPanel(body)
}

function wireNotesEntry() {
  document.getElementById('notes-entry')?.addEventListener('click', toggleNotesPanel)
  document.getElementById('btn-open-notes')?.addEventListener('click', toggleNotesPanel)
}

async function boot() {
  settings = await window.nagi.settings.get()

  // 日记查看器形态：独立小窗，只装配日记
  if (mode === 'diary') {
    initDiary()
    // 无头自测：把渲染结果打到 stdout，验证日记读取链路
    if (params.get('selftest') === '1') {
      setTimeout(() => {
        const dates = document.querySelectorAll?.('#diary-list .diary-date')?.length || 0
        const items = document.querySelectorAll?.('#diary-content .d-item')?.length || 0
        console.log(`[selftest] 日记窗：${dates} 篇日期，最新一篇 ${items} 条独白`)
      }, 1500)
    }
    return
  }

  // 事件：设置变更
  window.nagi.on(EVT.SETTINGS_CHANGED, (next) => {
    if (next) settings = next
  })

  // 事件：情绪状态机广播（主进程单例，双窗同步）——侧栏读数 + 双形态面容/动作
  window.nagi.on(EVT.MOOD, applyMood)
  // 初始情绪：心跳 15s 一次，先拉一次免得多半分钟默认脸
  try {
    applyMood(await window.nagi.mood.get())
  } catch {
    /* 旧版本主进程没有该通道时忽略 */
  }

  // 实感快照（BLUE-2）：时段表现落到 Live2D；归来时弹「她留了张便签」入口
  // （快照由主进程向两窗广播同一份，各自渲染各自的表现，天然同步）
  wireNotesEntry()
  presence.initPresence({
    getConfig: () => settings?.presence,
    onReunion: ({ durationMs }) => showNotesEntry(durationMs)
  })

  // 事件：桌宠交互（戳一戳台词气泡 / 活动监测的主动搭话 / 日程提醒）
  window.nagi.on(EVT.PET, (p) => {
    noteActivity()
    if (!p || !p.text) return
    if (mode === MODE.PET) {
      document.getElementById('bubble-ignore')?.classList.toggle('hidden', p.kind !== 'proactive')
      // 提醒是她答应过的事，气泡多停一会儿
      ui.showBubble(p.text, { autoHide: p.kind === 'reminder' ? 12000 : 6000 })
    } else if (p.kind === 'proactive' || p.kind === 'reminder') {
      // 工作台形态：主动搭话/提醒进对话流，别只闪个气泡就没了
      ui.addMessage('nagi', p.text)
      if (p.kind === 'reminder') {
        ui.addToolLog('⏰ 日程提醒：' + p.text)
        if (!document.getElementById('reminder-overlay')?.classList.contains('hidden')) renderReminders()
      }
    }
    // TapBody 动作在 pokeHer() 里已经播了，这里只管说
  })

  // 设备状态只进工作台日志；被动信号不绕过主动陪伴的打扰预算弹气泡。
  window.nagi.on(EVT.HA_EVENT, (payload) => {
    if (!payload || !payload.summary) return
    if (mode === MODE.WORKBENCH) ui.addToolLog(`（家里：${payload.summary}）`)
  })

  wireWindowButtons()
  wireSettingsPage()
  wireRelationPage()
  wireReminderPage()

  // 首次启动：活动监测告知（只弹一次，仅桌宠形态）
  if (mode === MODE.PET) maybeShowMonitorNotice()

  // 对话
  // 立绘动作由对话状态驱动（2026-10-15 起，不再跟随鼠标）：
  //   · 生成期间（思考/执行/等待）→ 思考姿态：目光偏移 + 轻微低侧头
  //   · 回复返回后 → 按回答内容的情绪与语气选表情 + 轻微动作；判断不出 → 中立脸
  //   · 空闲 → 呼吸/眨眼/待机动作照旧（姿态全部归零即交还给模型自身）
  initChat({
    // 流式情绪只记录、不当场翻脸：状态机的正式情绪仍以 MOOD 广播为准，
    // 而"她这一句是什么情绪"等回复返回后在 onDone 落地
    onEmotion: (emotion) => {
      chatEmotion = EMOTIONS.includes(emotion) ? emotion : null
    },
    onStatus: (state) => {
      if (state === 'thinking') ui.showBubble('……', { autoHide: 0 })
      // 非 idle（思考/执行/等待）都算"生成回复期间"
      if (l2dReady) l2d.setPose(state === 'idle' ? null : 'thinking')
    },
    // 说话口型：文本在流，嘴就动
    onTextDelta: () => {
      noteActivity()
      if (l2dReady) l2d.startTalking()
    },
    onDone: () => {
      if (l2dReady) {
        l2d.stopTalking()
        l2d.setPose(null) // 思考姿态平滑收回，交还呼吸/待机
        // 回答内容的情绪与语气 → 表情 + 轻微动作；无法判断 → 中立
        l2d.setEmotion(chatEmotion || 'calm', { motion: !!chatEmotion })
      }
      chatEmotion = null
    }
  })

  if (mode === MODE.WORKBENCH) {
    ui.setBrain(brainLabel())
    wireWorkbenchPanel()
  }

  // 语音链路（M5）：她回复完自动开口 + 「按住说话」送进对话 + 说话时的口型
  initVoice({ mode, getSettings: () => settings })

  // 桌宠：加载模型 + 尺寸控制 + 待机加成
  if (mode === MODE.PET) {
    wirePetControls()
    await tryLoadLive2D(ui.els.canvas, ui.els.placeholder)
    startIdleWatch()
    if (params.get('pettest') === '1') runEmotionSelftest()
  }

  // 工作台：凪面板里也加载一份
  if (mode === MODE.WORKBENCH) {
    await tryLoadLive2D(document.getElementById('wb-live2d-canvas'), document.getElementById('wb-live2d-placeholder'))
    renderMotionPanel()
    // 动作列表把面板撑高后容器尺寸变了，立刻重排一次，
    // 免得画布沿用旧高度溢出到下方控件栏上
    if (l2dReady) l2d.resize()
  }

  // 无头自测：自动发一条消息验证 对话 IPC → 事件广播 → UI 渲染 全链路
  if (params.get('selftest') === '1') {
    setTimeout(() => sendText(params.get('testmsg') || '你好，凪'), 3000)
    setTimeout(runPetSelftest, 6000)
  }
}

/* ---------------- 情绪/戳击链路自测（无头） ---------------- */
async function runPetSelftest() {
  const report = (name, pass, detail) =>
    console.log(`[selftest] ${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
  let allPass = true
  const check = (name, pass, detail) => {
    if (!pass) allPass = false
    report(name, pass, detail)
  }
  // 1. 初始快照
  try {
    const snap = await window.nagi.mood.get()
    check('mood.get 初始快照', !!snap && typeof snap.mood === 'string', `mood=${snap?.mood} expr=${snap?.expr}`)
  } catch (err) {
    check('mood.get 初始快照', false, err.message)
  }
  // 2. 订阅 → 戳击 → MOOD/PET 双广播（handlePoke 会立即广播两者）
  let moodSeen = null
  let petSeen = null
  const offMood = window.nagi.on(EVT.MOOD, (s) => { if (!moodSeen) moodSeen = s })
  const offPet = window.nagi.on(EVT.PET, (p) => { if (!petSeen) petSeen = p })
  try {
    const p = await window.nagi.pet.poke()
    check('pet.poke 返回台词', !!p && typeof p.text === 'string' && typeof p.expr === 'string',
      p ? `「${p.text}」(${p.expr})` : '')
  } catch (err) {
    check('pet.poke 返回台词', false, err.message)
  }
  await new Promise((r) => setTimeout(r, 500))
  offMood()
  offPet()
  check('MOOD 广播到达', !!moodSeen, moodSeen ? `${moodSeen.mood}/${moodSeen.expr}` : '未收到')
  check('PET 广播到达', !!petSeen && typeof petSeen.text === 'string', petSeen ? `「${petSeen.text}」` : '未收到')
  console.log(`[selftest] 情绪/戳击链路：${allPass ? '全部通过' : '存在失败项'}`)
}

function brainLabel() {
  const p = PROVIDER_PRESETS[settings?.llm?.provider]
  const name = p ? p.label : settings?.llm?.provider || '未配置'
  return `${name} / ${settings?.llm?.model || '-'}`
}

/* ---------------- 窗口按钮 ---------------- */
function wireWindowButtons() {
  const on = (id, fn) => {
    const el = document.getElementById(id)
    if (el) el.addEventListener('click', fn)
  }
  on('btn-open-workbench', () => window.nagi.win.setMode(MODE.WORKBENCH))
  on('btn-pet-settings', () => openSettings())
  on('btn-pet-hide', () => window.nagi.win.hide())
  on('btn-open-diary', () => window.nagi.win.openDiary())
  on('bubble-ignore', async () => {
    await window.nagi.companion.ignore()
    ui.hideBubble()
  })

  on('btn-wb-pet', () => window.nagi.win.setMode(MODE.PET))
  on('btn-wb-min', () => window.nagi.win.minimize())
  on('btn-wb-close', () => window.nagi.win.close())
  on('btn-open-settings', () => openSettings())
  on('btn-close-settings', () => closeSettings())

  // 新对话：清空短期上下文（长期记忆、关系、日程都保留）
  on('btn-new-chat', async () => {
    try {
      await window.nagi.memory.clearHistory()
    } catch {
      /* ignore */
    }
    const box = document.getElementById('messages')
    if (box) box.innerHTML = ''
    ui.addToolLog('已开始新对话（短期上下文清空，长期记忆与关系保留）')
  })
}

/* ---------------- 桌宠：尺寸自由调节 + 待机加成 ---------------- */
function wirePetControls() {
  const el = document.getElementById('pet-root')
  // 鼠标在桌宠上就是"有动静"
  el?.addEventListener('pointermove', noteActivity)
  el?.addEventListener('pointerdown', noteActivity)

  // 工具栏 ＋／－：等比缩放窗口（右下角锚定）
  const resizeBy = (factor) => {
    const b = window.__nagiPetSize || { width: 400, height: 600 }
    const width = Math.round(Math.min(760, Math.max(240, b.width * factor)))
    applyPetSize(width)
  }
  document.getElementById('btn-pet-grow')?.addEventListener('click', () => resizeBy(1.12))
  document.getElementById('btn-pet-shrink')?.addEventListener('click', () => resizeBy(1 / 1.12))
  document.getElementById('btn-pet-action')?.addEventListener('click', () => {
    noteActivity()
    if (l2dReady) l2d.randomMotion()
  })

  // Ctrl+滚轮 快速缩放
  el?.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      resizeBy(e.deltaY < 0 ? 1.08 : 1 / 1.08)
    },
    { passive: false }
  )

  // 右下角拖拽手柄：拖多少改多少，等比（保持 2:3）
  const grip = document.getElementById('pet-resizer')
  let dragging = false
  let start = null
  grip?.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    start = { x: e.clientX, y: e.clientY, w: window.__nagiPetSize?.width || 400, h: window.__nagiPetSize?.height || 600 }
    grip.setPointerCapture(e.pointerId)
  })
  grip?.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dw = e.clientX - start.x
    const dh = e.clientY - start.y
    // 取变化更大的那个方向，保持等比
    const byW = start.w + dw
    const byH = (start.h + dh) * (2 / 3)
    const width = Math.abs(dw) >= Math.abs(dh) ? byW : byH
    applyPetSize(width)
  })
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    if (window.__nagiPetSize) window.nagi.win.resize({ ...window.__nagiPetSize, persist: true })
  }
  grip?.addEventListener('pointerup', endDrag)
  grip?.addEventListener('pointercancel', endDrag)

  wirePetDragAndPoke(el)
}

/**
 * 拖动窗口 + 戳一戳。
 * 因为 #pet-root 不再是 -webkit-app-region: drag（见 css/base.css），
 * 鼠标事件能正常到达渲染层，于是可以做到：
 *   按住任意部位拖动 → 窗口跟着走；原地松手（位移 < 4px）→ 算戳一下。
 * 比"整窗当标题栏拖"多了一层语义：抓她=搬家，点她=逗她。
 */
function wirePetDragAndPoke(el) {
  if (!el) return
  const DRAG_THRESHOLD = 4
  let st = null

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    // 工具条按钮 / 缩放滑杆 / 气泡 / 右下角手柄 不参与拖动
    if (e.target?.closest?.('button, input, .bubble, #pet-resizer')) return
    // window.screenX/Y 是同步可读的窗口左上角（DIP），不必再问主进程，
    // 避免"按下后立刻快拖"时坐标还没回来、窗口跳到屏幕角落的竞态。
    st = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false, id: e.pointerId }
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  })

  el.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return
    const dx = e.screenX - st.sx
    const dy = e.screenY - st.sy
    if (!st.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) st.moved = true
    if (st.moved) window.nagi.win.moveTo(st.wx + dx, st.wy + dy)
  })

  const finish = (e) => {
    if (!st || (e && e.pointerId !== st.id)) return
    const wasDrag = st.moved
    st = null
    try {
      el.releasePointerCapture(e?.pointerId)
    } catch {
      /* ignore */
    }
    // 原地松手 = 戳一下（拖动过就不算）
    if (!wasDrag) pokeHer()
  }
  el.addEventListener('pointerup', finish)
  el.addEventListener('pointercancel', () => {
    st = null
  })
}

/** 戳一戳：演一下 TapBody，再让主进程挑台词（气泡 / 情绪 / 日记都走那条链） */
function pokeHer() {
  noteActivity()
  if (l2dReady) l2d.playMotion('TapBody')
  window.nagi?.pet?.poke()?.catch?.(() => {})
}

/** 应用桌宠尺寸（等比 2:3），拖动中不落盘，松手才 persist */
function applyPetSize(width) {
  const w = Math.round(Math.min(760, Math.max(240, width)))
  const h = Math.round(w * 1.5)
  window.__nagiPetSize = { width: w, height: h }
  window.nagi.win.resize({ width: w, height: h, persist: false })
  // 画布随窗口变化由 pixi 的 resizeTo 处理；这里补一次确保立刻生效
  if (l2dReady) setTimeout(() => l2d.resize(), 60)
}

/* ---------------- 工作台：凪面板 ---------------- */
function wireWorkbenchPanel() {
  const panel = document.getElementById('nagi-panel')
  const splitter = document.getElementById('wb-splitter')
  const expandBtn = document.getElementById('btn-nagi-panel-expand')
  if (!panel) return

  // 记忆上次的宽度与折叠状态
  const savedW = Number(localStorage.getItem('nagi.panelWidth'))
  if (Number.isFinite(savedW) && savedW >= 240 && savedW <= 460) {
    panel.style.flexBasis = savedW + 'px'
    panel.style.width = savedW + 'px'
  }
  const collapsed = localStorage.getItem('nagi.panelCollapsed') === '1'
  setPanelCollapsed(collapsed, { silent: true })

  function setPanelCollapsed(c, { silent = false } = {}) {
    panel.classList.toggle('collapsed', c)
    expandBtn?.classList.toggle('hidden', !c)
    if (!silent) localStorage.setItem('nagi.panelCollapsed', c ? '1' : '0')
    // 面板尺寸变了，画布要重排（CSS 有过渡，稍等一下再量）
    setTimeout(() => l2dReady && l2d.resize(), 220)
  }
  document.getElementById('btn-nagi-panel-collapse')?.addEventListener('click', () => setPanelCollapsed(true))
  expandBtn?.addEventListener('click', () => setPanelCollapsed(false))

  // 拖动改宽
  splitter?.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    splitter.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = panel.getBoundingClientRect().width
    const move = (ev) => {
      const w = Math.round(Math.min(460, Math.max(240, startW - (ev.clientX - startX))))
      panel.style.flexBasis = w + 'px'
      panel.style.width = w + 'px'
      l2dReady && l2d.resize()
    }
    const up = () => {
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
      localStorage.setItem('nagi.panelWidth', String(Math.round(panel.getBoundingClientRect().width)))
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })

  // 缩放滑杆
  const scale = document.getElementById('wb-l2d-scale')
  const scaleVal = document.getElementById('wb-l2d-scale-val')
  if (scale) {
    scale.value = String(settings?.live2d?.scale ?? 1)
    if (scaleVal) scaleVal.textContent = Number(scale.value).toFixed(2)
    scale.addEventListener('input', () => {
      const v = Number(scale.value)
      if (scaleVal) scaleVal.textContent = v.toFixed(2)
      if (l2dReady) l2d.setScale(v)
    })
    scale.addEventListener('change', async () => {
      await window.nagi.settings.set({ live2d: { scale: Number(scale.value) } })
      settings = await window.nagi.settings.get()
    })
  }

  // 动作按钮
  document.getElementById('btn-wb-random-motion')?.addEventListener('click', () => {
    const r = l2d.randomMotion()
    if (r) ui.addToolLog(`（凪动了一下：${r.group} #${r.index + 1}）`)
  })
  document.getElementById('btn-wb-stop-motion')?.addEventListener('click', () => l2d.stopMotions())
  document.getElementById('btn-wb-mirror')?.addEventListener('click', async () => {
    const next = !(settings?.live2d?.mirror ?? false)
    l2d.setMirror(next)
    await window.nagi.settings.set({ live2d: { mirror: next } })
    settings = await window.nagi.settings.get()
  })
}

/** 把模型里的动作组渲染成一排按钮：点一下她就演一遍 */
function renderMotionPanel() {
  const box = document.getElementById('wb-motion-list')
  if (!box) return
  box.innerHTML = ''
  const catalog = l2d.motionCatalog()
  const groups = Object.keys(catalog)
  if (!groups.length) {
    const d = document.createElement('div')
    d.className = 'dim'
    d.textContent = '（这个模型没有动作）'
    box.appendChild(d)
    return
  }
  for (const group of groups) {
    const label = document.createElement('div')
    label.className = 'np-group'
    label.textContent = group
    box.appendChild(label)
    catalog[group].forEach((name, i) => {
      const b = document.createElement('button')
      b.textContent = name
      b.title = `${group} · ${name}`
      b.addEventListener('click', () => l2d.playMotion(group, i))
      box.appendChild(b)
    })
  }
}

/* ---------------- Live2D ---------------- */
async function tryLoadLive2D(canvas, placeholder) {
  if (!canvas) return
  const cfg = settings?.live2d || {}
  const list = await window.nagi.models.list()
  if (!list.models || list.models.length === 0) {
    ui.addToolLog?.('（未找到 Live2D 模型，请把模型放进 models/ 目录。）')
    console.warn('[live2d] models 目录下没有 *.model3.json，跳过模型加载。模型目录：', list.dir)
    return
  }
  const rel = cfg.modelPath && list.models.includes(cfg.modelPath) ? cfg.modelPath : list.models[0]
  const url = `nagi-local://models/${rel}`
  try {
    await l2d.load(canvas, url, {
      scale: cfg.scale || 1,
      mirror: !!cfg.mirror,
      // 取景：默认「胸像」（只显示上半身）。模型目录 nagi-emotion.json 里的 frame 优先级更高
      frame: cfg.frame || undefined,
      eyeBlink: cfg.eyeBlink !== false
    })
    l2dReady = true
    placeholder?.classList.add('hidden')
    // 模型就位后立刻同步当前情绪（初始拉取发生在模型加载前）
    if (currentMood) l2d.setEmotion(currentMood.expr, { motion: false })
    // 时段表现：模型就绪前收到的 rhythm 快照在这里补上（深夜安静/午后慵懒）
    presence.applyCurrentRhythm()
    console.log(
      '[live2d] 已加载模型：',
      rel,
      '取景：',
      l2d.getFrame(),
      '表情：',
      l2d.listExpressions().length,
      '动作组：',
      l2d.listMotionGroups().join('/')
    )
  } catch (err) {
    console.error('[live2d] 加载失败：', err)
    if (mode === MODE.PET) ui.showBubble('模型加载失败：' + err.message)
    else ui.addToolLog('模型加载失败：' + err.message)
  }
}

/* ---------------- Live2D 自测 ---------------- */
function runEmotionSelftest() {
  setTimeout(() => {
    console.log('[selftest] 模型表情列表:', JSON.stringify(l2d.listExpressions()))
    console.log('[selftest] 动作组:', JSON.stringify(l2d.listMotionGroups()))
    console.log('[selftest] 动作目录:', JSON.stringify(l2d.motionCatalog()))
    const results = {}
    const motions = {}
    for (const e of EMOTIONS) {
      const hit = l2d.resolveExpression(e)
      const mo = l2d.resolveMotion(e)
      results[e] = hit
      motions[e] = mo
      l2d.setEmotion(e, { motion: 'force' })
      console.log(`[selftest] 情绪 ${e} → 表情 ${hit || '(无映射，保持默认)'} / 动作 ${mo || '(无)'}`)
    }
    const missed = EMOTIONS.filter((e) => !results[e])
    console.log(missed.length ? `[selftest] ⚠ 未命中: ${missed.join(',')}` : '[selftest] ✔ 6/6 情绪全部映射到真实表情')
  }, 2500)
}

/* ---------------- 首次启动：活动监测告知 ---------------- */
function maybeShowMonitorNotice() {
  const p = settings?.privacy || {}
  if (p.noticeShown) return
  const ov = document.getElementById('notice-overlay')
  if (!ov) return
  ov.classList.remove('hidden')
  const done = async (patch) => {
    ov.classList.add('hidden')
    try {
      await window.nagi.settings.set({ privacy: { noticeShown: true, ...patch } })
      settings = await window.nagi.settings.get()
    } catch {
      /* ignore */
    }
  }
  document.getElementById('btn-notice-ok')?.addEventListener('click', () => done({}))
  document.getElementById('btn-notice-off')?.addEventListener('click', () => done({ monitorEnabled: false }))
}

/* ---------------- 设置页 ---------------- */
function openSettings() {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return
  overlay.classList.remove('hidden')
  fillSettingsForm()
  refreshCalendarStatus()
  refreshMusicStatus()
  refreshGeoStatus()
  refreshHaStatus()
}
function closeSettings() {
  document.getElementById('settings-overlay')?.classList.add('hidden')
}

async function refreshCalendarStatus() {
  const label = document.getElementById('calendar-status')
  const list = document.getElementById('calendar-events')
  if (!label || !list || !window.nagi.calendar) return
  try {
    const state = await window.nagi.calendar.status()
    if (!state.authorized) {
      label.textContent = '尚未授权日历文件'
      list.textContent = ''
      return
    }
    label.textContent = `已授权快照：${state.sourceName} · 导入于 ${new Date(state.importedAt).toLocaleString()} · 共 ${state.total} 项` +
      (state.unsupported ? ` · ${state.unsupported} 项重复或无法可靠解析的日程已跳过` : '')
    list.textContent = state.events.length
      ? state.events.map((event) => `${new Date(event.startsAt).toLocaleString()} ${event.title}`).join('\n')
      : '快照里没有可显示的未来日程'
  } catch (err) {
    label.textContent = `日历快照不可读：${err.message}`
    list.textContent = ''
  }
}

async function refreshMusicStatus() {
  const label = document.getElementById('music-status')
  if (!label || !window.nagi.music) return
  label.textContent = '读取中…'
  try {
    const state = await window.nagi.music.status()
    if (!state.authorized) label.textContent = '尚未授权音乐信号'
    else if (state.paused) label.textContent = '已授权；勿扰或只陪着期间暂停读取'
    else if (state.error) label.textContent = `已授权；读取失败：${state.error}`
    else if (!state.observation?.available) label.textContent = '已授权；Windows 当前没有可用的媒体会话'
    else {
      const obs = state.observation
      const stateWord = obs.playbackStatus === 'playing' ? '正在播放' : obs.playbackStatus === 'paused' ? '已暂停' : obs.playbackStatus === 'stopped' ? '已停止' : '状态未知'
      label.textContent = `已授权 · ${stateWord}：${obs.title || '无曲名'}` +
        (obs.artist ? ` / ${obs.artist}` : '') + ` · 来源 ${obs.app || '未知播放器'}` +
        (obs.source && obs.source !== 'smtc' ? '（窗口标题兜底，非系统会话）' : '')
    }
  } catch (err) { label.textContent = `音乐信号读取失败：${err.message}` }
}

async function refreshGeoStatus() {
  const label = document.getElementById('geo-status')
  if (!label || !window.nagi.geo) return
  label.textContent = '读取中…'
  try {
    const state = await window.nagi.geo.status()
    if (!state.authorized) label.textContent = '尚未授权位置信号'
    else if (state.paused) label.textContent = '已授权；勿扰或只陪着期间暂停读取'
    else if (state.error) label.textContent = `已授权；读取失败：${state.error}`
    else if (!state.observation?.available) label.textContent = '已授权；定位暂不可用（系统定位未开且 IP 定位失败）'
    else {
      const obs = state.observation
      const where = [obs.city, obs.country].filter(Boolean).join('，') || '未知地名'
      label.textContent = `已授权 · ${obs.source === 'windows-api' ? '系统定位' : 'IP 粗定位'}：${where}（${obs.lat.toFixed(4)}, ${obs.lon.toFixed(4)}）`
    }
  } catch (err) { label.textContent = `位置信号读取失败：${err.message}` }
}

async function refreshHaStatus() {
  const label = document.getElementById('ha-signal-status')
  if (!label || !window.nagi.ha) return
  try {
    const state = await window.nagi.ha.signalStatus()
    label.textContent = `设备状态读取：${state.readAuthorized ? '已授权' : '未授权'} · 设备控制：${state.controlAuthorized ? '已授权，仍需逐次确认' : '未授权'}` +
      (state.paused ? ' · 勿扰/只陪着期间暂停信号' : '')
  } catch (err) { label.textContent = `HA 授权状态读取失败：${err.message}` }
}

function readLlmForm() {
  const rawTemperature = document.getElementById('set-temp').value.trim()
  const parsedTemperature = Number(rawTemperature)
  return {
    baseURL: document.getElementById('set-baseurl').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    temperature: rawTemperature && Number.isFinite(parsedTemperature) ? parsedTemperature : 0.7
  }
}

function showLlmProfile(provider) {
  const profile = llmDraftProfiles[provider] || PROVIDER_PRESETS[provider] || {}
  document.getElementById('set-baseurl').value = profile.baseURL || ''
  document.getElementById('set-model').value = profile.model || ''
  document.getElementById('set-temp').value = profile.temperature ?? 0.7
}

function fillSettingsForm() {
  // provider 下拉
  const sel = document.getElementById('set-provider')
  if (sel && sel.options.length === 0) {
    for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
      const o = document.createElement('option')
      o.value = key
      o.textContent = p.label
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => {
      if (llmDraftProvider) llmDraftProfiles[llmDraftProvider] = readLlmForm()
      llmDraftProvider = sel.value
      showLlmProfile(sel.value)
      updateLocalLlmUi()
    })
  }
  const llm = settings?.llm || {}
  llmDraftProvider = PROVIDER_PRESETS[llm.provider] ? llm.provider : 'openai'
  llmDraftProfiles = { ...(settings?.llmProfiles || {}) }
  llmDraftProfiles[llmDraftProvider] = {
    baseURL: llm.baseURL || '',
    model: llm.model || '',
    temperature: llm.temperature ?? 0.7
  }
  if (sel) sel.value = llmDraftProvider
  showLlmProfile(llmDraftProvider)
  updateLocalLlmUi()

  const ha = settings?.homeassistant || {}
  document.getElementById('set-ha-url').value = ha.baseURL || ''

  const tools = settings?.tools || {}
  document.getElementById('set-fileroot').value = tools.fileRoot || ''
  document.getElementById('set-cdp').value = tools.cdpPort ?? 9222
  document.getElementById('set-l2d-scale').value = settings?.live2d?.scale ?? 1
  // 桌宠大小
  const sizeEl = document.getElementById('set-pet-size')
  if (sizeEl) {
    const w = settings?.live2d?.petWidth ?? 400
    sizeEl.value = String(w)
    const label = document.getElementById('set-pet-size-val')
    if (label) label.textContent = `${w} × ${Math.round(w * 1.5)}`
  }
  const boost = document.getElementById('set-idle-boost')
  if (boost) boost.checked = settings?.live2d?.idleBoost !== false

  // 活动监测
  const privacy = settings?.privacy || {}
  const monEl = document.getElementById('set-monitor')
  if (monEl) monEl.checked = privacy.monitorEnabled !== false
  const dndEl = document.getElementById('set-dnd')
  if (dndEl) dndEl.checked = privacy.doNotDisturb === true
  const presenceEl = document.getElementById('set-only-presence')
  if (presenceEl) presenceEl.checked = privacy.onlyPresence === true
  const companion = settings?.companion || {}
  const maxEl = document.getElementById('set-companion-max')
  if (maxEl) maxEl.value = String(companion.maxDaily ?? 3)
  const gapEl = document.getElementById('set-companion-gap')
  if (gapEl) gapEl.value = String(companion.minGapMinutes ?? 90)
  const blEl = document.getElementById('set-blacklist')
  if (blEl) blEl.value = (privacy.blacklist || []).join('\n')

  refreshSecretStatus()
  refreshModels()
  refreshMemory()
  refreshLedger()
  refreshYearbook()
  refreshCompanionStatus()
  refreshVoice()
  refreshRag()
  refreshPresenceSection()
}

function updateLocalLlmUi() {
  const provider = document.getElementById('set-provider')?.value
  const local = provider === 'ollama'
  document.getElementById('set-local-llm')?.classList.toggle('hidden', !local)
  document.getElementById('set-cloud-key-wrap')?.classList.toggle('hidden', local || provider === 'workbuddy')
  if (local) void refreshLocalLlmStatus()
}

async function refreshLocalLlmStatus() {
  if (document.getElementById('set-provider')?.value !== 'ollama') return
  const baseURL = document.getElementById('set-baseurl').value.trim()
  const model = document.getElementById('set-model').value.trim()
  const status = document.getElementById('set-local-llm-status')
  const list = document.getElementById('set-local-model-list')
  status.textContent = '正在检测…'
  try {
    const result = await window.nagi.llm.localStatus({ baseURL, model })
    if (document.getElementById('set-provider')?.value !== 'ollama' ||
        document.getElementById('set-baseurl').value.trim() !== baseURL ||
        document.getElementById('set-model').value.trim() !== model) return
    status.textContent = result.ok ? '本地大脑已就绪' : result.error
    list.replaceChildren()
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = result.models?.length ? '选择已安装模型' : '（没有已安装模型）'
    list.appendChild(placeholder)
    for (const name of result.models || []) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      list.appendChild(option)
    }
    list.value = result.models?.includes(model) ? model : result.models?.includes(`${model}:latest`) ? `${model}:latest` : ''
  } catch {
    status.textContent = '检测失败，请重试'
  }
}

async function refreshSecretStatus() {
  try {
    const st = await window.nagi.secrets.status()
    const llm = st[SECRET_KEYS.LLM_API_KEY] ? '已配置' : '未配置'
    const ha = st[SECRET_KEYS.HA_TOKEN] ? '已配置' : '未配置'
    document.getElementById('set-key-status').textContent = llm
    document.getElementById('set-ha-status').textContent = ha
  } catch {
    /* ignore */
  }
}

/** 她的长期记忆：列出来 + 单条遗忘 */
async function refreshMemory() {
  const box = document.getElementById('memory-list')
  if (!box || !window.nagi.memory) return
  try {
    const list = await window.nagi.memory.list()
    box.innerHTML = ''
    for (const m of list) {
      const row = document.createElement('div')
      row.className = 'mem-item'
      const t = document.createElement('div')
      t.className = 't'
      t.textContent = `${m.provenance === 'user-stated' ? '用户记下' : '未经核实'}：${m.text}`
      const del = document.createElement('button')
      del.textContent = '✕'
      del.title = '让她忘掉这条'
      del.addEventListener('click', async () => {
        try {
          await window.nagi.memory.remove({ id: m.id })
          await refreshMemory()
          await refreshLedger()
        } catch (err) {
          document.getElementById('ledger-status').textContent = err.message
        }
      })
      row.append(t, del)
      box.appendChild(row)
    }
  } catch (err) {
    console.warn('[memory] 列表读取失败', err.message)
  }
}

let ledgerOffset = 0
const LEDGER_PAGE = 50
const tierNames = { recorded: '有来源的记录', unverified: '未经核实', subjective: '主观记录' }
const sourceNames = {
  'journal-live': '真实互动流水', journal: '旧版互动流水',
  'diary-live': '新日记', diary: '旧日记',
  'memory-manual': '用户手动记忆', 'memory-model': '模型整理', memory: '旧版记忆',
  history: '旧对话历史', rag: '旧检索档案', 'rag-summary': '模型摘要',
  relation: '旧关系统计', 'relation-live': '关系统计',
  timeline: '旧情绪时间线', 'timeline-live': '情绪时间线', correction: '用户更正'
}

async function refreshYearbook() {
  const box = document.getElementById('yearbook-list')
  const fragmentsBox = document.getElementById('yearbook-fragments')
  const status = document.getElementById('yearbook-status')
  if (!box || !fragmentsBox || !window.nagi.yearbook) return
  box.replaceChildren()
  fragmentsBox.replaceChildren()
  try {
    const result = await window.nagi.yearbook.list()
    if (!result.pages.length) box.textContent = '还没有年鉴页。到上方账本选择一段真实经历。'
    for (const page of result.pages) {
      const row = document.createElement('div')
      row.className = 'ledger-item'
      const title = document.createElement('strong')
      title.textContent = page.title
      const meta = document.createElement('div')
      meta.className = 'ledger-meta'
      meta.textContent = `经历 ID：${page.fact.id} · ${sourceNames[page.fact.source.type] || page.fact.source.type} · ${page.fact.occurredAt ? new Date(page.fact.occurredAt).toLocaleString() : '发生时间未记录'}`
      const fact = document.createElement('div')
      fact.className = 'ledger-text'
      fact.textContent = `【有来源的真实记录】${page.fact.text}`
      row.append(title, meta, fact)
      for (const note of page.subjective) {
        const diary = document.createElement('div')
        diary.className = 'ledger-text'
        diary.textContent = `【凪的主观记录 · ${note.id}】${note.text}`
        row.append(diary)
      }
      if (page.note) {
        const userNote = document.createElement('div')
        userNote.className = 'yearbook-note'
        userNote.textContent = `【用户编辑 / 创作】${page.note}`
        row.append(userNote)
      }
      const actions = document.createElement('div')
      actions.className = 'ledger-actions'
      const edit = document.createElement('button')
      edit.textContent = '编辑这页'
      edit.addEventListener('click', () => {
        if (row.querySelector('textarea')) return
        const titleInput = document.createElement('input')
        titleInput.className = 'yearbook-editor'
        titleInput.value = page.title
        titleInput.setAttribute('aria-label', '年鉴页标题')
        const noteInput = document.createElement('textarea')
        noteInput.className = 'yearbook-editor'
        noteInput.value = page.note
        noteInput.placeholder = '写下你的感想或创作；这里不会变成事实记忆'
        noteInput.setAttribute('aria-label', '用户编辑或创作文字')
        const save = document.createElement('button')
        save.textContent = '保存这页'
        save.addEventListener('click', async () => {
          const updated = await window.nagi.yearbook.edit(page.id, titleInput.value, noteInput.value)
          if (updated.ok) { status.textContent = '年鉴页已保存'; await refreshYearbook() }
          else status.textContent = updated.error || '保存失败'
        })
        row.append(titleInput, noteInput, save)
      })
      const remove = document.createElement('button')
      remove.textContent = '移出年鉴'
      remove.addEventListener('click', async () => {
        const removed = await window.nagi.yearbook.remove(page.id)
        if (removed.ok) { status.textContent = '已从年鉴移出，原经历仍在账本'; await refreshYearbook() }
        else status.textContent = removed.error || '移出失败'
      })
      actions.append(edit, remove)
      row.append(actions)
      box.append(row)
    }
    for (const fragment of result.fragments) {
      const row = document.createElement('div')
      row.className = 'ledger-item'
      row.textContent = fragment.unlocked
        ? `【创作设定 · ${fragment.title}】${fragment.text}（触发经历 ID：${fragment.triggerSourceId}）`
        : `身世碎片「${fragment.title}」：收入 ${fragment.neededPages} 段真实经历后可查看。`
      fragmentsBox.append(row)
    }
  } catch (err) {
    status.textContent = '年鉴读取失败：' + err.message
  }
}

async function refreshLedger(reset = true) {
  const box = document.getElementById('ledger-list')
  if (!box || !window.nagi.ledger) return
  const status = document.getElementById('ledger-status')
  if (reset) { ledgerOffset = 0; box.replaceChildren() }
  try {
    const result = await window.nagi.ledger.list({ offset: ledgerOffset, limit: LEDGER_PAGE })
    for (const entry of result.entries) {
      const row = document.createElement('div')
      row.className = 'ledger-item'
      const label = document.createElement('div')
      label.className = 'ledger-meta'
      label.textContent = `${tierNames[entry.tier] || entry.tier} · ${sourceNames[entry.source.type] || entry.source.type} · ${entry.occurredAt ? new Date(entry.occurredAt).toLocaleString() : '发生时间未记录'}`
      const body = document.createElement('div')
      body.className = 'ledger-text'
      body.textContent = entry.text
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = '查看来源'
      const source = document.createElement('div')
      source.textContent = `来源：${entry.source.type} / ${entry.source.ref}\n记录于：${new Date(entry.recordedAt).toLocaleString()}\n判断：${entry.certainty}`
      source.style.whiteSpace = 'pre-wrap'
      details.append(summary, source)
      const actions = document.createElement('div')
      actions.className = 'ledger-actions'
      const correct = document.createElement('button')
      correct.textContent = '纠正'
      correct.addEventListener('click', () => {
        if (row.querySelector('textarea')) return
        const editor = document.createElement('textarea')
        editor.value = entry.text
        editor.setAttribute('aria-label', '更正后的内容')
        const submit = document.createElement('button')
        submit.textContent = '提交更正'
        submit.addEventListener('click', async () => {
          const result = await window.nagi.ledger.correct(entry.id, editor.value)
          if (result.ok) { status.textContent = '更正已保存，旧内容已清理'; await refreshLedger(); await refreshYearbook() }
          else if (!result.cancelled) status.textContent = result.error || '更正失败'
        })
        row.append(editor, submit)
      })
      const forget = document.createElement('button')
      forget.textContent = '忘记'
      forget.className = 'danger'
      forget.addEventListener('click', async () => {
        const result = await window.nagi.ledger.forget(entry.id)
        if (result.ok) { status.textContent = '已忘记这条记录'; await refreshLedger(); await refreshYearbook() }
        else if (!result.cancelled) status.textContent = result.error || '忘记失败'
      })
      actions.append(correct, forget)
      if (entry.category === 'experience' && entry.tier === 'recorded') {
        const collect = document.createElement('button')
        collect.textContent = '收进年鉴'
        collect.addEventListener('click', async () => {
          const added = await window.nagi.yearbook.add(entry.id)
          const yearbookStatus = document.getElementById('yearbook-status')
          if (added.ok) { yearbookStatus.textContent = added.existing ? '这段经历已在年鉴里' : '已收进双人年鉴'; await refreshYearbook() }
          else yearbookStatus.textContent = added.error || '收录失败'
        })
        actions.append(collect)
      }
      row.append(label, body, details, actions)
      box.appendChild(row)
    }
    ledgerOffset += result.entries.length
    document.getElementById('btn-ledger-more')?.classList.toggle('hidden', ledgerOffset >= result.total)
    if (!result.total) status.textContent = '还没有可查看的共同经历。'
  } catch (err) {
    status.textContent = '账本读取失败：' + err.message
  }
}

async function refreshCompanionStatus() {
  const line = document.getElementById('companion-status')
  if (!line) return
  try {
    const result = await window.nagi.companion.status()
    const state = result.state
    const next = state.nextAllowedAt > Date.now()
      ? `；下次最早 ${new Date(state.nextAllowedAt).toLocaleTimeString()}` : ''
    line.textContent = `今天已主动搭话 ${state.deliveredToday}/${result.config.maxDaily} 次；连续被忽略 ${state.ignoredStreak} 次${next}`
  } catch (err) { line.textContent = '打扰预算读取失败：' + err.message }
}

async function refreshModels() {
  try {
    const list = await window.nagi.models.list()
    const sel = document.getElementById('set-model-path')
    if (!sel) return
    sel.innerHTML = ''
    if (!list.models.length) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = '（models/ 下暂无模型）'
      sel.appendChild(o)
      return
    }
    for (const m of list.models) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = m
      sel.appendChild(o)
    }
    sel.value = settings?.live2d?.modelPath || list.models[0]
  } catch {
    /* ignore */
  }
}

/* ---------------- 语音设置（设置页 · 语音区块） ---------------- */

/** 试听默认文本：用她的语气，方便判断「像不像她」 */
const VOICE_PREVIEW_TEXT = '我是凪。住在这里，仅此而已。'

/** 最近一次能力快照（引擎可用性 / 本机语音清单 / 离线模型状态） */
let voiceSnapshot = null
/** 试听用的 <audio>（同一时刻只留一个，切歌前先停旧的） */
let previewAudio = null

/** 引擎可用性的中文备注（挑不到时给个明确原因，而不是静默失败） */
function engineAvailNote(engine, available, extra = '') {
  if (available?.[engine] === false) {
    if (engine === 'cloud' || engine === 'gptsovits') return '（暂未接入）'
    return '（当前不可用）'
  }
  return extra
}

/** 填充「说话引擎」下拉 */
function fillTtsEngines(st, current) {
  const sel = document.getElementById('set-tts-engine')
  if (!sel) return
  sel.innerHTML = ''
  for (const [id, e] of Object.entries(TTS_ENGINES)) {
    const o = document.createElement('option')
    o.value = id
    const bad = st?.tts?.available?.[id] === false
    o.textContent = e.label + engineAvailNote(id, st?.tts?.available)
    // 未接入的引擎仍然列出来（让用户知道有这条路），但不可选
    if (bad && (id === 'cloud' || id === 'gptsovits')) o.disabled = true
    sel.appendChild(o)
  }
  sel.value = TTS_ENGINES[current] ? current : 'edge'
  fillTtsVoices(st)
}

/** 按当前引擎填充「音色」下拉 */
function fillTtsVoices(st) {
  const sel = document.getElementById('set-tts-voice')
  const engine = document.getElementById('set-tts-engine')?.value || 'edge'
  const note = document.getElementById('set-tts-engine-note')
  if (!sel) return

  const cfg = mergeVoiceSettings(settings?.voice)
  const picked = cfg.voiceByEngine?.[engine] || ''

  sel.innerHTML = ''
  if (engine === 'edge') {
    for (const v of EDGE_VOICES) {
      const o = document.createElement('option')
      o.value = v.id
      o.textContent = `${v.label}${v.note ? ' · ' + v.note : ''}`
      sel.appendChild(o)
    }
    sel.value = EDGE_VOICES.some((v) => v.id === picked) ? picked : EDGE_VOICES[0].id
  } else if (engine === 'sapi') {
    const list = st?.sapiVoices || []
    if (!list.length) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = '（没找到本机语音）'
      sel.appendChild(o)
    } else {
      for (const v of list) {
        const o = document.createElement('option')
        o.value = v.name || v.id || String(v)
        o.textContent = v.name || v.id || String(v)
        sel.appendChild(o)
      }
      sel.value = list.some((v) => (v.name || v.id) === picked) ? picked : (list[0].name || list[0].id)
    }
  } else {
    const o = document.createElement('option')
    o.value = ''
    o.textContent = '（用引擎默认音色）'
    sel.appendChild(o)
    sel.value = ''
  }

  const e = TTS_ENGINES[engine]
  if (note) {
    const reason = st?.tts?.engine !== engine && st?.tts?.available?.[engine] === false ? '当前会回退到可用引擎。' : ''
    if (engine === 'edge' && st?.tts?.edgeError) {
      note.textContent = `最近一次调用失败：${st.tts.edgeError}。失败会自动回退本机语音。`
    } else {
      note.textContent = (e?.note || '') + (reason ? ' ' + reason : '')
    }
  }
}

/** 填充「识别引擎」下拉 + 离线模型状态 */
function fillAsrEngine(st, current) {
  const sel = document.getElementById('set-asr-engine')
  if (!sel) return
  sel.innerHTML = ''
  for (const [id, e] of Object.entries(ASR_ENGINES)) {
    const o = document.createElement('option')
    o.value = id
    const note =
      id === 'sherpa'
        ? st?.asr?.available?.sherpa
          ? '（已装好，离线可用）'
          : '（未安装，装好后更准）'
        : engineAvailNote(id, st?.asr?.available)
    o.textContent = e.label + note
    if (id === 'cloud') o.disabled = true
    sel.appendChild(o)
  }
  sel.value = ASR_ENGINES[current] ? current : 'sapi'

  const noteEl = document.getElementById('set-asr-engine-note')
  if (noteEl) {
    const e = ASR_ENGINES[sel.value]
    const cfg = mergeVoiceSettings(settings?.voice)
    let extra = ''
    if (cfg.asrEngine !== sel.value && st?.asr?.engine && st.asr.engine !== sel.value) {
      extra = ` 保存后实际会用「${ASR_ENGINES[st.asr.engine]?.label || st.asr.engine}」。`
    }
    noteEl.textContent = (e?.note || '') + extra
  }

  const wrap = document.getElementById('set-asr-model-wrap')
  if (wrap) wrap.classList.toggle('hidden', sel.value !== 'sherpa')
  renderSherpaStatus(st?.sherpa)
}

/** 离线模型状态文字 */
function renderSherpaStatus(sh) {
  const el = document.getElementById('set-asr-model-status')
  const btn = document.getElementById('btn-asr-download')
  if (!el) return
  if (!sh) {
    el.textContent = '离线模型状态：未知'
    return
  }
  const server = sh.server?.running ? ` · 服务已常驻（端口 ${sh.server.port}）` : ''
  if (sh.ready) {
    el.textContent = `离线模型：已装好，可离线使用${server}`
  } else if (sh.cliPresent || sh.modelPresent) {
    el.textContent = `离线模型：不完整（${sh.error || '需要重新下载'}）`
  } else {
    el.textContent = '离线模型：未安装（不装也能用系统自带识别）'
  }
  if (btn) btn.disabled = !!sh.ready
}

/** 读一次语音能力快照并刷新整个区块 */
async function refreshVoice() {
  const sel = document.getElementById('set-tts-engine')
  if (!sel) return
  const cfg = mergeVoiceSettings(settings?.voice)

  let st = null
  try {
    st = await window.nagi.voice.status()
  } catch (err) {
    console.warn('[voice] 状态读取失败', err.message)
  }
  voiceSnapshot = st

  fillTtsEngines(st, cfg.ttsEngine)
  fillAsrEngine(st, cfg.asrEngine)

  const set = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.checked = v
  }
  set('set-voice-enabled', cfg.ttsEnabled)
  set('set-speak-reply', cfg.speakOnReply)
  set('set-speak-proactive', cfg.speakOnProactive)
  set('set-voice-profile', settings?.presence?.voiceProfileEnabled === true)
  set('set-lipsync', cfg.lipSync)

  const rate = document.getElementById('set-voice-rate')
  if (rate) rate.value = String(cfg.rate)
  document.getElementById('set-voice-rate-val').textContent = String(cfg.rate)
  const vol = document.getElementById('set-voice-volume')
  if (vol) vol.value = String(cfg.volume)
  document.getElementById('set-voice-volume-val').textContent = String(cfg.volume)

  const pt = document.getElementById('set-preview-text')
  if (pt && !pt.value) pt.value = VOICE_PREVIEW_TEXT
}

/** 试听当前（尚未保存的）引擎 / 音色 / 语速 */
async function previewVoice() {
  const btn = document.getElementById('btn-tts-preview')
  const out = document.getElementById('voice-preview-result')
  const text = (document.getElementById('set-preview-text')?.value || '').trim() || VOICE_PREVIEW_TEXT
  const engine = document.getElementById('set-tts-engine')?.value

  if (out) out.textContent = '合成中…'
  btn?.classList.add('playing')
  try {
    const r = await window.nagi.voice.preview({
      text,
      engine,
      voice: document.getElementById('set-tts-voice')?.value || '',
      rate: Number(document.getElementById('set-voice-rate')?.value) || 0,
      volume: Number(document.getElementById('set-voice-volume')?.value ?? 100)
    })
    if (!r || !r.ok) {
      if (out) out.textContent = '试听失败：' + (r?.error || '未知原因')
      return
    }
    if (out) out.textContent = `正在播放（${r.engine || engine}）…`
    await playPreviewBytes(r.bytes, r.format)
    if (out) out.textContent = '试听结束。满意就保存设置。'
  } catch (err) {
    if (out) out.textContent = '试听失败：' + err.message
  } finally {
    btn?.classList.remove('playing')
  }
}

/** 放一段试听音频（同时驱动口型，方便一起看效果） */
function playPreviewBytes(bytes, format) {
  return new Promise((resolve) => {
    try {
      if (previewAudio) {
        previewAudio.pause()
        previewAudio = null
      }
      const blob = new Blob([bytes], { type: format || 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const a = new Audio(url)
      previewAudio = a
      const done = () => {
        URL.revokeObjectURL(url)
        if (previewAudio === a) previewAudio = null
        resolve()
      }
      a.onended = done
      a.onerror = done
      a.play().catch(done)
    } catch {
      resolve()
    }
  })
}

function wireVoiceSettings(on) {
  const rate = document.getElementById('set-voice-rate')
  rate?.addEventListener('input', () => {
    document.getElementById('set-voice-rate-val').textContent = String(Number(rate.value))
  })
  const vol = document.getElementById('set-voice-volume')
  vol?.addEventListener('input', () => {
    document.getElementById('set-voice-volume-val').textContent = String(Number(vol.value))
  })

  // 换引擎 → 音色下拉跟着换数据源
  document.getElementById('set-tts-engine')?.addEventListener('change', () => fillTtsVoices(voiceSnapshot))
  document.getElementById('set-asr-engine')?.addEventListener('change', () => fillAsrEngine(voiceSnapshot, document.getElementById('set-asr-engine').value))

  on('btn-tts-preview', previewVoice)

  on('btn-save-voice', async () => {
    const engine = document.getElementById('set-tts-engine').value
    const voice = document.getElementById('set-tts-voice').value
    await window.nagi.settings.set({
      voice: {
        ttsEnabled: document.getElementById('set-voice-enabled').checked,
        ttsEngine: engine,
        // 每个引擎各自记音色：切来切去不会互相覆盖
        voiceByEngine: voice ? { [engine]: voice } : {},
        rate: Number(document.getElementById('set-voice-rate').value) || 0,
        volume: Number(document.getElementById('set-voice-volume').value ?? 100),
        speakOnReply: document.getElementById('set-speak-reply').checked,
        speakOnProactive: document.getElementById('set-speak-proactive').checked,
        lipSync: document.getElementById('set-lipsync').checked,
        asrEngine: document.getElementById('set-asr-engine').value
      },
      presence: {
        // 只写这一个键：deepMerge 保留其余 presence 配置
        voiceProfileEnabled: document.getElementById('set-voice-profile').checked
      }
    })
    settings = await window.nagi.settings.get()
    ui.addToolLog('语音设置已保存')
    refreshVoice()
  })

  on('btn-asr-download', async () => {
    const btn = document.getElementById('btn-asr-download')
    const out = document.getElementById('set-asr-model-status')
    if (btn) btn.disabled = true
    if (out) out.textContent = '正在下载离线识别（约 98MB，首次较慢）…'
    document.getElementById('asr-progress')?.classList.remove('hidden')
    let failMsg = ''
    try {
      const r = await window.nagi.voice.downloadModel()
      if (!r || !r.ok) failMsg = '离线识别安装失败：' + (r?.error || '未知原因')
    } catch (err) {
      failMsg = '离线识别安装失败：' + (err && err.message ? err.message : String(err))
    } finally {
      document.getElementById('asr-progress')?.classList.add('hidden')
      await refreshVoice()
      // 失败原因要留在状态行上：refreshVoice() 会把这里刷回「未安装」，
      // 只写工具日志的话用户看到的就是「点完什么都没发生」（2026-10-16）。
      if (failMsg) {
        if (out) out.textContent = failMsg
        ui.addToolLog(failMsg)
      } else {
        ui.addToolLog('离线识别已装好，之后完全离线可用')
      }
      if (btn) btn.disabled = false
    }
  })

  on('btn-asr-server-stop', async () => {
    const r = await window.nagi.voice.stopServer()
    ui.addToolLog(r?.stopped ? '已停掉离线识别服务，内存已释放' : '离线识别服务本来就没在跑')
    await refreshVoice()
  })

  // 下载进度（主进程广播）：只在设置页显示，不弹窗打断
  window.nagi.on(VOICE_EVT.PROGRESS, (p) => {
    if (!p || p.kind !== 'download') return
    const wrap = document.getElementById('asr-progress')
    const bar = document.getElementById('asr-progress-bar')
    const out = document.getElementById('set-asr-model-status')
    if (!wrap || !bar) return
    if (p.done) {
      bar.style.width = '100%'
      if (out) out.textContent = p.ok ? '下载完成，正在校验…' : '下载失败：' + (p.error || '未知原因')
      return
    }
    wrap.classList.remove('hidden')
    const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0
    bar.style.width = pct + '%'
    if (out) {
      // 解压没有百分比，只换文案 —— 否则会显示成「正在下载识别程序 · 100%」卡住不动
      if (p.stage === 'extract') {
        out.textContent = '正在解压识别程序…'
      } else {
        const what = p.stage === 'cli' || (!p.file && !p.stage) ? '识别程序' : '识别模型'
        out.textContent = `正在下载${what} · ${pct}%`
      }
    }
    const btn = document.getElementById('btn-asr-download')
    if (btn) btn.disabled = true
  })
}

/* ---------------- 实感 · 时间感设置（BLUE-2） ---------------- */

// 时段表编辑器：周期序列固定 夜→早→午→午后→晚→夜，6 段连续覆盖只需 5 个边界，
// 天然无缺口；core presenceConfig 对非法表整体回退默认，UI 先拦一道。
const SCHED_LABELS = ['夜结束于', '早结束于', '午结束于', '午后结束于', '晚结束于']
const SCHED_ORDER = ['night', 'morning', 'noon', 'afternoon', 'evening', 'night']

/** 分钟 → "HH:MM"（time 输入框用） */
function fmtMin(min) {
  const m = ((Math.floor(Number(min)) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "HH:MM" → 分钟；非法返回 NaN */
function parseHm(text) {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(text ?? '').trim())
  if (!m) return NaN
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return NaN
  return h * 60 + mm
}

/** 当前表能否被 5 边界编辑器忠实表示（标准六段表且顺序符合周期序列） */
function schedEditable(schedule) {
  return Array.isArray(schedule) && schedule.length === 6 &&
    schedule.every((row, i) => Array.isArray(row) && row[2] === SCHED_ORDER[i])
}

function renderSchedEditor(id, schedule) {
  const box = document.getElementById(id)
  if (!box) return
  box.textContent = ''
  if (!schedEditable(schedule)) {
    const note = document.createElement('p')
    note.className = 'dim'
    note.style.margin = '0'
    note.textContent = Array.isArray(schedule)
      ? `当前是自定义多段时段表（${schedule.length} 段）。本编辑器只支持标准六段表，保存时将保留这张原值不动。`
      : '时段表不可读，保存时将保留原值不动。'
    box.appendChild(note)
    return
  }
  for (let i = 0; i < 5; i++) {
    const label = document.createElement('label')
    label.textContent = `${SCHED_LABELS[i]} `
    const input = document.createElement('input')
    input.type = 'time'
    input.step = '60'
    input.value = fmtMin(schedule[i][1])
    label.appendChild(input)
    box.appendChild(label)
  }
}

/** 读编辑器 → 标准六段表；不可编辑（自定义表）或边界非法返回 null */
function readSchedEditor(id) {
  const box = document.getElementById(id)
  if (!box) return null
  const inputs = [...box.querySelectorAll('input[type="time"]')]
  if (inputs.length !== 5) return null // 自定义多段表：保留原值
  const bounds = inputs.map((el) => parseHm(el.value))
  if (bounds.some((b) => !Number.isFinite(b))) return null
  // 边界必须严格递增且都落在 (0,1440)：首段「夜」从 00:00 起，末段「晚」回到 24:00
  if (bounds.some((b, i) => b <= 0 || b >= 1440 || (i > 0 && b <= bounds[i - 1]))) return null
  return [
    [0, bounds[0], 'night'], [bounds[0], bounds[1], 'morning'], [bounds[1], bounds[2], 'noon'],
    [bounds[2], bounds[3], 'afternoon'], [bounds[3], bounds[4], 'evening'], [bounds[4], 1440, 'night']
  ]
}

/** 把当前生效设置回显到「陪伴 · 时间感」区块（同步函数，fillSettingsForm 调用） */
function refreshPresenceSection() {
  const cfg = presenceConfig(settings?.presence)
  const set = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.checked = v
  }
  set('set-presence-enabled', cfg.enabled)
  set('set-presence-rhythm', cfg.rhythmEnabled)
  set('set-presence-away', cfg.awayEnabled)
  set('set-presence-reunion', cfg.reunionEnabled)
  set('set-presence-persist', cfg.persistActivities)
  // 「她留下的东西」（BLUE-3）：三个业务开关默认全关
  set('set-notes-enabled', cfg.notesEnabled)
  set('set-traces-enabled', cfg.tracesEnabled)
  set('set-anchors-enabled', cfg.anchorsEnabled)
  // 「陪伴 · 可选表达」（BLUE-4）：默认全关，概率默认 0
  const imp = cfg.imperfection || {}
  set('set-imperf-enabled', imp.enabled === true)
  set('set-imperf-low', imp.lowPressureEnabled === true)
  set('set-imperf-repair', imp.repairEnabled === true)
  const prob = document.getElementById('set-imperf-prob')
  if (prob) prob.value = String(Math.max(0, Math.min(10, Math.round((Number(imp.forgetProbability) || 0) * 100))))

  const num = (id, minutes) => {
    const el = document.getElementById(id)
    if (el) el.value = String(Math.round(minutes))
  }
  num('set-presence-idle', cfg.idleAfterMs / 60000)
  num('set-presence-slice', cfg.activitySliceMs / 60000)
  num('set-presence-reunion-min', cfg.reunionMinMs / 60000)
  num('set-presence-reunion-long', cfg.reunionLongMs / 60000)
  num('set-presence-reunion-hours', cfg.reunionHoursMs / 60000)
  num('set-presence-cooldown', cfg.reunionCooldownMs / 60000)
  num('set-presence-daily', cfg.dailyReunionLimit)
  num('set-presence-retain', cfg.retainDays)
  num('set-presence-maxacts', cfg.maxActivities)

  renderSchedEditor('presence-sched-weekday', cfg.weekdaySchedule)
  renderSchedEditor('presence-sched-weekend', cfg.weekendSchedule)
  const st = document.getElementById('presence-sched-status')
  if (st) {
    const bounds = (rows) => rows.slice(0, 5).map((r) => fmtMin(r[1])).join(' / ')
    st.textContent = `当前生效（各段结束时间）：工作日 ${bounds(cfg.weekdaySchedule)} · 周末 ${bounds(cfg.weekendSchedule)}`
  }
}

function wirePresenceSettings(on) {
  // 读数值输入：夹在 [min,max]；空/非法 → 用当前生效值（等于「没改」）
  const numField = (id, min, max, current) => {
    const v = Number(document.getElementById(id)?.value)
    if (!Number.isFinite(v)) return current
    return Math.max(min, Math.min(max, Math.floor(v)))
  }

  on('btn-save-presence', async () => {
    const status = document.getElementById('presence-status')
    const cfg = presenceConfig(settings?.presence)
    const minMs = numField('set-presence-reunion-min', 5, 30, cfg.reunionMinMs / 60000) * 60000
    const longMs = numField('set-presence-reunion-long', 30, 90, cfg.reunionLongMs / 60000) * 60000
    const hoursMs = numField('set-presence-reunion-hours', 90, 1440, cfg.reunionHoursMs / 60000) * 60000
    if (!(minMs < longMs && longMs < hoursMs)) {
      if (status) status.textContent = '离开阈值必须从小到大（「一会儿」小于「很久」），已中止保存'
      return
    }

    // 时段表：渲染了编辑器却读不出合法表 = 用户填的边界非法 → 拦下并说明；
    // 没渲染（自定义多段表）才走「不写这个键，deepMerge 保留原值」。
    const schedStatus = document.getElementById('presence-sched-status')
    const readSched = (id) => {
      const rendered = !!document.getElementById(id)?.querySelector('input[type="time"]')
      const table = readSchedEditor(id)
      return { invalid: !table && rendered, table }
    }
    const wd = readSched('presence-sched-weekday')
    const we = readSched('presence-sched-weekend')
    if (wd.invalid || we.invalid) {
      if (schedStatus) schedStatus.textContent = '时段表边界不合法（各段结束时间需依次递增，且在 00:01–23:59 之间），已中止保存'
      return
    }
    if (wd.table && we.table) {
      const merged = presenceConfig({ weekdaySchedule: wd.table, weekendSchedule: we.table })
      if (JSON.stringify(merged.weekdaySchedule) !== JSON.stringify(wd.table) ||
          JSON.stringify(merged.weekendSchedule) !== JSON.stringify(we.table)) {
        if (schedStatus) schedStatus.textContent = '时段表没有通过校验，已中止保存（边界需递增且在 00:01–23:59 之间）'
        return
      }
    }
    const weekday = wd.table
    const weekend = we.table

    const patch = {
      enabled: document.getElementById('set-presence-enabled').checked,
      rhythmEnabled: document.getElementById('set-presence-rhythm').checked,
      awayEnabled: document.getElementById('set-presence-away').checked,
      reunionEnabled: document.getElementById('set-presence-reunion').checked,
      idleAfterMs: numField('set-presence-idle', 2, 60, cfg.idleAfterMs / 60000) * 60000,
      activitySliceMs: numField('set-presence-slice', 5, 60, cfg.activitySliceMs / 60000) * 60000,
      reunionMinMs: minMs,
      reunionLongMs: longMs,
      reunionHoursMs: hoursMs,
      reunionCooldownMs: numField('set-presence-cooldown', 30, 1440, cfg.reunionCooldownMs / 60000) * 60000,
      dailyReunionLimit: numField('set-presence-daily', 0, 3, cfg.dailyReunionLimit)
    }
    if (weekday) patch.weekdaySchedule = weekday
    if (weekend) patch.weekendSchedule = weekend
    try {
      await window.nagi.settings.set({ presence: patch })
      settings = await window.nagi.settings.get()
    } catch (err) {
      if (status) status.textContent = '保存失败：' + err.message
      return
    }
    refreshPresenceSection()
    if (status) status.textContent = '已保存，即时生效'
    ui.addToolLog('时间感设置已保存')
  })

  on('btn-save-presence-privacy', async () => {
    const status = document.getElementById('presence-status')
    const cfg = presenceConfig(settings?.presence)
    try {
      await window.nagi.settings.set({
        presence: {
          persistActivities: document.getElementById('set-presence-persist').checked,
          retainDays: numField('set-presence-retain', 1, 7, cfg.retainDays),
          maxActivities: numField('set-presence-maxacts', 1, 96, cfg.maxActivities)
        }
      })
      settings = await window.nagi.settings.get()
    } catch (err) {
      if (status) status.textContent = '保存失败：' + err.message
      return
    }
    refreshPresenceSection()
    if (status) status.textContent = '隐私设置已保存，即时生效'
    ui.addToolLog('时间感隐私设置已保存')
  })

  // 「她留下的东西」（BLUE-3）：三个业务开关一起写；关掉全部时主进程会连文件一起清掉
  on('btn-save-notes', async () => {
    const status = document.getElementById('notes-status')
    const notesEnabled = document.getElementById('set-notes-enabled').checked
    const tracesEnabled = document.getElementById('set-traces-enabled').checked
    const anchorsEnabled = document.getElementById('set-anchors-enabled').checked
    try {
      await window.nagi.settings.set({ presence: { notesEnabled, tracesEnabled, anchorsEnabled } })
      settings = await window.nagi.settings.get()
      // 让主进程立刻同步一次开关状态（关掉即清内存与文件）
      await window.nagi.notes.list()
    } catch (err) {
      if (status) status.textContent = '保存失败：' + err.message
      return
    }
    refreshPresenceSection()
    if (status) {
      status.textContent = notesEnabled || tracesEnabled || anchorsEnabled
        ? '已保存：从现在开始记。点「现在看看」查看。'
        : '已关闭：已保存的内容已清空，文件也删掉了。'
    }
    ui.addToolLog('「她留下的东西」设置已保存')
  })
  on('btn-open-notes-from-settings', () => {
    closeSettings()
    toggleNotesPanel()
  })

  // 「陪伴 · 可选表达」（BLUE-4）：概率按 0–10% 存成 0–0.1
  on('btn-save-imperf', async () => {
    const status = document.getElementById('imperf-status')
    const raw = Number(document.getElementById('set-imperf-prob').value)
    const pct = Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : 0
    const enabled = document.getElementById('set-imperf-enabled').checked
    try {
      await window.nagi.settings.set({
        presence: {
          imperfection: {
            enabled,
            // 总开关关着时概率归零：不会出现「关了还偶尔延迟」的错觉
            forgetProbability: enabled ? pct / 100 : 0,
            lowPressureEnabled: document.getElementById('set-imperf-low').checked,
            repairEnabled: document.getElementById('set-imperf-repair').checked
          }
        }
      })
      settings = await window.nagi.settings.get()
    } catch (err) {
      if (status) status.textContent = '保存失败：' + err.message
      return
    }
    refreshPresenceSection()
    if (status) {
      status.textContent = enabled
        ? `已保存：可选表达延迟概率 ${pct}%，每天最多 1 次；重要事项不受影响。`
        : '已关闭：所有可选表达照常说，重要事项本来就不受影响。'
    }
    ui.addToolLog('可选表达设置已保存')
  })
}

/* ---------------- 记忆档案设置（设置页 · 记忆档案区块） ---------------- */

/** 最近一次档案状态快照 */
let ragSnapshot = null

const RAG_PROVIDER_NOTE = {
  local: '全部在你电脑上算，不联网、不外发。首次需要下载一个约 25MB 的小模型。',
  openai: '复用「大脑」里填的 Key。注意：要送去做向量的文字会发到对方服务器，介意的话用本机模型。',
  none: '照样记录，但不会自动想起往事（等于关掉检索）。'
}

/** 档案状态文字：条数 / 待嵌 / 磁盘 / 引擎 */
function renderRagStatus(st) {
  const el = document.getElementById('rag-status')
  if (!el) return
  if (!st) {
    el.textContent = '档案状态：读取中…'
    return
  }
  if (!st.ready) {
    const why = st.dimMismatch
      ? '索引维度与当前引擎不符，点「重建索引」即可（原文都还在）'
      : st.provider === 'openai'
        ? '云端检索未就绪：需要配置大脑的 API Key'
        : '本机模型没装好，装完就自动开始工作（对话照常，只是暂时想不起往事）'
    el.textContent = `档案：未就绪 —— ${why}`
    return
  }
  const mb = st.disk ? (st.disk / 1024 / 1024).toFixed(1) + ' MB' : '0 MB'
  const pend = st.pending ? ` · 待嵌入 ${st.pending}` : ''
  el.textContent = `档案：${st.chunks} 条（${st.engine === 'local' ? '本机' : '云端'}引擎，${st.dim} 维）${pend} · 占 ${mb}`
}

/** 本机嵌入模型状态文字 */
function renderRagModel(st) {
  const el = document.getElementById('set-rag-model-status')
  const btn = document.getElementById('btn-rag-download')
  if (!el) return
  const m = st?.model
  if (!m) {
    el.textContent = '本机模型状态：未知'
    return
  }
  el.textContent = m.ready
    ? '本机模型：已装好，离线可用'
    : `本机模型：未安装${m.error ? '（' + m.error + '）' : ''}`
  if (btn) btn.disabled = !!m.ready
}

/** 读一次档案状态并刷新整个区块 */
async function refreshRag() {
  const sel = document.getElementById('set-rag-provider')
  if (!sel || !window.nagi.rag) return
  const cfg = mergeRagSettings(settings?.rag)

  let st = null
  try {
    st = await window.nagi.rag.status()
  } catch (err) {
    console.warn('[rag] 状态读取失败', err.message)
  }
  ragSnapshot = st

  const set = (id, v) => {
    const el = document.getElementById(id)
    if (el) el.checked = v
  }
  set('set-rag-enabled', cfg.enabled)
  set('set-rag-autosummary', cfg.autoSummary)
  sel.value = cfg.provider

  const note = document.getElementById('set-rag-provider-note')
  if (note) note.textContent = RAG_PROVIDER_NOTE[cfg.provider] || ''
  // 只有本机模式才需要看到「下载模型」那一块
  document.getElementById('set-rag-model-wrap')?.classList.toggle('hidden', cfg.provider !== 'local')

  const th = document.getElementById('set-rag-threshold')
  if (th) th.value = String(cfg.threshold)
  setText('set-rag-threshold-val', cfg.threshold.toFixed(2))
  const hl = document.getElementById('set-rag-halflife')
  if (hl) hl.value = String(cfg.halfLifeDays)
  setText('set-rag-halflife-val', cfg.halfLifeDays + ' 天')
  const se = document.getElementById('set-rag-summary-every')
  if (se) se.value = String(cfg.summaryEveryTurns)

  renderRagModel(st)
  renderRagStatus(st)
}

function wireRagSettings(on) {
  const th = document.getElementById('set-rag-threshold')
  th?.addEventListener('input', () => {
    setText('set-rag-threshold-val', Number(th.value).toFixed(2))
  })
  const hl = document.getElementById('set-rag-halflife')
  hl?.addEventListener('input', () => {
    setText('set-rag-halflife-val', Number(hl.value) + ' 天')
  })
  document.getElementById('set-rag-provider')?.addEventListener('change', () => {
    const v = document.getElementById('set-rag-provider').value
    const note = document.getElementById('set-rag-provider-note')
    if (note) note.textContent = RAG_PROVIDER_NOTE[v] || ''
    document.getElementById('set-rag-model-wrap')?.classList.toggle('hidden', v !== 'local')
  })

  on('btn-save-rag', async () => {
    await window.nagi.settings.set({
      rag: {
        enabled: document.getElementById('set-rag-enabled').checked,
        provider: document.getElementById('set-rag-provider').value,
        autoSummary: document.getElementById('set-rag-autosummary').checked,
        summaryEveryTurns: Number(document.getElementById('set-rag-summary-every').value) || 20,
        threshold: Number(document.getElementById('set-rag-threshold').value),
        halfLifeDays: Number(document.getElementById('set-rag-halflife').value)
      }
    })
    settings = await window.nagi.settings.get()
    ui.addToolLog('记忆设置已保存')
    await refreshRag()
  })

  on('btn-rag-download', async () => {
    const btn = document.getElementById('btn-rag-download')
    const out = document.getElementById('set-rag-model-status')
    if (btn) btn.disabled = true
    if (out) out.textContent = '正在下载本机模型（约 25MB）…'
    document.getElementById('rag-progress')?.classList.remove('hidden')
    try {
      const r = await window.nagi.rag.downloadModel()
      ui.addToolLog(r?.ok ? '本机检索模型已装好，之后完全离线可用' : '模型安装失败：' + (r?.error || '未知原因'))
    } catch (err) {
      ui.addToolLog('模型安装失败：' + err.message)
    } finally {
      document.getElementById('rag-progress')?.classList.add('hidden')
      await refreshRag()
    }
  })

  on('btn-rag-rebuild', async () => {
    const btn = document.getElementById('btn-rag-rebuild')
    if (btn) btn.disabled = true
    try {
      const r = await window.nagi.rag.rebuild()
      ui.addToolLog(r?.ok ? `索引重建中：${r.count} 条正在重新嵌入` : '重建失败：' + (r?.error || '未知原因'))
    } catch (err) {
      ui.addToolLog('重建失败：' + err.message)
    } finally {
      if (btn) btn.disabled = false
      await refreshRag()
    }
  })

  on('btn-rag-clear', async () => {
    // 档案是她跟你之间发生过的一切，删了就真没了——多确认一次
    if (!window.confirm('清空她的记忆档案？所有对话档案都会被删除，且无法恢复。')) return
    const r = await window.nagi.rag.clear()
    ui.addToolLog(r?.ok ? '记忆档案已清空' : '清空失败：' + (r?.error || '未知原因'))
    await refreshRag()
  })

  on('btn-rag-test', async () => {
    const out = document.getElementById('rag-test-result')
    const q = (document.getElementById('rag-query')?.value || '').trim()
    if (!q) {
      if (out) out.textContent = '先写一句话，比如「我最近睡得怎么样」'
      return
    }
    if (out) out.textContent = '检索中…'
    try {
      const r = await window.nagi.rag.recallTest(q)
      if (!out) return
      if (!r.ok) {
        out.textContent = '没检索到：' + (r.reason || '档案里还没有能匹配的内容')
        return
      }
      out.textContent = r.count ? r.text || r.results.map((x) => `· ${x.label}（${x.sim}）`).join('\n') : '档案里还没有能匹配的内容'
    } catch (err) {
      if (out) out.textContent = '检索失败：' + err.message
    }
  })

  // 下载进度（主进程广播）：只在设置页显示
  window.nagi.on(RAG_EVT.PROGRESS, (p) => {
    if (!p || p.kind !== 'download') return
    const wrap = document.getElementById('rag-progress')
    const bar = document.getElementById('rag-progress-bar')
    const out = document.getElementById('set-rag-model-status')
    if (!wrap || !bar) return
    if (p.done) {
      bar.style.width = '100%'
      if (out) out.textContent = p.ok ? '下载完成，正在校验…' : '下载失败：' + (p.error || '未知原因')
      return
    }
    wrap.classList.remove('hidden')
    const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0
    bar.style.width = pct + '%'
    if (out) {
      const what = p.file && p.file.includes('tokenizer') ? '分词器' : '检索模型'
      out.textContent = `正在下载${what} · ${pct}%`
    }
    const btn = document.getElementById('btn-rag-download')
    if (btn) btn.disabled = true
  })
}

function wireSettingsPage() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn)

  on('btn-calendar-import', async () => {
    const result = await window.nagi.calendar.import()
    if (!result.ok && !result.canceled) document.getElementById('calendar-status').textContent = `导入失败：${result.error}`
    else await refreshCalendarStatus()
  })
  on('btn-calendar-revoke', async () => {
    await window.nagi.calendar.revoke()
    await refreshCalendarStatus()
  })
  on('btn-music-enable', async () => {
    const state = await window.nagi.music.enable()
    if (state.error) document.getElementById('music-status').textContent = `已授权；读取失败：${state.error}`
    else await refreshMusicStatus()
  })
  on('btn-music-refresh', refreshMusicStatus)
  on('btn-music-revoke', async () => {
    await window.nagi.music.revoke()
    await refreshMusicStatus()
  })
  on('btn-geo-enable', async () => {
    const state = await window.nagi.geo.enable()
    if (state.error) document.getElementById('geo-status').textContent = `已授权；读取失败：${state.error}`
    else await refreshGeoStatus()
  })
  on('btn-geo-refresh', refreshGeoStatus)
  on('btn-geo-revoke', async () => {
    await window.nagi.geo.revoke()
    await refreshGeoStatus()
  })
  on('btn-ha-read-enable', async () => {
    await window.nagi.ha.enableRead()
    await refreshHaStatus()
  })
  on('btn-ha-control-enable', async () => {
    const result = await window.nagi.ha.enableControl()
    if (!result.ok && !result.canceled) document.getElementById('ha-result').textContent = result.error || '授权失败'
    await refreshHaStatus()
  })
  on('btn-ha-control-revoke', async () => {
    await window.nagi.ha.revokeControl()
    await refreshHaStatus()
  })
  on('btn-ha-signal-revoke', async () => {
    await window.nagi.ha.revokeSignal()
    await refreshHaStatus()
    await refreshSecretStatus()
    document.getElementById('ha-list').textContent = ''
  })

  on('btn-save-llm', async () => {
    const provider = document.getElementById('set-provider').value
    const profile = readLlmForm()
    const baseURL = profile.baseURL
    if (provider === 'ollama' && !ollamaTagsUrl(baseURL)) {
      document.getElementById('set-local-llm-status').textContent = 'Ollama 地址必须是本机 http://localhost:端口/v1'
      return
    }
    await window.nagi.settings.set({
      llm: {
        provider,
        ...profile
      }
    })
    llmDraftProfiles[provider] = profile
    settings = await window.nagi.settings.get()
    ui.setBrain(brainLabel())
    ui.addToolLog('大脑设置已保存')
    if (provider === 'ollama') void refreshLocalLlmStatus()
  })

  on('btn-check-local-llm', refreshLocalLlmStatus)
  document.getElementById('set-local-model-list')?.addEventListener('change', (event) => {
    if (!event.target.value) return
    document.getElementById('set-model').value = event.target.value
    void refreshLocalLlmStatus()
  })

  on('btn-save-key', async () => {
    const v = document.getElementById('set-apikey').value.trim()
    if (!v) return ui.addToolLog('API Key 为空，未保存')
    await window.nagi.secrets.set(SECRET_KEYS.LLM_API_KEY, v)
    document.getElementById('set-apikey').value = ''
    await refreshSecretStatus()
    ui.addToolLog('API Key 已加密保存')
  })

  on('btn-del-key', async () => {
    await window.nagi.secrets.remove(SECRET_KEYS.LLM_API_KEY)
    await refreshSecretStatus()
    ui.addToolLog('API Key 已删除')
  })

  // 桌宠大小滑杆：拖动即改窗口（等比 2:3），主进程负责落盘
  const sizeEl = document.getElementById('set-pet-size')
  sizeEl?.addEventListener('input', () => {
    const w = Number(sizeEl.value)
    const label = document.getElementById('set-pet-size-val')
    if (label) label.textContent = `${w} × ${Math.round(w * 1.5)}`
    window.nagi.win.resize({ width: w, height: Math.round(w * 1.5) })
  })
  sizeEl?.addEventListener('change', async () => {
    settings = await window.nagi.settings.get()
  })

  on('btn-refresh-models', refreshModels)
  on('btn-save-l2d', async () => {
    await window.nagi.settings.set({
      live2d: {
        modelPath: document.getElementById('set-model-path').value,
        scale: Number(document.getElementById('set-l2d-scale').value) || 1,
        idleBoost: document.getElementById('set-idle-boost')?.checked !== false
      }
    })
    settings = await window.nagi.settings.get()
    if (l2dReady) l2d.setScale(settings?.live2d?.scale || 1)
    ui.addToolLog('Live2D 设置已保存')
  })

  // 记忆
  on('btn-memory-add', async () => {
    const input = document.getElementById('memory-new')
    const v = input?.value.trim()
    if (!v) return
    await window.nagi.memory.add(v)
    if (input) input.value = ''
    await refreshMemory()
    await refreshLedger()
  })
  on('btn-ledger-more', () => refreshLedger(false))
  on('btn-ledger-export', async () => {
    const result = await window.nagi.ledger.export()
    const status = document.getElementById('ledger-status')
    if (result.ok) status.textContent = `已导出 ${result.count} 条到 ${result.path}`
    else if (!result.cancelled) status.textContent = result.error || '导出失败'
  })
  on('btn-yearbook-export', async () => {
    const status = document.getElementById('yearbook-status')
    try {
      const result = await window.nagi.yearbook.export()
      if (result.ok) status.textContent = `已导出 ${result.count} 页到 ${result.path}`
      else if (!result.cancelled) status.textContent = result.error || '导出失败'
    } catch (err) { status.textContent = '导出失败：' + err.message }
  })
  on('btn-history-clear', async () => {
    await window.nagi.memory.clearHistory()
    ui.addToolLog('对话历史已清空（长期记忆保留）')
  })

  on('btn-pick-fileroot', async () => {
    const result = await window.nagi.tools.pickFileRoot()
    if (!result?.ok) return
    document.getElementById('set-fileroot').value = result.fileRoot
    settings = await window.nagi.settings.get()
    ui.addToolLog(`已授权文件目录：${result.fileRoot}`)
  })
  on('btn-revoke-fileroot', async () => {
    await window.nagi.tools.revokeFileRoot()
    document.getElementById('set-fileroot').value = ''
    settings = await window.nagi.settings.get()
    ui.addToolLog('已撤销文件目录授权')
  })
  on('btn-save-tools', async () => {
    await window.nagi.settings.set({
      tools: {
        cdpPort: Number(document.getElementById('set-cdp').value) || 9222
      }
    })
    settings = await window.nagi.settings.get()
    ui.addToolLog('工具设置已保存')
  })

  // 活动监测：开关 / 勿扰 / 黑名单
  on('btn-save-monitor', async () => {
    const blacklist = (document.getElementById('set-blacklist')?.value || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    await window.nagi.settings.set({
      privacy: {
        monitorEnabled: document.getElementById('set-monitor').checked,
        doNotDisturb: document.getElementById('set-dnd').checked,
        onlyPresence: document.getElementById('set-only-presence').checked,
        blacklist
      },
      companion: {
        maxDaily: Number(document.getElementById('set-companion-max').value),
        minGapMinutes: Number(document.getElementById('set-companion-gap').value)
      }
    })
    settings = await window.nagi.settings.get()
    await refreshCompanionStatus()
    ui.addToolLog('陪伴与监测设置已保存')
  })

  on('btn-save-ha', async () => {
    await window.nagi.settings.set({
      homeassistant: {
        baseURL: document.getElementById('set-ha-url').value.trim(),
        enabled: true
      }
    })
    const token = document.getElementById('set-ha-token').value.trim()
    if (token) {
      await window.nagi.secrets.set(SECRET_KEYS.HA_TOKEN, token)
      document.getElementById('set-ha-token').value = ''
    }
    settings = await window.nagi.settings.get()
    await refreshSecretStatus()
    ui.addToolLog('HA 设置已保存')
  })
  on('btn-test-ha', async () => {
    const r = await window.nagi.ha.test()
    document.getElementById('ha-result').textContent = r.ok ? '连接成功' : '失败：' + r.error
  })
  on('btn-ha-list', async () => {
    const box = document.getElementById('ha-list')
    box.textContent = '查询中…'
    const r = await window.nagi.ha.list()
    if (!r.ok) {
      box.textContent = '失败：' + r.error
      return
    }
    box.textContent = (r.entities || [])
      .map((e) => `${e.entity_id}  ${e.name} = ${e.state}${e.unit || ''}`)
      .join('\n')
  })

  // 语音（M5）：引擎 / 音色 / 语速音量 / 自动开口 / 离线识别
  wireVoiceSettings(on)
  // 记忆档案（长期记忆检索）：开关 / 引擎 / 门限 / 重建 / 召回自测
  wireRagSettings(on)
  // 实感 · 时间感（BLUE-2）：开关 / 高级阈值 / 时段表 / 隐私
  wirePresenceSettings(on)
}

/* ---------------- 关系页（S4：熟悉度 + 情绪时间线） ---------------- */

/** 情绪 → 颜色。暗色主题下都要看得清，所以避开高饱和荧光色；平静色也不能太暗，
 *  否则在深色底上与轨道背景糊在一起（周视图的柱子会像没数据）。 */
const MOOD_COLORS = {
  calm: '#5f6884',
  smile: '#5fa8a0',
  joy: '#d9a63c',
  worry: '#8f6fc4',
  pout: '#c8564f',
  puzzled: '#4b93b8'
}
const MOOD_LABELS = { calm: '平静', smile: '微笑', joy: '开心', worry: '担心', pout: '闹别扭', puzzled: '疑惑' }

function setText(id, value) {
  const el = document.getElementById(id)
  if (el) el.textContent = String(value)
}

function openRelation() {
  document.getElementById('relation-overlay')?.classList.remove('hidden')
  renderRelation()
}

function closeRelation() {
  document.getElementById('relation-overlay')?.classList.add('hidden')
}

async function renderRelation() {
  // 熟悉度与统计
  try {
    const info = await window.nagi.relation.get()
    const r = info && info.relation
    if (r && r.level) {
      setText('rel-level-label', r.level.label)
      setText('rel-score', Math.round(r.score * 100) + '%')
      const fill = document.getElementById('rel-bar-fill')
      if (fill) fill.style.width = Math.round(r.score * 100) + '%'
      setText('rel-next', r.next ? `距离「${r.next.label}」还差 ${Math.round(r.needScore * 100)}%` : '已经是她最熟悉的人了')
      setText('rel-days', r.daysKnown)
      setText('rel-inter', r.interactionCount)
      setText('rel-active', r.activeDays)
      setText('rel-hint', `她现在的分寸是「${r.level.label}」——${r.level.note}`)
    }
    const mem = await window.nagi.memory.list().catch(() => [])
    setText('rel-mem', (mem || []).length)
  } catch (err) {
    console.warn('[relation] 读取失败', err.message)
  }

  // 情绪时间线
  try {
    const tl = await window.nagi.relation.timeline({ days: 7 })
    const now = Date.now()
    const dayStart = new Date(now).setHours(0, 0, 0, 0)
    const todayPts = ((tl && tl.days) || []).find((d) => d.date === localDayKey(dayStart))?.points || []
    drawTodayBand(todayPts, dayStart, dayStart + 24 * 3600 * 1000)
    drawWeek((tl && tl.buckets) || [])
  } catch (err) {
    console.warn('[relation] 时间线读取失败', err.message)
  }
  drawLegend()
}

function localDayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今日 24 小时色带：按时间比例铺色段（比例算法与主进程共用 core/relation/timeline.js） */
function drawTodayBand(points, from, to) {
  const box = document.getElementById('rel-today')
  if (!box) return
  box.innerHTML = ''
  const segs = toSegments(points, { from, to })
  if (!segs.length) {
    const empty = document.createElement('div')
    empty.className = 'rel-tl-empty'
    empty.textContent = '今天还没记下什么'
    box.appendChild(empty)
    return
  }
  for (const s of segs) {
    const el = document.createElement('div')
    el.className = 'rel-tl-seg'
    el.style.left = (s.from * 100).toFixed(2) + '%'
    el.style.width = ((s.to - s.from) * 100).toFixed(2) + '%'
    el.style.background = MOOD_COLORS[s.mood] || MOOD_COLORS.calm
    el.title = `${MOOD_LABELS[s.mood] || s.mood}（强度 ${Math.round(s.i * 100)}%）`
    box.appendChild(el)
  }
}

/** 近 7 天：每天一根小柱，高度=当天采样点数，颜色=当天主情绪 */
function drawWeek(buckets) {
  const box = document.getElementById('rel-week')
  if (!box) return
  box.innerHTML = ''
  for (const b of buckets) {
    const cell = document.createElement('div')
    cell.className = 'rel-week-day'
    const bar = document.createElement('div')
    bar.className = 'rel-week-bar'
    const fill = document.createElement('div')
    fill.className = 'rel-week-fill'
    if (b.count) {
      fill.style.height = Math.min(100, 32 + b.count * 6) + '%'
      fill.style.background = MOOD_COLORS[b.dominant] || MOOD_COLORS.calm
      bar.title = `${b.date}：${b.count} 个采样点，主情绪 ${MOOD_LABELS[b.dominant] || b.dominant}`
    } else {
      bar.title = `${b.date}：没有记录`
    }
    bar.appendChild(fill)
    const label = document.createElement('div')
    label.className = 'rel-week-label'
    label.textContent = b.date.slice(5).replace('-', '/')
    cell.append(bar, label)
    box.appendChild(cell)
  }
}

function drawLegend() {
  const box = document.getElementById('rel-legend')
  if (!box || box.childElementCount) return
  for (const [mood, label] of Object.entries(MOOD_LABELS)) {
    const span = document.createElement('span')
    const i = document.createElement('i')
    i.style.background = MOOD_COLORS[mood]
    span.append(i, document.createTextNode(label))
    box.appendChild(span)
  }
}

function wireRelationPage() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn)
  on('btn-open-relation', openRelation)
  on('btn-close-relation', closeRelation)
  on('btn-rel-diary', () => {
    closeRelation()
    window.nagi.win.openDiary()
  })
  on('btn-rel-settings', () => {
    closeRelation()
    openSettings()
  })
}

/* ---------------- 她的日程（M4：日程提醒） ---------------- */

function openReminder() {
  document.getElementById('reminder-overlay')?.classList.remove('hidden')
  renderReminders()
}

function closeReminder() {
  document.getElementById('reminder-overlay')?.classList.add('hidden')
}

async function renderReminders() {
  const box = document.getElementById('reminder-list')
  const empty = document.getElementById('reminder-empty')
  if (!box || !window.nagi.reminders) return
  renderPromises()
  try {
    const r = await window.nagi.reminders.list()
    const items = (r && r.items) || []
    box.innerHTML = ''
    if (!items.length) {
      empty?.classList.remove('hidden')
      return
    }
    empty?.classList.add('hidden')
    for (const it of items) {
      const isComplete = it.promiseStatus === 'completed'
      const row = document.createElement('div')
      row.className = 'rm-item' + (isComplete ? ' done' : '') + (!isComplete && it.firedAt ? ' fired' : '')
      const when = document.createElement('span')
      when.className = 'rm-when'
      when.textContent = isComplete ? '你已确认完成' : it.promiseStatus === 'legacy-unknown' ? '旧记录，结果未知' : it.missedAt ? '未送达' : it.repeat === 'none' && it.firedAt ? '提醒已发出' : it.when
      const text = document.createElement('span')
      text.className = 'rm-text'
      text.textContent = it.text
      row.append(when, text)
      if (it.repeat && it.repeat !== 'none') {
        const rep = document.createElement('span')
        rep.className = 'rm-rep'
        rep.textContent = it.repeatLabel
        row.appendChild(rep)
      }
      if (!isComplete) {
        const remain = document.createElement('span')
        remain.className = 'rm-remain'
        remain.textContent = it.promiseStatus === 'legacy-unknown' ? '旧版没有完成证据' : it.missedAt ? '已过期' : it.repeat === 'none' && it.firedAt ? '事情是否完成，由你确认' : it.remain
        row.appendChild(remain)
        const done = document.createElement('button')
        done.textContent = '✓'
        done.title = '标记完成'
        done.addEventListener('click', async () => {
          await window.nagi.reminders.done(it.id)
          renderReminders()
        })
        row.appendChild(done)
      }
      const del = document.createElement('button')
      del.textContent = '✕'
      del.title = '删除这条'
      del.addEventListener('click', async () => {
        await window.nagi.reminders.remove({ id: it.id })
        renderReminders()
      })
      row.appendChild(del)
      box.appendChild(row)
    }
  } catch (err) {
    console.warn('[reminder] 列表读取失败', err.message)
  }
}

async function renderPromises() {
  const box = document.getElementById('promise-list')
  if (!box || !window.nagi.promises) return
  const labels = { scheduled: '已记下', attempting: '正在尝试', attempted: '已尝试，效果待核实',
    delivered: '通知已发出', completed: '已完成', failed: '失败', missed: '未送达',
    cancelled: '已取消', 'legacy-unknown': '旧记录，结果未知' }
  try {
    const result = await window.nagi.promises.list()
    box.replaceChildren()
    for (const it of result.items || []) {
      const row = document.createElement('div')
      row.className = 'rm-item'
      const status = document.createElement('span')
      status.className = 'rm-when'
      status.textContent = labels[it.status] || it.status
      const title = document.createElement('span')
      title.className = 'rm-text'
      title.textContent = it.title
      const proof = document.createElement('span')
      proof.className = 'rm-remain'
      const last = it.evidence?.at(-1)
      proof.textContent = last ? `${new Date(last.at).toLocaleString()} · ${last.kind}` : '暂无结果证据'
      row.append(status, title, proof)
      box.appendChild(row)
    }
    if (!result.items?.length) box.textContent = '还没有承诺记录。'
  } catch (err) {
    box.textContent = `承诺簿读取失败：${err.message}`
  }
}

function wireReminderPage() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn)
  on('btn-open-reminder', openReminder)
  on('btn-close-reminder', closeReminder)
  on('btn-rm-add', async () => {
    const textEl = document.getElementById('rm-text')
    const whenEl = document.getElementById('rm-when')
    const repEl = document.getElementById('rm-repeat')
    const out = document.getElementById('rm-result')
    const text = textEl?.value.trim()
    const when = whenEl?.value.trim()
    if (!text) {
      if (out) out.textContent = '先写要提醒什么'
      return
    }
    if (!when) {
      if (out) out.textContent = '什么时候提醒？例如「10分钟后」「明天9:00」'
      return
    }
    const r = await window.nagi.reminders.add({ text, when, repeat: repEl?.value || 'none' })
    if (out) out.textContent = r.ok ? '记下了。到点她会叫你。' : '没能记下：' + (r.error || '未知原因')
    if (r.ok) {
      if (textEl) textEl.value = ''
      if (whenEl) whenEl.value = ''
      if (repEl) repEl.value = 'none'
      renderReminders()
    }
  })
}

// 调试：暴露情绪触发 / 动作触发
window.__nagiTestEmotion = (name) => {
  if (!EMOTIONS.includes(name)) return false
  ui.setMood(name)
  return l2d.setEmotion(name, { motion: 'force' })
}
window.__nagiTestMotion = (group) => l2d.playMotion(group)
window.__nagiTestMotion2 = (group, index) => l2d.playMotion(group, index)
window.__nagiStopMotions = () => l2d.stopMotions()
window.__nagiMotionCatalog = () => l2d.motionCatalog()
window.__nagiExpressionList = () => l2d.listExpressions()
window.__nagiTestExpression = (name) => l2d.setExpressionRaw(name)
window.__nagiReadParams = (ids) => l2d.readParams(ids)
window.__nagiRedParams = () => l2d.redParamIds()
window.__nagiProbeRed = () => l2d.probeRedOnce()
// 调试：取景/布局诊断（画布尺寸、模型尺寸、锚点、实际包围盒）
window.__nagiFrame = () => l2d.frameInfo()
// 调试：确定性抓帧（同帧渲染后读回，绕开 WebGL 截图空白问题）
window.__nagiSnapshot = () => l2d.snapshotDataURL()
// 调试：运行时改缩放/取景，便于验证在不同尺寸下的对齐
window.__nagiSetScale = (v) => l2d.setScale(v)
window.__nagiSetMirror = (v) => l2d.setMirror(v)
window.__nagiSetFrame = (f) => l2d.setFrame(f)
// 调试：探测画面实际范围（读回这一帧像素求 alpha 包围盒，比数学矩形可信）
window.__nagiArtBox = () => l2d.measureArtBox()
// 调试：对话状态驱动的姿态（'thinking' 思考 / null 收回中立）
window.__nagiSetPose = (n) => l2d.setPose(n)
window.__nagiGetPose = () => l2d.getPose()
// 调试：昼夜时段表现（BLUE-2）：'neutral' | 'night' | 'afternoon' | '…→neutral'（收回中）
window.__nagiApplyRhythmPose = (r) => l2d.applyRhythmPose(r)
window.__nagiGetRhythmPose = () => l2d.getRhythmPose()
// 调试：主进程广播来的 rhythm 快照（验证「广播 → presence.js → 模型」整条链路）
window.__nagiRhythm = () => presence.getRhythm()
// 调试：模型实际参数清单（时段表现过滤用）
window.__nagiParamIds = () => l2d.listParamIds()
// 调试：在姿态生效的瞬间采样姿态参数（帧外读不到，Cubism 每帧末尾会还原快照）
window.__nagiPoseParams = (ids) => l2d.probePoseOnce(ids)
// 调试：焦点控制器内部状态（验证"目光不跟随鼠标"：它应该一直是 0）
window.__nagiFocusState = () => l2d.focusState()
// 调试：关系页
window.__nagiRelation = () => window.nagi.relation.get()
window.__nagiTimeline = (days) => window.nagi.relation.timeline({ days: days || 7 })
window.__nagiOpenRelation = () => openRelation()
// 调试：日程
window.__nagiReminders = () => window.nagi.reminders.list()
window.__nagiOpenReminder = () => openReminder()
