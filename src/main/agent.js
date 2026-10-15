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
import { buildContextBlock, recentAssistantReplies, timeSlot } from '../core/context.js'
import {
  buildDiaryMessages,
  formatMoodJourney,
  isTooSimilar,
  pickFallbackDiary,
  sanitizeDiaryLine,
  shouldOfferCache,
  shouldWriteNow
} from '../core/diary.js'
import { dateKey } from '../core/journal.js'
import { MEMORY_EXTRACT_PROMPT, parseMemoryOps } from '../core/memory.js'
import {
  loadHistory,
  saveHistory,
  lastInteractionAt,
  memoryLines,
  listMemories,
  addMemory,
  removeMemory,
  mergeMemoryOps,
  clearHistory,
  flushPersist,
  loadMoodState,
  saveMoodState
} from './persist.js'
import { TOOL_SCHEMAS, createToolRunner } from '../core/tools/registry.js'
import { createFileTools } from '../core/tools/files.js'
import { createSystemTools } from '../core/tools/system.js'
import { createBrowserTools } from '../core/tools/browser.js'
import { HAClient, summarizeHaEvent } from '../core/homeassistant/ha.js'
import { createNativeTools } from './native-tools.js'
import { getSettings } from './settings-store.js'
import { getSecret, hasSecret } from './keystore.js'
import { broadcast, getWorkbenchWindow } from './windows.js'
import { appendDiary, recentDiaryLines, cacheLeakCount, noteCacheLeak } from './diary.js'
import { noteEvent, todayEvents, pruneJournals, flushJournal } from './journal.js'
import { startMonitor, stopMonitor } from './monitor/index.js'
import { getRag } from './rag/index.js'
import {
  startReminderEngine,
  stopReminderEngine,
  reminderTools,
  listReminders,
  addReminder,
  removeReminder,
  completeReminder
} from './reminders.js'
import {
  initRelation,
  noteRelationInteraction,
  relationSummary,
  recordMoodPoint,
  readTimeline,
  pruneTimeline
} from './relation.js'

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
const MAX_HISTORY = 40
let history = []
let historyLoaded = false
let busy = false
let currentAbort = null
let mockAnnounced = false // 本地占位大脑的说明只在第一次说一次
const pendingConfirms = new Map() // id -> resolve

/** 首次用到时从磁盘恢复对话历史（重启后凪还记得昨天聊过什么） */
function ensureHistory() {
  if (historyLoaded) return
  historyLoaded = true
  try {
    history = loadHistory()
    if (history.length) console.log('[memory] 已恢复历史消息', history.length, '条')
  } catch (err) {
    console.warn('[memory] 历史读取失败：', err.message)
    history = []
  }
}

/* ---------------- 情绪状态机（主进程单例：双窗同步 + LLM 直读） ---------------- */
const mood = createMood()

function broadcastMood() {
  broadcast(EVT.MOOD, mood.current())
}

/* ---------------- S4：情绪与关系跨重启延续 ---------------- */

/** 上次落盘时的状态签名：情绪/强度/互动时间真变了才写盘，否则 15 秒一次心跳会白白写盘 */
let lastMoodSig = ''
/** 语义关键位（情绪种类 + 互动时间）：这两位一变必须立刻写盘 */
let lastMoodKeyPart = ''
let lastMoodWriteAt = 0
/** 纯衰减（同情绪、只掉强度）的落盘限流：不必每 15 秒写一次小文件 */
const MOOD_WRITE_MIN_GAP = 30000

function moodSignature(st) {
  return st.mood + '|' + st.intensity.toFixed(3) + '|' + st.lastInteraction
}

// 情绪一变就落盘 + 记一个时间线采样点（采样规则会挡掉无意义的写）
mood.onChange(() => {
  const st = mood.serialize()
  const sig = moodSignature(st)
  if (sig === lastMoodSig) return
  lastMoodSig = sig

  const keyPart = st.mood + '|' + st.lastInteraction
  const important = keyPart !== lastMoodKeyPart // 情绪换脸 / 刚互动过 = 必须落盘
  lastMoodKeyPart = keyPart
  const nowMs = Date.now()
  if (!important && nowMs - lastMoodWriteAt < MOOD_WRITE_MIN_GAP) return
  lastMoodWriteAt = nowMs

  try {
    saveMoodState(st)
  } catch (err) {
    console.warn('[mood] 情绪落盘失败：', err && err.message)
  }
  try {
    recordMoodPoint({ mood: st.mood, intensity: st.intensity })
  } catch (err) {
    console.warn('[timeline] 采样失败：', err && err.message)
  }
})

