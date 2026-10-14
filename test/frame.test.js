// test/frame.test.js
// 锁定两件产品硬约束：
//   1) 默认取景是「胸像」——只看得到上半身，绝不等于全身；
//   2) 装框是 contain —— 形象永远落在画布内（含安全边距），不可能越界去盖 UI。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FRAME,
  FRAME_PRESETS,
  fitBand,
  frameBand,
  framePreset,
  isBustFrame,
  isInsideBox
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
