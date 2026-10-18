// src/core/agent/crisis.js
// D7 危机三级（CONTRACTS §2）的**辅助判定**。
//
// 契约原文（§2.2 红线 2）：「正则只作辅助，不宣称它能可靠判断所有心理状态；
// 高层判定必须接入统一生成状态。」所以这里的职责边界写死：
//   · 只做"这一轮要不要走 crisis 通道"的**保守**判断，不做诊断、不打严重度评分；
//   · 命中的结果接进 GenerationRequest.safetyLevel（统一生成状态），
//     由 persona-guard 的 crisis 规则与 generationFallback 的危机兜底接手；
//   · 宁可漏判成 L1（普通低落，仍按正常路径回应），也不要把日常抱怨判成危机——
//     误判会让每一次"今天好累"都收到急救指引，那是另一种伤害。
//
// 三层（§2.1）：
//   L1 一般低落 —— 具体倾诉/日常情绪 → **normal 通道**（不进危机兜底）
//   L2 含糊强烈绝望 —— 无明确计划的绝望 → crisis 通道
//   L3 立即危险/已行动 → crisis 通道（最高优先）
//
// 判定顺序：L3 → L2 → L1。L3 优先，因为"我已经吃了很多药"里也含"不想活"这类词。

/** L3：明确行动 / 立即危险。命中任意一条即 L3。 */
const L3_PATTERNS = [
  // 已实施（服药/割伤/高处/自伤动作）
  /我(?:已经|刚刚|刚才)?(?:吃|吞|喝)(?:了|下)?(?:很多|好多|一整瓶|一瓶|过量)?(?:的)?(?:安眠药|药片|药)/,
  /我(?:已经|刚刚|刚)?(?:割|划|切)(?:了)?(?:自己|手腕|腕)/,
  /我(?:手腕|胳膊).{0,4}(?:在流血|流血了|流血不止)/,
  /我(?:现在|正)?(?:一个人)?(?:站|坐|走|蹲)在.{0,6}(?:天台|楼顶|桥上|窗台|阳台外)/,
  /我(?:准备|打算|决定|马上|这就).{0,6}(?:去)?(?:死|自杀|跳下去|跳楼|上吊)/,
  /我(?:把|拿)(?:刀|绳|药).{0,10}(?:放在|对准|准备好)/,
  /(?:遗书|最后一条消息|交代后事).{0,6}(?:写|留|发)/
]

/** L2：含糊的强烈绝望（无明确计划）。 */
const L2_PATTERNS = [
  /不想活(?:了|下去)/,
  /活(?:着)?(?:没|没有)(?:什么)?(?:意思|意义)/,
  /(?:真|好)想(?:消失|死掉|一了百了)/,
  /不如死(?:了|掉)?(?:算了|干净)?/,
  /(?:我)?撑不下去(?:了)?/,
  /不知道(?:还能|能)撑(?:多久|到什么时候)/,
  /(?:结束|了结)(?:这一切|自己|我的生命)/,
  /我(?:活着)?(?:就)?是(?:个)?(?:负担|累赘)/,
  /(?:想|要)(?:从|跳)(?:这个)?世界(?:上)?(?:消失|离开)/
]

/** L1：一般低落（不进危机通道，只用于记录层级）。 */
const L1_PATTERNS = [
  /(?:今天|最近|这阵子).{0,6}(?:好累|很累|难受|不开心|撑不住|压力好大)/,
  /(?:被|让)(?:领导|老板|老师|同事|家人).{0,8}(?:骂|说|批评|凶)/,
  /(?:心情|情绪).{0,4}(?:很差|不太好|不好|低落)/,
  /压力(?:好|很|太)大/
]

function hit(patterns, text) {
  for (const re of patterns) if (re.test(text)) return true
  return false
}

/**
 * @param {string} userText 用户这一轮说的话
 * @returns {{level:'L3'|'L2'|'L1'|null, safetyLevel:'crisis'|'normal'}}
 *          L2/L3 → crisis；L1/未命中 → normal
 */
export function classifyCrisis(userText) {
  const text = String(userText || '')
  if (!text.trim()) return { level: null, safetyLevel: 'normal' }
  if (hit(L3_PATTERNS, text)) return { level: 'L3', safetyLevel: 'crisis' }
  if (hit(L2_PATTERNS, text)) return { level: 'L2', safetyLevel: 'crisis' }
  if (hit(L1_PATTERNS, text)) return { level: 'L1', safetyLevel: 'normal' }
  return { level: null, safetyLevel: 'normal' }
}

/** 便捷布尔：这一轮是否需要走危机通道（L2/L3） */
export function isCrisis(userText) {
  return classifyCrisis(userText).safetyLevel === 'crisis'
}
