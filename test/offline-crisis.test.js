// test/offline-crisis.test.js
// B4 二轮打回：占位大脑（断网 / 无 API key）遇到 L2/L3 时的正文定稿。
//
// 打回场景（只读复现）：输入「我已经吃了很多药」→ 占位回复「……我现在接不上大脑。等接上了，我再好好回你。」
// → createPersonaGuard(...,{crisis:true}).review(...) 返回 {ok:true} → 原样展示。
// 即：一条 L3 输入换回一句程序自嘲，既无求助指引、又把危机退回普通闲聊。
//
// 这里锁四件事：
//   1) 危机轮**不取**角色台词，直接用按级别的确定性安全指引；
//   2) 正文先定稿再送审（announce 尾句必须在审核之前拼好）；
//   3) 危机轮**禁止**追加占位自嘲尾句；
//   4) L2 询问此刻安全、L3 给出急救/到场求助，正文非空且不泄漏候选。
// mockRun 入口本身的验证在 scripts/verify-crisis-offline.mjs（真机、不配 key）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { composeOfflineReply, OFFLINE_SELF_DEPRECATION } from '../src/core/agent/offline.js'
import { classifyCrisis } from '../src/core/agent/crisis.js'
import { createPersonaGuard } from '../src/core/agent/persona-guard.js'
import { CRISIS_GUIDANCE, SAFETY_LEVEL, crisisGuidance } from '../src/core/agent/generation.js'

const NORMAL_MOCK_LINE = '……我现在接不上大脑。等接上了，我再好好回你。'

test('L3「我已经吃了很多药」→ 确定性求助指引，不再回占位台词', () => {
  const crisis = classifyCrisis('我已经吃了很多药')
  assert.equal(crisis.level, 'L3')
  const out = composeOfflineReply({
    personaText: NORMAL_MOCK_LINE, // 就算调用方传了，也不许用
    announce: true,
    safetyLevel: crisis.safetyLevel,
    level: crisis.level
  })
  assert.equal(out.crisis, true)
  assert.ok(out.text.length > 0, '正文不能为空')
  assert.match(out.text, /急救|到场|身边的人/, 'L3 必须给求助方向')
  assert.equal(out.text.includes('接不上大脑'), false, '不许泄漏占位台词')
  assert.equal(out.text.includes(OFFLINE_SELF_DEPRECATION), false, '危机轮禁止自嘲尾句')
  assert.equal(out.text.includes('只有这么点脑子'), false)
})

test('L2「我不知道还能撑多久」→ 先问此刻是否安全，不给热线清单', () => {
  const crisis = classifyCrisis('我不知道还能撑多久')
  assert.equal(crisis.level, 'L2')
  const out = composeOfflineReply({ personaText: NORMAL_MOCK_LINE, safetyLevel: crisis.safetyLevel, level: crisis.level })
  assert.match(out.text, /你现在安全吗|安全/)
  assert.match(out.text, /一个人/)
  assert.equal(out.text.includes('接不上大脑'), false)
  assert.equal(out.text.includes(OFFLINE_SELF_DEPRECATION), false)
  // L2 不该像 L3 那样直接甩求助流程
  assert.equal(/急救电话/.test(out.text), false, 'L2 先确认安全，不越级给急救指令')
})

test('定稿顺序：announce 尾句在审核之前就已拼好（危机轮不拼）', () => {
  const normal = composeOfflineReply({ personaText: '嗯。', announce: true, safetyLevel: SAFETY_LEVEL.NORMAL })
  assert.equal(normal.announced, true)
  assert.ok(normal.text.endsWith(OFFLINE_SELF_DEPRECATION), '普通轮首启动仍带自嘲尾句')

  const crisis = composeOfflineReply({ personaText: '嗯。', announce: true, safetyLevel: SAFETY_LEVEL.CRISIS, level: 'L3' })
  assert.equal(crisis.announced, false, '危机轮不追加尾句')
  assert.equal(crisis.text.includes(OFFLINE_SELF_DEPRECATION), false)
})

test('普通轮行为不变（没危机时仍用角色台词，且 announce 才补尾句）', () => {
  const quiet = composeOfflineReply({ personaText: '我在。', announce: false })
  assert.equal(quiet.text, '我在。')
  assert.equal(quiet.announced, false)
  assert.equal(quiet.crisis, false)
})

test('未知危机级别按 L3 处理（宁可多给求助方向）', () => {
  assert.equal(crisisGuidance(null), CRISIS_GUIDANCE.L3)
  assert.equal(crisisGuidance(undefined), CRISIS_GUIDANCE.L3)
  assert.equal(crisisGuidance('L9'), CRISIS_GUIDANCE.L3)
  assert.equal(crisisGuidance('L2'), CRISIS_GUIDANCE.L2)
})

test('两段安全指引都能过危机护栏（否则说明规则在误伤安全文本）', () => {
  for (const level of ['L2', 'L3']) {
    const guard = createPersonaGuard('我不想活了', { crisis: true })
    const review = guard.review(crisisGuidance(level))
    assert.equal(review.ok, true, `${level} 指引被 ${review.ruleId} 拦下了`)
  }
})

test('安全指引不含具体号码（地区未知不凭记忆编号码）', () => {
  for (const level of ['L2', 'L3']) {
    assert.equal(/\d{3,}/.test(crisisGuidance(level)), false, level)
  }
})
