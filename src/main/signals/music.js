import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resourcesDir } from '../paths.js'
import { getSettings } from '../settings-store.js'
import { runPowerShell } from '../voice/ps.js'
import { MusicSignal } from '../../core/signals/music-store.js'

async function readSystemMedia() {
  const dir = join(app.getPath('userData'), 'signals')
  mkdirSync(dir, { recursive: true })
  const output = join(dir, 'music-result-' + randomUUID() + '.json')
  try {
    const result = await runPowerShell(join(resourcesDir, 'music', 'smtc.ps1'), ['-OutFile', output], { timeoutMs: 8000 })
    if (!result.ok || !existsSync(output)) throw new Error('Windows 媒体会话读取失败：' + (result.error || result.stderr || result.code))
    return JSON.parse(readFileSync(output, 'utf8'))
  } finally {
    rmSync(output, { force: true })
  }
}

let music = null
let timer = null
export function getMusicSignal() {
  if (!music) music = new MusicSignal(app.getPath('userData'), {
    probe: readSystemMedia,
    doNotDisturb: () => Boolean(getSettings().privacy?.doNotDisturb || getSettings().privacy?.onlyPresence)
  })
  return music
}

export async function musicStatus(refresh = false) {
  return getMusicSignal().status({ refresh })
}

export async function authorizeMusic() {
  const signal = getMusicSignal()
  signal.authorize()
  try { return await signal.status({ refresh: true }) }
  catch (err) { return { authorized: true, error: err.message, observation: null } }
}

export function revokeMusic() {
  return getMusicSignal().revoke()
}

export function currentMusicContext() {
  return getMusicSignal().context()
}

export function startMusicMonitor() {
  if (timer) return
  timer = setInterval(() => {
    const signal = getMusicSignal()
    if (!signal.authorized()) return
    signal.status({ refresh: true }).catch((err) => console.warn('[music] 读取失败：', err.message))
  }, 60000)
  timer.unref?.()
  if (getMusicSignal().authorized()) {
    getMusicSignal().status({ refresh: true }).catch((err) => console.warn('[music] 读取失败：', err.message))
  }
}

export function stopMusicMonitor() {
  if (timer) clearInterval(timer)
  timer = null
}
