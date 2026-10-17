// src/core/frame.js
// 取景（framing）：决定"模型哪一段、以多大比例、落在画布的什么位置"。
//
// 产品的既定规则（2026-10-15 用户拍板）：**只显示胸像（上半身），不再显示全身**。
// 于是取景不再等于"把整张画布塞进窗口"，而是：
//   1) 先在模型上框出一个"取景带"（band）——横向取中间一段、纵向取顶部一段；
//   2) 再把这个带**完整装进**画布（contain，绝不越界），底部对齐、水平居中；
//   3) 留出安全边距，避免贴边、也避免压到画布内的 UI（如桌宠右侧工具条、底部状态行）。
//
// 这里的计算全是纯函数，方便单测把"不越界"这条硬约束钉死。

/**
 * 取景模式：值都是「声明 moc 画布」的归一化坐标（0~1，左上角为原点）。
 *
 * ⚠ 每个模型的画布"留白量"差别巨大，所以预设**按模型档案选**（见 FRAME_PROFILES）。
 *
 * 为什么横向要取到 0.11~0.95（Lisette 的情况，而不是"角色核心"的 0.15~0.85）：
 * 该模型的美术**画到了角色核心之外**，而且随待机动作摆动。实测（scripts/probe-art.mjs +
 * verify:frame 的像素统计）：
 *   · 静止姿态：整体范围 fx ∈ [0.131, 0.925]、fy ∈ [0.053, 0.963]；
 *   · 抬手/甩手的动作会把右缘推到 0.977 —— 差不多就是整张画布宽。
 * 也就是说"把每一次动作的手臂都框进来"要靠无限缩小人物才能做到，代价太大；
 * 取景带因此按**静止姿态**留量，保证"看起来她是完整地站在框里的"：
 *   · 左 0.11（比美术左缘 0.131 余 0.021）
 *   · 右 0.95（比静止右缘 0.925 余 0.025）
 *   · 顶 -0.02（头顶在 0.053，往画布上方再留一段）
 *   · 底 0.46（裁到腰，这就是"胸像"）
 * 大幅动作时手臂会短暂伸到画布边缘之外（被画布裁掉）——这是 Live2D 桌宠的常态，
 * 而且**永远不会盖住 UI**：UI 是画在画布之上的 HTML，且画布本身被容器裁切。
 * 左右不对称是故意的 —— 美术本身偏右，取景带跟着偏，形象才会落在画面正中
 * （fitBand 会用 centerOffset 把它摆正）。
 */
export const FRAME_PRESETS = {
  bust: { left: 0.11, right: 0.95, top: -0.02, bottom: 0.46 },
  // 缅因妹妹（models/Maine）：moc 画布 5000×7000。实测（2026-10-17，scripts/probe-maine-*.mjs
  // 像素剖面 + 带标尺全身图，逐个 fy 档读回）：
  //   · 头顶 fy = 0.030；**肚脐线 fy = 0.48**（0.47–0.50 为腹正面中央，袜口 0.58，整身到 0.96）
  //   · **上半身（fy 0.03~0.48）横向美术 fx ∈ [0.218, 0.769]，中心 0.494、宽 0.552**
  //     （2026-10-18 scripts/probe-upper-body.mjs 逐行像素剖面实测：
  //      最外侧左边是头发/发饰、右边是腰侧手臂；全身横向与上半身几乎相同，
  //      所以「不裁手臂」的取景带宽度下限就是 0.552）
  // 用户拍板（2026-10-17）：所有界面统一「肚脐以上特写」——带子**下边界就是肚脐线**
  // （锚点 anchorY = 0.48，她"站在"肚脐线上）；上边界取 0.015，在头顶上方留 0.015
  // （≈105 模型单位）容位：覆盖 ±10° 摆头时头顶的弧线位移与耳朵/发饰，又不留出一大片空白。
  // ⚠ 横向 0.255~0.83（旧值）是**照全身范围估的**，实测后有两个错：
  //   ① 左缘 0.255 比美术左缘 0.218 还靠右 → 左侧手臂/头发被裁掉 0.037（≈187 模型单位）；
  //   ② 带中心 0.543 比美术中心 0.494 偏右 0.049 → centerOffset 把整个人往左推，
  //      镜像打开时方向不翻，偏移翻倍（≈46px，2026-10-18 实测）。
  // 2026-10-18 第三次（用户逐字指出差异）：「我发给你的图下摆只到蝴蝶结位置左右」
  // —— 参考图的下摆不是我此前假设的肚脐(0.48)，而是**蝴蝶结**。
  // 判定依据（参考图 895×1207 像素实测 vs 模型逐档剖面，用同一把尺子比"宽度相对关系"）：
  //   · 参考图：头发最宽 0.70 画面宽，下摆（蝴蝶结，横向展开）0.68 → **下摆/头发 = 0.97**
  //   · 模型：头发最宽 fx 0.376（fy 0.02~0.14）；fy 0.38~0.42 宽 0.391 → **1.04** 最接近 0.97
  //     （fy 0.46~0.50 宽 0.534 = 1.42，明显过宽，那是蝴蝶结以下的裙摆/腰侧，参考图里没有）
  //   ⇒ 蝴蝶结在 **fy 0.415~0.44**。
  // 关键：画布底部还有 `--safe-bottom` = 26px 的安全边距（避让状态行），**它不是裁切区**，
  // 所以带底以下 26px 仍会画出来。把带底放在**蝴蝶结上缘 0.415**，那 26px 溢出正好落在
  // 蝴蝶结本体（fy 0.415~0.437），画面最底边就是蝴蝶结下缘 —— 与参考图一致。
  // 缩放按参考图「头顶留白 26%」反推：s = (619−168)/((0.415−0.030)×7000) = 0.167
  // → fit = 0.167/1.3225 = 0.1263 → 带 w = 300/0.1263 ≈ 2375（0.475 × 5000）。
  // ⇒ 头顶留白 26.2%（参考图 26%）；头发段横向 327px = 76% 画布宽（参考图 70%）；
  //   最宽处（底部蝴蝶结 0.448）375px = 87% —— 全部落在 430px 画布内，**一处都不裁**。
  // ⚠ 带宽 2375 **小于**美术宽 2765 是故意的：带子只决定缩放，**不是裁切框**；
  //   若把带宽放大到等于美术宽，缩放会被压小 16%、人物又变回参考图之前那么大。
  Maine: { left: 0.256, right: 0.731, top: 0.015, bottom: 0.415 },
  // 全身（保留能力：个别模型若原本就是半身稿，可用 full 原样显示）
  full: { left: 0, right: 1, top: 0, bottom: 1 }
}

