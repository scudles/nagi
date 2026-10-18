// src/main/download.js
// 通用单文件下载器：curl 优先（认系统 http_proxy）+ fetch 兜底，多 URL 回退，
// 轮询目标文件大小报进度。从 voice/sherpa.js 抽出——RAG 模型下载（hf-mirror 双源）
// 是同款链路，两边共用，不再各写一遍。
//
// 两个本机实测的坑（2026-10-15，勿改回去）：
//   ① Windows 上必须先试 curl.exe：undici 的 fetch 不读 http_proxy 环境变量，
//      直连被墙时会「连上但不来数据」，15MB 拖 8 分钟；curl 认系统代理，MB/s 级。
//      且 curl 要加 --retry-all-errors——默认不重试 18/56 这类传输中断。
//   ② 下载前 rmSync 清掉半截文件：否则上一次的残骸会被当成续传起点。

import { spawn } from 'node:child_process'
import { rmSync, statSync, writeFileSync } from 'node:fs'

const isWindows = process.platform === 'win32'

/** 文件大小（不存在/读不到 → 0） */
export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** URL 的 host（日志用；解析不了就原样返回） */
export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 轮询目标文件大小报进度（下载器无关，curl / fetch 都适用） */
export function watchProgress(destPath, onProgress, expectBytes) {
  if (!onProgress) return () => {}
  const total = expectBytes || 0
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    const received = fileSize(destPath)
    if (received > 0) onProgress({ received, total })
  }, 500)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * 单文件下载。多路兜底：
 *   ① Windows 上先试 curl.exe —— 认系统 http_proxy，自带重试与断点续传；
 *   ② 再试 fetch —— 没有 curl 的环境（老 Windows / 非 Windows）。
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string}>}
 */
export async function downloadSmart(url, destPath, opts = {}) {
  const order = isWindows ? [downloadWithCurl, downloadWithFetch] : [downloadWithFetch, downloadWithCurl]
  let lastError = ''
  for (const fn of order) {
    try {
      rmSync(destPath, { force: true })
    } catch{ /* B8:degrade — 目标文件删不掉，稍后的写入会覆盖 */ }
    const stop = watchProgress(destPath, opts.onProgress, opts.expectBytes)
    let r
    try {
      r = await fn(url, destPath, opts)
    } finally {
      stop()
    }
    if (r.ok) {
      // 收尾报一次最终进度，免得 UI 停在 99%
      opts.onProgress?.({ received: r.bytes, total: opts.expectBytes || r.bytes })
      return r
    }
    lastError = r.error
    opts.log && opts.log(`[download] ${fn.downloaderName} 失败（${hostOf(url)}）：${r.error}`)
  }
  return { ok: false, error: lastError || '下载失败' }
}

async function downloadWithFetch(url, destPath, opts = {}) {
  const { onProgress, timeoutMs = 15 * 60 * 1000, stallMs = 45000 } = opts
  void onProgress
  const ctrl = new AbortController()
  let stallTimer = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    // 直连被墙时 fetch 会「连上但不来数据」，光有总超时会白等十几分钟
    stallTimer = setTimeout(() => ctrl.abort(new Error('下载停滞')), stallMs)
    stallTimer.unref?.()
  }
  const timer = setTimeout(() => ctrl.abort(new Error('下载超时')), timeoutMs)
  timer.unref?.()
  let received = 0
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const total = Number(res.headers.get('content-length')) || opts.expectBytes || 0
    const parts = []
    armStall()
    if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of res.body) {
        parts.push(Buffer.from(chunk))
        received += chunk.length
        armStall()
        onProgress?.({ received, total })
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      parts.push(buf)
      received = buf.length
      onProgress?.({ received, total })
    }
    const buf = Buffer.concat(parts)
    if (!buf.length) return { ok: false, error: '下载结果为空' }
    writeFileSync(destPath, buf)
    return { ok: true, bytes: buf.length }
  } catch (err) {
    const reason = ctrl.signal.reason
    const msg = reason && reason.message ? reason.message : err && err.message ? err.message : String(err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
    if (stallTimer) clearTimeout(stallTimer)
  }
}
downloadWithFetch.downloaderName = 'fetch'

function downloadWithCurl(url, destPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'curl.exe',
        [
          '-L', // 跟随重定向
          '--fail', // 4xx/5xx 直接失败，别把错误页当文件
          '--retry', '3',
          '--retry-all-errors', // 默认不重试 18/56 这类传输中断，加上这行才真的重试
          '--retry-delay', '2',
          '--connect-timeout', '20',
          '-s',
          '-o', destPath,
          url
        ],
        { windowsHide: true }
      )
    } catch (err) {
      resolve({ ok: false, error: err.message })
      return
    }
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch{ /* B8:degrade — 子进程已退出或不存在 */ }
      resolve({ ok: false, error: '下载超时' })
    }, timeoutMs)
    timer.unref?.()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: 'curl 不可用：' + e.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, error: err.trim().slice(0, 200) || 'curl 退出码 ' + code })
        return
      }
      const bytes = fileSize(destPath)
      resolve(bytes > 0 ? { ok: true, bytes } : { ok: false, error: '下载结果为空' })
    })
  })
}
downloadWithCurl.downloaderName = 'curl'
