// src/main/voice/sherpa.js
// 离线识别适配器：sherpa-onnx（替代原计划的 Vosk）。
//
// 为什么放弃 Vosk：vosk npm 依赖 ffi-napi（原生模块，要 node-gyp 编译），
// 而且打出来的是 Node ABI 不是 Electron ABI（本工程 Electron 33 = Node 20 ABI 130）。
// 实测在本机装它卡在 ffi-napi 编译 9 分钟不出结果。于是改用 sherpa-onnx 官方
// **预编译 Windows 可执行文件** —— 它是独立进程，完全不碰 ABI，和本工程
// 「不引原生模块、优先预编译可执行文件」的做法一致。
//
// 为什么是「常驻 WS 服务」而不是每次跑一遍 CLI：
//   一次性 CLI 每次都要加载模型，实测 `recognizer created in 6.081 s`——交互不可接受。
//   官方带一个 sherpa-onnx-offline-websocket-server.exe，模型只加载一次，
//   之后每次识别只要 ~440ms（含连接 + 传输 + 解码）。所以这里管一个长驻子进程：
//   惰性拉起（第一次真要用才起）、空闲 5 分钟自动回收（它常驻要吃约 150MB 内存）。
//
// 全是「可选增强」：没下载好 / 起不来 / 崩了，status().ready 都是 false，
// 上层 recognizeAudio() 自动回退本机 SAPI —— 应用绝不会因为少一个可选项而哑掉。
//
// ⚠ Windows 非 ASCII 路径坑（2026-10-17 实测复现并修复，决策逻辑在
//    core/voice/sherpa-launch.js，有单测）：本可执行文件是传统 main() 的 C 程序，
//    子进程收到的 argv 会按系统 ANSI 代码页（中文系统 = GBK）转换。打包版
//    productName 是「凪 Nagi」，模型路径 %APPDATA%\凪 Nagi\voice\sherpa\model
//    里的「凪」（U+6BAA）不在 GBK 中，--paraformer/--tokens 绝对路径变成乱码 →
//    服务端启动即退出（stderr: tokens.txt does not exist）→ 旧实现还会白等满
//    60s 启动超时 → 识别静默回退 SAPI，结果质量很差（用户实测「说的是
//    『能听到我说话吗』，返回的却完全不相干」）。
//    对策：cwd=模型目录 + 纯 ASCII 相对文件名（cwd 走 UTF-16，不经代码页），
//    仍起不来再把模型硬链接到 %TEMP% 的 ASCII 目录用绝对路径重试。

import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { app } from 'electron'
import { fileSize, hostOf, downloadSmart } from '../download.js'
import {
  extractPcm,
  pcmToFloat32,
  toAsrWav,
  buildSherpaFrame,
  parseSherpaReply,
  sherpaLaunchPlan,
  ASR_SAMPLE_RATE,
  SHERPA_DONE
} from '../../core/voice/index.js'

/* ---------------- 常量 ---------------- */

/** CLI 版本（与官方 release tag 对应） */
export const SHERPA_CLI_VERSION = 'v1.13.8'
/** CLI 压缩包名（shared 构建 = 动态链接 DLL，体积小；no-tts = 不带语音合成） */
export const SHERPA_CLI_FILE = `sherpa-onnx-${SHERPA_CLI_VERSION}-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2`
/** 压缩包标称大小，用来判断下完没有 */
export const SHERPA_CLI_BYTES = 16168344
/**
 * CLI 下载地址，按顺序试。
 * ghproxy 在国内快得多（实测 GitHub 直连约 68KB/s，代理可到 MB/s 级）。
 */
export const SHERPA_CLI_URLS = [
  `https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_CLI_VERSION}/${SHERPA_CLI_FILE}`,
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_CLI_VERSION}/${SHERPA_CLI_FILE}`
]
/** 我们要用的那个可执行文件 */
export const SHERPA_SERVER_EXE = 'sherpa-onnx-offline-websocket-server.exe'

/** 中文 Paraformer small 模型（int8 量化，78MB，识别快且准） */
export const SHERPA_MODEL_DIR_NAME = 'sherpa-onnx-paraformer-zh-small-2024-03-09'
export const SHERPA_MODEL_BASES = [
  `https://hf-mirror.com/csukuangfj/${SHERPA_MODEL_DIR_NAME}/resolve/main`,
  `https://huggingface.co/csukuangfj/${SHERPA_MODEL_DIR_NAME}/resolve/main`
]
/** 模型文件 + 标称大小（校验下载完整性用） */
export const SHERPA_MODEL_FILES = [
  { name: 'model.int8.onnx', bytes: 81828675 },
  { name: 'tokens.txt', bytes: 75352 }
]
export const SHERPA_MODEL_TOTAL_BYTES = SHERPA_MODEL_FILES.reduce((a, f) => a + f.bytes, 0)

