// scripts/rag-demo.mjs
// 记忆档案（RAG）全链路演示：纯 node 直跑，不需要 Electron、不需要下载模型。
//
//   node scripts/rag-demo.mjs
//
// 覆盖「存储 / 索引 / 相似度 / 检索」四件事，一步一步打印出来看：
//   ① 向量数据的存储（userData/rag 四件套：meta / vectors.bin / chunks.jsonl / pending.jsonl）
//   ② 索引构建（追加写入 + 崩溃半截的对齐修复 + 待嵌队列补齐）
//   ③ 相似度计算（归一化后 cosine = 点积；时间衰减 + 类型权重 + MMR 去冗余）
//   ④ 检索查询（阈值 → 排序 → 预算截断 → 带时间感的提示词段落）
//
// ⚠ 嵌入器是「玩具版」：把文本映射到五个话题方向（睡眠/项目/吃饭/天气/情绪）。
//    换成真实的 bge-small-zh-v1.5（512 维）后，下面每一行代码都不用改——
//    因为存储、索引、检索全都只认「一个 Float32 向量」，与向量怎么算出来的无关。

import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VectorStore,
  makeTurnChunk,
  makeFactChunk,
  makeSummaryChunk,
  planEmbedding,
  coveredTurnIds,
  pickTurnsToSummarize,
  recall,
  scoreCandidates,
  timeLabel,
  formatRecall,
  normalizeInPlace
} from '../src/core/rag/index.js'
import { RagStoreIo } from '../src/main/rag/store-io.js'

const DIM = 128
const DAY = 86400000
const NOW = Date.now()

/* ---------------- 玩具嵌入器：五个话题方向 ---------------- */

const TOPICS = {
  睡眠: ['睡', '失眠', '觉', '梦', '困', '半夜'],
  项目: ['项目', '上线', '发布', '需求', '代码', 'bug', '排期'],
  吃饭: ['吃', '外卖', '夜宵', '饭', '饿', '面', '咖啡'],
  天气: ['雨', '冷', '风', '雪', '热', '气温'],
  情绪: ['烦', '累', '压力', '崩', '焦虑', '撑不住']
}

/** mulberry32：32 位整数安全的小 PRNG（别用 a*b+c 那套——超过 2^53 会丢精度，随机性塌掉） */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 话题名 → 确定性伪随机单位向量。128 维里 5 个方向基本互相垂直（cos ≈ ±0.09） */
const UNITS = new Map()
Object.keys(TOPICS).forEach((name, i) => {
  const rnd = mulberry32((i + 1) * 0x9e3779b9)
  const v = new Float32Array(DIM)
  for (let k = 0; k < DIM; k++) v[k] = rnd() * 2 - 1
  normalizeInPlace(v)
  UNITS.set(name, v)
})

/** 文本 → 向量：命中的话题按次数加权叠加（一个话题词都没命中 → 零向量，检索时自然不召回） */
function embed(text) {
  const s = String(text || '')
  const v = new Float32Array(DIM)
  let hit = 0
  for (const [name, words] of Object.entries(TOPICS)) {
    let n = 0
    for (const w of words) n += s.split(w).length - 1
    if (!n) continue
    hit += n
    const u = UNITS.get(name)
    const wgt = Math.min(n, 3) // 词频封顶：同一句话里反复出现一个词不该把方向带跑偏
    for (let k = 0; k < DIM; k++) v[k] += u[k] * wgt
  }
  if (!hit) return v
  normalizeInPlace(v)
  return v
}

function dot(x, y) {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * y[i]
  return s
}

/* ---------------- 演示骨架 ---------------- */

let step = 0
let failed = 0
const head = (t) => console.log(`\n${'─'.repeat(66)}\n${++step}. ${t}\n${'─'.repeat(66)}`)
const ok = (m) => console.log('   ✓', m)
const bad = (m) => {
  failed++
  console.log('   ✗', m)
}
const check = (c, m) => (c ? ok(m) : bad(m))
const line = (s) => console.log('   ' + s)

/* ---------------- 造语料 ---------------- */

