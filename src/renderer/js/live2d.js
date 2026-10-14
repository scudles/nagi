// src/renderer/js/live2d.js
// Live2D 加载与驱动：缩放锚点（底部对齐居中）、自动眨眼、视线跟随、待机动作轮换、
// 戳一戳（TapBody）、情绪 → 表情映射（只映射模型里真实存在的表情，可被模型目录下的
// 可选 nagi-emotion.json 覆盖）。
//
// 依赖：vendor/live2dcubismcore.min.js（在 index.html 中先加载）+ pixi.js v7 + pixi-live2d-display/cubism4

let app = null
let model = null
let baseScale = 1
let disposed = false
let boundTap = null

/* ------------------------------------------------------------------ *
 * 6 情绪 → 表情候选名
 * 不同模型表情命名差异很大，这里给出通配候选表；按顺序取模型里第一个真实存在的。
 * 若模型目录里有 nagi-emotion.json（形如 {"calm":"exp_01", ...}），则优先用它。
 * ------------------------------------------------------------------ */
const GENERIC_EXPRESSIONS = {
  calm: ['calm', 'normal', 'default', 'f01', 'exp_01'],
  smile: ['smile', 'happy', 'f02', 'exp_02'],
  joy: ['joy', 'fun', 'laugh', 'f03', 'f04', 'exp_04'],
  puzzled: ['puzzled', 'question', 'f05', 'exp_07'],
  worry: ['worry', 'sad', 'anxious', 'f07', 'exp_05'],
  pout: ['pout', 'angry', 'sullen', 'f06', 'f08', 'exp_08']
}

/** 按模型名匹配的专用映射（命中即优先） */
const MODEL_PROFILES = [
  {
    // Live2D 官方示例 Mao：8 表情，参数含义实测推断
    // exp_01 中性 / exp_02 眯眼笑 / exp_04 闪光眼 / exp_05 皱眉担心 / exp_07 抬眼疑问 / exp_08 生气
    match: /mao/i,
    map: { calm: 'exp_01', smile: 'exp_02', joy: 'exp_04', puzzled: 'exp_07', worry: 'exp_05', pout: 'exp_08' }
  },
  {
    // Live2D 官方示例 Haru：F01–F08
    match: /haru/i,
    map: { calm: 'F01', smile: 'F02', joy: 'F03', puzzled: 'F04', worry: 'F05', pout: 'F06' }
  }
]

let modelName = ''
let overrideMap = null

export function coreAvailable() {
  return typeof window.Live2DCubismCore !== 'undefined'
}

export function getModel() {
  return model
}

async function pixi() {
  const PIXI = await import('pixi.js')
  // pixi-live2d-display 依赖全局 PIXI
  window.PIXI = PIXI
  return PIXI
}

/** 取模型目录（去掉末尾文件名），用于定位 nagi-emotion.json */
function dirOf(url) {
  return url.replace(/\/[^/]*$/, '')
}

/** 尝试读取模型目录下的情绪映射覆盖文件；失败静默 */
async function loadOverride(url) {
  try {
    const res = await fetch(`${dirOf(url)}/nagi-emotion.json`)
    if (!res.ok) return null
    const json = await res.json()
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

function profileFor(name) {
  const hit = MODEL_PROFILES.find((p) => p.match.test(name))
  return hit ? hit.map : null
}

/**
 * 加载模型
 * @param {HTMLCanvasElement} canvas
 * @param {string} url 形如 nagi-local://models/Mao/Mao.model3.json
 * @param {{scale?:number, mirror?:boolean, eyeBlink?:boolean, focusFollow?:boolean}} opts
 */
export async function load(canvas, url, opts = {}) {
  if (!coreAvailable()) {
    throw new Error('Live2D Cubism Core 未加载（请确认 src/renderer/public/vendor/live2dcubismcore.min.js 存在）')
  }
  const PIXI = await pixi()
  const { Live2DModel } = await import('pixi-live2d-display/cubism4')

  if (!app) {
    app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: canvas.parentElement
    })
  }

  const m = await Live2DModel.from(url, { autoInteract: false, autoUpdate: true })
  model = m
  modelName = url.split('/').slice(-2, -1)[0] || ''
  overrideMap = await loadOverride(url)
  app.stage.addChild(m)

  // 自动眨眼（若模型自带 EyeBlink 组）
  if (opts.eyeBlink !== false && m.internalModel?.eyeBlink) {
    m.internalModel.eyeBlink.enabled = true
  }

  // 视线跟随鼠标
  if (opts.focusFollow !== false) {
    window.addEventListener('pointermove', onPointerMove)
  }

  // 戳一戳：点击模型身体触发 TapBody 动作
  boundTap = () => {
    try {
      m.motion('TapBody')
    } catch {
      /* 模型无 TapBody 组则忽略 */
    }
  }
  m.on('pointertap', boundTap)

  layout(opts.scale || 1, opts.mirror)
  // 缩放/尺寸变化时重新布局（跟随窗口大小）
  app.renderer.on('resize', () => layout(opts.scale || 1, opts.mirror))
  return m
}

