import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_PROCESSES, appDisplayName, cleanBrowserTitle, foregroundContext, isBrowser, videoSiteOf
} from '../src/core/signals/foreground.js'

const NOW = 1_700_000_000_000

test('浏览器窗口标题清洗：去掉「和另外 N 个页面」与浏览器名尾巴', () => {
  // 用户实测原样（2026-10-18）：Edge 的窗口标题长这样
  assert.equal(
    cleanBrowserTitle('三分相似，我便慌了神_哔哩哔哩_bilibili 和另外 9 个页面 - 个人 - Microsoft Edge'),
    '三分相似，我便慌了神_哔哩哔哩_bilibili'
  )
  // 真机原样里「Microsoft」和「Edge」之间夹着一个零宽字符 U+200B，
  // 不剥掉会让「- 个人 - Microsoft Edge」尾巴匹配失败（2026-10-18 实测踩到）
  assert.equal(
    cleanBrowserTitle('降世神通：科拉传奇（第一季/中英双字）_哔哩哔哩_bilibili 和另外 8 个页面 - 个人 - Microsoft\u200b Edge'),
    '降世神通：科拉传奇（第一季/中英双字）_哔哩哔哩_bilibili'
  )
  assert.equal(cleanBrowserTitle('某页面 - Chrome'), '某页面')
  assert.equal(cleanBrowserTitle('某页面 - 工作 - Google Chrome'), '某页面')
  assert.equal(cleanBrowserTitle('某页面\u200b'), '某页面', '零宽字符不能留在标题里')
  assert.equal(cleanBrowserTitle('没有尾巴的标题'), '没有尾巴的标题')
  assert.equal(cleanBrowserTitle(''), '')
  assert.equal(cleanBrowserTitle(null), '')
})

test('视频站识别：只做措辞提示，不参与播放状态判断', () => {
  assert.equal(videoSiteOf('三分相似，我便慌了神_哔哩哔哩_bilibili'), '哔哩哔哩')
  assert.equal(videoSiteOf('某视频 - YouTube'), 'YouTube')
  assert.equal(videoSiteOf('某电影 - 爱奇艺'), '爱奇艺')
  assert.equal(videoSiteOf('一篇技术博客'), '', '普通网页不该被认成视频站')
  assert.equal(videoSiteOf(''), '')
})

test('浏览器判定与展示名：大小写不敏感', () => {
  assert.ok(isBrowser('msedge'))
  assert.ok(isBrowser('MSEdge'))
  assert.ok(isBrowser('Chrome'))
  assert.ok(!isBrowser('cloudmusic'))
  assert.ok(!isBrowser(''))
  assert.equal(appDisplayName('msedge'), 'Edge')
  assert.equal(appDisplayName('MSEdge'), 'Edge')
  assert.equal(appDisplayName('Code'), 'Code')
  assert.ok(BROWSER_PROCESSES.length > 0)
})

test('前台上下文：浏览器视频页 → 说出页面标题，并明确不断言播放状态', () => {
  const lines = foregroundContext({
    app: 'msedge',
    title: '三分相似，我便慌了神_哔哩哔哩_bilibili 和另外 9 个页面 - 个人 - Microsoft Edge',
    ts: NOW
  }, NOW + 1000)
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.match(line, /Edge/)
  assert.match(line, /三分相似，我便慌了神/, '必须说出用户在看的那一页')
  assert.match(line, /哔哩哔哩/, '要标出视频站')
  assert.match(line, /不能证明视频正在播放还是已暂停/, '播放状态必须保持不确定')
  assert.match(line, /要么问他/, '要引导去问而不是自己猜')
  assert.doesNotMatch(line, /和另外 9 个页面/, '计数尾巴不能塞给模型')
})

test('前台上下文：非浏览器应用照样说她能用的话', () => {
  const lines = foregroundContext({ app: 'Code', title: 'music.js - nagi', ts: NOW }, NOW + 1000)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Code/)
  assert.match(lines[0], /music\.js - nagi/)
  assert.match(lines[0], /不能据此推断他在想什么/)
})

test('前台上下文：无标题 / 过期 / 缺失 / 空应用名都安全降级', () => {
  // 无标题仍可以说出应用名
  const noTitle = foregroundContext({ app: 'cloudmusic', title: '', ts: NOW }, NOW + 1000)
  assert.match(noTitle[0], /网易云音乐|cloudmusic/)
  assert.match(noTitle[0], /窗口没有标题/)
  // 过期（>15 秒）不报，避免卡在最后一个窗口上不放
  assert.deepEqual(foregroundContext({ app: 'Code', title: 'x', ts: NOW }, NOW + 20000), [])
  // 缺失 / 脏数据不抛错
  assert.deepEqual(foregroundContext(null, NOW), [])
  assert.deepEqual(foregroundContext(undefined, NOW), [])
  assert.deepEqual(foregroundContext({}, NOW), [])
  assert.deepEqual(foregroundContext({ app: '', title: 'x', ts: NOW }, NOW), [])
  assert.deepEqual(foregroundContext({ app: 'Code', title: 'x', ts: 'bad' }, NOW), [])
  // 时间戳缺失（NaN）不能算「新鲜」
  assert.deepEqual(foregroundContext({ app: 'Code', title: 'x' }, NOW), [])
})

test('前台上下文：用户离开很久时只说「人不在」，不拿最后窗口当「正在看」', () => {
  const lines = foregroundContext({ app: 'msedge', title: '某视频', ts: NOW, idleSec: 600 }, NOW + 1000)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /已经离开/)
  assert.match(lines[0], /10 分钟/, '要说清离开了多久')
  assert.doesNotMatch(lines[0], /不能证明视频/, '人不在时不必再谈播放状态')
})

test('前台上下文：空闲但在阈值内仍按「正在用」处理', () => {
  const lines = foregroundContext({ app: 'msedge', title: '某视频', ts: NOW, idleSec: 30 }, NOW + 1000)
  assert.match(lines[0], /前台应用是 Edge/)
  assert.doesNotMatch(lines[0], /已经离开/)
})