const SAMPLES = {
  睡眠: [
    ['最近睡不好，脑子停不下来', '又失眠了吗。早点关电脑。'],
    ['还是睡不着，好烦', '……要不要听点安静的。'],
    ['昨晚做梦梦到考试了', '你毕业好几年了吧。'],
    ['半夜三点还醒着', '……数羊有用吗？']
  ],
  项目: [
    ['桌宠项目下周要上线了', '恭喜。发布会讲得怎么样？'],
    ['需求又改了，排期要崩', '……要不我先别问了。'],
    ['这个 bug 找了一下午', '要不要先放一放。'],
    ['代码写完了一半', '那还剩一半。']
  ],
  吃饭: [
    ['晚上又点了外卖', '……你不是说这周不吃夜宵了。'],
    ['中午就吃了个面包', '难怪你现在喊饿。'],
    ['咖啡喝太多了', '晚上又该睡不着了。'],
    ['想吃碗热的面', '那就去吃，别光说。']
  ],
  天气: [
    ['外面下雨了，有点冷', '多穿点，别又感冒。'],
    ['今天热得受不了', '空调别开太低。'],
    ['刮了一天的风', '窗户关了没。'],
    ['下雪了，路很滑', '慢点走。']
  ],
  情绪: [
    ['感觉有点撑不住了', '……那就先别撑着。'],
    ['压力好大', '要不要先说说是哪件事。'],
    ['今天特别烦', '我在这儿。'],
    ['累得不想说话', '那就不用说话。']
  ]
}

/** 中性前缀：不含任何话题词，只用来让 200 条文本互不相同（否则会被内容去重合并掉） */
const PREFIX = ['', '（那天早上）', '（午休的时候）', '（下班路上）', '（刚到家）', '（在公司）', '（周末下午）', '（周日晚上）', '（开会间隙）', '（洗完澡后）']

function makeCorpus(n, days = 200) {
  const names = Object.keys(SAMPLES)
  const out = []
  for (let i = 0; i < n; i++) {
    const topic = names[i % names.length]
    const pair = SAMPLES[topic][Math.floor(i / names.length) % SAMPLES[topic].length]
    const prefix = PREFIX[Math.floor(i / (names.length * SAMPLES[topic].length)) % PREFIX.length]
    const at = NOW - Math.round(((n - i) / n) * days * DAY)
    out.push({ topic, chunk: makeTurnChunk({ user: prefix + pair[0], assistant: pair[1], at }) })
  }
  return out
}

/* ---------------- 入库：写盘 + 内存同步（与 RagService.embedPending 同构） ---------------- */

/** 嵌一条并同时落盘（顺序：先 chunk 行、后向量行） */
function add(io, store, chunk) {
  const r = store.append(chunk, embed(chunk.text))
  if (r.ok) io.appendEmbedded(chunk, store.rowVector(r.row))
  return r
}

/** 把一批文本写进待嵌队列 → 批量嵌入 → 落档 → 从队列摘掉（批量 64，循环到空） */
function ingestAll(io, store, items) {
  io.appendPending(items)
  let total = 0
  for (;;) {
    const queue = io.readPending()
    if (!queue.length) break
    const { toEmbed, skip } = planEmbedding(queue, store, { maxBatch: 64 })
    if (!toEmbed.length) {
      io.rewritePending([])
      break
    }
    const done = new Set(skip.map((x) => x.id))
    for (const item of toEmbed) {
      if (add(io, store, item).ok) total++
      done.add(item.id)
    }
    io.rewritePending(queue.filter((x) => !done.has(x.id)))
  }
  return total
}

/* ---------------- 开始 ---------------- */

console.log('记忆档案（RAG）全链路演示 —— 纯 node，真实运行时目录是 userData/rag')

const dir = mkdtempSync(join(tmpdir(), 'nagi-rag-demo-'))
const io = new RagStoreIo(dir)
let store = new VectorStore({ dim: DIM })

