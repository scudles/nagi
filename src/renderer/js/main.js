// src/renderer/js/main.js
// 渲染层入口：根据 ?mode=pet|workbench 初始化布局，装配 Live2D、对话与设置页。
//
// 两个形态各自加载一份 Live2D（桌宠窗 / 工作台凪面板），共用同一套驱动逻辑（live2d.js）；
// 因为是两个渲染进程，模块状态互不干扰。

import { PROVIDER_PRESETS, SECRET_KEYS, MODE, EMOTIONS, EVT } from '../../shared/protocol.js'
import * as ui from './ui.js'
import { initChat, sendText } from './chat.js'
import * as l2d from './live2d.js'
import { initDiary } from './diary.js'

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

  // 事件：桌宠交互（戳一戳台词气泡）
  window.nagi.on(EVT.PET, (p) => {
    noteActivity()
    if (mode === MODE.PET && p && p.text) ui.showBubble(p.text)
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
      eyeBlink: cfg.eyeBlink !== false,
      focusFollow: cfg.focusFollow !== false
    })
    l2dReady = true
    placeholder?.classList.add('hidden')
    // 模型就位后立刻同步当前情绪（初始拉取发生在模型加载前）
    if (currentMood) l2d.setEmotion(currentMood.expr, { motion: false })
    console.log('[live2d] 已加载模型：', rel, '表情：', l2d.listExpressions().length, '动作组：', l2d.listMotionGroups().join('/'))
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

  refreshSecretStatus()
  refreshModels()
  refreshMemory()
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
