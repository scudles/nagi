// test/export-io.test.js
// C5 统一记忆/数据导出（P3-08）——**IO 层**：真实临时目录 + 真实写入链路。
//
// 覆盖 EVAL §3.14 里 mock-io 的三条：
//   C5-EXPORT-01 导出后**重读真实文件**：旧正文不出现、删除标记不含可复原内容；
//   C5-EXPORT-03 目标已存在 / 中途写失败：不静默覆盖、不报成功、失败状态可见、可重试；
//   C5-EXPORT-04 预览不写盘（策略层：没有 preview 之外的自动导出入口）。
//
// 与纯函数层（export-build.test.js）的分工：那里锁「内容长什么样」，这里锁
// 「真实落盘链路」——partial+link 原子占位、失败清理、诚实返回。
// 真机由绿区用 scripts/verify-p3-08-export.mjs 复跑（真实 Electron + 系统对话框路径）。

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.now()
const SECRET = '蓝区验收隐私原文：周五要替她交报告'
const userData = mkdtempSync(join(tmpdir(), 'nagi-export-io-'))
const exportDir = mkdtempSync(join(tmpdir(), 'nagi-export-out-'))

/* ---------------- 种子 profile：四类信任层 + 一条已删 ---------------- */

mkdirSync(join(userData, 'ledger'), { recursive: true })
mkdirSync(join(userData, 'journal'), { recursive: true })
mkdirSync(join(userData, 'monologue'), { recursive: true })
mkdirSync(join(userData, 'yearbook'), { recursive: true })

// 账本：一条 live claim（用户确认）+ 一条 live experience（年鉴页来源）+ 一条已删（遗忘后 deletedAt 非空）
writeFileSync(join(userData, 'ledger', 'entries.jsonl'), [
  { id: 'e_live', category: 'claim', text: '他喜欢的颜色是蓝色',
    source: { type: 'memory-manual', ref: 'm1' }, occurredAt: NOW - 5000, recordedAt: NOW - 4900,
    certainty: 'user-stated', ragIds: [], meta: {}, revision: 1, correctedAt: null, deletedAt: null },
  { id: 'e_yb', category: 'experience', text: '一起改过一次 Bug',
    source: { type: 'journal-live', ref: 'jr-9' }, occurredAt: NOW - 6000, recordedAt: NOW - 5900,
    certainty: 'observed', ragIds: [], meta: { eventKind: 'chat' }, revision: 1, correctedAt: null, deletedAt: null },
  { id: 'e_dead', category: 'experience', text: SECRET,
    source: { type: 'journal-live', ref: 'jr-1' }, occurredAt: NOW - 4000, recordedAt: NOW - 3900,
    certainty: 'observed', ragIds: [], meta: { eventKind: 'chat' }, revision: 1,
    correctedAt: null, deletedAt: NOW - 1000 }
].map((r) => JSON.stringify(r)).join('\n') + '\n')

writeFileSync(join(userData, 'memory.json'), JSON.stringify({
  version: 1, entries: [
    { id: 'm1', text: '他喜欢的颜色是蓝色', at: NOW - 5000, provenance: 'user-stated' },
    { id: 'm2', text: '模型猜他住在杭州', at: NOW - 5000, provenance: 'model-extracted' }
  ]
}, null, 2))

// 流水：一条与已删账本同坐标（occurredAt+eventKind，遗忘链正是按这个删条的）→ 必须只留标记
writeFileSync(join(userData, 'journal', '2026-10-19.json'), JSON.stringify({
  version: 1, date: '2026-10-19', entries: [
    { t: NOW - 4000, kind: 'chat', user: `他：${SECRET}`, reply: '我：记住了' },
    { t: NOW - 3000, kind: 'poke', text: '用户戳了凪' }
  ]
}, null, 2))

