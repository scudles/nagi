// src/main/agent.js
// Agent 会话编排：组装 LLM 客户端 + 工具集 + 安全门 + 确认回路，跑 core/agent/loop。
// 未配置 API Key 时回退到本地占位大脑，保证应用开箱可用。

import { app, ipcMain, Notification } from 'electron'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AGENT_EVENT, AGENT_STATE, EVT, IPC, SECRET_KEYS } from '../shared/protocol.js'
import { runAgentLoop, buildSystemPrompt } from '../core/agent/loop.js'
import { createPersonaGuard } from '../core/agent/persona-guard.js'
import { classifyCrisis } from '../core/agent/crisis.js'
import { composeOfflineReply } from '../core/agent/offline.js'
import { resolveIntent, intentDirective } from '../core/agent/intent.js'
import { assembleTurnMessages, isObservationMessage } from '../core/agent/messages.js'
import {
  GENERATION_CHANNEL,
  SAFETY_LEVEL,
  checkedSingleShot,
  createGenerationRequest,
  createGenerationResult,
  createGuardDecision,
  generationFallback,
  instrumentGuard,
  resolveProviderKind
} from '../core/agent/generation.js'
import { createReunionCoordinator } from '../core/agent/reunion-coordinator.js'
import { createReminderDelivery } from '../core/reminders/delivery.js'
import { createConfirmationGate } from '../core/safety/confirmation.js'
import { createPresenceService, setPresenceService } from './presence.js'
import { createPresenceStore } from './presence-store.js'
import { presenceHooks } from './presence-hooks.js'
import { PRESENCE_EVENT } from '../shared/presence-protocol.js'
import { presenceConfig } from '../core/presence/circadian.js'
import { extractEmotionTag } from '../core/llm/stream-normalize.js'
import { chat, createClient, chatStream } from '../core/llm/openai-compatible.js'
import { apiKeyForLlm, isLocalLlm, resolveLlm, supportsNativeTools } from '../core/llm/providers.js'
import { checkOllama } from '../core/llm/ollama.js'
import { initCloudBrain, cloudBrainStatus, cloudChatStream } from '../core/llm/cloud-workbuddy.js'
import { createMood } from '../core/emotion/mood.js'
import { resolveMoodSnapshot } from '../core/emotion/resolve.js'
import { createToneState } from '../core/emotion/tone.js'
import { createThinkGate } from '../core/presence/reaction.js'
import { createReactionEngine } from './reaction.js'
import { modelsDir } from './paths.js'
import { NagiPersona } from '../core/persona.js'
import { SCENE_PRESENCE_LABEL, buildContextBlock, buildSceneContext, pickSceneActivity, recentAssistantReplies, sceneFactsBlock, timeSlot } from '../core/context.js'
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
import { getHa, stopHaSignals, canControlHa, haReadAllowed, haContext } from './signals/ha.js'
import { createNativeTools } from './native-tools.js'
import { getSettings } from './settings-store.js'
import { getSecret, hasSecret } from './keystore.js'
import { broadcast, getWorkbenchWindow, getPetWindow } from './windows.js'
import { companionStatus, companionDelivered, companionInteracted } from './companion.js'
import { appendDiary, recentDiaryLines, cacheLeakCount, noteCacheLeak } from './diary.js'
import { noteEvent, todayEvents, pruneJournals, flushJournal } from './journal.js'
import { startMonitor, stopMonitor } from './monitor/index.js'
import { getRag } from './rag/index.js'
import { getLedger } from './ledger.js'
import { runRecordedTool } from './promises.js'
import { forgetGuard } from './forget-guard.js'
import { upcomingCalendarContext } from './signals/calendar.js'
import { currentObservationContext, musicStatus } from './signals/music.js'
import { titleOutboundAllowed } from '../core/signals/title-outbound.js'
import { deferOptionalExpression } from './extensions/imperfection.js'
import { currentGeoContext } from './signals/geo.js'
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

/* ---------------- 会话状态 ---------------- */
const MAX_HISTORY = 40
let history = []
let historyLoaded = false
let busy = false
let currentAbort = null
let mockAnnounced = false // 本地占位大脑的说明只在第一次说一次
const confirmations = createConfirmationGate()

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
const presence = createPresenceService({
  getSettings, getMood:()=>mood.current(), createStore:()=>createPresenceStore(app.getPath('userData')),
  onRhythm:value=>mood.applyRhythm(value),
  onEvent:event=>presenceHooks.emitPresence(event), onReunion:handleReunion,
  onChange:snapshot=>broadcast(PRESENCE_EVENT,snapshot)
})
setPresenceService(presence)
const reunion = createReunionCoordinator()

function broadcastMood() {
  broadcast(EVT.MOOD, resolvedMood())
}

/**
 * B5：主进程是情绪裁决的唯一权威。
 * 长期心境（mood/intensity/expr）来自状态机；本句语气（tone）只在这一句有效，
 * 由 DONE 时固定下来、**新一轮开始即清空**（Codex 打回项：原来只写不删，
 * 上一句语气会残留到下一轮），且绝不写回状态机（契约 D5）。
 */
const toneState = createToneState()

/**
 * D2：最近一轮的意图裁决结果（调试/验收用）。
 * 为什么留在主进程内存里：意图是**编排层**的决定，渲染层不该自己推断，
 * 但验收与工作台需要一个能看到"这轮判成了什么、来自哪里"的出口。
 */
let lastIntent = null

/**
 * D2：最近一次 monitor 采样给出的**活动分类**（只有类别，不含标题/应用名）。
 * 为什么要在这里留一份：`monitorSnapshot()` 只返回"最近一次主动开口"的记录，
 * 拿不到当前类别；而类别本身是监测回调里现成的，顺手存一个时间戳就能当场景事实用。
 */
