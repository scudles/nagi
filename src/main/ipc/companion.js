import { IPC } from '../../shared/protocol.js'
import { trustedHandle } from './trusted.js'
import { companionIgnored, companionStatus } from '../companion.js'

export function registerCompanionIpc() {
  trustedHandle(IPC.COMPANION_STATUS, () => ({ ok: true, ...companionStatus() }))
  trustedHandle(IPC.COMPANION_IGNORE, () => {
    companionIgnored()
    return { ok: true, ...companionStatus() }
  })
}