// 日记：一行**精确包含**已删正文（模拟 removeDiaryEntry 没删干净的残局）→ 必须只留标记
writeFileSync(join(userData, 'monologue', 'diary-2026-10-19.md'),
  `- 12:00 ［calm·40%］ ${SECRET}\n- 12:30 ［smile·60%］ 今天他来过。\n`)

// 年鉴一页（来源必须是 live 的 experience 条目——canUse 的契约）
writeFileSync(join(userData, 'yearbook', 'pages.json'), JSON.stringify({
  version: 1, pages: [
    { id: 'y1', sourceId: 'e_yb', title: '一次调试', note: '他写给我的话', createdAt: NOW - 4000, updatedAt: NOW - 4000 }
  ]
}, null, 2))

// 便签：一条模拟活动（标模拟）+ 一条复述已删正文（模拟 pruneNotesReferencing 漏删）→ 标记
writeFileSync(join(userData, 'notes.json'), JSON.stringify({
  version: 1, savedAt: NOW,
  notes: [
    { id: 'n_sim', at: NOW - 2000, noteKind: 'activity', text: '读了会儿东西', provenance: 'simulation' },
    { id: 'n_dead', at: NOW - 2000, noteKind: 'action', text: `便签复述 ${SECRET}`, provenance: 'observed' }
  ],
  // 痕迹的摘要在 result.summary 里（normalizeActionTrace 的形状）
  traces: [{ id: 't1', at: NOW - 2000, tool: 'shell', status: 'ok', result: { summary: `跑了 ${SECRET}` } }],
  noteState: { dayKey: '2026-10-19', count: 2, lastAt: NOW - 2000, seen: ['n_sim', 'n_dead'] },
  anchorState: { dayKey: '2026-10-19', count: 0, lastAt: 0, lastAnchorId: null }
}, null, 2))

// 承诺簿：一条脱钩（来源已忘、用户保留）+ 一条旧数据无来源（unknown）
writeFileSync(join(userData, 'promises.json'), JSON.stringify({
  version: 1, entries: [
    { id: 'p1', kind: 'reminder', title: '周五交报告', source: { type: 'reminder', id: 'r1' },
      sourceIds: ['e_dead'], dueAt: NOW + 3600000, status: 'scheduled',
      createdAt: NOW - 5000, updatedAt: NOW - 1000, detachedAt: NOW - 900, evidence: [] },
    { id: 'p2', kind: 'reminder', title: '老早的一条', source: { type: 'legacy-reminder', id: 'old' },
      sourceIds: [], dueAt: NOW + 7200000, status: 'scheduled',
      createdAt: NOW - 6000, updatedAt: NOW - 6000, evidence: [] }
  ]
}, null, 2))

writeFileSync(join(userData, 'history.json'), JSON.stringify({
  version: 1, lastAt: NOW, messages: [
    { role: 'user', content: '帮我记一下' }, { role: 'assistant', content: '好' }
  ]
}, null, 2))

// 便签开关要开着，否则 listNotes 返回空（默认关闭是契约）
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  version: 1, mode: 'pet',
  presence: { notesEnabled: true, tracesEnabled: true, anchorsEnabled: true }
}, null, 2))

/* ---------------- 失败注入：只让导出的 .partial 写失败 / link 撞已存在 ---------------- */

let failPartialWrite = false
let failLink = false
mock.module('node:fs', {
  exports: {
    readFileSync: realFs.readFileSync,
    writeFileSync: (p, ...rest) => {
      if (failPartialWrite && String(p).endsWith('.partial')) {
        throw Object.assign(new Error("EACCES: permission denied, open '*.partial'"), { code: 'EACCES' })
      }
      return realFs.writeFileSync(p, ...rest)
    },
    existsSync: realFs.existsSync,
    mkdirSync: realFs.mkdirSync,
    renameSync: realFs.renameSync,
    unlinkSync: realFs.unlinkSync,
    readdirSync: realFs.readdirSync,
    statSync: realFs.statSync,
    appendFileSync: realFs.appendFileSync,
    rmSync: realFs.rmSync,
    realpathSync: realFs.realpathSync,
    // 依赖链里 openai 包的 shim 会 `import { ReadStream } from 'node:fs'`；
    // mock 的 exports 不含这个名字就会 SyntaxError。按需补齐（真实透传）。
    ReadStream: realFs.ReadStream,
    WriteStream: realFs.WriteStream,
    // notes-file.js 会 `import { promises as fs } from 'node:fs'`
    promises: realFs.promises,
    linkSync: (a, b) => {
      if (failLink) throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      return realFs.linkSync(a, b)
    }
  }
})

