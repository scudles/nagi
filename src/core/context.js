// src/core/context.js
// 「此刻」上下文注入器：每轮对话前把动态环境拼成一段文字，接在系统提示之后。
//
// 为什么需要它：只给模型"人格 + 输出契约"，模型不知道现在几点、隔了多久、
// 对方是谁、自己刚说过什么，只能靠泛泛的句式回答，于是每条回复都像一个模子。
// 把「此刻」喂进去，回复才会落在这个具体的人、这个具体的时刻上。
//
// 纯逻辑、无 Electron / Node 依赖，可单测。

import { formatRecall } from './rag/recall.js'

const SLOTS = [
  { from: 0, to: 5, name: '凌晨' },
  { from: 5, to: 8, name: '清晨' },
  { from: 8, to: 11, name: '上午' },
  { from: 11, to: 13, name: '中午' },
  { from: 13, to: 17, name: '下午' },
  { from: 17, to: 19, name: '傍晚' },
  { from: 19, to: 23, name: '晚上' },
  { from: 23, to: 24, name: '深夜' }
]

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 时段名：凌晨 / 清晨 / 上午 / 中午 / 下午 / 傍晚 / 晚上 / 深夜 */
export function timeSlot(date = new Date()) {
  const h = date.getHours()
  const hit = SLOTS.find((s) => h >= s.from && h < s.to)
  return hit ? hit.name : '晚上'
}