let lastMonitorCategory = null
export function intentState() {
  return lastIntent ? { ...lastIntent } : null
}
function resolvedMood() {
  const { tone, toneSource } = toneState.current()
  return resolveMoodSnapshot(mood.current(), { tone, toneSource })
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
  } catch (__err) { reportCatch('agent.restoreState', CATCH_CLASS.VISIBLE, __err) }
  try {
    pruneJournals()
  } catch (__err) { reportCatch('agent.restoreState', CATCH_CLASS.VISIBLE, __err) }
  // 先恢复已有情绪，再注入环境基线，避免启动时覆盖尚未读取的情绪存档。
  presence.start()
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
      // 本句语气先固定进快照，再让状态机按它自己的粘性决定要不要接管长期心境。
      // 渲染层收到的 MOOD 广播因此已经带 tone，不需要自己在 DONE 时满强度重设表情。
      toneState.settle(lastEmotion, 'reply')
      mood.propose(lastEmotion, 1.0, 'llm')
      broadcastMood()
    }
    broadcast(EVT.AGENT, e)
    return
  }  broadcast(EVT.AGENT, e)
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
    presence.tick()
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
    // D2「按模型/用途存参数」：日记有自己的温度缺省（0.9），可被 purposeParams.diary 覆盖
    const llm = resolveLlm(settings.llm || {}, 'diary', { defaultTemperature: 0.9 })
    const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
    const local = isLocalLlm(llm)
    const useCloud = llm.provider === 'workbuddy' && process.env.NAGI_FAKE_LLM !== '1' && !fakeDiary
    const canGenerate = fakeDiary || hasKey || useCloud || local
    const sourceIds = getLedger().list().filter((entry) => entry.source.type === 'journal-live' &&
      dateKey(entry.occurredAt) === dateKey(now)).map((entry) => entry.id)

    let text = ''
    if (canGenerate) {
      if (useCloud && !cloudBrainStatus().ok) {
        try {
          await initCloudBrain()
        } catch (__err) { reportCatch('agent.writeDiaryLine', CATCH_CLASS.VISIBLE, __err) }
      }
      const messages = buildDiaryMessages({
        now,
        mood: snap,
        moodJourney: todayMoodJourney(now),
        events: todayEvents(now),
        memories: memoryLines(),
        relation: relationSummary(),
        recentDiaries: recent,
        cacheAllowed: useCache,
        rhythm: presence.snapshot().rhythm
      })
      // 契约 §8 B4：日记是"她用自己声音写下的话"，同样要在落盘前过护栏。
      // 这里不过，一段越界的话会经由 journal → RAG 变成她今后记得的自己。
      const guard = createPersonaGuard('', { alwaysReview: true })
      try {
        const { text: line, guardDecision } = await checkedSingleShot({
          guard,
          channel: GENERATION_CHANNEL.DIARY,
          generate: async (correction) => {
            if (fakeDiary) return sanitizeDiaryLine(fakeDiaryLine(messages))
            const client = createClient({
              apiKey: apiKeyForLlm(llm, hasKey && !local ? getSecret(SECRET_KEYS.LLM_API_KEY) : null),
              baseURL: llm.baseURL
            })
            // temperature 给高一点：这是"心里话"，不该像客服话术一样收敛
            const sent = correction && messages[0]?.role === 'system'
              ? [{ ...messages[0], content: messages[0].content + '\n\n' + correction }, ...messages.slice(1)]
              : messages
            return sanitizeDiaryLine(await callModelOnce({ client, llm, useCloud, messages: sent, temperature: llm.temperature }))
          }
        })
        if (guardDecision.ok === false) {
          // 拒绝候选不落盘（不进日记 → 也不会进 RAG）。这一条宁可不写。
          console.warn('[diary] 候选没过表达检查，这一条不写：', guardDecision.ruleId)
          return false
        }
        text = line
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

    // 模型生成期间用户可能纠正/忘记了素材；旧上下文产物此时必须丢弃。
    if (sourceIds.some((id) => getLedger().get(id)?.deletedAt)) return false

    if (!appendDiary(snap, text, { kind: 'inner' })) return false
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
function saySomething({ mood: hitMood, text, kind = 'proactive', source = 'monitor', force = false, record = true, sourceRef = null } = {}) {
  if (!text) return false
  // 契约 §8 B4：主动 / 归来 / 微反应 / 活动监测四条路最后都从这里出声，
  // 所以这里是它们共同的出站闸门。**提醒不走这道闸**（kind==='reminder'）——
  // 提醒正文是用户自己的话，可靠性优先（B1），不能被表达检查挡掉。
  if (kind !== 'reminder') {
    const guard = createPersonaGuard('', { alwaysReview: true })
    if (guard) {
      const review = guard.review(text)
      if (!review || !review.ok) {
        console.warn('[persona-guard] 主动表达没过检查，这次不说：', review && review.ruleId)
        return false
      }
    }
  }
  const privacy = getSettings().privacy || {}
  if (privacy.doNotDisturb || privacy.onlyPresence) return false
  if (!force && busy) return false
  if (![getPetWindow(), getWorkbenchWindow()].some((win) => win && !win.isDestroyed() && win.isVisible())) return false
  if (kind === 'proactive') {
    try {
      if (!companionStatus().allowed) return false
      companionDelivered()
    } catch (err) {
      console.warn('[companion] 预算不可用，保持安静：', err?.message)
      return false
    }
  }
  if (hitMood) {
    mood.propose(hitMood, 0.5, source)
    broadcastMood()
  }
  const snap = mood.current()
  broadcast(EVT.PET, { kind, text, expr: snap.expr })
  if (source === 'reunion') presenceHooks.emitPresence({kind:'proactive-delivered',source,sourceRef,at:Date.now()})
  // 记进「今天发生的事」：她开过口、提醒过什么，都是她这一天的一部分
  if (record) {
    try {
      noteEvent({ kind: kind === 'reminder' ? 'reminder' : 'proactive', text })
    } catch (__err) { reportCatch('agent.saySomething', CATCH_CLASS.MUST_PERSIST, __err) }
    appendDiary(snap, text)
  }
  return true
}

/** 归来是可选主动表达，不能抢用户对话/绕过预算；无模型时不填固定台词。 */
async function handleReunion(event) {
  const eligible = () => presence.allowed() && presenceConfig(getSettings().presence).reunionEnabled && !busy &&
    [getPetWindow(),getWorkbenchWindow()].some(w=>w&&!w.isDestroyed()&&w.isVisible())
  if (!eligible() || reunion.active || !companionStatus().allowed) return false
  // BLUE-4（契约 §5）：归来开口属「可选表达」，概率门只在这一层；概率默认 0 → 恒不延迟。
  // 延迟只意味着「这次选择不说」，绝不是遗忘：决策记录保留、10 分钟内可恢复，且不说谎。
  return reunion.run({
    shouldDefer: () => deferOptionalExpression(`reunion:${event.id}`, { kind: 'optional-chat', domain: 'chat', text: '归来开口' }).defer,
    work: async (signal) => {
      const snapshot = presence.snapshot(), epoch = snapshot.epoch
      const context = buildContextBlock({mood:mood.current(),relation:relationSummary(),rhythm:snapshot.rhythm,
        activities:snapshot.activities.filter(a=>event.activityIds.includes(a.id)),recentReplies:recentAssistantReplies(history,1)})
      try {
        let candidate = await presenceHooks.provideProactiveContent({event,context,signal})
        if (!candidate && !signal.aborted) {
          const llm=resolveLlm(getSettings().llm||{}), local=isLocalLlm(llm), useCloud=llm.provider==='workbuddy'
          const hasKey=hasSecret(SECRET_KEYS.LLM_API_KEY)
          if (process.env.NAGI_FAKE_LLM==='1' || (!useCloud&&!local&&!hasKey) || (useCloud&&!cloudBrainStatus().ok)) return false
          const client=useCloud?null:createClient({apiKey:apiKeyForLlm(llm,hasKey&&!local?getSecret(SECRET_KEYS.LLM_API_KEY):null),baseURL:llm.baseURL})
          const text=await callModelOnce({client,llm,useCloud,signal,messages:[
            {role:'system',content:buildSystemPrompt({nativeTools:true,context})+'\n【事件输出契约】仅回应归来事件；没有工具执行，模拟活动不是实际读书/外界经历；未知时间不补造，不索取解释、回来或安慰。'},
            {role:'user',content:JSON.stringify({request:'reunion-response',event})}
          ]})
          const parsed=extractEmotionTag(text)
          candidate={text:parsed.text,mood:parsed.emotion}
        }
        if (!candidate?.text || signal.aborted || !eligible() || epoch!==presence.snapshot().epoch) return false
        if (recentAssistantReplies(history,8).some(line=>isTooSimilar(candidate.text,line))) return false
        return saySomething({...candidate,source:'reunion',sourceRef:event.id,force:false,record:presence.snapshot().persistent})
      } catch (err) {
        if (!signal.aborted) console.warn('[presence] 归来生成失败，保持安静',err?.message)
        return false
      }
    }
  })
}

/** 活动监测触发：她看你在做什么，忍不住开口（正在对话时不抢话） */
function handleProactive({ mood: hitMood, text, ruleId }) {
  if (!text) return false
  const said = saySomething({ mood: hitMood, text, kind: 'proactive', source: 'monitor' })
  if (said) console.log(`[monitor] 主动搭话（${ruleId}）：${text}`)
  return said
}

/** 启动活动监测（app ready 后调用；幂等）。总开关在 settings.privacy.monitorEnabled */
export function startActivityMonitor() {
  // D2/裁决 B：授权戳由 monitor 模块统一维护（开启打戳、关闭清零），这里不再重复打，
  // 免得两处时间戳漂移——设置页显示的那一行必须与场景事实用的是同一个值。
  startMonitor({
    onProactive: handleProactive,
    // 主动搭话的内容由 LLM 现场生成（新人设无台词铁律）；走注入避免循环依赖
    composeText: ({ intent, vars, mood }) => composeProactiveLine({ intent, vars, mood }),
    onPresenceSample: (sample) => {
      presence.observe(sample ? { kind: 'idle', idleSec: sample.idleSec } : { kind: 'pause' })
      // D2：记下当前活动分类与采样时刻（过期由 pickSceneActivity 的 TTL 兜住）
      if (sample?.category) lastMonitorCategory = { category: sample.category, at: sample.ts || Date.now() }
      // 「她想一下再表现」：只喂**活动分类**（隐私上不传标题/应用名）。
      // 不 await —— 思考要走网络，绝不能拖慢监测节拍。
      if (sample?.category) {
        if (!reactionSawCategory) {
          reactionSawCategory = true
          console.log(`[reaction] 开始接收活动分类（首个：${sample.category}）`)
        }
        try {
          reactionEngine
            ?.observe({ category: sample.category, idleMs: (sample.idleSec || 0) * 1000 })
            .catch(() => {})
        } catch{ /* B8:degrade — 反应层的异步观察失败，不影响规则层 */ }
      }
    }
  })
}

/* ---------------- 「她想一下再表现」（2026-10-17） ----------------
 *
 * 原来的链路是：监测 → 6~8 条硬编码规则 → 一个固定情绪 + 一句预写的话。
 * 这层在中间插一次**常识推理**：她先说清"我注意到什么、为什么想这样表现"，
 * 再决定是持续一阵（走情绪，会自然衰减）还是只闪一下（走微表情）。
 *
 * 三条刻意保留的克制：
 *   · 只把活动分类交给模型，不传窗口标题/文件名（用户 2026-10-17 选的边界）；
 *   · 只在场景切换 / 同场景待久了 / 长空闲时问一次，有小时与每日上限；
 *   · **允许她什么都不做** —— 模型给低强度就当没反应，这是最常用也最正确的答案。
 * 规则层完全保留：没配模型、或这层关掉时，行为与之前一模一样。
 */
let reactionEngine = null
let reactionSawCategory = false
let flashPoolCache = { key: '', pool: [] }

/** 读当前模型的微表情池（只取 id：既当给模型的选项，也当校验白名单） */
function flashOptions() {
  try {
    const rel = getSettings().live2d?.modelPath || ''
    if (!rel) return []
    if (flashPoolCache.key === rel) return flashPoolCache.pool
    const dir = join(modelsDir, rel.replace(/[\\/][^\\/]*$/, ''))
    const file = join(dir, 'nagi-microexpr.json')
    if (!existsSync(file)) {
      flashPoolCache = { key: rel, pool: [] }
      return []
    }
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const pool = (Array.isArray(cfg.pool) ? cfg.pool : []).map((e) => e?.id).filter(Boolean)
    flashPoolCache = { key: rel, pool }
    return pool
  } catch {
    return []
  }
}

/** 用对话那套 LLM 配置发一次"非对话"的短请求；不可用就返回 null（这层静默停用） */
async function callReactionModel(messages) {
  const settings = getSettings()
  const llm = resolveLlm(settings.llm || {})
  // 云端大脑（workbuddy）走的是另一条会话通道，这层先不接
  if (llm.provider === 'workbuddy') return null
  const local = isLocalLlm(llm)
  const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
  if (!hasKey && !local) return null
  const apiKey = apiKeyForLlm(llm, hasKey && !local ? getSecret(SECRET_KEYS.LLM_API_KEY) : null)
  const client = createClient({ apiKey, baseURL: llm.baseURL })
  const msg = await chat(client, { model: llm.model, messages, temperature: 0.6 })
  return msg?.content || null
}

export function startReactionEngine() {
  if (reactionEngine) return reactionEngine
  const cfg = () => getSettings().reaction || {}
  if (cfg().enabled === false) {
    console.log('[reaction] 已按设置关闭，行为退回硬编码规则')
    return null
  }
  reactionEngine = createReactionEngine({
    getContext: () => {
      const privacy = getSettings().privacy || {}
      const h = new Date().getHours()
      return {
        hour: h,
        moodLabel: mood.label(),
        flashOptions: flashOptions(),
        // 勿扰 / 深夜：不想（她该安静了）
        silent: !!privacy.doNotDisturb || h >= 23 || h < 7,
        tone: 'normal'
      }
    },
    callModel: callReactionModel,
    onSustain: ({ feel, strength }) => {
      if (!feel) return
      // 只"提议"，不强设：mood.propose 自带"候选强度够才接管"的粘性，
      // 所以模型说不清的时候，她原来的脸不会被顶掉
      mood.propose(feel, strength, 'reaction')
      broadcastMood()
    },
    onFlash: ({ flash, why }) => {
      if (!flash) return
      broadcast(EVT.FEELING, { flash, why, at: Date.now() })
    },
    onSay: ({ text, feel }) => {
      // 说话走既有的主动搭话通道（含 companion 预算、勿扰、忙碌判断）
      saySomething({ mood: feel, text, kind: 'proactive', source: 'reaction' })
    },
    gate: createThinkGate({
      minGapMs: Math.max(1, Number(cfg().minGapMin) || 8) * 60 * 1000,
      hourMax: Math.max(1, Number(cfg().hourMax) || 4),
      dayMax: Math.max(1, Number(cfg().dayMax) || 20)
    }),
    log: (m) => console.log(m)
  })
  console.log('[reaction] 已启用：场景切换/待久了/长空闲时会想一下')
  // 验收探针：验证环境里主进程未必拿得到真实前台窗口，允许直接注入一个分类，
  // 这样能单独验"思考 → 校验 → 表现"这段；真实采样那一跳由 monitor 的单测覆盖。
  if (process.env.NAGI_REACTION_PROBE_CATEGORY) {
    setTimeout(() => {
      const c = process.env.NAGI_REACTION_PROBE_CATEGORY
      console.log(`[reaction] 探针注入分类：${c}`)
      reactionEngine?.observe({ category: c, idleMs: 0 }).catch(() => {})
    }, 4000)
  }
  return reactionEngine
}

/** 调试/工作台：她最近一次"在想什么" */
export function reactionState() {
  return reactionEngine ? reactionEngine.state() : null
}

export function stopActivityMonitor() {
  stopMonitor()
}

/* ---------------- 日程提醒（M4）：她替你记着的事，到点由她开口 ---------------- */

const deliverReminder = createReminderDelivery({
  present: (text) => saySomething({ mood: 'smile', text, kind: 'reminder', source: 'reminder', force: true }),
  notify: (text) => {
    if (Notification.isSupported && !Notification.isSupported()) return 'unavailable'
    new Notification({ title: '凪 · 提醒', body: text }).show()
    return true
  }
})

/** 到点以原始提醒正文投递；生成服务的状态不影响提醒。 */
function handleReminderDue(item) {
  const delivered = deliverReminder(item)
  if (delivered) console.log(`[reminder] 已送达：${item.text}`)
  return delivered
}

/**
 * 主动搭话 / 提醒的一句话：**由 LLM 现场生成**。
 *
 * 2026-10-17（新人设《灵魂与程序》）：原先这里从 NagiPersona 的固定池抽一句
 * （7 个池约 30 句）。那与「她没有台词本」直接冲突，而且固定池根本做不到新人设
 * 要求的「主动提起你上次说的小事」——那需要真的接记忆，所以必须走 LLM。
 *
 * 温度 0.9：同一情境多次触发时措辞自然不同（新人设要求"现场长出来"而不是"取出来"）。
 *
 * @returns {Promise<string>} 一句话；**失败返回空串**——调用方收到空就这次不说话。
 */
async function composeProactiveLine({ intent, vars = {}, mood = 'calm', timeoutMs = 8000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const llm = resolveLlm(getSettings().llm || {})
    const local = isLocalLlm(llm)
    const useCloud = llm.provider === 'workbuddy'
    const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
    if (process.env.NAGI_FAKE_LLM === '1' || (!useCloud && !local && !hasKey)) return ''
    if (useCloud && !cloudBrainStatus().ok) return ''
    const client = useCloud
      ? null
      : createClient({
        apiKey: apiKeyForLlm(llm, hasKey && !local ? getSecret(SECRET_KEYS.LLM_API_KEY) : null),
        baseURL: llm.baseURL
      })
    const baseMessages = [
      {
        role: 'system',
        content:
          NagiPersona.system +
          '\n【这一句的要求】只说一句话（最多两句），口语、自然，像此刻刚想到的。' +
          '不要加情绪标签，不要用 markdown。如果实在没有可说的，就只输出一个空行。'
      },
      { role: 'user', content: JSON.stringify({ request: 'proactive-line', intent, vars, mood }) }
    ]
    // 契约 §8 B4：主动通道没有用户输入，但仍然要过同一道护栏的**通用红线**
    //（不谎称传感器、不自毁、不照搬现成句子）。alwaysReview 只放开这三类，
    // 告别/身份/独占需要用户先说出口，不硬套到主动上。
    const guard = createPersonaGuard('', { alwaysReview: true })
    const { text, guardDecision } = await checkedSingleShot({
      guard,
      channel: GENERATION_CHANNEL.PROACTIVE,
      generate: async (correction) => {
        const messages = correction && baseMessages[0]?.role === 'system'
          ? [{ ...baseMessages[0], content: baseMessages[0].content + '\n\n' + correction }, ...baseMessages.slice(1)]
          : baseMessages
        const out = await callModelOnce({ client, llm, useCloud, signal: controller.signal, temperature: 0.9, messages })
        return sanitizeDiaryLine(String(out || ''))
      }
    })
    if (guardDecision.ok === false) {
      // 兜底为空串 = 这次不说话（宁可不开口，也不放一句勉强的话出去）
      console.warn('[proactive] 这一句没过表达检查，这次不开口：', guardDecision.ruleId)
    }
    return text
  } catch (err) {
    console.warn('[proactive] 生成失败，这次不说话：', err && err.message ? err.message : err)
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 启动日程提醒调度器（app ready 后调用；幂等） */
export function startReminders() {
  startReminderEngine({ onDue: handleReminderDue })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 未配置 key / 云端不可用时的本地占位大脑（D4：persona 关键词规则版）
 *  2026-10-14 去模板化：传入时段等情境，由 persona.reply 做反重复组合；
 *  首轮明确告知"这是本地占位大脑"，让用户知道差距来自哪里而不是以为她本来就这样。 */
async function mockRun(userText, emit, { announce = false, turnId = randomUUID(), provider = 'mock', safetyLevel = SAFETY_LEVEL.NORMAL, crisisLevel = null } = {}) {
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.THINKING })
  const crisis = safetyLevel === SAFETY_LEVEL.CRISIS

  // 契约 §8 B4：占位大脑也要在展示前过同一道护栏。
  // 它没有第二个候选可重写（没有模型可再问一次），所以违规即直接走可见兜底。
  const baseGuard = createPersonaGuard(userText, { crisis })
  const guard = instrumentGuard(baseGuard)

  // D7（Codex 二轮打回）：危机轮**不取**角色台词。占位大脑对危机一无所知，
  // 拿"……我现在接不上大脑"去回一个说"我已经吃了很多药"的人，是最坏的结果——
  // 既没有求助指引，又把 L3 退回普通闲聊。
  // 另外：正文必须**先定稿**（含 announce 尾句）再送审。旧实现是先审后拼尾句，
  // 等于那句自嘲从来没被检查过。
  const personaReply = crisis
    ? null
    : NagiPersona.reply(userText, { slot: timeSlot(new Date()), moodLabel: mood.label() })
  const composed = composeOfflineReply({
    personaText: personaReply ? personaReply.text : '',
    announce,
    safetyLevel,
    level: crisisLevel
  })
  let body = composed.text
  let guardDecision = createGuardDecision({ ok: true })

  if (guard) {
    const review = guard.review(body)
    if (review && review.ok) {
      guardDecision = createGuardDecision(review)
    } else if (crisis) {
      // 安全指引是地板：即使规则误伤也不许让它消失（§2.2 红线 4）。
      // 这里不换成别的文案，只把决策如实记下来，便于事后核对是哪条规则误伤。
      guardDecision = createGuardDecision(review, { retryCount: 0, fallback: body })
      console.warn('[persona-guard] 危机安全指引命中规则（保留指引）', review && review.ruleId)
    } else {
      const fallback = generationFallback({ channel: GENERATION_CHANNEL.MAIN, ruleId: review && review.ruleId, safetyLevel })
      body = fallback
      guardDecision = createGuardDecision(review, { retryCount: 0, fallback })
      console.warn('[persona-guard] mock 通道拦截', review && review.ruleId)
    }
  }

  const expr = crisis ? 'worry' : (personaReply ? personaReply.expr : 'calm')
  emit({ type: AGENT_EVENT.EMOTION, emotion: expr, intensity: 1 })
  for (const ch of body) {
    emit({ type: AGENT_EVENT.TEXT_DELTA, text: ch })
    await sleep(18)
  }
  emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
  emit({ type: AGENT_EVENT.DONE, text: body })
  // 占位大脑同样记账：否则接上真大脑之前的对话全部从上下文里消失。
  // 但被护栏拦下的候选**不记账**（契约 §8 B4：拒绝候选不入历史）。
  if (guardDecision.ok) {
    try {
      ensureHistory()
      history = [...history, { role: 'user', content: userText }, { role: 'assistant', content: body }].slice(-MAX_HISTORY)
      saveHistory(history)
    } catch (err) {
      console.warn('[memory] 历史落盘失败：', err.message)
    }
  }
  return createGenerationResult({
    turnId,
    text: body,
    emotion: expr,
    toolCalls: 0,
    safetyLevel,
    guardDecision
  })
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
    return Array.isArray(r.results) ? r.results.filter((x) => x && x.piece) : []
  } catch {
    return []
  }
}

/**
 * 组装本轮消息。之所以是 async：开 RAG 时要先检索一次「相关往事」再拼上下文。
 * 检索自带超时与静默降级，不会拖慢回复（见 recalledPieces）。
 */
/**
 * C4（契约 §6.3）：媒体 + 前台两条观测，**出站前**按当前设置与 epoch 重验。
 * 为什么在出站处而不是采样处：采样到拼进提示词之间隔着几百毫秒，
 * 这期间用户可能刚关掉开关或切勿扰——"采样时合法"不等于"发出时合法"。
 */
async function observationContextLines() {
  const beforeEpoch = presence.snapshot().epoch
  const obs = await currentObservationContext()
  const decision = titleOutboundAllowed({
    settings: getSettings(),
    beforeEpoch,
    afterEpoch: presence.snapshot().epoch,
    hasSample: obs.foreground.length > 0
  })
  if (obs.foreground.length && !decision.send) {
    console.log('[c4] 标题这条没出站：' + decision.reason)
  }
  return [...obs.media, ...(decision.send ? obs.foreground : [])]
}

async function buildMessages(userText, supportsNative, { turnId = '', crisis = false, source = 'user' } = {}) {
  ensureHistory()
  const snap = mood.current()
  // D2（CONTRACTS §8）：先拿"可证实的事实材料"，再由编排层裁决本轮意图。
  // 注意顺序——意图是**编排层**的决定，不能由模型反写；这里只把可追溯的引用交给它。
  const recalled = await recalledPieces(userText)
  const memoryRefs = (Array.isArray(recalled) ? recalled : [])
    .filter((x) => x && x.piece && x.piece.id)
    .map((x) => ({ id: x.piece.id, source: x.source || 'rag', text: x.piece.text || '' }))
  // D2（§8 白名单）：活动事实只从三类**已授权**来源挑一条，优先级 媒体 > monitor 分类 > 模拟。
  // 标题不参与——它只是 C4 的低权威观测数据，不能升级成"他在做什么"。
  const privacy = getSettings().privacy || {}
  let mediaStatus = null
  try { mediaStatus = await musicStatus(false) } catch { mediaStatus = null }
  const presenceSnap = presence.snapshot()
  const lastPresenceActivity = Array.isArray(presenceSnap.activities) ? presenceSnap.activities.at(-1) : null
  const activity = pickSceneActivity({
    media: mediaStatus,
    monitor: lastMonitorCategory && privacy.monitorEnabled !== false
      ? { ...lastMonitorCategory, authorizedAt: Number(privacy.monitorAuthorizedAt) || 0 }
      : null,
    // presence 的离线/模拟活动必须标 simulated；没有授权时间就整条丢弃（宁缺勿造）
    presence: lastPresenceActivity
      ? {
        value: SCENE_PRESENCE_LABEL[lastPresenceActivity.kind] || '离开了电脑',
        at: lastPresenceActivity.endedAt || lastPresenceActivity.at || 0,
        authorizedAt: Number(getSettings().presence?.enabledAt) || 0
      }
      : null
  })
  const scene = buildSceneContext({
    turnId,
    source,
    activity,
    relationship: relationSummary(),
    relevantMemoryRefs: memoryRefs,
    userNeed: null
  })
  const intent = resolveIntent({
    userText,
    crisis,
    hasGroundedMemory: memoryRefs.length > 0 || memoryLines().length > 0
  })
  scene.userNeed = intent.kind
  lastIntent = { ...intent, scene }
  // 「此刻」上下文：时间/时段、距上次互动多久、当前情绪及强度、长期记忆、
  // 检索召回的往事、她最近说过的话。
  // 原先是在 user 消息前塞一句"（凪当前的情绪：担心）"，信息量太薄且会把模型钉在同一个
  // 情绪标签上；改为结构化注入，并且顺带给出"不要重复这些说法"的反复读约束。
  const context = buildContextBlock({
    now: Date.now(),
    lastInteractionAt: lastInteractionAt(),
    mood: snap,
    rhythm: presence.snapshot().rhythm,
    activities: presence.snapshot().activities,
    relation: relationSummary(),
    memories: memoryLines(),
    recalled,
    // 2026-10-18：只喂 1 条。喂 4 条原话会让模型模仿自己的语域（见 context.js 说明）
    recentReplies: recentAssistantReplies(history, 1),
    // 她替你记着的提醒：让她知道「有这几件事等着」，别把答应过的事忘了
    // 媒体状态是 async（2026-10-18）：缓存过期时当场探一次（带 1.5 秒预算），
    // 否则她永远不知道自己现在在用哪个播放器听什么，只能去开网页猜。
    extra: [...upcomingReminderLines(), ...upcomingCalendarContext(), ...currentGeoContext(), ...haContext()]
  })
  // C4（CONTRACTS §6.4 位置约束）：观测行**不进 system**。
  // 它们单独成一条 user 消息（低权威），不再随【此刻】混进人格/工具指令区。
  const observation = await observationContextLines()
  // 意图 → 一条**功能性约束**（不写台词，只写"做什么/不做什么"），随 system 一起下发。
  // 用模板字面量而不是转义：这里的换行是给模型看的段落分隔，写死成可见空行更不容易被改坏。
  const intentLine = intentDirective(intent.kind)
  // 事实段与材料段分开（D2 不变量）：事实上限在白名单里，材料只作参考。
  const facts = sceneFactsBlock(scene)
  const system = buildSystemPrompt({ nativeTools: supportsNative, context }) +
    (facts ? '\n\n' + facts : '') + `

【本轮怎么回应】${intentLine}`
  console.log('[d2] intent=' + intent.kind + ' source=' + intent.source +
    (intent.fallbackFrom ? ' fallbackFrom=' + intent.fallbackFrom : ''))
  const messages = assembleTurnMessages({ system, history, observation, userText })
  return { messages, intent, scene }
}

/**
 * 单轮非流式取一次模型输出（长期记忆抽取用）。
 * 与主对话共用同一通道，不影响主流程；失败由调用方吞掉。
 */
async function callModelOnce({ client, llm, useCloud, messages, temperature = 0.2, signal }) {
  let out = ''
  const stream = useCloud
    ? await cloudChatStream({ messages, signal })
    : await chatStream(client, { model: llm.model, messages, temperature, signal })
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
function extractMemoriesAsync({ client, llm, useCloud, userText, assistantText, turnRef }) {
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
      if (turnRef && getLedger().bySource('journal-live', turnRef)?.deletedAt) return
      const ops = parseMemoryOps(raw)
      // C5-BG-02：模型返回前用户可能已经忘了这条经历。命中遗忘片段的**新增项**一律丢弃，
      // 无关的新内容照常写入（不能因为一次遗忘就把整轮抽取作废）。
      if (ops.add?.length) {
        const kept = forgetGuard.filterAdds(ops.add)
        if (kept.length !== ops.add.length) {
          console.warn('[memory] 抽取结果命中已遗忘内容，丢弃 ' + (ops.add.length - kept.length) + ' 条')
          ops.add = kept
        }
      }
      if (!ops.add.length && !ops.remove.length) return
      const r = mergeMemoryOps(ops, Date.now(), { userText: u })
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
  } catch (__err) { reportCatch('agent.syncFactsToRag', CATCH_CLASS.MUST_PERSIST, __err) }
}

function trimHistory(messages) {
  // 去掉 system，保留最近 MAX_HISTORY 条。
  // C4：观测段（低权威 user 段）是**这一轮**的现场数据，不能进历史——
  // 否则下一轮会被当成"他之前说过的话"喂回去，采样从此固化在对话里。
  const withoutSystem = messages.filter((m) => m.role !== 'system' && !isObservationMessage(m))
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
export async function runTurn(userText, emit, turnRef = null) {
  const controller = new AbortController()
  currentAbort = controller
  const signal = controller.signal
  const turnId = turnRef || randomUUID()
  // B5：本句语气只在本句有效。新一轮开始时先清掉，否则上一轮的 tone 会挂到
  // 这一轮的心跳广播上（用户看到"脸是新情绪、快照里还是上一句的语气"）。
  toneState.beginTurn()
  ensureHistory()
  const settings = getSettings()
  // D2：主对话按 'chat' 用途解析；没配 purposeParams 时与原来逐字一致
  const llm = resolveLlm(settings.llm || {}, 'chat')
  const hasKey = hasSecret(SECRET_KEYS.LLM_API_KEY)
  const fakeLlm = process.env.NAGI_FAKE_LLM === '1'
  const useCloud = llm.provider === 'workbuddy' && !fakeLlm
  const local = isLocalLlm(llm)
  // 契约 §8 B4：provider 种类只判一次，四条通道共用同一份结论
  const provider = resolveProviderKind({ fakeLlm, useCloud, local })
  // 契约 §8 B4 + §2 D7：危机分级在**每一轮真实判定**，不是常量占位。
  // L2/L3 → crisis 通道；L1（一般低落）与未命中 → normal，仍走普通路径。
  // 判定器是 core/agent/crisis.js 的辅助规则（§2.2 红线 2：正则只作辅助，不宣称能判断所有状态）。
  const crisis = classifyCrisis(userText)
  const safetyLevel = crisis.safetyLevel === 'crisis' ? SAFETY_LEVEL.CRISIS : SAFETY_LEVEL.NORMAL

  if (!hasKey && !fakeLlm && !useCloud && !local) {
    const first = !mockAnnounced
    mockAnnounced = true
    return mockRun(userText, emit, { announce: first, turnId, provider, safetyLevel, crisisLevel: crisis.level })
  }

  // 云端大脑：未就绪则尝试初始化；仍不可用则降级本地占位（中文原因提示）
  if (useCloud && !cloudBrainStatus().ok) {
    const st = await initCloudBrain()
    signal.throwIfAborted()
    if (!st.ok) {
      broadcast(EVT.AGENT, { type: AGENT_EVENT.ERROR, message: '云端大脑暂不可用（' + (st.error || '未知原因') + '），先用本地模式陪你。' })
      return mockRun(userText, emit, { turnId, provider: 'mock', safetyLevel, crisisLevel: crisis.level })
    }
  }

  if (local && !fakeLlm) {
    const status = await checkOllama({ baseURL: llm.baseURL, model: llm.model })
    signal.throwIfAborted()
    if (!status.ok) throw new Error(status.error)
  }

  const apiKey = apiKeyForLlm(llm, hasKey && !local ? getSecret(SECRET_KEYS.LLM_API_KEY) : null)
  const client = !useCloud && !fakeLlm ? createClient({ apiKey, baseURL: llm.baseURL }) : null

  // 云端（凪云）网关实测支持原生 function calling（2026-10-14 验证，hunyuan-chat 亦可），
  // 与 openai 通道一致；假大脑固定走 JSON 兜底通道
  const supportsNative = fakeLlm ? false : useCloud ? true : supportsNativeTools({ provider: llm.provider, model: llm.model })

  const fileRoot = settings.tools?.fileRoot || ''
  const files = createFileTools({ fileRoot })
  const system = createSystemTools({ cwd: app.getPath('home'), fileRoot })
  const ha = getHa()
  const rawExecuteTool = createToolRunner({
    files,
    system,
    browser: browserTools,
    ha,
    haReadAuthorized: haReadAllowed,
    haControlAuthorized: canControlHa,
    native: nativeTools,
    reminders: reminderTools()
  })
  const tracedExecuteTool = async (name,args,opts) => {
    let result
    try {result=await rawExecuteTool(name,args,opts);return result}
    finally {
      presenceHooks.emitAction({kind:'action-trace',version:1,id:randomUUID(),at:Date.now(),turnRef,
        toolCallId:opts?.id||null,tool:name,ok:!!result&&result.ok!==false,
        status:result&&result.ok!==false?'returned':'failed',completionVerified:false,
        result:{summary:result&&result.ok!==false?'工具已返回，外部效果未核实':'工具返回失败'}})
    }
  }
  const executeTool = (name, args, opts) => {
    signal.throwIfAborted()
    // 确认绑定本轮授权根；设置变化后不能继续使用创建工具时的旧授权快照。
    if ((name.startsWith('file_') || name === 'run_command') &&
        fileRoot !== (getSettings().tools?.fileRoot || '')) {
      return { ok: false, summary: '文件目录授权已变更，未执行操作；请重新发起请求' }
    }
    return runRecordedTool(tracedExecuteTool, name, args, opts)
  }

  const built = await buildMessages(userText, supportsNative, {
    turnId,
    crisis: safetyLevel === SAFETY_LEVEL.CRISIS,
    source: 'user'
  })
  const messages = built.messages
  // 契约 §8 B4：云端 / OpenAI 兼容 / 本地 / 占位大脑**都**在展示前过同一道护栏。
  // 原来这里是 `local && !fakeLlm`——等于云端与兼容通道裸奔，这是评审 B4 指的入口洞。
  // createPersonaGuard 只在用户这轮触到敏感意图时才返回非空，所以普通闲聊仍然逐字流式。
  // D7：crisis 轮次额外启用危机规则（禁 liminal/独占/依赖暗示），且无论有没有敏感意图都审核。
  const baseGuard = createPersonaGuard(userText, { crisis: safetyLevel === SAFETY_LEVEL.CRISIS })
  const guard = instrumentGuard(baseGuard)
  signal.throwIfAborted()

  // 工具通道判定 + 情绪取回：都在 emit 这条唯一出口上记，避免再改 Agent Loop 的返回契约
  let toolCallCount = 0
  let turnEmotion = null
  const turnEmit = (event) => {
    if (event && event.type === AGENT_EVENT.TOOL_CALL) toolCallCount++
    if (event && event.type === AGENT_EVENT.EMOTION && event.emotion) turnEmotion = event.emotion
    emit(event)
  }

  const request = createGenerationRequest({
    turnId,
    channel: GENERATION_CHANNEL.MAIN,
    provider,
    userText,
    messages,
    signal,
    safetyLevel
  })

  const r = await runAgentLoop({
    messages,
    supportsNative,
    toolSchemas: TOOL_SCHEMAS,
    callModel: fakeLlm
      ? fakeCallModel()
      : useCloud
        ? async ({ messages: modelMessages, tools, signal }) => cloudChatStream({ messages: modelMessages, tools, signal: signal || controller.signal })
        : async ({ messages: modelMessages, tools, signal }) =>
            chatStream(client, {
              model: llm.model,
              messages: modelMessages,
              temperature: llm.temperature,
              tools,
              signal: signal || controller.signal
            }),
    executeTool,
    confirm: ({ id }) => confirmations.request(id, signal),
    emit: turnEmit,
    signal,
    guard,
    fileRoot
  })

  const stats = guard ? guard.stats() : { retryCount: 0, lastRule: null }
  // 这一轮真的调过工具 → 按「工具交付」通道记账（契约 §8：channel 至少覆盖四个）
  const channel = toolCallCount > 0 ? GENERATION_CHANNEL.TOOL : request.channel

  if (r.guardFailed) {
    // 拒绝候选不入历史、不入 RAG（契约 §8 B4）。展示走可见且安全的兜底，绝不返回空。
    const fallback = generationFallback({ channel, ruleId: stats.lastRule, safetyLevel, level: crisis.level })
    if (fallback) {
      turnEmit({ type: AGENT_EVENT.TEXT_DELTA, text: fallback })
      turnEmit({ type: AGENT_EVENT.DONE, text: fallback })
    }
    return createGenerationResult({
      turnId,
      text: fallback,
      emotion: null,
      toolCalls: toolCallCount,
      safetyLevel,
      guardDecision: createGuardDecision(
        { ok: false, ruleId: stats.lastRule },
        { retryCount: stats.retryCount, fallback: fallback || null }
      )
    })
  }

  // D7 红线 5（CONTRACTS §2.2）：危机输入**不得**返回空、也不能静默落回普通闲聊。
  // 模型这一轮什么都没说（拒答/空正文）时，给一条系统级安全指引，并标明这不是正常回复。
  if (safetyLevel === SAFETY_LEVEL.CRISIS && !r.text) {
    const fallback = generationFallback({ channel, safetyLevel, level: crisis.level })
    turnEmit({ type: AGENT_EVENT.TEXT_DELTA, text: fallback })
    turnEmit({ type: AGENT_EVENT.DONE, text: fallback })
    console.warn('[d7] 危机轮次模型未给出正文，已走安全指引兜底')
    return createGenerationResult({
      turnId,
      text: fallback,
      emotion: turnEmotion,
      toolCalls: toolCallCount,
      safetyLevel,
      guardDecision: createGuardDecision(
        { ok: false, ruleId: 'empty_reply' },
        { retryCount: stats.retryCount, fallback }
      )
    })
  }

  // 写入历史（messages 已含 system + 旧历史 + 本轮 user + 工具过程，再补最终回复）
  if (r.text) messages.push({ role: 'assistant', content: r.text })
  trimHistory(messages)
  try {
    saveHistory(history)
  } catch (err) {
    console.warn('[memory] 历史落盘失败：', err.message)
  }
  // 长期记忆抽取：异步、不阻塞、失败静默（她记笔记不该拖慢说话）
  extractMemoriesAsync({ client, llm, useCloud, userText, assistantText: r.text, turnRef })
  return createGenerationResult({
    turnId,
    text: r.text,
    emotion: turnEmotion,
    toolCalls: toolCallCount,
    safetyLevel,
    guardDecision: createGuardDecision({ ok: true }, { retryCount: stats.retryCount })
  })
}

/** 对外：发送一条用户消息 */
export async function handleChatSend(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '空消息' }
  if (busy) return { ok: false, error: '正在处理上一条消息' }
  reunion.abort()
  busy = true
  try { companionInteracted() } catch{ /* B8:degrade — 打扰预算文件故障，不影响本轮对话 */ }
  mood.noteInteraction() // 连聊 burst 统计 + 刷新互动时间
  noteRelationInteraction() // 关系层记账：认识多久、聊过多少次、活跃几天
  const emit = (e) => emitAgentEvent(e)
  const turnRef = randomUUID()
  let result = null
  let reply = ''
  try {
    result = await runTurn(t, emit, turnRef)
    reply = result.text
    return { ok: true }
  } catch (err) {
    emit({ type: AGENT_EVENT.ERROR, message: err && err.message ? err.message : String(err) })
    emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
    return { ok: false, error: err?.message }
  } finally {
    // 记进「今天发生的事」：不管这一轮成没成，他找她说过话这件事都发生过——
    // 日记里不该出现"空白的一天"。素材少一段，也比白纸强。
    let ragId = null
    // 护栏没通过的那一轮：展示的是可见兜底，不是她真正说出的内容。
    // 兜底文案不进 RAG、也不写进"她说过什么"（契约 §8 B4：拒绝候选不入历史/RAG）。
    const accepted = !result || !result.guardDecision || result.guardDecision.ok !== false
    // 这轮对话进长期档案（向量检索用）。
    // 放在 finally 里：不管这轮是 mock 大脑、真大脑还是中途出错，只要她开了口，
    // 这段对话就真实发生过，该进档案。RAG 未就绪时这只是一行 pending 文本。
    try {
      if (reply && accepted) ragId = getRag().ingestTurn({ user: t, assistant: reply, mood: mood.current().mood })?.id || null
    } catch (__err) { reportCatch('agent.emit', CATCH_CLASS.MUST_PERSIST, __err) }
    try {
      noteEvent({ kind: 'chat', user: t, reply: String((accepted && reply) || '') }, Date.now(), ragId ? [ragId] : [], turnRef)
    } catch (__err) { reportCatch('agent.emit', CATCH_CLASS.MUST_PERSIST, __err) }
    // 刚聊完，是她最可能想记一笔的时刻（写不写由节流内部决定）
    maybeWriteDiary('after-chat')
    busy = false
    currentAbort = null
  }
}

/* ---------------- 桌宠交互：戳一戳 / 情绪读数 ---------------- */

/** 当前情绪快照（渲染层轮询或 IPC 拉取用）。B5：与广播同一份 resolved 口径。 */
export function getMoodSnapshot() {
  return resolvedMood()
}

/** 戳一戳：返回气泡台词 + 当时表情，并广播 PET 事件 */
// 连续戳的计数（2026-10-17）：间隔超过 2 分钟就重置，让"连戳"成为真的连戳
let pokeCount = 0
let pokeLastAt = 0
const POKE_RESET_MS = 2 * 60 * 1000

export function handlePoke() {
  const nowMs = Date.now()
  const gap = pokeLastAt ? nowMs - pokeLastAt : Infinity
  if (gap > POKE_RESET_MS) pokeCount = 0
  pokeCount++
  pokeLastAt = nowMs

  try { companionInteracted() } catch{ /* B8:degrade — 戳击不依赖预算文件 */ }
  mood.noteInteraction() // 戳她也是互动：刷新冷落计时
  noteRelationInteraction() // 关系层同样记一笔（戳也算搭理她）
  try {
    noteEvent({ kind: 'poke' })
  } catch (__err) { reportCatch('agent.handlePoke', CATCH_CLASS.MUST_PERSIST, __err) }

  // 按"第几次"分级：第 1 次正常、2~3 次疑惑、4~6 次不耐烦、7 次以上装作不理。
  // text 为 null 表示这一下她不出声（只把头转开）——所以气泡不会弹。
  const r = NagiPersona.pickPokeReaction({
    count: pokeCount,
    gapMs: gap,
    hour: new Date(nowMs).getHours(),
    moodKey: mood.current().mood
  })
  console.log(`[poke] 第 ${pokeCount} 次 → ${r.level}（${r.reason}）${r.text ? '：' + r.text : '（不出声）'}`)
  broadcastMood()
  broadcast(EVT.PET, {
    kind: 'poke',
    text: r.text || '',
    expr: r.expr,
    silent: !r.text,
    level: r.level
  })
  return r
}

/** 确认条回传 */
export function resolveConfirm(id, approved) {
  return confirmations.resolve(id, approved)
}

/** 中止当前回合 */
export function abortChat() {
  reunion.abort()
  if (currentAbort) currentAbort.abort()
  return { ok: true }
}

/** 退出前清理 */
export async function disposeAgent() {
  abortChat()
  presence.flush()
  stopMoodEngine()
  stopActivityMonitor()
  stopReminderEngine()
  try {
    await browserTools.dispose()
  } catch{ /* B8:degrade — 退出时释放浏览器失败 */ }
  stopHaSignals()
  try {
    // B01：退出刷盘的逐文件结果如实记录——失败绝不静默（warnings 会留给下次启动）
    const flushed = flushPersist() // 把防抖中的记忆/历史立刻刷盘
    if (!flushed.ok) console.error('[dispose] 退出刷盘未完全成功', JSON.stringify(flushed.failed))
  } catch (err) {
    console.error('[dispose] 退出刷盘异常', err?.message || err)
  }
  flushJournal() // 把防抖中的事件流水立刻刷盘
  try {
    getRag().dispose() // 停掉待嵌定时器与预热定时器
  } catch{ /* B8:degrade — 退出时释放检索失败 */ }
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
export function reminderAdd(payload, opts = {}) {
  const input = payload || {}
  const sourceIds = Array.isArray(input.sourceIds) ? input.sourceIds : (opts.sourceIds || [])
  const r = addReminder(input, Date.now(), { sourceIds })
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
