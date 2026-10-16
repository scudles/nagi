// src/main/ipc/relation.js
// 关系层 IPC（S4）：熟悉度摘要 + 情绪时间线（关系页用）。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { relationInfo, timelineData } from '../agent.js'

export function registerRelationIpc() {
  trustedHandle(IPC.RELATION_GET, () => ({ ok: true, ...relationInfo() }))
  trustedHandle(IPC.RELATION_TIMELINE, (_e, opts) => ({ ok: true, ...timelineData(opts && opts.days) }))
}
