// scripts/verify-settings-nav.mjs
// 设置页二级菜单的真机验收（真实 Electron + 生产渲染层）。
//
// 验的是「看起来对了」背后那几件容易假通过的事：
//   A. 六组导航都渲染出来了，且**同时只有一组可见**（切组没变成全部堆叠）
//   B. 点导航真的切过去了（class 切换没绑错）
//   C. 「高级」区默认全部收起 —— 折叠没生效就等于没精简
//   D. 折叠区里的控件仍然可取到（别把控件折没了，JS 取值会变 undefined）
//   E. 布局不塌：导航与内容区不重叠、内容区有可用宽度
//   F. 点开高级区能真的展开
//   G. 控制台干净
//
// 用法：node scripts/verify-settings-nav.mjs [--shot=路径]
// 注意：**不要** browser.close() —— connectOverCDP 下那会把凪真的关掉。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.env.CDP_PORT || '9372'
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1] || ''

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NAGI_RENDERER_SANDBOX = '0'
const dir = mkdtempSync(join(tmpdir(), 'nagi-setnav-'))
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify(
    { privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true }, live2d: { frame: 'bust', petWidth: 400, petHeight: 600 } },
    null,
    2
  ),
  'utf8'
)

const child = spawn(ELECTRON, ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
})
// 收集日志：出了问题时第一条要看的就是 Electron 自己说了什么，
// 否则只能看到「waitForFunction 超时」这种没用的表象。
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

const visibleGroups = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.sp-group'))
      .filter((s) => s.offsetParent !== null)
      .map((s) => s.dataset.group)
  )

let browser
try {
  // Electron 冷启动要几秒，CDP 端口不是立刻可用的 —— 必须轮询，不能连一次就放弃
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    } catch {
      await sleep(500)
    }
  }
  if (!browser) throw new Error('CDP 连不上（Electron 没起来？）')
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    const ctx = browser.contexts()[0]
    if (ctx && ctx.pages().length) page = ctx.pages()[0]
  }
  if (!page) throw new Error('没拿到页面（Electron 没起来？）')

  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.waitForFunction(() => !!document.getElementById('btn-pet-settings'), null, { timeout: 30000 })
  await page.click('#btn-pet-settings')
  await sleep(800)

  // A. 导航项
  const navCount = await page.locator('.sp-nav-item').count()
  check('A 左侧导航 6 项', navCount === 6, String(navCount))

  // B. 同时只有一组可见
  const v1 = await visibleGroups(page)
  check('B1 同时只显示一组', v1.length === 1, v1.join(',') || '（无）')
  check('B2 默认显示「她这个人」', v1[0] === 'person', v1[0] || '')

  // C. 切组
  await page.click('.sp-nav-item[data-group="company"]')
  await sleep(400)
  const v2 = await visibleGroups(page)
  check('C 点「陪伴」切得过去', v2.length === 1 && v2[0] === 'company', v2.join(','))

  // D. 高级区默认收起
  const openCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('details.sp-adv')).filter((d) => d.open).length
  )
  check('D 高级区默认全部收起', openCount === 0, String(openCount))

  // E. 布局不塌
  const box = await page.evaluate(() => {
    const nav = document.querySelector('.sp-nav').getBoundingClientRect()
    const grp = document.querySelector('.sp-group.is-active').getBoundingClientRect()
    return { navW: nav.width, navBottom: nav.bottom, grpTop: grp.top, grpLeft: grp.left, grpRight: grp.right, grpW: grp.width, grpH: grp.height }
  })
  const stacked = box.grpTop >= box.navBottom - 1 // 窄屏：上下排
  const sideBySide = box.grpLeft >= box.navRight - 1
  check('E1 导航与内容区不重叠', stacked || sideBySide, `堆叠=${stacked}`)
  check('E2 内容区有可用宽度', box.grpW > 200, `${Math.round(box.grpW)}×${Math.round(box.grpH)}px`)

  // F. 展开
  await page.click('.sp-group[data-group="company"] details.sp-adv summary')
  await sleep(400)
  const openNow = await page.evaluate(() =>
    Array.from(document.querySelectorAll('details.sp-adv')).filter((d) => d.open).length
  )
  check('F 点开高级区能展开', openNow === 1, String(openNow))

  // G. 折叠区里的控件还在（这是最容易出事的一条：折没了 JS 就取到 undefined）
  const idsOk = await page.evaluate(() => {
    const ids = ['set-imperf-low', 'set-imperf-repair', 'set-presence-idle', 'set-notes-enabled', 'set-voice-profile', 'set-backchannel', 'set-speak-both', 'set-speak-reply', 'set-speak-proactive', 'set-dnd', 'set-only-presence']
    return ids.filter((i) => !document.getElementById(i))
  })
  check('G 折叠区控件仍可取到', idsOk.length === 0, idsOk.join(',') || '全部在')

  // G2. D51 取消掉的六个控件必须**真的消失了** —— 只删 JS 不删 HTML（或反之）都算没做完，
  //     而界面上留着却不起作用，是最糟的一种"假开关"。
  const stillThere = await page.evaluate(() => {
    const gone = ['set-presence-enabled', 'set-presence-rhythm', 'set-lipsync', 'set-ambient-gaze', 'set-imperf-prob', 'set-backchannel-prob']
    return gone.filter((i) => !!document.getElementById(i))
  })
  check('G2 已取消的六个控件确实从界面消失', stillThere.length === 0, stillThere.join(',') || '已全部移除')

  // I. 六组导航必须**全部**看得见 —— 横向滚动会把「连接」挤出可视区，
  //    用户根本不知道还有第六组。这条不看截图也能判定是否真的都露出来了。
  const clipped = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    return Array.from(document.querySelectorAll('.sp-nav-item'))
      .filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width === 0 || r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh
      })
      .map((b) => b.textContent.trim())
  })
  check('I 六组导航全部可见（无裁切）', clipped.length === 0, clipped.join(',') || '全部在视口内')

  if (SHOT) {
    await page.screenshot({ path: SHOT })
    console.log('　· 截图：' + SHOT)
  }

  check('H 控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  check('脚本执行', false, err.message)
  if (logs.length) {
    console.log('')
    console.log('--- Electron 输出（前 25 行）---')
    for (const l of logs.slice(0, 25)) console.log(l.trimEnd())
  }
} finally {
  try { child.kill() } catch {}
}

const failed = results.filter((r) => !r.pass).length
console.log('')
console.log(failed === 0 ? `全部通过（${results.length} 项）` : `${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
