// src/renderer/js/diary.js
// 日记查看器（独立小窗）：列出 userData/monologue/ 下的日记文件，点击阅读。
// 内心独白由主进程情绪引擎静默写入（D2），这里只做按需查看。

const $ = (sel) => document.querySelector(sel)

const els = {
  empty: $('#diary-empty'),
  list: $('#diary-list'),
  content: $('#diary-content')
}

let currentFile = null

export function initDiary() {
  $('#btn-diary-close')?.addEventListener('click', () => window.nagi.win.close())
  $('#btn-diary-refresh')?.addEventListener('click', () => refresh())
  refresh()
}

async function refresh() {
  try {
    const r = await window.nagi.diary.list()
    const dates = r.ok ? r.dates || [] : []
    els.list.innerHTML = ''
    if (!dates.length) {
      els.empty.classList.remove('hidden')
      els.content.innerHTML = ''
      return
    }
    els.empty.classList.add('hidden')
    for (const f of dates) {
      const btn = document.createElement('button')
      btn.className = 'diary-date'
      btn.textContent = f.replace(/^diary-/, '').replace(/\.md$/, '')
      btn.addEventListener('click', () => open(f, btn))
      els.list.appendChild(btn)
    }
    // 默认打开最新一篇
    els.list.firstChild?.click()
  } catch (err) {
    els.empty.textContent = '日记读取失败：' + (err && err.message ? err.message : err)
    els.empty.classList.remove('hidden')
  }
}

async function open(file, btn) {
  if (currentFile === file) return
  currentFile = file
  for (const b of els.list.children) b.classList.toggle('active', b === btn)
  const r = await window.nagi.diary.read(file)
  if (!r.ok) {
    els.content.innerHTML = '<p class="dim">（打不开这一篇。）</p>'
    return
  }
  // 把 markdown 行渲染成条目（- 时间 ［情绪·强度%］ 独白）
  els.content.innerHTML = ''
  for (const line of r.content.split('\n')) {
    const m = line.match(/^- (\d{2}:\d{2}) ［(.+?)·(\d+)%］ (.*)$/)
    if (!m) continue
    const item = document.createElement('div')
    item.className = 'd-item'
    const t = document.createElement('span')
    t.className = 't'
    t.textContent = m[1]
    const s = document.createElement('span')
    s.className = 's'
    s.textContent = m[4]
    const tag = document.createElement('span')
    tag.className = 'dim tag'
    tag.textContent = `${m[2]} ${m[3]}%`
    item.append(t, tag, s)
    els.content.appendChild(item)
  }
  if (!els.content.children.length) {
    els.content.innerHTML = '<p class="dim">（这一篇是空的。）</p>'
  }
}
