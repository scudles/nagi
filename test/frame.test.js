// test/frame.test.js
// 锁定两件产品硬约束：
//   1) 默认取景是「胸像」——只看得到上半身，绝不等于全身；
//   2) 装框是 contain —— 形象永远落在画布内（含安全边距），不可能越界去盖 UI。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FRAME,
  FRAME_PRESETS,
  STANDARD_BOX,
  fitBand,
  frameBand,
  framePreset,
  isBustFrame,
  isInsideBox,
  standardBoxFor
} from '../src/core/frame.js'

// 真实模型：Lisette 的 moc 画布 2715 × 4465
const MODEL = { w: 2715, h: 4465 }

test('默认取景是胸像，不是全身', () => {
  assert.equal(DEFAULT_FRAME, 'bust')
  assert.equal(isBustFrame(undefined), true)
  assert.equal(isBustFrame('bust'), true)
  assert.equal(isBustFrame('full'), false)
})

test('胸像取景带只覆盖模型上半部分', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const p = FRAME_PRESETS.bust
  assert.equal(band.w, MODEL.w * (p.right - p.left))
  assert.equal(band.h, MODEL.h * (p.bottom - p.top))
  assert.ok(band.h < MODEL.h * 0.6, '胸像带高应明显小于全身')
  assert.equal(band.anchorY, p.bottom)
})

// 实测数据（scripts/probe-art.mjs）：
// Lisette 的美术**画到了角色核心之外**，整体范围 fx∈[0.149,0.925]、fy∈[0.053,0.963]；
// 抬手的待机动作用会把右缘从 0.829 推到 0.925（两次实机取景各测到一次）。
// 取景带必须按最宽姿态把美术整段包住并留余量，否则头发/手臂会在画布边被裁
// （曾经右缘 0.85 时，手臂直接顶到画布边、还蹭进了右侧工具条的保留区）。
const ART = { left: 0.149, right: 0.925, top: 0.053 }
test('取景带包住美术真实范围并留余量（否则头发/手臂会被画布裁掉）', () => {
  const p = FRAME_PRESETS.bust
  assert.ok(p.left < ART.left, `左边要留余量：band ${p.left} 应小于美术左缘 ${ART.left}`)
  assert.ok(p.right > ART.right, `右边要留余量：band ${p.right} 应大于美术右缘 ${ART.right}`)
  assert.ok(p.top < ART.top, `头顶上方要留余量：band ${p.top} 应小于美术顶 ${ART.top}`)
})

test('取景带偏心量随之给出，且左右余量不悬殊', () => {
  const p = FRAME_PRESETS.bust
  const band = frameBand('bust', MODEL.w, MODEL.h)
  assert.ok(band.centerOffset > 0, '该模型美术偏右，取景带中心应偏右')
  const lm = ART.left - p.left
  const rm = p.right - ART.right
  assert.ok(Math.abs(lm - rm) < 0.05, `左右余量应接近，实际 左${lm.toFixed(3)} / 右${rm.toFixed(3)}`)
})

test('偏心取景带被摆正：落在框中央的是"形象"，不是声明的画布', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const fit = fitBand({ band, boxW: 400, boxH: 600 })
  const centerPx = fit.x + (band.x + band.w / 2 - MODEL.w / 2) * fit.scale
  assert.ok(Math.abs(centerPx - 200) < 0.5, `取景带中心应落在框中央 200，实际 ${centerPx.toFixed(2)}`)
  assert.ok(Math.abs(fit.rendered.left + fit.rendered.width / 2 - 200) < 0.5, 'rendered 也应居中')
})

test('取景带顶边越过画布上边界，保证头顶不被切', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  // 顶边必须是负的（往画布上方留余量），但也别留出一大片空白
  assert.ok(band.y < 0, `取景带顶边应高于画布上边界，实际 y=${band.y}`)
  assert.ok(band.y > -MODEL.h * 0.15, '但也不能留出一大片空白')
})

test('full 取景带等于整张模型（保留能力，不误删）', () => {
  const band = frameBand('full', MODEL.w, MODEL.h)
  assert.equal(band.w, MODEL.w)
  assert.equal(band.h, MODEL.h)
  assert.equal(band.y, 0)
  assert.equal(band.anchorY, 1)
})

