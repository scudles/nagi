// scripts/verify-ui.mjs
// 端到端 UI 验证：用 Playwright 通过 CDP 接管运行中的凪（渲染层是真进程，不是 mock），验证
//   1) 桌宠 Live2D 模型与动作组加载
//   2) 戳一戳（原地按下+松手）→ 主进程 pet:event 广播
//   3) 拖动窗口（按下→移动→松手）→ 窗口真的位移
//   4) 工作台凪面板与动作清单渲染
//
// 用法（凪必须已带调试端口启动）：
//   start-pet.bat 之后另开一个终端：
//   node_modules\electron\dist\electron.exe --remote-debugging-port=9222 .
//   然后：EXPECT=pet  node scripts/verify-ui.mjs
//        EXPECT=workbench node scripts/verify-ui.mjs
//
// 注意：connectOverCDP 下**不要**调 browser.close()，它会真的把 Electron 关掉。
import { chromium } from 'playwright'

const PORT = Number(process.env.CDP_PORT || 9222)
const OUT_PREFIX = process.env.OUT_PREFIX || 'shot'

async function waitEndpoint(ms = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

if (!(await waitEndpoint())) {
  console.log('✘ CDP 未就绪')
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const pages = ctx.pages()
console.log('页面：', pages.map((p) => p.url()))

const pet = pages.find((p) => p.url().includes('mode=pet'))
const wb = pages.find((p) => p.url().includes('mode=workbench'))
if (!pet) {
  console.log('✘ 没找到 pet 页面')
  process.exit(1)
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

// ---- 1. 等模型加载完（占位符隐藏） ----
try {
  await pet.waitForFunction(
    () => document.getElementById('pet-placeholder')?.classList.contains('hidden'),
    { timeout: 40000 }
  )
  const info = await pet.evaluate(() => ({
    exprs: window.__nagiMotionCatalog ? Object.keys(window.__nagiMotionCatalog()).length : -1,
    canvas: !!document.getElementById('live2d-canvas')
  }))
  check('桌宠模型加载', true, `动作组 ${info.exprs} 个`)
} catch (err) {
  check('桌宠模型加载', false, err.message)
}

// ---- 2. 戳一戳：原地按下+松手 → 主进程应广播 pet:event ----
// 直接监听 PET 广播，比看气泡文字稳（气泡可能正被"思考中"占位）
await pet.evaluate(() => {
  window.__pokeSeen = 0
  window.__pokeText = ''
  window.nagi.on('pet:event', (p) => {
    window.__pokeSeen++
    window.__pokeText = (p && p.text) || ''
  })
})
await pet.evaluate(() => {
  const el = document.getElementById('pet-root')
  const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1, clientX: 200, clientY: 420, screenX: 900, screenY: 700 }))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0, clientX: 200, clientY: 420, screenX: 900, screenY: 700 }))
})
await pet.waitForTimeout(1500)
const poke = await pet.evaluate(() => ({ n: window.__pokeSeen, text: window.__pokeText }))
check('戳一戳 → pet:event 广播', poke.n >= 1 && !!poke.text, `收到 ${poke.n} 次，「${poke.text}」`)

// ---- 3. 拖动窗口：按下 → 移动 (+60,+30) → 松手 ----
const posBefore = await pet.evaluate(() => ({ x: window.screenX, y: window.screenY }))
await pet.evaluate(() => {
  const el = document.getElementById('pet-root')
  const base = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1, clientX: 200, clientY: 420, screenX: 900, screenY: 700 }))
  el.dispatchEvent(new PointerEvent('pointermove', { ...base, button: 0, buttons: 1, clientX: 260, clientY: 450, screenX: 960, screenY: 730 }))
})
await pet.waitForTimeout(700)
const posMid = await pet.evaluate(() => ({ x: window.screenX, y: window.screenY }))
await pet.evaluate(() => {
  const el = document.getElementById('pet-root')
  const base = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0, clientX: 260, clientY: 450, screenX: 960, screenY: 730 }))
})
const ddx = posMid.x - posBefore.x
const ddy = posMid.y - posBefore.y
check('拖动窗口位移', Math.abs(ddx - 60) <= 3 && Math.abs(ddy - 30) <= 3, `实际 Δ=(${ddx},${ddy})，期望 (60,30)`)

// ---- 4. 页面级截图（无窗口阴影） ----
if (process.env.EXPECT !== 'workbench') {
  await pet.screenshot({ path: `${OUT_PREFIX}-pet.png` })
  console.log(`已保存 ${OUT_PREFIX}-pet.png`)
}
if (wb && process.env.EXPECT === 'workbench') {
  await wb.screenshot({ path: `${OUT_PREFIX}-workbench.png` })
  console.log(`已保存 ${OUT_PREFIX}-workbench.png`)
  // 工作台：面板与动作清单是否渲染到位
  const panel = await wb.evaluate(() => {
    const p = document.getElementById('nagi-panel')
    const list = document.getElementById('wb-motion-list')
    return {
      panel: !!p && p.getBoundingClientRect().width > 100,
      groups: list ? list.querySelectorAll('.np-group').length : -1,
      buttons: list ? list.querySelectorAll('button').length : -1,
      collapsed: p?.classList.contains('collapsed')
    }
  })
  check('工作台凪面板', panel.panel && panel.groups >= 1, `动作组 ${panel.groups}，按钮 ${panel.buttons}，折叠=${panel.collapsed}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
// 注意：不要调 browser.close()——connectOverCDP 下它会真的关掉 Electron。
process.exit(failed.length ? 2 : 0)
