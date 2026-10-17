// src/renderer/js/live2d.js
// Live2D 加载与驱动：缩放锚点（底部对齐居中）、自动眨眼、待机动作轮换、
// 戳一戳（TapBody）、情绪 → 表情 + 动作映射、说话口型、对话状态驱动的思考姿态。
//
// 表情/动作映射来自模型目录下的 nagi-emotion.json，支持两种写法：
//   "joy": "nagi_joy"                                                     // 只映射表情（旧格式）
//   "joy": { "expr": "nagi_joy", "motion": "Happy", "motionChance": 0.75 } // 表情 + 动作
//
// 2026-10-15 行为变更：
//   · 「黑脸」系列表情（dark_mask×4）已移除：资源删除 + 模型清单摘除 + 运行时黑名单兜底；
//   · 取消"目光/身体跟随鼠标"（focusController 改为加载时瞬间归中，见 load()）；
//   · 动作改由对话状态驱动：生成期间 setPose('thinking')，回复返回后由调用方按情绪翻脸。
//
// 依赖：vendor/live2dcubismcore.min.js（在 index.html 中先加载）+ pixi.js v7 + pixi-live2d-display/cubism4
import { pickRedParams, shouldRemoveRedGlow } from '../../core/redform.js'
import { DEFAULT_FRAME, fitBand, frameBand, framePreset, frameProfile, standardBoxFor } from '../../core/frame.js'
import { POSE_EASE_RATE, easePose, poseSettled, poseTargets } from '../../core/pose.js'
import { rhythmPoseTargets, RHYTHM_POSE_EASE_RATE } from '../../core/presence/rhythm-pose.js'
import {
  cycleLook,
  describeLook,
  filterParams,
  lookById,
  normalizeSlots,
  parseOutfit,
  randomLookId,
  shiftOneSlot,
  slotsParams
} from '../../core/outfit.js'
import { microEnvelope, parseMicroExpr } from '../../core/microexpr.js'
import { DEFAULT_DEPTH_CONFIG, DEPTH_PIVOT_FY, createDepthMotion } from '../../core/presence/depth-motion.js'
import { TURN_KIND, createTurnController, directionFrom, describeTurn } from '../../core/face/turn.js'
import { createBlinkScheduler } from '../../core/face/blink.js'
import { createEyeWander } from '../../core/face/eye.js'
import {
  blendMuscles,
  createSaccade,
  musclesFor,
  neutralOf,
  parseFaceConfig,
  pickViseme,
  scaleMuscles,
  tremorAt,
  visemeParams,
  visemeSwitchMs
} from '../../core/face/expression.js'

let app = null
let model = null
let baseScale = 1
/** 当前取景带（layout 时写入）：Z 轴缩放支点要按它算，bust / full 的带底不同 */
let curBand = null
let userScale = 1
let mirrorOn = false
let disposed = false
let mouthHook = null
let redGuard = null
let redIds = []
let frameMode = DEFAULT_FRAME
// 装束（见文件末尾「装束」一节）：配置来自模型目录的 nagi-outfit.json
let outfit = null // parseOutfit 的结果
let outfitSlots = null // 当前槽位表 { hair: 'long', ... }
let outfitLookId = '' // 当前装束 id（槽位表刚好等于某个预设时才有值）
let outfitTarget = null // 目标参数 { Param: value }，hook 每帧按绝对值写入
let outfitHook = null
let blinkState = null // 过渡掩护：主动眨眼
let headState = null // 过渡掩护：轻微头部偏移
let blinkHook = null
let headHook = null
// 瞬时微表情（见文件末尾「微表情」一节）：配置来自模型目录的 nagi-microexpr.json
let microCfg = null
let microHook = null
let microState = null
// 面部表达三层（2026-10-17）：配置来自 nagi-face.json
let faceCfg = null
let emotionHook = null // 情绪肌肉层（set 绝对值 + 缓动）
let emotionState = { cur: {}, target: {} }
let tremorHook = null // 五官微动（add 小增量）
let tremorSeed = Math.random() * 100
let tremorScale = 1
let faceSaccade = null // 眼球微扫视调度
let visemeHook = null // 口型（元音形状；与上面的 mouthHook 是两层：那层算开口度，这层决定嘴形）
let mouthShape = null
let mouthShapeAt = 0
let mouthLastViseme = null
let mouthValue = 0
// 前后（Z 轴）动作：模型外面套一层容器（zContainer），只动它的 scale/x/y；
// 参数层由 depthMotion 状态机算增量，hook 里 add 写入。详见该节注释。
let zContainer = null
let depthMotion = null
let depthHook = null
let depthSeq = 0
let depthCfg = { ...DEFAULT_DEPTH_CONFIG }
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
 * 「黑脸」系列表情黑名单（dark_mask×4：整脸压黑的死相）
 *
 * 2026-10-15 需求：任何回答情境下都不该出现该系列表情。
 * 三道防线：① 资源文件已从模型目录删除；② model3.json 里的条目已摘除；
 * ③ 这里再兜一层——即使模型文件被还原、或换一个自带同名表情的模型，
 *    也加载不进来（listExpressions 过滤）、映射不到（resolveExpression 走 listExpressions）、
 *    调试口也触发不了（setExpressionRaw 拒绝）。
 * ------------------------------------------------------------------ */
// 2026-10-17 换模型后补：缅因妹妹的「脸黑」（dark_face）同样是"整脸压黑"的死相，
// 而旧黑名单只认 dark_mask 这个名字——换模型时防线会静默失效（verify:pose 抓到的）。
const HIDDEN_EXPRESSIONS = ['dark_mask', 'dark_mask2', 'dark_mask3', 'dark_mask4', '脸黑']
const HIDDEN_EXPRESSION_RE = /dark[_-]?mask|dark[_-]?face|脸黑/i

