// test/export-build.test.js
// C5 统一记忆/数据导出（P3-08，CONTRACTS §15 / EVAL §3.14）——**纯函数层**。
//
// 这一组锁的是契约的四条硬要求：
//   C5-EXPORT-01 已删内容只留删除标记，且**不能从流水/日记/年鉴/便签重新带出正文**；
//   C5-EXPORT-02 信任层逐条正确（用户确认/有来源观测/主观/模拟/未核实），不把模拟说成共同经历；
//   （C5-EXPORT-03 不覆盖/不伪成功在 IO 层，C5-EXPORT-04 不自动导出是策略层，见另两个文件）
//
// 全部用假数据桩，不碰 fs、不依赖真模型。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPORT_SCHEMA_VERSION,
  TRUST_LAYERS,
  ITEM_STATUS,
  EXPORT_NOTICE,
  ledgerTrustLayer,
  memoryTrustLayer,
  exportLedgerItem,
  exportMemoryItem,
  exportJournalDay,
  exportDiaryFile,
  exportNoteItem,
  exportTraceItem,
  exportAnchorItem,
  exportPromiseItem,
  exportYearbookPage,
  exportYearbookFragment,
  exportHistoryItem,
  deadJournalEvents,
  buildExportBundle,
  serializeExport,
  parseExport
} from '../src/core/export/build.js'

const T0 = Date.UTC(2026, 9, 19, 4, 0, 0) // 2026-10-19 12:00 本地
const SECRET = '蓝区验收隐私原文：周五要替她交报告'

const liveEntry = (over = {}) => ({
  id: 'e_live1', category: 'experience', text: SECRET,
  source: { type: 'journal-live', ref: 'ref-1' }, occurredAt: T0 - 1000, recordedAt: T0 - 900,
  certainty: 'observed', ragIds: [], meta: {}, revision: 1, correctedAt: null, deletedAt: null, ...over
})
const deletedEntry = (over = {}) => liveEntry({
  id: 'e_dead1', text: SECRET, deletedAt: T0, ...over
})

/* ================= A 层：单条目映射 ================= */

test('A1 信任层映射：五层各就各位', () => {
  assert.equal(ledgerTrustLayer({ category: 'experience', certainty: 'user-stated' }), TRUST_LAYERS.USER_CONFIRMED)
  assert.equal(ledgerTrustLayer({ category: 'experience', certainty: 'user-corrected' }), TRUST_LAYERS.USER_CONFIRMED)
  assert.equal(ledgerTrustLayer({ category: 'experience', certainty: 'observed' }), TRUST_LAYERS.OBSERVED)
  assert.equal(ledgerTrustLayer({ category: 'subjective', certainty: 'subjective' }), TRUST_LAYERS.SUBJECTIVE)
  // claim 但既非用户陈述也非用户更正 → 未核实（未经核实的模型摘录）
  assert.equal(ledgerTrustLayer({ category: 'claim', certainty: 'inferred' }), TRUST_LAYERS.UNVERIFIED)
  assert.equal(memoryTrustLayer({ provenance: 'user-stated' }), TRUST_LAYERS.USER_CONFIRMED)
  assert.equal(memoryTrustLayer({ provenance: 'model-extracted' }), TRUST_LAYERS.UNVERIFIED)
})

test('A2 已删账本条目只输出删除标记，无正文', () => {
  const item = exportLedgerItem(deletedEntry())
  assert.equal(item.status, ITEM_STATUS.DELETED)
  assert.equal(item.id, 'e_dead1')
  assert.equal(item.deletedAt, T0)
  // 关键：整个 JSON 里不允许出现正文的任何片段
  const json = JSON.stringify(item)
  assert.ok(!json.includes(SECRET), '删除标记不得含可复原正文')
  assert.ok(!json.includes('text'), '删除标记不应带 text 字段')
})

test('A3 更正条目保留原文与更正时间（更正≠删除，供审计）', () => {
  const item = exportLedgerItem(liveEntry({ correctedAt: T0 + 5 }))
  assert.equal(item.status, ITEM_STATUS.CORRECTED)
  assert.equal(item.correctedAt, T0 + 5)
  assert.equal(item.text, SECRET)
})

