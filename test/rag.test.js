// test/rag.test.js
// RAG 长期记忆单测：哈希 / chunk / 相似度 / 向量库（含崩溃对齐修复）/ 召回管线 /
// 摘要触发 / 引擎注册表 / 真实文件 IO（临时目录）/ 设置合并 / 端到端召回。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  contentHash,
  normalizeText,
  makeTurnChunk,
  makeFactChunk,
  makeDiaryChunk,
  makeSummaryChunk,
  normalizeChunk,
  finalizeChunk,
  CHUNK_KINDS,
  KIND_WEIGHT,
  dayKey,
  dot,
  cosine,
  vecNorm,
  normalizeInPlace,
  decayFactor,
  DAY_MS,
  VectorStore,
  SEARCH_DEFAULTS,
  timeLabel,
  scoreCandidates,
  recall,
  formatRecall,
  planEmbedding,
  shouldSummarize,
  coveredTurnIds,
  pickTurnsToSummarize,
  EMBED_ENGINES,
  pickEmbedEngine
} from '../src/core/rag/index.js'
import { RagStoreIo } from '../src/main/rag/store-io.js'
import { DEFAULT_RAG_SETTINGS, mergeRagSettings } from '../src/shared/rag-protocol.js'

const DAY = DAY_MS
const NOW = 1792000000000 // 固定时间戳，保证时间相关断言确定

/* ---------------- 小工具 ---------------- */

/** 造一条测试 chunk + 向量 */
function mk(text, vec, at = NOW) {
  return { c: makeTurnChunk({ user: text, assistant: '好的', at }), v: new Float32Array(vec) }
}

/** 追加并断言成功，返回 { c, v } */
function add(store, text, vec, at = NOW) {
  const t = mk(text, vec, at)
  const r = store.append(t.c, t.v)
  assert.equal(r.ok, true, `append 失败：${r.reason}`)
  return t
}

/* ---------------- 哈希 ---------------- */

test('contentHash：同文同哈希、空白不敏感、空文本为空', () => {
  assert.equal(contentHash('你好呀'), contentHash('你好 呀\n'))
  assert.notEqual(contentHash('你好呀'), contentHash('你好阿'))
  assert.equal(contentHash(''), '')
  assert.equal(contentHash(null), '')
  assert.equal(normalizeText(' a\tb\nc '), 'abc')
})

/* ---------------- chunk 构造 ---------------- */

test('makeTurnChunk：格式、字段、稳定 id', () => {
  const c = makeTurnChunk({ user: '最近睡不好', assistant: '又失眠了吗', at: NOW, mood: 'worry' })
  assert.equal(c.kind, 'turn')
  assert.equal(c.role, 'both')
  assert.equal(c.text, '他：最近睡不好\n我：又失眠了吗')
  assert.equal(c.weight, KIND_WEIGHT.turn)
  assert.equal(c.day, dayKey(NOW))
  assert.equal(c.meta.mood, 'worry')
  assert.match(c.id, /^t_\d{8}_[0-9a-z]{6}$/)
  // 同样输入 → 同样 id（去重依赖这一点）
  const c2 = makeTurnChunk({ user: '最近睡不好', assistant: '又失眠了吗', at: NOW })
  assert.equal(c2.id, c.id)
  assert.equal(c2.hash, c.hash)
  assert.equal(makeTurnChunk({ user: '', assistant: '' }), null)
})

test('finalizeChunk：超长截断、非法 kind 回落 turn', () => {
  const c = finalizeChunk({ kind: '胡说', text: 'x'.repeat(2000), at: NOW })
  assert.equal(c.kind, 'turn')
  assert.ok(c.text.length < 1300)
  assert.ok(c.text.endsWith('…'))
  assert.equal(finalizeChunk({ text: '   ' }), null)
})

