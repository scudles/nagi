// src/core/agent/loop.js
// Agent Loop：模型 → 文本/工具调用 → 执行（高危先确认）→ 结果回喂 → 直到产出最终回复。
// 纯逻辑，无 Electron 依赖：模型调用、工具执行、用户确认全部通过注入的函数完成，可单测。
//
// 双通道：
//   1) 原生 function calling —— 直接把 tools schema 给模型，流里收 tool_calls；
//   2) prompt JSON 兜底 —— 模型在正文里输出 {"action":...} 块，用 json-protocol 解析。

import { AGENT_EVENT, AGENT_STATE, EMOTIONS } from '../../shared/protocol.js'
import { EmotionTagParser, extractEmotionTag } from '../llm/stream-normalize.js'
import { extractActions, formatToolResult, JSON_PROTOCOL_HINT } from './json-protocol.js'
import { getToolRisk, needsConfirm } from '../safety/policy.js'
import { NagiPersona } from '../persona.js'

export const DEFAULT_MAX_STEPS = 10

/** 系统提示：人格 + 输出契约（含情绪标签，见 core/persona.js）+ 工具提示 */
export function buildSystemPrompt({ persona, nativeTools = true, context = '' } = {}) {
  const lines = [persona || NagiPersona.llmSystem]
  // 「此刻」动态上下文（时间/上次互动/情绪/长期记忆/最近说过的话）——
  // 放在人格之后、工具说明之前：它是最影响这一句怎么说的信息
  if (context) lines.push('', context)
  lines.push(
    '',
    '【工具使用】有工具可用时优先用工具拿真实信息，不要编造；',
    '拿到工具结果后用简洁的中文向用户汇报关键内容。',
    '他说「过一会儿提醒我」「几点提醒我」这类事，用 reminder_add 记下来——这不是系统闹钟，' +
      '是你替他记下的事，到点由你开口提醒。'
  )
  // 原生 function calling 可用时不注入 JSON 协议提示——两者并存会干扰模型选择通道
  // （2026-10-14 实测：云网关的 hunyuan-chat 同时收到 tools 参数与 JSON 文本提示时，
  // 会优先在正文里吐 ```json 块而不是走 tool_calls）
  if (!nativeTools) {
    lines.push('', JSON_PROTOCOL_HINT)
  }
  return lines.join('\n')
}

/** 工具调用的确认描述（给用户看的一句话） */
export function describeToolCall(name, args = {}) {
  switch (name) {
    case 'run_command':
      return `执行命令：${args.command || '(空)'}`
    case 'file_write':
      return `写入文件：${args.path || '(未指定路径)'}`
    case 'clipboard_write':
      return '写入剪贴板'
    case 'home_set':
      return `控制设备：${args.entity_id || '(未指定)'} → ${args.service || args.action || ''}`
    case 'home_scene':
      return `触发场景：${args.entity_id || args.scene || '(未指定)'}`
    case 'open_app':
      return `打开应用：${args.name || args.path || '(未指定)'}`
    case 'browser_act':
      return `浏览器操作：${args.action || ''} ${args.selector || args.url || ''}`.trim()
    case 'reminder_add':
      return `设置提醒：${args.text || ''}（${args.when || args.at || ''}）`
    case 'reminder_cancel':
      return `取消提醒：${args.id || args.text || ''}`
    default:
      return `${name}`
  }
}

function parseToolArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return { _raw: String(raw) }
  }
}

function clampEmotion(e) {
  const k = String(e || '').toLowerCase()
  return EMOTIONS.includes(k) ? k : null
}

/**
 * 运行一轮 Agent 会话。
 * @param {object} opts
 * @param {Array} opts.messages            初始消息（含 system；会被就地追加）
 * @param {boolean} opts.supportsNative    是否用原生 function calling
 * @param {Array}  opts.toolSchemas        原生通道的 tools schema
 * @param {Function} opts.callModel        async ({messages, tools, signal}) => AsyncIterable<{type:'delta'|'tool_call'|'done', ...}>
 * @param {Function} opts.executeTool      async (name, args, meta) => {ok, summary, data?}
 * @param {Function} opts.confirm          async ({id,name,args,risk}) => boolean
 * @param {Function} opts.emit             (event) => void   向前端广播
 * @param {number}   opts.maxSteps
 * @param {AbortSignal} opts.signal
 * @returns {Promise<{text:string, steps:number, aborted:boolean}>}
 */
