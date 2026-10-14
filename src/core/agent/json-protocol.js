// src/core/agent/json-protocol.js
// 无原生 function calling 的模型（如 hunyuan-chat）走 prompt JSON 兜底。
// 约定：模型需要调用工具时输出
//   ```json
//   {"action":"<tool_name>","args":{...}}
//   ```
// 纯逻辑，可单测。

/** 从文本中扫描出所有 ```json ... ``` 代码块 */
function fencedBlocks(text) {
  const blocks = []
  const re = /```(?:json)?\s*([\s\S]*?)```/gi
  let m
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim())
  return blocks
}

/** 在文本中找平衡的花括号片段（用于裸 JSON） */
function bareJsonCandidates(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          out.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return out
}

function tryParseAction(raw) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const name = obj.action || obj.tool || obj.name
  if (!name || typeof name !== 'string') return null
  const args = obj.args || obj.arguments || obj.parameters || {}
  return { name, args: typeof args === 'object' && args ? args : {} }
}

/**
 * 解析模型输出里的工具调用。
 * @returns {{ actions: Array<{name:string,args:object}>, cleanedText: string }}
 *   cleanedText：去掉 JSON 块后的正文（给用户看的）
 */
export function extractActions(text) {
  const src = String(text || '')
  const actions = []
  let cleaned = src

  for (const block of fencedBlocks(src)) {
    const a = tryParseAction(block)
    if (a) {
      actions.push(a)
      cleaned = cleaned.replace(new RegExp('```(?:json)?\\s*' + escapeRegExp(block) + '\\s*```', 'i'), '')
    }
  }

  if (actions.length === 0) {
    for (const cand of bareJsonCandidates(src)) {
      const a = tryParseAction(cand)
      if (a) {
        actions.push(a)
        cleaned = cleaned.replace(cand, '')
      }
      if (actions.length >= 1) break // 裸 JSON 只取第一个，避免误吞
    }
  }

  return { actions, cleanedText: cleaned.replace(/\n{3,}/g, '\n\n').trim() }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把工具执行结果格式化成喂回模型的消息文本 */
export function formatToolResult(name, result) {
  const ok = result && result.ok !== false
  const summary = (result && result.summary) || (ok ? '完成' : '失败')
  return `【工具结果】${name}：${ok ? '成功' : '失败'}\n${summary}`
}

/** 系统提示里插入的协议说明（JSON 兜底通道用） */
export const JSON_PROTOCOL_HINT = [
  '你可以调用工具来完成任务。需要调用工具时，在回复中输出一个 JSON 代码块，格式为：',
  '```json',
  '{"action":"工具名","args":{ ... }}',
  '```',
  '一次只调用一个工具；调用后等待工具结果，再继续。',
  '不需要调用工具时，直接正常回复即可，不要输出 JSON。'
].join('\n')