test('makeFactChunk / makeSummaryChunk：权重与 covers', () => {
  const f = makeFactChunk({ text: '在做一款叫凪的桌宠项目', at: NOW })
  assert.equal(f.kind, 'fact')
  assert.equal(f.weight, KIND_WEIGHT.fact) // 1.15
  const s = makeSummaryChunk({ text: '这月在赶桌宠项目', covers: ['t_1', 't_2'], at: NOW })
  assert.equal(s.kind, 'summary')
  assert.equal(s.weight, KIND_WEIGHT.summary) // 0.8
  assert.deepEqual(s.meta.covers, ['t_1', 't_2'])
})

test('normalizeChunk：墓碑行识别、坏输入拒绝', () => {
  const t = normalizeChunk({ tombstone: true, id: 't_x', at: NOW })
  assert.equal(t.tombstone, true)
  assert.equal(normalizeChunk(null), null)
  assert.equal(normalizeChunk({ text: '' }), null)
  assert.equal(normalizeChunk({ kind: 'fact', text: '有条理', hash: 'abc' }).hash, 'abc')
})

test('CHUNK_KINDS / KIND_WEIGHT：集合完整', () => {
  assert.deepEqual(CHUNK_KINDS, ['turn', 'fact', 'summary', 'diary', 'event'])
  for (const k of CHUNK_KINDS) assert.ok(KIND_WEIGHT[k] > 0)
})

/* ---------------- 相似度 ---------------- */

test('cosine：正交 0 / 同向 1 / 反向 -1 / 零向量不炸', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([2, 0], [5, 0]), 1)
  assert.equal(cosine([1, 0], [-3, 0]), -1)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine([3, 4], [4, 3]), 24 / 25)
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32)
})

test('normalizeInPlace：归一后范数 1，零向量原样', () => {
  const v = new Float32Array([3, 4])
  normalizeInPlace(v)
  assert.ok(Math.abs(vecNorm(v) - 1) < 1e-6)
  const z = new Float32Array([0, 0])
  assert.deepEqual(Array.from(normalizeInPlace(z)), [0, 0])
})

test('decayFactor：45 天半衰、0 天与负龄为 1', () => {
  assert.equal(decayFactor(0), 1)
  assert.equal(decayFactor(-5), 1)
  assert.ok(Math.abs(decayFactor(45) - 0.5) < 1e-9)
  assert.ok(Math.abs(decayFactor(90) - 0.25) < 1e-9)
  assert.ok(Math.abs(decayFactor(10, 10) - 0.5) < 1e-9) // 自定义半衰期
})

/* ---------------- 向量库 ---------------- */

test('append + 序列化 → open 往返一致', () => {
  const s = new VectorStore({ dim: 3 })
  const a = add(s, '第一条', [1, 0, 0])
  const b = add(s, '第二条', [0, 1, 0])
  const c = add(s, '第三条', [0, 0, 1])
  assert.equal(s.count, 3)
  assert.equal(s.liveCount, 3)

  const bytes = s.vectorsBytes()
  const lines = s.chunkLines()
  assert.equal(bytes.length, 3 * 3 * 4)
  assert.equal(lines.length, 3)

  const { store: s2, repaired } = VectorStore.open({ dim: 3, vectorsBytes: bytes, chunkLines: lines })
  assert.deepEqual(repaired, { droppedVectorRows: 0, droppedChunkLines: 0, badLines: 0 })
  assert.equal(s2.count, 3)
  assert.deepEqual(
    s2.liveChunks().map((x) => x.text),
    [a.c.text, b.c.text, c.c.text]
  )
  // 向量按归一化后的值存（单位方向不变）
  assert.deepEqual(Array.from(s2.vec.subarray(0, 3)), [1, 0, 0])
  assert.deepEqual(Array.from(s2.vec.subarray(3, 6)), [0, 1, 0])
  // 非单位向量入库时即被归一
  const s3 = new VectorStore({ dim: 2 })
  add(s3, '斜的', [3, 4])
  assert.ok(Math.abs(vecNorm(s3.rowVector(0)) - 1) < 1e-6)
})