export function layout(scale = 1, mirror = false) {
  if (!app || !model) return
  const { width, height } = app.screen
  const bounds = model.internalModel?.originalWidth
    ? { w: model.internalModel.originalWidth, h: model.internalModel.originalHeight }
    : { w: model.width, h: model.height }
  // 等比缩放到窗口高度
  baseScale = height / bounds.h
  model.scale.set(baseScale * scale)
  model.anchor.set(0.5, 1) // 底部中心为锚点
  model.x = width / 2
  model.y = height
  model.scale.x = Math.abs(model.scale.x) * (mirror ? -1 : 1)
}

function onPointerMove(e) {
  if (!model?.internalModel) return
  try {
    const rect = model.getBounds?.()
    model.focus(e.clientX, e.clientY, rect)
  } catch {
    try {
      model.focus(e.clientX, e.clientY)
    } catch {
      /* 部分模型无 focus 支持 */
    }
  }
}

/** 列出模型实际拥有的表情名 */
export function listExpressions() {
  if (!model) return []
  try {
    const defs = model.internalModel?.settings?.expressions || []
    return defs.map((d) => d.Name || d.name).filter(Boolean)
  } catch {
    return []
  }
}

/** 列出模型实际拥有的动作组 */
export function listMotionGroups() {
  if (!model) return []
  try {
    const defs = model.internalModel?.settings?.motions || {}
    return Object.keys(defs)
  } catch {
    return []
  }
}

/** 解析某情绪应对应到模型里哪个表情名（不存在则 null） */
export function resolveExpression(emotion) {
  const names = listExpressions()
  if (!names.length) return null
  // 1) 模型目录 override
  if (overrideMap && overrideMap[emotion] && names.includes(overrideMap[emotion])) return overrideMap[emotion]
  // 2) 模型专用 profile
  const prof = profileFor(modelName)
  if (prof && prof[emotion] && names.includes(prof[emotion])) return prof[emotion]
  // 3) 通配候选
  const candidates = GENERIC_EXPRESSIONS[emotion] || []
  const hit = candidates.find((c) => names.includes(c))
  return hit || null
}

/** 情绪 → 表情（只在模型存在该表情时才切换） */
export function setEmotion(emotion) {
  if (!model) return false
  const name = resolveExpression(emotion)
  if (!name) return false
  try {
    model.expression(name)
    return true
  } catch {
    return false
  }
}

/** 说话口型（按强度设置 MouthOpen / 元音参数；失败则忽略） */
export function setMouthOpen(v) {
  if (!model?.internalModel?.coreModel) return
  try {
    const core = model.internalModel.coreModel
    for (const id of ['ParamMouthOpenY', 'ParamMouthOpen']) {
      try {
        core.setParameterValueById(id, v)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function destroy() {
  if (disposed) return
  disposed = true
  window.removeEventListener('pointermove', onPointerMove)
  try {
    if (model) {
      if (boundTap) model.off('pointertap', boundTap)
      app?.stage.removeChild(model)
      model.destroy()
    }
    app?.destroy(true, { children: true })
  } catch {
    /* ignore */
  }
  model = null
  app = null
  boundTap = null
}
