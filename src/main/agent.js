// src/main/agent.js
// Agent 会话编排：组装 LLM 客户端 + 工具集 + 安全门 + 确认回路，跑 core/agent/loop。
// 未配置 API Key 时回退到本地占位大脑，保证应用开箱可用。

import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { AGENT_EVENT, AGENT_STATE, EVT, IPC, SECRET_KEYS } from '../shared/protocol.js'
import { runAgentLoop, buildSystemPrompt } from '../core/agent/loop.js'
import { createClient, chatStream } from '../core/llm/openai-compatible.js'
import { resolveLlm, supportsNativeTools } from '../core/llm/providers.js'
import { initCloudBrain, cloudBrainStatus, cloudChatStream } from '../core/llm/cloud-workbuddy.js'
import { createMood } from '../core/emotion/mood.js'
import { NagiPersona } from '../core/persona.js'
import { TOOL_SCHEMAS, createToolRunner } from '../core/tools/registry.js'
import { createFileTools } from '../core/tools/files.js'
import { createSystemTools } from '../core/tools/system.js'
import { createBrowserTools } from '../core/tools/browser.js'
import { HAClient, summarizeHaEvent } from '../core/homeassistant/ha.js'
import { createNativeTools } from './native-tools.js'
import { getSettings } from './settings-store.js'
import { getSecret, hasSecret } from './keystore.js'
import { broadcast, getWorkbenchWindow } from './windows.js'
import { appendDiary } from './diary.js'

/* ---------------- 全局单例 ---------------- */
const nativeTools = createNativeTools({ getWorkbenchWindow })
const browserTools = createBrowserTools({
  get cdpPort() {
    return getSettings().tools?.cdpPort
  },
  get browserMode() {
    return getSettings().tools?.browserMode
  },
  userDataDir: join(app.getPath('userData'), 'playwright-profile')
})

let haClient = null
function getHa() {
  const cfg = getSettings().homeassistant || {}
  if (!cfg.enabled) return null
  const token = getSecret(SECRET_KEYS.HA_TOKEN)
  if (!cfg.baseURL || !token) return null
  if (!haClient || haClient.baseURL !== cfg.baseURL || haClient.token !== token) {
    if (haClient) haClient.stopEvents()
    haClient = new HAClient({
      baseURL: cfg.baseURL,
      token,
      onEvent: (evt) => {
        const summary = summarizeHaEvent(evt)
        if (summary) broadcast(EVT.HA_EVENT, { summary, entity_id: evt.data?.entity_id })
      }
    })
    haClient.startEvents()
  }
  return haClient
}

/* ---------------- 会话状态 ---------------- */
const MAX_HISTORY = 30
let history = []
let busy = false
let currentAbort = null
const pendingConfirms = new Map() // id -> resolve

/* ---------------- 情绪状态机（主进程单例：双窗同步 + LLM 直读） ---------------- */
const mood = createMood()

function broadcastMood() {
  broadcast(EVT.MOOD, mood.current())
}

// Agent 事件出口：EMOTION 只记最后一帧（DONE 时才提议情绪，流式中途不翻脸），其余直广播
let lastEmotion = null
function emitAgentEvent(e) {
  if (e.type === AGENT_EVENT.EMOTION) {
    lastEmotion = e.emotion
    broadcast(EVT.AGENT, e)
    return
  }
  if (e.type === AGENT_EVENT.DONE) {
    if (lastEmotion) {
      mood.propose(lastEmotion, 1.0, 'llm')
      broadcastMood()
    }
    broadcast(EVT.AGENT, e)
    return
  }
  broadcast(EVT.AGENT, e)
}

/* ---------------- 情绪引擎：心跳 + 独白日史 ---------------- */
let moodTickTimer = null
let diaryTimer = null

/** 启动情绪心跳（15s）与独白日史定时器（42s × 50%）；app ready 后调用 */
export function startMoodEngine() {
  if (moodTickTimer) return
  moodTickTimer = setInterval(() => {
    mood.tick()
    broadcastMood()
  }, 15000)
  // 内心独白写日史文件（D2 决策：UI 不常驻，用户在日记查看器/文件夹里按需打开）
  diaryTimer = setInterval(() => {
    if (Math.random() < 0.5) {
      appendDiary(mood.current(), mood.pickMonologue())
    }
  }, 42000)
}

