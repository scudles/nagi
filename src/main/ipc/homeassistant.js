// src/main/ipc/homeassistant.js
// 智能家居 IPC：测试连接 / 列设备。实体控制走 Agent 工具（home_set / home_scene）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { haTest, haList } from '../agent.js'

export function registerHomeAssistantIpc() {
  trustedHandle(IPC.HA_TEST, () => haTest())
  trustedHandle(IPC.HA_LIST, (_e, domain) => haList(domain))
}