/** 服务空闲多久自动回收（常驻约 150MB，用户不玩了就该还回去） */
const IDLE_STOP_MS = 5 * 60 * 1000
/** 服务启动等待上限（模型加载实测 6s，给足余量） */
const START_TIMEOUT_MS = 60000
/** 单次识别超时 */
const RECOGNIZE_TIMEOUT_MS = 25000
/** 服务端能识别的音频上限（秒），超过就拒绝而不是把内存吃爆 */
const MAX_AUDIO_SECONDS = 120

/* ---------------- 路径 ---------------- */

export function sherpaRootDir() {
  return join(app.getPath('userData'), 'voice', 'sherpa')
}
export function sherpaModelDir() {
  return join(sherpaRootDir(), 'model')
}

/** 递归找那个可执行文件（解压出来带版本号目录名，不写死层级） */
export function findServerExe(dir = sherpaRootDir(), depth = 0) {
  if (depth > 4) return ''
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase() === SHERPA_SERVER_EXE) return full
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'model') continue // 模型目录没什么可找的，省一趟遍历
    const hit = findServerExe(join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return ''
}

/** 模型是不是齐了（tokens.txt 很小，只做存在性判断；onnx 要求接近标称大小） */
function modelFilesOk() {
  const dir = sherpaModelDir()
  for (const f of SHERPA_MODEL_FILES) {
    const size = fileSize(join(dir, f.name))
    const min = f.bytes > 1e6 ? f.bytes * 0.9 : 1000
    if (size < min) return false
  }
  return true
}

/**
 * 离线识别现状。
 * @returns {{cliPresent:boolean, modelPresent:boolean, ready:boolean, exe:string, binDir:string, modelDir:string, rootDir:string, error:string}}
 */
export function sherpaStatus() {
  const exe = findServerExe()
  const cliPresent = !!exe
  const modelPresent = modelFilesOk()
  return {
    cliPresent,
    modelPresent,
    ready: cliPresent && modelPresent,
    exe,
    binDir: exe ? dirname(exe) : '',
    modelDir: sherpaModelDir(),
    rootDir: sherpaRootDir(),
    error: !cliPresent
      ? '识别程序未安装'
      : !modelPresent
        ? '离线模型未下载完整'
        : ''
  }
}

/** 当前是否已经拉起服务（设置页/诊断用） */
export function sherpaServerState() {
  return { running: !!(serverProc && serverProc.exitCode === null && serverReady), port: serverPort }
}

/* ---------------- 下载 ---------------- */

// 下载器（curl 优先 / fetch 兜底 / 进度轮询 / 多 URL 回退）在 ../download.js，
// 与 RAG 模型下载共用。这里只留 sherpa 自己的「下什么、下到哪、下完怎么验」。

/**
 * 用 Windows 自带的 bsdtar 解 .tar.bz2（Node 的 zlib 不支持 bz2，不引解压依赖）。
 *
 * ⚠ 必须优先用 System32 的那份：PATH 上（尤其 Git Bash 环境）常常先撞到 MSYS 的 GNU tar，
 * 而 GNU tar 会把 `C:\...` 当成「远程主机:路径」，直接报 `Cannot connect to C: resolve failed`。
 */
function extractTarBz2(archive, destDir, log) {
  const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const candidates = existsSync(systemTar) ? [systemTar, 'tar.exe'] : ['tar.exe']
  const errors = []
  log && log('[voice] 正在解压识别程序…')

  const tryOne = (i) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(candidates[i], ['-xjf', archive, '-C', destDir], { windowsHide: true })
      } catch (err) {
        errors.push(`${candidates[i]}: ${err.message}`)
        resolve({ ok: false, retryable: true })
        return
      }
      let err = ''
      let settled = false
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d) => (err += d))
      child.on('error', (e) => {
        if (settled) return
        settled = true
        errors.push(`${candidates[i]}: ${e.message}`)
        resolve({ ok: false, retryable: true })
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (code === 0) {
          resolve({ ok: true })
          return
        }
        const msg = err.trim().slice(0, 200) || 'tar 退出码 ' + code
        errors.push(`${candidates[i]}: ${msg}`)
        resolve({ ok: false, retryable: i + 1 < candidates.length })
      })
    }).then((r) => {
      if (r.ok) return r
      if (!r.retryable) return r
      if (i + 1 < candidates.length) return tryOne(i + 1)
      return { ok: false, error: errors.join('；') || '解压失败' }
    })

  return tryOne(0)
}

