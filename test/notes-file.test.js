// test/notes-file.test.js
// B23 外部便签写入：**安全边界回归锁**。
//
// 这一组测试存在的唯一理由：系统级写操作一旦越权就是真事故。
// 所有越权形态（穿越、绝对路径、盘符、软链逃逸）必须被挡住，少一条都不行。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTE_FILE_LIMITS,
  isWithinRoot,
  safeFileName,
  noteFileName,
  noteFileContent,
  resolveNoteTarget,
  decideNoteWrite,
  emptyNoteFileState,
  normalizeNoteFileState,
  resetNoteFileState,
  commitNoteWrite
} from '../src/core/presence/notes-file.js'

const ROOT = 'C:/Users/me/凪的角落'
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0) // 本地 2026-10-17 20:00
const note = (over = {}) => ({ id: 'evt-1', noteKind: 'activity', at: T0, text: '你不在的时候，我读了会儿东西。', provenance: 'simulation', ...over })
const cfgOn = { externalNotesEnabled: true }
/** 默认：目录真实路径就等于它自己（没有软链） */
const flatRealpath = (p) => p

/* ---------------- 1. 开关与授权 ---------------- */

test('默认关闭 / 未授权：一律拒绝，绝不返回"写成功了"', () => {
  const s = emptyNoteFileState(T0)
  assert.equal(decideNoteWrite({ note: note(), now: T0, state: s, config: {} }).reason, 'disabled')
  assert.equal(decideNoteWrite({ note: note(), now: T0, state: s, config: { externalNotesEnabled: false } }).reason, 'disabled')
  // 开了开关但没有授权目录 = 未授权
  assert.equal(decideNoteWrite({ note: note(), now: T0, state: s, config: cfgOn, root: '' }).reason, 'no-root')
  assert.equal(decideNoteWrite({ note: note(), now: T0, state: s, config: cfgOn }).reason, 'no-root')
  assert.equal(decideNoteWrite({ note: note(), now: T0, state: s, config: cfgOn, root: null }).reason, 'no-root')
  // 没有便签
  assert.equal(decideNoteWrite({ now: T0, state: s, config: cfgOn, root: ROOT }).reason, 'no-note')
  assert.equal(decideNoteWrite({ note: { text: 'x' }, now: T0, state: s, config: cfgOn, root: ROOT }).reason, 'no-note')
})

/* ---------------- 2. 路径归属（硬校验） ---------------- */

test('越权一：`..` 穿越一律拒绝，不"解析掉"', () => {
  for (const dir of ['../别处', 'a/../../b', '..', '.', './../../outside']) {
    const r = resolveNoteTarget({ root: ROOT, dir, fileName: 'x.txt' })
    // '.' 与 './..' 之外的都必须是穿越拒绝；'.' 是合法空目录
    if (dir === '.') continue
    assert.equal(r.ok, false, `应拒绝：${dir}`)
    assert.equal(r.reason, 'path-traversal', `拒绝理由：${dir} -> ${r.reason}`)
  }
})

test('越权二：子目录里夹绝对路径 / 盘符 / UNC', () => {
  for (const dir of ['C:/Windows', '//server/share', 'a/C:/b', '/etc']) {
    const r = resolveNoteTarget({ root: ROOT, dir, fileName: 'x.txt' })
    assert.equal(r.ok, false, `应拒绝：${dir}`)
    assert.equal(r.reason, 'path-traversal', `${dir} -> ${r.reason}`)
  }
})

test('越权三：根目录本身不合法（相对路径 / 自带 ..）', () => {
  for (const root of ['relative/dir', '', 'C:/a/../b', null, undefined]) {
    const r = resolveNoteTarget({ root, fileName: 'x.txt' })
    assert.equal(r.ok, false, `应拒绝根：${root}`)
    assert.ok(['no-root', 'bad-root'].includes(r.reason), `${root} -> ${r.reason}`)
  }
})

test('越权四：符号链接逃逸（拼出来看着在根内，realpath 戳穿）', () => {
  // 根下有个子目录是软链，指向外面
  const escape = (p) => (p.includes('软链') ? 'D:/别处/软链' : p)
  const r = resolveNoteTarget({ root: ROOT, dir: '软链', fileName: 'x.txt', realpathOf: escape })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'symlink-escape')
  // realpath 验不了（抛错 / 返回空）也不能放行
  assert.equal(resolveNoteTarget({ root: ROOT, fileName: 'x.txt', realpathOf: () => { throw new Error('ENOENT') } }).reason, 'symlink-unverifiable')
  assert.equal(resolveNoteTarget({ root: ROOT, fileName: 'x.txt', realpathOf: () => '' }).reason, 'symlink-unverifiable')
})

