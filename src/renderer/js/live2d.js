// src/renderer/js/live2d.js
// Live2D 加载与驱动：缩放锚点（底部对齐居中）、自动眨眼、视线跟随、待机动作轮换、
// 戳一戳（TapBody）、情绪 → 表情 + 动作映射、说话口型。
//
// 表情/动作映射来自模型目录下的 nagi-emotion.json，支持两种写法：
//   "joy": "nagi_joy"                                                     // 只映射表情（旧格式）
//   "joy": { "expr": "nagi_joy", "motion": "Happy", "motionChance": 0.75 } // 表情 + 动作
//
// 依赖：vendor/live2dcubismcore.min.js（在 index.html 中先加载）+ pixi.js v7 + pixi-live2d-display/cubism4
import { pickRedParams, shouldRemoveRedGlow } from '../../core/redform.js'
import { DEFAULT_FRAME, fitBand, frameBand, framePreset } from '../../core/frame.js'

let app = null
let model = null
let baseScale = 1
let userScale = 1
let mirrorOn = false
let disposed = false
let mouthHook = null
let redGuard = null
let redIds = []
let frameMode = DEFAULT_FRAME
/**
 * 模型的稳定基准尺寸（模型单位）。
 *
 * 必须在 load() 时缓存一次 —— 否则 layout() 每次去读 internalModel.originalHeight
 * 都可能拿到被污染的值（实测有窗口会返回画布原点 Y = 高度的一半 2232.5），
 * 于是算出 2 倍缩放、形象变成大特写。缓存后与调用时机无关。
 */
let baseW = 0
let baseH = 0
let resizer = null

/* ------------------------------------------------------------------ *
 * 红色形态（红色辉光）裁剪
 *
 * 该模型的"红色形态"完全由 ParamRed* 这一族参数驱动——偏离 0 就发红
 * （正值亮红、负值暗红），闹别扭 / 生气 / 狂暴 / 红眼发光 / 扔剪刀 都会点亮它。
 * 判断与选参的纯逻辑在 core/redform.js（可单测），这里只负责在正确的时刻压回 0。
 *
 * 做法是在"所有参数都写完、网格还没计算"的那一帧时刻把它们压回 0：
 *   motion 写参 → 表情写参 → 目光/呼吸 → 物理 → 【beforeModelUpdate】→ 算网格
 * 放在这里可以一次拦掉全部来源（动作 / 表情 / 物理），又不动任何模型资源，
 * 所以生气的神态、暗面、哭泣、剪刀动作、动作组数量、情绪映射全都保持原样。
 * ------------------------------------------------------------------ */
/** 当前模型被裁剪掉的红色参数（调试/测试用） */
export function redParamIds() {
  return redIds.slice()
}

/**
 * 确定性抓帧：在同一帧内"先渲染、再读回"，得到画布真实像素。
 * 用途是验证取景/对齐——Playwright 对 WebGL 画布的截图常常是空白（缓冲被清空），
 * 而 toDataURL 在 render 之后同步调用就一定是这一帧的画面。
 * 返回 data:image/png;base64,… ；未就绪返回 null。
 */
export function snapshotDataURL() {
  if (!app?.view) return null
  try {
    app.render?.()
    return app.view.toDataURL('image/png')
  } catch {
    return null
  }
}

/**
 * 量出「这一帧里真正画出来的像素范围」（画布像素坐标）。
 *
 * 为什么不能只信数学矩形：该模型的美术画到了声明的 moc 画布之外（头发往上、往右都出界），
 * 所以按声明画布算出来的取景带**不等于**实际画面范围 —— 实测窄窗口下头发会顶到画布边缘被切、
 * 宽窗口下还会钻进右侧工具条的保留区。这里直接读回这一帧的像素、按 alpha 求包围盒，
 * 让「有没有越界」这件事由真实数据回答。
 *
 * 返回 { x0, y0, x1, y1, w, h }；画面全空时返回 { empty:true, w, h }。
 */
