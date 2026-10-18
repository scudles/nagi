// test/turn.test.js
// 转向（转头）控制器的纯逻辑验收。
//
// 2026-10-18 用户反馈「部分动作开始和结束都太过突兀，比如突然快速转头，动作复位衔接不自然」，
// 这一轮改了两件事，必须钉住：
//   ① 缓动从 easeOut/easeIn 换成 easeInOutSine —— 起止两端的速度都要接近 0
//      （旧曲线把"速度最大"放在起止点上，读起来就是猛一下动、到点突然停）；
//   ② 打断续接 —— 转向中途换方向（+0.9 转到一半改成 −0.88 别过头）时，
//      新的淡入必须从"当前实际朝向"出发，不能先跳回 0 再转。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TURN_KIND,
  TURN_PRESETS,
  createTurnController,
  directionFrom,
  describeTurn
} from '../src/core/face/turn.js'

/** 造一个可控时钟 */
function clock(start = 0) {
  let t = start
  return {
    now: () => t,
    set: (v) => {
      t = v
    },
    add: (d) => {
      t += d
    }
  }
}

test('出厂预设齐全，且每个由头都有进入/保持/退出三段', () => {
  for (const kind of Object.values(TURN_KIND)) {
    const p = TURN_PRESETS[kind]
    assert.ok(p, `${kind} 应有预设`)
    assert.ok(p.inMs > 0 && p.holdMs > 0 && p.outMs > 0, `${kind} 三段时长都要为正`)
    // 退出必须比进入慢一点（"转回来"比"转过去"更容易看出突兀）
    assert.ok(p.outMs >= p.inMs, `${kind} 的 outMs 不应短于 inMs`)
    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.body) <= 1, `${kind} 归一化范围 ±1`)
  }
})

test('进入段是缓入：起步慢、中段快（不是 easeOut 那种"一上来就冲"）', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  const P = TURN_PRESETS[TURN_KIND.POKE]
  assert.deepEqual(ctl.turn(TURN_KIND.POKE), { ok: true })

  const sample = []
  for (let t = 0; t <= P.inMs; t += 10) {
    c.set(t)
    const s = ctl.tick()
    sample.push({ t, x: s ? s.x : 0 })
  }
  const step = (from, to) => {
    const a = sample.find((v) => v.t >= from)
    const b = sample.find((v) => v.t >= to)
    return Math.abs(b.x - a.x)
  }
  // 首 10% 时间窗 vs 中间 10% 时间窗：缓入曲线下前者应明显小于后者
  const head = step(0, P.inMs * 0.1)
  const middle = step(P.inMs * 0.45, P.inMs * 0.55)
  assert.ok(middle > head * 2, `进入段应慢起：首窗位移 ${head.toFixed(3)} 应远小于中段 ${middle.toFixed(3)}`)
})

test('退出段是缓出：收尾慢、不会到点突然停住', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  const P = TURN_PRESETS[TURN_KIND.POKE]
  ctl.turn(TURN_KIND.POKE)
  const outStart = P.inMs + P.holdMs
  c.set(outStart)
  const begin = ctl.tick()
  assert.ok(Math.abs(begin.x - P.x) < 1e-9, '进入退出段时应正处在目标值')

  const sample = []
  for (let k = 0; k <= 1.0001; k += 0.05) {
    c.set(outStart + P.outMs * k)
    const s = ctl.tick()
    sample.push({ k, x: s ? s.x : 0 })
  }
  const at = (k) => sample.reduce((best, v) => (Math.abs(v.k - k) < Math.abs(best.k - k) ? v : best)).x
  const tail = Math.abs(at(1) - at(0.9))
  const middle = Math.abs(at(0.55) - at(0.45))
  assert.ok(middle > tail * 2, `退出段应收尾缓慢：中段步进 ${middle.toFixed(3)} 应远大于尾段 ${tail.toFixed(3)}`)
})