/** 该表情名是否属于「黑脸」系列（对外导出供测试/调试断言） */
export function isHiddenExpression(name) {
  const n = String(name || '').toLowerCase()
  return HIDDEN_EXPRESSIONS.includes(n) || HIDDEN_EXPRESSION_RE.test(n)
}

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
  const band = frameBand(frameMode, baseW, baseH, modelName)
  const fit = fitBand({ band, boxW: width, boxH: height, scale: userScale, pad: readPads(), standard: standardBoxFor(frameMode) })
  let bounds = null
  try {
    const b = model.getBounds()
    bounds = { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    /* ignore */
  }
  return {
    frame: frameMode,
    preset: frameProfile(frameMode, modelName),
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

/** 姿态相关参数（思考姿态写的就是这一族） */
const POSE_PARAM_IDS = ['ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX']

/**
 * 调试/验证：在"姿态已生效、网格尚未计算"的瞬间采样姿态参数。
 *
 * 为什么不能在帧外读：Cubism 每帧末尾会 loadParameters() 还原到动作写完时的快照，
 * 姿态/表情/呼吸/焦点这些都是"这一帧的叠加量"，帧外读到的永远是叠加前的值——
 * 红色参数当年就是因此才必须在 beforeModelUpdate 里采（见 probeRedOnce）。
 * 本函数注册在姿态钩子之后，读到的是叠加后的真实值。
 */
export function probePoseOnce(ids = POSE_PARAM_IDS) {
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
      const out = {}
      for (const id of ids) {
        try {
          out[id] = core.getParameterValueById(id)
        } catch {
          out[id] = null
        }
      }
      resolve(out)
    }
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

/** 读取模型目录下的装束配置 nagi-outfit.json；没有就返回空配置（表现层静默降级） */
async function loadOutfitConfig(url) {
  try {
    const res = await fetch(`${dirOf(url)}/nagi-outfit.json`)
    if (!res.ok) return parseOutfit(null)
    return parseOutfit(await res.json())
  } catch {
    return parseOutfit(null)
  }
}

/** 读取模型目录下的微表情池 nagi-microexpr.json；没有就返回空池（她只是不闪而已） */
async function loadMicroExprConfig(url) {
  try {
    const res = await fetch(`${dirOf(url)}/nagi-microexpr.json`)
    if (!res.ok) return parseMicroExpr(null)
    return parseMicroExpr(await res.json())
  } catch {
    return parseMicroExpr(null)
  }
}

/** 读取模型目录下的面部表达配置 nagi-face.json；没有就返回空配置 */
async function loadFaceConfig(url) {
  try {
    const res = await fetch(`${dirOf(url)}/nagi-face.json`)
    if (!res.ok) return parseFaceConfig(null)
    return parseFaceConfig(await res.json())
  } catch {
    return parseFaceConfig(null)
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
 * @param {{scale?:number, mirror?:boolean, eyeBlink?:boolean, depth?:object, outfit?:any}} opts
 *   depth: 前后（Z 轴）动作配置 { enabled, amount }（设置页 live2d.depthMotion）
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
  outfit = await loadOutfitConfig(url)
  microCfg = await loadMicroExprConfig(url)
  faceCfg = await loadFaceConfig(url)
  // 前后（Z 轴）动作的载体：模型外面套一层容器。只动这一层的 scale/x/y
  // （绕模型锚点——即取景带底边/肚脐线——缩放与位移），layout() 给模型本人的
  // 定位原样不动，于是取景、镜像、安全边距全不受影响，画面也不会被拉变形。
  zContainer = new PIXI.Container()
  zContainer.addChild(m)
  app.stage.addChild(zContainer)

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

  // 配置随 load 灌入（设置页之后的改动走 configureDepth 热更新），
  // 免得"先按默认起跑、再被纠正"出现一帧的幅度跳变。
  // hook 本身的注册在下面 ensureEarHook() 之后——原因见那里。
  if (opts.depth) depthCfg = { ...DEFAULT_DEPTH_CONFIG, ...opts.depth }

  // 目光/身体跟随鼠标：已取消（2026-10-15 需求，立绘动作改由对话状态驱动）。
  // 光撤监听不够 —— focusController 每帧都会把它内部的目标值写进
  // ParamAngle*/ParamEyeBall*，而 focus() 不调用时它停在"鼠标最后停留的位置"，
  // 她会一直盯着那儿看。这里在加载时瞬间归中，之后目光交还给：
  //   · 思考姿态（setPose('thinking')，生成回复期间）
  //   · 模型自身的自然动作（呼吸/待机，全部归零时）
  try {
    m.internalModel?.focusController?.focus(0, 0, true)
  } catch {
    /* 个别模型没有 focusController，忽略 */
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

  // 装上她当前的装束：优先设置里存过的（opts.outfit 可以是 look id 或槽位表），
  // 否则用配置里的默认装束。首次应用不走过渡——没有"切换"的观感，直接就是那个样子。
  const saved = opts.outfit
  const startLook = typeof saved === 'string' && lookById(outfit, saved) ? saved : outfit.defaultLook
  if (startLook) {
    const look = lookById(outfit, startLook)
    if (look) applyOutfitSlots(look.slots, { lookId: startLook, transition: false })
  } else if (saved && typeof saved === 'object') {
    applyOutfitSlots(saved, { transition: false })
  }

  // 面部表达：微动与口型一直要跑；肌肉层等第一次 setEmotion 才装（那时才有目标值）
  ensureTremorHook()
  ensureVisemeHook()
  ensureTurnHook()
  ensureIdleHeadHook()
  ensureAutoBlinkHook()
  ensureEyeWanderHook()
  ensureEarHook()
  // 前后（Z 轴）动作的 hook 必须注册在**这一串的最后**：
  // beforeModelUpdate 的监听器按**注册顺序**执行（pixi-live2d-display 用
  // eventemitter3，FIFO——2026-10-17 实测纠正：早前注释写的"后注册先执行"是错的，
  // probeRedOnce/probePoseOnce"注册在后就已生效"与 freezeIdleMotion 能按住待机，
  // 两条都只在 FIFO 下成立）。而转向层 turnHook 对 ParamAngle*/ParamBodyAngle*
  // 是 set 绝对值：depth 若排在它前面，add 的角度增量会被整个盖掉——归来时
  // playTurn('return') 与 triggerDepth('peek') 正好叠加，探头的抬头就丢了。
  // 放最后，depth 的增量才叠在每一层之上：turn 的绝对值当底，待机摆头/思考姿态/
  // 时段表现/呼吸都是 add 照常相加，容器层（scale/dx/dy）则谁都不碰、天然独占。
  // redGuard 只写 ParamRed*，与 depth 无交集，谁先谁后都行。
  ensureDepthHook()
  if (faceCfg?.emotions) console.log('[live2d] 面部表达：', faceCfg.tremor.channels.length, '路微动 /', faceCfg.visemeOrder.length, '个元音')
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
  const band = frameBand(frameMode, baseW, baseH, modelName)
  // standard：各界面统一缩放比例（桌宠 / 工作台 / 设置同尺寸，大窗锁标准、小窗等比缩小）
  const fit = fitBand({ band, boxW: width, boxH: height, scale: userScale, pad: readPads(), standard: standardBoxFor(frameMode) })

  baseScale = fit.scale
  curBand = band // Z 轴支点要按当前取景带算（bust / full 的带底不同）
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

/* ---------------- 对话状态驱动的姿态（思考） ----------------
 *
 * 做法与红色形态裁剪同源：挂在 beforeModelUpdate 上——这一帧
 *   motion 写参 → 表情写参 → 目光(focus) → 呼吸 → 物理 → 【beforeModelUpdate】→ 算网格
 * 我们的偏移在最后一刻加进去，不会被动作/表情覆盖；用 add（不是 set），
 * 这样模型的呼吸、待机动作仍然在该参数上生效，思考姿态是"叠加在上面的轻微倾向"。
 *
 * 退出是渐变的：平滑归零后才撤钩，让模型自身的动作无缝接管，不会跳一下。
 */
let poseHook = null
let poseState = null // { name, target:{id:值}, cur:{id:当前值}, releasing:bool }
let poseLastAt = 0

/**
 * 切换姿态。
 * @param {string|null} name 'thinking' = 思考（目光偏移 + 轻微低侧头）；null = 收回中立
 * @returns {boolean} 模型就绪且已受理
 */
export function setPose(name) {
  if (!model?.internalModel) return false
  const target = poseTargets(name)
  if (poseHook) {
    // 已在运行：只改目标。thinking→thinking 不重启；任何→中立 开始平滑收回。
    // 收回时保留原姿态名——getPose() 要能报出 "thinking→neutral"，调用方才知道在收敛中。
    poseState.target = target
    poseState.releasing = Object.keys(target).length === 0
    if (!poseState.releasing) poseState.name = name
    return true
  }
  if (!Object.keys(target).length) return true // 本来就是中立，不必挂钩
  const cur = {}
  for (const id of Object.keys(target)) cur[id] = 0
  poseState = { name, target, cur, releasing: false }
  poseLastAt = performance.now()
  poseHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - poseLastAt) / 1000))
    poseLastAt = now
    // 遍历"目标 ∪ 当前值"：收回时 target 是空表，但 cur 里还有没收完的值，
    // 必须继续把它们平滑归零——只遍历 target 会第一帧就判定 settled 而硬切。
    const ids = new Set([...Object.keys(poseState.target), ...Object.keys(poseState.cur)])
    let settled = true
    for (const id of ids) {
      const t = poseState.target[id] ?? 0
      const c = easePose(poseState.cur[id] ?? 0, t, dt, POSE_EASE_RATE)
      poseState.cur[id] = c
      if (!poseSettled(c, t)) settled = false
      if (Math.abs(c) > 5e-4) {
        try {
          core.addParameterValueById(id, c)
        } catch {
          /* 模型没这个参数就跳过 */
        }
      }
    }
    if (poseState.releasing && settled) {
      try {
        model.internalModel.off('beforeModelUpdate', poseHook)
      } catch {
        /* ignore */
      }
      poseHook = null
      poseState = null
    }
  }
  model.internalModel.on('beforeModelUpdate', poseHook)
  return true
}

/** 当前姿态（调试/验证用）：'neutral' | 'thinking' | 'thinking→neutral'（收回中） */
export function getPose() {
  if (!poseState) return 'neutral'
  return poseState.releasing ? `${poseState.name}→neutral` : poseState.name
}

/* ---------------- 昼夜时段表现（BLUE-2） ----------------
 *
 * 与「思考姿态」同源做法：挂 beforeModelUpdate——这一帧所有参数刚写完，
 * 我们的偏移在最后一刻加进去，不会被动作/表情覆盖；用 add（不是 set），
 * 模型的呼吸、待机动作仍然在该参数上生效，时段表现是"叠加在上面的轻微倾向"。
 * 与 poseHook（思考）/ redGuard（红色裁剪）三个 hook 互不干扰地叠加。
 *
 * 进入/退出都是渐变的（指数平滑），切换时段不硬切；面容归情绪状态机
 * （mood.applyRhythm 每时段推温和基线），这里只做参数层，不夺脸。
 */
let rhythmHook = null
let rhythmState = null // { name, target:{id:值}, cur:{id:当前值}, releasing:bool }
let rhythmLastAt = 0

/**
 * 应用 / 收回时段表现。
 * @param {object|null} rhythm presence 快照里的 rhythm；null / 关闭 / 无预设 → 平滑收回
 * @returns {boolean} 模型就绪且已受理
 */
export function applyRhythmPose(rhythm) {
  if (!model?.internalModel) return false
  const t = rhythmPoseTargets(rhythm, listParamIds())
  if (!t) {
    // 无表现可施加：已在运行就平滑收回，没在运行就无事发生
    if (rhythmHook && !rhythmState.releasing) {
      rhythmState.target = {}
      rhythmState.releasing = true
    }
    return false
  }
  if (rhythmHook) {
    // 新时段直接改目标（不收回重来，切换是渐变的）；若正处释放途中则取消释放
    rhythmState.target = t.params
    rhythmState.releasing = false
    rhythmState.name = t.name
    return true
  }
  const cur = {}
  for (const id of Object.keys(t.params)) cur[id] = 0
  rhythmState = { name: t.name, target: t.params, cur, releasing: false }
  rhythmLastAt = performance.now()
  rhythmHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - rhythmLastAt) / 1000))
    rhythmLastAt = now
    // 遍历"目标 ∪ 当前值"：收回时 target 是空表，但 cur 里还有没收完的值
    const ids = new Set([...Object.keys(rhythmState.target), ...Object.keys(rhythmState.cur)])
    let settled = true
    for (const id of ids) {
      const target = rhythmState.target[id] ?? 0
      const c = easePose(rhythmState.cur[id] ?? 0, target, dt, RHYTHM_POSE_EASE_RATE)
      rhythmState.cur[id] = c
      if (!poseSettled(c, target)) settled = false
      if (Math.abs(c) > 5e-4) {
        try {
          core.addParameterValueById(id, c)
        } catch {
          /* 模型没这个参数就跳过 */
        }
      }
    }
    if (rhythmState.releasing && settled) {
      try {
        model.internalModel.off('beforeModelUpdate', rhythmHook)
      } catch {
        /* ignore */
      }
      rhythmHook = null
      rhythmState = null
    }
  }
  model.internalModel.on('beforeModelUpdate', rhythmHook)
  return true
}