test('append 幂等：同内容 / 同 id 拒绝；维度不符拒绝', () => {
  const s = new VectorStore({ dim: 3 })
  const { c, v } = mk('重复内容', [1, 0, 0])
  assert.equal(s.append(c, v).ok, true)
  assert.equal(s.append(c, v).reason, '内容已存在')
  assert.equal(s.append(makeTurnChunk({ user: '重复内容', assistant: '好的', at: NOW }), v).reason, '内容已存在')
  assert.equal(s.append(c, new Float32Array([1, 0])).reason, '向量维度不符')
})

test('remove → 墓碑 → 忘掉的内容可以重新记住', () => {
  const s = new VectorStore({ dim: 3 })
  const { c, v } = mk('要忘的事', [1, 0, 0])
  s.append(c, v)
  assert.equal(s.hasHash(c.hash), true)
  assert.equal(s.remove(c.id), true)
  assert.equal(s.remove(c.id), false) // 删第二次无效
  assert.equal(s.hasHash(c.hash), false) // 死行不算数
  assert.equal(s.liveCount, 0)
  // 重新记住同一句：id 相同但旧行是墓碑 → 放行
  const r = s.append(c, v)
  assert.equal(r.ok, true)
  assert.equal(r.row, 1)
  assert.equal(s.liveCount, 1)
  assert.equal(s.hasHash(c.hash), true)
})

test('open 对齐修复：向量行少一条（chunk 行写了、向量行没写）', () => {
  const s = new VectorStore({ dim: 3 })
  const a = add(s, '甲', [1, 0, 0])
  const b = add(s, '乙', [0, 1, 0])
  const bytes = s.vectorsBytes()
  const lines = s.chunkLines()
  // 模拟崩溃窗口：第三条的 chunk 行写进去了，向量行没写
  const c3 = makeTurnChunk({ user: '丙', assistant: '在吗', at: NOW })
  const { store, repaired } = VectorStore.open({
    dim: 3,
    vectorsBytes: bytes,
    chunkLines: [...lines, JSON.stringify(c3)]
  })
  assert.equal(repaired.droppedChunkLines, 1)
  assert.equal(repaired.droppedVectorRows, 0)
  assert.equal(store.count, 2)
  assert.deepEqual(
    store.liveChunks().map((x) => x.text),
    [a.c.text, b.c.text]
  )
})

test('open 对齐修复：向量多一行 + chunk 末行坏 JSON，双双截掉', () => {
  const s = new VectorStore({ dim: 2 })
  add(s, '甲', [1, 0])
  const bytes = s.vectorsBytes()
  const extra = new Uint8Array(bytes.length + 2 * 4) // 多半行向量（写了一半）
  extra.set(bytes)
  const { store, repaired } = VectorStore.open({
    dim: 2,
    vectorsBytes: extra,
    chunkLines: [s.chunkLines()[0], '{"id":"t_x","text":"半行'] // 末行坏 JSON
  })
  assert.equal(repaired.droppedVectorRows, 1)
  assert.equal(repaired.badLines, 1)
  assert.equal(store.count, 1)
})

test('open：文件末尾换行不算坏行', () => {
  const s = new VectorStore({ dim: 2 })
  add(s, '甲', [1, 0])
  const { store, repaired } = VectorStore.open({
    dim: 2,
    vectorsBytes: s.vectorsBytes(),
    chunkLines: [...s.chunkLines(), ''] // 末尾换行产生的空行
  })
  assert.equal(repaired.badLines, 0)
  assert.equal(store.count, 1)
})

test('compact：墓碑消失、内容与顺序不变、索引重建', () => {
  const s = new VectorStore({ dim: 3 })
  const a = add(s, '保留甲', [1, 0, 0])
  const b = add(s, '删掉乙', [0, 1, 0])
  const c = add(s, '保留丙', [0, 0, 1])
  s.remove(b.c.id)
  const plan = s.compactPlan()
  assert.equal(plan.keep.length, 2)
  s.applyCompact(plan)
  assert.equal(s.count, 2)
  assert.equal(s.dead.size, 0)
  assert.deepEqual(
    s.liveChunks().map((x) => x.text),
    [a.c.text, c.c.text]
  )
  // 行号前移后索引仍正确
  assert.equal(s.chunkById(a.c.id).text, a.c.text)
  assert.equal(s.rowOfHash(c.c.hash), 1)
})

