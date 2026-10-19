// test/b7-batch1-now-injection.test.js
// B7 core 边界迁移**第一批**的防回潮锁（DECISIONS D69）。
//
// 范围：src/core/signals/{calendar,foreground,music,players}.js + src/core/export/build.js。
// 这一批的共同点：都是**纯函数**，只要一个"现在"就能算，原来靠 `now = Date.now()` 默认值。
// 默认值是 B7 里最隐蔽的一类违约——它不报错，只在某个分支上让结果变得不可复现。
//
// 三条判据（缺一条这批就算没迁完）：
//   ① 缺 now 必须**当场抛** TypeError（不许静默退回全局时钟）；
//   ② 同一个 now + 同一个输入 → 输出逐字相同（确定性，两次调用对比）；
//   ③ 输出里的时间字段必须等于注入值（证明用的是注入的那个"现在"，不是碰巧一样）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { requireNow } from '../src/core/clock.js'
import { parseCalendar, calendarContext } from '../src/core/signals/calendar.js'
import { foregroundContext } from '../src/core/signals/foreground.js'
import { normalizeMediaObservation, musicContext } from '../src/core/signals/music.js'
import { buildFallbackObservation } from '../src/core/signals/players.js'
import { buildExportBundle } from '../src/core/export/build.js'

// 2023-11-14：必须早于下面那条 ICS（2027）的 DTSTART，事件才算"未来"，
// 否则 parseCalendar 会按"已过去"把它过滤掉，测试就变成空跑
const NOW = 1_700_000_000_000
const MISSING = /缺少注入依赖/

// 一条最小可用 ICS：DTSTART/DTEND 都在 NOW 之后，保证事件不会被"已过去"过滤掉
const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:batch1-1',
  'DTSTART:20270101T090000Z',
  'DTEND:20270101T100000Z',
  'SUMMARY:批次一验收会',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

/** 每个入参形态都试一遍：undefined / null / NaN / 字符串 —— 一律必须抛 */
function assertThrowsOnMissingNow(fn, site) {
  for (const bad of [undefined, null, NaN, '1800000000000']) {
    assert.throws(() => fn(bad), (err) => {
      assert.ok(err instanceof TypeError, `${site} 收到 ${String(bad)} 应抛 TypeError`)
      assert.match(err.message, MISSING, `${site} 的报错要指明缺的是注入依赖`)
      assert.match(err.message, new RegExp(site), `${site} 的报错要指明位置`)
      return true
    })
  }
}

test('B7-1-01 requireNow：非有限数一律抛 TypeError，并指明位置', () => {
  assert.equal(requireNow(NOW, 'demo'), NOW)
  assert.equal(requireNow(0, 'demo'), 0, '0 是合法时间戳（1970），不是"没传"')
  for (const bad of [undefined, null, NaN, Infinity, '1', {}]) {
    assert.throws(() => requireNow(bad, 'demo.site'), /demo\.site 缺少注入依赖：now/)
  }
})

test('B7-1-02 parseCalendar / calendarContext：缺 now 当场抛', () => {
  assertThrowsOnMissingNow((n) => parseCalendar(ICS, n), 'parseCalendar')
  assertThrowsOnMissingNow((n) => calendarContext([], n), 'calendarContext')
  // 正向：注入之后正常工作
  const parsed = parseCalendar(ICS, NOW)
  assert.equal(parsed.events.length, 1)
  // calendarContext 只看 48 小时窗口，用相对 NOW 的事件单独验（ICS 里那条是 2027，远期）
  const soon = [{ id: 'x', title: '批次一验收会', startsAt: NOW + 3600000, endsAt: null, allDay: false }]
  assert.ok(calendarContext(soon, NOW).some((line) => line.includes('批次一验收会')))
  assert.deepEqual(calendarContext(soon, NOW + 3 * 86400000), [], '超出 48 小时窗口就不该出现')
})

