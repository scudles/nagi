// src/renderer/js/main.js
// 渲染层入口：根据 ?mode=pet|workbench 初始化布局，装配 Live2D、对话与设置页。
//
// 两个形态各自加载一份 Live2D（桌宠窗 / 工作台凪面板），共用同一套驱动逻辑（live2d.js）；
// 因为是两个渲染进程，模块状态互不干扰。

import { PROVIDER_PRESETS, SECRET_KEYS, MODE, EMOTIONS, EVT } from '../../shared/protocol.js'
import { VOICE_EVT, mergeVoiceSettings } from '../../shared/voice-protocol.js'
import { EDGE_VOICES, TTS_ENGINES, ASR_ENGINES } from '../../core/voice/index.js'
import { toSegments } from '../../core/relation/timeline.js'
import * as ui from './ui.js'
import { initChat, sendText } from './chat.js'
import * as l2d from './live2d.js'
import { initDiary } from './diary.js'
import { initVoice } from './voice.js'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === MODE.WORKBENCH ? MODE.WORKBENCH : params.get('mode') === 'diary' ? 'diary' : MODE.PET
document.body.dataset.mode = mode

let settings = null
let l2dReady = false
let currentMood = null // 主进程情绪状态机的最新快照
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
      l2d.playMotion('Idle') // 换个待机姿势，提醒她还在
    } else if (idleBoosted) {
      // 待机中偶尔再动一下，别像块背景板
      if (Math.random() < 0.35) l2d.playMotion('Idle')
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

  // 事件：桌宠交互（戳一戳台词气泡 / 活动监测的主动搭话 / 日程提醒）
  window.nagi.on(EVT.PET, (p) => {
    noteActivity()
    if (!p || !p.text) return
    if (mode === MODE.PET) {
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

  // 事件：家里设备状态变化（桌宠气泡提醒；工作台进工具日志）
  window.nagi.on(EVT.HA_EVENT, (payload) => {
    if (!payload || !payload.summary) return
    if (mode === MODE.PET) ui.showBubble(`（家里：${payload.summary}）`)
    else ui.addToolLog(`（家里：${payload.summary}）`)
  })

  wireWindowButtons()
  wireSettingsPage()
  wireRelationPage()
  wireReminderPage()

  // 首次启动：活动监测告知（只弹一次，仅桌宠形态）
  if (mode === MODE.PET) maybeShowMonitorNotice()

  // 对话
  initChat({
    onEmotion: (emotion) => {
      // 流式情绪只驱动当场表情 + 动作（状态机的正式情绪以 MOOD 广播为准）
      if (l2dReady) l2d.setEmotion(emotion, { motion: true })
    },
    onStatus: (state) => {
      if (state === 'thinking') ui.showBubble('……', { autoHide: 0 })
    },
    // 说话口型：文本在流，嘴就动
    onTextDelta: () => {
      noteActivity()
      if (l2dReady) l2d.startTalking()
    },
    onDone: () => {
      if (l2dReady) l2d.stopTalking()
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
      eyeBlink: cfg.eyeBlink !== false,
      focusFollow: cfg.focusFollow !== false
    })
    l2dReady = true
    placeholder?.classList.add('hidden')
    // 模型就位后立刻同步当前情绪（初始拉取发生在模型加载前）
    if (currentMood) l2d.setEmotion(currentMood.expr, { motion: false })
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
}
function closeSettings() {
  document.getElementById('settings-overlay')?.classList.add('hidden')
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
      const p = PROVIDER_PRESETS[sel.value]
      if (p && sel.value !== 'custom') {
        document.getElementById('set-baseurl').value = p.baseURL
        document.getElementById('set-model').value = p.model
      }
    })
  }
  const llm = settings?.llm || {}
  if (sel) sel.value = llm.provider || 'openai'
  document.getElementById('set-baseurl').value = llm.baseURL || ''
  document.getElementById('set-model').value = llm.model || ''
  document.getElementById('set-temp').value = llm.temperature ?? 0.7

  const ha = settings?.homeassistant || {}
  document.getElementById('set-ha-url').value = ha.baseURL || ''

  const tools = settings?.tools || {}
  document.getElementById('set-fileroot').value = tools.fileRoot || ''
  document.getElementById('set-cdp').value = tools.cdpPort ?? 9222
  document.getElementById('set-confirm').checked = tools.confirmHighRisk !== false
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
  const blEl = document.getElementById('set-blacklist')
  if (blEl) blEl.value = (privacy.blacklist || []).join('\n')

  refreshSecretStatus()
  refreshModels()
  refreshMemory()
  refreshVoice()
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
      t.textContent = m.text
      const del = document.createElement('button')
      del.textContent = '✕'
      del.title = '让她忘掉这条'
      del.addEventListener('click', async () => {
        await window.nagi.memory.remove({ id: m.id })
        refreshMemory()
      })
      row.append(t, del)
      box.appendChild(row)
    }
  } catch (err) {
    console.warn('[memory] 列表读取失败', err.message)
  }
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
const VOICE_PREVIEW_TEXT = '我是凪。不是帮你，是顺手。'

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
    try {
      const r = await window.nagi.voice.downloadModel()
      if (!r || !r.ok) {
        ui.addToolLog('离线识别安装失败：' + (r?.error || '未知原因'))
      } else {
        ui.addToolLog('离线识别已装好，之后完全离线可用')
      }
    } catch (err) {
      ui.addToolLog('离线识别安装失败：' + err.message)
    } finally {
      document.getElementById('asr-progress')?.classList.add('hidden')
      await refreshVoice()
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
      const what = p.stage === 'cli' || (!p.file && !p.stage) ? '识别程序' : '识别模型'
      out.textContent = `正在下载${what} · ${pct}%`
    }
    const btn = document.getElementById('btn-asr-download')
    if (btn) btn.disabled = true
  })
}

