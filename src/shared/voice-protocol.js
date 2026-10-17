// src/shared/voice-protocol.js
// 语音链路的 IPC 通道名与默认设置。
//
// 为什么不写进 shared/protocol.js：那个文件是全局契约中枢，改它容易和别的改动撞车。
// 语音是一块独立能力（引擎可替换、可整体关闭），把它的通道名与默认值收在自己的文件里，
// 边界更清楚，也让 protocol.js 保持「核心协议」的定位。
//
// 只放"纯数据"，不放任何 Electron / Node 依赖。

/** 语音 IPC 通道名（invoke / handle） */
export const VOICE_IPC = {
  /** 语音能力快照：各引擎可用性 + 本机语音清单 + 离线模型状态 */
  STATUS: 'voice:status',

  // ---- 语音输出（TTS）----
  /** 开一次朗读会话：把回复切成句，返回 { sessionId, total, engine, sentences } */
  SPEAK: 'voice:speak',
  /** 取第 index 句的音频（按句取用 → 首响 = 首句合成时间） */
  PULL: 'voice:pull',
  /** 丢弃会话（打断；不传 sessionId 则全部丢弃） */
  STOP: 'voice:stop',
  /** 试听：设置页里点一下听效果，走单句同步返回 */
  PREVIEW: 'voice:preview',

  // ---- 语音输入（ASR）----
  /** 转写一段 WAV（渲染层录完的 16-bit PCM），返回 { text, engine } */
  LISTEN: 'voice:listen',

  // ---- 离线模型（可选增强）----
  /** 离线识别安装状态 */
  MODEL_STATUS: 'voice:model-status',
  /** 下载离线识别程序 + 模型（耗时长，进度走 VOICE_EVT.PROGRESS） */
  MODEL_DOWNLOAD: 'voice:model-download',
  /** 停掉常驻的离线识别服务，把内存还回去 */
  SERVER_STOP: 'voice:server-stop'
}

/** 主进程 → 渲染层的语音事件（on） */
export const VOICE_EVT = {
  /** 离线模型下载进度 { kind:'download', stage:'cli'|'model', file, received, total } */
  PROGRESS: 'voice:progress',
  /** 语音合成失败 / 引擎降级提示 { kind:'fallback'|'error', from, to, message } */
  NOTICE: 'voice:notice',
  /** 失去语音归属（形态切换）：收到就停止朗读，避免隐藏的窗继续发声（V01 修复） */
  OWNER_LOST: 'voice:owner-lost'
}

/**
 * 语音默认设置（settings.json 里的 `voice` 段）。
 *
 * 与 DEFAULT_SETTINGS 分开维护的原因见文件头。读取方一律用
 * `{ ...DEFAULT_VOICE_SETTINGS, ...(settings.voice || {}) }` 兜底，
 * 所以用户没写过 voice 段也不会出错。
 */
export const DEFAULT_VOICE_SETTINGS = {
  /** 语音总开关：关掉就完全不出声（她也不会去听） */
  ttsEnabled: true,
  /** TTS 引擎 id（见 core/voice/engines.js 的 TTS_ENGINES） */
  ttsEngine: 'edge',
  /**
   * 每个引擎各自记住的音色。
   * edge 预填 zh-CN-XiaoxiaoNeural：2026-10-15 用户听完 docs/voice-samples/ 三份样本
   * （A 晓晓·温暖 / B 晓伊·活泼 / C SAPI 慧慧）后定稿选 A。写在这里而不是依赖
   * EDGE_VOICES[0]，是为了让「默认音色」成为显式数据——列表日后调整顺序也不会变默认。
   */
  voiceByEngine: { edge: 'zh-CN-XiaoxiaoNeural' },
  /** 在凪的基准声线上的额外语速偏移（百分比，负=更慢） */
  rate: 0,
  /** 音量 0–100 */
  volume: 100,
  /** 她回复完自动念出来 */
  speakOnReply: true,
  /** 主动搭话 / 日程提醒也念出来 */
  speakOnProactive: true,
  /** 口型同步：说话时驱动 Live2D 嘴部参数 */
  lipSync: true,
  /** ASR 引擎 id（见 core/voice/engines.js 的 ASR_ENGINES） */
  asrEngine: 'sherpa',
  /** 识别语言/区域（本机 SAPI 用） */
  asrCulture: 'zh-CN',
  /** 单次录音上限（毫秒），到点自动结束并送去识别 */
  maxRecordMs: 60000,
  /**
   * 非语言语气音（回合首尾的「嗯。」/「唉……」等，无语义）。
   * **默认关闭**：enabled=false 且 probability=0 —— 不改这两项就一个字都不多念。
   * 用现有 TTS 念极短文本实现，不引入新引擎、不引入音频素材。
   * probability 上限由 core/voice/backchannel.js 夹住（0.3），配再高也不会变口头禅。
   */
  backchannel: {
    enabled: false,
    probability: 0,
    /** 每天最多几次（0 = 不限次数，但仍受概率与间隔约束） */
    perDayMax: 4,
    /** 两次之间最小间隔（毫秒） */
    minIntervalMs: 3 * 60 * 1000,
    /** 深夜是否仍允许（默认不允许） */
    allowAtNight: false
  }
}

/** 取一份合并后的语音设置（缺项自动补默认） */
export function mergeVoiceSettings(raw) {
  return { ...DEFAULT_VOICE_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) }
}
