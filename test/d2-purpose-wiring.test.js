// test/d2-purpose-wiring.test.js
// D2（P2-01）核对：六意图枚举 / 场景白名单 / **按模型-用途存参数**是否真的接上了。
//
// 本轮核对出的两处有证据的行为缺口（改前）：
//   1) `hasGroundedMemory` 把"长期记忆非空"也算进来 → reminisce 的引用门槛形同虚设；
//   2) LLM_PURPOSES 定义了 chat/diary/proactive/extract 四个用途，
//      但 proactive 与 extract **一次都没被调用** —— purposeParams 里配它们是死配置。
//
// 这个文件同时承担两件事：
//   · 行为层：resolveLlm 对每个用途的缺省值与覆盖行为（core，可直接跑）；
//   · 接线层：main/agent.js 里那几处"必须按用途解析"的点还在不再
//     （源码断言，防止有人改回 resolveLlm(cfg) 让配置悄悄失效）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LLM_PURPOSES, LLM_PURPOSE_LABELS, resolveLlm } from '../src/core/llm/providers.js'
import { INTENT, INTENT_KINDS, INTENT_DIRECTIVES, hasGroundedRefs, intentDirective, resolveIntent } from '../src/core/agent/intent.js'
import { SCENE_ACTIVITY_ORIGINS, normalizeSceneActivity } from '../src/core/context.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const agentSource = readFileSync(join(root, 'src', 'main', 'agent.js'), 'utf8')