test('合法路径：根目录内允许，子目录允许，盘符大小写不敏感', () => {
  const r = resolveNoteTarget({ root: ROOT, fileName: 'x.txt', realpathOf: flatRealpath })
  assert.equal(r.ok, true)
  assert.equal(r.absPath, `${ROOT}/x.txt`)
  assert.equal(r.fileName, 'x.txt')
  const sub = resolveNoteTarget({ root: ROOT, dir: '子目录/再一层', fileName: 'x.txt', realpathOf: flatRealpath })
  assert.equal(sub.ok, true)
  assert.equal(sub.absPath, `${ROOT}/子目录/再一层/x.txt`)
  // 归属判定大小写不敏感（Windows 语义）
  assert.equal(isWithinRoot('C:/Nagi', 'c:/nagi/a.txt'), true)
  assert.equal(isWithinRoot('C:/Nagi', 'C:/Nagi2/a.txt'), false, '前缀相同但不是子目录必须判否')
  assert.equal(isWithinRoot(ROOT, 'D:/other/x.txt'), false)
})

/* ---------------- 3. 文件名与正文 ---------------- */

test('文件名清洗：非法字符、扩展名、超长、空名', () => {
  assert.equal(safeFileName('a.exe'), 'a.txt', '扩展名由我们说了算')
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij.txt')
  assert.equal(safeFileName('...'), '', '全是点 -> 空 -> 拒绝')
  assert.equal(safeFileName(''), '')
  assert.equal(safeFileName(null), '')
  assert.equal(safeFileName('x'.repeat(200)).length, NOTE_FILE_LIMITS.stemMax + 4)
  assert.ok(safeFileName('正常名字').endsWith('.txt'))
  // 空名必须导致拒绝，不能落成 ".txt"
  assert.equal(resolveNoteTarget({ root: ROOT, fileName: '///' }).reason, 'bad-name')
})

test('便签文件名带日期前缀与类型，正文如实标注来源', () => {
  const n = note()
  const name = noteFileName(n, T0)
  assert.match(name, /^2026-10-17-独处.*\.txt$/)
  const body = noteFileContent(n)
  assert.ok(body.includes('读了会儿东西'))
  assert.ok(body.includes('不是你离开期间外界发生的事'), '模拟活动必须照旧标注，不许写成外界经历')
  // 可信但未核实的行动：如实说
  const act = note({ noteKind: 'action', provenance: 'observed', completionVerified: false, text: '跑过 tool' })
  assert.ok(noteFileContent(act).includes('外部效果她没有核实'))
  // 时间不明不猜
  assert.ok(noteFileContent({ noteKind: 'activity', text: 'x', provenance: 'observed' }).includes('时间不明'))
})

/* ---------------- 4. 幂等、配额、间隔 ---------------- */

const write = (n, now, state) => decideNoteWrite({ note: n, now, state, config: cfgOn, root: ROOT, realpathOf: flatRealpath })

test('幂等：同一张便签只写一次（记账在写入成功后）', () => {
  let state = emptyNoteFileState(T0)
  const first = write(note(), T0, state)
  assert.equal(first.reason, 'ok')
  assert.ok(first.write.absPath.endsWith('.txt'))
  // 决策本身不记账——没真写成功就先不占额度
  assert.equal(first.state.count, 0)
  state = commitNoteWrite(first.state, 'evt-1', true, T0)
  const again = write(note(), T0 + 3600000, state)
  assert.equal(again.reason, 'duplicate')
  assert.equal(again.write, null)
})

