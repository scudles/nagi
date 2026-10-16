// src/core/voice/index.js
// 语音纯逻辑层对外出口（分句 / 口型 / 引擎注册表）。
//
// 契约（main/voice 的适配器必须满足，上层只认这个）：
//   TTS：speak(text, opts) → AsyncIterable<{ chunk: Buffer|Uint8Array }>，最后 yield { done: true, durationMs }
//   ASR：transcribe(pcmOrWav, opts) → Promise<{ text: string, confidence?: number }>

export {
  createSegmenter,
  splitSentences,
  toSpeechText,
  SEG_DEFAULTS
} from './segmenter.js'

export {
  createLipTrack,
  estimateUnits,
  LIP_DEFAULTS
} from './lip.js'

export {
  encodeWav,
  readWavHeader,
  extractPcm,
  pcmToFloat32,
  toAsrWav,
  resample,
  trimSilence,
  rms,
  peak,
  pcmDurationMs,
  WAV_HEADER_BYTES,
  ASR_SAMPLE_RATE
} from './wav.js'

export {
  buildSherpaFrame,
  readSherpaHeader,
  parseSherpaReply,
  SHERPA_HEADER_BYTES,
  SHERPA_SAMPLE_RATE,
  SHERPA_DONE
} from './sherpa-frame.js'

export {
  isAsciiPath,
  sherpaLaunchPlan
} from './sherpa-launch.js'

export {
  TTS_ENGINES,
  ASR_ENGINES,
  TTS_FALLBACK,
  ASR_FALLBACK,
  EDGE_VOICES,
  NAGI_VOICE,
  MOOD_SPEECH,
  mergeVoiceParams,
  pickEngine,
  noEngineAvailable
} from './engines.js'

export {
  VOICE_PROFILE,
  resolveVoiceProfile
} from './voice-profile.js'
