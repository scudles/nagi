// src/core/presence/notes-file.js
// 外部便签文件写入（B23）——**只做决策与路径校验，不碰 fs**。
//
// 这是全项目风险最高的一块（系统级写操作），所以边界写死在这里，改之前先认同：
//   · **不写 fs**：本模块只回答「能不能写、写到哪、写什么」。真正的写入由 main 侧
//     走已有的原生目录授权 + 逐次确认流完成（契约 §4 明令禁止在订阅回调里直接 fs 写桌面）。
//   · **默认关闭**：`externalNotesEnabled !== true` 或没有授权根目录 → 一律拒绝，
//     返回 `unauthorized` / `disabled`，**绝不**返回"写成功了"。
//   · **路径归属是硬校验**：目标必须在授权根目录之内。`..` 穿越、绝对路径、
//     盘符/UNC、符号链接逃逸全部拒绝——不是"尽量挡"，是挡不住就不写。
//   · **不虚构、不谎报**：文件内容与便签正文一致，模拟活动照旧标注；
//     写入失败时状态如实回到「仅应用内」，不允许显示成「已保存」。
//
// 纯逻辑，无 IO / 无 Electron 依赖，可 node --test。
// 路径语义按 Windows 为主（盘符大小写不敏感、分隔符两种都吃），但比较逻辑平台无关。

import { NOTES_LIMITS } from './notes.js'

export const NOTE_FILE_LIMITS = {
  /** 每天最多写几个文件（沿用便签配额，不另开口子） */
  perDay: NOTES_LIMITS.perDay,
  /** 两次写入最小间隔（沿用便签的 30 分钟） */
  minGapMs: NOTES_LIMITS.minGapMs,
  /** 文件名主干最长多少字符（不含日期前缀与扩展名） */
  stemMax: 48,
  /** 正文最长多少字符 */
  contentMax: 2000,
  /** 固定扩展名：不提供可配，避免被写成可执行/脚本类后缀 */
  extension: '.txt'
}

/** 已落盘记录最多保留多少条（幂等用，防止无限增长） */
const WRITTEN_MAX = 200

/** 文件名里允许的字符之外的东西（Windows 保留字符、控制字符、分隔符） */
const UNSAFE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

export function dayKeyOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 路径：归属校验 ---------------- */

/** 统一分隔符并去掉末尾斜杠；不做任何 fs 调用 */
function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 是否绝对路径（盘符 C:/ 或 UNC //server/share 或 POSIX /） */
function isAbsolutePath(p) {
  const s = normalizePath(p)
  return /^[A-Za-z]:/.test(s) || s.startsWith('//') || s.startsWith('/')
}

/** 逐段清洗相对路径：吃掉 `.` 与空段，遇到 `..` 或绝对路径直接判失败 */
function splitSafeRelative(rel) {
  const out = []
  for (const seg of normalizePath(rel).split('/')) {
    if (!seg || seg === '.') continue
    // `..` 一律拒绝（不"解析掉"，因为解析掉正是穿越得以发生的温床）
    if (seg === '..') return null
    out.push(seg)
  }
  return out
}

/**
 * 目标路径是否落在授权根目录之内（大小写不敏感，Windows 语义）。
 * 只做字符串层面的判定——符号链接要另用 realpathOf 验（见 resolveNoteTarget）。
 */
export function isWithinRoot(root, target) {
  const r = normalizePath(root)
  const t = normalizePath(target)
  if (!r || !t) return false
  const rl = r.toLowerCase()
  const tl = t.toLowerCase()
  return tl === rl || tl.startsWith(rl + '/')
}

/**
 * 解析出可写的绝对路径。**任何一步不干净就返回 ok:false**，绝不"尽力而为"。
 *
 * @param {object} input
 *   root        授权根目录（必须非空；由用户亲自选择，不存在这里就没有写入这回事）
 *   dir         根目录下的子目录（可空；会被清洗，不允许 `..` 与绝对路径）
 *   fileName    文件名（会被清洗成安全名；扩展名固定 .txt）
 *   realpathOf  可选：**给定「目录」返回其真实路径**（用来挡符号链接逃逸）。
 *               注意是目录不是文件——目标文件此时还不存在，对它调 realpath 必然 ENOENT。
 *               **不传就无法挡符号链接**，本函数不会假装验过；main 侧必须传 fs.realpathSync。
 * @returns {{ok:boolean, absPath:string, fileName:string, reason:string}}
 */