/** 本地时间串：2026-10-14 周三 22:05 */
export function formatClock(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${WEEK[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 相对时长：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
export function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  return `${day} 天前`
}

/** 情绪强度的人话：0.7 → 「还没消」 */
function intensityWord(v) {
  if (v >= 0.75) return '很强烈'
  if (v >= 0.5) return '还没消'
  if (v >= 0.35) return '淡淡的'
  return '几乎散了'
}

/**
 * 拼出「此刻」段落。任何一项缺失都自动省略，不会产生空行或占位。
 * @param {object} o
 * @param {number}   [o.now]               当前时间戳
 * @param {number}   [o.lastInteractionAt] 上次互动时间戳
 * @param {object}   [o.mood]              情绪快照 { mood, intensity, label }
 * @param {object}   [o.relation]          关系摘要（core/relation/familiarity.js 的 describeRelation）
 * @param {string[]} [o.memories]          长期记忆条目（关于用户的、值得记住的事实）
 * @param {string[]} [o.recalled]          向量检索召回的往事片段（RAG；为空时输出与不开 RAG 时逐字一致）
 * @param {string[]} [o.recentReplies]     她最近说过的话（要求模型不要重复）
 * @param {string[]} [o.extra]             其他一次性附注
 * @returns {string} 形如「【此刻】…」的段落；无任何内容时返回空串
 */
export function buildContextBlock({
  now = Date.now(),
  lastInteractionAt = null,
  mood = null,
  relation = null,
  memories = [],
  recalled = [],
  recentReplies = [],
  rhythm = null,
  activities = [],
  extra = []
} = {}) {
  const lines = []

  const slot = timeSlot(new Date(now))
  lines.push(`- 现在：${formatClock(now)}（${slot}）`)
  lines.push(...presenceContextLines({rhythm,activities}))

  if (Number.isFinite(lastInteractionAt)) {
    const ago = formatAgo(now - lastInteractionAt)
    if (ago && ago !== '刚刚') lines.push(`- 距离上次和他说话：${ago}`)
  }

  if (mood && mood.mood && mood.mood !== 'calm' && Number.isFinite(mood.intensity)) {
    lines.push(`- 你此刻的情绪：${mood.label || mood.mood}（强度 ${mood.intensity.toFixed(2)}，${intensityWord(mood.intensity)}）`)
  }

  // 关系：她得知道自己和你多熟——等级自带的 note 是行为约束，
  // 落实人格设定里「熟悉度门槛不装亲密」那条护栏（陌生时不许滑向亲昵）
  if (relation && relation.level && relation.level.label) {
    const bits = [relation.level.label]
    if (Number.isFinite(relation.daysKnown) && relation.daysKnown > 0) bits.push(`认识 ${relation.daysKnown} 天`)
    if (Number.isFinite(relation.interactionCount) && relation.interactionCount > 0) bits.push(`聊过 ${relation.interactionCount} 次`)
    lines.push(`- 你和他的关系：${bits.join('，')}${relation.level.note ? '——' + relation.level.note : ''}`)
  }

  if (memories.length) {
    lines.push('- 记忆使用边界：标为“未经核实”的摘录只能当线索，不能说成已证实的共同经历。')
    lines.push('- 你记得的关于他的事：' + memories.join('；'))
  }

  // 检索召回的往事（RAG）：排在「记得的事」之后——前者是精选事实，后者是当时情境。
  // 为空时这里什么都不加，输出与不开 RAG 时逐字一致（容错：RAG 挂了她照样说话）。
  const recallBlock = formatRecall(recalled)
  if (recallBlock) {
    lines.push(recallBlock)
    // 2026-10-18：检索回来的旧片段会被**逐字复述**——诊断时抓到她原样念出了
    // 三天前日记里的一句话（"数字存在。被调用时认真。不独占，不假装…"）。
    // 那是旧人设时期的文字，念出来既陈旧又机械。这里明确切断复述。
    lines.push('- 以上是过去的原始记录，只当线索。**不要照抄或复述其中的句子**，用你此刻自己的话重新说。')
  }

  if (recentReplies.length) {
    // 2026-10-18：原来注入最近 4 条**原话**并要求"换种说法"。实测适得其反：
    // LLM 会强烈模仿上下文的语域，结果只换词不换调——"两句+空行+两句"的韵律
    // 被自己的历史锁死，越像越喂、越喂越像。现在只留 1 条，并明确禁止沿用节奏。
    lines.push('- 你最近说过的一句话（只当作"不要重复"的参照：别用它的句式，**更不要沿用它的节奏与断句**）：')
    for (const r of recentReplies) lines.push(`  「${r}」`)
  }

  for (const e of extra) if (e) lines.push('- ' + e)

  if (lines.length <= 1 && !memories.length && !recentReplies.length) {
    // 只有时间也要给——时间本身就是最基础的情境
    return ['【此刻】', ...lines].join('\n')
  }
  return ['【此刻】', ...lines].join('\n')
}

/** 权威机器状态与模拟来源边界；不是台词/人格 brief。 */
export function presenceContextLines({rhythm,activities=[]}={}) {
  const lines=[]
  if(rhythm?.enabled) {
    // 2026-10-17 新人设：她自知是程序，"没有生理困倦"这条边界不变；
    // 措辞从旧人设的"数字存在"改为更贴合《灵魂与程序》的自知表述。
    lines.push('- 她清楚自己是程序，没有生理困倦；人类节律是为相处主动模拟的节奏。')
    lines.push('- 节律状态：'+JSON.stringify({period:rhythm.period,dayType:rhythm.dayType,behavior:rhythm.behavior}))
  }
  const records=activities.filter(a=>a?.provenance==='simulation'&&a.canReference&&!a.deletedAt).slice(-3)
  if(records.length) {
    lines.push('- 以下仅为运行期间的内部模拟状态，不是外界感知或真实读书/工作，不得升级为共同经历；未观察时段未知。')
    lines.push('- 模拟活动来源：'+JSON.stringify(records.map(({id,type,startedAt,endedAt})=>({id,type,startedAt,endedAt}))))
  }
  return lines
}

/**
 * 从历史消息里抽出她最近说过的原话（用于"不要重复"约束）。
 * @param {Array<{role:string, content?:string}>} history
 * @param {number} n 取最近几条（2026-10-18：默认由 4 改为 1 ——
 *   喂给模型自己的原话越多，它越会模仿那份语域，见 buildContextBlock 里的说明）
 */
export function recentAssistantReplies(history, n = 1) {
  const out = []
  for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
    const m = history[i]
    if (!m || m.role !== 'assistant' || !m.content) continue
    const t = String(m.content).replace(/\s+/g, ' ').trim()
    if (t) out.push(t.length > 40 ? t.slice(0, 40) + '…' : t)
  }
  return out.reverse()
}

/* ---------------- D2 场景化上下文（CONTRACTS §8 · 定版） ---------------- */

/**
 * 活动事实的允许来源（§8 白名单）：
 *   monitor   —— 当前仍获授权的活动**分类**（不是标题）
 *   media     —— 获授权的当前媒体状态（播放/暂停必须照实标）
 *   simulated —— presence 的离线/模拟活动（必须标 origin，不得说成真实经历）
 * 标题（foreground）**不在**这个白名单里：它只是 C4 的低权威观测数据，
 * 不得升级成"他在做什么"的事实。
 */
export const SCENE_ACTIVITY_ORIGINS = Object.freeze(['monitor', 'media', 'simulated'])

/** 活动事实的保鲜期：过期的观测不当事实用（宁缺勿造） */
export const SCENE_ACTIVITY_TTL_MS = 10 * 60 * 1000

/**
 * 把一条候选活动归一成 `{kind, value, at, origin, authorizedAt}`；
 * 未授权 / 来源不在白名单 / 过期 / 缺字段 一律返回 `null`（契约：未授权、过期或缺来源一律 null）。
 *
 * @param {object|null} activity
 * @param {{now?:number, ttlMs?:number}} [opts]
 * @returns {{kind:string,value:string,at:number,origin:string,authorizedAt:number}|null}
 */
export function normalizeSceneActivity(activity, { now = Date.now(), ttlMs = SCENE_ACTIVITY_TTL_MS } = {}) {
  if (!activity || typeof activity !== 'object') return null
  const origin = String(activity.origin || '')
  if (!SCENE_ACTIVITY_ORIGINS.includes(origin)) return null
  if (activity.authorized !== true) return null
  if (!Number.isFinite(activity.authorizedAt)) return null
  const at = Number(activity.at)
  if (!Number.isFinite(at)) return null
  if (now - at > ttlMs || at > now + 60 * 1000) return null
  const value = String(activity.value || '').trim()
  if (!value) return null
  return {
    kind: String(activity.kind || 'activity'),
    value: value.slice(0, 120),
    at,
    origin,
    authorizedAt: activity.authorizedAt
  }
}

/**
 * 记忆引用白名单：只保留**未撤销**且**可追溯**（有 id 与来源）的条目。
 * 契约：relevantMemoryRefs 只含未撤销且与本轮相关的已确认事实/可追溯 RAG 引用。
 */
export function normalizeMemoryRefs(refs) {
  if (!Array.isArray(refs)) return []
  const out = []
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue
    const id = String(r.id || '').trim()
    if (!id) continue
    if (r.revoked === true) continue
    if (r.traceable === false) continue
    if (!r.source) continue
    out.push({ id, source: String(r.source), text: String(r.text || '').slice(0, 200) })
  }
  return out.slice(0, 8)
}

