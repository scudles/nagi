import { app } from 'electron'
import { YearbookStore } from '../core/yearbook/store.js'
import { getLedger } from './ledger.js'

let yearbook = null

export function getYearbook() {
  if (!yearbook) yearbook = new YearbookStore(app.getPath('userData'), getLedger()).load()
  return yearbook
}