/* ---------------- 召回 ---------------- */

test('timeLabel：各档位（都带 MM-DD 定位；日期由 dayKey 算，不写死）', () => {
  const md = (at) => `（${dayKey(at).slice(5)}）`
  assert.equal(timeLabel(NOW, NOW), `今天${md(NOW)}`)
  assert.equal(timeLabel(NOW - DAY, NOW), `昨天${md(NOW - DAY)}`)
  assert.equal(timeLabel(NOW - 3 * DAY, NOW), `3 天前${md(NOW - 3 * DAY)}`)
  assert.equal(timeLabel(NOW - 10 * DAY, NOW), `上周${md(NOW - 10 * DAY)}`)
  assert.equal(timeLabel(NOW - 20 * DAY, NOW), `2 周前${md(NOW - 20 * DAY)}`)
  assert.equal(timeLabel(NOW - 40 * DAY, NOW), `上个月${md(NOW - 40 * DAY)}`)
  assert.equal(timeLabel(NOW - 100 * DAY, NOW), `3 个月前${md(NOW - 100 * DAY)}`)
  assert.equal(timeLabel(NOW - 400 * DAY, NOW), `1 年前${md(NOW - 400 * DAY)}`)
})

test('召回阈值是语义门：老的相关记忆仍在（沉但不消失）', () => {
  const s = new VectorStore({ dim: 2 })
  const old = add(s, '很久以前聊过失眠', [1, 0], NOW - 400 * DAY) // sim 高但极老
  const fresh = add(s, '刚才在说项目', [0.9, 0.435], NOW) // sim≈0.9，新
  const q = new Float32Array([1, 0])
  const out = recall(s, q, { now: NOW, maxResults: 6 })
  assert.equal(out.length, 2, '两条都该过语义门限')
  assert.equal(out[0].text, fresh.c.text, '新的排前面')
  assert.equal(out[1].text, old.c.text, '老的沉底但没被删')
  // sim 低于阈值的完全不进
  const s2 = new VectorStore({ dim: 2 })
  add(s2, '完全无关', [0, 1])
  assert.equal(recall(s2, new Float32Array([1, 0]), { now: NOW }).length, 0)
})

test('类型权重：fact 1.15 排在同样 sim 的 turn 前', () => {
  const s = new VectorStore({ dim: 2 })
  const turn = add(s, '同一句话的轮次版', [1, 0])
  const fact = makeFactChunk({ text: '同一句话的事实版', at: NOW })
  assert.equal(s.append(fact, new Float32Array([1, 0])).ok, true)
  const out = recall(s, new Float32Array([1, 0]), { now: NOW, maxResults: 2 })
  assert.equal(out[0].kind, 'fact')
  assert.equal(out[1].kind, 'turn')
})

test('covered 降权：被摘要覆盖的轮次分数 ×0.8', () => {
  const s = new VectorStore({ dim: 2 })
  const a = add(s, '轮次甲', [1, 0])
  add(s, '轮次乙', [1, 0])
  const plain = scoreCandidates(s, new Float32Array([1, 0]), { now: NOW })
  const covered = scoreCandidates(s, new Float32Array([1, 0]), { now: NOW, covered: new Set([a.c.id]) })
  const pa = plain.find((x) => x.id === a.c.id)
  const ca = covered.find((x) => x.id === a.c.id)
  assert.ok(Math.abs(ca.score - pa.score * 0.8) < 1e-9)
})

