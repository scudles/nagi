// test/monitor-authorized-visible.test.js
// 作者裁决 B（CONTRACTS 作者裁决登记）：设置页监测区域显示「监测于 <时间> 授权」。
//
// 为什么用静态断言：这条裁决是**文案 + 可见性**的硬要求（不得自行移除或改语义），
// 而它落在 HTML 与渲染层两处，没有纯逻辑函数可测。这里锁三件事：
//   1) 展示位存在且默认隐藏（无授权时不显示）；
//   2) 时间只来自主进程的 privacy.monitorAuthorizedAt，并且是本地化时间；
//   3) 文案语义是"监测于 … 授权"，不是别的说法。
// 真机行为由 scripts/verify-maintenance-ui.mjs 的 D 段覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
const renderer = readFileSync(join(process.cwd(), 'src/renderer/js/main.js'), 'utf8')
const monitorMain = readFileSync(join(process.cwd(), 'src/main/monitor/index.js'), 'utf8')

test('展示位存在、在监测区域里、默认隐藏', () => {
  const el = html.match(/<div id="monitor-authorized-at"[^>]*>/)
  assert.ok(el, '设置页必须有 monitor-authorized-at 展示位')
  assert.match(el[0], /hidden/, '未授权时默认不显示')
  // 必须落在「活动监测」那一块里（set-monitor 之后、该 section 结束之前）
  const afterMonitor = html.indexOf('id="set-monitor"')
  const sectionEnd = html.indexOf('</section>', afterMonitor)
  const pos = html.indexOf('id="monitor-authorized-at"')
  assert.ok(pos > afterMonitor && pos < sectionEnd, '展示位要在活动监测区域内')
})

test('时间来自主进程打戳 + 本地化显示 + 无值不显示', () => {
  assert.match(renderer, /function renderMonitorAuthorizedAt\(privacy\)/)
  assert.match(renderer, /Number\(privacy\?\.monitorAuthorizedAt\)/)
  assert.match(renderer, /new Date\(at\)\.toLocaleString\(\)/)
  // 无值分支必须把整行藏起来，而不是显示"未授权"或 1970 年
  assert.match(renderer, /if \(at > 0\)[\s\S]{0,200}else \{[\s\S]{0,80}hidden = true/)
  // fillSettingsForm 与保存后都要刷新（开监测的那一刻就该看到）
  assert.match(renderer, /renderMonitorAuthorizedAt\(privacy\)/)
  assert.match(renderer, /renderMonitorAuthorizedAt\(settings\?\.privacy/)
})

test('文案语义冻结为「监测于 <时间> 授权」', () => {
  assert.match(renderer, /监测于 \$\{new Date\(at\)\.toLocaleString\(\)\} 授权/)
})

test('打戳只在主进程：开启打戳 / 关闭清零 / 勿扰不重置', () => {
  assert.match(monitorMain, /function syncAuthorizationStamp/)
  assert.match(monitorMain, /enabled && at <= 0[\s\S]{0,120}saveSettings/)
  assert.match(monitorMain, /!enabled && at > 0[\s\S]{0,120}saveSettings/)
  // 勿扰/只陪着是临时状态：不能出现在"清零"的条件里
  assert.equal(/doNotDisturb[\s\S]{0,40}monitorAuthorizedAt: 0/.test(monitorMain), false)
  // refreshMonitorPrivacy 与 startMonitor 都要经过它，避免会话中途缺戳
  assert.match(monitorMain, /export function refreshMonitorPrivacy\(\) \{\s*\n\s*syncAuthorizationStamp\(\)/)
  assert.match(monitorMain, /export function startMonitor\([\s\S]{0,200}syncAuthorizationStamp\(\)/)
})
