// src/shared/protocol.js
// 主进程 / 预加载 / 渲染层共用的常量与默认值。
// 只放"纯数据"，不放任何 Electron / Node 依赖，方便被 core 单测引用。

import { DEFAULT_BLACKLIST } from '../core/monitor/privacy.js'
import { PRESENCE_DEFAULTS } from './presence-protocol.js'

/** IPC 通道名（invoke / send） */
export const IPC = {
  // 设置
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  TOOLS_PICK_ROOT: 'tools:pick-root',
  TOOLS_REVOKE_ROOT: 'tools:revoke-root',
  // 密钥（safeStorage 加密，渲染层只能保存/查状态/删除）
  SECRET_SET: 'secret:set',
  SECRET_STATUS: 'secret:status',
  SECRET_DELETE: 'secret:delete',
  // 窗口 / 形态
  WINDOW_SET_MODE: 'window:set-mode',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_HIDE: 'window:hide',
  WINDOW_CLOSE: 'window:close',
  WINDOW_OPEN_DIARY: 'window:open-diary',
  WINDOW_RESIZE: 'window:resize',
  // 桌宠拖动：渲染层用原生 pointer 事件 + window.screenX 驱动窗口移动
  WINDOW_MOVE: 'window:move',
  // 对话 / Agent
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  TOOL_CONFIRM: 'tool:confirm',
  // 桌宠交互 / 独白日记
  PET_POKE: 'pet:poke',
  MOOD_GET: 'mood:get',
  DIARY_LIST: 'diary:list',
  DIARY_READ: 'diary:read',
  // 长期记忆 / 对话历史（跨会话）
  MEMORY_LIST: 'memory:list',
  MEMORY_ADD: 'memory:add',
  MEMORY_DELETE: 'memory:delete',
  HISTORY_CLEAR: 'history:clear',
  LEDGER_LIST: 'ledger:list',
  LEDGER_GET: 'ledger:get',
  LEDGER_CORRECT: 'ledger:correct',
  LEDGER_FORGET: 'ledger:forget',
  LEDGER_EXPORT: 'ledger:export',
  YEARBOOK_LIST: 'yearbook:list',
  YEARBOOK_ADD: 'yearbook:add',
  YEARBOOK_EDIT: 'yearbook:edit',
  YEARBOOK_REMOVE: 'yearbook:remove',
  YEARBOOK_EXPORT: 'yearbook:export',
  COMPANION_STATUS: 'companion:status',
  COMPANION_IGNORE: 'companion:ignore',
  // 关系层（S4）：熟悉度 + 情绪时间线
  RELATION_GET: 'relation:get',
  RELATION_TIMELINE: 'relation:timeline',
  // 日程提醒（M4）：她会记事，到点主动提醒
  REMINDER_LIST: 'reminder:list',
  REMINDER_ADD: 'reminder:add',
  REMINDER_REMOVE: 'reminder:remove',
  REMINDER_DONE: 'reminder:done',
  PROMISE_LIST: 'promise:list',
  // §11.4：关联提醒的「一并取消」入口，以及已结束记录的删除入口（不重放外部操作）
  PROMISE_CANCEL_LINKED: 'promise:cancel-linked',
  PROMISE_REMOVE: 'promise:remove',
  CALENDAR_STATUS: 'calendar:status',
  CALENDAR_IMPORT: 'calendar:import',
  CALENDAR_REVOKE: 'calendar:revoke',
  MUSIC_STATUS: 'music:status',
  MUSIC_ENABLE: 'music:enable',
  MUSIC_REVOKE: 'music:revoke',
  GEO_STATUS: 'geo:status',
  GEO_ENABLE: 'geo:enable',
  GEO_REVOKE: 'geo:revoke',
  // 智能家居
  HA_TEST: 'ha:test',
  HA_LIST: 'ha:list',
  HA_SIGNAL_STATUS: 'ha:signal-status',
  HA_READ_ENABLE: 'ha:read-enable',
  HA_CONTROL_ENABLE: 'ha:control-enable',
  HA_CONTROL_REVOKE: 'ha:control-revoke',
  HA_SIGNAL_REVOKE: 'ha:signal-revoke',
  // 应用信息
  APP_GET_INFO: 'app:get-info',
  MODELS_LIST: 'models:list'
}

