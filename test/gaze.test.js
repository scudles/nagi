// test/gaze.test.js
// 注视方向换算的回归锁（纯逻辑，不碰 electron）：
//   · 方向语义：她在屏幕中间 → 鼠标在最左就是 -1（往她自己左边看）、最右是 +1；
//   · 一律夹到 [-1,1]：屏幕外的坐标不能算出越界方向；
//   · 非法输入（NaN/undefined/缺字段）返回 0，不能让 NaN 流进模型参数；
//   · "有没有动"的判定：手抖（小于阈值）不算动 —— 否则她的目光会一直抖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { MOVE_PX, POLL_MS, moved, toGazeDir } from '../src/core/gaze.js'

const VIEW = { width: 1920, height: 1080 }
const CENTER = { x: 960, y: 540 } // 屏幕正中

test('正中央的光标 → 方向 0（她不用偏头）', () => {
  assert.deepEqual(toGazeDir({ x: 960, y: 540 }, CENTER, VIEW), { x: 0, y: 0 })
})

test('屏幕最左 / 最右 → x 分别是 -1 / +1', () => {
  assert.equal(toGazeDir({ x: 0, y: 540 }, CENTER, VIEW).x, -1)
  assert.equal(toGazeDir({ x: 1920, y: 540 }, CENTER, VIEW).x, 1)
})

test('屏幕最上 / 最下 → y 分别是 -1 / +1', () => {
  assert.equal(toGazeDir({ x: 960, y: 0 }, CENTER, VIEW).y, -1)
  assert.equal(toGazeDir({ x: 960, y: 1080 }, CENTER, VIEW).y, 1)
})

test('屏幕外的坐标被夹到 +/-1（多显示器接在更远处也不会越界）', () => {
  const far = toGazeDir({ x: 9000, y: -4000 }, CENTER, VIEW)
  assert.equal(far.x, 1)
  assert.equal(far.y, -1)
})

test('非法输入一律返回 0（NaN 不能流进模型参数）', () => {
  for (const bad of [
    [null, CENTER, VIEW],
    [{ x: NaN, y: 10 }, CENTER, VIEW],
    [{ x: 'a', y: 'b' }, CENTER, VIEW],
    [undefined, undefined, undefined],
    [{ x: 10, y: 10 }, null, VIEW]
  ]) {
    assert.deepEqual(toGazeDir(...bad), { x: 0, y: 0 }, JSON.stringify(bad))
  }
})

test('窗口中心在屏幕左下角时，右侧鼠标 → x 为正（方向是相对她自己）', () => {
  const corner = { x: 100, y: 1000 }
  const r = toGazeDir({ x: 1900, y: 1000 }, corner, VIEW)
  assert.ok(r.x > 0.5, `应当明显偏右，实际 ${r.x}`)
  assert.equal(r.y, 0)
})

test('moved：小于阈值的抖动不算"在动"', () => {
  const a = { x: 100, y: 100 }
  assert.equal(moved(a, { x: 101, y: 100 }), false, '动 1px 不算')
  assert.equal(moved(a, { x: 100 + MOVE_PX, y: 100 }), true, '刚好到阈值算动')
  assert.equal(moved(a, { x: 100, y: 100 + MOVE_PX }), true)
  assert.equal(moved(a, { x: 100, y: 100 }), false, '完全没动')
})

test('moved：第一次采样（没有上一帧）算作开始观测', () => {
  assert.equal(moved(null, { x: 5, y: 5 }), true)
  assert.equal(moved(undefined, undefined), true)
})

test('采样间隔是"最多 2.5 条/秒"的量级（别把主进程刷爆）', () => {
  assert.ok(POLL_MS >= 300 && POLL_MS <= 1000, `POLL_MS=${POLL_MS} 不合理`)
})