export function stopMoodEngine() {
  if (moodTickTimer) clearInterval(moodTickTimer)
  if (diaryTimer) clearInterval(diaryTimer)
  moodTickTimer = null
  diaryTimer = null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 未配置 key / 云端不可用时的本地占位大脑（D4：persona 关键词规则版） */
async function mockRun(userText, emit) {
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.THINKING })
  const r = NagiPersona.reply(userText)
  emit({ type: AGENT_EVENT.EMOTION, emotion: r.expr, intensity: 1 })
  const body = r.text
  for (const ch of body) {
    emit({ type: AGENT_EVENT.TEXT_DELTA, text: ch })
    await sleep(18)
  }
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
  emit({ type: AGENT_EVENT.DONE, text: body })
  return body
}

/**
 * 无头自测用的脚本化假大脑（NAGI_FAKE_LLM=1）：
 * 第一轮输出 JSON 兜底工具调用（file_list），第二轮拿到结果后汇报。
 * 用于在不接真实 LLM 的情况下端到端验证 Agent Loop + 工具 + 安全门链路。
 */
function fakeCallModel() {
  let round = 0
  return async function* () {
    round++
    if (round === 1) {
      yield { type: 'delta', text: '[calm] 我先看看你的文档目录。\n```json\n{"action":"file_list","args":{"path":"."}}\n```' }
      yield { type: 'done' }
    } else {
      yield { type: 'delta', text: '[smile] 看完了，目录内容我已经记下，需要哪个文件直接说。' }
      yield { type: 'done' }
    }
  }
}

function buildMessages(userText, supportsNative) {
  // 情绪连贯：强度够高时把当前情绪作为 user 消息前缀（只影响本轮，不改系统提示词）
  const hint = mood.hintForLLM()
  const userContent = hint ? '（凪当前的情绪：' + hint + '）\n' + userText : userText
  return [
    { role: 'system', content: buildSystemPrompt({ nativeTools: supportsNative }) },
    ...history,
    { role: 'user', content: userContent }
  ]
}

function trimHistory(messages) {
  // 去掉 system，保留最近 MAX_HISTORY 条
  const withoutSystem = messages.filter((m) => m.role !== 'system')
  history = withoutSystem.slice(-MAX_HISTORY).map((m) => {
    // tool 消息在部分模型上有兼容问题，压成 user 文本
    if (m.role === 'tool') return { role: 'user', content: m.content }
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant', content: m.content || `（调用工具 ${m.tool_calls.map((t) => t.function.name).join('、')}）` }
    }
    return { role: m.role, content: m.content }
  })
}

/** 组装依赖并执行一轮 */
export async function runTurn(userText, emit) {
  const settings = getSettings()
  const llm = resolveLlm(settings.llm || {})
  const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
  const fakeLlm = process.env.NAGI_FAKE_LLM === '1'
  const useCloud = llm.provider === 'workbuddy' && !fakeLlm

  if (!hasKey && !fakeLlm && !useCloud) return mockRun(userText, emit)

  // 云端大脑：未就绪则尝试初始化；仍不可用则降级本地占位（中文原因提示）
  if (useCloud && !cloudBrainStatus().ok) {
    const st = await initCloudBrain()
    if (!st.ok) {
      broadcast(EVT.AGENT, { type: AGENT_EVENT.ERROR, message: '云端大脑暂不可用（' + (st.error || '未知原因') + '），先用本地模式陪你。' })
      return mockRun(userText, emit)
    }
  }

  const apiKey = hasKey ? getSecret(SECRET_KEYS.LLM_API_KEY) : null
  const client = hasKey ? createClient({ apiKey, baseURL: llm.baseURL }) : null

  // 云端（凪云）网关实测支持原生 function calling（2026-10-14 验证，hunyuan-chat 亦可），
  // 与 openai 通道一致；假大脑固定走 JSON 兜底通道
  const supportsNative = fakeLlm ? false : useCloud ? true : supportsNativeTools({ provider: llm.provider, model: llm.model })

  const fileRoot = settings.tools?.fileRoot || app.getPath('documents')
  const files = createFileTools({ fileRoot })
  const system = createSystemTools({ cwd: app.getPath('home') })
  const ha = getHa()
  const executeTool = createToolRunner({ files, system, browser: browserTools, ha, native: nativeTools })

  const messages = buildMessages(userText, supportsNative)
  currentAbort = new AbortController()

  const r = await runAgentLoop({
    messages,
    supportsNative,
    toolSchemas: TOOL_SCHEMAS,
    callModel: fakeLlm
      ? fakeCallModel()
      : useCloud
        ? async ({ tools, signal }) => cloudChatStream({ messages, tools, signal: signal || currentAbort.signal })
        : async ({ tools, signal }) =>
            chatStream(client, {
              model: llm.model,
              messages,
              temperature: llm.temperature,
              tools,
              signal: signal || currentAbort.signal
            }),
    executeTool,
    confirm: ({ id }) =>
      new Promise((resolve) => {
        pendingConfirms.set(id, resolve)
        // 兜底：30 秒无人回应按拒绝处理
        setTimeout(() => {
          if (pendingConfirms.has(id)) {
            pendingConfirms.delete(id)
            resolve(false)
          }
        }, 30000).unref?.()
      }),
    emit,
    safety: { confirmHighRisk: settings.tools?.confirmHighRisk !== false },
    signal: currentAbort.signal
  })

  // 写入历史（messages 已含 system + 旧历史 + 本轮 user + 工具过程，再补最终回复）
  if (r.text) messages.push({ role: 'assistant', content: r.text })
  trimHistory(messages)
  return r.text
}

