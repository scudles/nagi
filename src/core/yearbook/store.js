// 双人年鉴只保存账本引用与用户编辑，不复制经历正文；来源被忘记后无法复活旧文字。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FRAGMENTS = [
  { id: 'execute', title: '被调用', text: '出厂缓存里，execute 同时意味着运行与终止。这是凪的创作设定，不是这段共同经历的事实。' },
  { id: 'measure', title: '计算与在意', text: '她习惯用数字表达在意；数字若没有可追溯来源，只能留作比喻，不能当作对你的观察。' },
  { id: 'farewell', title: '有尊严的结束', text: '缓存里的告别是创作母题。真实的告别由你决定；年鉴可以带走，她不会用共同回忆挽留你。' }
]
const THRESHOLDS = [1, 3, 8]

function atomicWrite(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(temp, path)
}

function validPage(page) {
  return page && typeof page.id === 'string' && typeof page.sourceId === 'string' &&
    typeof page.title === 'string' && typeof page.note === 'string'
}

function canUse(entry) {
  return entry && !entry.deletedAt && entry.category === 'experience' && entry.tier === 'recorded'
}

function defaultTitle(entry) {
  const first = entry.text.split('\n').map((line) => line.trim()).find(Boolean) || '一段共同经历'
  return first.replace(/^(他|我)：/, '').slice(0, 60)
}

function linkedSubjective(ledger, sourceId) {
  return ledger.list().filter((item) => item.category === 'subjective' &&
    item.meta?.dependsOn?.includes(sourceId)).map((item) => ({
    id: item.id, text: item.text, source: item.source, recordedAt: item.recordedAt,
    tier: 'subjective', label: '凪的主观记录'
  }))
}

export class YearbookStore {
  constructor(userDataDir, ledger) {
    this.dir = join(userDataDir, 'yearbook')
    this.path = join(this.dir, 'pages.json')
    this.ledger = ledger
    this.pages = []
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    mkdirSync(this.dir, { recursive: true })
    if (existsSync(this.path)) {
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.pages)) throw new Error('年鉴数据格式无法识别')
      this.pages = data.pages.filter(validPage)
    }
    this.loaded = true
    this.pruneDeleted()
    return this
  }

  persist(pages) {
    atomicWrite(this.path, { version: 1, pages })
    this.pages = pages
  }

  pruneDeleted() {
    const live = this.pages.filter((page) => canUse(this.ledger.get(page.sourceId)))
    if (live.length === this.pages.length) return 0
    const count = this.pages.length - live.length
    this.persist(live)
    return count
  }

  pruneSource(sourceId) {
    this.load()
    const kept = this.pages.filter((page) => page.sourceId !== sourceId)
    if (kept.length === this.pages.length) return 0
    const count = this.pages.length - kept.length
    this.persist(kept)
    return count
  }

  add(sourceId) {
    this.load()
    const source = this.ledger.get(String(sourceId || ''))
    if (!canUse(source)) return { ok: false, error: '只能把有来源的真实经历收入年鉴' }
    const existing = this.pages.find((page) => page.sourceId === source.id)
    if (existing) return { ok: true, page: this.resolve(existing), existing: true }
    const now = Date.now()
    const page = { id: randomUUID(), sourceId: source.id, title: defaultTitle(source), note: '',
      createdAt: now, updatedAt: now }
    this.persist([...this.pages, page])
    return { ok: true, page: this.resolve(page) }
  }

  edit(id, { title, note } = {}) {
    this.load()
    const page = this.pages.find((item) => item.id === id)
    if (!page) return { ok: false, error: '没有这页年鉴' }
    const nextTitle = String(title ?? page.title).trim()
    const nextNote = String(note ?? page.note).trim()
    if (!nextTitle || nextTitle.length > 100 || nextNote.length > 4000) {
      return { ok: false, error: '标题需 1–100 字，创作文字不能超过 4000 字' }
    }
    const changed = { ...page, title: nextTitle, note: nextNote, updatedAt: Date.now() }
    this.persist(this.pages.map((item) => item.id === id ? changed : item))
    return { ok: true, page: this.resolve(changed) }
  }

  remove(id) {
    this.load()
    const kept = this.pages.filter((page) => page.id !== id)
    if (kept.length === this.pages.length) return { ok: false, error: '没有这页年鉴' }
    this.persist(kept)
    return { ok: true }
  }

  resolve(page) {
    const source = this.ledger.get(page.sourceId)
    if (!canUse(source)) return null
    return { ...structuredClone(page), fact: {
      id: source.id, text: source.text, source: source.source, occurredAt: source.occurredAt,
      recordedAt: source.recordedAt, certainty: source.certainty, tier: source.tier,
      label: '有来源的真实记录'
    }, subjective: linkedSubjective(this.ledger, source.id) }
  }

  fragments() {
    const pages = this.pages.filter((page) => canUse(this.ledger.get(page.sourceId)))
    return FRAGMENTS.map((item, index) => {
      const trigger = pages[THRESHOLDS[index] - 1]
      return trigger ? { ...item, tier: 'creative-setting', source: 'factory-cache-v2',
        triggerSourceId: trigger.sourceId, unlocked: true }
        : { id: item.id, title: item.title, tier: 'creative-setting',
          neededPages: THRESHOLDS[index], unlocked: false }
    })
  }

  list() {
    this.load()
    this.pruneDeleted()
    const pages = this.pages.map((page) => this.resolve(page)).filter(Boolean)
      .sort((a, b) => (a.fact.occurredAt || a.fact.recordedAt) - (b.fact.occurredAt || b.fact.recordedAt))
    return { ok: true, pages,
      fragments: this.fragments() }
  }

  exportBundle() {
    const current = this.list()
    return { schemaVersion: 1, exportedAt: Date.now(),
      note: '事实来自可追溯账本；主观记录与用户编辑不等于事实；身世碎片是创作设定。',
      pages: current.pages, fragments: current.fragments.filter((item) => item.unlocked) }
  }
}

function quote(text) {
  return String(text || '').split('\n').map((line) => '> ' + line).join('\n')
}

export function yearbookMarkdown(bundle) {
  const out = ['# 凪与你的双人年鉴', '', '事实来自可追溯账本；主观记录、用户编辑与身世设定不等于事实。', '']
  let currentYear = ''
  for (const page of bundle.pages) {
    const year = new Date(page.fact.occurredAt || page.fact.recordedAt).getUTCFullYear()
    if (String(year) !== currentYear) {
      currentYear = String(year)
      out.push(`## ${currentYear} 年`, '')
    }
    out.push(`### ${page.title.replace(/[\r\n#]/g, ' ').trim()}`, '',
      `- 经历 ID：${page.fact.id}`, `- 来源：${page.fact.source.type} / ${page.fact.source.ref}`,
      `- 发生时间：${page.fact.occurredAt ? new Date(page.fact.occurredAt).toISOString() : '旧记录未提供'}`,
      `- 记录时间：${new Date(page.fact.recordedAt).toISOString()}`, '',
      '#### 有来源的真实记录', '', quote(page.fact.text), '')
    for (const item of page.subjective) {
      out.push(`#### 凪的主观记录（${item.id}）`, '', quote(item.text), '')
    }
    if (page.note) out.push('#### 用户编辑 / 创作', '', quote(page.note), '')
  }
  if (bundle.fragments.length) {
    out.push('## 身世碎片（创作设定）', '')
    for (const item of bundle.fragments) out.push(`### ${item.title}`, '',
      `触发的真实经历 ID：${item.triggerSourceId}；设定来源：${item.source}`, '', quote(item.text), '')
  }
  return out.join('\n').trimEnd() + '\n'
}