test('B7-1-03 foregroundContext：缺 now 当场抛（enabled=false 与无样本先返回空，不看时钟）', () => {
  assertThrowsOnMissingNow((n) => foregroundContext({ app: 'Code', ts: NOW }, n), 'foregroundContext')
  // 这两条不需要"现在"就能判定，属确定性短路，不应该因为缺 now 就抛
  assert.deepEqual(foregroundContext({ app: 'Code', ts: NOW }, undefined, { enabled: false }), [])
  assert.deepEqual(foregroundContext(null, undefined), [])
  // 正向
  const lines = foregroundContext({ app: 'Code', ts: NOW }, NOW + 100)
  assert.ok(Array.isArray(lines))
})

test('B7-1-04 normalizeMediaObservation / musicContext：缺 now 当场抛', () => {
  const raw = { available: true, app: 'cloudmusic', title: '约定', artist: '王菲', playbackStatus: 'playing' }
  assertThrowsOnMissingNow((n) => normalizeMediaObservation(raw, n), 'normalizeMediaObservation')
  assertThrowsOnMissingNow((n) => musicContext({ available: false, observedAt: NOW }, n), 'musicContext')
  // 正向：observedAt 必须等于注入值（不是碰巧）
  const obs = normalizeMediaObservation(raw, NOW)
  assert.equal(obs.observedAt, NOW)
  assert.equal(obs.available, true)
})

test('B7-1-05 buildFallbackObservation：缺 now 当场抛', () => {
  assertThrowsOnMissingNow(
    (n) => buildFallbackObservation([{ process: 'cloudmusic', title: '约定 - 王菲' }], n),
    'buildFallbackObservation')
  const obs = buildFallbackObservation([{ process: 'cloudmusic', title: '约定 - 王菲' }], NOW)
  assert.equal(obs.available, true)
  // 这个函数返回的是"待归一化的原始观测"，不直接带 observedAt；
  // 注入的 at 落在每条 session 的 updatedAt 上——那才是"她看到的这一刻"。
  assert.equal(obs.sessions[0].updatedAt, NOW, 'updatedAt 必须来自注入的 at')
})

test('B7-1-06 buildExportBundle：缺 now 当场抛，exportedAt 等于注入值', () => {
  assertThrowsOnMissingNow((n) => buildExportBundle({}, n), 'buildExportBundle')
  const a = buildExportBundle({}, NOW)
  const b = buildExportBundle({}, NOW)
  assert.equal(a.exportedAt, NOW)
  assert.deepEqual(a, b, '同一输入同一 now 必须逐字相同（默认值一旦回来就会漂）')
})

test('B7-1-07 确定性：同一 now + 同一输入 → 两次调用输出逐字相同', () => {
  const runs = () => [
    parseCalendar(ICS, NOW),
    calendarContext(parseCalendar(ICS, NOW).events, NOW),
    foregroundContext({ app: 'Code', title: 'nagi', ts: NOW }, NOW + 500),
    normalizeMediaObservation({ available: true, app: 'cloudmusic', title: '约定', playbackStatus: 'paused' }, NOW),
    buildFallbackObservation([{ process: 'cloudmusic', title: '约定 - 王菲' }], NOW)
  ]
  assert.deepEqual(runs(), runs())
})

test('B7-1-08 反向锁：哪天真把默认值放回来，这条必须红', async () => {
  // 读源码断言签名里没有 `now = Date.now()` 这种默认值。
  // 为什么不靠"调用一次看它抛不抛"：默认值一旦回来，调用不抛就变成静默通过；
  // 源码断言不依赖运行时分支，回潮必红。
  const { readFileSync } = await import('node:fs')
  const files = [
    'src/core/signals/calendar.js',
    'src/core/signals/foreground.js',
    'src/core/signals/music.js',
    'src/core/signals/players.js',
    'src/core/export/build.js'
  ]
  for (const file of files) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    const offenders = text.split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(({ line }) => /=\s*Date\.now\s*\(\s*\)/.test(line))
    assert.deepEqual(offenders, [], `${file} 里不许出现 Date.now() 默认值：` +
      JSON.stringify(offenders.map((o) => o.n + ':' + o.line.trim())))
  }
})
