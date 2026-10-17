// FIX-3 复现/回归：Playwright 生命周期 —— starting 状态清理。
//
// 病灶（源码可见，2026-10-17 复现）：
//   ensure() 里 `starting = null` 的 finally 只挂在内层「托管模式」try 上。
//   CDP 接管成功分支直接 `return { conn, page }`，整个 async IIFE 就此结束，
//   finally 不在该执行路径上 → starting 永远停留一个**已 fulfilled 的旧 Promise**。
//   后果：page 崩溃/关闭后，ensure() 的 `if (starting) return starting` 会把
//   调用方引向旧 Promise 里的死 page（工具在失效页面上操作）；dispose 同样
//   没清 starting，退出后仍能拿到已释放的连接。
//
// 本文件先红后绿：修复前第 1、3 条必挂，修复（finally 提升到最外层 + dispose 清理）后转绿。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let connectCount = 0
let launchCount = 0
let fakePage = null

function makeFakePage() {
  const handlers = {}
  const p = {
    _closed: false,
    _url: 'about:blank',
    isClosed: () => p._closed,
    on: (ev, cb) => { (handlers[ev] ||= []).push(cb) },
    _emit: (ev) => (handlers[ev] || []).forEach((cb) => cb()),
    context: () => ctx,
    goto: async (url) => {
      if (p._closed) throw new Error('Target page, context or browser has been closed')
      p._url = url
    },
    title: async () => 'fake-title',
    url: () => p._url
  }
  return p
}

const ctx = {
  pages: () => [fakePage],
  newPage: async () => fakePage
}

mock.module('playwright', { exports: { chromium: {
  connectOverCDP: async () => {
    connectCount++
    fakePage = makeFakePage()
    return { contexts: () => [ctx], close: async () => {} }
  },
  launchPersistentContext: async () => {
    launchCount++
    fakePage = makeFakePage()
    const managed = { pages: () => [fakePage], newPage: async () => fakePage, close: async () => {} }
    return managed
  }
} } })

const { createBrowserTools } = await import('../src/core/tools/browser.js')

function reset() {
  connectCount = 0
  launchCount = 0
}

test('CDP 接管成功后 page 崩溃：必须重新连接，不得复用旧 starting 里的死 page', async () => {
  reset()
  const tools = createBrowserTools({ browserMode: 'cdp', cdpPort: 9222 })
  await tools.open({ url: 'https://example.com' })
  assert.equal(connectCount, 1, '首次应走 CDP 接管')

  // 模拟 page 崩溃：close 事件 → attachPageEvents 把 page 置 null
  fakePage._closed = true
  fakePage._emit('close')

  const r = await tools.act({ action: 'goto', url: 'https://example.org' })
  assert.equal(connectCount, 2, 'page 失效后应重新连接；仍是 1 说明拿到了旧 Promise 的死 page（FIX-3）')
  assert.equal(r.ok, true, r.summary)
})

test('托管模式：成功路径本来就清理 starting（对照，防回归）', async () => {
  reset()
  const tools = createBrowserTools({ browserMode: 'managed' })
  await tools.open({ url: 'https://example.com' })
  assert.equal(launchCount, 1)
  assert.equal(connectCount, 0, 'managed 模式不应走 CDP')

  fakePage._closed = true
  fakePage._emit('close')
  const r = await tools.act({ action: 'goto', url: 'https://example.org' })
  assert.equal(launchCount, 2, '托管路径 page 失效后应重新 launch')
  assert.equal(r.ok, true, r.summary)
})

test('dispose 之后 starting 必须清空：不得再拿到已释放的连接', async () => {
  reset()
  const tools = createBrowserTools({ browserMode: 'cdp', cdpPort: 9222 })
  await tools.open({ url: 'https://example.com' })
  await tools.dispose()
  assert.equal(connectCount, 1)

  // dispose 后页面失效，再操作：应重新建立连接（connect 2 次），
  // 而不是返回 dispose 前那个已 close 的连接
  fakePage._closed = true
  fakePage._emit('close')
  const r = await tools.act({ action: 'goto', url: 'https://example.org' })
  assert.equal(connectCount, 2, 'dispose 后仍复用旧连接（FIX-3）')
  assert.equal(r.ok, true, r.summary)
})
