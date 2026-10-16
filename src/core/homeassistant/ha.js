// src/core/homeassistant/ha.js
// Home Assistant 客户端：REST（列设备/查状态/控制/场景）+ WebSocket（订阅状态事件）。
// 纯 Node 依赖（fetch + ws 包）。

import WebSocket from 'ws'

export class HAClient {
  /**
   * @param {{baseURL:string, token:string, onEvent?:(info:object)=>void}} opts
   */
  constructor({ baseURL, token, onEvent } = {}) {
    this.baseURL = String(baseURL || '').replace(/\/+$/, '')
    this.token = token || ''
    this.onEvent = onEvent || null
    this.ws = null
    this.wsTimer = null
    this.wsBackoff = 2000
    this.wsAlive = false
    this.eventsEnabled = false
  }

  get configured() {
    return Boolean(this.baseURL && this.token)
  }

  async request(method, path, body) {
    if (!this.baseURL || !this.token) throw new Error('Home Assistant 未配置（地址或 Token 缺失）')
    const res = await fetch(this.baseURL + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HA ${method} ${path} → HTTP ${res.status}${text ? '：' + text.slice(0, 200) : ''}`)
    }
    if (res.status === 200 || res.status === 201) {
      const ct = res.headers.get('content-type') || ''
      return ct.includes('json') ? res.json() : res.text()
    }
    return null
  }

  /** 测试连接（GET /api/ 应返回 "API running."） */
  async test() {
    const r = await this.request('GET', '/api/')
    const ok = typeof r === 'string' ? /API running/i.test(r) : Boolean(r)
    return { ok, message: typeof r === 'string' ? r : JSON.stringify(r) }
  }

  /** 列实体，可按域过滤（如 light / switch / sensor） */
  async listEntities({ domain } = {}) {
    const states = await this.request('GET', '/api/states')
    const arr = Array.isArray(states) ? states : []
    const filtered = domain ? arr.filter((s) => s.entity_id.startsWith(domain + '.')) : arr
    return filtered.map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      unit: s.attributes?.unit_of_measurement || '',
      domain: s.entity_id.split('.')[0]
    }))
  }

  async getState(entityId) {
    const s = await this.request('GET', `/api/states/${encodeURIComponent(entityId)}`)
    if (!s) return null
    return {
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      attributes: s.attributes
    }
  }

  /** 调服务，如 callService('light','turn_on',{entity_id:'light.x', brightness_pct:60}) */
  async callService(domain, service, data = {}) {
    await this.request('POST', `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, data)
    return { ok: true }
  }

  /** 触发场景/脚本：entity_id 形如 scene.xxx / script.xxx */
  async trigger(entityId) {
    const [domain] = entityId.split('.')
    return this.callService(domain, 'turn_on', { entity_id: entityId })
  }

  /* ---------------- WebSocket 事件订阅 ---------------- */

  startEvents() {
    if (!this.configured) return
    this.eventsEnabled = true
    if (this.ws) return
    this.connectWs()
  }

  connectWs() {
    if (!this.eventsEnabled || this.ws) return
    const wsURL = this.baseURL.replace(/^http/, 'ws') + '/api/websocket'
    let ws
    try {
      ws = new WebSocket(wsURL, { headers: { Authorization: `Bearer ${this.token}` } })
    } catch (err) {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.on('open', () => {
      this.wsAlive = true
      this.wsBackoff = 2000
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }))
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, type: 'subscribe_events' }))
      } else if (msg.type === 'auth_invalid') {
        this.wsAlive = false
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      } else if (msg.type === 'event' && msg.event && this.onEvent) {
        try {
          this.onEvent({ event_type: msg.event.event_type, data: msg.event.data })
        } catch {
          /* ignore */
        }
      }
    })
    ws.on('close', () => {
      this.wsAlive = false
      if (this.ws === ws) {
        this.ws = null
        this.scheduleReconnect()
      }
    })
    ws.on('error', () => {
      /* close 会跟着触发 */
    })
  }

  scheduleReconnect() {
    if (this.wsTimer || !this.configured || !this.eventsEnabled) return
    this.wsTimer = setTimeout(() => {
      this.wsTimer = null
      this.connectWs()
    }, this.wsBackoff)
    this.wsBackoff = Math.min(this.wsBackoff * 2, 60000)
  }

  stopEvents() {
    this.eventsEnabled = false
    if (this.wsTimer) {
      clearTimeout(this.wsTimer)
      this.wsTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.wsAlive = false
  }
}

/**
 * 把 HA 状态变化转成给用户看的摘要（供主动提醒用）。
 * 只挑值得说的事：设备从 off→on、传感器越过阈值、长按场景等。
 */
export function summarizeHaEvent(evt) {
  if (!evt || evt.event_type !== 'state_changed') return null
  const { entity_id, new_state, old_state } = evt.data || {}
  if (!new_state) return null
  const name = new_state.attributes?.friendly_name || entity_id
  const domain = entity_id?.split('.')[0]
  const from = old_state?.state
  const to = new_state.state
  if (from === to) return null
  if (['light', 'switch', 'fan', 'climate', 'media_player'].includes(domain)) {
    if (to === 'on' && from !== 'on') return `${name} 已打开`
    if (to === 'off' && from !== 'off') return `${name} 已关闭`
    return `${name}：${from} → ${to}`
  }
  if (domain === 'sensor' && new_state.attributes?.unit_of_measurement) {
    return `${name}：${to}${new_state.attributes.unit_of_measurement}`
  }
  if (domain === 'binary_sensor' && to === 'on') return `${name} 触发了`
  return `${name}：${to}`
}
