// scripts/verify-notes.mjs
// BLUE-3 环境留痕的实机校验（2026-10-17）：
//   ① 默认关闭：三开关全关时列表为空、userData 下不产生 notes.json；
//   ② 设置页能开能关：勾选 → 保存 → 开关真的写进设置；关闭 → 保存 → 记录清空 + 文件被删；
//   ③ 全链路留痕：真实「聊天 → 假大脑发出 file_list → 工具执行 → action-trace hook →
//      扩展 → 落盘」跑通，留痕与便签都出现，且措辞不冒充「外部效果已完成」；
//   ④ 查看器：面板能打开、有内容、如实标注「外部写入暂未开放」；
//   ⑤ 回忆物：开启后聚合出可引用锚点（第一次见面等），且每个锚点都有可重验的来源。
//
// 用法：npm run verify:notes
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

// 本机设了 http_proxy，Playwright 连本地 CDP 会被代理劫持返回 502 → 必须绕过
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DATA = mkdtempSync(join(tmpdir(), 'nagi-notes-e2e-'))
const NOTES_FILE = join(DATA, 'notes.json')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}
const info = (name, detail) => console.log(`　· ${name}：${detail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假大脑（NAGI_FAKE_LLM=1）第一轮固定发一个 file_list，用来跑通真实留痕链路；
// fileRoot 必须授权到隔离目录，否则工具会因未授权而被拒（那时不该有留痕）。
writeFileSync(
  join(DATA, 'settings.json'),
  JSON.stringify(
    {
      llm: { provider: 'custom', model: 'fixture' },
      tools: { fileRoot: DATA },
      privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false },
      presence: { notesEnabled: false, tracesEnabled: false, anchorsEnabled: false },
      live2d: { frame: 'bust', petWidth: 400, petHeight: 600 }
    },
    null,
    2
  )
)

const env = { ...process.env, NAGI_FAKE_LLM: '1', NAGI_NO_PREWARM: '1', NAGI_RENDERER_SANDBOX: '0' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(ELECTRON, ['.', `--user-data-dir=${DATA}`, '--remote-debugging-port=9413'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function waitForCdp(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  return false
}

async function findPage(browser, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        try {
          const ok = await page.evaluate(() => document.body?.dataset?.mode === 'pet' && typeof window.nagi?.notes?.list === 'function')
          if (ok) return page
        } catch {
          /* 页面还在导航 */
        }
      }
    }
    await sleep(400)
  }
  return null
}

async function stopApp() {
  await new Promise((r) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('close', r)
    k.on('error', r)
  })
  await sleep(600)
}

async function main() {
  console.log('起隔离实例（本地假大脑 + 已授权隔离目录）…')
  if (!(await waitForCdp(9413))) throw new Error('CDP 未就绪')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9413')
  const page = await findPage(browser)
  if (!page) throw new Error('桌宠页未就绪')
  await sleep(1500)

  /* ① 默认关闭 */
  const off = await page.evaluate(() => window.nagi.notes.list())
  info('默认状态', JSON.stringify(off.enabled))
  check(
    '默认关闭：三个开关全关、列表为空、不产生文件',
    off.enabled.notes === false && off.enabled.traces === false && off.enabled.anchors === false &&
      off.notes.length === 0 && off.traces.length === 0 && !existsSync(NOTES_FILE),
    `文件存在=${existsSync(NOTES_FILE)}`
  )
  // B23 之后桥接已存在（externalWriteAvailable=能力），但没选目录前**这次**不许写（external.available=许可）。
  // 两者不是一回事：这条同时钉住"别再假装没实现"和"未授权就是不能写"。
  check(
    '外部写入：桥接已实现，但没授权时不许写',
    off.externalWriteAvailable === true && off.external?.available === false && off.external?.saved?.length === 0,
    `available=${off.external?.available} dir=${JSON.stringify(off.external?.dir || '')}`
  )

  /* ② 设置页开关：开 */
  const opened = await page.evaluate(async () => {
    document.getElementById('btn-pet-settings').click()
    await new Promise((r) => setTimeout(r, 600))
    const boxes = ['set-notes-enabled', 'set-traces-enabled', 'set-anchors-enabled']
    const before = boxes.map((id) => document.getElementById(id)?.checked)
    for (const id of boxes) document.getElementById(id).checked = true
    document.getElementById('btn-save-notes').click()
    await new Promise((r) => setTimeout(r, 800))
    return { before, status: document.getElementById('notes-status').textContent, settings: (await window.nagi.settings.get()).presence }
  })
  check(
    '设置页：三个开关默认未勾选，勾选保存后写进设置',
    opened.before.every((v) => v === false) &&
      opened.settings.notesEnabled === true && opened.settings.tracesEnabled === true && opened.settings.anchorsEnabled === true,
    `${JSON.stringify(opened.before)} → ${opened.status}`
  )

  /* ③ 全链路：真实聊天 → 假大脑 file_list → 工具执行 → 留痕 */
  await page.evaluate(() => {
    const input = document.getElementById('input')
    const btn = document.getElementById('btn-send')
    input.value = '先看看我的目录吧'
    btn.click()
  })
  let after = null
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    await sleep(500)
    after = await page.evaluate(() => window.nagi.notes.list())
    if (after.traces.length > 0) break
  }
  info('留痕', JSON.stringify(after?.traces?.slice(0, 2)))
  info('便签', JSON.stringify(after?.notes?.slice(0, 2)))
  check('真实工具调用被记成留痕（工具名 + 已返回）', after?.traces?.length > 0 && after.traces[0].tool === 'file_list' && after.traces[0].status === 'returned', JSON.stringify(after?.traces?.[0] || null))
  check(
    '留痕措辞不冒充外部效果已完成',
    !!after?.traces?.[0] && !/已经帮你|已完成/.test(after.traces[0].summary || ''),
    after?.traces?.[0]?.summary || ''
  )
  check('同一件事同时留下一张便签，且声明未核实', !!after?.notes?.length && /没有核实/.test(after.notes[0].text), after?.notes?.[0]?.text || '')
  check('内容落盘（notes.json 出现）', existsSync(NOTES_FILE))

  /* ④ 查看器面板 */
  const panel = await page.evaluate(async () => {
    document.getElementById('btn-pet-settings')?.classList // 面板入口在桌宠窗是隐藏按钮，直接点也行
    document.getElementById('notes-entry').click()
    await new Promise((r) => setTimeout(r, 800))
    const card = document.getElementById('notes-panel')
    return {
      exists: !!card,
      sections: card ? [...card.querySelectorAll('.np-sec')].map((e) => e.textContent) : [],
      items: card ? card.querySelectorAll('.np-item').length : 0,
      text: card ? card.textContent : ''
    }
  })
  info('查看器', JSON.stringify({ sections: panel.sections, items: panel.items }))
  check('查看器面板能打开且有内容', panel.exists && panel.items > 0, `items=${panel.items}`)
  check('查看器有便签/留痕分区，且不谎称已写到桌面', panel.sections.includes('便签') && panel.sections.includes('帮你做过的事') && !/已写入|已保存到桌面/.test(panel.text))

  /* ⑤ 回忆物 */
  const anchors = await page.evaluate(() => window.nagi.notes.list())
  check(
    '回忆物开启后聚合出可引用锚点，且每个都有来源',
    anchors.anchors.length > 0 && anchors.anchors.every((a) => a.sourceIds.length > 0),
    JSON.stringify(anchors.anchors.map((a) => a.kind))
  )

  /* ⑥ 关闭 → 清空 + 删文件 */
  const closed = await page.evaluate(async () => {
    for (const id of ['set-notes-enabled', 'set-traces-enabled', 'set-anchors-enabled']) document.getElementById(id).checked = false
    document.getElementById('btn-save-notes').click()
    await new Promise((r) => setTimeout(r, 900))
    return { status: document.getElementById('notes-status').textContent, list: await window.nagi.notes.list() }
  })
  check(
    '关闭后：列表清空 + 文件被删 + 状态如实说明',
    closed.list.notes.length === 0 && closed.list.traces.length === 0 &&
      closed.list.enabled.notes === false && !existsSync(NOTES_FILE) && closed.status.includes('已关闭'),
    `${closed.status} 文件存在=${existsSync(NOTES_FILE)}`
  )

  /* ⑦ 清除接口（再次开启后清） */
  const cleared = await page.evaluate(async () => {
    for (const id of ['set-traces-enabled']) document.getElementById(id).checked = true
    document.getElementById('btn-save-notes').click()
    await new Promise((r) => setTimeout(r, 500))
    const r = await window.nagi.notes.clear()
    const list = await window.nagi.notes.list()
    return { r, notes: list.notes.length, traces: list.traces.length }
  })
  check('清除接口可用（清内存与磁盘）', cleared.r?.ok === true && cleared.notes === 0 && cleared.traces === 0, JSON.stringify(cleared))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ✘ ${f.name}${f.detail ? '：' + f.detail : ''}`)
  }
  console.log(`隔离数据目录：${DATA}`)
  process.exitCode = failed.length ? 1 : 0
}

main()
  .catch((err) => {
    console.error('校验失败：', err)
    process.exitCode = 1
  })
  .finally(stopApp)
