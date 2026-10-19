// src/main/settings-store.js
// userData/settings.json 的读写与默认值合并（不含密钥——密钥走 keystore）。

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, PROVIDER_PRESETS } from '../shared/protocol.js'
import { repairBlacklist } from '../core/monitor/privacy.js'
import { reportCatch, CATCH_CLASS } from './maintenance.js'

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

/**
 * 保存设置。**落盘失败绝不静默**（G3 / B8 必修，ff95ee3a 基线即有的漏网）。
 *
 * 旧实现只 `console.error` 后无条件 `return next`：调用方（IPC / 托盘 / 监测授权 /
 * 外部便签）因此全部"正常成功"，renderer 把开关刷成新值，而磁盘根本没写——
 * 重启后恢复默认。对 `privacy.noticeShown` / `privacy.monitorAuthorizedAt` /
 * 监测开关这类**高敏项**，这就是"UI 显示已关闭、实际还在采"的隐私假关闭。
 * 旧实现还是个"假防护"：调用方写的 `try/catch + reportCatch` 永远不会触发，
 * 因为这里根本不抛错（空 catch 扫描也扫不到——它是带 console.error 的非空 catch）。
 *
 * 三条硬规则：
 * 1. **落盘成功才更新 cache**。失败时内存保持旧值，与磁盘一致——内存不得被当成
 *    "已经生效"，否则本轮会话的行为会和重启后对不上。
 * 2. **失败按 B8 单点上报**（站点 `settings.saveSettings`，MUST_PERSIST），
 *    进健康状态与轨迹；退出刷盘时 settings.json 也纳入 persist-warnings（见 persist.js）。
 * 3. **向上抛**，让 IPC 如实回失败、托盘不广播假成功。
 *
 * 上报与抛出的错误都**不含文件路径**（只带 fs 的 code）：路径是内部信息，
 * 且 `redactMessage` 会打码盘符/用户目录——两处都不该出现用户内容或完整路径。
 */
export function saveSettings(patch) {
  const next = rememberActiveLlm(deepMerge(loadSettings(), patch || {}))
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    const code = err && err.code ? String(err.code) : 'unknown'
    const detail = `无法写入 settings.json（${code}）`
    // 单点上报：调用方的 catch 只做控制流，不再重复 reportCatch
    reportCatch('settings.saveSettings', CATCH_CLASS.MUST_PERSIST, new Error(detail))
    console.error('[settings] 写入失败，设置未生效：', detail)
    throw new Error(`保存设置失败：${detail}。请检查设置目录是否可写后重试。`)
  }
  cache = next
  return next
}

export function settingsPath() {
  return file()
}
