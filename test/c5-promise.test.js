// test/c5-promise.test.js
// C5-PROMISE-01..04（EVAL §3.10 / CONTRACTS §11.4）：承诺簿与遗忘的边界。
//
// 作者裁决的四条硬要求：
//   01 有来源 ID 的关联提醒 → 忘记其经历后**保留**提醒并提示可一并取消；
//      提醒只在交付/管理界面可读，不进人格回忆或关系锚点；用户取消后正文与派生清除。
//   02 已完成工具承诺关联被遗忘经历 → 本地只留 ID/类型/状态/时间/证据类别，可删除，不重放。
//   03 同时有无关提醒/承诺 → 不误删（不能一忘全忘）。
//   04 旧承诺无来源 ID → 标"关联未知"，**不**凭模糊文本自动取消。
//
// [mock-io]：真实文件系统 + 真实承诺簿 + 真实账本/RAG，只 mock electron 的 userData。
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const userData = mkdtempSync(join(process.cwd(), '.nagi-c5-promise-'))
mock.module('electron', { exports: {
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
} })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  rag: { enabled: true, provider: 'none' },
  presence: { enabled: false, notesEnabled: false, tracesEnabled: false, anchorsEnabled: true }
}))

const { getRag } = await import('../src/main/rag/index.js')
const { getLedger } = await import('../src/main/ledger.js')
const { addMemory, loadMemories, saveRelationStats } = await import('../src/main/persist.js')
const { forgetExperience } = await import('../src/main/ledger-actions.js')
const { getPromiseBook, cancelLinkedPromise, removePromise } = await import('../src/main/promises.js')
const { listAnchorCandidates } = await import('../src/main/presence-notes.js')
const { selectForContext, minimalEvidence } = await import('../src/core/promises/book.js')
const { isLevelAtLeast, PRIVATE_ANCHOR_MIN_LEVEL } = await import('../src/core/presence/anchors.js')

after(() => {
  try { getRag().dispose() } catch {}
  rmSync(userData, { recursive: true, force: true })
})

const SECRET = '我不喜欢香菜，别给我点'
const UNRELATED_TEXT = '他周日要去爬山'

/** 造一条经历（进 memory + 账本），返回账本条目 */
function seedExperience(text) {
  getRag().init()
  const ledger = getLedger()
  loadMemories()
  addMemory(text)
  const entry = ledger.list().reverse().find((e) => e.source.type === 'memory-manual' &&
    String(e.text || '').includes(text))
  assert.ok(entry, '账本应有这条经历')
  return entry
}

const persistCheck = () => JSON.parse(readFileSync(join(userData, 'promises.json'), 'utf8'))

test('C5-PROMISE-01a：遗忘关联经历后，用户单独设的提醒**保留**且被提示可一并取消', () => {
  const entry = seedExperience(SECRET)
  const book = getPromiseBook()
  const promise = book.create({ id: 'reminder:keep', kind: 'reminder', title: SECRET,
    source: { type: 'reminder', id: 'keep' }, sourceIds: [entry.id], dueAt: Date.now() + 60000 })

  const r = forgetExperience(entry.id)
  assert.equal(r.ok, true, r.error)

  // 红线一：不得静默取消
  const after = book.get(promise.id)
  assert.equal(after.status, 'scheduled', '提醒本身必须原样保留')
  assert.equal(after.title, SECRET, '不得改写提醒正文')
  // 提示可一并取消
  assert.equal(r.promises.kept.length, 1, '要在结果里明确提示可一并取消')
  assert.equal(r.promises.kept[0].id, promise.id)
  assert.match(r.note, /可在提醒里一并取消/, '给用户的话要说清楚还留着提醒')
  // 标记脱钩
  assert.equal(after.linkStatus, 'detached')
  assert.ok(after.detachedAt > 0)
})

