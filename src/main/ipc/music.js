import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { authorizeMusic, musicStatus, revokeMusic } from '../signals/music.js'

export function registerMusicIpc() {
  trustedHandle(IPC.MUSIC_STATUS, () => musicStatus(true))
  trustedHandle(IPC.MUSIC_ENABLE, () => authorizeMusic())
  trustedHandle(IPC.MUSIC_REVOKE, () => revokeMusic())
}
