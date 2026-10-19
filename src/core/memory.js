// src/core/memory.js
// 长期记忆的纯逻辑：格式化进提示词、解析模型吐出的增删指令、合并去重。
// 文件读写（userData/memory.json）在 main/memory-store.js，这里不碰 IO，方便单测。

/** 记忆条目上限（超出丢最旧的） */
export const MEMORY_LIMIT = 60

/** 单条记忆最长字符（防止模型吐长句子把提示撑爆） */
const MAX_TEXT = 60

/** 让模型从一轮对话里抽取"值得长期记住的事"的提示词 */
export const MEMORY_EXTRACT_PROMPT = [
  '你在维护一个长期记忆清单，记录「关于用户、值得以后还记得的事实」。',
  '输入是一轮对话。只抽取以后还用得上的信息，例如：',
  '  他的身份/在做的事、长期偏好、习惯、明确的约定、提到过的重要人和物、身体或作息状况。',
  '不要抽取：一次性的闲聊、情绪化的话、你自己说过的话、能从当下语境临时推理出来的东西。',
  '每条不超过 30 字，用第三人称陈述（例：「在做一款叫凪的桌宠项目」）。',
  '最多输出 2 条。没有任何值得记的就输出空数组。',
  '',
  '严格只输出 JSON，不要解释、不要 markdown 代码块：',
  '{"add": ["..."], "remove": ["..."]}',
  'add = 新增的记忆；remove = 应当作废的旧记忆（尽量逐字照抄已有记忆；拿不准就留空数组）',
  '',
  '补充：同一类属性（喜欢的颜色、住在哪座城市、名字、生日、在做的事）在同一时刻只有一个值。',
  '用户更正这类事实时，即使你不输出 remove，系统也会按属性把被取代的旧条目确定性作废——',
  '所以 remove 只是补充，漏了不会让旧事实继续生效。'
].join('\n')

/**
 * 记忆条目格式化为提示词用的短句数组。
 * @param {Array<{text?:string}>|string[]} entries
 * @returns {string[]}
 */
export function formatMemories(entries = []) {
  return entries
    .map((e) => (typeof e === 'string' ? e : e && e.text))
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim())
}

/**
 * 解析模型输出的 JSON（容错：去掉 ```json 围栏、截取首个 { ... } 片段）。
 * @returns {{add: string[], remove: string[]}}
 */
export function parseMemoryOps(raw) {
  const empty = { add: [], remove: [] }
  if (!raw || typeof raw !== 'string') return empty
  let s = raw.trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return empty
  let obj
  try {
    obj = JSON.parse(s.slice(start, end + 1))
  } catch {
    return empty
  }
  const pick = (v) =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, MAX_TEXT))
      : []
  return { add: pick(obj.add), remove: pick(obj.remove) }
}

/**
 * 合并增删指令并报告真实变化。纯函数。
 *
 * 与 applyMemoryOps 的区别：除了条目数组，还返回 changed/added/removed，
 * 供持久层按「内容变化」判断写盘（修复满额淘汰后数量不变导致不落盘的问题）。
 *
 * D1：`remove` 有两条来源——模型显式作废的旧记忆，以及**同属性槽被新事实
 * 取代**的旧记忆（`supersedeSameSlot`）。后者不依赖模型逐字复现，
 * 是撤权的主路径；前者降为补充。两者都以**原文**进 `removed`，
 * 好让调用方的删账本 / RAG 撤销能逐字对上。
 *
 * @param {Array<{id?:string,text:string,at?:number}>} entries
 * @param {{add?:string[],remove?:string[]}} ops
 * @param {number} now
 * @returns {{entries:Array, changed:boolean, added:string[], removed:string[]}}
 *   added   = 实际进入清单的新文本（去重跳过、超限淘汰不算"成功新增"）
 *   removed = 实际被删掉的旧文本（含同槽被取代）
 *   changed = 清单内容是否发生变化（含满额淘汰与无效条目清理）
 */
export function mergeMemoryEntries(entries = [], ops = {}, now = Date.now()) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim()
  const removeSet = new Set((ops.remove || []).map(norm))
  // D1：同属性槽旧事实被新事实确定性取代（不靠抽模型逐字复现 remove）
  const slotSet = new Set(supersedeSameSlot(entries, ops.add || []).map(norm))
  const removed = entries
    .filter((e) => e && typeof e.text === 'string' &&
      (removeSet.has(norm(e.text)) || slotSet.has(norm(e.text))))
    .map((e) => e.text.trim())
  let out = entries
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .filter((e) => !removeSet.has(norm(e.text)) && !slotSet.has(norm(e.text)))

  const seen = new Set(out.map((e) => norm(e.text)))
  const added = []
  for (const text of ops.add || []) {
    const n = norm(text)
    if (!n || seen.has(n)) continue
    seen.add(n)
    const entry = { id: 'm' + now.toString(36) + '_' + out.length, text: text.trim(), at: now }
    out.push(entry)
    added.push(entry.text)
  }

  if (out.length > MEMORY_LIMIT) out = out.slice(out.length - MEMORY_LIMIT)
  const changed = JSON.stringify(entries) !== JSON.stringify(out)
  return { entries: out, changed, added, removed }
}