test('A4 live 条目逐条带来源 ID/类型/信任层/时间', () => {
  const item = exportLedgerItem(liveEntry())
  assert.equal(item.trustLayer, TRUST_LAYERS.OBSERVED)
  assert.equal(item.source.type, 'journal-live')
  assert.equal(item.source.ref, 'ref-1')
  assert.equal(item.occurredAt, T0 - 1000)
  assert.equal(item.recordedAt, T0 - 900)
  assert.equal(item.text, SECRET)
})

test('A5 流水：按（occurredAt,eventKind）坐标命中已删条目时只留标记', () => {
  const dead = deadJournalEvents([deletedEntry({ meta: { eventKind: 'chat' } })])
  assert.deepEqual(dead, [{ occurredAt: T0 - 1000, eventKind: 'chat', ledgerId: 'e_dead1' }])
  const day = exportJournalDay('2026-10-19', [
    { t: T0 - 1000, kind: 'chat', user: `他：${SECRET}`, reply: '我：记住了' },
    { t: T0 - 800, kind: 'chat', user: '他：今天天气不错', reply: '我：是啊' },
    { t: T0 - 500, kind: 'poke', text: '用户戳了凪' }
  ], dead)
  assert.equal(day.items.length, 3)
  assert.equal(day.items[0].status, ITEM_STATUS.DELETED)
  assert.ok(!JSON.stringify(day.items[0]).includes('他：'))
  // live 的流水条目照实导出 user/reply
  assert.equal(day.items[1].status, ITEM_STATUS.LIVE)
  assert.equal(day.items[1].user, '他：今天天气不错')
  assert.equal(day.items[1].reply, '我：是啊')
  assert.equal(day.items[2].text, '用户戳了凪')
  assert.equal(day.items[1].trustLayer, TRUST_LAYERS.OBSERVED)
})

test('A6 日记/便签/痕迹/锚点：行内精确包含已删正文时只留标记', () => {
  const deadTexts = [SECRET]
  const diary = exportDiaryFile('diary-2026-10-19.md',
    `- 12:00 ［calm·40%］ ${SECRET}\n- 12:30 ［smile·60%］ 今天他来过。`, deadTexts)
  assert.equal(diary.items.length, 2)
  assert.equal(diary.items[0].status, ITEM_STATUS.DELETED)
  assert.equal(diary.items[1].status, ITEM_STATUS.LIVE)
  assert.equal(diary.items[1].trustLayer, TRUST_LAYERS.SUBJECTIVE)

  const note = exportNoteItem({ id: 'n1', at: T0, text: `便签提到 ${SECRET}`, provenance: 'observed' }, deadTexts)
  assert.equal(note.status, ITEM_STATUS.DELETED)
  const trace = exportTraceItem({ id: 't1', at: T0, tool: 'shell', status: 'ok', summary: `执行了 ${SECRET}` }, deadTexts)
  assert.equal(trace.status, ITEM_STATUS.DELETED)
  const anchor = exportAnchorItem({ id: 'a1', kind: 'promise', text: SECRET, sourceIds: [] }, deadTexts)
  assert.equal(anchor.status, ITEM_STATUS.DELETED)
})

test('A7 便签：模拟活动标「模拟」，不标成共同经历', () => {
  const sim = exportNoteItem({ id: 'n2', at: T0, text: '读了会儿东西', provenance: 'simulation', noteKind: 'activity' })
  assert.equal(sim.trustLayer, TRUST_LAYERS.SIMULATED)
  assert.equal(sim.status, ITEM_STATUS.LIVE)
  const sub = exportNoteItem({ id: 'n3', at: T0, text: '他想了一下事情', provenance: 'observed' })
  assert.equal(sub.trustLayer, TRUST_LAYERS.SUBJECTIVE)
})

