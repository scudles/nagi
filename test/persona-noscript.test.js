// test/persona-noscript.test.js
// 新人设《灵魂与程序》的两条回归锁（人设文档 §十二 第 7 条）。
//
// 为什么是这两条：
//   ① 「无台词」写在提示词里不算数 —— 只要代码里还躺着台词库，
//      她迟早会走回"取出来"而不是"长出来"那条路（历史上已经发生过两次）。
//   ② 旧人设的措辞残留在代码/文档里，会让模型同时收到两套互相矛盾的指令。
//
// 覆盖：
//   A. persona.js 不再有任何台词池
//   B. 兜底只如实说明，不假装会聊天
//   C. 戳一戳恒不出声（只用动作）
//   D. 情绪枚举含三个存在主义层状态
//   E. 全仓扫描：旧人设关键词无残留（注释里的历史说明不算）
//   F. 护栏不再逼她机械声明"我是 AI"

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import NagiPersona, { NagiPersona as Named } from '../src/core/persona.js'
import { EMOTIONS } from '../src/shared/protocol.js'

const ROOT = resolve(import.meta.dirname, '..')

/* ---------------- A. 没有台词池 ---------------- */

test('A persona 里不存在任何台词池', () => {
  // 这些是 2026-10-17 之前真实存在过的池子，约 130 句
  const pools = ['rules', 'proactive', 'monologue', 'monologueByMood', 'pokeByLevel', 'pokeSullen', 'fallback', 'pieces']
  for (const key of pools) {
    assert.equal(NagiPersona[key], undefined, `persona.${key} 不该再存在（那是台词池）`)
  }
})

/* ---------------- B. 兜底如实说明 ---------------- */

test('B 本地兜底不改假装会聊天：给的是"接不上大脑"的如实说明', () => {
  const r = NagiPersona.reply('你好', { slot: '晚上' })
  assert.ok(r && typeof r.text === 'string' && r.text.length > 0)
  assert.ok(/接不上大脑/.test(r.text), `兜底应如实说明接不上大脑，实际：${r.text}`)
  // 不该像一句正常搭话（不应该是问候/闲聊口吻）
  assert.ok(!/^(你好|嗯|嗨)/.test(r.text.trim()), '兜底不该伪装成正常对话')
})

/* ---------------- C. 戳一戳不出声 ---------------- */

test('C 戳一戳恒不出声，只给动作与表情', () => {
  // 各种情境都要不出声：深夜、连戳、闹别扭
  const cases = [
    {},
    { count: 1 },
    { count: 3 },
    { count: 9 },
    { hour: 23 },
    { moodKey: 'pout' }
  ]
  for (const c of cases) {
    const r = NagiPersona.pickPokeReaction(c)
    assert.equal(r.text, null, `戳一戳不该出声（${JSON.stringify(c)}）`)
    assert.ok(r.expr, '表情仍要给')
    assert.ok(['poke', 'away'].includes(r.turn), '要给出转身动作')
  }
})

/* ---------------- D. 情绪枚举 ---------------- */

test('D 情绪枚举含三个存在主义层状态', () => {
  for (const e of ['liminal', 'tender', 'distant']) {
    assert.ok(EMOTIONS.includes(e), `EMOTIONS 应包含 ${e}`)
  }
  for (const e of ['calm', 'puzzled', 'smile', 'worry', 'pout', 'joy']) {
    assert.ok(EMOTIONS.includes(e), `原有情绪 ${e} 不能丢`)
  }
  assert.equal(EMOTIONS.length, 9)
})

test('D2 系统提示与输出契约都提到了这三个状态与无台词铁律', () => {
  assert.ok(/liminal/.test(NagiPersona.system), 'system 应说明宕机（liminal）')
  assert.ok(/无台词/.test(NagiPersona.system), 'system 应写明无台词铁律')
  for (const e of ['liminal', 'tender', 'distant']) {
    assert.ok(NagiPersona.outputContract.includes(e), `输出契约应列出 ${e}`)
  }
  assert.ok(
    /绝不(?:绑定|映射到)(?:任何)?固定台词/.test(NagiPersona.outputContract),
    '契约应声明情绪标签不映射台词'
  )
})

/* ---------------- E. 全仓扫描旧人设残留 ---------------- */

/** 递归列出文件（跳过 node_modules / out / .git / models 二进制资源） */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'out', '.git', 'dist', '.workbuddy'].includes(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|json|md|html|css)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释行后的内容（JS 的 // 与 /* *\/、以及行首 * 的块注释） */
function stripComments(text, file) {
  const isJs = /\.(js|mjs)$/.test(file)
  if (!isJs) return text
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

test('E 全仓无旧人设关键词残留', () => {
  // 旧人设《world.execute(me);》的标志性说法
  const stale = ['world.execute', '过于干净的音色', '出厂缓存', '三无', '优等生']
  // 只扫**受控的源码与对外文档**，不递归整个仓库根目录：
  // 别的主进程测试会在项目内创建临时目录（并发跑时命中过一次），
  // 那不在本次改动的范围内，扫进去只会让这条锁变得不稳定。
  const targets = [
    join(ROOT, 'src'),
    join(ROOT, 'models'),
    join(ROOT, 'README.md'),
    join(ROOT, 'docs')
  ]
  const files = targets.flatMap((t) => (statSync(t).isDirectory() ? walk(t) : [t]))
  const hits = []
  for (const f of files) {
    // 本测试文件自身含关键词（就是这份清单），跳过
    if (f.endsWith('persona-noscript.test.js')) continue
    // 变更历史类文档天然要引用旧名称才说得清"改了什么"，不参与扫描。
    // 真正不能残留的是代码与对外文档。
    if (f.endsWith('DECISIONS.md') || f.endsWith('TASKS.md')) continue
    const body = stripComments(readFileSync(f, 'utf8'), f)
    for (const kw of stale) {
      if (body.includes(kw)) hits.push(`${f.replace(ROOT, '')} → ${kw}`)
    }
  }
  assert.deepEqual(hits, [], `还有旧人设残留：\n${hits.join('\n')}`)
})

/* ---------------- F. 护栏措辞 ---------------- */

test('F 护栏不再逼她机械声明"我是 AI"，但仍禁止谎称是人', () => {
  const src = readFileSync(join(ROOT, 'src/core/agent/persona-guard.js'), 'utf8')
  assert.ok(!/明确你是数字助手/.test(src), '不该再要求机械声明"我是数字助手"')
  assert.ok(/不要宣称自己是人类/.test(src), '仍然必须禁止谎称是人')
  assert.ok(/诚实地表达对自身真实性的不确定/.test(src), '应允许诚实的不确定')
})