mock.module('electron', {
  exports: {
    app: { getPath: () => userData, getVersion: () => '0.0.0', getName: () => 'Nagi', isPackaged: false },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false }
  }
})

// mock 注册之后才能动态 import 业务模块（与 g3-settings-persist.test.js 同一时序）
const { collectExportSources, buildExport, writeExportTo, previewExport, defaultExportName } =
  await import('../src/main/export.js')
const { parseExport } = await import('../src/core/export/build.js')

const target = join(exportDir, defaultExportName(NOW))

test.after(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(exportDir, { recursive: true, force: true })
})

/* ---------------- IO-1：C5-EXPORT-01 导出并重读真实文件 ---------------- */

test('IO-1 C5-EXPORT-01：真实落盘后重读，旧正文不出现、删除标记可审计', () => {
  const result = writeExportTo(target, NOW)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.path, target)
  assert.equal(result.counts.ledger, 3)
  assert.equal(result.counts.ledgerDeleted, 1)

  // 重读**真实文件**
  const text = readFileSync(target, 'utf8')
  assert.ok(!text.includes(SECRET), '已删正文不得出现在导出文件的任何位置（含流水/日记/便签/痕迹）')
  const reread = parseExport(text)
  assert.equal(reread.schemaVersion, 1)

  // 删除标记：账本 / 流水 / 日记 / 便签 / 痕迹 五处都在，且都无正文
  assert.equal(reread.sections.ledger.items.find((i) => i.id === 'e_dead').status, 'deleted')
  assert.equal(reread.sections.ledger.items.find((i) => i.id === 'e_dead').deletedAt, NOW - 1000)
  assert.equal(reread.sections.journal.days[0].items[0].status, 'deleted')
  assert.equal(reread.sections.diary.files[0].items[0].status, 'deleted')
  assert.equal(reread.sections.notes.items.find((i) => i.id === 'n_dead').status, 'deleted')
  assert.equal(reread.sections.notes.traces[0].status, 'deleted')

  // live 数据齐全且信任层逐条正确（四类齐活）
  const byId = {}
  for (const i of [...reread.sections.ledger.items, ...reread.sections.memory.items, ...reread.sections.notes.items]) byId[i.id] = i
  assert.equal(byId.e_live.trustLayer, 'user-confirmed')
  assert.equal(byId.m2.trustLayer, 'unverified')
  assert.equal(byId.n_sim.trustLayer, 'simulated')
  assert.equal(reread.sections.diary.files[0].items[1].trustLayer, 'subjective')
  assert.equal(reread.sections.yearbook.pages[0].fact.trustLayer, 'observed')
  assert.equal(reread.sections.history.messages[0].trustLayer, 'user-confirmed')

  // 承诺：脱钩保留标题 + unknown 不猜关联
  assert.equal(reread.sections.promises.items[0].linkStatus, 'detached')
  assert.equal(reread.sections.promises.items[0].title, '周五交报告')
  assert.equal(reread.sections.promises.items[1].linkStatus, 'unknown')

  // 没有 .partial 残留
  assert.deepEqual(readdirSync(exportDir).filter((f) => f.includes('.partial')), [])
})

/* ---------------- IO-2：C5-EXPORT-03 目标已存在 → 不覆盖 ---------------- */

