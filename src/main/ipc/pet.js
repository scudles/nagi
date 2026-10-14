// src/main/ipc/pet.js
// 桌宠交互 IPC：戳一戳 + 内心独白日史读取。

import { ipcMain } from 'electron'
import { IPC } from '../../shared/protocol.js'
import { handlePoke, getMoodSnapshot } from '../agent.js'
import { listDiaryDates, readDiary } from '../diary.js'

export function registerPetIpc() {
  ipcMain.handle(IPC.PET_POKE, () => handlePoke())
  ipcMain.handle(IPC.MOOD_GET, () => getMoodSnapshot())
  ipcMain.handle(IPC.DIARY_LIST, () => ({ ok: true, dates: listDiaryDates() }))
  ipcMain.handle(IPC.DIARY_READ, (_e, { file }) => {
    const content = readDiary(file)
    return content === null ? { ok: false, error: '日记不存在' } : { ok: true, content }
  })
}
