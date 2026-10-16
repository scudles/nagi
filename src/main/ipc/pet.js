// src/main/ipc/pet.js
// 桌宠交互 IPC：戳一戳 + 内心独白日史读取。

import { trustedHandle } from './trusted.js'
import { IPC } from '../../shared/protocol.js'
import { handlePoke, getMoodSnapshot } from '../agent.js'
import { listDiaryDates, readDiary } from '../diary.js'

export function registerPetIpc() {
  trustedHandle(IPC.PET_POKE, () => handlePoke())
  trustedHandle(IPC.MOOD_GET, () => getMoodSnapshot())
  trustedHandle(IPC.DIARY_LIST, () => ({ ok: true, dates: listDiaryDates() }))
  trustedHandle(IPC.DIARY_READ, (_e, { file }) => {
    const content = readDiary(file)
    return content === null ? { ok: false, error: '日记不存在' } : { ok: true, content }
  })
}