test('MMR 去冗余：同义复读只留代表，多样性进来', () => {
  const s = new VectorStore({ dim: 2 })
  add(s, '失眠复读一', [1, 0])
  add(s, '失眠复读二', [0.99, 0.14])
  add(s, '失眠复读三', [0.98, 0.2])
  add(s, '项目上线', [0, 1])
  const q = new Float32Array([0.7, 0.7]) // 与两边都有不低相似度
  const out = recall(s, q, { now: NOW, maxResults: 2 })
  const texts = out.map((x) => x.text)
  assert.equal(
    texts.filter((t) => t.includes('复读')).length,
    1,
    '两条名额里复读只占一条'
  )
  assert.ok(
    texts.some((t) => t.includes('项目')),
    '不同方向的那条该进来'
  )
})

test('预算截断：总字符不超预算（首条保证有内容）', () => {
  const s = new VectorStore({ dim: 2 })
  for (let i = 0; i < 6; i++) add(s, '预算测试' + i + 'x'.repeat(80), [1, i * 0.01])
  const out = recall(s, new Float32Array([1, 0]), { now: NOW, maxResults: 6, budgetChars: 300 })
  const used = out.reduce((n, x) => n + x.piece.length, 0)
  assert.ok(out.length >= 1 && out.length < 6, `召回 ${out.length} 条`)
  assert.ok(used <= 300 + 220, `预算 ${used} 超了`) // 首条允许超出（保证有内容）
})

test('formatRecall：空数组空串；有内容带头注', () => {
  assert.equal(formatRecall([]), '')
  const s = new VectorStore({ dim: 2 })
  add(s, '能被召回', [1, 0])
  const text = formatRecall(recall(s, new Float32Array([1, 0]), { now: NOW }))
  assert.match(text, /你想起的相关往事/)
  assert.match(text, /今天/)
})

test('独白召回保留心里话边界，口头日记按说过的话标注', () => {
  const s = new VectorStore({ dim: 2 })
  const inner = makeDiaryChunk({ text: '他说肩膀酸，我想让他停一会儿。', at: NOW, meta: { kind: 'inner' } })
  const spoken = makeDiaryChunk({ text: '先起来走两分钟。', at: NOW, meta: { kind: 'spoken' } })
  assert.equal(s.append(inner, new Float32Array([1, 0])).ok, true)
  assert.equal(s.append(spoken, new Float32Array([0.9, 0.1])).ok, true)
  const results = recall(s, new Float32Array([1, 0]), { now: NOW, maxResults: 2 })
  const text = formatRecall(results)
  assert.match(text, /心里记下、未对用户说出/)
  assert.match(text, /不要逐字说出/)
  assert.match(text, /当时说过/)
})

test('scoreCandidates：库空 / 查询空不炸', () => {
  const s = new VectorStore({ dim: 2 })
  assert.deepEqual(scoreCandidates(s, new Float32Array([1, 0]), { now: NOW }), [])
  add(s, '甲', [1, 0])
  assert.deepEqual(scoreCandidates(s, null, { now: NOW }), [])
  assert.deepEqual(recall(new VectorStore({ dim: 2 }), new Float32Array([1, 0]), { now: NOW }), [])
})

/* ---------------- 摘要触发 ---------------- */

test('shouldSummarize / pickTurnsToSummarize / coveredTurnIds', () => {
  assert.equal(shouldSummarize({ turnsSince: 19 }), false)
  assert.equal(shouldSummarize({ turnsSince: 20 }), true)
  assert.equal(shouldSummarize({ turnsSince: 20, enabled: false }), false)

  const s = new VectorStore({ dim: 2 })
  const turns = []
  for (let i = 0; i < 25; i++) {
    const t = add(s, '轮次' + i, [1, i / 100], NOW + i * 1000)
    turns.push(t.c)
  }
  const fact = makeFactChunk({ text: '一条事实', at: NOW })
  assert.equal(s.append(fact, new Float32Array([1, 0])).ok, true)

  assert.equal(coveredTurnIds(s).size, 0)
  const picked = pickTurnsToSummarize(s, { count: 20 })
  assert.equal(picked.length, 20)
  assert.equal(picked[0].text, turns[5].text, '取最近 20 条')
  assert.ok(picked.every((c) => c.kind === 'turn'))

  // 加一条覆盖了最后 3 条的摘要 → 它们被排除
  const sum = makeSummaryChunk({ text: '摘要', covers: [turns[22].id, turns[23].id, turns[24].id], at: NOW })
  assert.equal(s.append(sum, new Float32Array([1, 0])).ok, true)
  const picked2 = pickTurnsToSummarize(s, { count: 20, covered: coveredTurnIds(s) })
  assert.equal(picked2.length, 20)
  assert.ok(!picked2.some((c) => c.id === turns[24].id))
})

