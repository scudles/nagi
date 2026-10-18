// 不用外部密钥，验证 D9 的“DeepSeek provider → 本地代理 → 上游 SSE → 凪可见回复”路径。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let seen = 0
const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', (part) => chunks.push(part))
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(req.url, '/chat/completions')
      assert.equal(req.headers.authorization, 'Bearer d9-local-test')
      assert.equal(body.model, 'deepseek-flash')
      assert.equal(body.stream, true)
      assert.ok(body.messages.some((item) => item.role === 'user'))
      seen++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'd9-local', object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
      res.write(chunk({ role: 'assistant', content: '[calm]本机代理链路已接通。' }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message } }))
    }
  })
})

await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
const target = 'http://127.0.0.1:' + upstream.address().port
const env = { ...process.env, NAGI_D9_TEST_UPSTREAM: target }
delete env.NAGI_D9_API_KEY
let out = ''
let err = ''
const child = spawn(process.execPath, [resolve(import.meta.dirname, 'verify-d9.mjs')], {
  cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (part) => { out += String(part) })
child.stderr.on('data', (part) => { err += String(part) })
const timer = setTimeout(() => child.kill(), 90000)
try {
  const code = await new Promise((done, reject) => { child.on('close', done); child.on('error', reject) })
  assert.equal(code, 0, out + '\n' + err)
  assert.ok(seen >= 1, '上游至少收到一次请求')
  const report = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'docs', 'd9-proxy-selftest.json'), 'utf8'))
  assert.equal(report.mode, 'proxy-self-test')
  assert.equal(report.scenes.length, 1)
  assert.match(report.scenes[0].reply, /本机代理链路已接通/)
  console.log('D9 本机代理自检通过：' + seen + ' 次上游请求、1 条可见回复、隔离 profile 已清理')
} finally {
  clearTimeout(timer)
  await new Promise((done) => upstream.close(done))
}