export async function measureArtBox() {
  const url = snapshotDataURL()
  if (!url) return null
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const { data } = g.getImageData(0, 0, c.width, c.height)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = 0; y < c.height; y++) {
    const row = y * c.width * 4
    for (let x = 0; x < c.width; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (!Number.isFinite(x0)) return { empty: true, w: c.width, h: c.height }
  return { x0, y0, x1, y1, w: c.width, h: c.height }
}
export function probeArtBounds() {
  // 已废弃：Cubism Core 的 getDrawableVertexPositions 在该构建里返回的是归一化缓冲
  // （实测并集恒为 [-1,-1]~[1,1]），量不出真实画面范围。改用 measureArtBox() 读像素。
  return null
}

/** 取景/布局诊断：画布尺寸、模型原始尺寸、取景带、以及形象在画布里的实际落位 */
export function frameInfo() {
  if (!app || !model) return null
  const { width, height } = app.screen
  const band = frameBand(frameMode, baseW, baseH)
  const fit = fitBand({ band, boxW: width, boxH: height, scale: userScale, pad: readPads() })
  let bounds = null
  try {
    const b = model.getBounds()
    bounds = { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    /* ignore */
  }
  return {
    frame: frameMode,
    preset: framePreset(frameMode),
    band,
    fit,
    base: { w: baseW, h: baseH },
    canvas: { w: width, h: height },
    viewPx: { w: app.view?.width, h: app.view?.height },
    resolution: app.renderer?.resolution,
    modelSize: { w: model.width, h: model.height },
    original: { w: model.internalModel?.originalWidth, h: model.internalModel?.originalHeight },
    mocCanvas: (() => {
      try {
        const ci = model.internalModel?.coreModel?._model?.canvasinfo
        return ci ? { w: ci.CanvasWidth, h: ci.CanvasHeight, ppu: ci.PixelsPerUnit } : null
      } catch {
        return null
      }
    })(),
    scale: { x: model.scale.x, y: model.scale.y },
    anchor: { x: model.anchor.x, y: model.anchor.y },
    pos: { x: model.x, y: model.y },
    bounds
  }
}

/** 调试用：在"裁剪已生效、网格尚未计算"的瞬间采样红色参数，验证裁剪真的在生效 */
export function probeRedOnce() {
  return new Promise((resolve) => {
    const im = model?.internalModel
    if (!im) return resolve(null)
    const core = im.coreModel
    const once = () => {
      try {
        im.off('beforeModelUpdate', once)
      } catch {
        /* ignore */
      }
      const get = (id) => {
        try {
          return core.getParameterValueById(id)
        } catch {
          return null
        }
      }
      resolve({ ParamRedGlow: get('ParamRedGlow'), ParamRedHighlight: get('ParamRedHighlight') })
    }
    // 注册在 guard 之后 → 读到的是被压回 0 之后的值
    im.on('beforeModelUpdate', once)
    setTimeout(() => resolve(null), 1500)
  })
}

/* ------------------------------------------------------------------ *
 * 6 情绪 → 表情候选名
 * 不同模型表情命名差异很大，这里给出通配候选表；按顺序取模型里第一个真实存在的。
 * 若模型目录里有 nagi-emotion.json，则优先用它。
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

/** 「随便动一下」用的动作组（Special 里是作者做的杂技动作） */
const RANDOM_MOTION_GROUPS = ['Happy', 'Greet', 'Special', 'Angry', 'Sad', 'Frenzy', 'TapBody']

let modelName = ''
let overrideMap = null

/* ---------------- 说话口型 ---------------- */
let talking = false
let talkPhase = 0
let talkUntil = 0
/** M5：真实语音的口型时间轴（由 core/voice/lip.js 生成），有它就优先用它 */
let lipTrack = null
let lipClock = null

export function coreAvailable() {
  return typeof window.Live2DCubismCore !== 'undefined'
}

export function getModel() {
  return model
}

/** 模型是否已就绪 */
export function isReady() {
  return !!model
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

/** 映射条目归一化：兼容 "name" 与 { expr, motion, motionChance } */
function normalizeEntry(v) {
  if (!v) return null
  if (typeof v === 'string') return { expr: v, motion: null, motionChance: 0 }
  if (typeof v === 'object') {
    return {
      expr: typeof v.expr === 'string' ? v.expr : null,
      motion: typeof v.motion === 'string' ? v.motion : null,
      motionChance: typeof v.motionChance === 'number' ? v.motionChance : 0.6
    }
  }
  return null
}

function overrideEntry(emotion) {
  if (!overrideMap) return null
  return normalizeEntry(overrideMap[emotion])
}

/**
 * 加载模型
 * @param {HTMLCanvasElement} canvas
 * @param {string} url 形如 nagi-local://models/Lisette/Lisette.model3.json
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
    // 关键：关掉舞台的事件命中测试。
    // pixi-live2d-display@0.4 自带 pixi v6 的 Container（@pixi/display 6.x），
    // 而本应用用的是 pixi.js v7；v7 的 EventBoundary 在每次 pointermove 时会对
    // 场景树调用 currentTarget.isInteractive()——v6 对象没有这个方法，于是刷屏抛
    // "currentTarget.isInteractive is not a function"。把 stage 设为 'none' 后
    // v7 会直接剪枝整棵树，不再触碰模型。
    // 交互（戳一戳 / 拖动窗口 / 视线跟随）全部改由 main.js 的原生 DOM 事件实现。
    app.stage.eventMode = 'none'
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

  // 说话口型：挂在 afterMotionUpdate 上——这一帧的动作参数刚写完，
  // 我们写的嘴型不会被动作/表情覆盖（pixi-live2d-display 的更新顺序见 cubism4.js）
  mouthHook = () => {
    // M5：有真实语音时间轴时以它为准（嘴型跟着她说的话走，而不是随机动）
    if (lipTrack && lipClock) {
      const dur = lipTrack.durationMs > 0 ? lipTrack.durationMs : 1
      const t = lipClock()
      // 用取模：万一音频时长估短了，包络就循环，总比中途僵住张嘴不动好
      setMouthOpen(t <= 0 ? 0 : lipTrack.at(t % dur))
      return
    }
    if (!talking) return
    const now = performance.now()
    if (now > talkUntil) {
      talking = false
      setMouthOpen(0)
      return
    }
    talkPhase = now / 1000
    setMouthOpen(0.14 + Math.abs(Math.sin(talkPhase * 8.5)) * 0.52 + Math.random() * 0.1)
  }
  m.internalModel.on('afterMotionUpdate', mouthHook)

  // 红色形态裁剪（默认开启；模型目录 nagi-emotion.json 里 removeRedGlow:false 可放行）
  if (shouldRemoveRedGlow(overrideMap)) {
    const core = m.internalModel?.coreModel
    redIds = pickRedParams(core?._parameterIds || core?.parameterIds)
    if (redIds.length) {
      redGuard = () => {
        const core = model?.internalModel?.coreModel
        if (!core) return
        for (const id of redIds) {
          try {
            core.setParameterValueById(id, 0)
          } catch {
            /* 个别模型不认某个参数，忽略 */
          }
        }
      }
      m.internalModel.on('beforeModelUpdate', redGuard)
    }
  }

  // 视线跟随鼠标（原生事件，不依赖 pixi 事件系统）
  if (opts.focusFollow !== false) {
    window.addEventListener('pointermove', onPointerMove)
  }

  userScale = opts.scale || 1
  mirrorOn = !!opts.mirror
  // 取景模式：模型目录的 nagi-emotion.json 可覆盖，其次调用方，最后默认（胸像）
  frameMode = overrideMap?.frame || opts.frame || DEFAULT_FRAME
  // 缓存稳定基准尺寸，之后 layout() 只认这两个数
  const m0 = readBaseSize(m)
  baseW = m0.w
  baseH = m0.h

  layout(userScale, mirrorOn)
  // 缩放/尺寸变化时重新布局（跟随窗口大小）
  app.renderer.on('resize', () => layout(userScale, mirrorOn))
  // 容器尺寸变化也要重排：pixi 的 resizeTo 只在 window resize 时触发，
  // 而工作台面板的容器高度会随「动作列表展开/收起」变化 —— 不重排就会
  // 出现画布比容器高、溢出去盖住下方控件的问题（2026-10-15 实测）。
  observeContainer(canvas)
  return m
}