/* ---------------- 待嵌计划 ---------------- */

test('planEmbedding：去重 + 批量上限 + 跳过无效项', () => {
  const s = new VectorStore({ dim: 2 })
  add(s, '已在库', [1, 0])
  const queue = [
    makeTurnChunk({ user: '已在库', assistant: '好的', at: NOW }), // 已在库 → skip
    { text: '', hash: '' }, // 无效 → skip
    makeTurnChunk({ user: '新甲', assistant: '在吗', at: NOW }),
    makeTurnChunk({ user: '新乙', assistant: '在吗', at: NOW }),
    makeTurnChunk({ user: '新丙', assistant: '在吗', at: NOW })
  ]
  const { toEmbed, skip } = planEmbedding(queue, s, { maxBatch: 2 })
  assert.equal(toEmbed.length, 2)
  assert.equal(skip.length, 2)
  assert.equal(toEmbed[0].text.includes('新甲'), true)
})

/* ---------------- 引擎注册表 ---------------- */

test('pickEmbedEngine：选择 + 可用性分支', () => {
  assert.equal(pickEmbedEngine({ provider: 'local', localReady: true }), 'local')
  assert.equal(pickEmbedEngine({ provider: 'local', localReady: false }), 'none')
  assert.equal(pickEmbedEngine({ provider: 'openai', hasKey: true }), 'openai')
  assert.equal(pickEmbedEngine({ provider: 'openai', hasKey: false }), 'none')
  assert.equal(pickEmbedEngine({ provider: 'none' }), 'none')
  assert.equal(pickEmbedEngine({}), 'none')
  assert.equal(EMBED_ENGINES.local.dim, 512)
  assert.equal(EMBED_ENGINES.none.dim, 0)
})

/* ---------------- 设置合并 ---------------- */

test('mergeRagSettings：默认值 / 钳制 / 脏输入', () => {
  assert.deepEqual(mergeRagSettings({}), DEFAULT_RAG_SETTINGS)
  assert.deepEqual(mergeRagSettings(null), DEFAULT_RAG_SETTINGS)
  const m = mergeRagSettings({ threshold: 99, maxResults: -3, provider: 'cloud', recallTimeoutMs: 'abc' })
  assert.equal(m.threshold, 0.9)
  assert.equal(m.maxResults, 1)
  assert.equal(m.provider, 'local')
  assert.equal(m.recallTimeoutMs, 2500)
  assert.equal(mergeRagSettings({ enabled: false }).enabled, false)
})

/* ---------------- 端到端：玩具嵌入器（关键词+同义词表） ---------------- */

const LEXICON = {
  睡眠: ['睡', '失眠', '睡不着', '困', '熬夜', '闭眼'],
  项目: ['项目', '桌宠', '上线', '发布会', '凪'],
  饮食: ['吃', '外卖', '奶茶', '减肥', '饭'],
  天气: ['天气', '下雨', '降温', '晴', '冷']
}
const LEX_KEYS = Object.keys(LEXICON)

/** 玩具嵌入器：按关键词计数造向量。只为演示语义召回，非真模型 */
function toyEmbed(text) {
  const v = new Float32Array(LEX_KEYS.length)
  LEX_KEYS.forEach((k, i) => {
    v[i] = LEXICON[k].reduce((n, w) => n + (String(text).includes(w) ? 1 : 0), 0)
  })
  return normalizeInPlace(v)
}