test('A8 承诺：linkStatus 如实带出，脱钩保留标题，降级不带标题', () => {
  const linked = exportPromiseItem({ id: 'p1', kind: 'reminder', title: '周五交报告',
    source: { type: 'reminder', id: 'r1' }, sourceIds: ['e_live1'], dueAt: T0 + 1000,
    status: 'scheduled', createdAt: T0, updatedAt: T0, linkStatus: 'linked', evidence: [{ kind: 'notification-dispatched', at: T0, detail: 'x' }] })
  assert.equal(linked.linkStatus, 'linked')
  assert.equal(linked.title, '周五交报告')
  assert.equal(linked.trustLayer, TRUST_LAYERS.USER_CONFIRMED)
  // 证据只留 kind 与 at
  assert.deepEqual(linked.evidence, [{ kind: 'notification-dispatched', at: T0 }])

  const detached = exportPromiseItem({ id: 'p2', kind: 'reminder', title: '周五交报告',
    source: { type: 'reminder', id: 'r1' }, sourceIds: ['e_dead1'], status: 'scheduled',
    createdAt: T0, updatedAt: T0, linkStatus: 'detached', detachedAt: T0 + 10 })
  assert.equal(detached.detachedAt, T0 + 10)
  assert.equal(detached.title, '周五交报告', '用户选择保留的提醒，标题是用户自己的话，照实导出')

  const redacted = exportPromiseItem({ id: 'p3', kind: 'tool', title: '',
    source: { type: 'tool', id: 'x' }, sourceIds: [], status: 'completed',
    createdAt: T0, updatedAt: T0, linkStatus: 'unknown', redactedAt: T0 + 20 })
  assert.equal(redacted.title, null)
  assert.equal(redacted.redacted, true)

  // 旧数据没有来源 ID：标 unknown，不猜关联
  const legacy = exportPromiseItem({ id: 'p4', kind: 'reminder', title: '老早的一条',
    source: { type: 'legacy-reminder', id: 'old' }, sourceIds: [], status: 'scheduled',
    createdAt: T0, updatedAt: T0, linkStatus: 'unknown' })
  assert.equal(legacy.linkStatus, 'unknown')
  assert.equal(legacy.title, '老早的一条')
})

test('A9 年鉴：事实跟随账本信任层，用户编辑标创作，来源已删只留标记', () => {
  const page = exportYearbookPage({
    id: 'y1', sourceId: 'e_live1', title: '一次帮忙', note: '他写给我的话',
    createdAt: T0, updatedAt: T0,
    fact: { id: 'e_live1', text: SECRET, source: { type: 'journal-live', ref: 'r' },
      occurredAt: T0, recordedAt: T0, certainty: 'observed', tier: 'recorded' },
    subjective: [{ id: 's1', text: '她记下的感受', recordedAt: T0 }]
  })
  assert.equal(page.fact.trustLayer, TRUST_LAYERS.OBSERVED)
  assert.equal(page.fact.text, SECRET)
  assert.equal(page.subjective[0].trustLayer, TRUST_LAYERS.SUBJECTIVE)
  assert.equal(page.userNote.kind, 'user-creation')
  assert.equal(page.userNote.trustLayer, TRUST_LAYERS.SUBJECTIVE)

  // 第二道防线：来源已删（正常已被 pruneSource 删掉）→ 事实只留标记
  const dead = exportYearbookPage({
    id: 'y2', sourceId: 'e_dead1', title: '被忘的一天', note: '',
    fact: { id: 'e_dead1', text: SECRET }
  }, { deletedIds: new Set(['e_dead1']) })
  assert.equal(dead.fact.status, ITEM_STATUS.DELETED)
  assert.ok(!JSON.stringify(dead).includes(SECRET))

  const frag = exportYearbookFragment({ id: 'execute', title: '醒来', text: '她醒来时就在这台电脑里。', unlocked: true, triggerSourceId: 'e_live1' })
  assert.equal(frag.kind, 'creative-setting')
  assert.equal(frag.trustLayer, TRUST_LAYERS.SUBJECTIVE)
})

