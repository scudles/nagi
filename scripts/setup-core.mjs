// scripts/setup-core.mjs
// postinstall：下载 Live2D Cubism Core（不能通过 npm 安装，必须手动引入）
// 目标：src/renderer/vendor/live2dcubismcore.min.js
// 失败不抛出（避免打断 npm install），而是打印手动下载指引。

import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
const DEST = resolve(ROOT, 'src/renderer/public/vendor/live2dcubismcore.min.js')
// 体积参考值：约 200KB。太小视为占位/错误页。
const MIN_BYTES = 50 * 1024

async function exists(p) {
  try {
    const s = await stat(p)
    return s.size > 0
  } catch {
    return false
  }
}

function download(url, dest) {
  return new Promise((resolvePromise, reject) => {
    const tmp = dest + '.download'
    const file = createWriteStream(tmp)
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          unlink(tmp).catch(() => {})
          download(res.headers.location, dest).then(resolvePromise, reject)
          return
        }
        if (res.statusCode !== 200) {
          file.close()
          unlink(tmp).catch(() => {})
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(async () => {
          const s = await stat(tmp).catch(() => null)
          if (!s || s.size < MIN_BYTES) {
            await unlink(tmp).catch(() => {})
            reject(new Error(`下载内容异常（仅 ${s ? s.size : 0} 字节）`))
            return
          }
          await rename(tmp, dest)
          resolvePromise(s.size)
        }))
      })
      .on('error', (err) => {
        file.close()
        unlink(tmp).catch(() => {})
        reject(err)
      })
  })
}

function manualHint() {
  console.log('')
  console.log('⚠️  Cubism Core 自动下载失败，请手动处理：')
  console.log(`   1. 浏览器打开：${CORE_URL}`)
  console.log(`   2. 另存为：${DEST}`)
  console.log('   （该文件约 200KB，是 Live2D 官方 SDK，不可用 npm 安装）')
  console.log('')
}

async function main() {
  await mkdir(dirname(DEST), { recursive: true })
  if (await exists(DEST)) {
    console.log('[setup-core] Cubism Core 已存在，跳过下载。')
    return
  }
  try {
    console.log('[setup-core] 正在下载 Live2D Cubism Core ...')
    const size = await download(CORE_URL, DEST)
    console.log(`[setup-core] 完成：${DEST}（${(size / 1024).toFixed(0)} KB）`)
  } catch (err) {
    console.log(`[setup-core] 下载失败：${err.message}`)
    manualHint()
  }
}

main().catch((err) => {
  // 无论如何不让 postinstall 失败
  console.log(`[setup-core] 发生异常：${err && err.message}`)
  manualHint()
})