test('未知取景模式回落到默认（不会意外变全身）', () => {
  assert.deepEqual(framePreset('no-such-mode'), FRAME_PRESETS[DEFAULT_FRAME])
  assert.equal(frameBand('no-such-mode', MODEL.w, MODEL.h).anchorY, FRAME_PRESETS.bust.bottom)
})

test('contain 装框：常见画布尺寸下都完整落在框内', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const boxes = [
    { w: 299, h: 383 }, // 工作台面板（窄）
    { w: 299, h: 515 }, // 工作台面板（高）
    { w: 460, h: 700 }, // 面板拖到最宽
    { w: 400, h: 600 }, // 桌宠默认
    { w: 240, h: 360 }, // 桌宠最小
    { w: 760, h: 1140 }, // 桌宠最大
    { w: 1600, h: 400 }, // 极扁（横屏/大宽口）
    { w: 300, h: 150 } // 默认画布尺寸（尚未重排时）
  ]
  for (const b of boxes) {
    const fit = fitBand({ band, boxW: b.w, boxH: b.h })
    assert.ok(
      isInsideBox(fit.rendered, b.w, b.h),
      `形象越界了：box ${b.w}x${b.h} → rendered ${JSON.stringify(fit.rendered)}`
    )
    assert.ok(fit.rendered.width > 0 && fit.rendered.height > 0, '渲染尺寸必须为正')
  }
})

test('安全边距被尊重：形象不会压到画布内的 UI', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const boxW = 400
  const boxH = 600
  const pad = { top: 0, right: 44, bottom: 26, left: 0 }
  const fit = fitBand({ band, boxW, boxH, pad })
  assert.ok(fit.rendered.left >= pad.left - 0.5, '左边不越界')
  assert.ok(fit.rendered.left + fit.rendered.width <= boxW - pad.right + 0.5, '右边不侵占工具条')
  assert.ok(fit.rendered.top >= pad.top - 0.5, '上边不越界')
  assert.ok(fit.rendered.top + fit.rendered.height <= boxH - pad.bottom + 0.5, '下边不压状态行')
})

test('缩放为 1 时底边贴齐可用区底部（人物"站在"框底）', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const fit = fitBand({ band, boxW: 400, boxH: 600, pad: { bottom: 20 } })
  assert.ok(Math.abs(fit.rendered.top + fit.rendered.height - (600 - 20)) < 1e-6)
})

test('用户放大时会超出画布（可预期），但画布会裁掉，不会跑到框外去', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const fit = fitBand({ band, boxW: 400, boxH: 600, scale: 2 })
  // 缩放 2 倍时渲染尺寸确实超过画布 —— 这是用户主动放大的结果，
  // 由画布自身裁切，画布外的 UI 不受影响
  assert.ok(fit.rendered.height > 600 * 0.9)
})

test('取景带高宽比合理：胸像应比全身"更方"，不会拉成细条', () => {
  const bust = frameBand('bust', MODEL.w, MODEL.h)
  const full = frameBand('full', MODEL.w, MODEL.h)
  assert.ok(bust.w / bust.h > full.w / full.h, '胸像带相对更宽（更像头像/半身）')
  assert.ok(bust.w / bust.h < 1.6, '不至于宽到离谱')
})

test('渲染矩形落在画布内的判定（含容差）', () => {
  assert.equal(isInsideBox({ left: 0, top: 0, width: 100, height: 100 }, 100, 100), true)
  assert.equal(isInsideBox({ left: -1, top: 0, width: 100, height: 100 }, 100, 100), false)
  assert.equal(isInsideBox({ left: 0, top: 0, width: 101, height: 100 }, 100, 100), false)
  assert.equal(isInsideBox(null, 100, 100), false)
})

// ---- 统一缩放（2026-10-17 用户拍板：各界面同一套缩放比例与锚点，切换不跳变）----

test('统一缩放基准：胸像参与，full 不参与', () => {
  assert.deepEqual(standardBoxFor('bust'), STANDARD_BOX)
  assert.deepEqual(standardBoxFor(undefined), STANDARD_BOX)
  assert.equal(standardBoxFor('full'), null)
})