test('A10 历史：用户的话=用户确认，她的回复=有来源观测', () => {
  assert.equal(exportHistoryItem({ role: 'user', content: '你好' }).trustLayer, TRUST_LAYERS.USER_CONFIRMED)
  assert.equal(exportHistoryItem({ role: 'assistant', content: '我在' }).trustLayer, TRUST_LAYERS.OBSERVED)
  assert.equal(exportHistoryItem({ role: 'system', content: 'x' }), null)
  assert.equal(exportHistoryItem(null), null)
})

/* ================= B 层：总装（C5-EXPORT-01/02 端到端） ================= */

/** 一份「用户确认 + 有来源观测 + 主观 + 模拟 + 未核实」全齐的源数据 */
function mixedSources() {
  return {
    ledger: [
      liveEntry({ id: 'e_user', category: 'claim', text: '他喜欢的颜色是蓝色', certainty: 'user-stated',
        source: { type: 'memory-manual', ref: 'm1' } }),
      liveEntry({ id: 'e_sub', category: 'subjective', text: '［主观］他今天看起来累', certainty: 'subjective',
        source: { type: 'diary-live', ref: 'd1' } }),
      deletedEntry({ id: 'e_dead', meta: { eventKind: 'chat' } })
    ],
    memory: [
      { id: 'm1', text: '他喜欢的颜色是蓝色', at: T0, provenance: 'user-stated' },
      { id: 'm2', text: '模型猜他可能住在杭州', at: T0, provenance: 'model-extracted' }
    ],
    journal: [
      { date: '2026-10-19', entries: [
        { t: T0 - 1000, kind: 'chat', user: `他：${SECRET}`, reply: '我：记住了' },
        { t: T0 - 500, kind: 'poke', text: '用户戳了凪' }
      ] }
    ],
    diary: [
      { file: 'diary-2026-10-19.md', text: `- 12:00 ［calm·40%］ ${SECRET}\n- 12:30 ［smile·60%］ 今天他来过。` }
    ],
    yearbook: {
      pages: [{
        id: 'y1', sourceId: 'e_user', title: '一次更正', note: '他写的话',
        fact: { id: 'e_user', text: '他喜欢的颜色是蓝色', source: { type: 'memory-manual', ref: 'm1' },
          occurredAt: T0, recordedAt: T0, certainty: 'user-stated', tier: 'recorded' }
      }],
      fragments: [{ id: 'execute', title: '醒来', text: '创作设定正文', unlocked: true, triggerSourceId: 'e_user' }]
    },
    notes: {
      notes: [
        { id: 'n_sim', at: T0, text: '读了会儿东西', provenance: 'simulation', noteKind: 'activity' },
        { id: 'n_dead', at: T0, text: `便签复述 ${SECRET}`, provenance: 'observed' }
      ],
      traces: [{ id: 't1', at: T0, tool: 'shell', status: 'ok', summary: `跑了 ${SECRET}` }],
      anchors: [{ id: 'a1', kind: 'promise', text: SECRET, sourceIds: [] }]
    },
    promises: [
      { id: 'p1', kind: 'reminder', title: '周五交报告', source: { type: 'reminder', id: 'r1' },
        sourceIds: ['e_dead'], dueAt: T0 + 1000, status: 'scheduled', createdAt: T0, updatedAt: T0,
        linkStatus: 'detached', detachedAt: T0 + 5, evidence: [] }
    ],
    history: [
      { role: 'user', content: '帮我记一下' },
      { role: 'assistant', content: '好' }
    ]
  }
}

