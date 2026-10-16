import { trustedHandle } from './trusted.js'
import { PRESENCE_IPC } from '../../shared/presence-protocol.js'
import { getPresenceSnapshot,clearPresence } from '../presence.js'
export function registerPresenceIpc() {
  trustedHandle(PRESENCE_IPC.STATUS,()=>getPresenceSnapshot())
  trustedHandle(PRESENCE_IPC.CLEAR,()=>clearPresence())
}
