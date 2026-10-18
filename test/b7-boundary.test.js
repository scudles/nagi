// B7（P2-05）验收：边界不回潮 + 注入真的生效 + 临时路径写不到生产数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scanFile, MIGRATED_GATE, BOUNDARY_RULES } from '../scripts/audit-b7-boundary.mjs'
import { GeoSignal, geoContext, GEO_TTL_MS } from '../src/core/signals/geo-store.js'
import { MusicSignal, MEDIA_TTL_MS } from '../src/core/signals/music-store.js'
import { CalendarSnapshot } from '../src/core/signals/calendar-store.js'
import { YearbookStore } from '../src/core/yearbook/store.js'
import { ExperienceLedger } from '../src/core/ledger/store.js'
import { createMemoryDocumentIo, readOnlyDocumentIo, isDocumentIo } from '../src/core/store/document-io.js'
import { createMemoryRecordIo } from '../src/core/store/record-io.js'
import { createFsDocumentIo } from '../src/main/store/document-io.js'
import { createFsRecordIo } from '../src/main/store/record-io.js'
import { createFsLegacyReader } from '../src/main/store/legacy-reader.js'

const root = resolve(import.meta.dirname, '..')

test('B7-GATE-01 已迁移文件的边界依赖归零（five stores + core/store 端口）', () => {
  for (const entry of MIGRATED_GATE) {
    const found = scanFile(join(root, ...entry.split('/')), root)
    assert.deepEqual(found.violations, [], `${entry} 又出现了越界依赖：${JSON.stringify(found.violations)}`)
  }
})

test('B7-GATE-02 检查器自检：真有 Date.now()/fs/randomUUID 时必须抓得到（防假绿）', () => {
  const probe = mkdtempSync(join(tmpdir(), 'nagi-b7-probe-'))
  try {
    const file = join(probe, 'bad.js')
    writeFileSync(file, [
      "import { randomUUID } from 'node:crypto'",
      "import { readFileSync } from 'node:fs'",
      'export const now = Date.now()',
      'export const pick = () => Math.random()',
      "/* B7:allow:directCrypto — 允许标记必须生效 */",
      "import { createHash } from 'node:crypto' /* B7:allow:directCrypto — 纯计算 */"
    ].join('\n'), 'utf8')
    const found = scanFile(file, root)
    const rules = found.violations.map((item) => item.rule).sort()
    assert.deepEqual(rules, ['directCrypto', 'directFs', 'globalClock', 'globalRandom'],
      '四類越界都必须被抓到；allow 标记的那行必须被放行')
    // 规则表本身也得有内容，别有一天被清空变成"永远通过"
    assert.ok(BOUNDARY_RULES.length >= 5)
  } finally { rmSync(probe, { recursive: true, force: true }) }
})

test('B7-INJECT-01 缺少端口/时钟/随机必须在构造时就抛，不许静默退回默认值', () => {
  const io = createMemoryDocumentIo()
  const memoryRecIo = createMemoryRecordIo()
  const emptyLegacy = { exists: () => false, list: () => [], read: () => null, readObjects: () => [] }
  assert.throws(() => new GeoSignal({ probe: async () => ({}) }), /缺少注入依赖/)
  assert.throws(() => new GeoSignal({ io, probe: async () => ({}) }), /now\(\)/)
  assert.throws(() => new MusicSignal({}), /缺少注入依赖/)
  assert.throws(() => new CalendarSnapshot({ io }), /now\(\)/)
  assert.throws(() => new YearbookStore({ io, now: () => 1, rng: () => 'a' }), /必须注入账本/)
  assert.throws(() => new ExperienceLedger({ legacy: emptyLegacy, now: () => 1, rng: () => 'a' }), /recIo/)
  assert.throws(() => new ExperienceLedger({ recIo: memoryRecIo, now: () => 1, rng: () => 'a' }), /legacy/)
  // 形状不对的端口也不能蒙混过关（只 typeof function 检查会放过空壳）
  assert.throws(() => new ExperienceLedger({ recIo: {}, legacy: emptyLegacy, now: () => 1, rng: () => 'a' }), /recIo/)
})

