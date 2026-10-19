// src/main/export.js
// C5 统一记忆/数据导出（P3-08，CONTRACTS §15）的**主进程桥接**。
//
// 为什么单独一个文件：这里把各 store 的数据汇成一份导出并写盘，边界必须一眼看得完。
// 纪律（与 notes-file.js 同源，改之前先认同）：
//   · **只由用户明确发起**：入口只有 IPC.DATA_EXPORT（渲染层按钮）。后台任务、设置页预览
//     （IPC.DATA_EXPORT_PREVIEW）都不写盘、不上传——预览只是把数据取回来给用户看。
//   · **目标由系统保存框选出**，不接受渲染层传路径（手填 = 可被引诱写到任意位置）。
//   · **绝不覆盖已有文件**：先 existsSync 预检，再走「写 .partial → linkSync 原子占位」。
//     linkSync 在目标已存在时必然失败（EEXIST），用户的文件一根字节都不会被碰。
//   · **写入中断只留下可识别的残局**：失败时清掉 .partial；即便清理也失败，残留的也是
//     `.partial` 后缀而不是看起来完整的 .json——绝不给出成功承诺。
//   · **旧外部副本永远不碰**：不删、不改、不上传用户过去导出的文件（契约 §15.1）。
//   · 任何失败都如实返回 {ok:false,error}，**绝不返回"已导出"**。
//
// 组装与标注的纯逻辑在 core/export/build.js；本文件只做取数、对话框与落盘。

import { app, dialog } from 'electron'
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildExportBundle, serializeExport } from '../core/export/build.js'
import { reportCatch, CATCH_CLASS } from './maintenance.js'
import { getLedger } from './ledger.js'
import { listMemories, loadHistory } from './persist.js'
import { readAllJournalDays } from './journal.js'
import { listDiaryFiles } from './diary.js'
import { getYearbook } from './yearbook.js'
import { listNotes } from './presence-notes.js'
import { getPromiseBook } from './promises.js'

/** 默认文件名（用户在对话框里可以改） */
export function defaultExportName(now = Date.now()) {
  return `凪-数据导出-${new Date(now).toISOString().slice(0, 10)}.json`
}

/**
 * 从各 store 取数（复用 P2-06 数据地图里的同一批位置，不建平行库）：
 * 账本（含已删，删除标记的来源）/ memory.json / 流水 / 独白日记 / 年鉴 / 便签+痕迹+锚点 / 承诺簿 / 对话历史。
 * 读取失败一律抛出——导出可以失败，不能悄悄少一节。
 */
export function collectExportSources() {
  const notes = listNotes()
  return {
    ledger: getLedger().list({ includeDeleted: true }),
    memory: listMemories(),
    journal: readAllJournalDays(),
    diary: listDiaryFiles(),
    yearbook: getYearbook().list(),
    notes: { notes: notes.notes, traces: notes.traces, anchors: notes.anchors },
    promises: getPromiseBook().list(),
    history: loadHistory()
  }
}

/** 组装导出内容（纯数据 + 序列化文本）。不写盘。 */
export function buildExport(now = Date.now()) {
  const bundle = buildExportBundle(collectExportSources(), now)
  return { bundle, text: serializeExport(bundle) }
}

/**
 * 写入目标文件。**不覆盖**：已存在即失败；并发下靠 linkSync 原子占位保证。
 * @returns {{ok:true,path:string,counts:object}|{ok:false,reason:string,error:string}}
 */
export function writeExportTo(target, now = Date.now()) {
  const file = String(target || '')
  if (!file) return { ok: false, reason: 'no-target', error: '没有选择目标文件' }
  if (existsSync(file)) {
    return { ok: false, reason: 'exists', error: '目标文件已存在。为不覆盖你已有的文件，本次导出失败；请换一个文件名或目录。' }
  }
  let bundle
  let text
  try {
    ({ bundle, text } = buildExport(now))
  } catch (err) {
    // 取数失败（某个 store 读不出来）——没有内容可写，更谈不上成功
    return { ok: false, reason: 'collect-failed', error: `导出内容读取失败：${err?.message || '未知原因'}` }
  }
  const partial = `${file}.partial`
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(partial)) unlinkSync(partial)
    // 先写临时文件：中途失败（磁盘满/被锁）只留下 .partial，不会留下看起来完整的 .json
    writeFileSync(partial, text, 'utf8')
    // 原子占位：目标在两步之间出现时 linkSync 抛 EEXIST——用户文件不被碰
    linkSync(partial, file)
    unlinkSync(partial)
  } catch (err) {
    try { if (existsSync(partial)) unlinkSync(partial) } catch (__err) {
      // B8:degrade — 清理 .partial 失败只留下一个带后缀的可识别残局；
      // 本次导出已经按失败回给用户（下面那个 return），不影响任何已成功的写入。
      reportCatch('export.cleanupPartial', CATCH_CLASS.DEGRADE, __err)
    }
    if (err && err.code === 'EEXIST') {
      return { ok: false, reason: 'exists', error: '目标文件已存在。为不覆盖你已有的文件，本次导出失败；请换一个文件名或目录。' }
    }
    return { ok: false, reason: 'write-failed', error: err?.message || '写入失败' }
  }
  return { ok: true, path: file, counts: bundle.counts }
}

/**
 * 用户发起的导出：系统保存框选目标 → 同一套写入链路。
 * @param {import('electron').BrowserWindow|null} owner 对话框归属窗口
 */
export async function runExport(owner = null, now = Date.now()) {
  // 验收专用开关（与 NAGI_SELFTEST_AUTO_CONFIRM 同一惯例，见 ipc/ledger.js 注释）：
  // 无头环境弹不出系统保存框，整条导出链路没法真机走完。仅在**显式**设置
  // NAGI_SELFTEST_EXPORT_DIR 时跳过对话框、写入该目录；生产环境不设这个变量，
  // 行为与没有这个分支时逐字一致（弹框 → 用户选目标 → 同样的 existsSync/linkSync 链路）。
  const selftestDir = process.env.NAGI_SELFTEST_EXPORT_DIR
  if (selftestDir) {
    return writeExportTo(join(selftestDir, defaultExportName(now)), now)
  }
  const options = {
    title: '导出记忆与数据',
    defaultPath: join(app.getPath('documents'), defaultExportName(now)),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  return writeExportTo(result.filePath, now)
}

/**
 * 预览：把导出内容取回来给用户看（设置页展示范围用）。
 * **不写盘、不弹框、不上传**——C5-EXPORT-04：用户没发起导出就不能有外部文件写入。
 */
export function previewExport(now = Date.now()) {
  try {
    const { bundle } = buildExport(now)
    return { ok: true, bundle }
  } catch (err) {
    return { ok: false, error: `导出内容读取失败：${err?.message || '未知原因'}` }
  }
}
