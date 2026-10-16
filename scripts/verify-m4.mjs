// scripts/verify-m4.mjs
// M4 无头验证：日程提醒全链路（建 → 到点 → 她主动开口 + 情绪 + 日记 + 落盘标记）
//             + 重复提醒推进 + 错过太久保留未送达证据 + 未到期不动。
// 走生产同款代码路径（真实 electron 进程 + 隔离 userData），不依赖 CDP。
//
// 用法：node scripts/verify-m4.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const stamp = Date.now()
const results = []
const tempDirs = []

const HOUR = 3600000
const DAY = 86400000

function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '：' + detail : ''}`)
}

/** 干净的子进程环境：必须剔掉 ELECTRON_RUN_AS_NODE，否则 electron 会当 node 跑 */
function baseEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return Object.assign(env, extra)
}

function newUserData(tag) {
  const p = join(tmpdir(), `nagi-m4-${tag}-${stamp}`)
  mkdirSync(p, { recursive: true })
  tempDirs.push(p)
  // 不配置 API Key → 走本地占位大脑；监测关掉，正常提醒允许送达。
  writeFileSync(
    join(p, 'settings.json'),
    JSON.stringify(
      { llm: { provider: 'custom', model: 'x' }, privacy: { noticeShown: true, monitorEnabled: false, doNotDisturb: false } },
      null,
      2
    ),
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

const remindersFile = (ud) => join(ud, 'reminders.json')
const diaryDir = (ud) => join(ud, 'monologue')

const logLine = (out, re) => {
  const m = out.split(/\r?\n/).find((l) => re.test(l))
  return m ? m.trim() : null
}
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const readDiary = (ud) => {
  const dir = diaryDir(ud)
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((f) => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}
const findItem = (ud, id) => {
  const data = readJson(remindersFile(ud))
  return data?.items?.find((x) => x.id === id) || null
}

/* ---------- 1. 全链路：自测提醒 3 秒后到期 ---------- */

console.log('=== 1. 全链路：到点 → 她主动开口 + 情绪 + 日记 + 落盘 ===')
{
  const ud = newUserData('loop')
  // NAGI_SELFTEST_REMINDER=1：调度器提速到 1.2 秒一轮，并塞一条 3 秒后到期的提醒
  const out = await runApp(ud, 10000, { NAGI_SELFTEST_REMINDER: '1' })

  check('调度器已启动', !!logLine(out, /\[reminder\] 日程提醒已启动/), logLine(out, /\[reminder\] 日程提醒已启动/) || '（没打出启动日志）')
  check('自测提醒已登记', !!logLine(out, /\[reminder\] 已塞入自测提醒/), logLine(out, /\[reminder\] 已塞入自测提醒/) || '（没塞入）')
  check('到点触发主动开口', !!logLine(out, /\[reminder\] 已送达：\[自测\]/), logLine(out, /\[reminder\] 已送达：/) || '（没有送达日志）')

  const moodLine = logLine(out, /\[mood\] → smile/)
  check('到点推了情绪（smile）', !!moodLine, moodLine || '（没打出情绪日志）')
  check('情绪来源标注为 reminder', !!moodLine && /\(reminder\)/.test(moodLine), moodLine && /\(reminder\)/.test(moodLine) ? '来源正确' : `实际：${moodLine || '无'}`)

  const it = findItem(ud, 'selftest')
  check(
    '一次性提醒触发后标记完成（firedAt + doneAt）',
    !!it && it.firedAt > 0 && it.doneAt > 0,
    it ? `firedAt=${!!it.firedAt} doneAt=${!!it.doneAt}` : '（reminders.json 里找不到自测条目）'
  )

  const diary = readDiary(ud)
  check('日记落盘且含提醒内容', /该起来喝口水了/.test(diary), /该起来喝口水了/.test(diary) ? '日记命中' : '（日记里没有提醒内容）')
  check('日记带上了当时情绪', /微笑|开心/.test(diary), /微笑|开心/.test(diary) ? '情绪已记录' : '（日记无情绪标注）')
}

/* ---------- 2. 重复推进 + 错过作废 + 未到期不动 ---------- */

console.log('\n=== 2. 重复推进 / 错过作废 / 未到期不动 ===')
{
  const ud = newUserData('repeat')
  const now = Date.now()
  writeFileSync(
    remindersFile(ud),
    JSON.stringify(
      {
        version: 1,
        items: [
          // 每天的重复提醒，上次该响的时间已经过去 25 小时 → 应触发并推进到下一天往后的时刻
          { id: 'daily1', text: '每天喝水', at: now - 25 * HOUR, repeat: 'daily', createdAt: now - 30 * HOUR, firedAt: null, doneAt: null },
          // 一次性提醒，已错过 13 小时（> 12 小时）→ 留“未送达”，不冒充完成
          { id: 'stale1', text: '很久以前的事', at: now - 13 * HOUR, repeat: 'none', createdAt: now - 14 * HOUR, firedAt: null, doneAt: null },
          // 未来 20 小时才到期 → 不该被碰
          { id: 'future1', text: '明天的事', at: now + 20 * HOUR, repeat: 'none', createdAt: now, firedAt: null, doneAt: null }
        ]
      },
      null,
      2
    ),
    'utf8'
  )

  const out = await runApp(ud, 9000, { NAGI_SELFTEST_REMINDER: '1' })

  check('重复提醒到点触发', !!logLine(out, /\[reminder\] 已送达：每天喝水/), logLine(out, /已送达：每天喝水/) || '（没触发）')
  const daily = findItem(ud, 'daily1')
  const advanced = !!daily && daily.at > now && !daily.doneAt && daily.firedAt > 0 && (daily.at - (now - 25 * HOUR)) % DAY === 0
  check(
    '重复提醒推进到下一次（未完成、整日步进）',
    advanced,
    daily ? `at 前移 ${Math.round((daily.at - (now - 25 * HOUR)) / HOUR)}h、doneAt=${!!daily.doneAt}` : '（条目丢失）'
  )

  const staleLog = logLine(out, /\[reminder\] 未送达且已过时：很久以前的事/)
  const stale = findItem(ud, 'stale1')
  check('错过太久的一次性提醒标为未送达', !!staleLog && !!stale && stale.missedAt > 0 && !stale.doneAt && !stale.firedAt, stale ? `missedAt=${!!stale.missedAt} doneAt=${!!stale.doneAt}` : '（条目丢失）')
  check('未送达的提醒没有打扰用户', !/已送达：很久以前的事/.test(out), /已送达：很久以前的事/.test(out) ? '不该触发却触发了' : '未触发，正确')

  const future = findItem(ud, 'future1')
  check('未到期的提醒保持原样', !!future && !future.firedAt && !future.doneAt && future.at === now + 20 * HOUR, future ? `at 未变、未触发` : '（条目丢失）')

  const diary = readDiary(ud)
  check('只有真正到点的事进了日记', /每天喝水/.test(diary) && !/很久以前的事/.test(diary), /每天喝水/.test(diary) ? '命中且排除了作废项' : '（日记内容不符）')
}

/* ---------- 3. 勿扰优先：不能标记送达，解除后跨重启补送 ---------- */

console.log('\n=== 3. 勿扰优先与跨重启补送 ===')
{
  const ud = newUserData('dnd')
  const settingsFile = join(ud, 'settings.json')
  const settings = readJson(settingsFile)
  settings.privacy.doNotDisturb = true
  writeFileSync(settingsFile, JSON.stringify(settings), 'utf8')
  const muted = await runApp(ud, 7000, { NAGI_SELFTEST_REMINDER: '1' })
  const pending = findItem(ud, 'selftest')
  check('勿扰下提醒不宣称送达或完成', !!pending && !pending.firedAt && !pending.doneAt &&
    !/\[reminder\] 已送达：\[自测\]/.test(muted))
  settings.privacy.doNotDisturb = false
  writeFileSync(settingsFile, JSON.stringify(settings), 'utf8')
  const resumed = await runApp(ud, 7000, { NAGI_SELFTEST_REMINDER: '1', NAGI_SELFTEST_REMINDER_SEED: '0' })
  const delivered = findItem(ud, 'selftest')
  check('解除勿扰后跨重启补送且有落盘证据', !!delivered && delivered.firedAt > 0 && delivered.doneAt > 0 &&
    /\[reminder\] 已送达：\[自测\]/.test(resumed))
}

/* ---------- 清理与汇总 ---------- */

for (const d of tempDirs) {
  try {
    if (!resolve(d).startsWith(resolve(tmpdir()) + sep) || !basename(d).startsWith('nagi-m4-')) continue
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* %TEMP% 下偶尔删不掉，留着无妨 */
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
