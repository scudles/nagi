import { app } from 'electron'
import { join } from 'node:path'
import { trustedHandle } from './trusted.js'
import { findWindowByWebContents, getPetWindow, getWorkbenchWindow } from '../windows.js'
import { createRendererHealthStore } from '../renderer-health-store.js'
import { attachRendererHealthStore, reportCatch, maintenanceRecover, CATCH_CLASS } from '../maintenance.js'
import { RENDERER_HEALTH_IPC, rendererSourceForEvent, validRendererHealthEvent } from '../../shared/renderer-health-protocol.js'

export function createRendererHealthHandler(store, sourceForEvent = (event) => rendererSourceForEvent(event, findWindowByWebContents, getPetWindow, getWorkbenchWindow)) {
  return (event, payload) => {
    const source = sourceForEvent(event)
    if (!source || !validRendererHealthEvent(payload)) throw new TypeError('renderer health report rejected')
    return store.report(source, payload)
  }
}

export function registerRendererHealthIpc() {
  const store = createRendererHealthStore({
    file: join(app.getPath('userData'), 'renderer-health.json'),
    onPersistFailure: (err) => reportCatch('rendererHealth.persist', CATCH_CLASS.MUST_PERSIST, err),
    onPersistRecovery: () => maintenanceRecover('rendererHealth.persist')
  })
  attachRendererHealthStore(store)
  trustedHandle(RENDERER_HEALTH_IPC, createRendererHealthHandler(store))
}