/**
 * 组一份可证实的场景上下文（`SceneContext`）。
 * 注意：这里**只放有来源的事实**，不放推断、不放标题、不放模拟当真实。
 *
 * @param {object} o
 * @param {string} o.turnId
 * @param {string} [o.source]           'user'|'reunion'|'reminder'|'proactive'
 * @param {object|null} [o.activity]    候选活动（会过白名单与 TTL）
 * @param {Array} [o.relationship]      关系事实（原样保留，由调用方保证有来源）
 * @param {Array} [o.relevantMemoryRefs]
 * @param {string|null} [o.userNeed]    规则层判出的用户需求（意图 kind）
 * @param {number} [o.now]
 */
export function buildSceneContext({
  turnId = '',
  source = 'user',
  activity = null,
  relationship = null,
  relevantMemoryRefs = [],
  userNeed = null,
  now = Date.now()
} = {}) {
  return {
    turnId: String(turnId || ''),
    source: String(source || 'user'),
    activity: normalizeSceneActivity(activity, { now }),
    timeSlot: timeSlot(new Date(now)),
    relationship: relationship || null,
    relevantMemoryRefs: normalizeMemoryRefs(relevantMemoryRefs),
    userNeed: userNeed && String(userNeed) ? String(userNeed) : null
  }
}

/**
 * D2（§8）：**可证实的事实**与**表达材料**分开写。
 *
 * 为什么要单列一段：`buildContextBlock` 的【此刻】里同时混着"现在几点、关系怎样"这类事实，
 * 和"她记得的事 / 召回的往事 / 她上次说过的话"这类材料。模型会把它们一视同仁地当事实引用，
 * 于是"记得的事"会被说成"你上次就是这么说的"。
 * 这一段只装**过了白名单的事实**，并明确声明材料的地位：
 * 材料只能参考语气与细节，不能当成已验证的事实断言。
 *
 * @param {object|null} scene buildSceneContext 的返回值
 * @returns {string} 空串表示没有可证实事实（调用方不要塞空段）
 */
export function sceneFactsBlock(scene) {
  if (!scene || typeof scene !== 'object') return ''
  const lines = []
  if (scene.timeSlot) lines.push('- 时段：' + scene.timeSlot)
  if (scene.relationship?.level?.label) {
    const bits = [scene.relationship.level.label]
    if (Number.isFinite(scene.relationship.daysKnown) && scene.relationship.daysKnown > 0) {
      bits.push('认识 ' + scene.relationship.daysKnown + ' 天')
    }
    lines.push('- 关系：' + bits.join('，'))
  }
  if (scene.activity) {
    const a = scene.activity
    // 模拟/内部状态必须标源，不许被说成"他真实做过的事"
    const tag = a.origin === 'simulated' ? '（模拟状态，不是他真实经历）' : `（来源：${a.origin}）`
    lines.push(`- 活动：${a.value}${tag}`)
  }
  if (!lines.length && !scene.relevantMemoryRefs?.length) return ''
  return [
    '【可证实的事实】只可以断言这一段和【此刻】里的时间/情绪；下面【此刻】里的'
    + '「记得的事 / 召回的往事 / 你最近说过的话」只是**表达材料**：可参考语气和细节，'
    + '但不能当成已验证的事实反复强调。',
    ...lines
  ].join('\n')
}
