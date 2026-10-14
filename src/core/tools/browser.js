// src/core/tools/browser.js
// 浏览器工具（Playwright）：优先 CDP 接管用户日常 Chrome，失败回退托管的独立浏览器。
//
// 两种模式：
//   1) cdp：需要用户以 --remote-debugging-port=<port> 启动 Chrome（README 有命令）。
//   2) managed：Playwright 自带浏览器（首次使用需 `npx playwright install chromium`），
//      登录态持久化在 userDataDir。

import { join } from 'node:path'

const NAV_TIMEOUT = 30000

async function importPlaywright() {
  try {
    return await import('playwright')
  } catch (err) {
    throw new Error('Playwright 未安装：' + err.message)
  }
}

/**
 * @param {{cdpPort?:number, browserMode?:'cdp'|'managed', userDataDir?:string}} cfg
 */
export function createBrowserTools(cfg = {}) {
  const cdpPort = Number(cfg.cdpPort) || 9222
  const preferCdp = cfg.browserMode !== 'managed'

  let pw = null
  let conn = null // Browser(CDP) 或 BrowserContext(managed)
  let connKind = null
  let page = null
  let starting = null

  function attachPageEvents() {
    if (!page) return
    page.on('crash', () => {
      page = null
    })
    page.on('close', () => {
      if (page) page = null
    })
  }

  async function ensure() {
    if (conn && page && !page.isClosed?.()) return { conn, page }
    if (starting) return starting

    starting = (async () => {
      if (!pw) pw = await importPlaywright()

      // 1) CDP 接管
      if (preferCdp) {
        try {
          const browser = await pw.chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 4000 })
          const ctx = browser.contexts()[0] || (await browser.newContext())
          conn = browser
          connKind = 'cdp'
          page = ctx.pages().at(-1) || (await ctx.newPage())
          attachPageEvents()
          return { conn, page }
        } catch (e) {
          // 回退托管
        }
      }

      // 2) 托管模式
      try {
        const ctx = await pw.chromium.launchPersistentContext(cfg.userDataDir || join(process.cwd(), '.pw-profile'), {
          headless: true,
          viewport: { width: 1280, height: 800 },
          args: ['--disable-blink-features=AutomationControlled']
        })
        conn = ctx
        connKind = 'managed'
        page = ctx.pages()[0] || (await ctx.newPage())
        attachPageEvents()
        return { conn, page }
      } catch (e) {
        const msg = String(e.message || e)
        if (/Executable doesn't exist|install chromium/i.test(msg)) {
          throw new Error('托管浏览器未安装：请运行 `npx playwright install chromium`；或改用 CDP 接管（以 --remote-debugging-port=' + cdpPort + ' 启动 Chrome）')
        }
        throw new Error('浏览器连接失败：' + msg)
      } finally {
        starting = null
      }
    })()

    return starting
  }

  async function goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
  }

  return {
    /** 当前连接方式（调试/日志用） */
    kind: () => connKind,

    /** browser_open {url, newTab?} */
    async open(args) {
      const url = String(args.url || '').trim()
      if (!url) return { ok: false, summary: '缺少 url 参数' }
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`
      const { page: p } = await ensure()
      let target = p
      if (args.newTab || p.isClosed?.()) {
        target = await p.context().newPage()
        page = target
        attachPageEvents()
      }
      await goto(target, full)
      const title = await target.title().catch(() => '')
      return { ok: true, summary: `已打开 ${full}（${title || '无标题'}）`, data: { url: target.url(), title } }
    },

    /** browser_act {action, selector?, value?, key?, url?} */
    async act(args) {
      const action = String(args.action || '').toLowerCase()
      const { page: p } = await ensure()
      const t0 = Date.now()
      switch (action) {
        case 'goto': {
          const url = String(args.url || args.value || '')
          if (!url) return { ok: false, summary: 'goto 需要 url' }
          await goto(p, /^https?:\/\//i.test(url) ? url : `https://${url}`)
          return { ok: true, summary: `已导航到 ${p.url()}`, ms: Date.now() - t0 }
        }
        case 'click': {
          if (!args.selector) return { ok: false, summary: 'click 需要 selector' }
          await p.click(args.selector, { timeout: 10000 })
          return { ok: true, summary: `已点击 ${args.selector}`, ms: Date.now() - t0 }
        }
        case 'fill':
        case 'type': {
          if (!args.selector || args.value == null) return { ok: false, summary: 'fill/type 需要 selector 和 value' }
          await p.fill(args.selector, String(args.value), { timeout: 10000 })
          return { ok: true, summary: `已在 ${args.selector} 填入内容`, ms: Date.now() - t0 }
        }
        case 'press': {
          if (!args.key) return { ok: false, summary: 'press 需要 key（如 Enter）' }
          if (args.selector) await p.click(args.selector, { timeout: 5000 }).catch(() => {})
          await p.keyboard.press(args.key)
          return { ok: true, summary: `已按键 ${args.key}`, ms: Date.now() - t0 }
        }
        case 'scroll': {
          const dy = Number(args.value) || 600
          await p.mouse.wheel(0, dy)
          return { ok: true, summary: `已滚动 ${dy}px`, ms: Date.now() - t0 }
        }
        case 'back':
          await p.goBack({ timeout: NAV_TIMEOUT }).catch(() => {})
          return { ok: true, summary: `已后退到 ${p.url()}`, ms: Date.now() - t0 }
        case 'select': {
          if (!args.selector || args.value == null) return { ok: false, summary: 'select 需要 selector 和 value' }
          await p.selectOption(args.selector, String(args.value), { timeout: 10000 })
          return { ok: true, summary: `已选择 ${args.value}`, ms: Date.now() - t0 }
        }
        case 'wait': {
          const ms = Math.min(Math.max(Number(args.value) || 1000, 100), 15000)
          await p.waitForTimeout(ms)
          return { ok: true, summary: `等待 ${ms}ms`, ms: Date.now() - t0 }
        }
        default:
          return { ok: false, summary: `未知 action：${action}（可选 goto/click/fill/press/scroll/back/select/wait）` }
      }
    },

    /** browser_scrape {url?, selector?, maxChars?} */
    async scrape(args) {
      const { page: p } = await ensure()
      if (args.url) await goto(p, /^https?:\/\//i.test(args.url) ? args.url : `https://${args.url}`)
      const scope = args.selector ? p.locator(args.selector).first() : p.locator('body')
      const text = await scope.innerText({ timeout: 15000 }).catch(() => '')
      const maxChars = Math.min(Math.max(Number(args.maxChars) || 4000, 500), 12000)
      const links = await p
        .$$eval('a[href]', (as) =>
          as.slice(0, 40).map((a) => ({ text: (a.innerText || '').trim().slice(0, 60), href: a.href }))
        )
        .catch(() => [])
      const title = await p.title().catch(() => '')
      const clipped = text.slice(0, maxChars)
      return {
        ok: Boolean(clipped),
        summary: clipped
          ? `${p.url()}（${title}）正文前 ${clipped.length} 字：\n${clipped}`
          : '页面无可提取正文（可能需要等待加载或指定 selector）',
        data: { url: p.url(), title, text: clipped, links },
        ms: 0
      }
    },

    /** 退出时清理 */
    async dispose() {
      try {
        if (connKind === 'cdp' && conn) await conn.close() // 断开连接，不关用户的浏览器
        else if (conn) await conn.close() // 托管浏览器一并关闭
      } catch {
        /* ignore */
      }
      conn = null
      connKind = null
      page = null
    }
  }
}