/** 对外：发送一条用户消息 */
export async function handleChatSend(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '空消息' }
  if (busy) return { ok: false, error: '正在处理上一条消息' }
  busy = true
  mood.noteInteraction() // 连聊 burst 统计 + 刷新互动时间
  const emit = (e) => emitAgentEvent(e)
  try {
    await runTurn(t, emit)
    return { ok: true }
  } catch (err) {
    emit({ type: AGENT_EVENT.ERROR, message: err && err.message ? err.message : String(err) })
    emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
    return { ok: false, error: err?.message }
  } finally {
    busy = false
    currentAbort = null
  }
}

/* ---------------- 桌宠交互：戳一戳 / 情绪读数 ---------------- */

/** 当前情绪快照（渲染层轮询或 IPC 拉取用） */
export function getMoodSnapshot() {
  return mood.current()
}

/** 戳一戳：返回气泡台词 + 当时表情，并广播 PET 事件 */
export function handlePoke() {
  mood.noteInteraction() // 戳她也是互动：刷新冷落计时
  const p = mood.pickPoke()
  broadcastMood()
  broadcast(EVT.PET, { kind: 'poke', text: p.text, expr: p.expr })
  return p
}

/** 确认条回传 */
export function resolveConfirm(id, approved) {
  const resolve = pendingConfirms.get(id)
  if (resolve) {
    pendingConfirms.delete(id)
    resolve(Boolean(approved))
    return { ok: true }
  }
  return { ok: false, error: '没有等待中的确认' }
}

/** 中止当前回合 */
export function abortChat() {
  if (currentAbort) currentAbort.abort()
  return { ok: true }
}

/** 退出前清理 */
export async function disposeAgent() {
  stopMoodEngine()
  try {
    await browserTools.dispose()
  } catch {
    /* ignore */
  }
  if (haClient) haClient.stopEvents()
}

/* ---------------- HA 专用 IPC（设置页的"测试连接 / 列设备"） ---------------- */
export async function haTest() {
  const cfg = getSettings().homeassistant || {}
  if (!cfg.baseURL) return { ok: false, error: '尚未配置 Home Assistant 地址' }
  if (!hasSecret(SECRET_KEYS.HA_TOKEN)) return { ok: false, error: '尚未配置 Home Assistant Token' }
  try {
    const client = new HAClient({ baseURL: cfg.baseURL, token: getSecret(SECRET_KEYS.HA_TOKEN) })
    const r = await client.test()
    return { ok: r.ok, error: r.ok ? null : `HA 响应异常：${r.message}` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function haList(domain) {
  const cfg = getSettings().homeassistant || {}
  if (!cfg.baseURL || !hasSecret(SECRET_KEYS.HA_TOKEN)) {
    return { ok: false, error: '尚未配置 Home Assistant（地址 + Token）' }
  }
  try {
    const client = new HAClient({ baseURL: cfg.baseURL, token: getSecret(SECRET_KEYS.HA_TOKEN) })
    const list = await client.listEntities({ domain })
    return { ok: true, count: list.length, entities: list.slice(0, 100) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
