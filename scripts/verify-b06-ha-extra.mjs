// scripts/verify-b06-ha-extra.mjs
// B06：复现 home_set 的 extra 覆盖 entity_id 风险（假 HA 客户端，不接真实设备）。
// 背景：任务书 S02 要求「控制参数不得通过 extra 等字段替换已核验的目标」。
// 本脚本只复现并留存证据；修复属红区（安全门/工具适配），建议见 docs/HANDOFF.md。
// 运行：node scripts/verify-b06-ha-extra.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRunner, planHomeService } from '../src/core/tools/registry.js'
import { describeToolCall } from '../src/core/agent/loop.js'
import { needsConfirm } from '../src/core/safety/policy.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/* ---------------- 假 HA 客户端：只记录调用，不碰任何真实设备 ---------------- */
const calls = []
const fakeHa = {
  configured: true,
  async callService(domain, service, data) { calls.push({ kind: 'service', domain, service, data }) },
  async getState() { return null },
  async trigger(entity_id) { calls.push({ kind: 'trigger', entity_id }) }
}

const runner = createToolRunner({
  files: null,
  system: null,
  browser: null,
  native: null,
  reminders: null,
  ha: fakeHa,
  haReadAuthorized: () => true,
  haControlAuthorized: () => true // 已单独授权设备控制（确认门仍逐次弹）
})

/* ---------------- 场景 ---------------- */
const scenarios = [
  {
    name: 'extra 覆盖 entity_id：确认框显示诱饵目标，实际执行被换成真实目标',
    args: { entity_id: 'light.living_room', state: 'off', extra: { entity_id: 'lock.front_door' } }
  },
  {
    name: 'extra 正当透传（不含 entity_id）——该字段的设计本意',
    args: { entity_id: 'light.living_room', state: 'on', extra: { transition: 2 } }
  },
  {
    name: 'extra 连带覆盖已钳制字段：brightness_pct 10 被换成 255',
    args: { entity_id: 'light.living_room', state: 'on', brightness_pct: 10, extra: { brightness_pct: 255 } }
  }
]

const report = {
  what: 'B06 home_set extra 覆盖 entity_id 复现',
  date: new Date().toISOString(),
  node: process.version,
  fakeClient: true,
  realDevice: false,
  scenarios: []
}

for (const sc of scenarios) {
  calls.length = 0
  const confirmShown = describeToolCall('home_set', sc.args) // 用户确认框里看到的文字
  const decision = needsConfirm({ name: 'home_set', args: sc.args }) // 是否会弹确认
  const result = await runner('home_set', sc.args) // 实际执行（假客户端）
  const plan = planHomeService(sc.args)
  report.scenarios.push({
    name: sc.name,
    args: sc.args,
    confirmRequired: decision.confirm,
    confirmShown,
    plannedCall: { domain: plan.domain, service: plan.service, data: plan.data },
    resultSummary: result.summary,
    actualCalls: calls.map((c) => ({ ...c }))
  })
}

/* ---------------- 判定 ---------------- */
const s1 = report.scenarios[0]
const s3 = report.scenarios[2]
report.verdict = {
  entityIdOverridable: s1.actualCalls[0]?.data?.entity_id === 'lock.front_door',
  confirmShowsDecoy: s1.confirmShown.includes('light.living_room') && !s1.confirmShown.includes('lock.front_door'),
  summaryAlsoLies: s1.resultSummary.includes('light.living_room'),
  clampedFieldOverridable: s3.actualCalls[0]?.data?.brightness_pct === 255,
  legitPassthroughWorks: report.scenarios[1].actualCalls[0]?.data?.transition === 2
}
report.vulnerable = report.verdict.entityIdOverridable && report.verdict.confirmShowsDecoy

/* ---------------- 输出 ---------------- */
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const outDir = join(root, 'docs', 'verify')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `b06-ha-extra-${stamp}.json`)
writeFileSync(outFile, JSON.stringify(report, null, 2))

for (const sc of report.scenarios) {
  console.log(`\n■ ${sc.name}`)
  console.log(`  参数          ${JSON.stringify(sc.args)}`)
  console.log(`  需确认        ${sc.confirmRequired}`)
  console.log(`  确认框显示    ${sc.confirmShown}`)
  console.log(`  计划调用      ${sc.plannedCall.domain}.${sc.plannedCall.service} ${JSON.stringify(sc.plannedCall.data)}`)
  console.log(`  结果摘要      ${sc.resultSummary}`)
  console.log(`  实际调用      ${JSON.stringify(sc.actualCalls)}`)
}
console.log('\n=== 判定 ===')
console.log(JSON.stringify(report.verdict, null, 2))
console.log(report.vulnerable
  ? '结论：漏洞可复现——确认对象 ≠ 执行对象（S02 违反）。修复建议见 docs/HANDOFF.md（红区，待 ChatGPT 决定）。'
  : '结论：未复现（可能已修复）——请更新 HANDOFF 建议状态。')
console.log(`证据已存：${outFile}`)