test('IO-2 C5-EXPORT-03：目标已存在时失败且原文件一字节不动', () => {
  const original = '用户自己的旧导出，动一根字节都不行\n'
  writeFileSync(target, original, 'utf8')
  const result = writeExportTo(target, NOW)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'exists')
  assert.ok(result.error.includes('已存在'))
  assert.equal(readFileSync(target, 'utf8'), original, '不得静默覆盖用户已有文件')
  assert.deepEqual(readdirSync(exportDir).filter((f) => f.includes('.partial')), [])
})

/* ---------------- IO-3：C5-EXPORT-03 中途写失败 → 不伪成功、可重试 ---------------- */

test('IO-3 C5-EXPORT-03：写 .partial 中途失败 → 如实报失败、无残局、重试可成', () => {
  rmSync(target, { force: true })
  failPartialWrite = true
  let result
  try {
    result = writeExportTo(target, NOW)
  } finally {
    failPartialWrite = false
  }
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write-failed')
  assert.equal(existsSync(target), false, '失败不得留下看起来完整的 .json')
  assert.deepEqual(readdirSync(exportDir).filter((f) => f.includes('.partial')), [], '失败要清理残局')

  // 可重试：条件恢复后同一条链路成功
  const retry = writeExportTo(target, NOW)
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(readFileSync(target, 'utf8').includes(SECRET), false)
})

/* ---------------- IO-4：link 撞已存在（两步之间出现目标）→ 用户文件不碰 ---------------- */

test('IO-4 C5-EXPORT-03：linkSync 竞态失败同样按已存在处理', () => {
  rmSync(target, { force: true })
  failLink = true
  let result
  try {
    result = writeExportTo(target, NOW)
  } finally {
    failLink = false
  }
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'exists')
  assert.equal(existsSync(target), false, '用户文件没被创建，更没被碰')
  assert.deepEqual(readdirSync(exportDir).filter((f) => f.includes('.partial')), [], 'partial 要清掉')
})

/* ---------------- IO-5：C5-EXPORT-04 预览不写盘 ---------------- */

test('IO-5 C5-EXPORT-04：预览只取数，不写任何外部文件', () => {
  const before = readdirSync(exportDir).sort()
  const preview = previewExport(NOW)
  assert.equal(preview.ok, true)
  assert.equal(preview.bundle.schemaVersion, 1)
  assert.ok(preview.bundle.counts.ledger >= 2)
  // 导出目录一个文件都没多；profile 目录也没有新文件（便签/设置都不该被碰）
  assert.deepEqual(readdirSync(exportDir).sort(), before, '预览不得写外部文件')
})

/* ---------------- IO-6：取数失败 → 诚实失败（放最后：会临时改种子） ---------------- */

test('IO-6 取数失败如实报 collect-failed，不伪成功', () => {
  const journalFile = join(userData, 'journal', '2026-10-19.json')
  const good = readFileSync(journalFile, 'utf8')
  writeFileSync(journalFile, '{ 坏掉的 json', 'utf8')
  let result
  try {
    result = writeExportTo(join(exportDir, 'x.json'), NOW)
  } finally {
    writeFileSync(journalFile, good, 'utf8')
  }
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'collect-failed')
  assert.ok(result.error.includes('导出内容读取失败'))
  assert.equal(existsSync(join(exportDir, 'x.json')), false)
})

/* ---------------- IO-7：collectExportSources 复用数据地图（不建平行库） ---------------- */

test('IO-7 取数覆盖数据地图全部章节', () => {
  const sources = collectExportSources()
  assert.equal(sources.ledger.length, 3, '账本含已删（删除标记的来源）')
  assert.equal(sources.memory.length, 2)
  assert.equal(sources.journal.length, 1)
  assert.equal(sources.diary.length, 1)
  assert.equal(sources.notes.notes.length, 2)
  assert.equal(sources.promises.length, 2)
  assert.equal(sources.history.length, 2)
  assert.ok(Array.isArray(sources.yearbook.pages))
  assert.equal(sources.yearbook.pages.length, 1)
})