const DEMO_TURNS = [
  ['最近睡不好，脑子停不下来', '又失眠了吗。早点关电脑。'],
  ['桌宠项目下周要上线了', '恭喜。发布会讲得怎么样？'],
  ['晚上又点了外卖', '……你不是说这周不吃夜宵了。'],
  ['外面下雨了，有点冷', '多穿点，别又感冒。'],
  ['还是睡不着，好烦', '……要不要听点安静的。']
]

test('端到端（内存版）：入库 → 语义召回 → 格式化', () => {
  const s = new VectorStore({ dim: LEX_KEYS.length })
  for (const [u, a] of DEMO_TURNS) {
    const c = makeTurnChunk({ user: u, assistant: a, at: NOW - 30 * DAY })
    assert.equal(s.append(c, toyEmbed(c.text)).ok, true)
  }
  // 「失眠」问句 → 该召回「睡不好」那两轮，且不该混进外卖/天气
  const out = recall(s, toyEmbed('又失眠了怎么办'), { now: NOW, maxResults: 3 })
  assert.ok(out.length >= 2)
  assert.ok(
    out[0].text.includes('睡'),
    `首选该是睡眠相关，实际：${out[0].text}`
  )
  assert.ok(
    out.every((x) => x.text.includes('睡')),
    '前几条都该与睡眠有关'
  )
  const formatted = formatRecall(out)
  assert.match(formatted, /上个月/) // 30 天前
  assert.match(formatted, /他：/)
  // 完全无关的查询（空向量）→ 零召回
  assert.equal(recall(s, new Float32Array(LEX_KEYS.length), { now: NOW }).length, 0)
})

/* ---------------- 端到端：真实文件 IO（临时目录） ---------------- */