/** 当前时段表现（调试/验证用）：'neutral' | 'night' | 'afternoon' | 'night→neutral'（收回中） */
export function getRhythmPose() {
  if (!rhythmState) return 'neutral'
  return rhythmState.releasing ? `${rhythmState.name}→neutral` : rhythmState.name
}

/* ---------------- 装束（Outfit） ----------------
 *
 * 与「昼夜时段表现」同源：第四个 beforeModelUpdate 钩子，但语义不同——
 *   · rhythmHook 用 add —— 那是"叠加在上面的轻微倾向"，呼吸/待机仍在该参数上生效；
 *   · outfitHook 用 set（绝对值）—— 装束是"她穿成什么样"，必须压过动作/表情写的 0，
 *     否则动作每帧把配件参数写回 0，配件就会一闪一闪。
 *
 * 为什么不用表情做装束：Live2D 的 expression 是**独占**的——点「眼镜」表情会把当前
 * 情绪表情顶掉。装束要和情绪面容并存，只能走参数层（nagi-outfit.json 的每个选项
 * 就是一组参数，见 src/core/outfit.js）。
 *
 * 切换不硬切：眨眼掩护（眼睛完全闭合的那一帧才改参数）+ 轻微头部偏移，
 * 观感上像"眨个眼就换好了"，而不是"啪"地一下变了个样。
 * 与 poseHook（思考姿态）/ rhythmHook（昼夜）/ redGuard（红色裁剪）四者并存、互不夺参。
 */
const BLINK_CLOSE_MS = 110
const BLINK_HOLD_MS = 60
const BLINK_OPEN_MS = 170
const HEAD_NUDGE_MS = 900

/**
 * 眨眼埋点：记录这次掩护里驱动过的最小开度。
 * 为什么要埋点：验证脚本不能靠"读参数"确认眨眼（渲染库定格的数组读不到表情/眨眼
 * 那一层的值，见 deepProbe），而这些值是我们自己写出去的，直接记最可靠。
 */
let blinkTraceData = { count: 0, min: Infinity, at: 0 }

/** 装束参数层：每帧把目标值按绝对值写回（最后一个写，压过动作与表情） */
function ensureOutfitHook() {
  if (outfitHook || !model?.internalModel) return
  outfitHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core || !outfitTarget) return
    for (const id of Object.keys(outfitTarget)) {
      try {
        core.setParameterValueById(id, outfitTarget[id])
      } catch {
        /* 模型没这个参数（换模型/配置过期）：跳过，不打断这一帧 */
      }
    }
  }
  model.internalModel.on('beforeModelUpdate', outfitHook)
}

/** 主动眨眼；眼睛完全闭合的那一刻回调 onClosed —— 用它把参数切换"藏"在闭眼里 */
function briefBlink(onClosed) {
  if (!model?.internalModel) {
    onClosed?.()
    return
  }
  if (blinkHook) {
    // 已经在眨：直接提交，别让第二次切换排队等（快速连按热键时不至于卡住）
    onClosed?.()
    return
  }
  const state = { t0: performance.now(), fired: false, onClosed }
  blinkState = state
  blinkHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const el = performance.now() - state.t0
    const end = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS
    let v = 1
    if (el < BLINK_CLOSE_MS) v = 1 - el / BLINK_CLOSE_MS
    else if (el < BLINK_CLOSE_MS + BLINK_HOLD_MS) v = 0
    else if (el < end) v = (el - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS
    blinkTraceData.count++
    blinkTraceData.min = Math.min(blinkTraceData.min, v)
    blinkTraceData.at = Date.now()
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
      try {
        core.setParameterValueById(id, v)
      } catch {
        /* 模型没有这个参数就放弃眨眼掩护 */
      }
    }
    if (!state.fired && el >= BLINK_CLOSE_MS) {
      state.fired = true
      try {
        state.onClosed?.()
      } catch {
        /* 切换失败不能把 hook 弄死 */
      }
    }
    if (el >= end) {
      try {
        model.internalModel.off('beforeModelUpdate', blinkHook)
      } catch {
        /* ignore */
      }
      blinkHook = null
      blinkState = null
    }
  }
  model.internalModel.on('beforeModelUpdate', blinkHook)
}

/** 轻微头部偏移：给切换一个"她动了一下"的由头，1 秒内起落 */
function nudgeHead(dir = 0) {
  if (!model?.internalModel) return
  const amount = (dir < 0 ? -1 : 1) * 2.2
  if (headHook) {
    headState = { ...headState, t0: performance.now(), amount }
    return
  }
  const state = { t0: performance.now(), amount }
  headState = state
  headHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const el = performance.now() - state.t0
    if (el >= HEAD_NUDGE_MS) {
      try {
        model.internalModel.off('beforeModelUpdate', headHook)
      } catch {
        /* ignore */
      }
      headHook = null
      headState = null
      return
    }
    const env = Math.sin(Math.PI * (el / HEAD_NUDGE_MS)) // 0 → 1 → 0
    try {
      core.addParameterValueById('ParamAngleZ', state.amount * env)
      core.addParameterValueById('ParamBodyAngleZ', state.amount * 0.5 * env)
    } catch {
      /* 没有这些参数就只当没加 */
    }
  }
  model.internalModel.on('beforeModelUpdate', headHook)
}

/** 槽位表是否刚好等于某个预设装束 */
function matchLookId(slots) {
  if (!outfit?.looks?.length || !slots) return ''
  for (const l of outfit.looks) {
    if (outfit.slots.every((s) => l.slots[s.id] === slots[s.id])) return l.id
  }
  return ''
}

/** 装上某套槽位（内部入口）：算参数 → 视情况走眨眼掩护再提交 */
function applyOutfitSlots(slots, opts = {}) {
  if (!outfit?.slots?.length) return false
  const merged = normalizeSlots(outfit.slots, slots)
  const { params } = filterParams(slotsParams(outfit, merged), listParamIds())
  outfitSlots = merged
  outfitLookId = opts.lookId || matchLookId(merged)
  const commit = () => {
    outfitTarget = params
    ensureOutfitHook()
  }
  if (opts.transition === false) {
    commit()
  } else {
    nudgeHead(opts.headDir ?? 0)
    briefBlink(commit)
  }
  return true
}

/** 装束配置（给设置页/菜单渲染选项用） */
export function outfitConfig() {
  if (!outfit) return null
  return { slots: outfit.slots, looks: outfit.looks, defaultLook: outfit.defaultLook }
}

/** 当前装束（调试/验证/UI 用） */
export function currentOutfit() {
  const lookId = outfitLookId
  return {
    lookId,
    slots: outfitSlots ? { ...outfitSlots } : null,
    name: lookId ? lookById(outfit, lookId)?.name || '' : '',
    describe: lookId ? describeLook(outfit, lookId) : '',
    params: outfitTarget ? { ...outfitTarget } : null
  }
}

/** 按预设装束切换（用户热键/菜单/自主换装都走这里） */
export function setOutfitLook(lookId, opts = {}) {
  const look = lookById(outfit, lookId)
  if (!look) return false
  return applyOutfitSlots(look.slots, { ...opts, lookId })
}

/** 按槽位表切换（自主换装"只动一处"走这条，观感更细） */
export function setOutfitSlots(slots, opts = {}) {
  return applyOutfitSlots(slots, opts)
}

/** 下一个 / 上一个装束；返回新 id，没得换返回 null */
export function cycleOutfit(dir = 1, opts = {}) {
  if (!outfit?.looks?.length) return null
  const next = cycleLook(outfit, outfitLookId || outfit.defaultLook, dir)
  if (!next) return null
  return setOutfitLook(next, { ...opts, headDir: dir }) ? next : null
}

/** 随机换一套（不会抽到当前这套） */
export function randomOutfit(opts = {}) {
  const id = randomLookId(outfit, { avoid: outfitLookId, rng: opts.rng })
  if (!id) return null
  return setOutfitLook(id, opts) ? id : null
}

/** 只换一个槽位（自主换装的首选：整套换掉太醒目） */
export function shiftOutfitSlot(opts = {}) {
  if (!outfit?.slots?.length || !outfitSlots) return null
  const r = shiftOneSlot(outfit, outfitSlots, { rng: opts.rng })
  if (!r) return null
  return setOutfitSlots(r.slots, opts) ? r : null
}

/** 当前装束参数（验证脚本读它比对） */
export function outfitParams() {
  return outfitTarget ? { ...outfitTarget } : null
}

/* ---------------- 瞬时微表情（2026-10-17） ----------------
 *
 * 把模型里那些"一次性特效表情"（星星眼/花花/吐舌/炸毛…）用起来。
 *
 * 为什么是参数层 + add，而不是 expression：
 *   · expression 独占——用它闪一下星星眼，会把当前情绪那张脸顶掉；
 *   · add 是叠加——她该有的表情还在，只是临时多了一双星星眼；
 *   · 到期把权重缓到 0 就收回，不会残留。
 *
 * 这是第 5 个 beforeModelUpdate 钩子，与 redGuard／poseHook／rhythmHook／outfitHook 并存。
 * 池里的参数刻意避开了情绪与装束已经在用的那些（见 nagi-microexpr.json）。
 */
/** 微表情池（渲染层挑选用；没有配置就返回空池） */
export function microExprConfig() {
  return microCfg || { pool: [], holdMs: [1200, 2200], ok: false, errors: ['没有微表情配置'] }
}

