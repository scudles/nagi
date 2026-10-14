// src/core/llm/cloud-workbuddy.js
// 云端大脑适配器（凪云 = WorkBuddy 云服务，2026-10-14 自桌宠原型 llm.js 移植）
// 以与 openai-compatible.chatStream 相同的事件协议暴露，供 runAgentLoop 的 callModel 注入：
//   yield { type: 'delta', text } / { type: 'tool_call', toolCalls } / { type: 'done' }
// 特性：选模型（优先 BRAIN.model）/ 会话级 conversationId / 错误中文化 / 无 Key 依赖（公开键模式）。
// 工具：2026-10-14 实测云网关完整支持 OpenAI 原生 function calling（hunyuan-chat 亦可正确
// 返回 tool_calls，网关侧做了协议转换），因此云端走原生工具通道，不再依赖提示词 JSON 兜底。
// 注意：SDK 是 dual 包，ESM 默认导入会走浏览器构建；主进程用 createRequire 拿 CJS 构建（原型验证过）。
// 另：网关强制 stream: true。

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { publicConfig, BRAIN } from '../../../cloud-config.js'

const require = createRequire(import.meta.url)
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')

let cloud = null;
let modelId = null;       // 启动时从模型目录选定，null = 大脑不可用
let modelName = null;     // 选中模型的展示名
const conversationId = randomUUID(); // 应用级会话 ID（本次运行内稳定，重启换新）

/** 初始化并选模型；返回 { ok, model?, modelName?, error? } */
export async function initCloudBrain() {
  try {
    cloud = createWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey
    });
  } catch (err) {
    console.error('[brain] 客户端初始化失败：', err && err.message);
    return { ok: false, reason: 'config', error: describeError(err) };
  }
  return pickModel();
}

// 选模型：优先 BRAIN.model；被禁用或不存在则取目录里第一个可用的；空目录 = 不可用
async function pickModel() {
  let models = [];
  try {
    models = await cloud.llm.models.list();
  } catch (err) {
    console.error('[brain] 模型目录拉取失败：', describeError(err));
    return { ok: false, reason: 'catalog', error: describeError(err) };
  }
  const usable = models.filter((m) => m.disabled !== true && m.enabled !== false);
  const preferred = usable.find((m) => m.id === BRAIN.model);
  const picked = preferred || usable[0];
  if (!picked) {
    console.warn('[brain] 模型目录为空，大脑不可用，将使用本地 Mock');
    return { ok: false, reason: 'empty', error: '云端模型目录为空' };
  }
  modelId = picked.id;
  modelName = picked.name || picked.id;
  console.log('[brain] 在线，模型 =', modelId, '(' + modelName + ')');
  return { ok: true, model: modelId, modelName };
}

export function cloudBrainStatus() {
  return {
    ok: !!modelId,
    model: modelId,
    modelName: modelName,
    source: modelId ? 'cloud' : 'local'
  };
}

// 错误中文化：按 CloudOpenAIError 的 code 前缀映射，附带 requestId 便于排查
export function describeError(err) {
  const code = err && err.error && err.error.code ? err.error.code : '';
  const requestId = err && err.requestId ? '（requestId: ' + err.requestId + '）' : '';
  var msg;
  if (code === 'gateway_network_error') msg = '网络异常，连不上云端';
  else if (code.indexOf('request_') === 0) msg = '请求参数不被模型接受';
  else if (code.indexOf('auth_') === 0) msg = '云端凭证校验失败';
  else if (code.indexOf('quota_') === 0) msg = '额度不足或触发限流';
  else if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) msg = '模型服务暂时不可用';
  else if (code.indexOf('internal_') === 0) msg = '云端内部错误';
  else msg = '网络异常，连不上云端';
  return msg + requestId;
}

/**
 * 流式对话（与 openai-compatible.chatStream 同协议）。
 * 云端仅支持 stream: true；会话记忆由 Agent Loop 的 messages 管理，此处只转发。
 * tools 存在时走网关的原生 function calling（实测 hunyuan-chat 亦可正确返回）。
 * @returns {AsyncGenerator<{type:'delta'|'tool_call'|'done', text?:string, toolCalls?:Array}>}
 */
export async function* cloudChatStream({ messages, tools, signal }) {
  if (!cloud || !modelId) {
    throw new Error(describeError({ error: { code: 'auth_client_missing' } }));
  }
  try {
    const body = { model: modelId, messages, stream: true, conversationId };
    if (tools && tools.length) body.tools = tools;
    const stream = await cloud.llm.chat.completions.create(body);
    const toolAcc = new Map(); // index -> { id, name, arguments }
    for await (const chunk of stream) {
      if (signal && signal.aborted) break;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        yield { type: 'delta', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
      if (choice.finish_reason) {
        if (toolAcc.size) yield { type: 'tool_call', toolCalls: [...toolAcc.values()] };
        yield { type: 'done', finishReason: choice.finish_reason };
        return;
      }
    }
    if (toolAcc.size) yield { type: 'tool_call', toolCalls: [...toolAcc.values()] };
    yield { type: 'done' };
  } catch (err) {
    // 中止不算错误，原样抛给上层；其余错误中文化后再抛
    if (signal && signal.aborted) throw err;
    throw new Error('云端大脑出错了：' + describeError(err));
  }
}
