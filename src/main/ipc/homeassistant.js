// src/main/ipc/homeassistant.js
// 智能家居 IPC：测试连接 / 列设备。实体控制走 Agent 工具（home_set / home_scene）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { BrowserWindow, dialog } from 'electron'
import { haTest, haList, haSignalStatus, allowHaRead, allowHaControl, revokeHaControl, revokeHaAll } from '../signals/ha.js'

export function registerHomeAssistantIpc() {
  trustedHandle(IPC.HA_TEST, () => haTest())
  trustedHandle(IPC.HA_LIST, (_e, domain) => haList(domain))
  trustedHandle(IPC.HA_SIGNAL_STATUS, () => haSignalStatus())
  trustedHandle(IPC.HA_READ_ENABLE, () => allowHaRead())
  trustedHandle(IPC.HA_CONTROL_ENABLE, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const opts = { type: 'warning', title: '授权智能家居控制',
      message: '允许凪请求控制 Home Assistant 设备？',
      detail: '每次具体设备控制仍会显示目标和操作，并等待你再次确认。服务调用成功只记“已尝试”，不代表设备已达到目标状态。',
      buttons: ['取消', '允许逐次确认的控制'], defaultId: 0, cancelId: 0, noLink: true }
    const answer = owner ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts)
    return answer.response === 1 ? allowHaControl() : { ok: false, canceled: true }
  })
  trustedHandle(IPC.HA_CONTROL_REVOKE, () => revokeHaControl())
  trustedHandle(IPC.HA_SIGNAL_REVOKE, () => revokeHaAll())
}