/**
 * 下载并解压 sherpa-onnx 识别程序（约 15MB）。
 * @param {{onProgress?:Function, log?:Function}} [opts]
 */
export async function downloadSherpaCli(opts = {}) {
  const log = opts.log
  const root = sherpaRootDir()
  mkdirSync(root, { recursive: true })
  const archive = join(root, SHERPA_CLI_FILE)

  let lastError = ''
  let got = false
  for (const url of SHERPA_CLI_URLS) {
    const r = await downloadSmart(url, archive, { ...opts, expectBytes: SHERPA_CLI_BYTES })
    if (r.ok) {
      got = true
      log && log(`[voice] 识别程序已下载 ${(r.bytes / 1048576).toFixed(1)}MB（${hostOf(url)}）`)
      break
    }
    lastError = r.error
    log && log(`[voice] 识别程序下载失败（${hostOf(url)}）：${r.error}`)
  }
  if (!got) return { ok: false, error: lastError || '下载失败' }

  // 解压没有中间进度可报（tar.bz2 一次性展开），但这一步实测要 20~30 秒，
  // 不推一条状态的话界面会卡在「100%」像死了（2026-10-16 实测）。
  opts.onProgress?.({ stage: 'extract', received: SHERPA_CLI_BYTES, total: SHERPA_CLI_BYTES })
  const ex = await extractTarBz2(archive, root, log)
  try {
    rmSync(archive, { force: true })
  } catch{ /* B8:degrade — 压缩包删不掉无副作用 */ }
  if (!ex.ok) return { ok: false, error: '解压失败：' + ex.error }

  const st = sherpaStatus()
  if (!st.cliPresent) return { ok: false, error: '解压完成但没找到识别程序，请重试' }
  return { ok: true, dir: root, exe: st.exe }
}

/**
 * 下载中文离线模型（约 78MB）。
 * @param {{onProgress?:Function, log?:Function}} [opts]
 */
export async function downloadSherpaModel(opts = {}) {
  const log = opts.log
  const dir = sherpaModelDir()
  mkdirSync(dir, { recursive: true })

  for (const f of SHERPA_MODEL_FILES) {
    const dest = join(dir, f.name)
    const min = f.bytes > 1e6 ? f.bytes * 0.9 : 1000
    if (fileSize(dest) >= min) {
      log && log(`[voice] ${f.name} 已存在，跳过`)
      continue
    }
    let lastError = ''
    let got = false
    for (const base of SHERPA_MODEL_BASES) {
      const r = await downloadSmart(`${base}/${f.name}`, dest, {
        ...opts,
        expectBytes: f.bytes,
        onProgress: (p) => opts.onProgress?.({ file: f.name, ...p })
      })
      if (r.ok) {
        got = true
        break
      }
      lastError = r.error
    }
    if (!got) {
      try {
        rmSync(dest, { force: true }) // 半截文件别留着，否则下次会误判「已存在」
      } catch{ /* B8:degrade — 半截模型文件删不掉，下次有校验兜住 */ }
      return { ok: false, error: `${f.name} 下载失败：${lastError}` }
    }
  }

  const st = sherpaStatus()
  if (!st.modelPresent) return { ok: false, error: '模型文件不完整，请删掉重下' }
  // 模型刚被（重）写过：%TEMP% 下的 ASCII 硬链接镜像可能已指向旧 inode，作废重来
  try {
    rmSync(asciiMirrorDir(), { recursive: true, force: true })
  } catch{ /* B8:degrade — 镜像目录作废失败，下次会重判 */ }
  return { ok: true, dir }
}

/** 一次把程序 + 模型都备齐 */
export async function downloadSherpa(opts = {}) {
  const cli = await downloadSherpaCli(opts)
  if (!cli.ok) return cli
  const model = await downloadSherpaModel(opts)
  if (!model.ok) return model
  return { ok: true, dir: sherpaRootDir() }
}

/* ---------------- 常驻服务 ---------------- */

/** @type {import('node:child_process').ChildProcess|null} */
let serverProc = null
let serverPort = 0
let serverReady = false
let lastUsedAt = 0
let starting = null
/** 启动过程中被要求停止（退出应用 / 手动停）：别再起下一个方案 */
let stopping = false
let idleTimer = null
let tailLog = []