test('IO：appendEmbedded 落盘 → load 恢复；pending 队列；墓碑；compact；clear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-test-'))
  try {
    const dim = LEX_KEYS.length
    const io = new RagStoreIo(dir)
    const { store } = io.load(dim)
    assert.equal(store.count, 0)

    // 五条入库：先写 pending，再嵌入落档，再从 pending 摘掉
    const chunks = DEMO_TURNS.map(([u, a]) => makeTurnChunk({ user: u, assistant: a, at: NOW }))
    io.appendPending(chunks)
    assert.equal(io.readPending().length, 5)
    const { toEmbed } = planEmbedding(io.readPending(), store)
    assert.equal(toEmbed.length, 5)
    for (const item of toEmbed) {
      const r = store.append(item, toyEmbed(item.text))
      assert.equal(r.ok, true)
      io.appendEmbedded(item, store.rowVector(r.row))
    }
    io.rewritePending([])
    assert.equal(io.readPending().length, 0)

    // 重新开一个 io（模拟重启）
    const io2 = new RagStoreIo(dir)
    const { store: store2, repaired, dimMismatch } = io2.load(dim)
    assert.equal(dimMismatch, false)
    assert.deepEqual(repaired, { droppedVectorRows: 0, droppedChunkLines: 0, badLines: 0 })
    assert.equal(store2.count, 5)
    const found = recall(store2, toyEmbed('失眠'), { now: NOW, maxResults: 1 })
    assert.ok(found.length === 1 && found[0].text.includes('睡'))

    // 墓碑 + compact
    // 注意：DEMO_TURNS 里有两条睡眠相关（第 0 条和第 4 条），忘掉第 0 条后该只剩第 4 条
    const sleepBefore = recall(store2, toyEmbed('睡不好'), { now: NOW })
    assert.equal(sleepBefore.length, 2, '睡眠相关原本有两条')
    io2.appendTombstone(store2.chunkById(chunks[0].id), store2.rowBytes)
    const io3 = new RagStoreIo(dir)
    const { store: store3 } = io3.load(dim)
    assert.equal(store3.liveCount, 4)
    assert.equal(store3.hasHash(chunks[0].hash), false, '被忘掉的那条不该还能按内容检索到')
    const sleepAfter = recall(store3, toyEmbed('睡不好'), { now: NOW })
    assert.equal(sleepAfter.length, 1, '忘掉的内容不该被召回，只剩另一条睡眠对话')
    assert.equal(sleepAfter[0].id, chunks[4].id, '剩下的应是未被忘掉的那条')
    io3.compact(store3)
    assert.equal(store3.dead.size, 0)
    const io4 = new RagStoreIo(dir)
    const { store: store4 } = io4.load(dim)
    assert.equal(store4.liveCount, 4)
    assert.ok(io4.diskUsage() > 0)

    // 清空
    io4.clear()
    assert.equal(new RagStoreIo(dir).load(dim).store.count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('IO：崩溃对齐修复——chunk 行写了向量行没写，重启截齐且文本不丢（还在 pending）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-crash-'))
  try {
    const dim = 2
    const io = new RagStoreIo(dir)
    const { store } = io.load(dim)
    const c1 = makeTurnChunk({ user: '第一条', assistant: '在吗', at: NOW })
    assert.equal(store.append(c1, new Float32Array([1, 0])).ok, true)
    io.appendEmbedded(c1, store.rowVector(0))

    // 模拟崩溃：pending 里有第二条，chunks.jsonl 被追加了它的行，但向量没写
    const c2 = makeTurnChunk({ user: '第二条', assistant: '在吗', at: NOW })
    io.appendPending([c2])
    appendFileSync(io.chunksFile, JSON.stringify(c2) + '\n')

    const io2 = new RagStoreIo(dir)
    const { store: store2, repaired } = io2.load(dim)
    assert.equal(store2.count, 1, '半截行被截掉')
    assert.equal(repaired.droppedChunkLines, 1)
    // 关键：第二条的文本还在 pending 里，会重新嵌入，不丢
    const pending = io2.readPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].text, c2.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('IO：维度不符 → dimMismatch，文本全保留等重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-dim-'))
  try {
    const io = new RagStoreIo(dir)
    const { store } = io.load(2)
    const c = makeTurnChunk({ user: '维度测试', assistant: '在吗', at: NOW })
    assert.equal(store.append(c, new Float32Array([1, 0])).ok, true)
    io.appendEmbedded(c, store.rowVector(0))

    // 换个引擎（维度 4）打开：不该崩，文本还得在
    const io2 = new RagStoreIo(dir)
    const { store: store2, dimMismatch } = io2.load(4)
    assert.equal(dimMismatch, true)
    assert.equal(store2.liveCount, 1)
    assert.equal(store2.chunkById(c.id).text, c.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('IO：首次写入即记录维度——没走过 load 直接追加也不会被误判', () => {
  // 回归：appendEmbedded 原先不写 meta.json，于是「先追加、后 load」的库
  // 重启时 meta.dim 还是 0，会被当成维度不符（RAG 静默关闭）。
  const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-meta-'))
  try {
    const io = new RagStoreIo(dir)
    const store = new VectorStore({ dim: 2 })
    const c = makeTurnChunk({ user: '直接写', assistant: '在', at: NOW })
    assert.equal(store.append(c, new Float32Array([1, 0])).ok, true)
    io.appendEmbedded(c, store.rowVector(0))

    const { store: s2, dimMismatch } = new RagStoreIo(dir).load(2)
    assert.equal(dimMismatch, false, '不该被误判为维度不符')
    assert.equal(s2.count, 1)
    assert.equal(s2.chunks[0].text, c.text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('formatRecall 同时接受结果对象和片段字符串', () => {
  assert.equal(formatRecall([]), '')
  assert.match(formatRecall(['「昨天（10-14）：他：睡不好」']), /昨天（10-14）/)
  // 混着给也不崩，空片段自动跳过
  assert.match(formatRecall([{ piece: '「a」' }, '', null]), /「a」/)
  assert.equal(formatRecall(['', null]), '')
})
