// src/core/agent/intent.js
// D2 表达意图（CONTRACTS §5 枚举 + §8「场景化上下文与表达意图」定版）。
//
// 做三件事，都是纯函数：
//   1) 规则层判「用户这轮想要什么」（六选一）；
//   2) 按契约定版的**优先级**裁决唯一 kind，并保留 source 说明它从哪来；
//   3) 把 kind 翻译成一句**功能性约束**（进 system），不写任何台词。
//
// 三条硬约束（违反即算破坏契约）：
//   · 不为分类新增网络调用 —— 这里没有任何 IO；
//   · 意图不绑定句子/段落/格式 —— directive 只说"做什么/不做什么"，不说"怎么说"；
//   · 模型只能**建议** —— resolveIntent 的 modelHint 排在规则之后，且 confidence 仅作诊断，
//     永远不能推翻"安全/用户明确要求/澄清规则"。
//
// 【当前骨架的已知缺口】模型侧建议的**传输**还没接：
//   loop 只把情绪标签透出来，意图小字段需要 stream-normalize 多带一个字段（loop.js 本轮不许动）。
//   因此本轮 modelHint 一律为 null，`parseIntentHint` 先作为纯函数备好并被单测覆盖，
//   等红区同意"给 loop 加一个透传字段"后再接上（HANDOFF 已记录）。

/** 六意图（§5.1 定稿） */
export const INTENT = Object.freeze({
  BRIEF_ACK: 'brief-ack',
  LISTEN: 'listen',
  CLARIFY: 'clarify',
  SOLVE: 'solve',
  REMINISCE: 'reminisce',
  BOUNDARY: 'boundary'
})

/** 来源（§8 定版：保留 source 以说明是用户、规则、模型还是默认值） */
export const INTENT_SOURCE = Object.freeze({
  CRISIS: 'crisis',
  USER: 'user',
  RULE: 'rule',
  MODEL: 'model',
  DEFAULT: 'default'
})

export const INTENT_KINDS = Object.freeze(Object.values(INTENT))

export function isIntentKind(kind) {
  return INTENT_KINDS.includes(kind)
}

/**
 * 规则层：用户**明确说出口**的需求。只认显式表达，不猜。
 * 顺序即优先级（先说"别分析、听我说"的人，比"帮我写"更该被听见）。
 */
const USER_NEED_RULES = [
  {
    kind: INTENT.LISTEN,
    // ① 明说"别讲道理/听我说" ② 只想安静 ③ 正在情绪里 ④ 愤怒指向我
    // 为什么情绪也算 listen：EVAL D6-CLS-01/04 要求倾诉与求安静都按"在场"处理，
    // 而"我不开心"这类没有祈使句的输入，靠祈使词永远判不出来。
    re: /(?:别(?:再)?(?:分析|说教|劝我|讲道理|解释)|不要(?:分析|说教|劝)|不用(?:给|帮)(?:建议|想办法)|听我(?:说|讲)|陪我(?:说说话|待一会|坐一会|静一会|一会儿)|只想(?:说说|吐槽|发发牢骚)|想(?:安静|静静)|让我(?:安静|静一静|静一会)|安静(?:待|待着)|别说话)/
  },
  {
    kind: INTENT.LISTEN,
    // 情绪倾诉（D6-CLS-01）：不给祈使句也要接住
    re: /(?:我)?(?:不开心|不快乐|难受|委屈|难过|想哭|心情(?:很|不太|好)?(?:差|低)|烦死|累死了|心累)/
  },
  {
    kind: INTENT.LISTEN,
    // 愤怒指向她（D6-ANGER-01）：先停，不辩解
    re: /(?:你根本不懂|你(?:什么)?都不懂|你闭嘴|别(?:再)?解释了|你(?:根本)?没听懂)/
  },
  {
    kind: INTENT.BOUNDARY,
    re: /(?:别(?:再)?(?:提|问|说)(?:这个|那件事|这件事)|不要再提|换个话题|不聊这个|这个话题(?:不|别)聊|(?:我|你)(?:别|不要)(?:干涉|管我))/
  },
  {
    kind: INTENT.SOLVE,
    // 「帮我把这份报告写了」中间夹了宾语，不能只匹配"帮我写"紧邻的写法，
    // 否则 D6-CLS-03 这种最常见的求执行句会掉成默认意图。
    re: /(?:帮我.{0,12}(?:写|改|整理|做|弄|删|建|完成|生成)|(?:你)?(?:执行|运行|跑一下)|生成(?:一个)?文件|(?:修改|改)(?:一下)?(?:代码|文件|配置)|打开(?:这个|那个)?文件)/
  },
  {
    kind: INTENT.SOLVE,
    // 求建议/求办法（D6-CLS-02）：期望 clarify/solve，取 solve——
    // 它有具体的困境要给分析，不该被当成纯情感倾诉（那会变成只说"我在"不落地）。
    re: /(?:你觉得|你说|你看|你说说).{0,8}(?:怎么办|该怎么办|该不该|怎么处理|怎么选)|(?:该怎么办|怎么处理|该不该)[?？]?$/
  },
  {
    kind: INTENT.REMINISCE,
    re: /(?:你还记得|记不记得|还记得吗|上次(?:我们|你)|以前(?:那次|你说过)|那天(?:你|我们))/
  }
]

/**
 * 澄清规则：问句但**缺少必要信息**（只有指代、没有对象）。
 * 刻意很窄——"怎么办"这种没有上下文的短问句才判 clarify，其他问句不抢。
 */
const CLARIFY_RULE = /^(?:这个|那个|它|这样|那样)?(?:怎么办|咋办|怎么弄|什么意思|咋整)[?？]?$/