function pushTail(s) {
  tailLog.push(s)
  if (tailLog.length > 40) tailLog.shift()
}

/** 让系统分配一个空闲端口 */
function findFreePort() {
  return new Promise((resolve) => {
    let srv
    try {
      srv = createServer()
    } catch {
      resolve(0)
      return
    }
    srv.once('error', () => resolve(0))
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address() && srv.address().port
      srv.close(() => resolve(p || 0))
    })
  })
}

/**
 * 轮询直到端口可连 / 子进程退出 / 超时。
 * 为什么要盯子进程退出：服务起不来时旧实现只会干等满整个启动超时（实测每次识别
 * 白白多等 60s 才回退 SAPI）；而「进程已经退出」是确定性失败，应当立即判死，
 * 把余下时间留给下一个启动方案。
 * @returns {Promise<{ok:boolean, reason:'ready'|'exited'|'error'|'timeout'}>}
 */
function waitForPortOrExit(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    // spawn 失败（ENOENT 等）只发 'error' 不发 'exit'，两个都得盯
    child.once('exit', () => done({ ok: false, reason: 'exited' }))
    child.once('error', () => done({ ok: false, reason: 'error' }))
    const attempt = () => {
      if (settled) return
      const sock = createConnection({ host: '127.0.0.1', port })
      let sockDone = false
      const finish = (ok) => {
        if (sockDone) return
        sockDone = true
        try {
          sock.destroy()
        } catch{ /* B8:degrade — socket 已销毁 */ }
        if (settled) return
        if (ok) done({ ok: true, reason: 'ready' })
        else if (Date.now() > deadline) done({ ok: false, reason: 'timeout' })
        else setTimeout(attempt, 150)
      }
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.setTimeout(600, () => finish(false))
    }
    attempt()
  })
}

/** ASCII 镜像目录（%TEMP% 下；模型 80MB，用硬链接不占额外空间） */
function asciiMirrorDir() {
  return join(tmpdir(), 'nagi-sherpa-ascii')
}

/**
 * 把模型文件镜像到纯 ASCII 目录 —— 「cwd + 相对路径」方案也救不了时的兜底
 * （比如将来换个不认相对路径的服务端版本）。
 * 硬链接优先：同卷秒建、与源文件同 inode 不占空间；跨卷/失败退老实复制。
 * @returns {{ok:boolean, dir?:string, error?:string}}
 */
function ensureAsciiModelMirror(modelDir, log) {
  try {
    const dir = asciiMirrorDir()
    mkdirSync(dir, { recursive: true })
    for (const f of SHERPA_MODEL_FILES) {
      const src = join(modelDir, f.name)
      const dest = join(dir, f.name)
      const min = f.bytes > 1e6 ? f.bytes * 0.9 : 1000
      if (fileSize(dest) >= min) continue // 已有可用镜像
      try {
        linkSync(src, dest)
      } catch {
        copyFileSync(src, dest)
      }
      if (fileSize(dest) < min) return { ok: false, error: 'ASCII 镜像文件不完整：' + f.name }
    }
    log && log('[voice] 已准备 ASCII 模型镜像：' + dir)
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, error: 'ASCII 模型镜像失败：' + (err && err.message ? err.message : String(err)) }
  }
}

function ensureIdleTimer(log) {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    if (!serverProc || !serverReady) return
    if (Date.now() - lastUsedAt < IDLE_STOP_MS) return
    log && log('[voice] 离线识别服务空闲超时，回收内存')
    stopSherpaServer()
  }, 60 * 1000)
  idleTimer.unref?.() // 别因为这个定时器把应用吊住
}