/**
 * 启动时恢复：情绪（按离线时长自然衰减）+ 关系统计 + 清理过期时间线。
 * 必须在 app ready 之后调用（要用 userData 路径）。
 */
export function restoreState() {
  try {
    const saved = loadMoodState()
    if (saved && mood.restore(saved)) {
      const snap = mood.current()
      lastMoodSig = moodSignature(mood.serialize())
      console.log(`[mood] 已延续上次心情：${snap.label}（${Math.round(snap.intensity * 100)}%）`)
    }
  } catch (err) {
    console.warn('[mood] 恢复失败：', err && err.message)
  }
  try {
    initRelation()
  } catch (err) {
    console.warn('[relation] 初始化失败：', err && err.message)
  }
  try {
    pruneTimeline()
  } catch {
    /* 清理失败不影响启动 */
  }
  try {
    pruneJournals()
  } catch {
    /* 同上 */
  }
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

/** 独白节流状态：单日计数跨天归零（只活在内存里，重启重算） */
let diaryDay = null
let diaryCount = 0
let lastDiaryAt = 0
let diaryBusy = false

/** 启动情绪心跳（15s）与独白日史检查（60s，是否动笔由节流决定）；app ready 后调用 */
export function startMoodEngine() {
  if (moodTickTimer) return
  moodTickTimer = setInterval(() => {
    mood.tick()
    broadcastMood()
  }, 15000)
  // 内心独白写日史文件（D2 决策：UI 不常驻，用户在日记查看器/文件夹里按需打开）
  // 2026-10-15：不再是「掷骰子从固定池抽一句」——每分钟醒一次，按节流决定是否动笔；
  // 动笔时把「今天发生的事 + 情绪轨迹 + 关于他的记忆」交给她即兴生成（见 writeDiaryLine）。
  diaryTimer = setInterval(() => {
    maybeWriteDiary('ambient')
  }, 60000)
  // 无头自测：强制写一条（延迟 10s，等无头脚本先把测试消息聊完），
  // 验证「采素材 → 生成 → 落盘」整条链路（NAGI_SELFTEST_DIARY_WRITE=1）
  if (process.env.NAGI_SELFTEST && process.env.NAGI_SELFTEST_DIARY_WRITE === '1') {
    setTimeout(() => void writeDiaryLine({ now: Date.now() }), 10000)
  }
}

export function stopMoodEngine() {
  if (moodTickTimer) clearInterval(moodTickTimer)
  if (diaryTimer) clearInterval(diaryTimer)
  moodTickTimer = null
  diaryTimer = null
}

/* ---------------- 内心独白：按「今天真实发生的事」即兴生成（2026-10-15） ----------------
 * 修的是什么：原先每 42 秒掷一次骰子，中了就从固定句子池里抽一条——所以日记篇篇是模板，
 * 跟"今天到底过了什么"没关系。现在：节流决定"该不该写"，内容由她看着今天的经历即兴写。
 * 固定池只剩一个用途：模型不可用时的离线兜底（且兜底也反重复）。
 */

/** 跨天重置单日计数 */
function ensureDiaryDay(now = Date.now()) {
  const day = dateKey(now)
  if (diaryDay !== day) {
    diaryDay = day
    diaryCount = 0
  }
}

/** 今天的心情轨迹（从情绪时间线压缩成一句，喂给生成用） */
function todayMoodJourney(now = Date.now()) {
  try {
    const { days } = readTimeline(1, now)
    const last = days && days.length ? days[days.length - 1] : null
    return formatMoodJourney(last ? last.points : [], now)
  } catch {
    return ''
  }
}

/**
 * 无头自测用的假日记模型：它只能看到上下文，却回一句引用了「今天素材」的话——
 * 若日记里出现这句话，就证明上下文真的传到了（NAGI_FAKE_DIARY=1）。
 */
function fakeDiaryLine(messages) {
  const ctx = (messages.find((m) => m.role === 'user') || {}).content || ''
  const hit = ctx.match(/- (\d{2}:\d{2}) 他：(.{0,18})/m)
  if (hit) return `……（自测）${hit[1]} 他说的那句「${hit[2]}」，我记下了。`
  return '……（自测）今天很安静。安静也算一种事。'
}

/**
 * 生成并落盘一条「心里话」。任何失败都静默——她记不记得写笔记，不该影响对话。
 * @returns {Promise<boolean>} 是否真的写了一条
 */
async function writeDiaryLine({ now = Date.now() } = {}) {
  if (diaryBusy) return false
  diaryBusy = true
  try {
    const snap = mood.current()
    const recent = recentDiaryLines(6) // 不该重复自己最近写过的话
    const useCache = shouldOfferCache({ now, weekCount: cacheLeakCount(now) }) // 深夜残片：5% × 每周上限 1
    const fakeDiary = process.env.NAGI_FAKE_DIARY === '1'
    const settings = getSettings()
    const llm = resolveLlm(settings.llm || {})
    const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
    const useCloud = llm.provider === 'workbuddy' && process.env.NAGI_FAKE_LLM !== '1' && !fakeDiary
    const canGenerate = fakeDiary || hasKey || useCloud

    let text = ''
    if (canGenerate) {
      if (useCloud && !cloudBrainStatus().ok) {
        try {
          await initCloudBrain()
        } catch {
          /* 初始化失败交给离线兜底 */
        }
      }
      const messages = buildDiaryMessages({
        now,
        mood: snap,
        moodJourney: todayMoodJourney(now),
        events: todayEvents(now),
        memories: memoryLines(),
        relation: relationSummary(),
        recentDiaries: recent,
        cacheAllowed: useCache
      })
      try {
        if (fakeDiary) {
          text = sanitizeDiaryLine(fakeDiaryLine(messages))
        } else {
          const client = hasKey ? createClient({ apiKey: getSecret(SECRET_KEYS.LLM_API_KEY), baseURL: llm.baseURL }) : null
          // temperature 给高一点：这是"心里话"，不该像客服话术一样收敛
          text = sanitizeDiaryLine(await callModelOnce({ client, llm, useCloud, messages, temperature: 0.9 }))
        }
      } catch (err) {
        console.warn('[diary] 生成失败，转离线兜底：', err && err.message)
      }
    }

    const generated = !!text
    if (!text || recent.some((r) => isTooSimilar(text, r))) {
      text = pickFallbackDiary({ mood: snap, recent })
      if (text && recent.some((r) => isTooSimilar(text, r))) text = '' // 兜底也全撞车：这一条宁可不写
    }
    if (!text) return false

    appendDiary(snap, text, { kind: 'inner' })
    // 泄露计数：只在"真的由模型写出来、且当时给了缓存许可"时记一笔（护栏：极低频）
    if (useCache && generated) noteCacheLeak(now)
    lastDiaryAt = now
    ensureDiaryDay(now)
    diaryCount++
    console.log(`[diary] ${generated ? '生成' : '兜底'}一条（${snap.label}）：${text}`)
    return true
  } catch (err) {
    console.warn('[diary] 写日记出错：', err && err.message)
    return false
  } finally {
    diaryBusy = false
  }
}

/**
 * 节流后决定是否动笔。刻意不 await——写日记不该阻塞任何事。
 * @param {'ambient'|'after-chat'} trigger
 */
function maybeWriteDiary(trigger = 'ambient') {
  const now = Date.now()
  ensureDiaryDay(now)
  const d = shouldWriteNow({ now, lastWriteAt: lastDiaryAt, todayCount: diaryCount }, trigger)
  if (!d.go) return false
  void writeDiaryLine({ now })
  return true
}

/* ---------------- 活动监测（M3）：她看你在做什么，忍不住主动开口 ---------------- */

/**
 * 她说一句主动的话（活动监测 / 日程提醒共用）：提情绪 → 广播 → 记进内心独白日记。
 * force=true 用于日程提醒这类「不能错过」的事——正在对话时也要开口；
 * 活动监测的主动搭话不带 force，正在对话时不抢话，只安静记一笔。
 */
function saySomething({ mood: hitMood, text, kind = 'proactive', source = 'monitor', force = false } = {}) {
  if (!text) return false
  if (hitMood) {
    mood.propose(hitMood, 0.5, source)
    broadcastMood()
  }
  const snap = mood.current()
  if (force || !busy) broadcast(EVT.PET, { kind, text, expr: snap.expr })
  appendDiary(snap, text)
  // 记进「今天发生的事」：她开过口、提醒过什么，都是她这一天的一部分
  try {
    noteEvent({ kind: kind === 'reminder' ? 'reminder' : 'proactive', text })
  } catch {
    /* 记流水失败不影响开口 */
  }
  return true
}

/** 活动监测触发：她看你在做什么，忍不住开口（正在对话时不抢话） */
function handleProactive({ mood: hitMood, text, ruleId }) {
  if (!text) return
  console.log(`[monitor] 主动搭话（${ruleId}）：${text}`)
  saySomething({ mood: hitMood, text, kind: 'proactive', source: 'monitor' })
}

/** 启动活动监测（app ready 后调用；幂等）。总开关在 settings.privacy.monitorEnabled */
export function startActivityMonitor() {
  startMonitor({ onProactive: handleProactive })
}

export function stopActivityMonitor() {
  stopMonitor()
}

/* ---------------- 日程提醒（M4）：她替你记着的事，到点由她开口 ---------------- */

/**
 * 到点提醒：优先用她自己想好的话（say），否则从 proactive.reminder 池临场挑一句。
 * 这是「不能错过」的事，force=true —— 正在对话时也开口。
 */
function handleReminderDue(item) {
  if (!item || !item.text) return
  const line = item.say || NagiPersona.pickProactive('reminder', { what: item.text }) || `……提醒你：${item.text}。`
  console.log(`[reminder] 到点：${item.text}`)
  saySomething({ mood: 'smile', text: line, kind: 'reminder', source: 'reminder', force: true })
}

/** 启动日程提醒调度器（app ready 后调用；幂等） */
export function startReminders() {
  startReminderEngine({ onDue: handleReminderDue })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 未配置 key / 云端不可用时的本地占位大脑（D4：persona 关键词规则版）
 *  2026-10-14 去模板化：传入时段等情境，由 persona.reply 做反重复组合；
 *  首轮明确告知"这是本地占位大脑"，让用户知道差距来自哪里而不是以为她本来就这样。 */
async function mockRun(userText, emit, { announce = false } = {}) {
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.THINKING })
  const r = NagiPersona.reply(userText, { slot: timeSlot(new Date()), moodLabel: mood.label() })
  emit({ type: AGENT_EVENT.EMOTION, emotion: r.expr, intensity: 1 })
  let body = r.text
  if (announce) body = body + '\n（……现在的我只有这么点脑子。接上真大脑，我会说得更像样。）'
  for (const ch of body) {
    emit({ type: AGENT_EVENT.TEXT_DELTA, text: ch })
    await sleep(18)
  }
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
  emit({ type: AGENT_EVENT.DONE, text: body })
  // 占位大脑同样记账：否则接上真大脑之前的对话全部从上下文里消失
  try {
    ensureHistory()
    history = [...history, { role: 'user', content: userText }, { role: 'assistant', content: body }].slice(-MAX_HISTORY)
    saveHistory(history)
  } catch (err) {
    console.warn('[memory] 历史落盘失败：', err.message)
  }
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

/** 即将到点的提醒（最多 3 条），拼成「此刻」里的一行注记；没有则返回空数组 */
function upcomingReminderLines(now = Date.now()) {
  try {
    const list = listReminders(now)
      .filter((x) => !x.doneAt && x.at > now)
      .slice(0, 3)
      .map((x) => `${x.when} ${x.text}`)
    return list.length ? [`你替他记着的提醒（到点你会主动开口）：${list.join('；')}`] : []
  } catch {
    return []
  }
}

/**
 * 向量检索召回的往事片段（RAG）。
 * 任何异常、引擎未就绪、超时都返回空数组——最坏情况只是这一轮没有往事，
 * 与不开 RAG 时逐字一致。她记不起来的时候，也照样能把话接下去。
 */
async function recalledPieces(query) {
  try {
    const r = await getRag().recall(query)
    return Array.isArray(r.results) ? r.results.map((x) => x.piece).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 组装本轮消息。之所以是 async：开 RAG 时要先检索一次「相关往事」再拼上下文。
 * 检索自带超时与静默降级，不会拖慢回复（见 recalledPieces）。
 */
async function buildMessages(userText, supportsNative) {
  ensureHistory()
  const snap = mood.current()
  // 「此刻」上下文：时间/时段、距上次互动多久、当前情绪及强度、长期记忆、
  // 检索召回的往事、她最近说过的话。
  // 原先是在 user 消息前塞一句"（凪当前的情绪：担心）"，信息量太薄且会把模型钉在同一个
  // 情绪标签上；改为结构化注入，并且顺带给出"不要重复这些说法"的反复读约束。
  const context = buildContextBlock({
    now: Date.now(),
    lastInteractionAt: lastInteractionAt(),
    mood: snap,
    relation: relationSummary(),
    memories: memoryLines(),
    recalled: await recalledPieces(userText),
    recentReplies: recentAssistantReplies(history, 4),
    // 她替你记着的提醒：让她知道「有这几件事等着」，别把答应过的事忘了
    extra: upcomingReminderLines()
  })
  return [
    { role: 'system', content: buildSystemPrompt({ nativeTools: supportsNative, context }) },
    ...history,
    { role: 'user', content: userText }
  ]
}

/**
 * 单轮非流式取一次模型输出（长期记忆抽取用）。
 * 与主对话共用同一通道，不影响主流程；失败由调用方吞掉。
 */
async function callModelOnce({ client, llm, useCloud, messages, temperature = 0.2 }) {
  let out = ''
  const stream = useCloud
    ? await cloudChatStream({ messages })
    : await chatStream(client, { model: llm.model, messages, temperature })
  for await (const evt of stream) {
    if (evt.type === 'delta') out += evt.text || ''
    else if (evt.type === 'done') break
  }
  return out
}

/**
 * 长期记忆抽取（fire-and-forget）：一轮对话结束后，让模型判断有没有"值得以后还记得的事"，
 * 输出增删指令合并进 memory.json。异步且不阻塞回复；任何失败都静默（不能因为她记笔记失败
 * 而影响对话）。太短的寒暄直接跳过，省一次调用。
 */
function extractMemoriesAsync({ client, llm, useCloud, userText, assistantText }) {
  const u = String(userText || '').trim()
  const a = String(assistantText || '').trim()
  if (u.length < 6 || a.length < 6) return
  const existing = memoryLines()
  const messages = [
    { role: 'system', content: MEMORY_EXTRACT_PROMPT },
    {
      role: 'user',
      content:
        `他：${u}\n我：${a}\n\n已有记忆：\n` +
        (existing.length ? existing.map((x) => '- ' + x).join('\n') : '（空）')
    }
  ]
  callModelOnce({ client, llm, useCloud, messages })
    .then((raw) => {
      const ops = parseMemoryOps(raw)
      if (!ops.add.length && !ops.remove.length) return
      const r = mergeMemoryOps(ops)
      console.log('[memory] 记忆更新：', r.before, '→', r.after, ops.add.length ? '新增 ' + ops.add.join(' / ') : '')
      // 同步一份进向量档案：memory.json 只在「条数不多」时全量注入提示词，
      // 攒多了就注不下去了；向量侧靠语义检索，条数不是问题。
      syncFactsToRag(r.added, r.removed)
    })
    .catch((err) => console.warn('[memory] 抽取失败（忽略）：', err.message))
}

/** 记忆增删 → 向量档案同步（失败静默，档案落不下不影响对话） */
function syncFactsToRag(added, removed) {
  try {
    const rag = getRag()
    for (const t of added || []) if (t) rag.ingestFact({ text: t })
    for (const t of removed || []) if (t) rag.forgetText(t)
  } catch {
    /* 档案写入失败不影响对话 */
  }
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
  ensureHistory()
  const settings = getSettings()
  const llm = resolveLlm(settings.llm || {})
  const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
  const fakeLlm = process.env.NAGI_FAKE_LLM === '1'
  const useCloud = llm.provider === 'workbuddy' && !fakeLlm

  if (!hasKey && !fakeLlm && !useCloud) {
    const first = !mockAnnounced
    mockAnnounced = true
    return mockRun(userText, emit, { announce: first })
  }

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
  const system = createSystemTools({ cwd: app.getPath('home'), fileRoot })
  const ha = getHa()
  const executeTool = createToolRunner({
    files,
    system,
    browser: browserTools,
    ha,
    native: nativeTools,
    reminders: reminderTools()
  })

  const messages = await buildMessages(userText, supportsNative)
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
    signal: currentAbort.signal
  })

  // 写入历史（messages 已含 system + 旧历史 + 本轮 user + 工具过程，再补最终回复）
  if (r.text) messages.push({ role: 'assistant', content: r.text })
  trimHistory(messages)
  try {
    saveHistory(history)
  } catch (err) {
    console.warn('[memory] 历史落盘失败：', err.message)
  }
  // 长期记忆抽取：异步、不阻塞、失败静默（她记笔记不该拖慢说话）
  extractMemoriesAsync({ client, llm, useCloud, userText, assistantText: r.text })
  return r.text
}

/** 对外：发送一条用户消息 */
export async function handleChatSend(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '空消息' }
  if (busy) return { ok: false, error: '正在处理上一条消息' }
  busy = true
  mood.noteInteraction() // 连聊 burst 统计 + 刷新互动时间
  noteRelationInteraction() // 关系层记账：认识多久、聊过多少次、活跃几天
  const emit = (e) => emitAgentEvent(e)
  let reply = ''
  try {
    reply = await runTurn(t, emit)
    return { ok: true }
  } catch (err) {
    emit({ type: AGENT_EVENT.ERROR, message: err && err.message ? err.message : String(err) })
    emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
    return { ok: false, error: err?.message }
  } finally {
    // 记进「今天发生的事」：不管这一轮成没成，他找她说过话这件事都发生过——
    // 日记里不该出现"空白的一天"。素材少一段，也比白纸强。
    try {
      noteEvent({ kind: 'chat', user: t, reply: String(reply || '') })
    } catch {
      /* 记流水失败不影响对话 */
    }
    // 这轮对话进长期档案（向量检索用）。
    // 放在 finally 里：不管这轮是 mock 大脑、真大脑还是中途出错，只要她开了口，
    // 这段对话就真实发生过，该进档案。RAG 未就绪时这只是一行 pending 文本。
    try {
      if (reply) getRag().ingestTurn({ user: t, assistant: reply, mood: mood.current().mood })
    } catch {
      /* 进档案失败不影响对话 */
    }
    // 刚聊完，是她最可能想记一笔的时刻（写不写由节流内部决定）
    maybeWriteDiary('after-chat')
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
  noteRelationInteraction() // 关系层同样记一笔（戳也算搭理她）
  try {
    noteEvent({ kind: 'poke' })
  } catch {
    /* 记流水失败不影响反应 */
  }
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
  stopActivityMonitor()
  stopReminderEngine()
  try {
    await browserTools.dispose()
  } catch {
    /* ignore */
  }
  if (haClient) haClient.stopEvents()
  try {
    flushPersist() // 把防抖中的记忆/历史立刻刷盘
  } catch {
    /* ignore */
  }
  flushJournal() // 把防抖中的事件流水立刻刷盘
  try {
    getRag().dispose() // 停掉待嵌定时器与预热定时器
  } catch {
    /* ignore */
  }
}

/* ---------------- 长期记忆 / 历史 IPC ---------------- */
export function memoryList() {
  return listMemories()
}
export function memoryAdd(text) {
  return addMemory(text)
}
export function memoryRemove(payload) {
  return removeMemory(payload || {})
}
export function historyClear() {
  clearHistory()
  history = []
  historyLoaded = true
  return { ok: true }
}

/* ---------------- 关系层 IPC（S4） ---------------- */

/** 关系摘要 + 当前情绪（关系页头部用） */
export function relationInfo() {
  return { relation: relationSummary(), mood: mood.current() }
}

/** 情绪时间线（默认近 7 天） */
export function timelineData(days) {
  return readTimeline(Number(days) || 7)
}

/* ---------------- 日程提醒 IPC（M4） ---------------- */
export function reminderList() {
  return listReminders()
}
export function reminderAdd(payload) {
  const r = addReminder(payload || {})
  return r.ok ? { ok: true, item: r.item, items: listReminders() } : { ok: false, error: r.error }
}
export function reminderRemove(payload) {
  const r = removeReminder(payload || {})
  return r.ok ? { ok: true, removed: r.removed, items: listReminders() } : { ok: false, error: r.error }
}
export function reminderDone(id) {
  const r = completeReminder(id)
  return r.ok ? { ok: true, items: listReminders() } : { ok: false, error: r.error }
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
