// src/main/forget-guard.js
// C5-BG-02：进程级的"遗忘片段表"。
//
// 为什么放在 main 而不是 core：core 只放可单测的纯逻辑（createForgetGuard），
// 这里只做单例装配，让 ledger-actions（写）与 agent（读）共用一个实例。
import { createForgetGuard } from '../core/memory/forget-guard.js'

export const forgetGuard = createForgetGuard()