function wireSettingsPage() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn)

  on('btn-save-llm', async () => {
    await window.nagi.settings.set({
      llm: {
        provider: document.getElementById('set-provider').value,
        baseURL: document.getElementById('set-baseurl').value.trim(),
        model: document.getElementById('set-model').value.trim(),
        temperature: Number(document.getElementById('set-temp').value) || 0.7
      }
    })
    settings = await window.nagi.settings.get()
    ui.setBrain(brainLabel())
    ui.addToolLog('大脑设置已保存')
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
  })
  on('btn-history-clear', async () => {
    await window.nagi.memory.clearHistory()
    ui.addToolLog('对话历史已清空（长期记忆保留）')
  })

  on('btn-save-tools', async () => {
    await window.nagi.settings.set({
      tools: {
        fileRoot: document.getElementById('set-fileroot').value.trim(),
        cdpPort: Number(document.getElementById('set-cdp').value) || 9222,
        confirmHighRisk: document.getElementById('set-confirm').checked
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
        blacklist
      }
    })
    settings = await window.nagi.settings.get()
    ui.addToolLog('监测设置已保存')
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
      const row = document.createElement('div')
      row.className = 'rm-item' + (it.doneAt ? ' done' : '') + (!it.doneAt && it.firedAt ? ' fired' : '')
      const when = document.createElement('span')
      when.className = 'rm-when'
      when.textContent = it.doneAt ? '已完成' : it.when
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
      if (!it.doneAt) {
        const remain = document.createElement('span')
        remain.className = 'rm-remain'
        remain.textContent = it.remain
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
// 调试：关系页
window.__nagiRelation = () => window.nagi.relation.get()
window.__nagiTimeline = (days) => window.nagi.relation.timeline({ days: days || 7 })
window.__nagiOpenRelation = () => openRelation()
// 调试：日程
window.__nagiReminders = () => window.nagi.reminders.list()
window.__nagiOpenReminder = () => openReminder()
