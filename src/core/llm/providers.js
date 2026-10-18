// src/core/llm/providers.js
// 各家 OpenAI 兼容提供商的预设与解析。

import { PROVIDER_PRESETS } from '../../shared/protocol.js'
import { OLLAMA_PLACEHOLDER_KEY, ollamaTagsUrl } from './ollama.js'

export const PROVIDERS = PROVIDER_PRESETS

export function isLocalLlm(cfg = {}) {
  return cfg.provider === 'ollama'
}

/** OpenAI SDK 要求非空 key；本机 Ollama 不验证它，也不使用云端保存的 Key。 */
export function apiKeyForLlm(cfg = {}, savedKey = null) {
  if (isLocalLlm(cfg)) {
    if (!ollamaTagsUrl(cfg.baseURL)) throw new Error('Ollama 地址必须是本机 http://localhost:端口/v1')
    return OLLAMA_PLACEHOLDER_KEY
  }
  return savedKey || null
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([key, v]) => ({ key, ...v }))
}

/** 用途枚举（D2 卡「按模型/用途存参数」）。只用于覆盖 llm 参数，不改变通道语义。 */
export const LLM_PURPOSES = Object.freeze(['chat', 'diary', 'proactive', 'extract'])

export const LLM_PURPOSE_LABELS = Object.freeze({
  chat: '主对话',
  diary: '日记',
  proactive: '主动开口',
  extract: '记忆抽取'
})

function isTemp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2
}

/**
 * 归一化一个 llm 配置，补全 baseURL/model，并可叠加**按用途**的参数覆盖。
 *
 * `cfg.purposeParams = { diary: { temperature, model }, extract: {...} }`：
 *   · 只认已知字段与合法值（temperature 0–2、非空 model/baseURL），非法值忽略；
 *   · 没有配置时**与不传 purpose 完全一致**——这条很重要，否则"加个能力"就会悄悄改行为；
 *   · 不修改传入的 cfg（返回新对象）。
 *
 * @param {object} cfg 用户设置里的 llm 段
 * @param {string} [purpose] LLM_PURPOSES 之一
 * @param {{defaultTemperature?:number}} [opts] 该用途的缺省温度（覆盖全局缺省 1.3）
 */
export function resolveLlm(cfg = {}, purpose = 'chat', { defaultTemperature } = {}) {
  const key = cfg.provider || 'openai'
  const preset = PROVIDERS[key] || PROVIDERS.custom
  const table = cfg.purposeParams && typeof cfg.purposeParams === 'object' ? cfg.purposeParams : {}
  const over = table[purpose] && typeof table[purpose] === 'object' ? table[purpose] : {}

  // 2026-10-18：0.7 → 1.3。DeepSeek 官方对「通用对话」推荐 1.3；
  // 0.7 会让输出偏向"最稳、最像格言"的表达，是电报体与金句感的放大器。
  // 已写入设置的用户显式值仍然优先（这里只是缺省值）。
  let temperature = typeof cfg.temperature === 'number' ? cfg.temperature : 1.3
  if (isTemp(defaultTemperature)) temperature = defaultTemperature
  if (isTemp(over.temperature)) temperature = over.temperature

  const model = typeof over.model === 'string' && over.model.trim()
    ? over.model.trim()
    : (cfg.model || preset.model || '')
  const baseURL = typeof over.baseURL === 'string' && over.baseURL.trim()
    ? over.baseURL.trim().replace(/\/+$/, '')
    : (cfg.baseURL || preset.baseURL || '').replace(/\/+$/, '')

  return { provider: key, label: preset.label, baseURL, model, temperature }
}

/** 该 provider 是否支持原生 function calling（其余走 prompt JSON 兜底） */
export function supportsNativeTools(cfg = {}) {
  const key = cfg.provider || 'openai'
  if (key === 'openai' || key === 'deepseek' || key === 'qwen' || key === 'kimi' || key === 'glm' || key === 'openrouter') {
    return true
  }
  // 混元仅部分型号支持；hunyuan-chat 不支持 → 默认兜底
  if (key === 'hunyuan') return /turbos|t1|functioncall/i.test(String(cfg.model || ''))
  // Ollama 的兼容接口支持 tools，但具体模型能否正确调用仍需真机验证。
  if (key === 'ollama') return true
  return false
}
