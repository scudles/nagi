// src/core/voice/owner.js
// 语音播放归属（V01 修复，2026-10-15）：一次回复只允许一个窗口朗读。
//
// 背景：桌宠窗与工作台窗加载同一份渲染层，都会订阅 AGENT DONE 并各自调用 speak，
// 出现「一次广播、两窗齐声」——隐藏的桌宠窗也会在用户看不见的地方发声。
// 修复思路：主进程定唯一归属者（当前形态所在窗口），IPC 层只放行归属者的
// speak 请求；形态切换时旧归属者停止朗读。
//
// 这里是纯逻辑，不碰 Electron，方便单测；窗口存活判断由调用方（main/windows.js）喂进来。

/**
 * 选语音播放归属窗口。
 * @param {'pet'|'workbench'} mode 当前形态
 * @param {{pet?:boolean, workbench?:boolean}} alive 各窗口是否存在
 * @returns {'pet'|'workbench'|null} 归属窗口；都没有则 null
 */
export function pickVoiceOwner(mode, alive = {}) {
  const primary = mode === 'workbench' ? 'workbench' : 'pet'
  const other = primary === 'workbench' ? 'pet' : 'workbench'
  if (alive[primary]) return primary
  // 兜底：当前形态的窗异常消失时用另一个，避免全员静默（她说不出话比双播更糟）
  if (alive[other]) return other
  return null
}
