// src/main/diary.js
// 内心独白日史（D2 决策：后台静默记录——平时 UI 不显示，用户在日记查看器/文件夹里主动打开才看到）
// 落盘：userData/monologue/diary-YYYY-MM-DD.md，每条带时间与当时情绪强度。

import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'

function diaryDir() {
  return join(app.getPath('userData'), 'monologue')
}

function pad(n) { return String(n).padStart(2, '0') }

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 追加一条独白（snapshot 来自情绪状态机：{ mood, intensity, expr, label }） */
export function appendDiary(snapshot, text) {
  try {
    const dir = diaryDir()
    mkdirSync(dir, { recursive: true })
    const line = `- ${timeStr()} ［${snapshot.label}·${Math.round(snapshot.intensity * 100)}%］ ${text}\n`
    appendFileSync(join(dir, `diary-${dateStr()}.md`), line, 'utf8')
  } catch (err) {
    console.error('[diary] 写入失败：', err && err.message)
  }
}

/** 列出所有日记日期文件（新→旧） */
export function listDiaryDates() {
  try {
    return readdirSync(diaryDir())
      .filter((f) => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 读取一篇日记；文件不存在或越权返回 null */
export function readDiary(file) {
  if (!/^diary-\d{4}-\d{2}-\d{2}\.md$/.test(String(file || ''))) return null
  const full = join(diaryDir(), file)
  try {
    if (!statSync(full).isFile()) return null
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}