/** 主进程 → 渲染层的广播事件（on） */
export const EVT = {
  AGENT: 'agent:event',
  SETTINGS_CHANGED: 'settings:changed',
  HA_EVENT: 'ha:event',
  MOOD: 'mood:change',   // 情绪状态机快照 { mood, intensity, expr, label }
  PET: 'pet:event',      // 桌宠交互 { kind: 'poke' | 'proactive', text, expr }
  // 2026-10-17 待机行为：
  // 注视提示**只传相对方向**（-1..1），主进程算好再发，渲染层拿不到也存不下绝对鼠标坐标
  GAZE: 'gaze:hint',     // { x, y, at }  x/y 是鼠标相对桌宠窗口中心的方向
  OUTFIT: 'outfit:change', // { lookId, slots, reason } 装束变更（双窗同步 + 让主进程记账）
  // 2026-10-17 「她想一下再表现」：主进程把"闪一下"的指令发下来（持续那部分走情绪通道）
  FEELING: 'feeling:flash' // { flash: 'star', feel: 'joy', why: '...' }
}

/**
 * 装束通道（2026-10-17）
 *
 * 单向数据流，避免主进程去猜模型里有什么装束：
 *   渲染层 ──outfit:report──▶ 主进程（清单 + 当前项；托盘菜单据此构建、当前项落盘）
 *   主进程 ──outfit:change──▶ 渲染层（指令：{ action:'next'|'prev'|'random'|'set', lookId? }）
 *
 * 装束清单来自模型目录的 nagi-outfit.json，只有渲染层读得到（走 nagi-local://），
 * 所以主进程做"渲染层上报什么就用什么"，不自己维护一份可能过期的副本。
 */
/**
 * B8（CONTRACTS §12.2）：维护状态的**只读** IPC。
 * 渲染层只能看与清，不能写入任何状态——错误来自主进程，界面只负责如实呈现。
 */
export const MAINTENANCE_IPC = {
  HEALTH: 'maintenance:health',
  CLEAR: 'maintenance:clear'
}

export const OUTFIT_IPC = {
  REPORT: 'outfit:report' // 渲染层上报 { looks, current, slots }
}

/** 6 种离散情绪（与旧情感系统一致） */
// 2026-10-17 新人设：后三个是「存在主义层」——只在真正深刻的时刻出现，日常不用。
export const EMOTIONS = ['calm', 'puzzled', 'smile', 'worry', 'pout', 'joy', 'liminal', 'tender', 'distant']

/** Agent Loop 向前端广播的事件类型 */
export const AGENT_EVENT = {
  TEXT_DELTA: 'text-delta', // { text }
  EMOTION: 'emotion', // { emotion, intensity }
  TOOL_CALL: 'tool-call', // { id, name, args, risk }
  TOOL_RESULT: 'tool-result', // { id, name, ok, summary, ms }
  CONFIRM: 'confirm', // { id, name, args, risk, description }
  STATUS: 'status', // { state: 'thinking'|'acting'|'waiting'|'idle', detail? }
  DONE: 'done', // { text }
  ERROR: 'error' // { message, code? }
}

/** 工具风险等级 */
export const RISK = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }

/** 窗口形态 */
export const MODE = { PET: 'pet', WORKBENCH: 'workbench' }

/** Agent 状态（用于套皮：表情 + 文字） */
export const AGENT_STATE = {
  IDLE: 'idle',
  THINKING: 'thinking',
  ACTING: 'acting',
  WAITING: 'waiting'
}

/** 记忆键名（settings.json 内的字段） */
export const SECRET_KEYS = {
  LLM_API_KEY: 'llmApiKey',
  HA_TOKEN: 'haToken'
}

