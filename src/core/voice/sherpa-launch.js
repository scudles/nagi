// src/core/voice/sherpa-launch.js
// sherpa-onnx 离线服务「启动参数怎么给」的纯决策逻辑（可单测，不碰 fs / spawn）。
//
// 坑（2026-10-17 实测复现并修复，复现步骤见 main/voice/sherpa.js 顶部注释）：
// sherpa-onnx-offline-websocket-server.exe 是传统 main() 的 C 程序，Windows 上
// 子进程收到的 argv 会按系统 ANSI 代码页（中文系统 = cp936/GBK）转换。打包版
// productName 是「凪 Nagi」，userData 落在 %APPDATA%\凪 Nagi ——「凪」（U+6BAA）
// 不在 GBK 里，--paraformer/--tokens 的绝对路径会被打成乱码，服务端启动即退出
// （tokens.txt does not exist），于是每次识别都白等一个启动超时、再静默回退
// SAPI，识别结果质量很差。
//
// 规避手段（本文件只判断「用哪种」，真正起进程在 main/voice/sherpa.js）：
//   ① cwd 不走 argv —— libuv 用 UTF-16 把它传给 CreateProcessW，原样保留。
//      所以把模型目录设为 cwd、参数改成纯 ASCII 的相对文件名，代码页转换就
//      无从破坏（实测：服务 1.5s 就绪，识别完全正常）；
//   ② 目录本身是 ASCII 时没必要绕，保持「绝对路径 + cwd=binDir」的既有行为。

/**
 * 字符串能否安全地作为子进程命令行参数。
 * 纯 ASCII 可打印字符才行；含中文/日文等 GBK 以外字符、或含双引号时都不行
 * （前者会被代码页转换打乱，后者会破坏 argv 引号规则）。
 * @param {string} p
 * @returns {boolean}
 */
export function isAsciiPath(p) {
  const s = String(p ?? '')
  return /^[\x20-\x7E]*$/.test(s) && !s.includes('"')
}

/**
 * 决定服务启动时的 cwd 与模型文件参数形态。
 * @param {string} modelDir 模型目录（userData 下，可能含非 ASCII 字符）
 * @param {string} [binDir] 可执行文件所在目录（ASCII 场景用作 cwd）
 * @returns {{relative:boolean, cwd:string, modelDir:string}}
 *   relative=false → 参数用绝对路径 join(modelDir, 'model.int8.onnx')，cwd=binDir（既有行为）
 *   relative=true  → 参数用相对文件名 'model.int8.onnx'，cwd=modelDir（绕过代码页）
 */
export function sherpaLaunchPlan(modelDir, binDir = '') {
  const dir = String(modelDir ?? '')
  if (isAsciiPath(dir)) {
    return { relative: false, cwd: String(binDir ?? ''), modelDir: dir }
  }
  return { relative: true, cwd: dir, modelDir: dir }
}