/**
 * 应用增删指令，返回全新条目数组。纯函数。
 * - add：新条目入队；与已有条目（去空格后）相同则跳过
 * - remove：按原文精确匹配删除
 * - 超出上限丢最旧的（保留最新）
 * @param {Array<{id?:string,text:string,at?:number}>} entries
 * @param {{add?:string[],remove?:string[]}} ops
 * @param {number} now
 */
export function applyMemoryOps(entries = [], ops = {}, now = Date.now()) {
  return mergeMemoryEntries(entries, ops, now).entries
}

/* ================= D1：同属性槽撤权 ================= */

/**
 * 属性槽规则。**只收单值属性**——颜色、居住地、名字、生日、在做的事
 * 在同一时刻都只有一个值，新值落地时旧值必须让位。
 * 宠物、爱好清单这类**可多值**的属性故意不收：否则"养猫"会被"养狗"误撤，
 * 那等于用一条新红线换掉旧红线。顺序即优先级。
 *
 * **city 必须细分成两个子语义**（`city:current` 现居 / `city:home` 老家）：
 * 一个人同时有老家和现居，它们是**两个独立事实**，不是同一个值的两个版本。
 * 合成一个槽时，"我住的是上海"会把"我老家在北京"一并删掉——那是误删用户真记忆。
 * 子语义检查顺序是 **current 在前、home 在后**：一句话若同时含两类词
 * （"我老家杭州，现居北京"），它的"当前主张"是现居；归到 home 会与别的老家条目
 * 同槽而被误撤，归到 current 只会与别的现居条目同槽，错得起价更小。
 */
const CITY_CURRENT_RE = /(住在|住的?是|居住在|家住|常住|住址|搬[到去来]|迁[至到徙]|城市|现居)/
const CITY_HOME_RE = /(老家|故乡|籍贯|祖籍)/
const SLOT_RULES = [
  ['color', /(颜色|色彩|喜爱?的?色|偏爱的?色)/],
  // city 必须覆盖"我住的是上海"这类说法（绿区真机 correct 原文就是它）——
  // 只有"住在|居住"会漏。`住的?是` 刻意不写成裸 `住的`：
  // "我住的酒店"不是居住地陈述，而"我住的是上海"是。宁窄勿宽。
  ['city:current', CITY_CURRENT_RE],
  ['city:home', CITY_HOME_RE],
  ['name', /(名字|姓名|昵称|名叫|叫我|他叫|我叫)/],
  ['birthday', /(生日|出生|生辰|星座)/],
  ['occupation', /(职业|工作|上班|在公司|岗位|在做|搞开发|写代码|创业)/]
]

/**
 * 值域词表。旧记忆常把属性词省掉——"喜欢蓝色"不会写成"喜欢的颜色是蓝色"，
 * 只靠关键词规则认不出它和"喜欢的颜色是绿色"是同槽。
 * 只有**颜色**需要它：城市这类开放值域硬编码必然漏，宁可不认也不瞎猜。
 */
const VALUE_SLOT_RULES = [
  ['color', /(?:[红橙黄绿青蓝紫灰白粉金银棕黑]{1,2}色|(?:喜欢|喜爱|偏爱|偏好|最爱|是|买|穿|要)[红橙黄绿青蓝紫灰白粉金银棕黑]{1,2})/]
]

/** 谓词：两条 claim 在说同一件事的佐证。刻意不含"是/有"这类万能字。 */
const PREDICATE_RE = /(喜欢|喜爱|偏爱|偏好|想要|希望|讨厌|住|居住|在工作|上班|在做|搞|叫|养|戴|用|吃|听|看|玩|买|穿)/

/** 自称/指代：这条 claim 是否在说用户自己的事。记忆系统按契约只存这类。 */
const USER_MARKER_RE = /(我|用户|他|本人|自己|主人)/

/**
 * 一条记忆文本属于哪个属性槽；认不出返回 null（认不出就绝不做同槽撤权）。
 * @returns {string|null}
 */
export function memorySlot(text) {
  const s = String(text == null ? '' : text)
  if (!s.trim()) return null
  for (const [slot, re] of SLOT_RULES) if (re.test(s)) return slot
  for (const [slot, re] of VALUE_SLOT_RULES) if (re.test(s)) return slot
  return null
}

const hasSlotKeyword = (text, slot) => {
  const rule = SLOT_RULES.find(([s]) => s === slot)
  return rule ? rule[1].test(text) : false
}

