// test/outfit.test.js
// 装束纯逻辑回归锁：
//   ① 真实配置 models/Maine/nagi-outfit.json 能解析、每个 look 都能补全成完整槽位表；
//   ② 装束参数必须真的存在于模型（cdi3 实扫）——装束写错参数名会静默失效，
//      这一条是静态一侧的保险（运行时一侧由 filterParams 过滤）；
//   ③ 参数合成：base 公共项 + 槽位选项叠加，尾巴三个选项互斥关系正确；
//   ④ 循环 / 随机 / 单槽位微调的行为与边界（空配置、只有一个 look、avoid 当前项）；
//   ⑤ 坏数据降级：缺槽位、缺 look、选项非法值都不应让表现层崩。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseOutfit,
  normalizeSlots,
  lookById,
  lookParams,
  slotsParams,
  describeLook,
  cycleLook,
  randomLookId,
  shiftOneSlot,
  filterParams
} from '../src/core/outfit.js'

const ROOT = process.cwd()
const MODEL_DIR = join(ROOT, 'models', 'Maine')
const raw = JSON.parse(readFileSync(join(MODEL_DIR, 'nagi-outfit.json'), 'utf8'))
const cfg = parseOutfit(raw)

/** 模型真实参数清单 */
const paramIds = (() => {
  const cdi = JSON.parse(readFileSync(join(MODEL_DIR, 'Maine.cdi3.json'), 'utf8'))
  return (cdi.Parameters || []).map((p) => p.Id)
})()

/* ---------------- ① 配置能解析 ---------------- */

test('真实装束配置：解析无错、槽位与预案齐全', () => {
  assert.equal(cfg.ok, true, `配置有错：${cfg.errors.join('；')}`)
  assert.ok(cfg.slots.length >= 6, `槽位太少：${cfg.slots.length}`)
  assert.ok(cfg.looks.length >= 4, `预案太少：${cfg.looks.length}`)
  assert.ok(lookById(cfg, cfg.defaultLook), 'defaultLook 必须指向真实存在的预案')
})

test('每个 look 的槽位表都被补全（不会漏槽位）', () => {
  for (const l of cfg.looks) {
    for (const s of cfg.slots) {
      assert.ok(l.slots[s.id], `预案「${l.name}」缺槽位 ${s.id}`)
      assert.ok(
        s.options.some((o) => o.id === l.slots[s.id]),
        `预案「${l.name}」的 ${s.id}=${l.slots[s.id]} 不是合法选项`
      )
    }
  }
})

/* ---------------- ② 参数必须真实存在 ---------------- */

test('装束引用的参数全部真实存在于模型（cdi3 实扫）', () => {
  const used = new Set(Object.keys(cfg.base))
  for (const s of cfg.slots) for (const o of s.options) for (const k of Object.keys(o.params || {})) used.add(k)
  const missing = [...used].filter((id) => !paramIds.includes(id))
  assert.deepEqual(missing, [], `配置里有模型不存在的参数：${missing.join(', ')}`)
})

test('发型四个选项互斥：都只写自己那个参数为 1', () => {
  const hair = cfg.slots.find((s) => s.id === 'hair')
  const params = ['Param2', 'Param3', 'Param4', 'Param5']
  for (const o of hair.options) {
    const keys = Object.keys(o.params || {})
    if (!keys.length) continue // 「长发」是不写参数（回到默认）
    assert.equal(keys.length, 1, `发型选项 ${o.id} 只该写一个参数，实际 ${keys.join(',')}`)
    assert.ok(params.includes(keys[0]))
    assert.equal(o.params[keys[0]], 1, `发型选项 ${o.id} 的值应为 1`)
  }
})

test('尾巴三选项：翘起与收起互斥（不会同时开）', () => {
  const tail = cfg.slots.find((s) => s.id === 'tail')
  for (const o of tail.options) {
    const p = o.params || {}
    assert.notEqual(
      p.Param467 === 1 && p.Param322 === 1,
      true,
      `尾巴选项 ${o.id} 同时写了「关闭」和「位置」，会打架`
    )
  }
})

/* ---------------- ③ 参数合成 ---------------- */

test('lookParams：base 公共项一定带上，槽位参数按选项合成', () => {
  const p = lookParams(cfg, 'going_out')
  assert.equal(p.Param469, 1, '水印关闭是所有装束的公共项')
  assert.equal(p.Param4, 1, '出门应当是高马尾')
  assert.equal(p.Param11, 1, '出门要把蝴蝶结收起来')
  assert.equal(p.Param466, 1, '出门要把披肩收起来')
  assert.equal(p.Param322 ?? 0, 0, '出门尾巴垂着')
})

test('slotsParams 与 lookParams 对同一个装束给出一致结果', () => {
  for (const l of cfg.looks) {
    assert.deepEqual(slotsParams(cfg, l.slots), lookParams(cfg, l.id), `预案「${l.name}」两条路径结果不一致`)
  }
})

test('未知装束 id 只回退到公共项，不抛错', () => {
  const p = lookParams(cfg, 'not-a-look')
  assert.deepEqual(p, { ...cfg.base })
})

