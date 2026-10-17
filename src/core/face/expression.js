// src/core/face/expression.js
// 面部表达的三层纯逻辑（2026-10-17）：
//   ① 情绪 → 五官「肌肉」向量，按 mood.intensity 缩放（「有点担心」和「很担心」是两张脸）；
//   ② 静止时的五官微动（真人脸部肌肉永远在轻微动，这一层决定"像人"还是"像雕像"）；
//   ③ 口型的元音形状（替掉单一 MouthOpenY 的正弦随机）。
//
// 为什么放在 core：这三件事都是纯计算（向量缩放、正弦叠加、扫视调度），
// 注入假时钟就能单测（test/face-expression.test.js）。渲染层只负责把它们写进模型。
//
// 设计约束：
//   · 肌肉用满强度(1.0)定义，实际值 = 满强度 × intensity，所以强度是连续谱；
//   · 微动一律用**很小的振幅**（±0.02~0.045），并且左右不同频不同相 ——
//     同步的抖动看起来像故障，不同步的才像肌肉；
//   · 所有输出都只是"增量"，由渲染层决定用 set 还是 add。

/** 解析面部配置；坏数据降级为空（表现层就退回 exp3 表情，而不是崩） */
export function parseFaceConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const errors = []

  const emotions = {}
  for (const [name, vec] of Object.entries(src.emotions || {})) {
    if (!vec || typeof vec !== 'object') {
      errors.push(`情绪 ${name} 的肌肉向量无效`)
      continue
    }
    const clean = {}
    for (const [id, v] of Object.entries(vec)) {
      const n = Number(v)
      if (Number.isFinite(n)) clean[id] = n
    }
    emotions[name] = clean
  }

  const tr = src.tremor || {}
  const channels = (Array.isArray(tr.channels) ? tr.channels : [])
    .filter((c) => c && c.param)
    .map((c) => ({
      param: String(c.param),
      amp: Math.max(0, Number(c.amp) || 0),
      freq: Array.isArray(c.freq) && c.freq.length === 2 ? c.freq.map((f) => Math.max(0.01, Number(f) || 0.1)) : [0.1, 0.25]
    }))
  const sac = tr.saccade || {}
  const saccade = {
    everyMs: Array.isArray(sac.everyMs) && sac.everyMs.length === 2 ? sac.everyMs.map(Number) : [1400, 4200],
    amp: Math.max(0, Number(sac.amp) || 0.04),
    glideMs: Math.max(16, Number(sac.glideMs) || 70)
  }
  const tremor = { amplitude: Number.isFinite(Number(tr.amplitude)) ? Number(tr.amplitude) : 1, channels, saccade }

  const visemes = {}
  for (const [key, vec] of Object.entries(src.visemes || {})) {
    if (key === 'note' || !vec || typeof vec !== 'object') continue
    const clean = {}
    for (const [id, v] of Object.entries(vec)) {
      const n = Number(v)
      if (Number.isFinite(n)) clean[id] = n
    }
    if (Object.keys(clean).length) visemes[key] = clean
  }
  const keys = Object.keys(visemes)
  const order = Array.isArray(src.visemeOrder) ? src.visemeOrder.filter((k) => visemes[k]) : keys
  const switchMs = Array.isArray(src.visemeSwitchMs) && src.visemeSwitchMs.length === 2 ? src.visemeSwitchMs.map(Number) : [150, 260]

  return {
    emotions,
    tremor,
    visemes,
    visemeOrder: order.length ? order : keys,
    visemeSwitchMs: switchMs,
    ok: errors.length === 0 && Object.keys(emotions).length > 0,
    errors
  }
}

/** 取某表情的满强度肌肉向量（没有定义返回 null → 调用方退回 exp3） */
export function musclesFor(cfg, exprName) {
  const vec = cfg?.emotions?.[exprName]
  if (!vec) return null
  return { ...vec }
}

/**
 * 中性值**不是 0** 的参数（2026-10-17）。
 *
 * 这是肌肉层一个很容易踩的坑：缩放公式是「值 × 强度」，隐含假设"中性 = 0"。
 * 对眉毛、嘴角、脸颊都成立，但对**眼开闭**不成立——它的中性值是 1（睁着）。
 * 直接乘会让"0.3 强度的开心"把眼睛压成 0.24，等于闭眼。
 * 所以这类参数要从中性值出发做插值：`1 + (v - 1) × intensity`。
 */
export const PARAM_NEUTRAL = {
  ParamEyeLOpen: 1,
  ParamEyeROpen: 1
}

/** 某参数的中性值（默认 0） */
export function neutralOf(id) {
  return Object.prototype.hasOwnProperty.call(PARAM_NEUTRAL, id) ? PARAM_NEUTRAL[id] : 0
}

/**
 * 按强度缩放。
 * @param {number} intensity 0~1（情绪状态机的 intensity）
 */
