import test from 'node:test'
import assert from 'node:assert/strict'
import { GeoSignal, GEO_TTL_MS, geoContext, normalizeGeoObservation } from '../src/core/signals/geo-store.js'
import { createMemoryDocumentIo } from '../src/core/store/document-io.js'

test('坐标信号默认不读取；授权、TTL、勿扰和撤销各自生效', async () => {
  let calls = 0
  let dnd = false
  const io = createMemoryDocumentIo()
  const signal = new GeoSignal({
    io,
    now: () => 1000, // B7（P2-05）：时钟由外部注入，core 不读 Date.now()
    probe: async () => {
      calls++
      return { available: true, lat: 34.05, lon: -118.24, city: 'Los Angeles', country: 'United States', source: 'ip' }
    },
    doNotDisturb: () => dnd
  })
  assert.equal((await signal.status({ refresh: true })).authorized, false)
  assert.equal(calls, 0)
  signal.authorize(100)
  const first = await signal.status({ refresh: true, now: 200 })
  assert.equal(first.authorized, true)
  assert.equal(first.observation.lat, 34.05)
  assert.equal(calls, 1)
  // TTL 内不重复探测（位置不需要每分钟刷新）
  await signal.status({ now: 200 + GEO_TTL_MS - 1000 })
  assert.equal(calls, 1)
  // 过期后重新探测
  await signal.status({ now: 200 + GEO_TTL_MS + 1000 })
  assert.equal(calls, 2)
  dnd = true
  assert.equal((await signal.status({ refresh: true, now: 300 })).paused, 'do-not-disturb')
  assert.deepEqual(signal.context(400), [])
  dnd = false
  signal.revoke()
  assert.equal((await signal.status({ refresh: true, now: 500 })).authorized, false)
  assert.deepEqual(signal.context(600), [])
  assert.equal(calls, 2)
})

test('坐标归一化：系统定位与 IP 定位、坏坐标与不可用', () => {
  const win = normalizeGeoObservation({ available: true, lat: 31.2, lon: 121.5, accuracyMeters: 65, source: 'windows-api' }, 100)
  assert.equal(win.available, true)
  assert.equal(win.source, 'windows-api')
  assert.equal(win.accuracyMeters, 65)
  assert.equal(win.city, '')
  const ip = normalizeGeoObservation({ available: true, lat: 39.9, lon: 116.4, city: '北京', country: '中国', source: 'ip' }, 100)
  assert.equal(ip.source, 'ip')
  assert.equal(ip.accuracyMeters, null)
  // 越界/非法坐标视为不可用
  assert.equal(normalizeGeoObservation({ available: true, lat: 999, lon: 0 }, 1).available, false)
  assert.equal(normalizeGeoObservation({ available: true, lat: 'x', lon: 'y' }, 1).available, false)
  assert.equal(normalizeGeoObservation({ available: false, reason: 'ip-unavailable' }, 1).available, false)
  assert.equal(normalizeGeoObservation(null, 1).reason, 'unavailable')
})

test('坐标上下文：来源与精度如实说明，过期不注入', () => {
  const ip = normalizeGeoObservation({ available: true, lat: 39.9, lon: 116.4, city: '北京', country: '中国', source: 'ip' }, 100)
  const line = geoContext(ip, 200)[0]
  assert.match(line, /北京，中国/)
  assert.match(line, /IP 粗定位/)
  assert.match(line, /别说得像在精确跟踪/)
  const win = normalizeGeoObservation({ available: true, lat: 31.2, lon: 121.5, source: 'windows-api' }, 100)
  assert.match(geoContext(win, 200)[0], /系统定位/)
  // 过期
  assert.deepEqual(geoContext(ip, 100 + GEO_TTL_MS + 1), [])
  // 不可用 / 空
  assert.deepEqual(geoContext(normalizeGeoObservation({ available: false }, 100), 200), [])
  assert.deepEqual(geoContext(null, 200), [])
})