test('describeLook 给出非空的人类可读描述', () => {
  for (const l of cfg.looks) {
    const d = describeLook(cfg, l.id)
    assert.ok(d && d.length > 2, `预案「${l.name}」描述为空`)
  }
})

/* ---------------- ④ 循环 / 随机 / 微调 ---------------- */

test('cycleLook 首尾相接，方向正确', () => {
  const ids = cfg.looks.map((l) => l.id)
  assert.equal(cycleLook(cfg, ids[0], 1), ids[1])
  assert.equal(cycleLook(cfg, ids[ids.length - 1], 1), ids[0], '最后一个的下一个回到第一个')
  assert.equal(cycleLook(cfg, ids[0], -1), ids[ids.length - 1], '第一个的上一个绕到最后')
  assert.equal(cycleLook(cfg, 'unknown', 1), ids[0], '未知当前项从头开始')
})

test('randomLookId 不会抽到要避开的那个', () => {
  const ids = cfg.looks.map((l) => l.id)
  const seq = [0.999, 0, 0.5, 0.13, 0.77]
  let i = 0
  const rng = () => seq[i++ % seq.length]
  for (let n = 0; n < 20; n++) {
    const id = randomLookId(cfg, { avoid: ids[0], rng })
    assert.notEqual(id, ids[0])
    assert.ok(ids.includes(id))
  }
})

test('只有一个 look 时 randomLookId 仍返回它（不能返回 null）', () => {
  const one = parseOutfit({ slots: raw.slots, looks: [raw.looks[0]] })
  assert.equal(randomLookId(one, { avoid: one.looks[0].id }), one.looks[0].id)
})

test('shiftOneSlot 只改一个槽位，其它槽位保持不变', () => {
  const base = { hair: 'long', glasses: 'on', ears: 'show', ribbon: 'on', cape: 'on', tail: 'down' }
  const r = shiftOneSlot(cfg, base, { rng: () => 0.4 })
  assert.ok(r, '应当能换一处')
  assert.notEqual(r.slots[r.slot], base[r.slot], '换的那个槽位必须真的变了')
  for (const k of Object.keys(base)) {
    if (k !== r.slot) assert.equal(r.slots[k], base[k], `不该动 ${k}`)
  }
  // 再换一次应当仍合法
  const r2 = shiftOneSlot(cfg, r.slots, { rng: () => 0.9 })
  assert.ok(r2 && r2.slots)
})

test('shiftOneSlot：所有槽位都只有一个选项时返回 null', () => {
  const one = parseOutfit({ slots: [{ id: 'x', options: [{ id: 'only', params: {} }] }] })
  assert.equal(shiftOneSlot(one, { x: 'only' }), null)
})

/* ---------------- ⑤ 坏数据降级 ---------------- */

test('空配置 / null 不抛错，返回可用的空壳', () => {
  for (const bad of [null, undefined, 0, 'x', {}]) {
    const c = parseOutfit(bad)
    assert.deepEqual(c.slots, [])
    assert.deepEqual(c.looks, [])
    assert.equal(c.defaultLook, '')
  }
})

test('槽位选项非法值被忽略，落到该项默认', () => {
  const c = parseOutfit({
    slots: [
      { id: 'a', options: [{ id: 'a1', params: { P: 1 } }, { id: 'a2', params: { P: 2 } }] },
      { id: 'b', options: [{ id: 'b1', params: { Q: 1 } }] }
    ],
    looks: [{ id: 'L', name: 'L', slots: { a: '不存在', b: 'b1' } }]
  })
  assert.equal(c.looks[0].slots.a, 'a1', '非法选项应当回落到第一项')
  assert.equal(c.looks[0].slots.b, 'b1')
})

test('没有配置任何 look 时自动补一个默认装束（不让表现层没得跑）', () => {
  const c = parseOutfit({ slots: raw.slots })
  assert.equal(c.looks.length, 1)
  assert.equal(c.looks[0].id, 'default')
  assert.equal(c.ok, false, '这种情况应当被标为有错（配置不全）')
})

test('normalizeSlots 对缺项与非法项都回落到第一项', () => {
  const slots = [{ id: 'a', options: [{ id: 'a1' }, { id: 'a2' }] }]
  assert.deepEqual(normalizeSlots(slots, {}), { a: 'a1' })
  assert.deepEqual(normalizeSlots(slots, { a: 'nope' }), { a: 'a1' })
  assert.deepEqual(normalizeSlots(slots, { a: 'a2' }), { a: 'a2' })
})

/* ---------------- 参数过滤 ---------------- */

test('filterParams 丢掉模型没有的参数，并报告丢了哪些', () => {
  const r = filterParams({ Param2: 1, 不存在: 5, ParamEx: 0 }, ['Param2', 'ParamEx'])
  assert.deepEqual(r.params, { Param2: 1, ParamEx: 0 })
  assert.deepEqual(r.dropped, ['不存在'])
})

test('filterParams 在参数清单为空时放行（模型还没加载完）', () => {
  const r = filterParams({ Param2: 1 }, [])
  assert.deepEqual(r.params, { Param2: 1 })
  assert.deepEqual(r.dropped, [])
})
