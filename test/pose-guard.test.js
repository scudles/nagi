// test/pose-guard.test.js
// 2026-10-15 需求回归锁：
//   ① 「黑脸」系列表情（dark_mask×4）彻底移除——资源文件没了、模型清单干净、
//      源码无残留，且运行时黑名单能挡住"模型文件被还原"的情况；
//   ② 思考姿态是"轻微"的（角度 ≤10°、眼珠 ≤0.6），平滑收敛且与帧率无关；
//   ③ 源码里不再有鼠标跟随（onPointerMove / focusFollow / model.focus）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { POSE_PRESETS, POSE_NEUTRAL, poseTargets, easePose, poseSettled, isSubtlePose } from '../src/core/pose.js'
import { isHiddenExpression } from '../src/renderer/js/live2d.js'

// 注意：2026-10-17 换装后 models/ 下只剩「缅因妹妹」；Lisette 归档到 models-archive/。
// 这两条针对 Lisette 资源的断言改成在归档目录里查（归档没了一起跳过，不是失败）。
const ARCHIVED = join(process.cwd(), 'models-archive', 'Lisette')
const MODEL_DIR = ARCHIVED
const ARCHIVE_OK = existsSync(join(ARCHIVED, 'Lisette.model3.json'))
const skipArchive = ARCHIVE_OK ? false : 'models-archive/Lisette 不存在（旧模型未归档）'

/* ---------------- ① 「黑脸」系列：资源与清单 ---------------- */

test('黑脸资源文件已删除（4 个 dark_mask*.exp3.json 一个不留），其余表情一个没动', { skip: skipArchive }, () => {
  const files = readdirSync(join(MODEL_DIR, 'Expressions')).filter((f) => f.endsWith('.exp3.json'))
  const dark = files.filter((f) => /dark[_-]?mask/i.test(f))
  assert.deepEqual(dark, [], `仍存在黑脸资源：${dark.join(', ')}`)
  // 其余 15 个表情文件原样保留（只删黑脸，别的一个不动）
  assert.deepEqual(files.sort(), [
    'angry.exp3.json',
    'body_X_reverse.exp3.json',
    'body_Y_reverse.exp3.json',
    'body_Z_reverse.exp3.json',
    'frenzy.exp3.json',
    'nagi_calm.exp3.json',
    'nagi_joy.exp3.json',
    'nagi_pout.exp3.json',
    'nagi_puzzled.exp3.json',
    'sad.exp3.json',
    'sans_eye_glow.exp3.json',
    'shy.exp3.json',
    'tear.exp3.json',
    'tongue_out.exp3.json',
    'walking_toggle.exp3.json'
  ])
})

test('模型清单里没有黑脸条目', { skip: skipArchive }, () => {
  const d = JSON.parse(readFileSync(join(MODEL_DIR, 'Lisette.model3.json'), 'utf8'))
  const names = (d.FileReferences?.Expressions || []).map((e) => e.Name)
  assert.equal(names.length, 11, `表情条目应为 11，实际 ${names.length}`)
  for (const n of names) assert.ok(!isHiddenExpression(n), `清单里仍有黑脸：${n}`)
  // 常用表情都还在（只删黑脸，别的一个不动）
  for (const keep of ['nagi_calm', 'nagi_joy', 'nagi_puzzled', 'nagi_pout', 'shy', 'sad', 'angry', 'frenzy', 'sans_eye_glow']) {
    assert.ok(names.includes(keep), `表情 ${keep} 不该被删`)
  }
})

test('运行时黑名单：命中 4 个黑脸及其变体，不误伤正常表情', () => {
  for (const n of ['dark_mask', 'dark_mask2', 'dark_mask3', 'dark_mask4', 'Dark_Mask', 'darkmask', 'DARK-MASK-9']) {
    assert.ok(isHiddenExpression(n), `应挡住 ${n}`)
  }
  for (const n of ['nagi_calm', 'nagi_joy', 'nagi_puzzled', 'nagi_pout', 'shy', 'sad', 'angry', 'tear', 'frenzy', 'sans_eye_glow', 'walking_toggle', 'body_Y_reverse']) {
    assert.ok(!isHiddenExpression(n), `误伤正常表情 ${n}`)
  }
  assert.ok(!isHiddenExpression(''), '空名不误伤')
})