export function scaleMuscles(vec, intensity) {
  const i = Math.max(0, Math.min(1, Number(intensity) || 0))
  const out = {}
  for (const [id, v] of Object.entries(vec || {})) {
    const n = neutralOf(id)
    // 中性 0 的量直接乘；中性 1 的（眼开闭）从 1 出发插值，否则强度低时会把眼睛压闭
    const s = n === 0 ? v * i : n + (v - n) * i
    // 太小的值不写：省得给一堆参数塞 0.0001，也让"没这个情绪"时参数真的归零
    if (Math.abs(s - n) > 5e-4) out[id] = s
  }
  return out
}

/**
 * 两组肌肉之间插值（情绪切换时用；t=0 取 a，t=1 取 b）。
 * 一边没有的参数按 0 处理——所以"从 joy 变 calm"会把笑眼慢慢松回去，而不是突跳。
 */
export function blendMuscles(a, b, t) {
  const k = Math.max(0, Math.min(1, Number(t) || 0))
  const out = {}
  const ids = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const id of ids) {
    const va = Number(a?.[id] || 0)
    const vb = Number(b?.[id] || 0)
    const v = va + (vb - va) * k
    if (Math.abs(v) > 5e-4) out[id] = v
  }
  return out
}

/**
 * 某时刻的五官微动增量。
 *
 * 用两路不同频率的正弦叠加来近似平滑噪声（比 Perlin 便宜，且天然连续、无跳变）。
 * 每个通道的相位由 seed 决定，所以左右眉/眼不会同步抖 —— 同步抖动看起来像故障。
 *
 * @param {object} cfg parseFaceConfig 的结果
 * @param {number} tMs 时间（毫秒）
 * @param {number} [seed] 相位种子（同一次运行固定，重启可变）
 * @param {number} [scale] 额外倍率（设置页调"明显程度"用）
 * @returns {Record<string, number>} 参数 → 增量
 */
export function tremorAt(cfg, tMs, seed = 1, scale = 1) {
  const tr = cfg?.tremor
  if (!tr?.channels?.length) return {}
  const t = (Number(tMs) || 0) / 1000
  const k = tr.amplitude * (Number.isFinite(Number(scale)) ? Number(scale) : 1)
  const out = {}
  tr.channels.forEach((c, idx) => {
    const ph = (seed * 1.37 + idx * 2.11) % (Math.PI * 2)
    const w =
      0.62 * Math.sin(2 * Math.PI * c.freq[0] * t + ph) + 0.38 * Math.sin(2 * Math.PI * c.freq[1] * t + ph * 1.7)
    const v = c.amp * k * w
    if (Math.abs(v) > 1e-4) out[c.param] = (out[c.param] || 0) + v
  })
  return out
}

/**
 * 眼球微扫视调度器：每隔 1~4 秒换一个很小的注视偏移，几十毫秒滑过去。
 * 人眼本来就在不停地微扫，眼珠一直不动是最明显的"假"。
 * @param {object} cfg parseFaceConfig 的结果
 * @param {{now?:()=>number, rng?:()=>number}} [deps]
 */
export function createSaccade(cfg, deps = {}) {
  const everyMs = cfg?.tremor?.saccade?.everyMs || [1400, 4200]
  const amp = cfg?.tremor?.saccade?.amp ?? 0.045
  const glideMs = cfg?.tremor?.saccade?.glideMs ?? 70
  const now = deps.now ?? (() => Date.now())
  const rng = deps.rng ?? Math.random

  let nextAt = now() + pick(everyMs, rng)
  let from = { x: 0, y: 0 }
  let to = { x: 0, y: 0 }
  let beganAt = 0

  function pick(range, r) {
    return range[0] + r() * (range[1] - range[0])
  }

  /** 每帧调用；返回当前应当叠加的眼球偏移 */
  function tick(t = now()) {
    if (t >= nextAt) {
      from = { ...to }
      to = { x: (rng() * 2 - 1) * amp, y: (rng() * 2 - 1) * amp * 0.6 }
      beganAt = t
      nextAt = t + pick(everyMs, rng)
    }
    const k = glideMs > 0 ? Math.min(1, Math.max(0, (t - beganAt) / glideMs)) : 1
    // 缓出，看起来像"眼睛移过去"而不是"瞬移"
    const e = 1 - (1 - k) * (1 - k)
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }
  }

  return {
    tick,
    reset: () => {
      from = { x: 0, y: 0 }
      to = { x: 0, y: 0 }
      nextAt = now() + pick(everyMs, rng)
    }
  }
}

/** 随机挑一个元音口型（连续两次不重复由调用方保证） */
export function pickViseme(cfg, rng = Math.random, avoid = null) {
  const order = cfg?.visemeOrder || []
  if (!order.length) return null
  const pool = order.length > 1 && avoid ? order.filter((k) => k !== avoid) : order
  return pool[Math.floor(rng() * pool.length) % pool.length]
}

/** 元音 → 参数（返回副本） */
export function visemeParams(cfg, key) {
  const v = cfg?.visemes?.[key]
  return v ? { ...v } : null
}

/** 说话时换元音的间隔（毫秒） */
export function visemeSwitchMs(cfg, rng = Math.random) {
  const r = cfg?.visemeSwitchMs || [150, 260]
  return Math.round(r[0] + rng() * (r[1] - r[0]))
}