/** 读模型基准尺寸：优先 moc 画布信息（load 时读一次即稳定），回退 originalWidth/Height */
function readBaseSize(m) {
  try {
    const ci = m?.internalModel?.coreModel?._model?.canvasinfo
    if (ci && ci.CanvasWidth > 0 && ci.CanvasHeight > 0) {
      return { w: ci.CanvasWidth, h: ci.CanvasHeight }
    }
  } catch {
    /* ignore */
  }
  const w = Number(m?.internalModel?.originalWidth) || Number(m?.width) || 1
  const h = Number(m?.internalModel?.originalHeight) || Number(m?.height) || 1
  return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 }
}

/** 监听画布容器的尺寸变化 → 同步 pixi 渲染尺寸并重排（尺寸永不失配） */
function observeContainer(canvas) {
  try {
    resizer?.disconnect?.()
  } catch {
    /* ignore */
  }
  const target = canvas?.parentElement
  if (!target || typeof ResizeObserver === 'undefined') return
  resizer = new ResizeObserver(() => {
    try {
      app?.resize?.()
    } catch {
      /* ignore */
    }
    layout(userScale, mirrorOn)
  })
  resizer.observe(target)
}

/**
 * 画布内的安全边距：从容器的 CSS 变量读，这样"要避开哪些画布内 UI"
 * 交给样式表声明（桌宠要避开右侧工具条与底部状态行，工作台不用）。
 */