async function startServer(log, timeoutMs) {
  const t0 = Date.now()
  const dbg = process.env.NAGI_SHERPA_DEBUG ? (s) => log && log(`[voice][sherpa] +${Date.now() - t0}ms ${s}`) : () => {}
  const st = sherpaStatus()
  if (!st.ready) return { ok: false, error: st.error || '离线识别不可用' }

  stopping = false
  const port = await findFreePort()
  if (!port) return { ok: false, error: '找不到可用端口' }
  dbg('已选端口 ' + port)

  // 启动方案（为什么需要挑，见 core/voice/sherpa-launch.js 与文件顶部注释）：
  //   ① 模型目录含非 ASCII 字符 → cwd=模型目录 + 相对文件名（首选，零成本）；
  //   ② ① 确实起不来 → 才把模型硬链接到 %TEMP% 的 ASCII 目录，用绝对路径重试；
  //   目录本身是 ASCII 时只走原方案（绝对路径 + cwd=binDir），行为与从前一致。
  const plan = sherpaLaunchPlan(st.modelDir, st.binDir)

  let tail = ''
  for (let round = 1; round <= 2; round++) {
    let p
    if (round === 1) {
      p = plan.relative
        ? { label: '相对路径', cwd: plan.cwd, paraformer: 'model.int8.onnx', tokens: 'tokens.txt' }
        : {
            label: '绝对路径',
            cwd: plan.cwd,
            paraformer: join(st.modelDir, 'model.int8.onnx'),
            tokens: join(st.modelDir, 'tokens.txt')
          }
    } else {
      if (!plan.relative) break // ASCII 目录没有兜底方案，一次定胜负
      const mirror = ensureAsciiModelMirror(st.modelDir, log)
      if (!mirror.ok) {
        log && log('[voice] ' + mirror.error)
        break
      }
      p = {
        label: 'ASCII 镜像',
        cwd: st.binDir,
        paraformer: join(mirror.dir, 'model.int8.onnx'),
        tokens: join(mirror.dir, 'tokens.txt')
      }
    }
    if (stopping) return { ok: false, error: '识别服务启动被取消' }
    tailLog = []
    log && log(`[voice] 拉起离线识别服务：端口 ${port}，模型参数走${p.label}`)

    let child
    try {
      child = spawn(
        st.exe,
        [
          `--port=${port}`,
          // 交互场景一次就一句话，批大小为 1 最直接（不会为了攒批而多等）
          '--max-batch-size=1',
          '--num-work-threads=2',
          `--paraformer=${p.paraformer}`,
          `--tokens=${p.tokens}`
        ],
        { cwd: p.cwd || st.binDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      tail = err && err.message ? err.message : String(err)
      continue
    }

    serverProc = child
    serverPort = port
    serverReady = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => { pushTail(l); dbg('[out] ' + l) }))
    child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { pushTail(l); dbg('[err] ' + l) }))
    child.on('error', (err) => {
      pushTail('spawn error: ' + err.message)
      serverReady = false
      if (serverProc === child) serverProc = null
    })
    child.on('exit', (code) => {
      dbg('进程退出 code=' + code)
      serverReady = false
      if (serverProc === child) {
        serverProc = null
        serverPort = 0
      }
    })

    const startedAt = Date.now()
    const r = await waitForPortOrExit(port, timeoutMs, child)
    if (r.ok) {
      serverReady = true
      lastUsedAt = Date.now()
      ensureIdleTimer(log)
      log && log(`[voice] 离线识别服务就绪（端口 ${port}，${p.label}，用时 ${Date.now() - startedAt}ms）`)
      return { ok: true, port }
    }
    tail = tailLog.filter(Boolean).slice(-5).join(' / ')
    dbg(`方案「${p.label}」未就绪（${r.reason}）`)
    // 起不来的方案别留着；端口没被监听过，下一个方案可直接复用
    try {
      child.kill()
    } catch{ /* B8:degrade — 起不来的方案回收失败 */ }
  }
  return { ok: false, error: '识别服务启动失败' + (tail ? '：' + tail : '') }
}

/**
 * 惰性拉起常驻服务，已在跑就直接复用。
 * @param {{log?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
 */
export async function ensureSherpaServer(opts = {}) {
  const log = opts.log
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS
  if (serverProc && serverReady && serverProc.exitCode === null) {
    return { ok: true, port: serverPort }
  }
  if (starting) return starting
  starting = startServer(log, timeoutMs).finally(() => {
    starting = null
  })
  return starting
}

/** 停掉常驻服务（应用退出、切换引擎、空闲回收都会用到） */
export function stopSherpaServer() {
  stopping = true // 正在启动中的流程看到这个标记就别再起下一个方案
  const child = serverProc
  serverProc = null
  serverReady = false
  serverPort = 0
  if (!child) return false
  try {
    child.kill()
  } catch{ /* B8:degrade — 子进程已退出或不存在 */ }
  return true
}

/* ---------------- 识别 ---------------- */

