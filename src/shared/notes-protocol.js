// src/shared/notes-protocol.js
// BLUE-3 便签（她留下的东西）的可信 IPC 契约。
//
// 单独成文件、不改 presence-protocol.js（红区）：红区负责实感状态机本身，
// 便签是蓝区业务，通道名与广播名都在这里，渲染层只读。

export const NOTES_IPC = {
  /** 只读：当前便签列表 + 留痕 + 开关状态 */
  LIST: 'notes:list',
  /** 清除：清内存与磁盘（不改设置开关） */
  CLEAR: 'notes:clear',
  /** 用系统目录选择器选一个授权目录（外部便签写入的唯一入口；不接受手填路径） */
  EXTERNAL_PICK: 'notes:external-pick',
  /** 撤销授权目录（不清空已写出的文件，只是不再写） */
  EXTERNAL_REVOKE: 'notes:external-revoke',
  /**
   * 把某一张便签写成文件。**每次都会弹一次原生确认框**（逐次授权），
   * 用户不点确认就不写盘。
   */
  EXTERNAL_WRITE: 'notes:external-write'
}

/** 便签/留痕变化后主进程向两窗广播（同一权威列表） */
export const NOTES_EVENT = 'notes:changed'