/**
 * 闪一个微表情。
 * @param {Record<string, number>} params 参数 → 峰值（通常是 1）
 * @param {number} holdMs 总时长（含淡入淡出）
 * @returns {boolean} 受理
 */
export function playMicroExpr(params, holdMs = 1600) {
  if (!model?.internalModel) return false
  const ids = Object.keys(params || {})
  if (!ids.length) return false
  if (microHook) {
    // 正在闪：直接换目标、重新计时（快速连发时不会叠加成双份眼睛）
    microState = { params: { ...params }, holdMs, t0: performance.now() }
    return true
  }
  const state = { params: { ...params }, holdMs, t0: performance.now() }
  microState = state
  microHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const el = performance.now() - state.t0
    const w = microEnvelope(el, state.holdMs)
    for (const id of Object.keys(state.params)) {
      const v = state.params[id] * w
      if (Math.abs(v) > 1e-4) {
        try {
          core.addParameterValueById(id, v)
        } catch {
          /* 模型没这个参数就跳过 */
        }
      }
    }
    if (el >= Math.max(state.holdMs, 400)) {
      try {
        model.internalModel.off('beforeModelUpdate', microHook)
      } catch {
        /* ignore */
      }
      microHook = null
      microState = null
    }
  }
  model.internalModel.on('beforeModelUpdate', microHook)
  return true
}

/** 当前微表情状态（调试/验证用：能看出"正在闪"和"已经收回"） */
export function microExprState() {
  if (!microState) return null
  return { params: { ...microState.params }, holdMs: microState.holdMs, elapsed: performance.now() - microState.t0 }
}

/* ---------------- 面部表达三层（2026-10-17） ----------------
 *
 * 这个模型本来是给面捕直播用的，`ParamGroup` 里那 15 个标准面部参数
 * （眼开闭/眼笑/眼珠/眼球深度/眉毛上下与变形/嘴变形/嘴张开）+ `ParamGroup5` 的 11 个
 * 精细口型参数，足够做"五官微妙调整"。之前我们只用了其中 8 个，而且用法是离散的：
 * 情绪靠 exp3 一张一张切、静止时脸完全不动的。这里补三层：
 *
 *   ① 肌肉层（set 绝对值 + 缓动）：情绪 → 五官参数向量 × intensity。
 *      「有点担心」和「很担心」变成两张脸；情绪衰减时脸跟着松下来，而不是突变。
 *   ② 微动层（add 小增量）：眉毛/嘴角/眼睑的慢速不同步微动 + 眼球微扫视。
 *      真人脸部肌肉永远在轻微动，这一层决定"像人"还是"像雕像"。
 *   ③ 口型层：按元音切换 JawOpen / MouthForm / 嘴距，替掉单一 MouthOpenY 的正弦。
 *
 * 注意与已有的四个钩子共存（redGuard / pose / rhythm / outfit），参数互不重叠：
 *   · 肌肉层用 set，装束也用 set —— 但参数集合不相交（装束是发型/配件，肌肉是五官）；
 *   · 微动层用 add，幅度 ≤0.045，与呼吸/姿态叠加不会过量。
 */
/** 面部配置（调试/验证用） */
export function faceConfig() {
  return faceCfg
}

/** 情绪肌肉层：按强度给目标，每帧缓动过去 */
function ensureEmotionHook() {
  if (emotionHook || !model?.internalModel) return
  emotionHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const now = performance.now()
    const dt = Math.min(0.12, (now - (emotionState.lastAt || now - 16)) / 1000)
    emotionState.lastAt = now
    const ids = new Set([...Object.keys(emotionState.cur), ...Object.keys(emotionState.target)])
    for (const id of ids) {
      // 目标里没有这个参数 = 回到中性值。眼开闭的中性是 1，不能当 0 处理（否则会闭眼）
      const n = neutralOf(id)
      const t = Object.prototype.hasOwnProperty.call(emotionState.target, id) ? emotionState.target[id] : n
      const c = Object.prototype.hasOwnProperty.call(emotionState.cur, id) ? emotionState.cur[id] : n
      if (Math.abs(t - c) < 1e-3) {
        if (Math.abs(t - n) < 5e-4) {
          delete emotionState.cur[id]
          continue
        }
        emotionState.cur[id] = t
        try {
          core.setParameterValueById(id, t)
        } catch {
          /* 模型没有这个参数 */
        }
        continue
      }
      // 约 0.3~0.5 秒到位：情绪换脸应该是"松过去"，不是"啪一下"
      const next = c + (t - c) * Math.min(1, dt * 3.4)
      emotionState.cur[id] = next
      try {
        core.setParameterValueById(id, next)
      } catch {
        /* ignore */
      }
    }
  }
  model.internalModel.on('beforeModelUpdate', emotionHook)
}

/** 五官微动 + 眼球微扫视：小幅度、不同步、连续 */
function ensureTremorHook() {
  if (tremorHook || !model?.internalModel) return
  faceSaccade = createSaccade(faceCfg)
  tremorHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const now = performance.now()
    const tr = tremorAt(faceCfg, now, tremorSeed, tremorScale)
    // 验收用：微动是 0.07~0.4Hz 的低频变化，画面差分的采样窗口很容易落在同一相位，
    // 测不准（实测"开"和"关"都读到 2.95%）。记录真正写进去的增量才可靠。
    window.__tremorLast = tr
    for (const id of Object.keys(tr)) {
      try {
        core.addParameterValueById(id, tr[id])
      } catch {
        /* ignore */
      }
    }
    // 眼球微扫：与注视叠加——她看着某处时眼睛也在微动，这才像活人。
    // 注意它也要受 tremorScale 控制：否则"把微动关到 0"之后眼睛还在扫，
    // 用户会以为开关没生效（2026-10-17 实测踩到）。
    if (tremorScale > 0.01) {
      const sac = faceSaccade.tick(now)
      try {
        core.addParameterValueById('ParamEyeBallX', sac.x * tremorScale)
        core.addParameterValueById('ParamEyeBallY', sac.y * tremorScale)
      } catch {
        /* ignore */
      }
    }
  }
  model.internalModel.on('beforeModelUpdate', tremorHook)
}

/** 口型层：按元音切形状（"张多大"由 setMouthOpen 给） */
function ensureVisemeHook() {
  if (visemeHook || !model?.internalModel) return
  visemeHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    if (mouthValue < 0.02) {
      mouthShape = null // 不说话：形状交回情绪肌肉层
      return
    }
    const now = performance.now()
    if (!mouthShape || now - mouthShapeAt > visemeSwitchMs(faceCfg)) {
      mouthLastViseme = pickViseme(faceCfg, Math.random, mouthLastViseme)
      mouthShape = visemeParams(faceCfg, mouthLastViseme)
      mouthShapeAt = now
    }
    if (!mouthShape) return
    for (const id of Object.keys(mouthShape)) {
      try {
        core.setParameterValueById(id, mouthShape[id] * mouthValue)
      } catch {
        /* ignore */
      }
    }
  }
  model.internalModel.on('beforeModelUpdate', visemeHook)
}

/** 设置页可调：五官微动的明显程度（0 = 关掉） */
export function setTremorScale(v) {
  tremorScale = Math.max(0, Math.min(3, Number(v) || 0))
  return tremorScale
}

/**
 * 探针专用：把某个角度参数按住在一个值上（每帧写，对抗帧末的参数恢复）。
 * 只给 scripts/probe-angle-range.mjs 用，生产路径不碰。
 */
let angleProbe = null
let angleProbeHook = null
// 转向层（2026-10-17）：事件驱动的朝向控制，与注视互斥（谁在控制就谁独占角度）
const turnCtl = createTurnController()
let turnHook = null
let idleHeadHook = null
// 待机头部写入序号：转向在飞时 hook 早退不写，__idleHeadLast 会留着陈旧值。
// 验收（verify:turns A）靠 seq 只认"切换之后的新鲜写入"，否则关掉后读到残尾会假失败。
let idleHeadSeq = 0
// 自动眨眼（2026-10-17）：框架在"动作正在播"时会跳过眨眼，而 Idle 是常驻循环，
// 所以她的眼睛一次都不眨。这里自己排。
let autoBlinkHook = null
let blinkCtl = null
let blinkScale = 1
// 眼球自主游走（2026-10-17）：之前眼球只会"跟着头/跟着鼠标"，没有自己的意志
let eyeWanderCtl = null
let eyeWanderHook = null
let eyeWanderOn = true
let lastGazeAt = -1e9 // 最近一次"真的在指方向"的注视（鼠标静止后眼球才开始自己游走）
let lastHeadAngle = { x: 0, y: 0 } // 待机摆动当前写进去的角度（眼球游走时要叠加）
// 抖耳朵（2026-10-17）：Param78/79 是**物理输入**，写它耳朵会自己甩起来
let earHook = null
let earPulse = null
export function applyAngleProbe(id, value) {
  angleProbe = { id, value: Number(value) || 0 }
  if (!angleProbeHook && model?.internalModel) {
    angleProbeHook = () => {
      if (!angleProbe) return
      const core = model?.internalModel?.coreModel
      try {
        core.setParameterValueById(angleProbe.id, angleProbe.value)
      } catch {
        /* ignore */
      }
    }
    model.internalModel.on('beforeModelUpdate', angleProbeHook)
  }
  return true
}

/**
 * 参数的真实值域（最小/最大/默认）。
 * 用来判断"幅度能开到多大"——超出 max 的量会被核心静默裁掉，
 * 光看画面没法区分"没开到"和"被裁了"。
 */
