// src/main/settings-store.js
// userData/settings.json 的读写与默认值合并（不含密钥——密钥走 keystore）。

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, PROVIDER_PRESETS } from '../shared/protocol.js'
import { repairBlacklist } from '../core/monitor/privacy.js'

let cache = null

function file() {
  return join(app.getPath('userData'), 'settings.json')
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v
  }
  return out
}

function rememberActiveLlm(settings) {
  const llm = settings.llm || {}
  if (!Object.hasOwn(PROVIDER_PRESETS, llm.provider)) return settings
  settings.llmProfiles = {
    ...(settings.llmProfiles || {}),
    [llm.provider]: {
      baseURL: llm.baseURL,
      model: llm.model,
      temperature: llm.temperature
    }
  }
  return settings
}

export function loadSettings() {
  if (cache) return cache
  let raw = {}
  try {
    if (existsSync(file())) raw = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    raw = {}
  }
  // 旧版只有 llm 当前配置：装载时补进对应提供商档案，下一次保存一并落盘。
  cache = rememberActiveLlm(deepMerge(structuredClone(DEFAULT_SETTINGS), raw))
  // 旧版本写进 settings.json 的乱码黑名单（*密码* → *瀵嗙爜*）会让中文隐私规则全部失效，
  // 装载时就地还原；下一次保存会把干净值落盘。
  if (cache.privacy) cache.privacy = { ...cache.privacy, blacklist: repairBlacklist(cache.privacy.blacklist) }
  return cache
}

export function getSettings() {
  return loadSettings()
}

export function saveSettings(patch) {
  const next = rememberActiveLlm(deepMerge(loadSettings(), patch || {}))
  cache = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] 写入失败：', err.message)
  }
  return next
}

export function settingsPath() {
  return file()
}
