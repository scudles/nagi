// src/main/extensions/traces.js
// BLUE-3 扩展：把 presence 事件与行动留痕接进「她留下的东西」。
//
// 契约（§3.2 蓝区注册入口）：
//   · 只导出 install(api)（可返回 dispose）；不在 import 顶层起后台任务/落盘/联网；
//   · install 里按设置同步一次、dispose 里清理订阅；回调只做转发；
//   · 三个开关（notesEnabled / tracesEnabled / anchorsEnabled）默认全关 → 不落盘、不产生记录。
//
// 唯一的实现取舍：订阅**恒建立**，关掉开关时靠回调里的闸短路（每次事件读一次设置）。
// 理由是开关要能当场生效——若只在 install 时按开关决定订阅，用户开启后必须重启才有反应；
// 而事件本身很稀疏（工具返回 / 离开归来），短路成本可忽略，也不新增任何 timer。
//
// 说明：这里不注册主动开口提供者。便签/留痕是**留给用户来看**的东西，
// 什么时候说、怎么说属于人格与表达策略（与 OBS-1 的情绪外显度一起评估），
// 本期先把「记录与展示」做扎实，不新增自动台词。

import { recordPresenceEvent, recordActionTrace, syncNotesSettings } from '../presence-notes.js'

export function install(api) {
  const onPresence = (event) => {
    try {
      recordPresenceEvent(event)
    } catch (err) {
      console.warn('[notes] presence 事件处理失败', err?.message)
    }
  }
  const onAction = (trace) => {
    try {
      recordActionTrace(trace)
    } catch (err) {
      console.warn('[notes] 行动留痕处理失败', err?.message)
    }
  }
  // 与设置同步一次：三个开关全关时顺手把本模块旧文件清掉
  syncNotesSettings()
  const stops = [api.subscribePresenceEvents(onPresence), api.subscribeActionTraces(onAction)]
  return () => {
    for (const stop of stops.reverse()) {
      try {
        stop()
      } catch {
        /* 卸载失败不阻断退出 */
      }
    }
  }
}