function readPads() {
  const el = app?.view?.parentElement
  if (!el || typeof getComputedStyle !== 'function') return {}
  try {
    const cs = getComputedStyle(el)
    const get = (n) => Number.parseFloat(cs.getPropertyValue(n)) || 0
    return { top: get('--safe-top'), right: get('--safe-right'), bottom: get('--safe-bottom'), left: get('--safe-left') }
  } catch {
    return {}
  }
}

export function layout(scale = userScale, mirror = mirrorOn, frame = frameMode) {
  userScale = scale
  mirrorOn = !!mirror
  if (frame) frameMode = frame
  if (!app || !model) return

  const { width, height } = app.screen
  const band = frameBand(frameMode, baseW, baseH)
  const fit = fitBand({ band, boxW: width, boxH: height, scale: userScale, pad: readPads() })

  baseScale = fit.scale
  model.anchor.set(0.5, fit.anchorY)
  model.x = fit.x
  model.y = fit.y
  model.scale.set(fit.scale)
  model.scale.x = Math.abs(model.scale.x) * (mirrorOn ? -1 : 1)
}

/** 当前取景模式（bust / full） */
export function getFrame() {
  return frameMode
}

/** 切换取景模式：runtime 调（设置页 / 调试用） */
export function setFrame(frame) {
  frameMode = frame || DEFAULT_FRAME
  layout(userScale, mirrorOn)
}

/** 运行时改缩放（设置页滑杆 / 待机加成用），保持镜像状态 */
export function setScale(scale) {
  layout(scale, mirrorOn)
}

export function getScale() {
  return userScale
}

export function setMirror(on) {
  layout(userScale, !!on)
}