export function resolveNoteTarget({ root, dir = '', fileName = '', realpathOf = null } = {}) {
  const r = normalizePath(root)
  if (!r) return { ok: false, absPath: '', fileName: '', reason: 'no-root' }
  // 根目录自己必须是绝对路径，且自身不含 `..`
  if (!isAbsolutePath(r) || normalizePath(r).split('/').includes('..')) {
    return { ok: false, absPath: '', fileName: '', reason: 'bad-root' }
  }

  const safeName = safeFileName(fileName)
  if (!safeName) return { ok: false, absPath: '', fileName: '', reason: 'bad-name' }

  const rel = dir === '' ? [] : splitSafeRelative(dir)
  if (rel === null) return { ok: false, absPath: '', fileName: '', reason: 'path-traversal' }
  // 前导斜杠（POSIX '/etc' 与 UNC '//server/share'）：按 '/' 切分后它们会退化成普通子目录，
  // 看起来"仍在根内"，但那是**静默重解释**了调用方的意图——可疑输入一律拒绝，不猜。
  if (normalizePath(dir).startsWith('/')) {
    return { ok: false, absPath: '', fileName: '', reason: 'path-traversal' }
  }
  // 子目录里若混进盘符段（如 'C:'、'a/C:/b'）也拒绝
  if (rel.some((s) => /^[A-Za-z]:/.test(s))) {
    return { ok: false, absPath: '', fileName: '', reason: 'path-traversal' }
  }

  const absPath = [r, ...rel, safeName].join('/')
  if (!isWithinRoot(r, absPath)) return { ok: false, absPath: '', fileName: '', reason: 'outside-root' }

  // 符号链接逃逸：验**目录**的真实路径（文件还不存在，验它必然 ENOENT）。
  // 授权根里的某个子目录若被换成指向外部软链，拼出来的路径看起来仍在根内，
  // 只有 realpath 能戳穿——这一步挡不住就不写。
  if (typeof realpathOf === 'function') {
    const dirPath = [r, ...rel].join('/')
    let real = ''
    try {
      real = normalizePath(realpathOf(dirPath))
    } catch {
      return { ok: false, absPath: '', fileName: '', reason: 'symlink-unverifiable' }
    }
    if (!real) return { ok: false, absPath: '', fileName: '', reason: 'symlink-unverifiable' }
    if (!isWithinRoot(r, real)) return { ok: false, absPath: '', fileName: '', reason: 'symlink-escape' }
  }

  return { ok: true, absPath, fileName: safeName, reason: 'ok' }
}

/** 把任意输入收敛成一个安全文件名（主干截断 + 扩展名固定） */
export function safeFileName(rawName) {
  const stem = String(rawName == null ? '' : rawName)
    .replace(/\.[^./\\]*$/, '') // 去掉原有扩展名（扩展名我们说了算）
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, NOTE_FILE_LIMITS.stemMax)
    .trim()
  if (!stem) return ''
  return `${stem}${NOTE_FILE_LIMITS.extension}`
}

/* ---------------- 文件名与正文 ---------------- */

const NOTE_KIND_SLUG = { activity: '独处', reunion: '归来', action: '行动' }

/** 便签 → 文件名（日期前缀 + 类型 + 正文起头，全部清洗过） */
export function noteFileName(note, now = Date.now()) {
  const at = Number.isFinite(note?.at) ? note.at : now
  const slug = NOTE_KIND_SLUG[note?.noteKind] || '便签'
  const head = String(note?.text || '').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim()
  const stem = `${dayKeyOf(at)}-${slug}${head ? `-${head}` : ''}`
  return safeFileName(stem)
}

