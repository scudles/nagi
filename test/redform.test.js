// test/redform.test.js
// 「去掉红色形态」需求的回归锁。
//
// 红色形态由 ParamRed* 一族参数驱动（偏离 0 即泛红），渲染层在 beforeModelUpdate
// 时刻把它们压回 0。开关的判定与选参逻辑在 src/core/redform.js（纯函数，可单测）；
// 本文件同时校验模型资源里的红色参数族与"其余形态没被删"。
//
// 注意：models/ 不入库（体积 + 版权，见 .gitignore），所以模型相关的断言在
// 没有模型目录时会跳过，而不是失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { pickRedParams, shouldRemoveRedGlow } from '../src/core/redform.js'

const EMOTION_CFG = new URL('../models/Lisette/nagi-emotion.json', import.meta.url)
const CDI = new URL('../models/Lisette/Lisette.cdi3.json', import.meta.url)
const MODEL3 = new URL('../models/Lisette/Lisette.model3.json', import.meta.url)

const readJson = (u) => JSON.parse(readFileSync(u, 'utf8'))
const hasModel = existsSync(EMOTION_CFG) && existsSync(CDI) && existsSync(MODEL3)
const skipNoModel = hasModel ? false : 'models/ 不入库，本机没有该模型'

test('去掉红色形态：默认开启（模型配置缺失也不会漏）', () => {
  assert.equal(shouldRemoveRedGlow(undefined), true)
  assert.equal(shouldRemoveRedGlow(null), true)
  assert.equal(shouldRemoveRedGlow({ calm: 'nagi_calm' }), true)
})

test('模型可用 removeRedGlow:false 单独放行', () => {
  assert.equal(shouldRemoveRedGlow({ removeRedGlow: false }), false)
  assert.equal(shouldRemoveRedGlow({ removeRedGlow: true }), true)
})

test('红色参数选取覆盖整族，且不误伤其他参数', () => {
  const red = pickRedParams([
    'ParamRedGlow',
    'ParamRedGlowMove',
    'ParamRedGlowSway',
    'ParamRedGlowSway2',
    'ParamRedGlowPhysics',
    'ParamRedGlowPhysics2',
    'ParamRedGlowPhysics3',
    'ParamRedHighlight',
    'ParamEyeColorL',
    'ParamDarkAngry',
    'ParamEyeBallX',
    'ParamMouthOpenY'
  ])
  assert.equal(red.length, 8)
  for (const id of ['ParamRedGlow', 'ParamRedHighlight']) assert.ok(red.includes(id), `漏掉 ${id}`)
  for (const id of ['ParamEyeColorL', 'ParamDarkAngry', 'ParamEyeBallX', 'ParamMouthOpenY']) {
    assert.ok(!red.includes(id), `误伤 ${id}`)
  }
})

test('输入异常时返回空数组而不是抛错', () => {
  assert.deepEqual(pickRedParams(undefined), [])
  assert.deepEqual(pickRedParams([]), [])
})

test('模型确实存在这族红色参数', { skip: skipNoModel }, () => {
  const ids = readJson(CDI).Parameters.map((p) => p.Id)
  const red = pickRedParams(ids)
  assert.ok(red.includes('ParamRedGlow'), '模型缺少 ParamRedGlow')
  assert.ok(red.includes('ParamRedHighlight'), '模型缺少 ParamRedHighlight')
  assert.ok(red.length >= 5, `红色参数族数量异常: ${JSON.stringify(red)}`)
})

test('其余情绪映射保持完整，闹别扭仍保留生气动作（只是不再泛红）', { skip: skipNoModel }, () => {
  const cfg = readJson(EMOTION_CFG)
  for (const e of ['calm', 'smile', 'joy', 'puzzled', 'worry', 'pout']) {
    assert.ok(cfg[e], `情绪 ${e} 的映射被误删`)
  }
  assert.equal(cfg.pout.expr, 'nagi_pout')
  assert.equal(cfg.pout.motion, 'Angry', '闹别扭应仍播放 Angry 动作（仅去掉红光）')
})

test('动作组与表情清单未被删减（红色只是被遮掉，不是被删掉）', { skip: skipNoModel }, () => {
  const m = readJson(MODEL3)
  const groups = Object.keys(m.FileReferences.Motions)
  for (const g of ['Idle', 'TapBody', 'Greet', 'Happy', 'Sad', 'Angry', 'Frenzy', 'Special']) {
    assert.ok(groups.includes(g), `动作组 ${g} 被删掉了`)
  }
  const exprs = m.FileReferences.Expressions.map((e) => e.Name)
  for (const n of ['nagi_calm', 'nagi_joy', 'nagi_puzzled', 'nagi_pout', 'shy', 'sad']) {
    assert.ok(exprs.includes(n), `表情 ${n} 被删掉了`)
  }
})
