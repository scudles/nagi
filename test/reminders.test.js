// test/reminders.test.js
// 日程提醒纯逻辑单测：时间解析 / 到期判定 / 重复推进 / 排序 / 展示格式化。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWhen,
  normalizeItem,
  normalizeItems,
  isDue,
  advanceRepeat,
  sortItems,
  formatWhen,
  remainingText,
  describeItem,
  startOfDay,
  dayKey,
  REPEAT_LABEL,
  REMINDER_LIMIT
} from '../src/core/reminders/schedule.js'

const MIN = 60000
const HOUR = 3600000
const DAY = 86400000

/** 固定基准：2026-10-15 周四 10:00（本地时区） */
const BASE = new Date('2026-10-15T10:00:00').getTime()

const at = (s) => new Date(s).getTime()
const hm = (ts) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const ymd = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ================= 相对时间 ================= */

test('parseWhen：相对时间', () => {
  assert.equal(parseWhen('10分钟后', BASE).at, BASE + 10 * MIN)
  assert.equal(parseWhen('半小时后', BASE).at, BASE + 30 * MIN)
  assert.equal(parseWhen('2小时后', BASE).at, BASE + 2 * HOUR)
  assert.equal(parseWhen('1天后', BASE).at, BASE + DAY)
  assert.equal(parseWhen('30秒后', BASE).at, BASE + 30000)
  assert.equal(parseWhen('一会儿', BASE).at, BASE + 10 * MIN)
  assert.equal(parseWhen('in 5 minutes', BASE).at, BASE + 5 * MIN)
})

test('parseWhen：纯数字按秒/毫秒判别', () => {
  assert.equal(parseWhen(1791992741678, BASE).at, 1791992741678) // 13 位 = 毫秒
  assert.equal(parseWhen(1791992741, BASE).at, 1791992741000) // 10 位 = 秒
  assert.equal(parseWhen('1791992741678', BASE).at, 1791992741678)
})

/* ================= 绝对时间 ================= */

test('parseWhen：明天 / 后天 / 今天带时钟', () => {
  const r1 = parseWhen('明天9:00', BASE)
  assert.equal(ymd(r1.at), '2026-10-16')
  assert.equal(hm(r1.at), '09:00')

  const r2 = parseWhen('后天 14:30', BASE)
  assert.equal(ymd(r2.at), '2026-10-17')
  assert.equal(hm(r2.at), '14:30')
})

test('parseWhen：时段词（下午/晚上/凌晨/中午）', () => {
  const pm = parseWhen('下午3点半', BASE)
  assert.equal(ymd(pm.at), '2026-10-15')
  assert.equal(hm(pm.at), '15:30')

  const night = parseWhen('今晚8点', BASE)
  assert.equal(ymd(night.at), '2026-10-15')
  assert.equal(hm(night.at), '20:00')

  const noon = parseWhen('中午12点', BASE)
  assert.equal(hm(noon.at), '12:00')

  const noon2 = parseWhen('中午1点', BASE)
  assert.equal(hm(noon2.at), '13:00')
})

test('parseWhen：裸时钟已过则顺延到明天', () => {
  const r = parseWhen('9点', BASE) // BASE 是 10:00，今天 9 点已过
  assert.equal(ymd(r.at), '2026-10-16')
  assert.equal(hm(r.at), '09:00')

  const r2 = parseWhen('15:00', BASE) // 今天 15 点还没到
  assert.equal(ymd(r2.at), '2026-10-15')
  assert.equal(hm(r2.at), '15:00')
})

test('parseWhen：星期几（取下一次，今天该时刻已过则下周）', () => {
  const cur = new Date(BASE).getDay() // 4（周四）
  const nextDow = (cur + 2) % 7
  const cn = ['日', '一', '二', '三', '四', '五', '六'][nextDow]
  const r = parseWhen(`周${cn}10点`, BASE)
  const d = new Date(r.at)
  assert.equal(d.getDay(), nextDow)
  assert.equal(hm(r.at), '10:00')
  assert.ok(r.at > BASE + DAY, '应落在未来')

  // 今天同星期 + 已过时刻 → 下周
  const sameDayCn = ['日', '一', '二', '三', '四', '五', '六'][cur]
  const r2 = parseWhen(`周${sameDayCn}9点`, BASE) // 今天周四 9 点已过
  assert.equal(new Date(r2.at).getDay(), cur)
  assert.ok(r2.at - BASE > 6 * DAY, '应该是 6 天后（下周四）')
})

test('parseWhen：ISO 日期兜底', () => {
  const r = parseWhen('2026-10-20 09:00', BASE)
  assert.equal(ymd(r.at), '2026-10-20')
  assert.equal(hm(r.at), '09:00')
})

