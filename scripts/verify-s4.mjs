// scripts/verify-s4.mjs
// S4 无头验证：情绪跨重启延续（含离线衰减）+ 情绪时间线落盘 + 关系统计累加 + 保留策略。
// 走生产同款代码路径（真实 electron 进程 + 隔离 userData），不依赖 CDP。
//
// 用法：node scripts/verify-s4.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const stamp = Date.now()
const results = []
const tempDirs = []

function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

/** 干净的子进程环境：必须剔掉 ELECTRON_RUN_AS_NODE，否则 electron 会当 node 跑 */
function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return Object.assign(env, { NAGI_FAKE_LLM: '1' }, extra)
}

function newUserData(tag) {
  const p = join(tmpdir(), `nagi-s4-${tag}-${stamp}`)
  mkdirSync(p, { recursive: true })
  tempDirs.push(p)
  // 不配置 API Key → 走本地占位大脑；监测关掉，避免噪声
  writeFileSync(
    join(p, 'settings.json'),
    JSON.stringify({ llm: { provider: 'custom', model: 'x' }, privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: true } }, null, 2),
    'utf8'
  )
  return p
}

/** 起一个实例跑 ms 毫秒收集 stdout，然后连同子进程一起杀掉 */
function runApp(userData, ms, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`], {
      cwd: ROOT,
      env: baseEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    setTimeout(async () => {
      await new Promise((r) => {
        const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        k.on('close', r)
        k.on('error', r)
      })
      setTimeout(() => done(out), 1200)
    }, ms)
  })
}

const moodFile = (ud) => join(ud, 'mood.json')
const relationFile = (ud) => join(ud, 'relation.json')
const timelineDir = (ud) => join(ud, 'timeline')

/** 造一份"上次退出时"的情绪状态 */
function seedMood(ud, { mood, intensity, agoMs }) {
  const now = Date.now()
  writeFileSync(
    moodFile(ud),
    JSON.stringify(
      {
        version: 1,
        mood,
        intensity,
        lastInteraction: now - agoMs,
        lastIdlePush: 0,
        nightWorried: false,
        lastBurstPush: 0,
        chatTimes: [],
        savedAt: now - agoMs
      },
      null,
      2
    ),
    'utf8'
  )
}

const logLine = (out, re) => {
  const m = out.split(/\r?\n/).find((l) => re.test(l))
  return m ? m.trim() : null
}
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)

/* ---------- 1. 短离线（40 秒）：情绪延续并衰减两步 ---------- */

console.log('=== 1. 短离线：情绪延续 + 衰减 ===')
{
  const ud = newUserData('short')
  seedMood(ud, { mood: 'pout', intensity: 0.8, agoMs: 40000 })
  const out = await runApp(ud, 12000)
  // 40s / 15s ≈ 2 步，每步 -0.09 → 0.80 - 0.18 = 0.62
  const line = logLine(out, /已延续上次心情/)
  check('情绪延续并按离线时长衰减（0.80 → 0.62）', !!line && /闹别扭/.test(line) && /62%/.test(line), line || '（没打出恢复日志）')
  check('首次运行建立关系统计并落盘', existsSync(relationFile(ud)), existsSync(relationFile(ud)) ? 'relation.json 已生成' : '缺少 relation.json')
  const rel = logLine(out, /\[relation\]/)
  check('关系统计日志：初次见面', !!rel && /初次见面/.test(rel), rel || '（无）')
}

/* ---------- 2. 长离线（3 小时）：回来应回平静 ---------- */

console.log('\n=== 2. 长离线：情绪归零 ===')
{
  const ud = newUserData('long')
  seedMood(ud, { mood: 'pout', intensity: 0.9, agoMs: 3 * 3600 * 1000 })
  const out = await runApp(ud, 12000)
  const line = logLine(out, /已延续上次心情/)
  check('不会挂着几小时前的闹别扭，回平静', !!line && /平静/.test(line) && /0%/.test(line), line || '（没打出恢复日志）')
}

/* ---------- 3. 完整回路：聊天 → 情绪落盘 + 时间线采样 → 重启延续 ---------- */

console.log('\n=== 3. 完整回路：聊天 → 落盘 → 重启延续 ===')
{
  const ud = newUserData('loop')
  // NAGI_SELFTEST=1 让工作台渲染层自动发一条消息；假大脑末轮情绪标签为 [smile]
  const out = await runApp(ud, 26000, { NAGI_SELFTEST: '1', NAGI_FAKE_LLM: '1' })
  const saved = readJson(moodFile(ud))
  check(
    '对话后情绪已落盘',
    !!saved && saved.mood === 'smile' && saved.intensity > 0,
    saved ? `mood=${saved.mood} intensity=${Number(saved.intensity).toFixed(2)}` : '没有 mood.json'
  )

  const dir = timelineDir(ud)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : []
  const day = files.length ? readJson(join(dir, files[0])) : null
  check(
    '情绪时间线有采样点',
    !!day && Array.isArray(day.points) && day.points.length > 0,
    day ? `${files[0]} 共 ${day.points.length} 点，最后为 ${day.points[day.points.length - 1].mood}` : '没有时间线文件'
  )

  const out2 = await runApp(ud, 12000)
  const line = logLine(out2, /已延续上次心情/)
  check('重启后情绪延续', !!line && /微笑|开心/.test(line), line || '（没打出恢复日志）')

  const rel = readJson(relationFile(ud))
  check('关系统计累加互动次数', !!rel && rel.interactionCount >= 1, rel ? `互动 ${rel.interactionCount} 次、活跃 ${rel.activeDays.length} 天` : '没有 relation.json')

  // 保留策略：塞过期文件，重启应清掉
  for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) {
    writeFileSync(join(dir, `${d}.json`), JSON.stringify({ version: 1, date: d, points: [] }), 'utf8')
  }
  await runApp(ud, 12000)
  const left = readdirSync(dir).filter((f) => f.startsWith('2020-'))
  check('过期时间线被清理（保留 30 天）', left.length === 0, left.length ? `残留 ${left.join(',')}` : '已清空')
}

/* ---------- 清理与汇总 ---------- */

for (const d of tempDirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* %TEMP% 下偶尔删不掉，留着无妨 */
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