/** 手动触发一次画布重排（容器尺寸变了但没触发 window resize 时用，例如折叠面板） */
export function resize() {
  try {
    app?.resize?.()
  } catch {
    /* ignore */
  }
  layout(userScale, mirrorOn)
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

/* ---------------- 查询 ---------------- */

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

/** 列出某动作组下的动作名（去掉路径与扩展名，给人看） */
export function listMotions(group) {
  if (!model) return []
  try {
    const defs = model.internalModel?.settings?.motions || {}
    const arr = defs[group] || []
    return arr.map((d) => {
      const f = d.File || d.file || ''
      return String(f).split('/').pop().replace(/\.motion3\.json$/, '')
    })
  } catch {
    return []
  }
}

/** 全部动作组 → 动作名，供动作面板展示 */
export function motionCatalog() {
  const out = {}
  for (const g of listMotionGroups()) out[g] = listMotions(g)
  return out
}

/** 解析某情绪应对应到模型里哪个表情名（不存在则 null） */
export function resolveExpression(emotion) {
  const names = listExpressions()
  if (!names.length) return null
  // 1) 模型目录 override
  const ov = overrideEntry(emotion)
  if (ov?.expr && names.includes(ov.expr)) return ov.expr
  // 2) 模型专用 profile
  const prof = profileFor(modelName)
  if (prof && prof[emotion] && names.includes(prof[emotion])) return prof[emotion]
  // 3) 通配候选
  const candidates = GENERIC_EXPRESSIONS[emotion] || []
  const hit = candidates.find((c) => names.includes(c))
  return hit || null
}

/** 解析某情绪对应的动作组（没有映射 / 模型没这组则 null） */
export function resolveMotion(emotion) {
  const ov = overrideEntry(emotion)
  if (!ov?.motion) return null
  const groups = listMotionGroups()
  return groups.includes(ov.motion) ? ov.motion : null
}

/* ---------------- 表情 / 动作 ---------------- */

/**
 * 情绪 → 表情（+ 按概率触发对应动作）
 * @param {string} emotion
 * @param {{motion?:boolean|'force'}} [opts] motion:false 只换表情；'force' 必定播放动作
 */
export function setEmotion(emotion, opts = {}) {
  if (!model) return false
  const name = resolveExpression(emotion)
  let ok = false
  if (name) {
    try {
      model.expression(name)
      ok = true
    } catch {
      ok = false
    }
  }
  if (opts.motion !== false) {
    const group = resolveMotion(emotion)
    if (group) {
      const ov = overrideEntry(emotion)
      const chance = opts.motion === 'force' ? 1 : ov?.motionChance ?? 0.6
      if (Math.random() < chance) playMotion(group)
    }
  }
  return ok
}

/** 调试用：直接按名字应用表情（绕过情绪映射），便于逐个形态比对 */
export function setExpressionRaw(name) {
  if (!model) return false
  try {
    if (!name) {
      model.internalModel?.motionManager?.expressionManager?.resetExpression?.()
      return true
    }
    model.expression(name)
    return true
  } catch {
    return false
  }
}

/** 调试用：读写核心参数（用于手工拼装形态 / 采样当前形态） */
export function readParams(ids = []) {
  const core = model?.internalModel?.coreModel
  if (!core) return null
  const out = {}
  const src = core._parameterIds || core.parameterIds
  const vals = core._parameterValues || core.parameterValues
  if (!src || !vals) return null
  for (let i = 0; i < src.length; i++) {
    if (!ids.length || ids.includes(src[i])) out[src[i]] = vals[i]
  }
  return out
}

/** 播放动作组里的动作；index 省略则随机一个 */
export function playMotion(group, index) {
  if (!model) return false
  const groups = listMotionGroups()
  if (!groups.includes(group)) return false
  try {
    model.motion(group, index)
    return true
  } catch {
    return false
  }
}

/** 随机播一个动作（模型「自由动作展示」用） */
export function randomMotion() {
  if (!model) return null
  const groups = listMotionGroups()
  const pool = RANDOM_MOTION_GROUPS.filter((g) => groups.includes(g))
  const usable = pool.length ? pool : groups
  if (!usable.length) return null
  const group = usable[Math.floor(Math.random() * usable.length)]
  const n = listMotions(group).length
  const index = n ? Math.floor(Math.random() * n) : undefined
  playMotion(group, index)
  return { group, index: index ?? 0 }
}

/** 停掉所有动作（回待机） */
export function stopMotions() {
  try {
    model?.internalModel?.motionManager?.stopAllMotions()
  } catch {
    /* ignore */
  }
}

/* ---------------- 说话口型 ---------------- */

/** 设置嘴部开合（0~1） */
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

/** 开始说话：嘴动起来；持续调用会自动续期，超时自动闭合 */
export function startTalking(holdMs = 900) {
  talking = true
  talkUntil = performance.now() + holdMs
}

/** 结束说话：嘴立刻闭合 */
export function stopTalking() {
  talking = false
  setMouthOpen(0)
}

export function isTalking() {
  return talking || !!lipTrack
}

/**
 * M5：用真实语音的口型时间轴驱动嘴部。
 *
 * 与 startTalking() 的区别：startTalking 只是「嘴随便动动」，用来说「文本正在流」；
 * 这个用 core/voice/lip.js 按音节数和音频时长算出的包络，嘴型跟着她实际说的话走。
 * 一旦设置，mouthHook 就优先用它，直到 clearLipTrack()。
 *
 * @param {{durationMs:number, at:(t:number)=>number}|null} track createLipTrack() 的产物
 * @param {() => number} [clock] 返回相对播放起点的毫秒数。
 *        **一定要传播放器的 currentTime**，别用 performance.now()：
 *        audio.duration 在有些容器上会短暂给出错值，而 currentTime 是播放进度的唯一真相。
 */
export function setLipTrack(track, clock) {
  lipTrack = track && typeof track.at === 'function' ? track : null
  lipClock = lipTrack ? (typeof clock === 'function' ? clock : () => performance.now()) : null
  if (!lipTrack) setMouthOpen(0)
}

export function clearLipTrack() {
  setLipTrack(null)
}

export function destroy() {
  if (disposed) return
  disposed = true
  window.removeEventListener('pointermove', onPointerMove)
  try {
    resizer?.disconnect?.()
  } catch {
    /* ignore */
  }
  resizer = null
  try {
    if (model) {
      if (mouthHook) model.internalModel?.off?.('afterMotionUpdate', mouthHook)
      if (redGuard) model.internalModel?.off?.('beforeModelUpdate', redGuard)
      app?.stage.removeChild(model)
      model.destroy()
    }
    app?.destroy(true, { children: true })
  } catch {
    /* ignore */
  }
  model = null
  app = null
  mouthHook = null
  redGuard = null
  redIds = []
  baseW = 0
  baseH = 0
  talking = false
  lipTrack = null
  lipClock = null
}
