// src/main/settings-store.js
// userData/settings.json 的读写与默认值合并（不含密钥——密钥走 keystore）。

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/protocol.js'

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

export function loadSettings() {
  if (cache) return cache
  let raw = {}
  try {
    if (existsSync(file())) raw = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    raw = {}
  }
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), raw)
  return cache
}

export function getSettings() {
  return loadSettings()
}

export function saveSettings(patch) {
  const next = deepMerge(loadSettings(), patch || {})
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