export async function runAgentLoop(opts) {
  const {
    messages,
    supportsNative = true,
    toolSchemas = [],
    callModel,
    executeTool,
    confirm,
    emit,
    maxSteps = DEFAULT_MAX_STEPS,
    signal
  } = opts

  let steps = 0
  let finalText = ''
  let aborted = false
  const onAbort = () => {
    aborted = true
  }
  if (signal) {
    if (signal.aborted) aborted = true
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (steps < maxSteps && !aborted) {
      steps++
      emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.THINKING, detail: steps > 1 ? `第 ${steps} 步` : undefined })

      let visibleText = ''
      let emotion = null
      let nativeToolCalls = []
      let jsonActions = []

      if (supportsNative) {
        // ---- 原生通道：流式直出 ----
        const parser = new EmotionTagParser()
        const stream = await callModel({ messages, tools: toolSchemas.length ? toolSchemas : undefined, signal })
        for await (const evt of stream) {
          if (aborted) break
          if (evt.type === 'delta') {
            const r = parser.push(evt.text)
            if (r.emotion && !emotion) {
              emotion = r.emotion
              emit({ type: AGENT_EVENT.EMOTION, emotion, intensity: 1 })
            }
            if (r.text) {
              visibleText += r.text
              emit({ type: AGENT_EVENT.TEXT_DELTA, text: r.text })
            }
          } else if (evt.type === 'tool_call') {
            nativeToolCalls = evt.toolCalls || []
          } else if (evt.type === 'done') {
            break
          }
        }
        const rest = parser.flush()
        if (rest.text) {
          visibleText += rest.text
          emit({ type: AGENT_EVENT.TEXT_DELTA, text: rest.text })
        }
      } else {
        // ---- JSON 兜底通道：缓冲全文再解析（避免把 JSON 块漏给用户）----
        let raw = ''
        const stream = await callModel({ messages, tools: undefined, signal })
        for await (const evt of stream) {
          if (aborted) break
          if (evt.type === 'delta') raw += evt.text || ''
          else if (evt.type === 'done') break
        }
        const tagged = extractEmotionTag(raw)
        if (tagged.emotion) {
          emotion = tagged.emotion
          emit({ type: AGENT_EVENT.EMOTION, emotion, intensity: 1 })
        }
        const parsed = extractActions(tagged.text)
        jsonActions = parsed.actions
        visibleText = parsed.cleanedText
        if (visibleText) emit({ type: AGENT_EVENT.TEXT_DELTA, text: visibleText })
      }

      if (emotion && !clampEmotion(emotion)) {
        // 非法情绪标签忽略（标签本身已在 parser 处理，不会出现在正文）
        emotion = null
      }

      const toolCalls = supportsNative
        ? nativeToolCalls.map((tc, i) => ({ id: tc.id || `native_${steps}_${i}`, name: tc.name, arguments: tc.arguments }))
        : jsonActions.map((a, i) => ({ id: `json_${steps}_${i}`, name: a.name, arguments: JSON.stringify(a.args) }))

      if (toolCalls.length) {
        // 把这一轮助手输出（含工具调用意图）记入上下文
        if (supportsNative) {
          messages.push({
            role: 'assistant',
            content: visibleText || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) }
            }))
          })
        } else {
          messages.push({ role: 'assistant', content: visibleText || `（调用工具 ${toolCalls[0].name}）` })
        }

        for (const tc of toolCalls) {
          if (aborted) break
          const args = parseToolArgs(tc.arguments)
          const risk = getToolRisk(tc.name)
          emit({ type: AGENT_EVENT.TOOL_CALL, id: tc.id, name: tc.name, args, risk })

          const decision = needsConfirm({ name: tc.name, args })
          let result
          if (decision.blocked) {
            result = { ok: false, summary: '该命令被安全策略永久拒绝（黑名单）' }
            emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.ACTING })
          } else if (decision.confirm) {
            emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.WAITING })
            emit({
              type: AGENT_EVENT.CONFIRM,
              id: tc.id,
              name: tc.name,
              args,
              risk,
              description: describeToolCall(tc.name, args)
            })
            let approved = false
            try {
              approved = confirm ? await confirm({ id: tc.id, name: tc.name, args, risk }) : false
            } catch {
              approved = false
            }
            if (!approved) {
              result = { ok: false, summary: '用户拒绝执行该操作' }
            }
          }

          if (!result) {
            emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.ACTING, detail: tc.name })
            try {
              result = (await executeTool(tc.name, args, { id: tc.id, safe: decision.safe })) || { ok: false, summary: '工具无返回' }
            } catch (err) {
              result = { ok: false, summary: '工具执行异常：' + (err && err.message ? err.message : String(err)) }
            }
          }

          const ok = result && result.ok !== false
          emit({
            type: AGENT_EVENT.TOOL_RESULT,
            id: tc.id,
            name: tc.name,
            ok,
            summary: (result && result.summary) || '',
            ms: result && result.ms
          })

          // 结果回喂
          if (supportsNative) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: formatToolResult(tc.name, result) })
          } else {
            messages.push({ role: 'user', content: formatToolResult(tc.name, result) })
          }
        }
        continue // 工具结果回喂后再向模型要下一步
      }

      // 无工具调用 → 本轮文本即最终回复
      finalText = visibleText
      break
    }

    if (aborted) {
      emit({ type: AGENT_EVENT.ERROR, message: '已取消' })
      return { text: finalText, steps, aborted: true }
    }
    if (steps >= maxSteps && !finalText) {
      finalText = '……步骤数达到上限，先停在这里。需要的话我再继续。'
      emit({ type: AGENT_EVENT.TEXT_DELTA, text: finalText })
    }
    emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
    emit({ type: AGENT_EVENT.DONE, text: finalText })
    return { text: finalText, steps, aborted: false }
  } catch (err) {
    emit({ type: AGENT_EVENT.ERROR, message: err && err.message ? err.message : String(err) })
    emit({ type: AGENT_EVENT.STATUS, state: AGENT_STATE.IDLE })
    return { text: finalText, steps, aborted }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
