// src/main/keystore.js
// 用 Electron safeStorage 加密落盘敏感信息（API key / HA token）。
// 明文只在主进程内存里出现；渲染进程只能 "保存 / 查是否已配置 / 删除"。

import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cache = null

function file() {
  return join(app.getPath('userData'), 'secrets.json')
}

function loadAll() {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist() {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.error('[keystore] 写入失败：', err.message)
  }
}

/** 保存一条密钥（加密后落盘） */
export function setSecret(key, plaintext) {
  loadAll()
  if (!plaintext) {
    delete cache[key]
    persist()
    return { ok: true, configured: false }
  }
  if (safeStorage.isEncryptionAvailable()) {
    cache[key] = { enc: 'safeStorage', value: safeStorage.encryptString(String(plaintext)).toString('base64') }
  } else {
    // 极端环境（无系统钥匙串）降级：标记为 plain，仅本地文件权限保护
    console.warn('[keystore] safeStorage 不可用，降级为明文存储（不推荐）')
    cache[key] = { enc: 'plain', value: Buffer.from(String(plaintext), 'utf8').toString('base64') }
  }
  persist()
  return { ok: true, configured: true }
}

/** 仅主进程内部调用：取明文 */
export function getSecret(key) {
  const all = loadAll()
  const item = all[key]
  if (!item) return null
  try {
    if (item.enc === 'safeStorage') return safeStorage.decryptString(Buffer.from(item.value, 'base64'))
    return Buffer.from(item.value, 'base64').toString('utf8')
  } catch (err) {
    console.error('[keystore] 解密失败：', err.message)
    return null
  }
}

export function hasSecret(key) {
  return Boolean(loadAll()[key])
}

export function deleteSecret(key) {
  loadAll()
  if (key in cache) {
    delete cache[key]
    persist()
  }
  return { ok: true, configured: false }
}

/** 给渲染层用的状态（不含明文） */
export function secretStatus(keys) {
  const out = {}
  for (const k of keys) out[k] = hasSecret(k)
  return out
}