/** 便签 → 文件正文（如实：模拟活动照旧标注，不写成外界经历） */
export function noteFileContent(note) {
  const at = Number.isFinite(note?.at) ? new Date(note.at) : null
  const timeLine = at
    ? `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : '（时间不明）'
  const lines = [timeLine, '', String(note?.text || '').slice(0, NOTE_FILE_LIMITS.contentMax)]
  if (note?.provenance === 'simulation') {
    lines.push('', '（这是她独处时的内部状态，不是你离开期间外界发生的事。）')
  }
  if (note?.provenance === 'observed' && note?.completionVerified === false) {
    lines.push('', '（只说跑过与返回，外部效果她没有核实。）')
  }
  return lines.join('\n')
}

/* ---------------- 状态与决策 ---------------- */

export function emptyNoteFileState(now = Date.now()) {
  return { dayKey: dayKeyOf(now), count: 0, lastAt: 0, written: [] }
}

export function normalizeNoteFileState(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const written = Array.isArray(s.written) ? s.written.filter((x) => typeof x === 'string' && x).slice(-WRITTEN_MAX) : []
  return {
    dayKey: typeof s.dayKey === 'string' && s.dayKey ? s.dayKey : dayKeyOf(now),
    count: Math.max(0, Math.floor(Number(s.count) || 0)),
    lastAt: Number.isFinite(s.lastAt) ? s.lastAt : 0,
    written
  }
}

/** 关闭开关即清空（沿用便签「关闭即删文件」的语义，不重放积压） */
export function resetNoteFileState(now = Date.now()) {
  return emptyNoteFileState(now)
}

/**
 * 这张便签要不要、能不能、写到哪。
 *
 * @param {object} input
 *   note            便签（来自 notes.js 的 considerNote；没有就谈不上写）
 *   now             当前时间戳（注入）
 *   state           上一次返回的 state
 *   config          { externalNotesEnabled?:boolean }
 *   root            授权根目录（空 = 未授权）
 *   dir             可选子目录
 *   realpathOf      可选，符号链接校验（见 resolveNoteTarget）
 * @returns {{write:{absPath:string,fileName:string,content:string}|null, reason:string, state:object}}
 */
export function decideNoteWrite(rawInput) {
  // 入参可能是 null / 字符串 / 数组；一律收敛成空对象，绝不抛错
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const state = normalizeNoteFileState(input.state, now)
  const none = (reason) => ({ write: null, reason, state })

  const config = input.config && typeof input.config === 'object' ? input.config : {}
  if (config.externalNotesEnabled !== true) return none('disabled')

  const note = input.note && typeof input.note === 'object' ? input.note : null
  if (!note || !note.id) return none('no-note')

  // 幂等：同一张便签只写一次（写失败不该由本模块决定重试——那是 main 侧的事）
  if (state.written.includes(String(note.id))) return none('duplicate')

  const today = dayKeyOf(now)
  const count = state.dayKey === today ? state.count : 0
  if (count >= NOTE_FILE_LIMITS.perDay) return none('daily-limit')
  if (state.lastAt && now - state.lastAt < NOTE_FILE_LIMITS.minGapMs) return none('too-soon')

  const target = resolveNoteTarget({
    root: input.root,
    dir: input.dir,
    fileName: noteFileName(note, now),
    realpathOf: input.realpathOf
  })
  if (!target.ok) return none(target.reason)

  // 注意：**这里不记账，连 dayKey 都不提前翻**——配额与幂等都要等 main 侧真写成功后
  // 再由 commitNoteWrite 落账，否则①一次失败就吃掉额度还不能重试；②跨日时会把昨天的
  // 计数当成今天的（3 + 1 = 4 而不是归零后的 1）。决策本身对状态是只读的。
  return {
    write: { absPath: target.absPath, fileName: target.fileName, content: noteFileContent(note) },
    reason: 'ok',
    state
  }
}

/**
 * 写入结果回填：**只有成功才占配额、才记幂等**。
 * 失败（用户拒绝确认 / fs 报错 / 越权被拦）一律原样返回——不占额度，同一张便签可以再试。
 */
export function commitNoteWrite(state, noteId, ok, now = Date.now()) {
  const s = normalizeNoteFileState(state, now)
  if (ok !== true) return s
  const id = String(noteId || '')
  if (!id || s.written.includes(id)) return s
  const today = dayKeyOf(now)
  const count = s.dayKey === today ? s.count : 0
  return {
    dayKey: today,
    count: count + 1,
    lastAt: now,
    written: [...s.written, id].slice(-WRITTEN_MAX)
  }
}
