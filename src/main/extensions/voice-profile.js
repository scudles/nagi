// src/main/extensions/voice-profile.js
// BLUE-1 扩展：把「语音情绪参数映射」注册为 presence 的语音参数提供者。
//
// 由 src/main/presence-extensions.js 的 import.meta.glob('./extensions/*.js') 自动加载，
// 蓝区加扩展只需往这个目录放文件，不改红区编排（main/voice）。
//
// 门控：无条件注册；开不开由编排层读 settings.presence.voiceProfileEnabled 决定
//      （默认 false），设置里切换即时生效，无需重启。
//
// 用户偏移：设置页的语速 / 音量滑条应继续有效——这里把 settings.voice 的全局偏移
//           折进基准（与编排层 paramsFor 同语义），再交给 core 纯函数。

import { resolveVoiceProfile } from '../../core/voice/voice-profile.js'
import { getSettings } from '../settings-store.js'

export function install(api) {
  return api.registerVoiceParamsProvider((input) => {
    const v = (getSettings() || {}).voice || {}
    return resolveVoiceProfile(input, {
      userRate: Number.isFinite(v.rate) ? v.rate : 0,
      userVolume: Number.isFinite(v.volume) ? v.volume : 100
    })
  })
}