test('C5-PROMISE-01b：未取消的提醒不进人格回忆/关系锚点/模型上下文', () => {
  // 承诺锚点属"私密锚点"，要够熟才出现；先把熟悉度推到 familiar 以上，
  // 否则整类锚点都被关系门槛挡掉，下面两条断言就都成了假绿。
  const now = Date.now()
  const activeDays = []
  for (let i = 0; i < 20; i++) activeDays.push(new Date(now - i * 86400000).toISOString().slice(0, 10))
  saveRelationStats({ firstMetAt: now - 40 * 86400000, interactionCount: 200, activeDays, lastActiveDay: activeDays[0] })

  // 口径自检：先放一条**正常**的承诺，确认承诺锚点这条通路本来是通的。
  getPromiseBook().create({ id: 'reminder:control', kind: 'reminder', title: '控制组提醒文本',
    source: { type: 'reminder', id: 'control' }, sourceIds: [], dueAt: Date.now() + 1000 })

  const result = listAnchorCandidates(now)
  assert.ok(isLevelAtLeast(result.level, PRIVATE_ANCHOR_MIN_LEVEL),
    `自检：熟悉度要到 ${PRIVATE_ANCHOR_MIN_LEVEL} 以上，承诺锚点才会进入候选（当前 ${result.level}）`)
  const anchors = result.anchors
  assert.ok(anchors.find((a) => a.id === 'anchor:promise:reminder:control'),
    '自检：正常承诺本来会被制成承诺锚点')
  assert.equal(anchors.find((a) => a.id === 'anchor:promise:reminder:keep'), undefined,
    '已脱钩的提醒（经历已忘但用户保留）不得成为承诺锚点')

  // 纯函数层：引用前按来源 ID 重验
  const forgotten = new Set(getLedger().list({ includeDeleted: true })
    .filter((e) => e.deletedAt).map((e) => e.id))
  assert.ok(forgotten.size > 0, '自检：账本里要有已遗忘条目')
  const kept = getPromiseBook().get('reminder:keep')
  assert.equal(selectForContext([kept], { forgottenIds: [] }).length, 0,
    '自身已脱钩即排除，与遗忘集合无关')
  assert.equal(selectForContext([{ id: 'x', title: '某条承诺', sourceIds: [...forgotten] }],
    { forgottenIds: forgotten }).length, 0, 'sourceIds 精确命中已遗忘来源 → 排除')
  assert.equal(selectForContext([{ id: 'y', title: '某条承诺', sourceIds: ['still-alive'] }],
    { forgottenIds: forgotten }).length, 1, '未命中的照常保留')
})

test('C5-PROMISE-01c：用户选择一并取消后，正文与派生内容都清掉，且承诺簿不再留正文', () => {
  const book = getPromiseBook()
  let cancelledReminderId = null
  const r = cancelLinkedPromise('reminder:keep',
    { cancelReminder: (p) => { cancelledReminderId = p.id } })
  assert.equal(r.ok, true, r.error)
  assert.equal(cancelledReminderId, 'keep', '要级联取消提醒本体')

  const after = book.get('reminder:keep')
  assert.equal(after.status, 'cancelled')
  assert.equal(after.title, '', '正文必须清除（只留最小履约记录）')
  assert.equal(persistCheck().entries.some((e) => String(e.title || '').includes('香菜')), false,
    'promises.json 里也不能再出现正文')
  // 证据降级：只剩类别与时间
  assert.ok(after.evidence.length >= 1)
  for (const ev of after.evidence) {
    assert.equal(typeof ev.kind, 'string')
    assert.equal(Object.keys(ev).sort().join(','), 'at,kind', '证据不得带 detail/path/bytes')
  }
})

test('C5-PROMISE-02：已完成工具承诺关联被遗忘经历 → 只留最小履约记录，可删除且不重放', async () => {
  const entry = seedExperience(UNRELATED_TEXT)
  const { runRecordedTool } = await import('../src/main/promises.js')
  let runs = 0
  const res = await runRecordedTool(async () => { runs++; return { ok: true, summary: '文件已写入' } },
    'file_write', { path: 'note.txt', content: '一次性的秘密内容' }, { sourceIds: [entry.id] })
  assert.equal(res.ok, true)
  const promiseId = getPromiseBook().list().find((p) => (p.sourceIds || []).includes(entry.id) &&
    p.kind === 'agent-tool').id
  assert.equal(getPromiseBook().get(promiseId).status, 'completed')

  const before = getPromiseBook().get(promiseId)
  assert.notEqual(before.evidence.at(-1).path, undefined, '自检：原始证据里确实有可复原字段')

  const r = forgetExperience(entry.id)
  assert.equal(r.ok, true, r.error)
  assert.ok(r.promises.redacted.some((p) => p.id === promiseId), '这条等待 Forget 管线一并降级')

  const after = getPromiseBook().get(promiseId)
  assert.equal(after.status, 'completed', '状态本身不被改写（不误报完成，也不谎报取消）')
  assert.equal(after.title, '', '标题必须清除')
  assert.equal(after.source.type, 'agent-tool', '类型保留')
  assert.ok(after.createdAt > 0 && after.updatedAt > 0, '时间保留')
  for (const ev of after.evidence) {
    assert.equal(Object.keys(ev).sort().join(','), 'at,kind', '只留证据类别与时间')
  }
  assert.equal(persistCheck().entries.some((e) => String(e.title || '').includes('打开') ||
    String(JSON.stringify(e.source || {})).includes('秘密内容')), false,
    '不能留下可复原正文或工具参数')

  // 删除入口：只删本地记录，**不重放**外部操作
  const del = removePromise(promiseId)
  assert.equal(del.ok, true, del.error)
  assert.equal(getPromiseBook().get(promiseId), null)
  assert.equal(runs, 1, '删除不得重放外部操作')
})

