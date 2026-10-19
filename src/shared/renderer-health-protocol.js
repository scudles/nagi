// Fixed renderer health ingress. No user/model text or arbitrary site can cross it.
export const RENDERER_HEALTH_IPC = 'health:report-renderer'

export const RENDERER_HEALTH_SITES = Object.freeze({
  'ambient.restyleReport': 'must-persist',
  'main.clearHistory': 'must-persist',
  'main.outfitReport': 'must-persist',
  'main.monitorNoticeSave': 'must-persist',
  'main.settingsRead': 'visible',
  'main.secretStatus': 'visible',
  'main.modelList': 'visible',
  'main.maintenanceClear': 'visible',
  'main.poke': 'visible',
  'main.relationMemoryRead': 'visible',
  'live2d.stopMotion': 'semantic',
  'voice.stopSession': 'promise',
  'voice.pauseAudio': 'promise',
  'voice.stopSessionOnCancel': 'promise',
  'voice.abortBeforeRecord': 'promise',
  'voice.recordingCleanup': 'promise',
  'voice.recorderWait': 'semantic',
  // The fifth must-persist entry is the synchronous and asynchronous
  // main.outfitReport failure paths counted separately in the B8 inventory.
})

export const RENDERER_HEALTH_SOURCES = Object.freeze(['pet', 'workbench', 'diary'])

export function rendererSourceForEvent(event, findWindow, petWindow, workbenchWindow) {
  if (!event?.senderFrame || event.senderFrame !== event.sender?.mainFrame) return null
  const win = findWindow(event.sender)
  if (!win || win.isDestroyed?.()) return null
  if (win === petWindow()) return 'pet'
  if (win === workbenchWindow()) return 'workbench'
  return 'diary' // findWindow only returns registered app windows
}

export function validRendererHealthEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== 4 || keys.join(',') !== 'action,cls,id,site') return false
  if (value.action !== 'fail' && value.action !== 'recover') return false
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) return false
  if (typeof value.site !== 'string' || !Object.hasOwn(RENDERER_HEALTH_SITES, value.site)) return false
  return value.cls === RENDERER_HEALTH_SITES[value.site]
}
