// test/policy.test.js
// 安全策略单测：风险分级、黑名单、目录边界、受控命令计划（S01 修复，2026-10-15）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getToolRisk,
  isCommandBlocked,
  isPathWithin,
  needsConfirm,
  planSafeCommand
} from '../src/core/safety/policy.js'
import { RISK } from '../src/shared/protocol.js'

test('工具风险分级', () => {
  assert.equal(getToolRisk('file_read'), RISK.LOW)
  assert.equal(getToolRisk('file_write'), RISK.MEDIUM)
  assert.equal(getToolRisk('run_command'), RISK.HIGH)
  assert.equal(getToolRisk('unknown_tool'), RISK.HIGH) // 未知按最高
})

test('危险命令黑名单', () => {
  assert.equal(isCommandBlocked('format C:'), true)
  assert.equal(isCommandBlocked('diskpart'), true)
  assert.equal(isCommandBlocked('REG DELETE HKLM\\Software'), true)
  assert.equal(isCommandBlocked('dir'), false)
})

test('目录边界', () => {
  assert.equal(isPathWithin('C:/work', 'C:/work/a.txt'), true)
  assert.equal(isPathWithin('C:/work', 'C:/work/sub/a.txt'), true)
  assert.equal(isPathWithin('C:/work', 'C:/work2/a.txt'), false)
  assert.equal(isPathWithin('C:/work', 'C:/Windows/system32'), false)
  assert.equal(isPathWithin('', 'C:/a'), false)
})

test('planSafeCommand：受控命令精确命中，返回固定 argv', () => {
  assert.deepEqual(planSafeCommand('dir'), { file: 'cmd.exe', args: ['/c', 'dir'] })
  assert.deepEqual(planSafeCommand('ipconfig'), { file: 'ipconfig', args: [] })
  assert.deepEqual(planSafeCommand('tasklist'), { file: 'tasklist', args: [] })
  assert.deepEqual(planSafeCommand('git status'), { file: 'git', args: ['status'] })
  assert.deepEqual(planSafeCommand('node -v'), { file: 'node', args: ['-v'] })
  assert.deepEqual(planSafeCommand('npm -v'), { file: 'npm', args: ['-v'] })
})

test('planSafeCommand：受限参数放行（大小写不敏感）', () => {
  assert.deepEqual(planSafeCommand('dir /a'), { file: 'cmd.exe', args: ['/c', 'dir', '/a'] })
  assert.deepEqual(planSafeCommand('DIR /A'), { file: 'cmd.exe', args: ['/c', 'dir', '/A'] })
  assert.deepEqual(planSafeCommand('ipconfig /all'), { file: 'ipconfig', args: ['/all'] })
  assert.deepEqual(planSafeCommand('git status --short'), { file: 'git', args: ['status', '--short'] })
})

test('planSafeCommand：元字符/引号/通配符/命令替换/换行一律拒绝', () => {
  const bad = [
    'dir & del x', // 连接符
    'dir "quoted arg"', // 引号
    'dir *', // 通配符
    'echo $(whoami)', // 命令替换
    'echo `whoami`', // 反引号替换
    'dir\ntype x', // 换行分隔
    'dir;whoami', // 分号
    'dir|findstr a', // 管道
    'dir > out.txt', // 重定向
    'dir < in.txt', // 输入重定向
    'echo %PATH%', // cmd 变量展开
    'echo ~', //  home 展开
    'echo !x!' // 延迟展开
  ]
  for (const cmd of bad) {
    assert.equal(planSafeCommand(cmd), null, `应拒绝：${JSON.stringify(cmd)}`)
  }
})

test('planSafeCommand：未知命令与不可指定的可执行文件一律拒绝', () => {
  const bad = [
    'del file.txt', // 不在受控表内
    'python x.py',
    'nodex', // 前缀不完整
    'node --version', // 模型不能换标志位
    'cmd /c dir', // 模型不能自选 shell 可执行文件
    'powershell -c dir',
    '',
    'dir C:/Windows',
    'dir ../',
    'where /r C:/Windows node'
  ]
  for (const cmd of bad) {
    assert.equal(planSafeCommand(cmd), null, `应拒绝：${JSON.stringify(cmd)}`)
  }
  // 受控命令 + 合法受限参数（含点号）放行
  assert.deepEqual(planSafeCommand('where /r . node'), { file: 'where', args: ['/r', '.', 'node'] })
})

test('needsConfirm：受控命令免确认并附带执行计划', () => {
  const r = needsConfirm({ name: 'run_command', args: { command: 'dir /a' } })
  assert.equal(r.confirm, false)
  assert.equal(r.blocked, false)
  assert.equal(r.risk, RISK.LOW)
  assert.deepEqual(r.safe, { file: 'cmd.exe', args: ['/c', 'dir', '/a'] })
})

test('needsConfirm：免确认绕过向量全部要求确认', () => {
  const bypass = [
    'echo ok & whoami', // 历史漏洞：前缀命中后追加命令
    'echo changed > victim.txt',
    'type x | findstr y',
    'git status; whoami',
    'echo a\nwhoami',
    'echo $(whoami)',
    'echo `whoami`',
    'del file.txt',
    'python x.py'
  ]
  for (const cmd of bypass) {
    const r = needsConfirm({ name: 'run_command', args: { command: cmd } })
    assert.equal(r.confirm, true, `应要求确认：${JSON.stringify(cmd)}`)
    assert.equal(r.blocked, false)
    assert.equal(r.risk, RISK.HIGH)
    assert.equal(r.safe, undefined, '确认路径不得携带 safe 计划')
  }
})

test('needsConfirm：有副作用或敏感读取逐次确认，旧开关不可绕过', () => {
  assert.equal(needsConfirm({ name: 'run_command', args: { command: 'del x' } }, { confirmHighRisk: false }).confirm, true)
  assert.equal(needsConfirm({ name: 'unknown_tool', args: {} }, { confirmHighRisk: false }).confirm, true)
  for (const name of ['file_write', 'home_set', 'browser_act', 'clipboard_read', 'screenshot', 'reminder_add', 'reminder_cancel']) {
    assert.equal(needsConfirm({ name, args: {} }, { confirmHighRisk: false }).confirm, true, name)
  }
  assert.equal(needsConfirm({ name: 'file_list', args: {} }).confirm, false)
})

test('needsConfirm：黑名单命令被拒', () => {
  const r = needsConfirm({ name: 'run_command', args: { command: 'format C:' } })
  assert.equal(r.blocked, true)
  assert.equal(r.confirm, true)
})

test('needsConfirm：allowedTools 限制仍然生效', () => {
  const r = needsConfirm({ name: 'file_write', args: {} }, { allowedTools: ['file_read'] })
  assert.equal(r.confirm, true)
  const r2 = needsConfirm({ name: 'file_read', args: {} }, { allowedTools: ['file_read'] })
  assert.equal(r2.confirm, false)
})
