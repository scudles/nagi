// src/main/notes-file.js
// B23 外部便签写入的**主进程桥接**（全项目唯一真正 fs 写盘的地方）。
//
// 为什么单独一个文件：这里是系统级写操作，边界必须一眼看得完。
// 规则（改之前先认同）：
//   · 目录只能由用户用**系统目录选择器**选出，不接受手填路径（手填 = 可被引诱到任意位置）；
//     选出后立刻 realpath，存的是真实路径。
//   · **每次写入都弹一次原生确认框**，不提供"以后都不问"的开关——
//     逐次授权是这个功能能被允许存在的代价。
//   · 写之前把 core 的路径校验再跑一遍（含 realpath 软链校验），**校验不过绝不写**；
//     写入用 `wx` 标志：已存在就失败，绝不覆盖用户已有的文件。
//   · 任何失败都如实返回，**绝不返回"已保存"**（界面状态跟着这个结果走）。
//   · 开关关闭 → 直接不写（甚至不去读目录）。

import { dialog } from 'electron'
import { promises as fs, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSettings, saveSettings } from './settings-store.js'
import {
  decideNoteWrite,
  commitNoteWrite,
  emptyNoteFileState,
  normalizeNoteFileState,
  resetNoteFileState
} from '../core/presence/notes-file.js'

/** 外部写入状态只存内存：重启后幂等表归零，靠 `wx` 防重复覆盖（不落盘是刻意的——
 *  落盘会让它"跨天还记得写过什么"，那不是我们想要的状态） */
let fileState = emptyNoteFileState()
/** 已成功写出的便签 id → 路径（只用于界面显示"已保存到"） */
let savedPaths = new Map()

const presenceCfg = () => getSettings().presence || {}

/** 当前外部写入是否可用（开关 + 已授权目录） */
export function externalWriteStatus() {
  const p = presenceCfg()
  const enabled = p.externalNotesEnabled === true
  const dir = typeof p.notesExternalDir === 'string' ? p.notesExternalDir : ''
  return { enabled, dir, available: enabled && !!dir }
}

/** 开关关闭/撤销时清空内存状态（不重放积压） */
export function syncExternalNotes(now = Date.now()) {
  const st = externalWriteStatus()
  if (!st.available) {
    fileState = resetNoteFileState(now)
    savedPaths = new Map()
  } else {
    fileState = normalizeNoteFileState(fileState, now)
  }
  return st
}

/** 给渲染层看的状态（含"已保存到哪"） */
export function externalNotesView() {
  const st = syncExternalNotes()
  return {
    available: st.available,
    enabled: st.enabled,
    dir: st.dir,
    saved: [...savedPaths.entries()].map(([id, path]) => ({ id, path })),
    todayCount: fileState.count
  }
}

/**
 * 用系统目录选择器选一个授权目录。
 * @returns {{ok:boolean, dir?:string, canceled?:boolean, error?:string}}
 */
export async function pickExternalDir(owner) {
  const r = await dialog.showOpenDialog(owner, {
    title: '选一个文件夹：凪把便签写到这里',
    properties: ['openDirectory', 'dontAddToRecent']
  })
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true }
  let dir = ''
  try {
    // 存真实路径：防止授权的是一个软链，之后被改指向
    dir = realpathSync(r.filePaths[0])
    if (!statSync(dir).isDirectory()) return { ok: false, error: '请选择文件夹，不是文件' }
  } catch (err) {
    return { ok: false, error: `这个目录读不了：${err?.message || '未知原因'}` }
  }
  // G3：授权写盘失败必须如实回 {ok:false}。旧实现 return {ok:true, dir} 会让用户
  // 以为"已授权到这个目录"，而 settings.json 根本没写——重启后授权消失，
  // 更糟的是本次会话已经在这个目录里写便签了（权限与记忆不一致）。
  // 上报由 settings-store 单点完成（站点 settings.saveSettings）。
  let next
  try {
    next = saveSettings({ presence: { notesExternalDir: dir } })
  } catch (err) {
    /* B8:must-persist — 落盘失败已由 settings.saveSettings 上报；这里把"授权没保存"
       如实回给调用方（{ok:false}），绝不说成已授权——本次会话已经在这个目录写便签了，
       权限与记忆不一致比"保存失败"更难查。 */
    return { ok: false, error: `授权没能保存：${err.message}` }
  }
  syncExternalNotes()
  return { ok: true, dir, settings: next }
}