test('B7-INJECT-02 注入时钟后 TTL 分支确定可控（不再依赖真实等待）', async () => {
  let now = 0
  let probes = 0
  const geo = new GeoSignal({
    io: createMemoryDocumentIo(),
    now: () => now,
    probe: async () => { probes++; return { available: true, lat: 31.2, lon: 121.5, city: '上海', source: 'windows-api' } }
  })
  geo.authorize(1) // authorizedAt 必须 > 0，否则 authorized() 判为未授权
  await geo.status({ now: 1 })
  assert.equal(probes, 1)
  now = 1 + GEO_TTL_MS - 1
  assert.equal(geo.context(now).length, 1, 'TTL 内仍有上下文')
  now = 1 + GEO_TTL_MS + 1
  assert.deepEqual(geo.context(now), [], '刚过 TTL 必须立刻停止注入')
  await geo.status({ now })
  assert.equal(probes, 2, '过期后重新探测')

  let media = 0
  let musicCalls = 0
  const music = new MusicSignal({
    io: createMemoryDocumentIo(),
    now: () => media,
    probe: async () => { musicCalls++; return { available: true, sessions: [{ app: 'x', title: '歌', playbackStatus: 'Playing' }] } }
  })
  music.authorize(1)
  await music.status({ now: 1000 })
  media = 1000 + MEDIA_TTL_MS - 1
  assert.equal(music.fresh(), true)
  media = 1000 + MEDIA_TTL_MS + 1
  assert.equal(music.fresh(), false, '过了 60 秒就不许再用旧观测冒充现状')
  assert.equal(musicCalls, 1)
})

test('B7-TEMP-01 真实 fs 端口指向临时根目录，写不到别处（含生产 userData 不动）', () => {
  const fakeUserData = mkdtempSync(join(tmpdir(), 'nagi-b7-userdata-'))
  const sentinel = join(fakeUserData, 'sentinel.txt')
  writeFileSync(sentinel, '这是不能被 store 碰到的东西\n', 'utf8')
  try {
    const io = createFsDocumentIo({ root: fakeUserData, files: { 'geo-consent': 'signals/geo.json' } })
    const signal = new GeoSignal({ io, now: () => 1000, probe: async () => ({ available: false }) })
    assert.equal(existsSync(join(fakeUserData, 'signals', 'geo.json')), false)
    signal.authorize(1000)
    assert.equal(readFileSync(join(fakeUserData, 'signals', 'geo.json'), 'utf8').includes('authorizedAt'), true)
    // 只能在自己被指到的地方写：父目录不能凭空多出一个 signals/
    assert.equal(existsSync(join(fakeUserData, '..', 'signals')), false)
    assert.equal(readFileSync(sentinel, 'utf8'), '这是不能被 store 碰到的东西\n')
    signal.revoke()
    assert.equal(existsSync(join(fakeUserData, 'signals', 'geo.json')), false)

    // 真实运行时的生产目录：本次操作前后必须一模一样（只是读，不会因这次测试被创建/改写）
    const prod = process.env.APPDATA ? join(process.env.APPDATA, '凪 Nagi', 'signals', 'geo.json') : null
    if (prod && existsSync(prod)) {
      const before = readFileSync(prod, 'utf8')
      signal.authorize(2000)
      assert.equal(readFileSync(prod, 'utf8'), before, '注入端口后不得再碰到真正的生产授权文件')
      signal.revoke()
    }
  } finally { rmSync(fakeUserData, { recursive: true, force: true }) }
})

