import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { authorizeGeo, geoStatus, revokeGeo } from '../signals/geo.js'

export function registerGeoIpc() {
  trustedHandle(IPC.GEO_STATUS, () => geoStatus())
  trustedHandle(IPC.GEO_ENABLE, () => authorizeGeo())
  trustedHandle(IPC.GEO_REVOKE, () => revokeGeo())
}
