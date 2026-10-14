#!/usr/bin/env node
// scripts/fetch-sample-model.mjs
// 拉取 Live2D 官方示例模型（免费）到 models/<Name>/，用于在拿到 Lisette 之前跑通渲染管线。
//
// 用法：
//   node scripts/fetch-sample-model.mjs            # 默认 Mao
//   node scripts/fetch-sample-model.mjs Hiyori
//   node scripts/fetch-sample-model.mjs Haru
//
// 说明：官方示例仓库 Live2D/CubismWebSamples 的二进制文件（.moc3/.png）在
// cdn.jsdelivr.net 上会被 301 重定向到 raw.githubusercontent.com（本机网络常不可达），
// 实测 gcore.jsdelivr.net 镜像可直接命中，故默认走 gcore，并保留多镜像回退。

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REPO = 'Live2D/CubismWebSamples@master'
const BASE_PATH = 'Samples/Resources'

const MIRRORS = [
  'https://gcore.jsdelivr.net/gh/' + REPO,
  'https://testingcf.jsdelivr.net/gh/' + REPO,
  'https://cdn.jsdelivr.net/gh/' + REPO
]

const MODELS = {
  Mao: [
    'Mao.model3.json', 'Mao.moc3', 'Mao.physics3.json', 'Mao.pose3.json', 'Mao.cdi3.json',
    'Mao.2048/texture_00.png',
    'expressions/exp_01.exp3.json', 'expressions/exp_02.exp3.json', 'expressions/exp_03.exp3.json',
    'expressions/exp_04.exp3.json', 'expressions/exp_05.exp3.json', 'expressions/exp_06.exp3.json',
    'expressions/exp_07.exp3.json', 'expressions/exp_08.exp3.json',
    'motions/mtn_01.motion3.json', 'motions/mtn_02.motion3.json', 'motions/mtn_03.motion3.json',
    'motions/mtn_04.motion3.json', 'motions/sample_01.motion3.json',
    'motions/special_01.motion3.json', 'motions/special_02.motion3.json', 'motions/special_03.motion3.json'
  ],
  Hiyori: [
    'Hiyori.model3.json', 'Hiyori.moc3', 'Hiyori.physics3.json', 'Hiyori.pose3.json',
    'Hiyori.cdi3.json', 'Hiyori.userdata3.json',
    'Hiyori.2048/texture_00.png', 'Hiyori.2048/texture_01.png',
    ...Array.from({ length: 10 }, (_, i) => `motions/Hiyori_m${String(i + 1).padStart(2, '0')}.motion3.json`)
  ],
  Haru: [
    'Haru.model3.json', 'Haru.moc3', 'Haru.physics3.json', 'Haru.pose3.json', 'Haru.cdi3.json',
    'Haru.2048/texture_00.png', 'Haru.2048/texture_01.png',
    ...Array.from({ length: 8 }, (_, i) => `expressions/F${String(i + 1).padStart(2, '0')}.exp3.json`)
  ]
}

async function fetchFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 32) throw new Error(`过小（${buf.length}B），可能是错误页`)
  // 若返回的是文本重定向提示，直接判失败
  if (buf.slice(0, 8).toString('latin1').startsWith('Moved')) {
    throw new Error('得到重定向文本而非文件，需换镜像')
  }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return buf.length
}

async function fetchWithMirrors(rel, dest) {
  let lastErr
  for (const m of MIRRORS) {
    try {
      const n = await fetchFile(`${m}/${BASE_PATH}/${rel}`, dest)
      return { ok: true, mirror: m, bytes: n }
    } catch (e) {
      lastErr = e
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown' }
}

async function main() {
  const name = process.argv[2] || 'Mao'
  const list = MODELS[name]
  if (!list) {
    console.error(`未知模型：${name}\n可选：${Object.keys(MODELS).join(' / ')}`)
    process.exit(1)
  }
  const dir = join(ROOT, 'models', name)
  console.log(`拉取官方示例模型 ${name} → ${dir}`)
  let okCount = 0
  for (const rel of list) {
    const dest = join(dir, rel)
    const r = await fetchWithMirrors(`${name}/${rel}`, dest)
    if (r.ok) {
      okCount++
    } else {
      console.error(`  ✘ ${rel}  （${r.error}）`)
    }
  }
  // 完整性自检：moc3 与贴图不能太小
  const required = list.filter((f) => /\.(moc3|png|model3\.json)$/.test(f))
  const missing = required.filter((f) => !existsSync(join(dir, f)) || statSync(join(dir, f)).size < 1024)
  console.log(`\n完成：${okCount}/${list.length} 个文件`)
  if (missing.length) {
    console.error('关键文件缺失或过小：', missing.join(', '))
    process.exit(1)
  }
  console.log('模型就绪。启动应用后会自动扫描到它。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