/** 各家模型（OpenAI 兼容）预设 */
export const PROVIDER_PRESETS = {
  // 凪云默认用 deepseek-v4.1-flash：2026-10-14 实测它在同等人格提示下复读最少、
  // 最会引用上下文、响应也快（hunyuan-chat 倾向重复固定句式）
  workbuddy: { label: '凪云（免密钥）', baseURL: '', model: 'deepseek-v4.1-flash' },
  openai: { label: 'OpenAI ChatGPT', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  hunyuan: { label: '腾讯混元', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest' },
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  kimi: { label: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  glm: { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  ollama: { label: '本地 Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5' },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  custom: { label: '自定义', baseURL: '', model: '' }
}

/** 默认设置（不含密钥） */
export const DEFAULT_SETTINGS = {
  presence: PRESENCE_DEFAULTS,
  mode: MODE.PET,
  llm: {
    provider: 'workbuddy',
    baseURL: PROVIDER_PRESETS.workbuddy.baseURL,
    model: PROVIDER_PRESETS.workbuddy.model,
    temperature: 0.7,
    // D2「按模型/用途存参数」：按用途覆盖通用参数，例如
    //   { diary: { temperature: 1.0 }, extract: { model: 'deepseek-chat' } }
    // 空对象 = 各用途沿用上面的通用参数，行为与加这个字段之前完全一致。
    purposeParams: {}
  },
  llmProfiles: {}, // 每个提供商最后保存的地址、模型与温度；密钥仍在 keystore
  live2d: {
    // 2026-10-17：角色形象换成「缅因妹妹」（models/Maine）。
    // 旧的 Lisette / Mao 已移出 models/（归档到 models-archive/），此处同步指到新模型。
    modelPath: 'Maine/Maine.model3.json',
    scale: 1,
    mirror: false,
    // 取景：'bust' = 只显示胸像（上半身），'full' = 全身。
    // 默认胸像 —— 形象永不越界、也不会盖到 UI 上（详见 core/frame.js）
    frame: 'bust',
    eyeBlink: true,
    petWidth: 400, // 桌宠窗口尺寸（可用右下角手柄/Ctrl+滚轮自由调）
    petHeight: 600,
    idleBoost: true, // 待机加成：一段时间无互动时放大一点、换个姿势
    // 前后（Z 轴）动作：前倾凑近 / 探头看你 / 后仰松弛 + 常态纵深摆动
    depthMotion: { enabled: true, amount: 1 },
    // 当前装束（nagi-outfit.json 里的 look id；桌宠重启后还是这一身）
    outfit: 'daily'
  },
  // 「她想一下再表现」（2026-10-17）：看你一眼、想一下、再决定要不要有反应
  // 只把**活动分类**交给模型（不传窗口标题/文件名），且只在关键时机问一次
  reaction: {
    enabled: true, // 总开关（关掉就退回原来的硬编码规则）
    minGapMin: 8, // 两次思考的最小间隔（分钟）
    hourMax: 4, // 每小时最多想几次
    dayMax: 20 // 每天最多想几次
  },
  // 待机行为（2026-10-17）：没人跟她说话的时候，她自己怎么待着
  ambient: {
    enabled: true, // 总开关
    gaze: true, // 微注视（鼠标明显移动时看她一眼，看一眼就移开）
    autonomous: true, // 自主动作与自主换装
    level: 'conservative', // conservative | medium | lively
    hotkeys: true // 全局热键（Ctrl+Alt+O 系列）
  },
  homeassistant: {
    enabled: false,
    baseURL: 'http://homeassistant.local:8123'
  },
  tools: {
    cdpPort: 9222,
    fileRoot: '',
    browserMode: 'cdp' // 'cdp' | 'managed'
  },
  privacy: {
    monitorEnabled: true, // 活动监测总开关（首次启动有告知弹窗，可一键关）
    titleOutbound: true, // C4/D63：窗口标题可进上下文（独立开关，默认开启；关掉只保留类别判断）
    doNotDisturb: false, // 勿扰模式：临时停采，不落任何样本
    onlyPresence: false, // 只陪着：不监测活动、不主动开口；手动对话与戳击仍可用
    noticeShown: false, // 「她在观察你在用什么程序」的首次告知是否已展示
    // D2：活动分类的**授权时间**（开启监测时打戳）。场景上下文要用它证明"这条事实有授权来源"，
    // 没有它就只能填 null——不用当前时间冒充授权时间。
    monitorAuthorizedAt: 0,
    sampleSec: 20, // 多久看一眼（秒）
    blacklist: [...DEFAULT_BLACKLIST] // 命中即丢样本（窗口标题/应用名，支持 * 通配）
  },
  // 媒体感知：窗口标题兜底时追加的播放器进程名（网易云等不注册系统媒体会话的播放器）
  signals: { extraPlayerProcesses: [] },
  companion: { maxDaily: 3, minGapMinutes: 90 }
}
