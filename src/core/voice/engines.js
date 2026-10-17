// src/core/voice/engines.js
// TTS / ASR 引擎注册表 + 降级链 + 凪的声线预设。
//
// 设计原则（NFR「LLM / TTS / ASR 全部接口抽象」）：
//   core 只描述「有哪些引擎、各自什么属性、优先级怎么排」，
//   具体怎么调（WSS / PowerShell / HTTP）全在 main/voice 的适配器里。
//   于是换引擎 = 加一个适配器 + 在表里加一行，不动上层。
//
// 纯逻辑，无 Electron / Node 依赖，可 node --test。

import { MOOD_KEYS, MOOD_OFFSETS } from './mood-table.js'

/* ---------------- TTS ---------------- */

/**
 * 每个引擎：
 *   label       展示名
 *   offline     是否离线可用
 *   needsKey    是否需要用户填 Key
 *   needsNetwork 是否依赖网络
 *   note        一句话说明（设置页展示，顺便交代坑）
 *   format      产出音频容器（渲染层播放要按它选 MIME）
 */
export const TTS_ENGINES = {
  edge: {
    id: 'edge',
    label: 'edge-tts（免费在线神经音色）',
    offline: false,
    needsKey: false,
    needsNetwork: true,
    format: 'audio/mpeg',
    note: '微软 Edge 朗读的神经音色，免密钥、音质好；非官方接口，可能失效——断网或失效时自动回退本机语音'
  },
  sapi: {
    id: 'sapi',
    label: 'Windows 本机语音（离线免密钥）',
    offline: true,
    needsKey: false,
    needsNetwork: false,
    format: 'audio/wav',
    note: '系统自带 SAPI 语音，完全离线、最稳；音质偏「机器朗读」'
  },
  cloud: {
    id: 'cloud',
    label: '云端 TTS（火山 / Azure，需 Key）',
    offline: false,
    needsKey: true,
    needsNetwork: true,
    format: 'audio/mpeg',
    note: '需自行填 Key；音色可选范围最广'
  },
  gptsovits: {
    id: 'gptsovits',
    label: '本地 GPT-SoVITS（凪的专属音色）',
    offline: true,
    needsKey: false,
    needsNetwork: false,
    format: 'audio/wav',
    note: '用凪的语音样本训练出的专属音色；需本地跑 GPT-SoVITS 服务（接口已预留）'
  }
}

/** TTS 降级顺序：免费的在线音色 → 离线本机 → 需 Key 的云 → 专属音色 */
export const TTS_FALLBACK = ['edge', 'sapi', 'cloud', 'gptsovits']

/** edge-tts 的 zh-CN 音色（2026-10 实测可用，免密钥） */
export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖（推荐）', note: '干净、情绪稳，最贴「过于干净的音色」' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼', note: '音调略高，活泼一些' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光（男声）', note: '男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 专业（男声）', note: '男声，播音感' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 激情（男声）', note: '男声' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 可爱（少年男声）', note: '少年音' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话', note: '方言彩蛋' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话', note: '方言彩蛋' }
]

/* ---------------- ASR ---------------- */

export const ASR_ENGINES = {
  sherpa: {
    id: 'sherpa',
    label: '离线模型 sherpa-onnx（更准，推荐）',
    offline: true,
    needsKey: false,
    needsNetwork: false,
    needsModel: true,
    note: 'Paraformer 中文离线模型，长句、标点、数字表现都明显更好；首次需下载约 98MB（装好后完全离线）。没装时自动回退本机识别，不下载也能用'
  },
  sapi: {
    id: 'sapi',
    label: 'Windows 本机识别（离线免密钥）',
    offline: true,
    needsKey: false,
    needsNetwork: false,
    note: '系统自带识别引擎，零依赖开机可用；老引擎精度一般，长句可能只识别前半句'
  },
  cloud: {
    id: 'cloud',
    label: '云端 ASR（需 Key）',
    offline: false,
    needsKey: true,
    needsNetwork: true,
    note: '需自行填 Key；长句与嘈杂环境表现更好'
  }
}

