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

/** 归一化一个 llm 配置，补全 baseURL/model */
export function resolveLlm(cfg = {}) {
  const key = cfg.provider || 'openai'
  const preset = PROVIDERS[key] || PROVIDERS.custom
  return {
    provider: key,
    label: preset.label,
    baseURL: (cfg.baseURL || preset.baseURL || '').replace(/\/+$/, ''),
    model: cfg.model || preset.model || '',
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.7
  }
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