export function paramRange(ids = []) {
  const cm = model?.internalModel?.coreModel
  if (!cm) return null
  const out = {}
  for (const id of ids) {
    try {
      const idx = cm.getParameterIndex(id)
      const m = cm._model?.parameters
      out[id] =
        idx >= 0 && m
          ? { min: m.minimumValues[idx], max: m.maximumValues[idx], def: m.defaultValues[idx] }
          : null
    } catch {
      out[id] = null
    }
  }
  return out
}

/** 面部表达状态（验证用） */
export function faceState() {
  return {
    hasConfig: !!faceCfg && (faceCfg.ok || Object.keys(faceCfg.emotions || {}).length > 0),
    emotions: Object.keys(faceCfg?.emotions || {}),
    tremorChannels: faceCfg?.tremor?.channels?.length || 0,
    tremorScale,
    visemes: faceCfg?.visemeOrder || [],
    emotionTarget: { ...emotionState.target },
    emotionCurrent: { ...emotionState.cur },
    mouth: { value: mouthValue, viseme: mouthLastViseme },
    blink: blinkCtl ? { ...blinkCtl.stats(), scale: blinkScale } : null,
    eye: eyeWanderCtl ? { ...eyeWanderCtl.stats(), enabled: eyeWanderOn } : null,
    hooks: {
      emotion: !!emotionHook,
      tremor: !!tremorHook,
      viseme: !!visemeHook,
      blink: !!autoBlinkHook,
      eye: !!eyeWanderHook,
      ear: !!earHook
    }
  }
}

/* ---------------- 转头 / 转身（2026-10-17） ----------------
 *
 * 原来"朝向"只有注视一条路（鼠标动就朝那边看），而且**待机时头部是 0**——
 * 那 ±30° 的头部空间和 ±10° 的身体空间一直空着。这一层补上"因为发生了什么，
 * 她朝你转过来 / 转开"这种有由头的朝向。
 *
 * 与注视的交接（重要）：
 *   框架在 updateFocus() 里把注视量 add 进角度，之后才轮到我们的
 *   beforeModelUpdate —— 所以这里用 set 覆盖它的结果。为了不让转向结束时"跳回去"，
 *   包络 w 从 1 缓到 0 的同时，把注视量按 (1-w) 混回来：
 *       angle = turn * w + focus * (1 - w)
 *   w=0 时正好等于框架自己会写进去的值，视觉上无跳变。
 *
 * 值域是实测的：ParamAngle* ∈ [-30,30]、ParamBodyAngle* ∈ [-10,10]（moc3 里写死）。
 */
const TURN_ANGLE_MAX = 30
const TURN_BODY_MAX = 10
/**
 * 眼球跟随系数：头转 30° 时眼珠偏 0.45（值域 ±1 ≈ ±30°）。
 * 头转了但眼珠不动，看起来是"面无表情地侧着脸"；眼珠跟着走才是"目光落过来"。
 * 这个数是按"能看出在看，但不至于翻白眼"定的。
 */
const EYE_FOLLOW_TURN = 0.45
const EYE_FOLLOW_IDLE = 0.35

/** 发起一次转向（poke / approach / scene / return / typing / away） */
export function playTurn(kind, opts = {}) {
  const r = turnCtl.turn(kind, opts)
  console.log(`[turn] ${kind} ${r.ok ? '→ ' + describeTurn(kind) : '被拒（' + r.reason + '）'}`)
  // 验收用：记这一次转向的**峰值**。低帧率下按固定时刻抓帧只能抓到半路（实测 w=0.61），
  // 拿"最后一帧"当判据会假失败；峰值才是"她最多转到多少度"。
  if (r.ok) window.__turnPeak = { x: 0, y: 0, body: 0, eyeX: 0, eyeY: 0, w: 0 }
  return r
}

/** 朝鼠标方向转（知道方向时用；不知道就用默认的"略偏上"） */
export function turnToward(kind, gaze, opts = {}) {
  const dir = directionFrom(gaze)
  return playTurn(kind, { ...opts, x: dir.x, y: dir.y })
}

export function turnState() {
  return turnCtl.stats()
}

function ensureTurnHook() {
  if (turnHook || !model?.internalModel) {
    console.log('[turn] hook 未安装：' + (turnHook ? '已存在' : 'model 未就绪'))
    return
  }
  console.log('[turn] hook 已安装')
  turnHook = () => {
    window.__turnHookCalls = (window.__turnHookCalls || 0) + 1
    const core = model?.internalModel?.coreModel
    if (!core) return
    const s = turnCtl.tick()
    if (!s) {
      window.__turnSkipped = (window.__turnSkipped || 0) + 1
      return
    }
    // 注视当前的量（框架已经 add 过一次，这里要按 1-w 混回来，避免结束时跳变）
    let fx = 0
    let fy = 0
    try {
      const f = focusState()
      fx = Number(f?.x) || 0
      fy = Number(f?.y) || 0
    } catch {
      /* ignore */
    }
    // tick() 返回的值已经乘过包络 w，这里不要再乘（否则是 w²，幅度少一半）
    const w = s.weight
    const ax = s.x + fx * (1 - w)
    if (!turnHook.__logged) {
      turnHook.__logged = true
      console.log(`[turn] hook 生效：x=${s.x.toFixed(2)} y=${s.y.toFixed(2)} body=${s.body.toFixed(2)} w=${w.toFixed(2)}`)
    }
    const ay = s.y + fy * (1 - w)
    const tilt = s.tilt
    // 验收用：记下最后真正写进模型的角度（读参数读不到 hook 这一层，
    // 画面又受帧率影响，所以直接记"写了多少"）
    // 峰值（低帧率下抓帧抓不到最大角度，验收据此判断"最多转到多少"）
    {
      const p = window.__turnPeak
      if (p) {
        p.x = Math.max(p.x, Math.abs(ax * TURN_ANGLE_MAX))
        p.y = Math.max(p.y, Math.abs(ay * TURN_ANGLE_MAX))
        p.body = Math.max(p.body, Math.abs(s.body * TURN_BODY_MAX))
        p.eyeX = Math.max(p.eyeX, Math.abs(ax * EYE_FOLLOW_TURN))
        p.eyeY = Math.max(p.eyeY, Math.abs(ay * EYE_FOLLOW_TURN))
        p.w = Math.max(p.w, w)
      }
    }
    window.__turnLastWritten = {
      x: ax * TURN_ANGLE_MAX,
      y: ay * TURN_ANGLE_MAX,
      body: s.body * TURN_BODY_MAX,
      eyeX: Math.max(-1, Math.min(1, ax * EYE_FOLLOW_TURN)),
      eyeY: Math.max(-1, Math.min(1, ay * EYE_FOLLOW_TURN)),
      w
    }
    try {
      core.setParameterValueById('ParamAngleX', ax * TURN_ANGLE_MAX)
      core.setParameterValueById('ParamAngleY', ay * TURN_ANGLE_MAX)
      core.setParameterValueById('ParamAngleZ', tilt * TURN_ANGLE_MAX + fx * fy * -8 * (1 - w))
      // 眼神跟着头走（用户 2026-10-17 指出"眼神死板"）：
      // 这里用 set 覆盖注视的结果（与角度一致），所以转向结束时也会随 (1-w) 平滑交还。
      const eyeX = Math.max(-1, Math.min(1, ax * EYE_FOLLOW_TURN))
      const eyeY = Math.max(-1, Math.min(1, ay * EYE_FOLLOW_TURN))
      core.setParameterValueById('ParamEyeBallX', eyeX)
      core.setParameterValueById('ParamEyeBallY', eyeY)
      core.setParameterValueById('ParamBodyAngleX', (s.body + fx * (1 - w)) * TURN_BODY_MAX)
      core.setParameterValueById('ParamBodyAngleY', s.body * TURN_BODY_MAX * 0.6)
      core.setParameterValueById('ParamBodyAngleZ', s.x * TURN_BODY_MAX * 0.35)
    } catch {
      /* 模型缺参数就算了 */
    }
  }
  model.internalModel.on('beforeModelUpdate', turnHook)
}

/* ---------------- 待机头部摆动 / 动作期加强（2026-10-17） ----------------
 *
 * 实测发现两件事，合起来就是"看起来不灵动"的主因：
 *   ① 待机时头部角度恒为 0 —— 那 ±30° 的空间一直空着（只有呼吸带一点点）；
 *   ② 原包的动作文件里**没有任何角度曲线**（它们本来是给面捕用的，角度交给摄像头），
 *      所以在桌宠里一播动作就是"手臂在动、头身僵住"。
 *
 * 这里用一层程序化的摆动补上：多周期正弦叠加（不是单一频率，否则像节拍器），
 * 待机时缓慢左右看 + 歪头；遇到动作组（Greet/Happy/TapBody/Scene）时幅度再加强一档。
 * 转向（turn）激活期间让位——那边用 set 独占角度，避免叠到被裁。
 *
 * 幅度是相对 ±30/±10 的值域定的：待机约用到 1/3，动作期接近 1/2。
 */
const IDLE_HEAD = { x: 10, y: 4, z: 6 } // 待机：度
const ACT_HEAD = { x: 16, y: 7, z: 9 } // 动作期：加强
const ACT_BODY = { x: 5, y: 4, z: 3 }

