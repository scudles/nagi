// src/shared/notes-protocol.js
// BLUE-3 便签（她留下的东西）的可信 IPC 契约。
//
// 单独成文件、不改 presence-protocol.js（红区）：红区负责实感状态机本身，
// 便签是蓝区业务，通道名与广播名都在这里，渲染层只读。

export const NOTES_IPC = {
  /** 只读：当前便签列表 + 留痕 + 开关状态 */
  LIST: 'notes:list',
  /** 清除：清内存与磁盘（不改设置开关） */
  CLEAR: 'notes:clear'
}

/** 便签/留痕变化后主进程向两窗广播（同一权威列表） */
export const NOTES_EVENT = 'notes:changed'