test('parseWhen：识别不了要报错，不瞎猜', () => {
  assert.ok(parseWhen('', BASE).error)
  assert.ok(parseWhen(null, BASE).error)
  assert.ok(parseWhen('随便什么时候', BASE).error)
})

/* ================= 规范化 / 判定 / 排序 ================= */

test('normalizeItem：非法条目被丢掉、字段被夹紧', () => {
  assert.equal(normalizeItem(null), null)
  assert.equal(normalizeItem({ text: '   ', at: BASE }), null)
  assert.equal(normalizeItem({ text: '喝水', at: NaN }), null)

  const it = normalizeItem({ text: '开会', at: BASE, repeat: '乱写', say: 123 })
  assert.equal(it.repeat, 'none')
  assert.equal(it.say, '123')
  assert.equal(it.doneAt, null)
})

test('isDue：到点且未完成才算', () => {
  const it = normalizeItem({ text: 'x', at: BASE })
  assert.equal(isDue(it, BASE - 1), false)
  assert.equal(isDue(it, BASE), true)
  assert.equal(isDue({ ...it, doneAt: BASE }, BASE + 1000), false)
})

test('advanceRepeat：每天 / 每周推进；不重复返回 null', () => {
  const daily = normalizeItem({ text: 'd', at: BASE, repeat: 'daily' })
  const next = advanceRepeat(daily, BASE + 1000)
  assert.equal(next.at, BASE + DAY)
  assert.equal(next.firedAt, BASE + 1000)

  // 错过多次只推到下一次，不补偿
  const catchUp = advanceRepeat(daily, BASE + 3.5 * DAY)
  assert.ok(catchUp.at > BASE + 3.5 * DAY)
  assert.ok(catchUp.at - (BASE + 3.5 * DAY) < DAY)

  const weekly = normalizeItem({ text: 'w', at: BASE, repeat: 'weekly' })
  assert.equal(advanceRepeat(weekly, BASE).at, BASE + 7 * DAY)

  const none = normalizeItem({ text: 'n', at: BASE })
  assert.equal(advanceRepeat(none, BASE), null)
})

test('sortItems：未完成在前，按时间升序', () => {
  const a = normalizeItem({ id: 'a', text: 'a', at: BASE + 3 * HOUR })
  const b = normalizeItem({ id: 'b', text: 'b', at: BASE + 1 * HOUR })
  const c = normalizeItem({ id: 'c', text: 'c', at: BASE, doneAt: BASE })
  const out = sortItems([a, c, b])
  assert.deepEqual(out.map((x) => x.id), ['b', 'a', 'c'])
})

/* ================= 展示 ================= */

test('formatWhen：今天 / 明天 / 更远', () => {
  assert.equal(formatWhen(BASE + 5 * HOUR, BASE), '今天 15:00')
  assert.equal(formatWhen(BASE + DAY + 3 * HOUR, BASE), '明天 13:00')
  assert.equal(formatWhen(at('2026-10-20T09:00:00'), BASE), '10月20日 09:00')
  assert.equal(formatWhen(at('2027-01-02T09:00:00'), BASE), '2027-01-02 09:00')
})

test('remainingText：还有 / 已过', () => {
  assert.equal(remainingText(BASE + 30 * 1000, BASE), '还有 30 秒')
  assert.equal(remainingText(BASE + 12 * MIN, BASE), '还有 12 分钟')
  assert.equal(remainingText(BASE + 3 * HOUR, BASE), '还有 3 小时')
  assert.equal(remainingText(BASE - 2 * MIN, BASE), '已过 2 分钟')
})

test('describeItem：一行带重复标注', () => {
  const it = normalizeItem({ text: '吃维生素', at: BASE + HOUR, repeat: 'daily' })
  assert.equal(describeItem(it, BASE), `今天 11:00（${REPEAT_LABEL.daily}） 吃维生素`)
})

/* ================= 辅助 ================= */

test('startOfDay / dayKey 与本地日一致', () => {
  const s = startOfDay(BASE)
  assert.equal(new Date(s).getHours(), 0)
  assert.equal(dayKey(BASE), '2026-10-15')
  assert.ok(BASE - s < DAY)
})

test('normalizeItems：混合列表被清洗并排序', () => {
  const out = normalizeItems([null, { text: 'a', at: BASE + HOUR }, { text: '', at: BASE }, { text: 'z', at: BASE }])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((x) => x.text), ['z', 'a'])
})

test('常量：上限与重复档位存在', () => {
  assert.ok(REMINDER_LIMIT > 0)
  assert.deepEqual(Object.keys(REPEAT_LABEL), ['none', 'daily', 'weekly'])
})