function ensureIdleHeadHook() {
  if (idleHeadHook || !model?.internalModel) return
  let lastGroup = ''
  let actAt = 0
  idleHeadHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    // 转向时让位：那边在 set 绝对值，这里再 add 会叠过头
    if (turnCtl.isActive()) return
    const now = performance.now()

    // 动作组变化 → 记一下开始时间（用来算动作期包络）
    let group = ''
    try {
      group = focusState()?.motionGroup || ''
    } catch {
      /* ignore */
    }
    if (group !== lastGroup) {
      lastGroup = group
      actAt = now
    }
    const acting = !!group && group !== 'Idle'
    const actEl = acting ? (now - actAt) / 1000 : 99
    // 动作期包络：0.2s 淡入、之后保持，4 秒后淡出（原包动作大多 2~4 秒）
    const actEnv = acting ? Math.min(1, actEl / 0.2) * Math.min(1, Math.max(0, (4.2 - actEl) / 0.8)) : 0

    const t = now / 1000
    const base = {
      // 两个不整除的频率叠加：0.31Hz 与 0.13Hz，合起来约 10 秒走一个大来回
      x: (Math.sin(t * 0.31) * 0.55 + Math.sin(t * 0.13 + 1.7) * 0.45) * IDLE_HEAD.x,
      y: (Math.sin(t * 0.23 + 0.6) * 0.7 + Math.sin(t * 0.41) * 0.3) * IDLE_HEAD.y,
      z: Math.sin(t * 0.19 + 2.1) * IDLE_HEAD.z
    }
    const extra = {
      x: Math.sin(t * 2.7) * ACT_HEAD.x * actEnv,
      y: Math.sin(t * 2.1 + 1.1) * ACT_HEAD.y * actEnv,
      z: Math.sin(t * 1.9 + 0.4) * ACT_HEAD.z * actEnv
    }
    lastHeadAngle = { x: base.x + extra.x, y: base.y + extra.y }
    // 验收用：待机摆动的**实际写入值**。判"头部有没有在动"要读这个，不能拿画面差分——
    // 冻结/关掉之后头发尾巴的物理还会余震好几秒，像素差会把"已经关了"算成"还在动"
    // （2026-10-17 verify:turns A 项踩过：关掉后基线仍有 10~12%）。extra 是"动作期加强"
    // 分量（actEnv 包络内的 ±16° 快摆），待机时恒为 0——C 项"播动作时摆动加强"也读它。
    window.__idleHeadLast = {
      seq: ++idleHeadSeq,
      x: base.x + extra.x,
      y: base.y + extra.y,
      z: base.z + extra.z,
      extra: { x: extra.x, y: extra.y, z: extra.z },
      acting
    }
    try {
      core.addParameterValueById('ParamAngleX', base.x + extra.x)
      core.addParameterValueById('ParamAngleY', base.y + extra.y)
      core.addParameterValueById('ParamAngleZ', base.z + extra.z)
      // 头摆动时眼珠也要跟着挪一点，否则眼珠相对眼眶像在飘（斜视感）
      core.addParameterValueById('ParamEyeBallX', (base.x / TURN_ANGLE_MAX) * EYE_FOLLOW_IDLE + (extra.x / TURN_ANGLE_MAX) * EYE_FOLLOW_IDLE)
      core.addParameterValueById('ParamEyeBallY', (base.y / TURN_ANGLE_MAX) * EYE_FOLLOW_IDLE)
      if (actEnv > 0.01) {
        core.addParameterValueById('ParamBodyAngleX', Math.sin(t * 2.3) * ACT_BODY.x * actEnv)
        core.addParameterValueById('ParamBodyAngleY', Math.sin(t * 1.7 + 0.8) * ACT_BODY.y * actEnv)
        core.addParameterValueById('ParamBodyAngleZ', Math.sin(t * 2.9 + 1.5) * ACT_BODY.z * actEnv)
      }
    } catch {
      /* 模型缺参数就算了 */
    }
  }
  model.internalModel.on('beforeModelUpdate', idleHeadHook)
}

/* ---------------- 自动眨眼（2026-10-17） ----------------
 *
 * 框架里眨眼只在"这一帧没有动作在更新"时才跑：
 *     const motionUpdated = motionManager.update(...)
 *     if (!motionUpdated) eyeBlink.updateParameters(...)
 * 而她的 Idle 动作是常驻循环（nagi_idle 9 秒一轮），motionUpdated 永远为 true
 * → **她一次都不眨眼**。用户 2026-10-17 直接指出"似乎没看到眨眼"，原因就是这个。
 *
 * 自己排眨眼还能做得更像人：间隔随机 2.2~5.6 秒、闭得快开得慢、偶尔连眨两下。
 * 写的时候是**乘**在当前值上（不是直接写 1/0），这样表情造成的半闭（笑眼）不会被抹掉。
 */
function ensureAutoBlinkHook() {
  if (autoBlinkHook || !model?.internalModel) return
  // 时钟基准必须和 tick 用的一致：调度器内部拿 now() 初始化下一次的时刻，
  // 而 hook 里传的是 performance.now()。如果这里不给 now，默认用 Date.now()（1.7e12 量级），
  // 那么 tick(performance.now())（几万毫秒）永远小于 nextAt → 一次都不会眨（2026-10-17 踩过）。
  blinkCtl = createBlinkScheduler(faceCfg?.blink || {}, { now: () => performance.now() })
  autoBlinkHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    if (blinkScale <= 0.01) return
    const f = blinkCtl.tick(performance.now())
    if (f >= 0.999) return // 睁着：不写，把眼睑交给动作/表情/微动层
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
      let base = 1
      try {
        base = core.getParameterValueById(id)
      } catch {
        /* 模型没这个参数 */
      }
      try {
        core.setParameterValueById(id, Math.max(0, Math.min(1, base * f)))
      } catch {
        /* ignore */
      }
    }
    window.__blinkLastWritten = { f, at: performance.now() }
  }
  // 最后注册 = 最后执行：闭眼要压过微动层对眼睑的微小增量
  model.internalModel.on('beforeModelUpdate', autoBlinkHook)
}

/** 开关自动眨眼（0 = 关，1 = 正常） */
export function setBlinkScale(k) {
  blinkScale = Math.max(0, Math.min(2, Number(k)))
  if (blinkScale <= 0.01 && blinkCtl) blinkCtl.reset()
  return blinkScale
}

/** 眨眼状态（验证用）。注意名字不能叫 blinkState——模块里已有同名变量（装束切换的主动眨眼） */
export function autoBlinkStats() {
  return blinkCtl ? blinkCtl.stats() : null
}

/* ---------------- 眼球自主游走（2026-10-17） ----------------
 *
 * 之前眼球只有三个来源，全都在"跟着别的东物走"：focus（鼠标）、转向、待机头部摆动。
 * 用户观察得很准："视线完全由头部方向决定，眼球好像不会动。"
 *
 * 这一层给眼球**自己的意志**：头基本不动时，眼珠会自己换注视点
 * （看屏幕左边 → 回来 → 瞟一眼键盘 → 看远处），一次扫视 70~140ms，然后完全静止地停一会儿。
 *
 * 让位规则（重要）：
 *   · 转向激活时不写（那边用 set 管朝向）；
 *   · 鼠标刚动过（6 秒内）时不写（她在看你）。
 * 只有在"没人管她"的时候，眼珠才自己游走——所以不会抢注视。
 */
const GAZE_ACTIVE_MS = 6000

function ensureEyeWanderHook() {
  if (eyeWanderHook || !model?.internalModel) return
  eyeWanderCtl = createEyeWander(faceCfg?.eyeWander || {}, { now: () => performance.now() })
  eyeWanderHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core) return
    const now = performance.now()
    if (!eyeWanderOn) return
    if (turnCtl.isActive()) return // 转向在管
    if (poseState) return // 姿态（思考/收回中）在管目光：它是 add，我们是 set，
    // 不躲开会把它写的 ParamEyeBall* 整个盖掉——思考时目光会自己飘走（2026-10-17
    // verify:pose 抓到：ΔEyeBallX=0.468 而非姿态目标 0.35，差值正是游走落点）
    if (now - lastGazeAt < GAZE_ACTIVE_MS) return // 她在看你
    const w = eyeWanderCtl.tick(now)
    // 头部摆动带来的眼珠跟随要一起算进来（这一层是 set，会覆盖下方其它层）
    const hx = (lastHeadAngle.x / TURN_ANGLE_MAX) * EYE_FOLLOW_IDLE
    const hy = (lastHeadAngle.y / TURN_ANGLE_MAX) * EYE_FOLLOW_IDLE
    const x = Math.max(-1, Math.min(1, w.x + hx))
    const y = Math.max(-1, Math.min(1, w.y + hy))
    try {
      core.setParameterValueById('ParamEyeBallX', x)
      core.setParameterValueById('ParamEyeBallY', y)
    } catch {
      /* ignore */
    }
    window.__eyeLastWritten = { x, y, at: now }
  }
  model.internalModel.on('beforeModelUpdate', eyeWanderHook)
}

/** 眼球游走开关（0 = 关，1 = 开） */
export function setEyeWanderScale(k) {
  eyeWanderOn = Number(k) > 0.01
  if (eyeWanderOn) {
    // 手动打开就立刻接管，不用等"鼠标静止 6 秒"（验证与设置页都会用到）
    lastGazeAt = -1e9
    eyeWanderCtl?.reset(performance.now())
  } else {
    eyeWanderCtl?.reset(performance.now())
  }
  return eyeWanderOn ? 1 : 0
}

/** 眼球状态（验证用） */
export function eyeState() {
  return eyeWanderCtl ? { ...eyeWanderCtl.stats(), enabled: eyeWanderOn, sinceGazeMs: performance.now() - lastGazeAt } : null
}

