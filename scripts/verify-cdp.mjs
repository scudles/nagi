// scripts/verify-cdp.mjs
// Chrome/Edge CDP 接管验证：直接调用生产代码 src/core/tools/browser.js，
// 而不另写一套 Playwright 调用——验证的就是 ship 出去的那条链路。
//
// 前置：已有一个 Chromium 内核浏览器以 --remote-debugging-port=<port> 启动。
// 用法：node scripts/verify-cdp.mjs
//   环境变量：CDP_PORT（默认 9222）、CDP_TEST_URL（默认 http://localhost:8765/）

import { createBrowserTools } from '../src/core/tools/browser.js'

const port = Number(process.env.CDP_PORT) || 9222
const testUrl = process.env.CDP_TEST_URL || 'http://localhost:8765/'

const tools = createBrowserTools({ browserMode: 'cdp', cdpPort: port })
const log = []

try {
  const open = await tools.open({ url: testUrl })
  log.push(['连接方式', tools.kind()])
  log.push(['browser_open', JSON.stringify(open)])

  const scrape = await tools.scrape({ maxChars: 300 })
  const title = scrape?.data?.title || ''
  const text = scrape?.data?.text || ''
  log.push(['browser_scrape.ok', String(scrape.ok)])
  log.push(['页面标题', title])
  log.push(['正文首段', text.slice(0, 120).replace(/\s+/g, ' ')])

  // browser_act：填表 + 点击，再读回结果（验证交互动作链路）
  await tools.act({ action: 'fill', selector: '#name', value: '凪' })
  await tools.act({ action: 'click', selector: '#go' })
  const after = await tools.scrape({ selector: '#out' })
  const actText = (after?.data?.text || '').trim()
  log.push(['browser_act 结果', actText])
  const actOk = actText.includes('你好，凪')

  const pass =
    tools.kind() === 'cdp' &&
    Boolean(scrape.ok) &&
    title.includes('CDP') &&
    text.includes('DevTools Protocol') &&
    actOk

  console.log('\n=== CDP 接管验证 ===')
  for (const [k, v] of log) console.log(`  ${k}: ${v}`)
  console.log(`\n结果: ${pass ? 'PASS ✅ 走的是 CDP 接管通道' : 'FAIL ❌'}`)
  process.exitCode = pass ? 0 : 1
} catch (err) {
  console.log('\n=== CDP 接管验证 ===')
  for (const [k, v] of log) console.log(`  ${k}: ${v}`)
  console.log(`\n结果: FAIL ❌ ${err.message}`)
  process.exitCode = 1
} finally {
  await tools.dispose()
}
