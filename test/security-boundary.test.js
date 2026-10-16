import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFileTools, resolveRealWithin } from '../src/core/tools/files.js'
import { isTrustedIpcSource, sameRendererEntry } from '../src/core/safety/ipc-origin.js'

function testDirs(t) {
  const base = mkdtempSync(join(tmpdir(), 'nagi-boundary-'))
  const root = join(base, 'allowed')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  t.after(() => {
    if (resolve(base).startsWith(resolve(tmpdir()) + '\\')) rmSync(base, { recursive: true, force: true })
  })
  return { root, outside }
}

test('文件工具：真实路径内读写，词法越界拒绝', async (t) => {
  const { root, outside } = testDirs(t)
  const files = createFileTools({ fileRoot: root })
  await files.write({ path: 'sub/note.txt', content: '第一句' })
  await files.write({ path: 'sub/note.txt', content: '第二句', append: true })
  assert.equal(readFileSync(join(root, 'sub', 'note.txt'), 'utf8'), '第一句第二句')
  assert.equal((await files.read({ path: 'sub/note.txt' })).ok, true)
  await assert.rejects(files.write({ path: '../outside/escape.txt', content: 'x' }), /越界/)
  await assert.rejects(resolveRealWithin(root, join(outside, 'escape.txt')), /越界/)
})

test('文件工具：内部链接指向外部时读、写、列目录均拒绝', async (t) => {
  const { root, outside } = testDirs(t)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  try {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'), 'file')
    // 无符号链接权限的环境里 symlinkSync 可能不报错、而是静默建成普通文件
    // （2026-10-16 实测：Node 22 + 未提权 + 开发者模式关）。此时链接场景并未真正
    // 建立，必须跳过，而不是让后续断言假失败、把环境问题记成代码问题。
    if (!lstatSync(join(root, 'linked.txt')).isSymbolicLink()) {
      return t.skip('当前环境不能创建真实符号链接（创建被静默降级为普通文件）')
    }
    symlinkSync(outside, join(root, 'linked-dir'), 'junction')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前 Windows 权限不能创建测试链接')
    throw error
  }
  const files = createFileTools({ fileRoot: root })
  await assert.rejects(files.read({ path: 'linked.txt' }), /越界/)
  await assert.rejects(files.write({ path: 'linked.txt', content: 'changed' }), /越界/)
  await assert.rejects(files.write({ path: 'linked-dir/new.txt', content: 'changed' }), /越界/)
  await assert.rejects(files.list({ path: 'linked-dir' }), /越界/)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('文件工具：Windows 目录接合点单独验证越界', async (t) => {
  const { root, outside } = testDirs(t)
  try {
    symlinkSync(outside, join(root, 'linked-dir'), 'junction')
    // 同链接测试：创建被静默降级为普通目录时，越界场景并未真正建立
    if (!lstatSync(join(root, 'linked-dir')).isSymbolicLink()) {
      return t.skip('当前环境不能创建真实目录接合点（创建被静默降级为普通目录）')
    }
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('当前 Windows 权限不能创建目录接合点')
    throw error
  }
  const files = createFileTools({ fileRoot: root })
  await assert.rejects(files.write({ path: 'linked-dir/new.txt', content: 'changed' }), /越界/)
  await assert.rejects(files.list({ path: 'linked-dir' }), /越界/)
})

test('IPC：只接受注册窗口的顶层应用页，拒绝 iframe 与导航后的页面', () => {
  const entry = pathToFileURL(resolve('out/renderer/index.html')).toString()
  const source = { url: entry + '?mode=pet' }
  const sender = { mainFrame: source }
  const win = { isDestroyed: () => false }
  const options = { rendererEntry: entry, findWindow: (wc) => wc === sender ? win : null }
  assert.equal(sameRendererEntry(source.url, entry), true)
  assert.equal(isTrustedIpcSource({ sender, senderFrame: source }, options), true)
  assert.equal(isTrustedIpcSource({ sender, senderFrame: { url: entry } }, options), false)
  assert.equal(isTrustedIpcSource({ sender: { mainFrame: source }, senderFrame: source }, options), false)
  source.url = 'https://example.com/'
  assert.equal(isTrustedIpcSource({ sender, senderFrame: source }, options), false)
  assert.equal(sameRendererEntry('javascript:alert(1)', entry), false)
})
