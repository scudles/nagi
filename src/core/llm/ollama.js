// 本机 Ollama 服务探测。只接受 loopback 地址，避免把「本地大脑」误配到远端。
// 与主对话共用 OpenAI 兼容格式；这里仅查询 Ollama 的本机模型目录。

export const OLLAMA_PLACEHOLDER_KEY = 'ollama'

export function ollamaTagsUrl(baseURL) {
  let url
  try {
    url = new URL(String(baseURL || ''))
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') return null
  return `${url.origin}/api/tags`
}

export function modelInstalled(model, models) {
  const wanted = String(model || '').trim()
  if (!wanted) return false
  if (/(:cloud|-cloud)$/i.test(wanted)) return false
  return models.includes(wanted) || (!wanted.includes(':') && models.includes(`${wanted}:latest`))
}

/** @returns {Promise<{ok:boolean,reason?:string,error?:string,models:string[],model:string}>} */
export async function checkOllama({ baseURL, model, fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const tagsUrl = ollamaTagsUrl(baseURL)
  const selected = String(model || '').trim()
  if (!tagsUrl) return { ok: false, reason: 'invalid-url', error: 'Ollama 地址必须是本机 http://localhost:端口/v1', models: [], model: selected }
  if (/(:cloud|-cloud)$/i.test(selected)) return { ok: false, reason: 'cloud-model', error: 'Ollama 云端模型不能作为本地大脑', models: [], model: selected }
  try {
    const response = await fetchImpl(tagsUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const models = Array.isArray(body.models)
      ? body.models.map((item) => item?.name || item?.model)
          .filter((name) => typeof name === 'string' && !/(:cloud|-cloud)$/i.test(name))
      : []
    if (!models.length) return { ok: false, reason: 'no-models', error: 'Ollama 已运行，但还没有下载模型', models, model: selected }
    if (!modelInstalled(selected, models)) {
      return { ok: false, reason: 'model-missing', error: `模型 ${selected || '（未填写）'} 尚未安装在本机 Ollama`, models, model: selected }
    }
    return { ok: true, models, model: selected }
  } catch {
    return { ok: false, reason: 'offline', error: '连不上本机 Ollama，请确认服务已启动', models: [], model: selected }
  }
}
