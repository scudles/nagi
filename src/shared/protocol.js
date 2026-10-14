// src/shared/protocol.js
// 主进程 / 预加载 / 渲染层共用的常量与默认值。
// 只放"纯数据"，不放任何 Electron / Node 依赖，方便被 core 单测引用。

/** IPC 通道名（invoke / send） */
export const IPC = {
  // 设置
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
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
  // 智能家居
  HA_TEST: 'ha:test',
  HA_LIST: 'ha:list',
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
  PET: 'pet:event'       // 桌宠交互 { kind: 'poke', text, expr }
}

/** 6 种离散情绪（与旧情感系统一致） */
export const EMOTIONS = ['calm', 'puzzled', 'smile', 'worry', 'pout', 'joy']

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
  mode: MODE.PET,
  llm: {
    provider: 'workbuddy',
    baseURL: PROVIDER_PRESETS.workbuddy.baseURL,
    model: PROVIDER_PRESETS.workbuddy.model,
    temperature: 0.7
  },
  live2d: {
    modelPath: 'Lisette/Lisette.model3.json',
    scale: 1,
    mirror: false,
    eyeBlink: true,
    focusFollow: true,
    petWidth: 400, // 桌宠窗口尺寸（可用右下角手柄/Ctrl+滚轮自由调）
    petHeight: 600,
    idleBoost: true // 待机加成：一段时间无互动时放大一点、换个姿势
  },
  homeassistant: {
    enabled: false,
    baseURL: 'http://homeassistant.local:8123'
  },
  tools: {
    cdpPort: 9222,
    confirmHighRisk: true,
    fileRoot: '',
    browserMode: 'cdp' // 'cdp' | 'managed'
  },
  privacy: {
    monitorEnabled: false
  }
}
