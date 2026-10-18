import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { calendarNow } from './clock.js'
import { createFsDocumentIo } from './store/document-io.js'
import { YearbookStore } from '../core/yearbook/store.js'
import { getLedger } from './ledger.js'

let yearbook = null

export function getYearbook() {
  if (!yearbook) yearbook = new YearbookStore({
    io: createFsDocumentIo({ root: app.getPath('userData'), files: { 'yearbook-pages': 'yearbook/pages.json' } }),
    now: calendarNow,
    rng: randomUUID,
    ledger: getLedger()
  }).load()
  return yearbook
}