test('配额：每天最多 3 个；跨日归零；间隔 30 分钟', () => {
  let state = emptyNoteFileState(T0)
  for (let i = 0; i < NOTE_FILE_LIMITS.perDay; i++) {
    const at = T0 + i * 31 * 60000
    const r = write(note({ id: `e${i}` }), at, state)
    assert.equal(r.reason, 'ok', `第 ${i + 1} 次`)
    state = commitNoteWrite(r.state, `e${i}`, true, at)
  }
  const blocked = write(note({ id: 'x' }), T0 + 5 * 31 * 60000, state)
  assert.equal(blocked.reason, 'daily-limit')

  // 间隔
  const g1 = write(note({ id: 'g' }), T0, emptyNoteFileState(T0))
  assert.equal(g1.reason, 'ok')
  const g1State = commitNoteWrite(g1.state, 'g', true, T0)
  const tooSoon = write(note({ id: 'g2' }), T0 + 60000, g1State)
  assert.equal(tooSoon.reason, 'too-soon')

  // 跨日：计数归零
  const nextDay = T0 + 24 * 3600000
  const next = write(note({ id: 'n' }), nextDay, state)
  assert.equal(next.reason, 'ok')
  const nextState = commitNoteWrite(next.state, 'n', true, nextDay)
  assert.equal(nextState.count, 1)
})

test('写入失败不占配额、不记幂等（可原样再试）；成功才记账', () => {
  const r = write(note(), T0, emptyNoteFileState(T0))
  assert.equal(r.reason, 'ok')
  const afterFail = commitNoteWrite(r.state, 'evt-1', false, T0)
  assert.equal(afterFail.count, 0, '失败不占额度')
  assert.equal(afterFail.written.length, 0, '失败不记幂等')
  // 失败后同一张便签仍能再次决策（用户拒了一次确认，下次还想写就还能写）
  const retry = write(note(), T0, afterFail)
  assert.equal(retry.reason, 'ok')

  const afterOk = commitNoteWrite(r.state, 'evt-1', true, T0)
  assert.equal(afterOk.count, 1)
  assert.ok(afterOk.written.includes('evt-1'))
  // commitNoteWrite 对未知/重复 id 安全
  assert.equal(commitNoteWrite(afterOk, '', true, T0).count, 1)
  assert.equal(commitNoteWrite(afterOk, 'evt-1', true, T0).count, 1, '重复记账不翻倍')
})

/* ---------------- 5. 状态与脏输入 ---------------- */

test('状态：关闭即清空（不重放积压）、脏数据可恢复、不可变', () => {
  const s = emptyNoteFileState(T0)
  const snapshot = JSON.parse(JSON.stringify(s))
  const r = decideNoteWrite({ note: note(), now: T0, state: s, config: cfgOn, root: ROOT, realpathOf: flatRealpath })
  assert.equal(r.reason, 'ok')
  assert.deepEqual(s, snapshot, '传入的 state 不得被就地修改')

  // now 必须显式传 T0：省略会用真实 Date.now()，跨零点后 dayKey 变成"明天"，
  // 断言 expect_day(T0) 就必挂（2026-10-18 00:2x 实测踩到，是测试自己的时间炸弹）
  assert.deepEqual(normalizeNoteFileState({ dayKey: 1, count: 'x', lastAt: 'y', written: 'no' }, T0), {
    dayKey: expect_day(s), count: 0, lastAt: 0, written: []
  })
  assert.deepEqual(normalizeNoteFileState(null, T0).written, [])
  const reset = resetNoteFileState(T0)
  assert.equal(reset.count, 0)
  assert.equal(reset.written.length, 0)
})

function expect_day(s) {
  const d = new Date(T0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test('脏输入全扫描：不抛错，且只产出两种结果（拒绝 / 根内合法路径）', () => {
  const roots = [ROOT, '', 'bad/rel', null, 42]
  const dirs = [null, '', 'ok', '../x', 'C:/x', 42]
  const names = [null, '', '../x.txt', 'a.exe', '正常']
  let allowed = 0
  let denied = 0
  for (const root of roots) {
    for (const dir of dirs) {
      for (const fileName of names) {
        const r = resolveNoteTarget({ root, dir, fileName, realpathOf: flatRealpath })
        assert.ok(typeof r.ok === 'boolean')
        assert.ok(typeof r.reason === 'string' && r.reason)
        if (!r.ok) {
          denied++
          assert.equal(r.absPath, '', '拒绝时不给路径')
          continue
        }
        allowed++
        assert.ok(isWithinRoot(normalize(root), r.absPath), `允许的路径必须在根内：${r.absPath}`)
        assert.ok(r.fileName.endsWith('.txt'))
      }
    }
  }
  assert.ok(allowed > 0 && denied > 0, `两种结果都要覆盖：allowed=${allowed} denied=${denied}`)
  // 决策层对整体脏入参
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(decideNoteWrite(bad).write, null)
  }
})

function normalize(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
}