/* ---------------- ② 源码残留扫描 ---------------- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|json|html|css)$/.test(name)) out.push(p)
  }
  return out
}

test('源码无黑脸/鼠标跟随残留', () => {
  const src = join(process.cwd(), 'src')
  const bad = []
  for (const f of walk(src)) {
    const text = readFileSync(f, 'utf8')
    // 黑脸：注释里提一句"已移除"是允许的（说明性文字），但不允许出现资源路径/清单条目式引用
    for (const m of text.matchAll(/dark[_-]?mask\d*\.exp3\.json/gi)) bad.push(`${f}: ${m[0]}`)
    if (/Expressions\/dark/i.test(text)) bad.push(`${f}: Expressions/dark…`)
    // 鼠标跟随：实现必须一个不剩。
    // 注意：focusController.focus(0, 0, true) 是"取消跟随"的归中动作，必须允许；
    // 主进程的 win.focus()/window.focus() 是窗口聚焦，与立绘目光无关，也不该误伤。
    if (/onPointerMove/.test(text)) bad.push(`${f}: onPointerMove`)
    if (/focusFollow/.test(text)) bad.push(`${f}: focusFollow`)
    if (/model\.focus\(/.test(text)) bad.push(`${f}: model.focus(`)
  }
  assert.deepEqual(bad, [], `仍有残留：\n${bad.join('\n')}`)
})

/* ---------------- ③ 思考姿态：产品口径 ---------------- */

test('思考姿态覆盖 目光/头/身体 三类参数，且刻意保持轻微', () => {
  const t = POSE_PRESETS.thinking
  const ids = Object.keys(t)
  assert.ok(ids.includes('ParamEyeBallX') && ids.includes('ParamEyeBallY'), '要有目光偏移')
  assert.ok(ids.some((i) => /^ParamAngle/.test(i)), '要有头部角度')
  assert.ok(ids.some((i) => /^ParamBodyAngle/.test(i)), '身体要跟着一点点')
  assert.ok(isSubtlePose(t), '思考姿态必须是"轻微"的（角度 ≤10°、眼珠 ≤0.6）')
  assert.ok(Math.abs(t.ParamAngleX) >= 2 && Math.abs(t.ParamAngleZ) >= 2,
    '思考姿态的头部偏转也需可见，不能缩小十倍后近乎静止')
  // 方向口径：目光移开 + 下垂；头低 + 侧
  assert.ok(t.ParamEyeBallX > 0 && t.ParamEyeBallY < 0, '目光应偏移并微微下垂')
  assert.ok(t.ParamAngleX < 0 && t.ParamAngleZ !== 0, '头应略低且侧一点')
})

test('poseTargets：中立/未知姿态返回空表（= 全部归零交还模型自身）', () => {
  assert.deepEqual(poseTargets(POSE_NEUTRAL), {})
  assert.deepEqual(poseTargets(null), {})
  assert.deepEqual(poseTargets('不存在的姿态'), {})
  assert.deepEqual(poseTargets('thinking'), POSE_PRESETS.thinking)
})

test('easePose：收敛到目标，且与帧率无关', () => {
  const target = 5
  // 大步长一次
  const big = easePose(0, target, 0.5, 6)
  // 同等时长切成 10 小步
  let small = 0
  for (let i = 0; i < 10; i++) small = easePose(small, target, 0.05, 6)
  assert.ok(Math.abs(big - small) < 1e-9, `帧率相关：${big} vs ${small}`)
  // 单调逼近、不越过目标
  let v = 0
  for (let i = 0; i < 200; i++) {
    const next = easePose(v, target, 1 / 60, 6)
    assert.ok(next > v && next <= target, '应单调逼近且不冲过目标')
    v = next
  }
  assert.ok(poseSettled(v, target))
  // dt 为 0/负值时不炸
  assert.equal(easePose(1, 5, 0, 6), 1)
  assert.equal(easePose(1, 5, -1, 6), 1)
})