export const DEFAULT_FRAME = 'bust'

/**
 * 模型档案：按模型目录名/文件名匹配，命中则用一个"更贴合该模型画布"的预设覆盖同名的通用预设。
 * 匹配规则与渲染层 live2d.js 的 MODEL_PROFILES 同源（拿模型目录名去试）。
 */
export const FRAME_PROFILES = [
  { match: /maine|缅因/i, presets: { bust: FRAME_PRESETS.Maine } }
]

/**
 * 解析"该用哪套预设"。
 * @param {string} frame 取景模式（bust / full / …）
 * @param {string} modelName 模型目录名（如 'Maine'、'Lisette'）；缺省则用通用预设
 */
export function frameProfile(frame, modelName) {
  const name = String(modelName || '')
  for (const p of FRAME_PROFILES) {
    if (p.match.test(name)) {
      const hit = p.presets[frame]
      if (hit) return hit
    }
  }
  return framePreset(frame)
}

/** 取某个取景模式的比例表；未知模式回落到默认 */
export function framePreset(frame) {
  return FRAME_PRESETS[frame] || FRAME_PRESETS[DEFAULT_FRAME]
}

export function isBustFrame(frame) {
  return (frame || DEFAULT_FRAME) !== 'full'
}

/**
 * 标准可用区（CSS 像素）：**各界面统一缩放比例**的基准（2026-10-17 用户拍板）。
 *
 * 2026-10-18 第二次校准（用户看图拍板）：用户给了一张上半身特写参考图
 * （895×1207，头顶留白 26%、主体居中、底部裁到腰贴底），反馈"当前还有点大"。
 * 桌宠最常呈现的是**待机加成档**（scale 1.15 × idleBoost 1.15 = 1.3225），
 * 之前 fit=0.130 时该档头顶只剩 12% 留白、几乎撑满画面。
 * 现按「待机档头顶留白对齐参考图（≈26%）」反推 fit ≈ 0.108；但工作台默认
 * 面板 300 宽的本窗 contain = 0.10067 是**所有界面的瓶颈**——标准盒一旦大于它
 * （如 322），工作台就会比桌宠小 7%、「切换界面不跳变」失效（frame.test.js 钉着）。
 * 故取 w=300（= 瓶颈，保持跨界面同比例），待机档留白 31%、日常档 39%、基准档 47%，
 * 比参考图略疏朗一点，方向与用户诉求一致。h=560 只兜底不约束（0.172 > 0.1007）。
 * （前一轮曾放宽到 {386,560}＝"不裁手臂的几何最大"，用户看后嫌大，故收紧。）
 *
 * 规则（fitBand 的 standard 参数，见下）：
 *   scale = min(本窗 contain, 标准区 contain)
 *   · 装得下标准区 → **锁定标准比例**：桌宠 / 工作台 / 设置里她是同一个尺寸，
 *     切换界面不跳变；桌宠窗拖得再大也不再变大（想变大用「尺寸」滑杆——那是用户显式意图）；
 *   · 装不下（面板被拖窄 / 桌宠被缩到很小）→ 按本窗 contain **等比缩小**，
 *     绝不裁头、绝不拉伸。
 */