test('打断续接：中途换方向时不跳变，从当前朝向继续', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  ctl.turn(TURN_KIND.POKE)
  c.set(200)
  const mid = ctl.tick()
  assert.ok(mid.x > 0.3 && mid.x < TURN_PRESETS[TURN_KIND.POKE].x, `200ms 时应转到中途，实际 ${mid.x.toFixed(3)}`)

  // 换一个反方向的动作（away 的 x 是负的），force 绕过最小间隔
  ctl.turn(TURN_KIND.AWAY, { force: true })
  const atBreak = ctl.tick()
  assert.ok(Math.abs(atBreak.x - mid.x) < 1e-9, `打断瞬间应与打断前完全一致：${atBreak.x} vs ${mid.x}`)

  c.add(16)
  const next = ctl.tick()
  assert.ok(Math.abs(next.x - atBreak.x) < 0.05, `打断后一帧不应跳变：${atBreak.x.toFixed(3)} → ${next.x.toFixed(3)}`)

  // 之后应朝新目标走（x 变小、最终变负）
  c.set(200 + TURN_PRESETS[TURN_KIND.AWAY].inMs)
  const settled = ctl.tick()
  assert.ok(settled.x < 0, `淡入结束后应到达新方向（负），实际 ${settled.x.toFixed(3)}`)
})

test('总时长走完就归还控制权（tick 返回 null），不再占着角度', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  const P = TURN_PRESETS[TURN_KIND.TYPING]
  ctl.turn(TURN_KIND.TYPING)
  const total = P.inMs + P.holdMs + P.outMs
  c.set(total - 1)
  assert.ok(ctl.tick(), '结束前一帧仍有输出')
  c.set(total + 1)
  assert.equal(ctl.tick(), null, '结束后应返回 null')
  assert.equal(ctl.isActive(), false)
})

test('幅度被夹到 ±1；未知动作被拒', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  assert.equal(ctl.turn('no-such-kind').ok, false)
  ctl.turn(TURN_KIND.SCENE, { x: 9, y: -9, body: 9 })
  c.set(TURN_PRESETS[TURN_KIND.SCENE].inMs)
  const s = ctl.tick()
  assert.ok(Math.abs(s.x - 1) < 1e-9 && Math.abs(s.y + 1) < 1e-9 && Math.abs(s.body - 1) < 1e-9)
})

test('同一由头有冷却，不会连着转；poke 不限', () => {
  const c = clock(0)
  const ctl = createTurnController({ now: c.now })
  assert.equal(ctl.turn(TURN_KIND.SCENE).ok, true)
  c.add(2000)
  assert.equal(ctl.turn(TURN_KIND.SCENE).ok, false, 'SCENE 有 60 秒冷却')
  // poke 不受同由头冷却：但要等上一次结束（MIN_GAP）
  c.add(20000)
  assert.equal(ctl.turn(TURN_KIND.POKE).ok, true)
})

test('directionFrom：没有数据/太近时给默认朝向，有方向时归一化', () => {
  const d = directionFrom(null)
  // 默认朝向是"略偏上"的手工常量，不要求恰好归一化，但要有明确方向
  assert.ok(d.x > 0.5 && d.y > 0, `默认应朝右上：${JSON.stringify(d)}`)
  const near = directionFrom({ x: 0.01, y: 0.01 })
  assert.ok(Math.abs(near.x - 0.9) < 1e-6 && Math.abs(near.y - 0.2) < 1e-6, '太近应回落默认朝向')
  const far = directionFrom({ x: 3, y: 4 })
  assert.ok(Math.abs(far.x - 0.6) < 1e-6 && Math.abs(far.y - 0.8) < 1e-6)
})

test('describeTurn：每个由头都有中文说法', () => {
  for (const kind of Object.values(TURN_KIND)) {
    const text = describeTurn(kind)
    assert.ok(text && text !== kind, `${kind} 应有中文描述`)
  }
})
