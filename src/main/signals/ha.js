import { app } from 'electron'
import { HAClient, summarizeHaEvent } from '../../core/homeassistant/ha.js'
import { HaConsent, mayControlHa } from '../../core/signals/ha-consent.js'
import { getSettings } from '../settings-store.js'
import { getSecret, hasSecret, deleteSecret } from '../keystore.js'
import { broadcast } from '../windows.js'
import { EVT, SECRET_KEYS } from '../../shared/protocol.js'

let consent = null
let client = null
let lastEvent = null
const getConsent = () => (consent ||= new HaConsent(app.getPath('userData')))
const quiet = () => Boolean(getSettings().privacy?.doNotDisturb || getSettings().privacy?.onlyPresence)

export function haSignalStatus() {
  const grants = getConsent().status()
  const cfg = getSettings().homeassistant || {}
  return { readAuthorized: Boolean(grants.readAt), controlAuthorized: Boolean(grants.controlAt),
    configured: Boolean(cfg.enabled && cfg.baseURL && hasSecret(SECRET_KEYS.HA_TOKEN)),
    paused: quiet(), lastEvent }
}

function onHaEvent(evt) {
  if (!getConsent().status().readAt || quiet()) return
  const summary = summarizeHaEvent(evt)
  if (!summary) return
  lastEvent = { summary, entityId: String(evt.data?.entity_id || ''), observedAt: Date.now() }
  broadcast(EVT.HA_EVENT, { summary, entity_id: lastEvent.entityId })
}

export function getHa() {
  const status = haSignalStatus()
  if (!status.readAuthorized || !status.configured) { stopHaSignals(); return null }
  const cfg = getSettings().homeassistant
  const token = getSecret(SECRET_KEYS.HA_TOKEN)
  if (!client || client.baseURL !== cfg.baseURL || client.token !== token) {
    if (client) client.stopEvents()
    client = new HAClient({ baseURL: cfg.baseURL, token, onEvent: onHaEvent })
  }
  if (status.paused) {
    client.stopEvents()
    lastEvent = null
  }
  else client.startEvents()
  return client
}

export function refreshHaSignals() { getHa() }

export function stopHaSignals() {
  if (client) client.stopEvents()
  client = null
}

export function allowHaRead() {
  const grant = getConsent().allowRead()
  refreshHaSignals()
  return { ok: true, ...haSignalStatus(), readAt: grant.readAt }
}

export function allowHaControl() {
  if (!haSignalStatus().configured) return { ok: false, error: '请先配置并连接 Home Assistant' }
  getConsent().allowControl()
  return { ok: true, ...haSignalStatus() }
}

export function revokeHaControl() {
  getConsent().revokeControl()
  return { ok: true, ...haSignalStatus() }
}

export function revokeHaAll() {
  getConsent().revokeAll()
  stopHaSignals()
  lastEvent = null
  deleteSecret(SECRET_KEYS.HA_TOKEN)
  return { ok: true, ...haSignalStatus() }
}

export function canControlHa() {
  return mayControlHa(getConsent().status(), quiet())
}

export function haReadAllowed() {
  return Boolean(getConsent().status().readAt && !quiet())
}

export function haContext(now = Date.now()) {
  if (!getConsent().status().readAt || quiet() || !lastEvent || now - lastEvent.observedAt > 300000) return []
  return ['用户授权的 Home Assistant 设备状态事件：' + lastEvent.summary +
    '。这是设备报告，不能据此推断用户做了什么。']
}

export async function haTest() {
  const cfg = getSettings().homeassistant || {}
  if (!cfg.baseURL) return { ok: false, error: '尚未配置 Home Assistant 地址' }
  if (!hasSecret(SECRET_KEYS.HA_TOKEN)) return { ok: false, error: '尚未配置 Home Assistant Token' }
  try {
    const probe = new HAClient({ baseURL: cfg.baseURL, token: getSecret(SECRET_KEYS.HA_TOKEN) })
    const r = await probe.test()
    return { ok: r.ok, error: r.ok ? null : 'HA 响应异常：' + r.message }
  } catch (err) { return { ok: false, error: err.message } }
}

export async function haList(domain) {
  if (!getConsent().status().readAt) return { ok: false, error: '请先单独授权读取 HA 设备状态' }
  const cfg = getSettings().homeassistant || {}
  if (!cfg.baseURL || !hasSecret(SECRET_KEYS.HA_TOKEN)) {
    return { ok: false, error: '尚未配置 Home Assistant（地址 + Token）' }
  }
  try {
    const probe = new HAClient({ baseURL: cfg.baseURL, token: getSecret(SECRET_KEYS.HA_TOKEN) })
    const list = await probe.listEntities({ domain })
    if (!getConsent().status().readAt) return { ok: false, error: 'HA 读取授权已撤销' }
    return { ok: true, count: list.length, entities: list.slice(0, 100) }
  } catch (err) { return { ok: false, error: err.message } }
}