/* ---------------- 抖耳朵（2026-10-17） ----------------
 *
 * `Param78/79` 是**物理输入**（PhysicsSetting26~29 的 Input 就是它们），
 * 也就是说：写它 → 物理会把耳朵各段（Param45/53/48/47/54/28/100…）甩起来。
 * 这是模型里少数"只要给个冲量，剩下的交给物理"的地方，成本极低。
 *
 * 写法是短促衰减振荡（约 3 次摆动、500ms 收干净），左耳右耳给相反符号，
 * 看起来是"两只耳朵交替抖了一下"，而不是整颗头在摇。
 */
export function wiggleEars(amp = 0.85, ms = 520) {
  if (!model?.internalModel) return false
  earPulse = {
    at: performance.now(),
    amp: Math.max(0, Math.min(1.2, Number(amp) || 0.85)),
    ms: Math.max(200, Math.min(1500, Number(ms) || 520)),
    dir: Math.random() < 0.5 ? 1 : -1
  }
  return true
}

function ensureEarHook() {
  if (earHook || !model?.internalModel) return
  earHook = () => {
    if (!earPulse) return
    const core = model?.internalModel?.coreModel
    if (!core) return
    const el = performance.now() - earPulse.at
    if (el >= earPulse.ms) {
      earPulse = null
      window.__earLast = 0
      return
    }
    const decay = Math.max(0, 1 - el / earPulse.ms)
    // 3 个半周 ≈ 抖三下；衰减平方让最后收得干脆（否则像一直抽搐）
    const v = Math.sin((el / earPulse.ms) * Math.PI * 3) * decay * decay * earPulse.amp * earPulse.dir
    try {
      core.addParameterValueById('Param78', v)
      core.addParameterValueById('Param79', -v)
    } catch {
      /* 模型没有耳参数就算了 */
    }
    window.__earLast = v
  }
  model.internalModel.on('beforeModelUpdate', earHook)
}

/** 调待机头部摆动的幅度（倍数；0 = 完全不动） */
export function setIdleHeadScale(k) {
  const n = Math.max(0, Math.min(2.5, Number(k) || 0))
  IDLE_HEAD.x = 10 * n
  IDLE_HEAD.y = 4 * n
  IDLE_HEAD.z = 6 * n
  ACT_HEAD.x = 16 * n
  ACT_HEAD.y = 7 * n
  ACT_HEAD.z = 9 * n
  return n
}

/* ---------------- 前后（Z 轴）动作（2026-10-17 用户拍板） ----------------
 *
 * 之前的动作只有左右方向的平移与摆动，缺纵深。这里补三类触发动作
 * （前倾凑近 leanIn / 探头看你 peek / 后仰松弛 leanBack）+ 一路常态复合摆动
 * （左右转身时带轻微前后）。纯逻辑在 core/presence/depth-motion.js（可单测），
 * 本文件只负责把它的输出落到两层：
 *   ① transform（scale/dx/dy）→ zContainer：绕模型锚点缩放/位移。
 *      pivot 每帧重取 model.x/model.y，所以 layout() 重排（改窗口/镜像/缩放）
 *      之后锚点自动跟着走，不会错位。
 *   ② params（角度增量）→ addParameterValueById：与 pose/rhythm/待机摆头同款
 *      的 add 层（每帧末框架 loadParameters() 复位，增量只在当帧有效）。
 *
 * 角度正负号是实测约定（probe-angle-sign.mjs 逐档截图）：负 = 靠近屏幕
 * （抬头/前倾），正 = 远离（低头/后仰）。
 */
function ensureDepthHook() {
  if (depthHook || !model?.internalModel) return
  if (!depthMotion) {
    depthMotion = createDepthMotion({
      rng: Math.random,
      enabled: depthCfg.enabled !== false,
      amount: Number(depthCfg.amount) > 0 ? Number(depthCfg.amount) : DEFAULT_DEPTH_CONFIG.amount
    })
  }
  depthHook = () => {
    const core = model?.internalModel?.coreModel
    if (!core || !zContainer) return
    const out = depthMotion.update(performance.now())
    // 参数层：增量写入（模型缺参数就跳过，与其它层一致）
    for (const [id, v] of Object.entries(out.params)) {
      if (Math.abs(v) < 1e-4) continue
      try {
        core.addParameterValueById(id, v)
      } catch {
        /* 模型没这个参数 */
      }
    }
    // 容器层：绝对定位（不是增量），绕**颈肩支点**做缩放/位移。
    // 支点 = 模型锚点（取景带底边）上方 (band.bottom − DEPTH_PIVOT_FY) 的位置：
    // 缩放时肩膀几乎不动、头往前长 —— 读作"探头"；绕锚点（肚脐）缩放则是整片均匀
    // 放大往上飘，读作"整体前后移动"（2026-10-17 用户指出后改掉）。
    const px = model.x
    const py = model.y
    // ⚠ 取景带对象只有 anchorY（= 带的下边界 fy），**没有 bottom**——写成 bottom 会得到
    // undefined → 支点变 NaN → 模型整片消失（2026-10-17 实测：快照全空才发现的）。
    const bandBottom = curBand ? Number(curBand.anchorY) : NaN
    const off = Number.isFinite(bandBottom) ? (bandBottom - DEPTH_PIVOT_FY) * baseH * baseScale : 0
    zContainer.pivot.set(px, py - off)
    zContainer.position.set(px + out.transform.dx, py + out.transform.dy)
    zContainer.scale.set(out.transform.scale)
    // 验收用：真正写进去的值。判"Z 动作有没有生效"要读这个，不能拿画面差分
    // （头发物理余震会把"已经收回"算成"还在动"，2026-10-17 verify:turns 踩过）
    const bandPx = curBand ? curBand.h * baseScale : 0
    window.__depthLast = {
      seq: ++depthSeq,
      mode: out.mode,
      env: out.env,
      ambientEnv: out.ambientEnv,
      transform: out.transform,
      params: out.params,
      container: {
        x: zContainer.x, y: zContainer.y, scaleX: zContainer.scale.x, scaleY: zContainer.scale.y,
        pivotY: py - off,
        anchorY: py,
        bandPx,
        // 支点在取景带里的相对高度（0 = 带底/肚脐线，1 = 带顶）。bust 取景下应 ≈0.54
        // （颈肩线 fy 0.23、带底 0.48、带高 0.465 → (0.48−0.23)/0.465）。
        // 旧实现是 0（支点在肚脐）→ 整体缩放，读作"整体前后移动"。
        pivotFracUp: bandPx > 0 ? off / bandPx : null
      }
    }
  }
  model.internalModel.on('beforeModelUpdate', depthHook)
}

/** 纵深感配置（设置页 live2d.depthMotion 驱动；加载时由调用方灌入） */

/** 加载时灌入配置（main.js 读 settings.live2d.depthMotion 后调用） */
export function configureDepth(cfg) {
  depthCfg = { ...DEFAULT_DEPTH_CONFIG, ...(cfg || {}) }
  if (depthMotion) {
    depthMotion.setEnabled(depthCfg.enabled !== false)
    depthMotion.setAmount(Number(depthCfg.amount) > 0 ? Number(depthCfg.amount) : DEFAULT_DEPTH_CONFIG.amount)
    depthMotion.setAmbient(depthCfg.ambient !== false)
    depthMotion.setAuto(depthCfg.auto !== false)
  }
  return depthState()
}

/** 触发一个 Z 轴动作：'leanIn' | 'peek' | 'leanBack' */
export function triggerDepth(name) {
  if (!depthMotion) return false
  return depthMotion.trigger(name, performance.now())
}

/** 纵深感开关（设置页） */
export function setDepthEnabled(on) {
  if (!depthMotion) return false
  depthMotion.setEnabled(!!on, performance.now())
  return true
}

/** 纵深感幅度（设置页滑杆 0~2，1 = 设计基准） */
export function setDepthAmount(v) {
  if (!depthMotion) return false
  depthMotion.setAmount(v)
  return true
}

/** 当前纵深感状态（调试/验收用） */
export function depthState() {
  return depthMotion ? depthMotion.state() : { mode: 'idle', phase: 'idle', env: 0, ...depthCfg }
}

/* ---------------- 微注视（待机行为，2026-10-17） ----------------
 *
 * 2026-10-15 曾彻底取消"跟随鼠标"：鼠标停哪儿她盯哪儿很诡异。这里加回来的
 * 是**有节制的微注视**——由 core/ambient.js 的调度器决定"这一眼要不要看、看多久、
 * 什么时候移开"，本函数只负责把方向交给 focusController（它自带速度限制，
 * 所以是平滑转过去而不是瞬移）。
 *
 * 静默时调用方传 (0,0)，她就回到中立——所以"没人动鼠标"时她的目光仍是归中的，
 * 旧的行为验证不会失效。
 */
export function setGaze(x, y, instant = false) {
  const fc = model?.internalModel?.focusController
  if (!fc) return false
  const nx = Math.max(-1, Math.min(1, Number(x) || 0))
  const ny = Math.max(-1, Math.min(1, Number(y) || 0))
  // 只有真的指了个方向才算"她在看你"；静默归中的 (0,0) 不算，
  // 否则主进程周期性归中会让眼球永远不敢自己游走。
  if (Math.abs(nx) > 0.02 || Math.abs(ny) > 0.02) lastGazeAt = performance.now()
  if (fc.targetX === nx && fc.targetY === ny) return true // 值没变就不打扰它
  try {
    fc.focus(nx, ny, instant)
    return true
  } catch {
    return false
  }
}

