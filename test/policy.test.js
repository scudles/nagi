import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getToolRisk,
  isCommandBlocked,
  isWhitelistedCommand,
  isPathWithin,
  needsConfirm,
  TOOL_RISK
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

test('只读命令白名单', () => {
  assert.equal(isWhitelistedCommand('dir'), true)
  assert.equal(isWhitelistedCommand('ipconfig /all'), true)
  assert.equal(isWhitelistedCommand('node -v'), true)
  assert.equal(isWhitelistedCommand('del file.txt'), false)
})

test('目录边界', () => {
  assert.equal(isPathWithin('C:/work', 'C:/work/a.txt'), true)
  assert.equal(isPathWithin('C:/work', 'C:/work/sub/a.txt'), true)
  assert.equal(isPathWithin('C:/work', 'C:/work2/a.txt'), false)
  assert.equal(isPathWithin('C:/work', 'C:/Windows/system32'), false)
  assert.equal(isPathWithin('', 'C:/a'), false)
})

test('needsConfirm：高危确认', () => {
  assert.equal(needsConfirm({ name: 'file_read', args: {} }).confirm, false)
  assert.equal(needsConfirm({ name: 'file_write', args: {} }).confirm, false)
  assert.equal(needsConfirm({ name: 'run_command', args: { command: 'del x' } }).confirm, true)
})

test('needsConfirm：黑名单命令被拒', () => {
  const r = needsConfirm({ name: 'run_command', args: { command: 'format C:' } })
  assert.equal(r.blocked, true)
})

test('needsConfirm：白名单命令免确认', () => {
  const r = needsConfirm({ name: 'run_command', args: { command: 'dir' } })
  assert.equal(r.confirm, false)
  assert.equal(r.risk, RISK.LOW)
})