test('B7-TEMP-02 行式端口：追加保序、重写替掉旧正文、坏行不影响其余行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-b7-records-'))
  try {
    const recIo = createFsRecordIo({ root: join(dir, 'ledger'), files: { entries: 'entries.jsonl' } })
    recIo.append('entries', { id: 'a', n: 1 })
    recIo.append('entries', { id: 'b', n: 2 })
    assert.deepEqual(recIo.readObjects('entries').map((row) => row.id), ['a', 'b'])
    recIo.rewrite('entries', [{ id: 'a', n: 9 }])
    assert.deepEqual(recIo.readObjects('entries'), [{ id: 'a', n: 9 }])
    writeFileSync(join(dir, 'ledger', 'entries.jsonl'), '{"id":"ok"}\n{"id":"半行\n{"id":"ok2"}\n', 'utf8')
    assert.deepEqual(recIo.readObjects('entries').map((row) => row.id), ['ok', 'ok2'], '半行跳过后其余行照样要读到')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('B7-TEMP-03 迁移源端口拒绝越界引用（..\\ 与白名单外同等待遇）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-b7-legacy-'))
  try {
    writeFileSync(join(dir, 'memory.json'), '{"entries":[{"id":"m1","text":"可见"}]}', 'utf8')
    writeFileSync(join(dir, 'private.txt'), '不属于迁移源的东西', 'utf8')
    const reader = createFsLegacyReader({ root: dir, allow: ['memory.json'] })
    assert.equal(reader.read('memory.json').includes('可见'), true)
    assert.equal(reader.read('../private.txt'), null, '目录外的引用读不到')
    assert.equal(reader.read('private.txt'), null, '白名单外的引用同样读不到')
    assert.deepEqual(reader.list('..'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('B7-PORT-01 端口契约：缺方法的端口当场被拒，只读包装挡住写入', () => {
  assert.equal(isDocumentIo({ read: () => null }), false)
  assert.equal(isDocumentIo(createMemoryDocumentIo()), true)
  const io = createMemoryDocumentIo()
  io.write('k', 'v')
  const locked = readOnlyDocumentIo(io)
  assert.equal(locked.read('k'), 'v')
  assert.throws(() => locked.write('k', 'v2'), /只读端口/)
  assert.throws(() => locked.remove('k'), /只读端口/)
  assert.equal(io.read('k'), 'v', '被拒的写入不能落到真端口上')
})

test('B7-REGRESS-01 原行为回归：撤销之后三种信号的上下文都必须为空，且各自理由如实', async () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:x',
    'DTSTART:20261016T100000Z', 'SUMMARY:见面', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const memoryIo = createMemoryDocumentIo()
  const now = Date.UTC(2026, 9, 16, 0, 0, 0)
  const wait = () => new Promise((done) => setImmediate(done))

  const geo = new GeoSignal({ io: memoryIo, now: () => now, probe: async () => ({ available: true, lat: 31.2, lon: 121.5, city: '上海' }) })
  const music = new MusicSignal({ io: memoryIo, now: () => now, probe: async () => ({ available: true, sessions: [{ app: 'x', title: '歌', playbackStatus: 'Playing' }] }) })
  const calendar = new CalendarSnapshot({ io: memoryIo, now: () => now })
  calendar.importText(ics, 'a.ics', now)
  assert.equal(calendar.authorized !== false, true)

  geo.authorize(1)
  music.authorize(1)
  await geo.status({ refresh: true })
  await music.status({ refresh: true })
  await wait()
  assert.ok(geo.context(now).length > 0)
  assert.ok(music.context(now).length > 0)
  assert.ok(calendar.context(now).length > 0)

  geo.revoke()
  music.revoke()
  calendar.revoke()
  assert.deepEqual(geo.context(now), [], '坐标撤销后不该还在附注里说他在哪')
  assert.deepEqual(music.context(now), [], '音乐撤销后不该还在说他在听什么')
  assert.deepEqual(calendar.context(now), [], '日历撤销后不该还在说今天有什么安排')
})

test('B7-REGRESS-02 原行为回归：账本 + 年鉴端到端仍然分层正确', () => {
  const ports = {
    recIo: createMemoryRecordIo(),
    legacy: { exists: () => false, list: () => [], read: () => null, readObjects: () => [] },
    now: () => 1000,
    rng: randomUUID
  }
  const ledger = new ExperienceLedger(ports).load()
  const real = ledger.record({ category: 'experience', text: '他：一起做的事', source: { type: 'journal-live', ref: 'r1' }, occurredAt: 900 })
  ledger.record({ category: 'subjective', text: '（心里）我的想法', source: { type: 'diary', ref: 'd1' }, meta: { dependsOn: [real.id] } })
  const claim = ledger.record({ category: 'claim', text: '模型猜的', source: { type: 'memory-model', ref: 'm1' }, certainty: 'model-inferred' })

  let n = 0
  const book = new YearbookStore({ io: createMemoryDocumentIo(), now: () => 1000, rng: () => `page-${++n}`, ledger }).load()
  assert.equal(book.add(claim.id).ok, false, '没有来源的模型猜测不能进年鉴')
  const added = book.add(real.id)
  assert.equal(added.ok, true)
  assert.equal(added.page.subjective.length, 1)
  ledger.forget(real.id)
  assert.equal(book.list().pages.length, 0, '来源被忘，年鉴不能再显示那一页')
  assert.equal(ledger.get(real.id).text, '', '遗忘后正文必须留不下来')
})
