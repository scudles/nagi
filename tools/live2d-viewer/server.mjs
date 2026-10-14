#!/usr/bin/env node
// tools/live2d-viewer/server.mjs
// Live2D 模型预览器 · 本地静态服务（零依赖，仅用 Node 内置模块）
//
// 用法：
//   node tools/live2d-viewer/server.mjs                 # 预览 <nagi>/models，自动打开浏览器
//   node tools/live2d-viewer/server.mjs --root D:/my    # 预览任意模型目录
//   node tools/live2d-viewer/server.mjs --port 9000     # 指定端口
//   node tools/live2d-viewer/server.mjs --no-open       # 不自动开浏览器
//
// 路由：
//   /                    预览页面
//   /viewer.js /style.css
//   /api/models          扫描模型根目录下的 *.model3.json 列表
//   /models/<相对路径>    模型资源（moc3 / 贴图 / json …）
//   /vendor/<lib>        Cubism Core + pixi + pixi-live2d-display（复用工程 node_modules）

import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep, extname, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NAGI_ROOT = resolve(__dirname, '..', '..')

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', process.env.PORT || 8787))
const MODEL_ROOT = resolve(argOf('--root', join(NAGI_ROOT, 'models')))
const AUTO_OPEN = !argv.includes('--no-open')

/* ---------------- 静态资源映射 ---------------- */
const VIEWER_DIR = __dirname
const VENDOR = {
  '/vendor/live2dcubismcore.min.js': join(NAGI_ROOT, 'src/renderer/public/vendor/live2dcubismcore.min.js'),
  '/vendor/pixi.min.js': join(NAGI_ROOT, 'node_modules/pixi.js/dist/pixi.min.js'),
  '/vendor/cubism4.min.js': join(NAGI_ROOT, 'node_modules/pixi-live2d-display/dist/cubism4.min.js')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}
const mimeOf = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream'

/* ---------------- 工具 ---------------- */
/** 把 root 内的相对路径解析成绝对路径；越界返回 null（防目录穿越） */
function safeJoin(root, rel) {
  const p = resolve(root, rel)
  return p === root || p.startsWith(root + sep) ? p : null
}

/** 递归扫描 *.model3.json（深度 ≤ 4，跳过隐藏目录与 node_modules） */
function scanModels(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const name = ent.name
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = join(dir, name)
    if (ent.isDirectory()) scanModels(full, depth + 1, out)
    else if (name.toLowerCase().endsWith('.model3.json')) {
      out.push(relative(MODEL_ROOT, full).split(sep).join('/'))
    }
  }
  return out
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJson(res, data, code = 200) {
  send(res, code, JSON.stringify(data), { 'Content-Type': MIME['.json'] })
}

/** 带 Last-Modified / 304 与 Content-Type 的文件响应 */
function sendFile(req, res, file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return send(res, 404, 'Not Found')
  }
  if (!st.isFile()) return send(res, 404, 'Not Found')

  const lastMod = st.mtime.toUTCString()
  if (req.headers['if-modified-since'] === lastMod) {
    res.writeHead(304, { 'Last-Modified': lastMod })
    return res.end()
  }
  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Content-Length': st.size,
    'Last-Modified': lastMod,
    // 模型贴图较大：允许缓存，加快刷新/切模型
    'Cache-Control': /\.(png|jpg|jpeg|webp|moc3)$/i.test(file) ? 'public, max-age=300' : 'no-cache'
  })
  createReadStream(file).pipe(res)
}

/* ---------------- 服务 ---------------- */
const server = createServer(async (req, res) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    return send(res, 400, 'Bad Request')
  }

  // 预览页与自身资源
  if (pathname === '/' || pathname === '/index.html') return sendFile(req, res, join(VIEWER_DIR, 'index.html'))
  if (pathname === '/viewer.js') return sendFile(req, res, join(VIEWER_DIR, 'viewer.js'))
  if (pathname === '/style.css') return sendFile(req, res, join(VIEWER_DIR, 'style.css'))
  if (pathname === '/favicon.ico') return send(res, 204, '')

  // 运行库
  if (VENDOR[pathname]) {
    if (!existsSync(VENDOR[pathname])) {
      return send(res, 500, `缺少运行库：${VENDOR[pathname]}\n（在工程根目录执行 npm install / npm run postinstall 可补齐）`, {
        'Content-Type': 'text/plain; charset=utf-8'
      })
    }
    return sendFile(req, res, VENDOR[pathname])
  }

  // 模型清单
  if (pathname === '/api/models') {
    const models = scanModels(MODEL_ROOT).sort()
    return sendJson(res, { root: MODEL_ROOT, models })
  }

  // 模型资源
  if (pathname.startsWith('/models/')) {
    const rel = pathname.slice('/models/'.length)
    const file = safeJoin(MODEL_ROOT, rel)
    if (!file) return send(res, 403, 'Forbidden')
    return sendFile(req, res, file)
  }

  send(res, 404, 'Not Found')
})

/* ---------------- 启动（端口占用自动 +1 重试） ---------------- */
function listen(port, tries = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries > 0) {
      console.log(`端口 ${port} 被占用，换 ${port + 1} 试试…`)
      listen(port + 1, tries - 1)
    } else {
      console.error('启动失败：', err.message)
      process.exit(1)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    const models = scanModels(MODEL_ROOT)
    console.log('')
    console.log('  🎭  Live2D 模型预览器')
    console.log('  ────────────────────────────────')
    console.log(`  地址      ${url}`)
    console.log(`  模型目录  ${MODEL_ROOT}`)
    console.log(`  已发现    ${models.length} 个模型${models.length ? '：' + models.join('、') : ''}`)
    console.log('  ────────────────────────────────')
    console.log('  滚轮缩放 · 拖动平移 · 点击模型触发动作 · Ctrl+C 退出')
    console.log('')
    if (!models.length) {
      console.log('  ⚠ 该目录下没有 *.model3.json，可用 --root 指向其他模型目录')
      console.log('')
    }
    if (AUTO_OPEN) openBrowser(url)
  })
}

function openBrowser(url) {
  try {
    const opt = { stdio: 'ignore', detached: true }
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opt).unref()
    else if (process.platform === 'darwin') spawn('open', [url], opt).unref()
    else spawn('xdg-open', [url], opt).unref()
  } catch {
    /* 打不开就手动点链接 */
  }
}

listen(PORT)