test('B1 C5-EXPORT-01：导出后重读，旧正文不出现、删除标记不含可复原内容', () => {
  const bundle = buildExportBundle(mixedSources(), T0)
  const text = serializeExport(bundle)
  const reread = parseExport(text)

  // ① 全文任何位置都不出现已删正文（含流水/日记/便签/痕迹/锚点这些派生层）
  assert.ok(!text.includes(SECRET), '已删正文不得出现在导出文件的任何位置')
  // ② 删除标记在，且只有 ID/deletedAt/status
  const dead = reread.sections.ledger.items.find((i) => i.id === 'e_dead')
  assert.equal(dead.status, ITEM_STATUS.DELETED)
  assert.equal(dead.deletedAt, T0)
  assert.equal(dead.text, undefined)
  // ③ 派生层同样只留标记
  assert.equal(reread.sections.journal.days[0].items[0].status, ITEM_STATUS.DELETED)
  assert.equal(reread.sections.diary.files[0].items[0].status, ITEM_STATUS.DELETED)
  assert.equal(reread.sections.notes.items.find((i) => i.id === 'n_dead').status, ITEM_STATUS.DELETED)
  assert.equal(reread.sections.notes.traces[0].status, ITEM_STATUS.DELETED)
  assert.equal(reread.sections.notes.anchors[0].status, ITEM_STATUS.DELETED)
  // ④ 计数如实
  assert.equal(reread.counts.ledgerDeleted, 1)
  assert.equal(reread.counts.journalDeleted, 1)
  assert.equal(reread.counts.diaryDeleted, 1)
  assert.equal(reread.counts.notesDeleted, 1)
})

test('B2 C5-EXPORT-02：四类信任层逐条正确，不把模拟说成共同经历', () => {
  const reread = parseExport(serializeExport(buildExportBundle(mixedSources(), T0)))
  const all = [
    ...reread.sections.ledger.items,
    ...reread.sections.memory.items,
    ...reread.sections.notes.items
  ]
  const byId = Object.fromEntries(all.map((i) => [i.id, i]))
  assert.equal(byId.e_user.trustLayer, TRUST_LAYERS.USER_CONFIRMED)   // 用户确认
  assert.equal(byId.e_sub.trustLayer, TRUST_LAYERS.SUBJECTIVE)        // 主观
  assert.equal(byId.n_sim.trustLayer, TRUST_LAYERS.SIMULATED)         // 模拟
  assert.equal(byId.m2.trustLayer, TRUST_LAYERS.UNVERIFIED)           // 未核实
  assert.equal(byId.e_user.text, '他喜欢的颜色是蓝色')
  // 用户编辑与创作设定都不等于事实
  const page = reread.sections.yearbook.pages[0]
  assert.equal(page.userNote.trustLayer, TRUST_LAYERS.SUBJECTIVE)
  assert.equal(reread.sections.yearbook.fragments[0].kind, 'creative-setting')
  // 文件级声明存在，但**不替代**逐条标注
  assert.ok(reread.trustLayers['user-confirmed'])
  assert.ok(reread.notice.includes('已遗忘'))
})

test('B3 序列化往返：schemaVersion 固定，坏文件如实抛错', () => {
  const text = serializeExport(buildExportBundle(mixedSources(), T0))
  assert.ok(text.endsWith('\n'))
  const reread = parseExport(text)
  assert.equal(reread.schemaVersion, EXPORT_SCHEMA_VERSION)
  assert.equal(reread.exportedAt, T0)
  assert.throws(() => parseExport('{"hello":1}'), /不是可识别的凪数据导出文件/)
  assert.throws(() => parseExport('not json'), SyntaxError)
})

test('B4 空数据也能导出（不崩、不谎报）', () => {
  const bundle = buildExportBundle({}, T0)
  assert.equal(bundle.counts.ledger, 0)
  assert.equal(bundle.sections.ledger.items.length, 0)
  const reread = parseExport(serializeExport(bundle))
  assert.equal(reread.counts.memory, 0)
})

test('B5 反向锁：去掉删除标记实现（冒充导出正文）必须能被发现', () => {
  // 这个测试本身是结构探针：确认删除标记的判据（status+无 text）是可断言的，
  // 防止将来有人把 deleted 条目当普通条目导出而测试全绿。
  const bad = { id: 'e_dead', status: ITEM_STATUS.LIVE, text: SECRET }
  assert.equal(bad.status, ITEM_STATUS.LIVE)
  assert.ok(JSON.stringify(bad).includes(SECRET))
  // 而正确实现下同一输入导出不含正文（与 B1 同一判据，互为镜像）
  const good = parseExport(serializeExport(buildExportBundle(mixedSources(), T0)))
  assert.ok(!serializeExport(good).includes(SECRET))
})
