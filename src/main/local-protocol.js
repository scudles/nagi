// src/main/local-protocol.js
// 自定义特权协议 nagi-local:// ，用于加载 Live2D 模型目录下的文件。
// 模型体积大、且内部常见相对路径引用（贴图/动作/物理），用 http/file 都容易踩坑，
// 注册成标准特权协议最稳，模型内相对路径能自然解析。

import { app, protocol, net } from 'electron'
import { join, normalize, sep, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SCHEME = 'nagi-local'
export const ROOT_HOST = 'models'

const MIME = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.motion3': 'application/octet-stream',
  '.exp3': 'application/octet-stream',
  '.physics3': 'application/octet-stream',
  '.cdi3': 'application/octet-stream',
  '.pose3': 'application/octet-stream'
}

/** 必须在 app ready 之前调用 */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        byob: true,
        bypassCSP: false,
        corsEnabled: true
      }
    }
  ])
}

/** app ready 之后调用；modelsDir 为模型根目录的绝对路径 */
export function registerHandler(modelsDir) {
  const base = normalize(modelsDir)
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // nagi-local://models/<相对路径>
      if (url.hostname && url.hostname !== ROOT_HOST) {
        return new Response('Unknown host', { status: 404 })
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = normalize(join(base, rel))
      if (target !== base && !target.startsWith(base + sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(target)) {
        return new Response('Not found: ' + rel, { status: 404 })
      }
      const res = await net.fetch(pathToFileURL(target).toString())
      const type = MIME[extname(target).toLowerCase()]
      if (type) {
        const headers = new Headers(res.headers)
        headers.set('Content-Type', type)
        return new Response(res.body, { status: res.status, headers })
      }
      return res
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 })
    }
  })
}
