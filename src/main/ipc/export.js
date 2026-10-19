// C5 统一记忆/数据导出（P3-08，CONTRACTS §15）的 IPC 入口。
// 两条通道，语义刻意分开：
//   DATA_EXPORT        用户点「导出」→ 系统保存框 → 写盘。唯一的写盘路径。
//   DATA_EXPORT_PREVIEW 设置页预览范围 → 只取数，不写盘、不弹框、不上传（C5-EXPORT-04）。
import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/protocol.js'
import { trustedHandle } from './trusted.js'
import { previewExport, runExport } from '../export.js'

export function registerExportIpc() {
  trustedHandle(IPC.DATA_EXPORT, (event) =>
    runExport(BrowserWindow.fromWebContents(event.sender)))
  trustedHandle(IPC.DATA_EXPORT_PREVIEW, () => previewExport())
}