test('D2-ENUM-01 六意图与契约 §5 枚举逐字一致，且每种都有功能性 directive', () => {
  assert.deepEqual([...INTENT_KINDS].sort(), [
    'boundary', 'brief-ack', 'clarify', 'listen', 'reminisce', 'solve'
  ])
  assert.equal(INTENT_KINDS.length, 6)
  for (const kind of INTENT_KINDS) {
    const line = intentDirective(kind)
    assert.ok(line && line.length > 8, `${kind} 必须有 directive`)
    // 无台词铁律：directive 只说做什么，不给台词样本
    assert.doesNotMatch(line, /^(「|"|')/, `${kind} 的 directive 不该以引号里的句子开头`)
    assert.equal(INTENT_DIRECTIVES[kind], line)
  }
})

test('D2-ENUM-02 场景白名单只认三类已授权来源，其余一律不作数', () => {
  assert.deepEqual([...SCENE_ACTIVITY_ORIGINS], ['monitor', 'media', 'simulated'])
  for (const origin of ['title', 'window', 'ip', 'guess', '']) {
    assert.equal(normalizeSceneActivity({ origin, value: '在看剧', at: Date.now(), authorizedAt: Date.now() }), null,
      `${origin || '(空)'} 不是白名单来源，不得进事实段`)
  }
  // 白名单内但没有授权时间 → 同样丢弃（宁缺勿造）
  assert.equal(normalizeSceneActivity({ origin: 'media', value: '听歌', at: Date.now(), authorizedAt: 0 }), null)
})

test('D2-PURPOSE-01 四个用途的缺省值 = 各调用点改造前写死的值', () => {
  const cfg = { provider: 'deepseek', model: 'deepseek-chat', temperature: 1.3 }
  // 主对话：1.3（cfg 温度优先）
  assert.equal(resolveLlm(cfg, 'chat').temperature, 1.3)
  // 日记：0.9；主动开口：原来两处分别写死 0.9 / 0.2，各自的缺省由调用点传入
  assert.equal(resolveLlm(cfg, 'diary', { defaultTemperature: 0.9 }).temperature, 0.9)
  assert.equal(resolveLlm(cfg, 'proactive', { defaultTemperature: 0.2 }).temperature, 0.2)
  assert.equal(resolveLlm(cfg, 'proactive', { defaultTemperature: 0.9 }).temperature, 0.9)
  assert.equal(resolveLlm(cfg, 'extract', { defaultTemperature: 0.2 }).temperature, 0.2)
  // 没配 purposeParams 时，带用途与不带用途只在"调用点显式给的缺省"上有差别
  assert.equal(resolveLlm(cfg, 'extract').temperature, 1.3, '不传缺省温度时与 chat 一致（负责任的行为：不偷偷改）')
})

test('D2-PURPOSE-02 proactive / extract 覆盖生效，且不串到主对话', () => {
  const cfg = {
    provider: 'deepseek', model: 'deepseek-chat', temperature: 1.3,
    purposeParams: {
      proactive: { temperature: 0.5, model: 'proactive-model' },
      extract: { temperature: 0.1, model: 'extract-model' }
    }
  }
  assert.equal(resolveLlm(cfg, 'proactive', { defaultTemperature: 0.9 }).temperature, 0.5)
  assert.equal(resolveLlm(cfg, 'proactive').model, 'proactive-model')
  assert.equal(resolveLlm(cfg, 'extract', { defaultTemperature: 0.2 }).temperature, 0.1)
  assert.equal(resolveLlm(cfg, 'extract').model, 'extract-model')
  // 不串台
  assert.equal(resolveLlm(cfg, 'chat').temperature, 1.3)
  assert.equal(resolveLlm(cfg, 'chat').model, 'deepseek-chat')
  assert.equal(resolveLlm(cfg, 'diary', { defaultTemperature: 0.9 }).temperature, 0.9)
  // 非法值忽略
  for (const bad of [3, -1, '0.5', NaN]) {
    const wrong = { ...cfg, purposeParams: { extract: { temperature: bad } } }
    assert.equal(resolveLlm(wrong, 'extract', { defaultTemperature: 0.2 }).temperature, 0.2, String(bad))
  }
  assert.deepEqual([...LLM_PURPOSES], ['chat', 'diary', 'proactive', 'extract'])
  for (const p of LLM_PURPOSES) assert.ok(LLM_PURPOSE_LABELS[p], p)
})

test('D2-WIRE-01 main 侧按用途解析的接线点仍在（改回无用途会让配置悄悄失效）', () => {
  const callSites = agentSource.match(/resolveLlm\([^)]*\)/g) || []
  assert.ok(callSites.length >= 4, '至少 diary / chat / proactive / extract 各一处')
  assert.ok(/resolveLlm\(settings\.llm \|\| \{\}, 'diary'/.test(agentSource), '日记必须走 diary 用途')
  assert.ok(/resolveLlm\(settings\.llm \|\| \{\}, 'chat'/.test(agentSource), '主对话必须走 chat 用途')
  assert.ok(/resolveLlm\(getSettings\(\)\.llm \|\| \{\}, 'proactive', \{ defaultTemperature: 0\.2 \}\)/.test(agentSource),
    '归来主动表达要走 proactive 用途（缺省 0.2 与改造前一致）')
  assert.ok(/resolveLlm\(getSettings\(\)\.llm \|\| \{\}, 'proactive', \{ defaultTemperature: 0\.9 \}\)/.test(agentSource),
    '主动那一句要走 proactive 用途（缺省 0.9 与改造前一致）')
  assert.ok(/resolveLlm\(settings\.llm \|\| \{\}, 'extract', \{ defaultTemperature: 0\.2 \}\)/.test(agentSource),
    '记忆抽取要走 extract 用途（缺省 0.2 与改造前一致）')
  // 温度得真的用上，不能解了用途又写死回 0.9/0.2
  assert.ok(/temperature: llm\.temperature/.test(agentSource), '解出来的用途温度必须传给调用，否则配置依然无效')
  assert.ok(!/memoryLines\(\)\.length > 0/.test(agentSource), '长期记忆非空不能再当作"已召回相关往事"')
  assert.ok(/hasGroundedMemory: hasGroundedRefs\(memoryRefs\)/.test(agentSource), '可追溯口径必须走 hasGroundedRefs')
})

test('D2-WIRE-02 首请求 modelHint 恒 null；仅同轮候选出站前参与复核', () => {
  const build = agentSource.slice(agentSource.indexOf('async function buildMessages'), agentSource.indexOf('async function callModelOnce'))
  assert.ok(!/modelHint:/.test(build), '首请求不得使用上一用户轮 hint')
  assert.match(agentSource, /stripIntentHintEvents\(stream, \(hint\) => \{[\s\S]*?hintSlot\.offer/, '同次模型输出应进复核')
  assert.match(agentSource, /createModelHintGuard\(\{/, '候选必须经过编排复核')
  const baseline = resolveIntent({ userText: '嗯' })
  assert.equal(resolveIntent({ userText: '嗯', modelHint: null }).kind, baseline.kind)
  assert.ok(existsSync(join(root, 'src', 'core', 'agent', 'intent.js')))
  assert.ok(hasGroundedRefs([{ id: 'a', source: 'rag' }]))
})