try {
  /* ---- 1. 存储结构 ---- */
  head('存储结构：四个文件各管一件事')
  line(`目录 ${dir}`)
  line(`meta.json     维度 / 模型对齐信息（当前 dim=${DIM}）`)
  line('vectors.bin   向量本体，Float32 连续存放，只追加')
  line('chunks.jsonl  每行一条元数据，与 vectors.bin 行号严格对齐')
  line('pending.jsonl 还没嵌入的文本（装好模型后自动补齐）')
  store = io.load(DIM).store
  check(store.count === 0, '空目录开局：0 条')

  /* ---- 2. 索引构建 ---- */
  head('索引构建：200 条对话 → 追加写入')
  const corpus = makeCorpus(200)
  const written = ingestAll(io, store, corpus.map((x) => x.chunk))
  check(written === 200, `写入 ${written} 条向量（内容去重后仍为 200，说明语料互不相同）`)
  check(io.readPending().length === 0, '待嵌队列已清空')
  const vecBytes = existsSync(io.vectorsFile) ? statSync(io.vectorsFile).size : 0
  line(`vectors.bin = ${vecBytes} 字节`)
  check(vecBytes === 200 * DIM * 4, `正好 行数 × 维度 × 4 = ${200 * DIM * 4}（没有多余头信息）`)

  /* ---- 3. 相似度 ---- */
  head('相似度计算：入库时已 L2 归一化，cosine 就是点积')
  const a = embed('最近睡不好')
  const b = embed('还是睡不着')
  const c = embed('外面下雨了')
  line(`cos(睡不好, 睡不着) = ${dot(a, b).toFixed(4)}`)
  line(`cos(睡不好, 下雨了) = ${dot(a, c).toFixed(4)}`)
  check(dot(a, b) > 0.9, '同一件事 → 高度相似')
  check(dot(a, c) < 0.32, '不相干 → 低于 0.32 门限，根本不会进候选')

  /* ---- 4. 检索 ---- */
  head('检索查询：问她一句，看她想起什么')
  const q1 = recall(store, embed('我最近睡得怎么样'), { now: NOW, maxResults: 4 })
  line(formatRecall(q1).replace(/\n/g, '\n   '))
  check(q1.length === 4, `召回 ${q1.length} 条`)
  check(
    q1.every((r) => !/下雨|刮风|热得|下雪|气温/.test(r.text)),
    '没有混进天气那几轮'
  )
  check(q1.filter((r) => /睡|梦|困|失眠/.test(r.text)).length >= 3, '四条里至少三条确实是睡眠相关')

  const q2 = recall(store, embed('那个 bug 修好了吗'), { now: NOW, maxResults: 3 })
  line(formatRecall(q2).replace(/\n/g, '\n   '))
  check(q2.every((r) => /bug|项目|需求|代码|上线|排期/.test(r.text)), '换一个问题，命中的全变成项目那几轮')

  /* ---- 5. 时间衰减 ---- */
  head('时间衰减：近的排前面，远的还在，只是沉下去了')
  add(io, store, makeTurnChunk({ user: '今晚只吃了个苹果', assistant: '……这也叫晚饭？', at: NOW }))
  const q3 = recall(store, embed('我吃了什么'), { now: NOW, maxResults: 3 })
  for (const r of q3) line(`${r.label.padEnd(18)} score=${r.score.toFixed(3)}  ${r.text.replace(/\s+/g, ' ').slice(0, 26)}`)
  check(q3[0].at >= q3[q3.length - 1].at, '今天的排第一')

  // 关键设计：阈值卡在「语义相似度」上，衰减只影响排序
  const cands = scoreCandidates(store, embed('我吃了什么'), { now: NOW })
  const oldest = corpus.filter((x) => x.topic === '吃饭')[0]
  check(
    cands.some((c) => c.id === oldest.chunk.id),
    `${timeLabel(oldest.chunk.at, NOW)} 那条仍在候选里（语义过关就留着，不看年纪）`
  )
  const afterDecay = cands.filter((c) => c.score >= 0.32).length
  check(
    cands.length > afterDecay,
    `语义相关 ${cands.length} 条；若改成「衰减后再卡阈值」，只剩 ${afterDecay} 条 —— 半年以上的记忆会被静默删掉`
  )
  line('→ 衰减只影响排序，不做淘汰：一年前的记忆不会「过期消失」。')

  /* ---- 6. MMR ---- */
  head('MMR 去冗余：λ 越大越像「按相关性硬排」，越小越追求「别重复」')
  for (let i = 0; i < 5; i++) {
    add(
      io,
      store,
      makeTurnChunk({ user: '睡不着怎么办' + '啊'.repeat(i), assistant: '数羊吧。', at: NOW - i * 60000 })
    )
  }
  const greedy = recall(store, embed('睡不着'), { now: NOW, maxResults: 3, lambda: 0.95 })
  const balanced = recall(store, embed('睡不着'), { now: NOW, maxResults: 3, lambda: 0.7 })
  const diverse = recall(store, embed('睡不着'), { now: NOW, maxResults: 3, lambda: 0.3 })
  for (const [name, rs] of [
    ['λ=0.95', greedy],
    ['λ=0.70（默认）', balanced],
    ['λ=0.30', diverse]
  ]) {
    line(`${name}：${rs.map((r) => r.text.replace(/\s+/g, ' ').slice(0, 12)).join(' / ')}`)
  }
  const nSheep = (rs) => rs.filter((r) => r.text.includes('数羊')).length
  check(nSheep(greedy) === 3, 'λ=0.95：三条全被「数羊」复读占满')
  check(nSheep(diverse) < 3, `λ=0.30：复读只占 ${nSheep(diverse)} 条，额度让给了别的话题`)

  /* ---- 7. 类型权重 ---- */
  head('类型权重：提炼过的「事实」比原始对话更该被想起（1.15 vs 1.0）')
  // 与上面 5 条复读同属睡眠话题、同样是今天、向量方向相同——唯一的差别是类型
  add(io, store, makeFactChunk({ text: '他长期失眠，晚上要靠褪黑素', at: NOW }))
  const q5 = recall(store, embed('为什么我总是睡不着'), { now: NOW, maxResults: 4 })
  check(q5[0].kind === 'fact', `排第一的是 fact（${q5[0].kind}）`)
  line(`fact：${q5[0].text}`)
  line(`次条：${q5[1].kind} — ${q5[1].text.replace(/\s+/g, ' ').slice(0, 24)}`)

  /* ---- 8. 滚动摘要 ---- */
  head('滚动摘要：压成一条，原轮次降权 0.8（仍可检索，只是靠后——不删）')
  const covBefore = coveredTurnIds(store)
  const turns = pickTurnsToSummarize(store, { count: 20, covered: covBefore })
  const sum = makeSummaryChunk({
    text: '这段时间他在赶桌宠项目上线，需求反复改、bug 难查，睡得越来越差，也开始吃夜宵。',
    covers: turns.map((x) => x.id),
    at: NOW
  })
  add(io, store, sum)
  const covAfter = coveredTurnIds(store)
  check(covAfter.size > covBefore.size, `被摘要覆盖的轮次：${covBefore.size} → ${covAfter.size}`)
  const q6 = recall(store, embed('项目上线'), { now: NOW, maxResults: 3, covered: covAfter })
  check(q6.length > 0, '原文照旧能检索到（摘要是降权，不是删除）')

  /* ---- 9. 重启 ---- */
  head('重启：从磁盘重新载入，一条不少')
  const io2 = new RagStoreIo(dir)
  const { store: s2, repaired, dimMismatch } = io2.load(DIM)
  check(dimMismatch === false, '维度一致')
  check(!repaired.badLines && !repaired.droppedChunkLines, '没有坏行、没有半截')
  check(s2.liveCount === store.liveCount, `重启后 ${s2.liveCount} 条（重启前 ${store.liveCount}）`)
  const q7 = recall(s2, embed('我最近睡得怎么样'), { now: NOW, maxResults: 2 })
  check(q7.length > 0, `重启后照样检索得到：${q7[0].label}`)

  /* ---- 10. 遗忘 ---- */
  head('遗忘：追加一行墓碑，不是重写整个文件')
  const victim = s2.liveChunks().find((x) => x.kind === 'fact')
  const liveBefore = s2.liveCount
  s2.remove(victim.id)
  io2.appendTombstone(victim, s2.rowBytes)
  const { store: s3 } = new RagStoreIo(dir).load(DIM)
  check(s3.liveCount === liveBefore - 1, `活条目 ${liveBefore} → ${s3.liveCount}`)
  check(s3.hasHash(victim.hash) === false, '按内容也检索不到了')
  check(
    recall(s3, embed(victim.text), { now: NOW }).every((r) => r.id !== victim.id),
    `「${victim.text}」已从召回结果里消失`
  )

  /* ---- 11. compact ---- */
  head('整理：compact 把墓碑行真正清掉（行号前移、索引重建）')
  const io3 = new RagStoreIo(dir)
  const before = s3.count // 209 行 = 207 活条目 + 1 条被忘掉的 + 1 行墓碑
  io3.compact(s3)
  const { store: s4 } = new RagStoreIo(dir).load(DIM)
  check(s4.dead.size === 0, '墓碑清零')
  check(s4.count === s3.liveCount, `行数 ${before} → ${s4.count}（= 活条目数，墓碑行与被忘掉那条一起清掉）`)
  check(recall(s4, embed('睡不好'), { now: NOW }).length > 0, '整理后检索依然正常')

  /* ---- 12. 崩溃对齐 ---- */
  head('崩溃对齐：写到一半断电，重启自动截齐，且文本不丢')
  const dir2 = mkdtempSync(join(tmpdir(), 'nagi-rag-crash-'))
  try {
    const ioC = new RagStoreIo(dir2)
    const items = makeCorpus(3).map((x) => x.chunk)
    ioC.appendPending(items)
    // 模拟「chunk 行写了、向量行还没写」——正是写入顺序刻意保证的唯一半截状态
    ioC.appendEmbedded(items[0], embed(items[0].text))
    ioC.appendEmbedded(items[1], embed(items[1].text))
    ioC.rewritePending([items[2]])
    const { store: sC2, dimMismatch: dm2 } = new RagStoreIo(dir2).load(DIM)
    check(dm2 === false, '维度没有被误判（meta 在首次写入时就记下了 dim）')
    check(sC2.count === 2, `截齐到 ${sC2.count} 行（chunk 与向量重新对齐）`)
    check(new RagStoreIo(dir2).readPending().length === 1, '没写完那条还在待嵌队列，下次启动补上')
    check(recall(sC2, embed(items[1].text), { now: NOW }).length > 0, '已落盘的两条检索正常')
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  /* ---- 13. 维度不符 ---- */
  head('换引擎（维度变了）：文本全保留，等重建')
  check(new RagStoreIo(dir).load(DIM * 2).dimMismatch === true, '检测到维度不符 → 召回暂停')
  const { store: s5 } = new RagStoreIo(dir).load(1) // dim=1 打开只为把文本全读出来
  check(s5.liveChunks().length > 100, `chunks.jsonl 里 ${s5.liveChunks().length} 条文本一条没丢，点「重建索引」即可重新嵌入`)

  /* ---- 14. 清空 ---- */
  head('清空')
  const io6 = new RagStoreIo(dir)
  io6.clear()
  const { store: s6 } = new RagStoreIo(dir).load(DIM)
  check(s6.count === 0, '档案已清空')
  check(new RagStoreIo(dir).readPending().length === 0, '待嵌队列也空了')
  check(!existsSync(io6.vectorsFile), 'vectors.bin 已删除')

  /* ---- 收尾 ---- */
  console.log(`\n${'─'.repeat(66)}`)
  if (failed) {
    console.log(`演示结束：${failed} 项不符合预期`)
    process.exitCode = 1
  } else {
    console.log('演示结束：全部符合预期')
    console.log('')
    console.log('把玩具嵌入器换成真实模型（bge-small-zh-v1.5，512 维）后，上面每一步')
    console.log('的代码都不用改——接口只认「一个 Float32 向量」。')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