/** 撤销授权：只是不再写，不动已经写出去的文件（删除用户文件是我们不该做的事） */
export function revokeExternalDir() {
  let next
  try {
    next = saveSettings({ presence: { notesExternalDir: '' } })
  } catch (err) {
    /* B8:must-persist — 撤销失败＝授权还在磁盘上，绝不能回 {ok:true} 说成已撤销。
       已由 settings.saveSettings 上报；这里只把结果如实给调用方。 */
    return { ok: false, error: `撤销没能保存：${err.message}` }
  }
  syncExternalNotes()
  return { ok: true, settings: next }
}
/** 找出一张便签（只读，供写入用） */
function findNote(noteId) {
  if (!noteId) return null
  // 便签正文在 presence-notes.js 里；这里不直接依赖它的内部 state，走它的只读出口
  const list = listNotesSnapshot()
  return list.find((n) => n && n.id === noteId) || null
}

let listNotesSnapshot = () => []
/** 由 ipc/notes.js 注入便签读取器（避免本模块反向依赖 presence-notes 造成循环） */
export function setNotesReader(fn) {
  listNotesSnapshot = typeof fn === 'function' ? fn : () => []
}

/**
 * 把一张便签写成文件。**写完之前会弹一次确认框**。
 *
 * @param {string} noteId 便签 id
 * @param {BrowserWindow|null} owner 确认框的归属窗口
 * @returns {{ok:boolean, path?:string, reason?:string, canceled?:boolean, error?:string}}
 */
export async function writeNoteFile(noteId, owner = null) {
  const st = syncExternalNotes()
  if (!st.enabled) return { ok: false, reason: 'disabled', error: '外部便签写入是关着的' }
  if (!st.dir) return { ok: false, reason: 'no-root', error: '还没有选文件夹' }

  const note = findNote(noteId)
  if (!note) return { ok: false, reason: 'no-note', error: '找不到这张便签' }
  if (savedPaths.has(noteId)) return { ok: false, reason: 'duplicate', error: '这张已经保存过了' }

  // 路径与配额：core 层裁决，realpath 用真的 fs（挡软链逃逸）
  const decision = decideNoteWrite({
    note,
    now: Date.now(),
    state: fileState,
    config: { externalNotesEnabled: true },
    root: st.dir,
    realpathOf: (p) => realpathSync(p)
  })
  if (!decision.write) return { ok: false, reason: decision.reason, error: `不能写：${decision.reason}` }
  fileState = decision.state

  const { absPath, fileName, content } = decision.write

  // 逐次确认：把要写到哪、写成什么都摊开给用户看
  const answer = owner
    ? await dialog.showMessageBox(owner, {
      type: 'question',
      buttons: ['写入', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '把这张便签写成文件？',
      message: `写到：${absPath}`,
      detail: `${fileName}\n\n${content}`
    })
    : await dialog.showMessageBox({
      type: 'question',
      buttons: ['写入', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '把这张便签写成文件？',
      message: `写到：${absPath}`,
      detail: `${fileName}\n\n${content}`
    })
  if (answer?.response !== 0) {
    // 用户取消：不占额度、不记幂等（core 已是"成功才记账"，这里什么都不用回滚）
    return { ok: false, canceled: true, reason: 'canceled' }
  }

  try {
    await fs.mkdir(dirname(absPath), { recursive: true })
    // wx：已存在就失败——绝不覆盖用户已有的文件
    await fs.writeFile(absPath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    // 写失败如实上报，界面不能显示成"已保存"
    return { ok: false, reason: 'write-failed', error: err?.message || '写入失败' }
  }

  fileState = commitNoteWrite(fileState, noteId, true, Date.now())
  savedPaths.set(noteId, absPath)
  return { ok: true, path: absPath, fileName }
}

/** 测试/诊断：只读状态 */
export function __peekNoteFileState() {
  return { ...fileState, saved: [...savedPaths.entries()] }
}