/** ASR 降级顺序：更准的离线 → 零依赖本机 → 云端 */
export const ASR_FALLBACK = ['sherpa', 'sapi', 'cloud']

/* ---------------- 凪的声线 ---------------- */

/**
 * 凪的默认声线参数。
 * rate / pitch 用「百分比」，各引擎自行折算（edge 直接用 %；SAPI 的 Rate 是 -10~10，按 /10 折算）。
 * 默认值取自《声线参考短名单》：语速略慢（那层干净音色的「不慌不忙」）、音高微降（压掉少女音的甜感）。
 * 2026-10-15 用户听完 docs/voice-samples/ 三份样本后定稿选 A（edge 晓晓·温暖）。
 */
export const NAGI_VOICE = {
  edge: { voice: 'zh-CN-XiaoxiaoNeural', rate: -10, pitch: -2, volume: 100 },
  sapi: { voice: 'Microsoft Huihui Desktop', rate: -1, volume: 100 },
  cloud: { voice: '', rate: -10, pitch: -2, volume: 100 },
  gptsovits: { voice: '', rate: 0, pitch: 0, volume: 100 }
}

/**
 * 情绪 → 语音微调（在基准参数上叠加）。这是「语音情绪」那一层：表层不是没起伏，
 * 是起伏有规律。
 *
 * 数值与 `VOICE_PROFILE.emotions` **同源**（都取自 `mood-table.js`，D50）：
 * 2026-10-17 之前这里是另一份小一截的表（joy 只 +8、worry 还是"略快"），
 * 于是关掉「语音情绪映射」开关 = 把她换成一个更木的人。现在切开关只影响
 * 「有没有时段/强度/语气这些维度」，不影响她的性格本身。
 * 注意这里只取 rate/pitch：旧路径从不因情绪改音量（音量恒取基准）。
 */
export const MOOD_SPEECH = Object.fromEntries(
  MOOD_KEYS.map((k) => [k, { rate: MOOD_OFFSETS[k].rate, pitch: MOOD_OFFSETS[k].pitch }])
)

/**
 * 把「基准声线 + 情绪微调」合成最终参数。
 * @param {{rate?:number, pitch?:number, volume?:number}} base
 * @param {string} mood
 * @returns {{rate:number, pitch:number, volume:number}}
 */
export function mergeVoiceParams(base = {}, mood = 'calm') {
  const d = MOOD_SPEECH[mood] || MOOD_SPEECH.calm
  const clampPct = (v) => Math.max(-50, Math.min(50, Math.round(Number(v) || 0)))
  return {
    rate: clampPct((Number(base.rate) || 0) + d.rate),
    pitch: clampPct((Number(base.pitch) || 0) + d.pitch),
    volume: Math.max(0, Math.min(100, Math.round(Number(base.volume ?? 100))))
  }
}

/* ---------------- 选择 ---------------- */

const TABLES = { tts: TTS_ENGINES, asr: ASR_ENGINES }
const CHAINS = { tts: TTS_FALLBACK, asr: ASR_FALLBACK }

/**
 * 按偏好 + 可用性挑引擎，挑不到就沿降级链往下走。
 * @param {'tts'|'asr'} kind
 * @param {string} preferred 用户选的引擎 id
 * @param {Record<string, boolean>} [available] 各引擎当前是否可用（false / undefined=不可用由调用方约定）
 * @returns {string|null}
 */
export function pickEngine(kind, preferred, available = {}) {
  const table = TABLES[kind]
  const chain = CHAINS[kind]
  if (!table || !chain) return null
  if (preferred && table[preferred] && available[preferred] !== false) return preferred
  for (const id of chain) {
    if (table[id] && available[id] !== false) return id
  }
  return null
}

/** 是否所有候选引擎都不可用（用于给用户一个明确的「语音暂不可用」而不是静默失败） */
export function noEngineAvailable(kind, available = {}) {
  return pickEngine(kind, null, available) === null
}
