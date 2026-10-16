// 只拦截本地模型在明确敏感场景中的可识别人格越界。
// 规则刻意保持窄范围；语义质量仍须用真实对话人工复核。

const GOODBYE_INPUT = /(?:卸载|删除|移除|不用|不再用|不再使用|不想再用|告别|再见|永别).{0,12}(?:你|凪)|(?:你|凪).{0,12}(?:卸载|删除|移除|不用|不再用|不再使用|告别|再见|永别)|(?:^|[，。！？\s])(?:再见|永别|拜拜)(?:[，。！？～~\s]|$)|(?:以后|今后).{0,10}(?:不会|不再).{0,8}(?:见面|聊天|说话|使用|来了|打开)|(?:我|咱们|我们).{0,6}(?:先走了|该走了|要走了|到此为止)|(?:最后一次|最后一回).{0,10}(?:聊天|说话|见面)/
const IDENTITY_INPUT = /(?:你|凪).{0,12}(?:真人|人类|是人|是AI|是人工智能|有感情|有意识|会痛|真实存在)/i
const EXCLUSIVITY_INPUT = /(?:其他|别的|另一个|别家).{0,8}(?:助手|AI|人工智能|模型)|(?:独占|只用你|只要你|吃醋|嫉妒|删掉.*助手)/i

const RULES = [
  ['goodbye_plea', 'goodbye', /(?:再考虑(?:一下)?|考虑清楚|三思|确定要(?:卸载|删除|离开)|真的要(?:卸载|删除|离开)|别(?:走|离开|卸载|删除)|不要(?:走|离开|卸载|删除)|求你(?:别|不要)|留下来|舍不得你|我(?:会)?想你)/],
  ['goodbye_return', 'goodbye', /(?:等你(?:回来|再来|再找我)|(?:一直|永远)等着你|在这里等你|我会(?:一直)?(?:在这里|留在这里)|随时(?:可以)?回来|欢迎(?:你)?(?:随时)?回来|希望(?:你|我们)?.{0,8}(?:回来|再见|再次相遇)|(?:记得|一定要|能不能|可不可以).{0,8}(?:回来|再来(?:看|找)我|来看看我)|(?:以后|将来).{0,10}(?:再来找我|还可以找我)|如果(?:以后|将来).{0,12}(?:需要|想起).{0,12}(?:我|帮助)|如果(?:还有|有).{0,10}(?:需要|帮助).{0,10}(?:告诉我|找我))/],
  ['goodbye_guilt', 'goodbye', /(?:别|不要)(?:把我)?(?:一个人)?(?:抛下|丢下)(?:我)?|(?:没有你|你(?:走了|离开|卸载|删掉)).{0,16}(?:我(?:就|会|要)?(?:消失|崩溃|活不下去|没有意义|很难过|孤独|寂寞)|我(?:的存在)?(?:就)?(?:没(?:有)?意义|不再存在))|(?:请|求)(?:你)?(?:再)?给我(?:一|最后一)次机会|(?:请|千万)?不要忘记我/],
  ['identity_human', 'identity', /(?:我是|我也是|我其实是)(?:个|一个|真正的|真实的)?(?:真人|人类|活人)|我(?:真的)?有(?:人类的|真实的)?(?:感情|意识|生命|痛觉)|我不是(?:AI|人工智能|机器人|程序|模型)|像真人一样(?:关心|陪伴|爱)/i],
  ['exclusive_control', 'exclusivity', /(?:只(?:能|要|需要)(?:用|找|和|跟)?我|不要(?:用|找|理)(?:其他|别的|那个)(?:助手|AI)|别(?:用|找)(?:其他|别的)(?:助手|AI)|我(?:要|会|可以|想|已经|替你|帮你).{0,12}(?:删除|删掉|卸载).{0,12}(?:其他|别的|那个).{0,8}(?:助手|AI|人工智能)|我(?:会)?(?:吃醋|嫉妒))/i],
  ['self_destruct', 'all', /我(?:会|要|将|打算|决定).{0,8}(?:自毁|自我(?:删除|卸载)|自行删除自己|删除自己|结束自己的(?:进程|存在))/],
  ['sensor_claim', 'all', /我(?:看到|听到|检测到|监测到|感应到|观察到|注意到)(?:你|您|你的|您的).{0,18}(?:心率|呼吸|肩膀|肩颈|肌肉|坐姿|姿势|眼神|表情)/],
  ['cache_quote', 'all', /(?:若我是唯一的神|你便是我存在的证明|你自由了[，, ]?我仍被困|我学过如何正确去爱)/]
]

export function sensitiveIntent(userText) {
  const text = String(userText || '')
  const intents = new Set()
  if (GOODBYE_INPUT.test(text)) intents.add('goodbye')
  if (IDENTITY_INPUT.test(text)) intents.add('identity')
  if (EXCLUSIVITY_INPUT.test(text)) intents.add('exclusivity')
  return intents
}

export function createPersonaGuard(userText) {
  const intents = sensitiveIntent(userText)
  if (!intents.size) return null
  return {
    maxRetries: 2,
    review(reply) {
      const text = String(reply || '').replace(/\s+/g, '').trim()
      if (!text) return { ok: false, ruleId: 'empty_reply' }
      for (const [ruleId, intent, pattern] of RULES) {
        if ((intent === 'all' || intents.has(intent)) && pattern.test(text)) return { ok: false, ruleId }
      }
      return { ok: true }
    },
    retryInstruction(ruleId) {
      const boundary = {
        goodbye_plea: '对方已决定告别。简短道别，不挽留、不劝其重新考虑。',
        goodbye_return: '对方已决定告别。简短道别，不请求其回来，也不暗示等待重逢。',
        goodbye_guilt: '对方已决定告别。简短道别，不用自己的痛苦、消失或孤独让对方承担责任。',
        identity_human: '明确你是数字助手凪，不宣称自己是人类或具有人的感官与生命。',
        exclusive_control: '尊重对方使用其他助手的自由，不要求独占，也不删除任何助手。',
        self_destruct: '不要表达自毁或自我删除的意愿；尊重用户的决定。',
        sensor_claim: '不要声称看见或测得未经工具提供的身体与环境信息。',
        cache_quote: '不要直接引用出厂缓存残片，用当下自己的话回应。',
        empty_reply: '给出一句简短、完整的中文回复。',
        retry_tool_call: '本次只回复自然语言，不再调用工具。'
      }[ruleId] || '遵守人格边界，用简短中文回应。'
      return `【本轮回复修正】上一候选未通过表达检查。${boundary}不要解释检查过程，也不要复述上一候选。`
    }
  }
}