test('C5-PROMISE-02b：仍在执行/待交付的承诺不许用删除入口绕过取消流程', () => {
  const book = getPromiseBook()
  book.create({ id: 'reminder:live', kind: 'reminder', title: '还在等的提醒',
    source: { type: 'reminder', id: 'live' }, dueAt: Date.now() + 1000 })
  const r = removePromise('reminder:live')
  assert.equal(r.ok, false)
  assert.match(r.error, /取消流程/)
  assert.ok(book.get('reminder:live'), '记录必须还在')
})

test('C5-PROMISE-03：无关提醒/承诺不被误删（不能一忘全忘）', () => {
  const entry = seedExperience('他有一辆蓝色的自行车')
  const book = getPromiseBook()
  book.create({ id: 'reminder:other', kind: 'reminder', title: UNRELATED_TEXT + '（无关）',
    source: { type: 'reminder', id: 'other' }, sourceIds: ['some-other-experience'], dueAt: Date.now() + 1000 })

  const before = book.get('reminder:other')
  const r = forgetExperience(entry.id)
  assert.equal(r.ok, true, r.error)
  const after = book.get('reminder:other')
  assert.equal(after.title, before.title, '无关提醒的正文不得被改动')
  assert.equal(after.status, before.status, '无关提醒的状态不得被改动')
  assert.equal(after.detachedAt, undefined, '无关提醒不得被脱钩')
  assert.equal(r.promises.kept.some((p) => p.id === 'reminder:other'), false, '不该被列进可取消清单')
})

test('C5-PROMISE-04：旧承诺无来源 ID → 标关联未知，不凭模糊文本自动取消', () => {
  const entry = seedExperience('他小时候养过一只叫豆豆的猫')
  const book = getPromiseBook()
  // 模拟旧数据：正文与目标经历高度相似，但没有 sourceIds
  const legacy = book.create({ id: 'reminder:legacy-promise', kind: 'reminder',
    title: '他小时候养过一只叫豆豆的猫（旧数据）', source: { type: 'reminder', id: 'legacy-promise' },
    dueAt: Date.now() + 1000 })
  assert.equal(legacy.linkStatus, 'unknown', '没有来源 ID 就该标关联未知')

  const before = book.get(legacy.id)
  const r = forgetExperience(entry.id)
  assert.equal(r.ok, true, r.error)
  const after = book.get(legacy.id)
  assert.equal(after.title, before.title, '不得猜测关联后静默删除')
  assert.equal(after.status, before.status)
  assert.equal(after.detachedAt, undefined)
  assert.equal(r.promises.unknownHint, true, '要提示用户自己去看一眼')
  assert.match(r.note, /无法确认是否关联/, '提示要落在给用户的 note 里')
})

test('C5-PROMISE-04b：证据降级是纯函数，写完/落到实处之前也不泄漏', () => {
  const degraded = minimalEvidence([
    { kind: 'file-write-result', at: 1, path: '/secret/x.txt', bytes: 12 },
    { kind: 'tool-returned', at: 2, tool: 'browser_open' },
    null,
    { at: 3 }
  ])
  assert.deepEqual(degraded, [{ kind: 'file-write-result', at: 1 }, { kind: 'tool-returned', at: 2 }])
})
