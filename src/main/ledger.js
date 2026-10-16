import { app } from 'electron'
import { ExperienceLedger } from '../core/ledger/store.js'

let ledger = null

export function getLedger() {
  if (!ledger) ledger = new ExperienceLedger(app.getPath('userData')).load()
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
