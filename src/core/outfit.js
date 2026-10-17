// src/core/outfit.js
// 装束（Outfit）：把模型里那些"配件开关"参数组织成可切换的装束。
//
// 为什么装束必须走参数层、不能用表情：
//   Live2D 的 expression 是**独占**的——点「眼镜」表情会把当前情绪表情顶掉。
//   装束要和情绪面容并存，只能由渲染层在 beforeModelUpdate 里以绝对值写参数
//   （见 renderer/js/live2d.js 的 outfitHook）。本文件只做纯逻辑，不碰模型。
//
// 参数语义来自 models/Maine/nagi-outfit.json（依据原包按键说明 + 逐个渲染实测）：
//   Param2/3/4/5 = 短发/丸子头/高马尾/侧编发（互斥，全 0 = 默认长发）
//   Param20 眼镜、Param 兽耳、Param11 蝴蝶结关闭、Param466 披肩关闭、
//   Param467 尾巴关闭、Param322 尾巴位置（1 = 翘起）
//
// 本文件是纯函数：给定配置与当前状态，算出"下一个装束 / 该写哪些参数"，
// 不读时钟、不写文件、不碰 DOM —— 便于单测（test/outfit.test.js）。

/**
 * 解析并校验装束配置。坏数据要降级成"能用"，不能让表现层崩掉。
 * @param {object} raw models/<model>/nagi-outfit.json 的内容
 * @returns {{slots:Array, looks:Array, base:object, defaultLook:string, ok:boolean, errors:string[]}}
 */
export function parseOutfit(raw) {
  const errors = []
  const src = raw && typeof raw === 'object' ? raw : {}
  const slots = []
  for (const s of Array.isArray(src.slots) ? src.slots : []) {
    if (!s || !s.id || !Array.isArray(s.options) || !s.options.length) {
      errors.push(`槽位无效：${JSON.stringify(s)?.slice(0, 60)}`)
      continue
    }
    const options = s.options.filter((o) => o && o.id)
    if (!options.length) {
      errors.push(`槽位 ${s.id} 没有可用选项`)
      continue
    }
    slots.push({ id: String(s.id), name: s.name || String(s.id), options })
  }
  const slotIds = new Set(slots.map((s) => s.id))

  const looks = []
  for (const l of Array.isArray(src.looks) ? src.looks : []) {
    if (!l || !l.id) {
      errors.push(`装束无效：${JSON.stringify(l)?.slice(0, 60)}`)
      continue
    }
    looks.push({
      id: String(l.id),
      name: l.name || String(l.id),
      desc: l.desc || '',
      slots: normalizeSlots(slots, l.slots)
    })
  }
  if (!looks.length && slots.length) {
    // 没写预案就现场造一个"全默认项"的，至少能跑
    looks.push({ id: 'default', name: '默认', desc: '', slots: defaultSlots(slots) })
    errors.push('没配置任何 look，已回退为默认装束')
  }

  const defaultLook = looks.some((l) => l.id === src.defaultLook) ? src.defaultLook : looks[0]?.id || ''
  return {
    slots,
    looks,
    base: src.base && typeof src.base === 'object' ? { ...src.base } : {},
    defaultLook,
    ok: errors.length === 0,
    errors,
    slotIds
  }
}

/** 每个槽位取第一个选项 —— "出厂状态" */
function defaultSlots(slots) {
  const out = {}
  for (const s of slots) out[s.id] = s.options[0].id
  return out
}

/** 把"只写了一部分槽位"的装束补全：缺的槽位按该项默认补齐 */
export function normalizeSlots(slots, partial) {
  const out = defaultSlots(slots)
  if (partial && typeof partial === 'object') {
    for (const s of slots) {
      const want = partial[s.id]
      if (want && s.options.some((o) => o.id === want)) out[s.id] = want
    }
  }
  return out
}

/** 找一个装束（找不到返回 null） */
export function lookById(cfg, id) {
  return cfg?.looks?.find((l) => l.id === id) || null
}

/**
 * 合成某个装束该写的全部参数：base（水印等公共项）+ 各槽位选中选项的参数。
 * 后面的槽位覆盖前面的同名参数（正常配置不会重叠，重叠了以靠后的为准）。
 */
export function lookParams(cfg, lookId) {
  const out = { ...(cfg?.base || {}) }
  const look = lookById(cfg, lookId)
  if (!look) return out
  for (const s of cfg.slots) {
    const optId = look.slots[s.id]
    const opt = s.options.find((o) => o.id === optId)
    if (opt?.params) Object.assign(out, opt.params)
  }
  return out
}

/** 由"槽位表"直接合成参数（自主行为可能只改一个槽位，不走整份 look） */
export function slotsParams(cfg, slots) {
  const out = { ...(cfg?.base || {}) }
  for (const s of cfg?.slots || []) {
    const opt = s.options.find((o) => o.id === slots?.[s.id])
    if (opt?.params) Object.assign(out, opt.params)
  }
  return out
}

/** 装束的人类可读描述（UI 与日志用），如「高马尾 · 不戴 · 露出耳朵 · 系着 · 收起 · 垂着」 */
export function describeLook(cfg, lookId) {
  const look = lookById(cfg, lookId)
  if (!look) return ''
  return cfg.slots
    .map((s) => s.options.find((o) => o.id === look.slots[s.id])?.name || '')
    .filter(Boolean)
    .join(' · ')
}

/**
 * 循环切换装束。
 * @param {number} dir +1 下一个 / -1 上一个
 */
export function cycleLook(cfg, currentId, dir = 1) {
  const ids = (cfg?.looks || []).map((l) => l.id)
  if (!ids.length) return null
  const i = ids.indexOf(currentId)
  const step = dir < 0 ? -1 : 1
  const next = i < 0 ? 0 : (i + step + ids.length) % ids.length
  return ids[next]
}

/**
 * 随机挑一个装束（可与当前相同则重挑，避免"换了个寂寞"）。
 * @param {() => number} rng 注入随机源，便于单测
 */
export function randomLookId(cfg, { avoid = null, rng = Math.random } = {}) {
  const ids = (cfg?.looks || []).map((l) => l.id)
  if (!ids.length) return null
  const pool = ids.length > 1 && avoid ? ids.filter((id) => id !== avoid) : ids
  return pool[Math.floor(rng() * pool.length) % pool.length]
}

/**
 * 只动一个槽位（自主换装的首选：整套换掉太醒目，"只把头发放下来"更像人）。
 * @returns {{slots:object, slot:string, option:string}|null} 没得改就 null
 */
export function shiftOneSlot(cfg, slots, { rng = Math.random } = {}) {
  const changeable = (cfg?.slots || []).filter((s) => s.options.length > 1)
  if (!changeable.length) return null
  const slot = changeable[Math.floor(rng() * changeable.length) % changeable.length]
  const others = slot.options.filter((o) => o.id !== slots?.[slot.id])
  if (!others.length) return null
  const opt = others[Math.floor(rng() * others.length) % others.length]
  return { slots: { ...slots, [slot.id]: opt.id }, slot: slot.id, option: opt.id }
}

/**
 * 参数过滤：只保留模型真正拥有的参数（换模型后配置可能引用不存在的参数）。
 * @param {string[]} paramIds 模型的参数清单（listParamIds()）
 */
export function filterParams(params, paramIds) {
  const has = new Set(paramIds || [])
  const out = {}
  const dropped = []
  for (const [k, v] of Object.entries(params || {})) {
    if (!has.size || has.has(k)) out[k] = v
    else dropped.push(k)
  }
  return { params: out, dropped }
}