/**
 * 深度探参（诊断用）：同一个参数从三个地方读，定位"读到 0"到底是哪一层的问题。
 *   · mirror = 渲染库定格的参数数组（readParams 读的就是它）
 *   · live   = 本帧正在计算的参数数组
 *   · core   = 核心模型自己的取值接口
 * 2026-10-17 加：验证脚本发现表情写入的参数在 mirror 里读不到，用这个定位。
 */
export function deepProbe(ids = []) {
  const cm = model?.internalModel?.coreModel
  if (!cm) return null
  const mIds = cm._parameterIds || cm.parameterIds
  const mVals = cm._parameterValues || cm.parameterValues
  const liveVals = cm.parameters?.values || cm.parameters?._values || null
  const out = { mirror: {}, live: {}, core: {}, probeKeys: Object.keys(cm).slice(0, 40) }
  for (let i = 0; i < (mIds?.length || 0); i++) {
    const id = mIds[i]
    if (ids.length && !ids.includes(id)) continue
    out.mirror[id] = mVals?.[i] ?? null
    if (liveVals) out.live[id] = liveVals[i] ?? null
  }
  const raw = cm._model || null
  for (const id of ids) {
    if (!raw) break
    try {
      out.core[id] = typeof raw.getParameterValueById === 'function' ? raw.getParameterValueById(id) : 'no-method'
    } catch (e) {
      out.core[id] = 'ERR:' + e.message
    }
  }
  return out
}

/** 眨眼埋点（验证用）：切换装束时的眨眼掩护到底有没有真的执行 */
export function blinkTrace() {
  return { ...blinkTraceData }
}

/**
 * 冻结待机摆动（验证/截图用）。
 *
 * 为什么需要：待机动作一直在跑，参数每帧都在变，**任何两次抓帧都会差 20% 以上**
 * —— 2026-10-17 用它才看清，"画面变了"这种判据会被姿态漂移淹没，
 * 分不清到底是"换了表情"还是"她刚好摆到别处"。
 * 打开后把待机动作会写的那两个参数按住，模型静止，画面差异就只反映面容与装束。
 * 日常运行**不要**开（她就不动了）。
 */
let idleFreezeHook = null

/**
 * 要按住的参数：她自己会动的那些。
 *   待机摆动（本项目自写 idle）→ ParamBodyAngleY/Z
 *   呼吸（CubismBreath）→ ParamAngleX/Y/Z、ParamBodyAngleX、ParamBreath
 *   自动眨眼 → ParamEyeLOpen/ROpen
 * 2026-10-17：一开始只按了待机摆动，静置抖动仍有 13% —— 呼吸和眨眼也在动，
 * 只按一个不够，画面还是"每帧都不一样"。
 */
const FREEZE_IDS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamBreath', 'ParamEyeLOpen', 'ParamEyeROpen'
]

export function freezeIdleMotion(on) {
  if (on) {
    if (idleFreezeHook || !model?.internalModel) return !!idleFreezeHook
    idleFreezeHook = () => {
      const core = model?.internalModel?.coreModel
      if (!core) return
      for (const id of FREEZE_IDS) {
        try {
          // 眨眼按住"睁开"（1），其余按住 0（中立）
          core.setParameterValueById(id, id.endsWith('Open') ? 1 : 0)
        } catch {
          /* 模型没有这个参数就算了 */
        }
      }
    }
    model.internalModel.on('beforeModelUpdate', idleFreezeHook)
    return true
  }
  if (idleFreezeHook) {
    try {
      model?.internalModel?.off?.('beforeModelUpdate', idleFreezeHook)
    } catch {
      /* ignore */
    }
    idleFreezeHook = null
  }
  return false
}

/** 模型实际拥有的参数 ID 清单（时段表现过滤用：禁止映射不存在的参数） */
export function listParamIds() {
  const core = model?.internalModel?.coreModel
  if (!core) return []
  const src = core._parameterIds || core.parameterIds
  return src ? Array.from(src) : []
}

/**
 * 焦点控制器内部状态（调试/验证"目光不再跟随鼠标"用）。
 * 取消跟随时只做了两件事：撤监听 + 加载时归中；这个钩子让人能直接读到
 * "它后来再也没动过"，比拿参数反推可靠（待机动作也在写角度参数）。
 */
/**
 * 焦点控制器 + 动作状态（调试/验证用）。
 *
 * 两个用途：
 *  1. 「目光不再跟随鼠标」——直接读焦点控制器的内部状态（它每帧都会把目标值写进
 *     目光/头部参数）。取消跟随后它必须恒为 0；拿参数反推不可靠，因为待机动作
 *     也在写同一批参数。
 *  2. 「空闲时自然动画仍在跑」——读动作状态机的 currentGroup。框架自带
 *     "动作播完随机换 Idle 组"的机制，这个字段就是它在轮换的证据。
 */
export function focusState() {
  const im = model?.internalModel
  const fc = im?.focusController
  if (!fc) return null
  return {
    x: fc.x,
    y: fc.y,
    targetX: fc.targetX,
    targetY: fc.targetY,
    motionGroup: im?.motionManager?.state?.currentGroup ?? null
  }
}

/* ---------------- 查询 ---------------- */

/** 列出模型实际拥有的表情名（「黑脸」系列已被黑名单挡在外面） */
export function listExpressions() {
  if (!model) return []
  try {
    const defs = model.internalModel?.settings?.expressions || []
    return defs.map((d) => d.Name || d.name).filter((n) => n && !isHiddenExpression(n))
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
  const intensity = Number.isFinite(Number(opts.intensity)) ? Number(opts.intensity) : 1
  let ok = false
  // ① 有肌肉定义 → 走「肌肉层」：按强度连续缩放 + 缓动过渡。
  //    这样「有点担心」和「很担心」是两张脸，情绪衰减时脸也会跟着松下来，
  //    而不是从一张 exp3 突变成另一张（2026-10-17 之前就是突变的）。
  const vec = musclesFor(faceCfg, name)
  if (vec && faceCfg) {
    ensureEmotionHook()
    emotionState.target = scaleMuscles(vec, intensity)
    // 肌肉层接管后要把 exp3 撤掉，否则两套叠加（exp3 是独占的，它一在就把参数顶死）
    try {
      model.expression(null)
    } catch {
      /* 没有表情管理器时忽略 */
    }
    ok = true
  } else if (name) {
    // ② 没有肌肉定义：退回美术调好的 exp3（行为与之前一致）
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

/** 调试用：直接按名字应用表情（绕过情绪映射），便于逐个形态比对。黑脸系列拒绝 */
export function setExpressionRaw(name) {
  if (!model) return false
  if (isHiddenExpression(name)) return false
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
  const val = Math.max(0, Math.min(1, Number(v) || 0))
  // 记下来给口型层用：这里只管"张多大"，"什么形状"由 visemeHook 按元音决定
  mouthValue = val
  try {
    const core = model.internalModel.coreModel
    for (const id of ['ParamMouthOpenY', 'ParamMouthOpen']) {
      try {
        core.setParameterValueById(id, val)
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
  if (poseHook) {
    try {
      model?.internalModel?.off?.('beforeModelUpdate', poseHook)
    } catch {
      /* ignore */
    }
  }
  poseHook = null
  poseState = null
  if (rhythmHook) {
    try {
      model?.internalModel?.off?.('beforeModelUpdate', rhythmHook)
    } catch {
      /* ignore */
    }
  }
  rhythmHook = null
  rhythmState = null
  for (const [h, setter] of [
    [outfitHook, () => (outfitHook = null)],
    [blinkHook, () => (blinkHook = null)],
    [headHook, () => (headHook = null)],
    [microHook, () => (microHook = null)],
    [emotionHook, () => (emotionHook = null)],
    [tremorHook, () => (tremorHook = null)],
    [visemeHook, () => (visemeHook = null)],
    [angleProbeHook, () => (angleProbeHook = null)],
    [turnHook, () => (turnHook = null)],
    [idleHeadHook, () => (idleHeadHook = null)],
    [autoBlinkHook, () => (autoBlinkHook = null)],
    [eyeWanderHook, () => (eyeWanderHook = null)],
    [earHook, () => (earHook = null)]
  ]) {
    if (!h) continue
    try {
      model?.internalModel?.off?.('beforeModelUpdate', h)
    } catch {
      /* ignore */
    }
    setter()
  }
  outfitTarget = null
  outfitSlots = null
  outfitLookId = ''
  outfit = null
  blinkState = null
  headState = null
  microCfg = null
  microState = null
  faceCfg = null
  blinkCtl = null
  eyeWanderCtl = null
  earPulse = null
  emotionState = { cur: {}, target: {} }
  faceSaccade = null
  mouthShape = null
  mouthValue = 0
  turnCtl.reset()
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
      if (depthHook) model.internalModel?.off?.('beforeModelUpdate', depthHook)
      // 先摘容器再毁模型：容器是 model 的父级，反了会让 pixi 拖着半棵子树
      if (zContainer) {
        zContainer.removeChild(model)
        app?.stage.removeChild(zContainer)
        zContainer.destroy()
      } else {
        app?.stage.removeChild(model)
      }
      model.destroy()
    }
    app?.destroy(true, { children: true })
  } catch {
    /* ignore */
  }
  model = null
  app = null
  zContainer = null
  depthMotion = null
  depthHook = null
  depthSeq = 0
  mouthHook = null
  redGuard = null
  redIds = []
  baseW = 0
  baseH = 0
  talking = false
  lipTrack = null
  lipClock = null
}