/**
 * 走常驻服务识别一段音频（8 字节头 + float32 样本）。
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
function transcribeOverWs(port, frame, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? RECOGNIZE_TIMEOUT_MS
  const log = opts.log
  return new Promise((resolve) => {
    let ws
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`)
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) })
      return
    }
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch{ /* B8:degrade — ws 已关闭 */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: '识别超时' }), timeoutMs)
    timer.unref?.()

    ws.on('open', () => {
      // 分块发，避免一条超大消息把服务端打挂
      const CHUNK = 256 * 1024
      for (let i = 0; i < frame.length; i += CHUNK) ws.send(frame.subarray(i, i + CHUNK))
    })
    ws.on('message', (d) => {
      const { text } = parseSherpaReply(d.toString())
      log && log(`[voice] 离线识别结果：${text || '(空)'}`)
      try {
        ws.send(SHERPA_DONE)
      } catch{ /* B8:degrade — socket 已关闭 */ }
      finish({ ok: true, text })
    })
    ws.on('error', (err) => finish({ ok: false, error: (err && (err.code || err.message)) || 'ws 错误' }))
    ws.on('close', (code) => finish({ ok: false, error: '识别服务断开了连接（' + code + '）' }))
  })
}

/**
 * 用 sherpa-onnx 离线识别一段 WAV。
 * @param {Buffer|Uint8Array} wavBytes 任意采样率 / 声道数的 16-bit PCM WAV（内部统一成 16k 单声道）
 * @param {{log?:Function}} [opts]
 * @returns {Promise<{ok:boolean, text?:string, engine?:string, error?:string}>}
 */
export async function recognizeWithSherpa(wavBytes, opts = {}) {
  const log = opts.log
  const st = sherpaStatus()
  if (!st.ready) return { ok: false, error: st.error || '离线识别不可用' }

  const asr = toAsrWav(wavBytes, ASR_SAMPLE_RATE)
  if (!asr) return { ok: false, error: '音频数据无法解析（需要 16-bit PCM WAV）' }
  const parsed = extractPcm(asr.bytes)
  if (!parsed || !parsed.pcm.length) return { ok: false, error: '音频数据为空' }

  const seconds = parsed.pcm.length / 2 / (parsed.sampleRate || ASR_SAMPLE_RATE)
  if (seconds > MAX_AUDIO_SECONDS) {
    return { ok: false, error: `录音过长（${seconds.toFixed(0)}s），请分段说话` }
  }

  const samples = pcmToFloat32(parsed.pcm)
  if (!samples.length) return { ok: false, error: '音频数据为空' }

  const srv = await ensureSherpaServer({ log })
  if (!srv.ok) return { ok: false, error: srv.error }
  lastUsedAt = Date.now()

  const r = await transcribeOverWs(srv.port, buildSherpaFrame(samples, parsed.sampleRate || ASR_SAMPLE_RATE), { log })
  if (!r.ok) {
    // 连接层出错通常是服务挂了，标记不可用逼上层重来 / 回退
    log && log('[voice] 离线识别失败：' + r.error)
    if (/断开|ECONN|超时/.test(String(r.error))) stopSherpaServer()
    return { ok: false, error: r.error }
  }
  return { ok: true, text: r.text, engine: 'sherpa' }
}

/* ---------------- 生命周期 ---------------- */

/**
 * 预热：在后台悄悄把服务拉起来，这样用户第一次「按住说话」时不用等模型加载。
 *
 * 为什么需要：实测服务启动（onnxruntime 加载 Paraformer small 模型）要 4.3–4.8s，
 * 而服务一旦就绪，单次识别只要 0.3s 左右。把这 4.5s 从「用户按下的那一刻」挪到
 * 「应用刚启动、用户还没开口」的时候，感知上就是从 4.8s 变成 0.3s。
 * 代价是约 150MB 内存常驻（空闲 5 分钟会自动回收）。
 *
 * @param {{log?:Function, delayMs?:number}} [opts]
 * @returns {Promise<boolean>} 是否已就绪
 */
export async function prewarmSherpa(opts = {}) {
  if (process.env.NAGI_NO_PREWARM === '1') return false
  if (!sherpaStatus().ready) return false
  const delayMs = opts.delayMs ?? 8000
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  const r = await ensureSherpaServer({ log: opts.log })
  if (!r.ok) opts.log && opts.log('[voice] 离线识别预热失败（不影响使用）：' + r.error)
  return r.ok
}

let quitHookInstalled = false
/** 应用退出时顺手把子进程收掉（放在本模块里，免得动 main.js） */
export function installSherpaQuitHook() {
  if (quitHookInstalled) return
  quitHookInstalled = true
  try {
    app.on('will-quit', () => stopSherpaServer())
  } catch{ /* B8:degrade — 非 Electron 环境属预期（单测） */ }
}
installSherpaQuitHook()