test('标准区封顶：装得下就锁标准比例，装不下才等比缩小', () => {
  const band = frameBand('bust', MODEL.w, MODEL.h)
  const stdFit = STANDARD_BOX.w / band.w
  // 大窗（桌宠最大 760×1140）：contain 远大于标准 → 锁标准比例
  const big = fitBand({ band, boxW: 760, boxH: 1140, standard: STANDARD_BOX })
  assert.ok(Math.abs(big.scale - stdFit) < 1e-9, `大窗应锁标准比例 ${stdFit.toFixed(5)}，实际 ${big.scale.toFixed(5)}`)
  assert.ok(isInsideBox(big.rendered, 760, 1140), '锁标准后仍然完整落在框内')
  // 小窗（桌宠最小 240×360）：contain 小于标准 → 按本窗 contain 缩小，不裁切
  const small = fitBand({ band, boxW: 240, boxH: 360, standard: STANDARD_BOX })
  const contain = Math.min(240 / band.w, 360 / band.h)
  assert.ok(Math.abs(small.scale - contain) < 1e-9, '小窗应按本窗 contain 缩小')
  assert.ok(small.scale < stdFit, '且必须小于标准比例')
  assert.ok(isInsideBox(small.rendered, 240, 360), '缩小后仍然完整落在框内')
  // 不传 standard（旧调用方）→ 行为与从前完全一致
  const legacy = fitBand({ band, boxW: 760, boxH: 1140 })
  assert.ok(legacy.scale > stdFit, '缺省 standard 时保持纯 contain，不被封顶')
})

test('缅因妹妹：桌宠与工作台默认舞台落在同一缩放比例与锚点（切换界面不跳变）', () => {
  const MW = 5000
  const MH = 7000
  const band = frameBand('bust', MW, MH, 'Maine')
  const pet = fitBand({ band, boxW: 400, boxH: 600, pad: { right: 44, bottom: 26 }, standard: STANDARD_BOX })
  const wb = fitBand({ band, boxW: 300, boxH: 480, standard: STANDARD_BOX })
  assert.ok(
    Math.abs(pet.scale - wb.scale) < 1e-9,
    `两界面应同比例：桌宠 ${pet.scale.toFixed(5)} vs 工作台 ${wb.scale.toFixed(5)}`
  )
  assert.equal(pet.anchorY, band.anchorY, '锚点相同（都"站在"肚脐线上）')
  assert.equal(wb.anchorY, band.anchorY)
  assert.ok(pet.scale <= STANDARD_BOX.w / band.w + 1e-9, '不超过标准比例')
  // 锚点相同 + 比例相同 ⇒ 同一套参数；rendered 都居中在各自可用区里
  assert.ok(isInsideBox(pet.rendered, 400, 600) && isInsideBox(wb.rendered, 300, 480), '两界面都不越界')
})

test('缅因取景带：下边界是肚脐线，头顶留容位，横向包住美术', () => {
  const MW = 5000
  const MH = 7000
  const band = frameBand('bust', MW, MH, 'Maine')
  const p = FRAME_PRESETS.Maine
  // 实测（2026-10-18，scripts/probe-upper-body.mjs，Z 轴位移 bug 修复后）：
  // 头顶 fy=0.030、肚脐 fy=0.48、上半身横向美术 fx∈[0.218,0.769]
  // （旧口径 [0.273,0.813] 是位移 bug 时代测的，中心偏右 0.049，已弃用）
  assert.equal(band.anchorY, 0.48, '带子底边（锚点）应落在肚脐线')
  assert.ok(p.top < 0.03 && p.top > 0, `头顶上方要留容位但不能是一片空白：top=${p.top}`)
  assert.ok(p.left < 0.218 && p.right > 0.769, '横向要包住上半身美术并留余量')
  assert.equal(band.y, MH * 0.015, '带子顶边落在画布内 0.015 处（正数，不再越出画布上边界）')
  assert.ok(band.h < MH * 0.5, '特写带高必须明显小于半身')
  assert.ok(band.w / band.h < 1, '肚脐以上是竖长特写，带宽高比应小于 1')
})
