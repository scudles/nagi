// src/renderer/js/main.js
// 渲染层入口：根据 ?mode=pet|workbench 初始化布局，装配 Live2D、对话与设置页。

import { PROVIDER_PRESETS, SECRET_KEYS, MODE, EMOTIONS, EVT } from '../../shared/protocol.js'
import * as ui from './ui.js'
import { initChat, sendText } from './chat.js'
import * as l2d from './live2d.js'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === MODE.WORKBENCH ? MODE.WORKBENCH : MODE.PET
document.body.dataset.mode = mode

let settings = null
let l2dReady = false

boot().catch((err) => {
  console.error('[nagi] 启动失败：', err)
  ui.addMessage('error', '启动失败：' + err.message)
})

async function boot() {
  settings = await window.nagi.settings.get()

  // 事件：设置变更
  window.nagi.on(EVT.SETTINGS_CHANGED, (next) => {
    if (next) settings = next
  })

  // 事件：家里设备状态变化（主动提醒进独白面板）
  window.nagi.on(EVT.HA_EVENT, (payload) => {
    if (payload && payload.summary) ui.addMonologue(`（家里：${payload.summary}）`, 'calm')
  })

  wireWindowButtons()
  wireSettingsPage()

  // 对话
  initChat({
    onEmotion: (emotion) => {
      l2d.setEmotion(emotion)
    },
    onStatus: (state) => {
      if (state === 'thinking') ui.showBubble('……', { autoHide: 0 })
    }
  })

  // 默认独白（工作台）
  if (mode === MODE.WORKBENCH) {
    ui.addMonologue('（凪醒来了，安静地看着屏幕。）', 'calm')
    ui.setBrain(brainLabel())
  }

  // 桌宠：尝试加载 Live2D 模型
  if (mode === MODE.PET) {
    await tryLoadLive2D()
    // 无头自测：轮换 6 情绪，验证表情映射全部命中
    if (params.get('pettest') === '1') runEmotionSelftest()
  }

  // 无头自测：自动发一条消息验证 对话 IPC → 事件广播 → UI 渲染 全链路
  if (params.get('selftest') === '1') {
    setTimeout(() => sendText('你好，凪'), 3000)
  }
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

  on('btn-wb-pet', () => window.nagi.win.setMode(MODE.PET))
  on('btn-wb-min', () => window.nagi.win.minimize())
  on('btn-wb-close', () => window.nagi.win.close())
  on('btn-open-settings', () => openSettings())
  on('btn-close-settings', () => closeSettings())
}

/* ---------------- Live2D ---------------- */
async function tryLoadLive2D() {
  const cfg = settings?.live2d || {}
  const list = await window.nagi.models.list()
  if (!list.models || list.models.length === 0) {
    ui.addMonologue?.('（未找到 Live2D 模型，桌宠显示占位。请把模型放进 models/ 目录。）')
    console.warn('[live2d] models 目录下没有 *.model3.json，跳过模型加载。模型目录：', list.dir)
    return
  }
  const rel = cfg.modelPath && list.models.includes(cfg.modelPath) ? cfg.modelPath : list.models[0]
  const url = `nagi-local://models/${rel}`
  try {
    await l2d.load(ui.els.canvas, url, {
      scale: cfg.scale || 1,
      mirror: !!cfg.mirror,
      eyeBlink: cfg.eyeBlink !== false,
      focusFollow: cfg.focusFollow !== false
    })
    l2dReady = true
    ui.els.placeholder.classList.add('hidden')
    console.log('[live2d] 已加载模型：', rel, '表情：', l2d.listExpressions())
  } catch (err) {
    console.error('[live2d] 加载失败：', err)
    ui.showBubble('模型加载失败：' + err.message)
  }
}

/* ---------------- Live2D 自测 ---------------- */
function runEmotionSelftest() {
  setTimeout(() => {
    console.log('[selftest] 模型表情列表:', JSON.stringify(l2d.listExpressions()))
    console.log('[selftest] 动作组:', JSON.stringify(l2d.listMotionGroups()))
    const results = {}
    for (const e of EMOTIONS) {
      const hit = l2d.resolveExpression(e)
      results[e] = hit
      l2d.setEmotion(e)
      console.log(`[selftest] 情绪 ${e} → 表情 ${hit || '(无映射，保持默认)'}`)
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

  refreshSecretStatus()
  refreshModels()
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

  on('btn-refresh-models', refreshModels)
  on('btn-save-l2d', async () => {
    await window.nagi.settings.set({
      live2d: {
        modelPath: document.getElementById('set-model-path').value,
        scale: Number(document.getElementById('set-l2d-scale').value) || 1
      }
    })
    settings = await window.nagi.settings.get()
    ui.addToolLog('Live2D 设置已保存（回到桌宠后生效）')
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

// 调试：暴露情绪触发
window.__nagiTestEmotion = (name) => {
  if (!EMOTIONS.includes(name)) return false
  ui.setMood(name)
  return l2d.setEmotion(name)
}