export const STANDARD_BOX = { w: 300, h: 560 }

/** 统一缩放基准只对胸像生效；full 是保留能力，按本窗 contain 原样装框 */
export function standardBoxFor(frame) {
  return isBustFrame(frame) ? STANDARD_BOX : null
}

/**
 * 在模型坐标系里框出"取景带"。
 * @param {string} frame 取景模式
 * @param {number} baseW 模型原始宽（模型单位）
 * @param {number} baseH 模型原始高（模型单位）
 * @param {string} [modelName] 模型目录名；给了就按模型档案挑预设（如 Maine）
 * @returns {{x:number,y:number,w:number,h:number,anchorY:number}}
 *   anchorY = 取景带底边在"整张模型"里的高度占比，也就是 pixi 的 anchor.y
 */
export function frameBand(frame, baseW, baseH, modelName) {
  const p = frameProfile(frame, modelName)
  const w = baseW * (p.right - p.left)
  const h = baseH * (p.bottom - p.top)
  return {
    x: baseW * p.left,
    y: baseH * p.top, // 可为负：越过画布上边界往上的余量
    w,
    h,
    anchorY: p.bottom,
    preset: p,
    // 取景带中心相对"画布中心"的偏移（模型单位）。美术偏右时取景带也偏右，
    // fitBand 靠它把取景带摆到框中央，而不是把画布中心摆到框中央。
    centerOffset: baseW * ((p.left + p.right) / 2 - 0.5)
  }
}

/**
 * 把取景带"完整装进"画布（contain）。
 *
 * 硬约束：scale === 1 时，带子的渲染矩形必须完全落在画布可用区内（>0 的余量），
 * 这样形象永远不可能越界去盖住画布外的 UI。
 *
 * @param {{band:object, boxW:number, boxH:number, scale?:number, pad?:object, standard?:object}} o
 *   pad: {top,right,bottom,left} 安全边距（像素），用来避开画布内的 UI
 *   standard: {w,h} 标准可用区（见 STANDARD_BOX）。给了就再拿它封顶：
 *     大窗锁标准比例（各界面同尺寸），小窗才按本窗 contain 等比缩小。
 * @returns {{scale:number,x:number,y:number,anchorY:number,bandW:number,bandH:number,rendered:object}}
 */
export function fitBand({ band, boxW, boxH, scale = 1, pad = {}, standard = null }) {
  const pl = num(pad.left)
  const pr = num(pad.right)
  const pt = num(pad.top)
  const pb = num(pad.bottom)

  const availW = Math.max(1, boxW - pl - pr)
  const availH = Math.max(1, boxH - pt - pb)

  // contain：取两个方向里更"紧"的那个 → 带子完整可见，绝不被裁
  let fit = Math.min(availW / band.w, availH / band.h)

  // 统一缩放：再拿「标准可用区」封顶（见 STANDARD_BOX）。
  // 两个方向都只会把 fit 改小，contain 的硬约束不被破坏；standard 缺省（旧调用方）
  // 或给 0 时行为与从前完全一致。
  if (standard) {
    const sw = num(standard.w)
    const sh = num(standard.h)
    if (sw > 0) fit = Math.min(fit, sw / band.w)
    if (sh > 0) fit = Math.min(fit, sh / band.h)
  }

  const s = fit * scale

  // 锚点是带子底边中点。x 的算法：
  //   先让"画布中心"落在可用区中心，再减去取景带相对画布中心的偏移 ——
  //   这样摆在框正中的是**取景带**（也就是形象本身），而不是声明的画布。
  //   注意带子是否偏心不影响 rendered（推导后 offset 会约掉），rendered 始终是居中矩形。
  const x = pl + availW / 2 - num(band.centerOffset, true) * s
  const y = boxH - pb
  const rw = band.w * s
  const rh = band.h * s

  return {
    scale: s,
    x,
    y,
    anchorY: band.anchorY,
    bandW: band.w,
    bandH: band.h,
    rendered: { left: pl + (availW - rw) / 2, top: y - rh, width: rw, height: rh }
  }
}

/** 判断渲染矩形是否完全落在画布内（容差 tol 像素） */
export function isInsideBox(rendered, boxW, boxH, tol = 0.5) {
  if (!rendered) return false
  return (
    rendered.left >= -tol &&
    rendered.top >= -tol &&
    rendered.left + rendered.width <= boxW + tol &&
    rendered.top + rendered.height <= boxH + tol
  )
}

/** 数值兜底：非法/未定义 → 0；allowNegative 时允许负值（centerOffset 可为负） */
function num(v, allowNegative = false) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (allowNegative) return n
  return n > 0 ? n : 0
}
