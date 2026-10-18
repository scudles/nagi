import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { calendarNow } from './clock.js'
import { ledgerRecordIo } from './store/record-io.js'
import { userDataLegacyReader } from './store/legacy-reader.js'
import { ExperienceLedger } from '../core/ledger/store.js'

let ledger = null

export function getLedger() {
  // B7（P2-05）：core 侧只认端口；真实 fs 的端口在这里装配
  if (!ledger) ledger = new ExperienceLedger({
    recIo: ledgerRecordIo(app.getPath('userData')),
    legacy: userDataLegacyReader(app.getPath('userData')),
    now: calendarNow,
    rng: randomUUID
  }).load()
  return ledger
}

export function migrateLegacyLedger() {
  return getLedger().migrateLegacy()
}

export function recordLedger(fields) {
  try {
    return getLedger().record(fields)
  } catch (err) {
    console.warn('[ledger] 写入失败：', err?.message)
    return null
  }
}

export function deleteLedgerSource(type, ref) {
  try { return getLedger().deleteBySource(type, ref) } catch (err) {
    console.warn('[ledger] 删除状态写入失败：', err?.message)
    return false
  }
}