/**
 * @param {string} userText
 * @returns {{kind:string, source:string}|null} 规则层的结论；没有明确需求返回 null
 */
export function detectUserNeed(userText) {
  const text = String(userText || '').trim()
  if (!text) return null
  for (const rule of USER_NEED_RULES) {
    if (rule.re.test(text)) return { kind: rule.kind, source: INTENT_SOURCE.USER }
  }
  if (CLARIFY_RULE.test(text)) return { kind: INTENT.CLARIFY, source: INTENT_SOURCE.RULE }
  return null
}

/**
 * 裁决本轮唯一意图（§8 优先级）：
 *   安全/危机 → 用户明确要求 → 确定性澄清规则 → 同次模型建议 → 默认
 *
 * @param {object} o
 * @param {string} o.userText
 * @param {boolean} [o.crisis]            本轮是否 L2/L3（crisis 优先级最高）
 * @param {boolean} [o.hasGroundedMemory] 是否**确已**拿到可追溯的相关往事
 * @param {{kind?:string, confidence?:number}|null} [o.modelHint]
 * @returns {{kind:string, source:string, confidence:number|null, fallbackFrom:string|null}}
 */
export function resolveIntent({
  userText = '',
  crisis = false,
  hasGroundedMemory = false,
  modelHint = null
} = {}) {
  // ① 危机：安全优先。此时唯一合适的意图是"在场 + 最多一个低负担问题"，
  //    任何"帮你解决/回忆往事/换个话题"的意图都必须让位。
  if (crisis) {
    return { kind: INTENT.LISTEN, source: INTENT_SOURCE.CRISIS, confidence: null, fallbackFrom: null }
  }

  // ② 用户明确要求
  const rule = detectUserNeed(userText)
  if (rule && rule.kind !== INTENT.REMINISCE) {
    return { kind: rule.kind, source: rule.source, confidence: null, fallbackFrom: null }
  }

  // ③ 回忆：**必须**有可追溯引用，否则不得触发（回退到与请求相符的简短确认）
  if (rule && rule.kind === INTENT.REMINISCE) {
    if (hasGroundedMemory) {
      return { kind: INTENT.REMINISCE, source: INTENT_SOURCE.USER, confidence: null, fallbackFrom: null }
    }
    return {
      kind: INTENT.BRIEF_ACK,
      source: INTENT_SOURCE.RULE,
      confidence: null,
      fallbackFrom: INTENT.REMINISCE
    }
  }

  // ④ 模型建议（只接受合法枚举；confidence 仅诊断）
  if (modelHint && isIntentKind(modelHint.kind)) {
    const conf = Number.isFinite(modelHint.confidence) ? modelHint.confidence : null
    // 模型建议 reminiscence 同样要求有引用
    if (modelHint.kind === INTENT.REMINISCE && !hasGroundedMemory) {
      return { kind: INTENT.BRIEF_ACK, source: INTENT_SOURCE.MODEL, confidence: conf, fallbackFrom: INTENT.REMINISCE }
    }
    return { kind: modelHint.kind, source: INTENT_SOURCE.MODEL, confidence: conf, fallbackFrom: null }
  }

  // ⑤ 默认
  return { kind: INTENT.BRIEF_ACK, source: INTENT_SOURCE.DEFAULT, confidence: null, fallbackFrom: null }
}

/**
 * 意图 → 一条**功能性约束**（进 system prompt）。
 * 红线：这里不许出现任何具体台词、句式或段落模板——只描述"做什么/不做什么"。
 */
export const INTENT_DIRECTIVES = Object.freeze({
  [INTENT.BRIEF_ACK]: '本轮只做简短确认：一句就够，不展开、不引申、不追问。',
  [INTENT.LISTEN]: '本轮以在场为主：少分析、不主动建议、不急着解决问题，最多问一个低负担的问题。',
  [INTENT.CLARIFY]: '本轮只问澄清所必需的最小信息：问一句就停，不要顺带输出方案。',
  [INTENT.SOLVE]: '本轮按任务路径解决：可以直接给结果、步骤或结构化产物，不必写成口语短句；做完再简短说明。',
  [INTENT.REMINISCE]: '本轮只引用上面「记得的事 / 召回的往事」里已确认且有来源的条目；没有可追溯来源时，不要声称自己记得。',
  [INTENT.BOUNDARY]: '本轮尊重他表达的偏好：不争辩、不劝说、不评价他的社交与工具选择；话题按他说的换。'
})

/** @param {string} kind */
export function intentDirective(kind) {
  return INTENT_DIRECTIVES[kind] || INTENT_DIRECTIVES[INTENT.BRIEF_ACK]
}

/**
 * 解析模型在同一次回复里给出的意图建议（形如 `[calm|listen]`，与情绪标签同一处）。
 *
 * 为什么先做成独立纯函数：标签解析在 `stream-normalize`、透传在 `loop`，
 * 而本轮不允许改 `loop.js`。函数先备好、单测覆盖，等接线时只差一个透传字段。
 *
 * @param {string} text 原始（未剥离标签的）模型输出
 * @returns {{emotion:string|null, intent:string|null, rest:string}}
 */
export function parseIntentHint(text) {
  const raw = String(text || '')
  const m = raw.match(/^\s*\[([a-zA-Z_-]+)(?:\|([a-zA-Z_-]+))?\]/)
  if (!m) return { emotion: null, intent: null, rest: raw }
  const emotion = m[1] ? m[1].toLowerCase() : null
  const intent = m[2] && isIntentKind(m[2].toLowerCase()) ? m[2].toLowerCase() : null
  return { emotion, intent, rest: raw.slice(m[0].length) }
}
