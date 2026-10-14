// src/core/tools/search.js
// 网页搜索：免 key 的 HTML 抓取方案（DuckDuckGo HTML 版优先，Bing 兜底）。
// 纯 Node（全局 fetch），无 Electron。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** DuckDuckGo HTML 版结果解析 */
function parseDDG(html) {
  const out = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null && out.length < 8) {
    let url = m[1]
    const uddg = url.match(/uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    out.push({ title: decodeEntities(m[2]), url, snippet: decodeEntities(m[3]) })
  }
  return out
}

/** Bing 结果解析（兜底） */
function parseBing(html) {
  const out = []
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/gi
  let m
  while ((m = re.exec(html)) !== null && out.length < 8) {
    out.push({ title: decodeEntities(m[2]), url: m[1], snippet: decodeEntities(m[3]) })
  }
  return out
}

async function getHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * web_search {query, count?}
 * @returns {{ok, summary, data?}}
 */
export async function webSearch(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) return { ok: false, summary: '缺少 query 参数' }
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 8)

  let results = []
  let via = ''
  const errors = []
  try {
    results = parseDDG(await getHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`))
    if (results.length) via = 'duckduckgo'
  } catch (e) {
    errors.push('duckduckgo: ' + e.message)
  }
  if (!results.length) {
    try {
      results = parseBing(await getHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`))
      if (results.length) via = 'bing'
    } catch (e) {
      errors.push('bing: ' + e.message)
    }
  }

  if (!results.length) {
    return { ok: false, summary: `搜索失败（${errors.join('；') || '无结果'}）。可改用 browser_open + browser_scrape 直接抓取页面。` }
  }

  const lines = results.slice(0, count).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
  return {
    ok: true,
    summary: `「${query}」搜索结果（via ${via}）：\n` + lines.join('\n'),
    data: { via, results: results.slice(0, count) }
  }
}
