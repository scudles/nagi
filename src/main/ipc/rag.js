// src/main/ipc/rag.js
// 长期记忆档案（RAG）的 IPC：状态 / 召回自测 / 重建 / 清空 / 本地模型下载。
//
// 与语音链路同构：下载是几十 MB 的慢活，进度走广播（RAG_EVT.PROGRESS），
// 不让设置页干等；其余都是一次性查状态或触发维护动作。

import { BrowserWindow } from 'electron'
import { RAG_IPC, RAG_EVT } from '../../shared/rag-protocol.js'
import { trustedHandle } from './trusted.js'
import { getRag } from '../rag/index.js'
import { downloadEmbedModel, embedLocalStatus } from '../rag/embed-local.js'

/** 广播给所有窗口（桌宠窗 + 工作台窗） */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload)
      } catch{ /* B8:degrade — 窗口正在销毁属预期竞态 */ }
    }
  }
}

export function registerRagIpc() {
  /* ---------------- 状态 ---------------- */

  trustedHandle(RAG_IPC.STATUS, () => getRag().status())

  /* ---------------- 召回自测（设置页「试一下」） ---------------- */

  trustedHandle(RAG_IPC.RECALL_TEST, async (_e, payload = {}) => {
    const q = String((payload && payload.query) || '').trim()
    if (!q) return { ok: false, reason: '先写一句想问她的话', count: 0, results: [], text: '' }
    return getRag().recallTest(q)
  })

  /* ---------------- 维护 ---------------- */

  // 重建索引：换嵌入引擎（维度变了）或向量文件损坏后用它重嵌。文本全保留。
  trustedHandle(RAG_IPC.REBUILD, async () => getRag().rebuild())

  // 清空档案：渲染层已做过二次确认，这里不再啰嗦
  trustedHandle(RAG_IPC.CLEAR, () => getRag().clear())

  /* ---------------- 本地嵌入模型 ---------------- */

  trustedHandle(RAG_IPC.MODEL_STATUS, () => embedLocalStatus())

  trustedHandle(RAG_IPC.MODEL_DOWNLOAD, async () => {
    // 约 24MB（量化 ONNX）+ 分词表。进度推给设置页，别让按钮像卡住了
    const r = await downloadEmbedModel({
      log: (s) => console.log(s),
      onProgress: (p) => broadcast(RAG_EVT.PROGRESS, { kind: 'download', ...p })
    })
    broadcast(RAG_EVT.PROGRESS, { kind: 'download', done: true, ok: r.ok, error: r.error || '' })
    // 装好就立刻开工：把之前攒下的待嵌文本补进索引，不用等下一轮对话才生效
    if (r.ok) await getRag().embedPending()
    return { ...r, status: embedLocalStatus() }
  })
}