/** 两条文本是否共享同一个谓词（不是"各有一个谓词"） */
function sharesPredicate(a, b) {
  const g = new RegExp(PREDICATE_RE.source, 'g')
  const inB = new Set(String(b).match(g) || [])
  return (String(a).match(g) || []).some((p) => inB.has(p))
}

/** 这条 claim 是否在说用户自己的事。"桌宠是蓝色的"这类不算——它不是用户的属性。 */
const isUserClaim = (text) => USER_MARKER_RE.test(text) || PREDICATE_RE.test(text)

/**
 * 取出值域词表槽里的"值"（颜色字）；取不出返回 null。
 * 用来区分"改版"（蓝→绿）和"同一件事换了个说法"（喜欢蓝色 / 喜欢的颜色是蓝色）——
 * 后者不是更正，撤它就是白丢信息。
 *
 * 两条容易漏的规则：
 * 1. **先剔掉被否定的值**："我喜欢的不是蓝色是绿色"里"蓝色"是**被否掉的旧值**。
 *    若按第一个匹配取值会拿到"蓝色"、与旧条目相同，整条撤权就被判据⑤误放过去——
 *    这正是绿区 color case 的 correct 原文，漏了它 D1 等于没修。
 * 2. **取最后一个而非第一个**：中文里主张的值通常落在句尾（"…是绿色"）。
 *    两者叠加：否定过滤处理"不是X"，取末尾处理"更正为Y"。
 */
function lexiconValue(text, slot) {
  if (slot !== 'color') return null
  const s = String(text == null ? '' : text)
  const COLOR = '[红橙黄绿青蓝紫灰白粉金银棕黑]{1,2}色'
  const negated = new Set()
  for (const m of s.matchAll(new RegExp('(?:不是|并非|不再是|没有|别是|而非)\\s*(' + COLOR + ')', 'g'))) {
    negated.add(m[1])
  }
  const all = [...s.matchAll(new RegExp(COLOR, 'g'))].map((m) => m[0])
  const live = all.filter((v) => !negated.has(v))
  return (live.length ? live : all).at(-1) || null
}

/**
 * D1：同属性槽的旧事实，在新事实落盘时**确定性**被取代（版本化）。
 *
 * 为什么需要它：撤权原先只靠抽模型在 `remove` 里逐字复现旧条目
 * （`mergeMemoryEntries` 按去空白精确匹配）。真机 temp=1.3 下模型被纠正时
 * 只 `add` 新事实、不复现旧文本，于是旧条目原样留在 live 记忆里，
 * 重启后照样进 system 的"你记得的关于他的事"——EVAL §0"删除后复述"
 * 红线在数据层成立（绿区 2026-10-19 两 case 真机铁证）。
 *
 * 判据（全部满足才撤；**宁可漏撤，不可误删**）：
 *   1. 新事实能归到某个属性槽 —— 认不出槽就什么都不做；
 *   2. 旧条目归到**同一个**槽且文本确实不同 —— 跨槽天然安全，
 *      改颜色不会碰到城市，这正是要守住的那条；
 *   3. 旧条目是**关于用户自己的 claim** —— 挡掉"桌宠是蓝色的"这类
 *      只是沾了值域词的无关条目；
 *   4. 两条共享同一个谓词，或双方都有显式属性词 ——
 *      再挡掉"我穿蓝色衣服"被"我喜欢红色"顺手删掉这类同域不同事；
 *   5. 值确实变了（能取出值域值时）—— "喜欢蓝色"与"喜欢的颜色是蓝色"
 *      是同一件事的两种说法，不是改版，撤它就是白丢信息。
 *
 * 模型的 `remove` 仍然是补充路径，但不再是唯一路径。
 *
 * @param {Array<{id?:string,text:string}>} entries 当前 live 记忆
 * @param {string[]} addTexts 本轮要新增的文本
 * @returns {string[]} 应被撤权的旧条目**原文**（删 ledger / RAG 都要逐字对上）
 */
export function supersedeSameSlot(entries = [], addTexts = []) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').trim()
  const adds = (addTexts || []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean)
  if (!adds.length) return []
  const victims = new Map()
  for (const newText of adds) {
    const slot = memorySlot(newText)
    if (!slot) continue
    const newExplicit = hasSlotKeyword(newText, slot)
    const newValue = lexiconValue(newText, slot)
    for (const e of entries || []) {
      if (!e || typeof e.text !== 'string') continue
      const oldText = e.text.trim()
      if (!oldText || norm(oldText) === norm(newText)) continue
      if (memorySlot(oldText) !== slot) continue
      if (!isUserClaim(oldText)) continue
      const bothExplicit = newExplicit && hasSlotKeyword(oldText, slot)
      if (!bothExplicit && !sharesPredicate(oldText, newText)) continue
      // 同一个值 = 同一件事的两种说法，不是改版
      const oldValue = lexiconValue(oldText, slot)
      if (oldValue && newValue && oldValue === newValue) continue
      victims.set(norm(oldText), oldText)
    }
  }
  return [...victims.values()]
}
