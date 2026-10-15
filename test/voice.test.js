// test/voice.test.js
// 语音纯逻辑单测：分句缓冲 / 朗读文本清洗 / 口型时间轴 / WAV 编解码 / 引擎注册表与降级链。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSegmenter, splitSentences, toSpeechText } from '../src/core/voice/segmenter.js'
import { createLipTrack, estimateUnits } from '../src/core/voice/lip.js'
import {
  encodeWav,
  readWavHeader,
  extractPcm,
  resample,
  trimSilence,
  rms,
  peak,
  pcmDurationMs
} from '../src/core/voice/wav.js'
import { DEFAULT_VOICE_SETTINGS, mergeVoiceSettings } from '../src/shared/voice-protocol.js'
import { secMsGec, buildSsml } from '../src/main/voice/edge.js'
import {
  buildSherpaFrame,
  readSherpaHeader,
  parseSherpaReply,
  SHERPA_HEADER_BYTES
} from '../src/core/voice/sherpa-frame.js'
import {
  TTS_ENGINES,
  ASR_ENGINES,
  TTS_FALLBACK,
  ASR_FALLBACK,
  EDGE_VOICES,
  NAGI_VOICE,
  MOOD_SPEECH,
  mergeVoiceParams,
  pickEngine,
  noEngineAvailable
} from '../src/core/voice/engines.js'

/* ---------------- 分句 ---------------- */

test('splitSentences：两句都够长就各成一段', () => {
  assert.deepEqual(splitSentences('你好，我是凪。今天天气不错。'), ['你好，我是凪。', '今天天气不错。'])
})

test('splitSentences：minChars 保护——太短的碎句并进下一句', () => {
  // 「嗯。」只有 2 字，默认不单独成句，会与后文合并
  const out = splitSentences('嗯。后面还有很长的一句话。')
  assert.equal(out.length, 1)
  assert.equal(out[0], '嗯。后面还有很长的一句话。')
})

test('splitSentences：minChars 可调小，碎句就能独立', () => {
  assert.deepEqual(splitSentences('嗯。好。', { minChars: 1 }), ['嗯。', '好。'])
})

test('splitSentences：超长无句号 → 在软标点处按 maxChars 断开', () => {
  const text = '第一段内容比较长，第二段内容也不短，第三段同样很长。'
  const out = splitSentences(text, { minChars: 6, maxChars: 10 })
  assert.ok(out.length >= 3, `应切成多段，实际 ${out.length} 段`)
  for (const s of out) assert.ok(s.length <= 12, `分段不该太长：${s}`)
  assert.equal(out.join(''), text, '切分不该丢字')
})

test('splitSentences：句末收尾符跟着上一句走', () => {
  assert.deepEqual(splitSentences('「不是帮你。」这句话她说过很多次了。'), [
    '「不是帮你。」',
    '这句话她说过很多次了。'
  ])
})

test('createSegmenter：流式喂 token，句子一成形就吐出', () => {
  const seg = createSegmenter({ minChars: 6, maxChars: 60 })
  const got = []
  for (const t of ['你好', '，我', '是凪', '。今', '天天气', '很好', '。']) {
    got.push(...seg.push(t))
  }
  assert.deepEqual(got, ['你好，我是凪。', '今天天气很好。'])
})

test('createSegmenter：flush 吐出最后残留，且只能吐一次', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('只有半句'), [])
  assert.equal(seg.pending, '只有半句')
  assert.equal(seg.flush(), '只有半句')
  assert.equal(seg.flush(), null, 'flush 后不该再吐同一段')
})

test('createSegmenter：一次 push 里含多句就一次吐多句', () => {
  const seg = createSegmenter({ minChars: 6 })
  assert.deepEqual(seg.push('第一句够长了。第二句也够长了。'), ['第一句够长了。', '第二句也够长了。'])
})

/* ---------------- 朗读文本清洗 ---------------- */

test('toSpeechText：剥掉行首情绪标签', () => {
  assert.equal(toSpeechText('[smile] 你好。'), '你好。')
})

test('toSpeechText：代码块与行内代码不该被念出来', () => {
  assert.equal(toSpeechText('看这个 ```js\nconst a = 1\n``` 就行'), '看这个 就行')
  assert.equal(toSpeechText('用 `npm test` 跑'), '用 npm test 跑')
})

test('toSpeechText：链接只念文字，裸 URL 不念', () => {
  assert.equal(toSpeechText('[文档](https://a.b/c) 在这里'), '文档 在这里')
  assert.equal(toSpeechText('见 https://a.b/c 详情'), '见 详情')
})

test('toSpeechText：Markdown 强调符与标题/列表符都去掉', () => {
  assert.equal(toSpeechText('**重点**内容'), '重点内容')
  assert.equal(toSpeechText('## 标题'), '标题')
  assert.equal(toSpeechText('- 一条\n- 两条'), '一条\n两条')
})

/* ---------------- 口型时间轴 ---------------- */

test('estimateUnits：中文按字、英文按字符折半、空串至少 1', () => {
  assert.equal(estimateUnits('你好世界'), 4)
  assert.equal(estimateUnits(''), 1)
  assert.equal(estimateUnits('hello world'), 6)
})

test('createLipTrack：边界（负时间 / 超时长）都闭嘴', () => {
  const tr = createLipTrack({ text: '你好世界', durationMs: 1000 })
  assert.equal(tr.at(-5), 0)
  assert.equal(tr.at(0), 0)
  assert.equal(tr.at(1000), 0)
  assert.equal(tr.at(5000), 0)
})

test('createLipTrack：音节中点张口到峰值，音节末有闭嘴缝', () => {
  const tr = createLipTrack({ text: '你好世界', durationMs: 1000 })
  assert.equal(tr.units, 4)
  assert.equal(tr.slotMs, 250)
  const peak = tr.at(102.5) // 第 0 音节的正中
  assert.ok(peak >= 0.5 && peak <= 1, `峰值应在 0.5~1，实际 ${peak}`)
  assert.ok(tr.at(240) === 0, '音节末尾应闭嘴（留白）')
  assert.ok(tr.at(300) > 0, '进入下一音节后应重新张口')
})

test('createLipTrack：同 seed 结果完全可复现，异 seed 会不同', () => {
  const a = createLipTrack({ text: '你好世界啊', durationMs: 900, seed: 7 })
  const b = createLipTrack({ text: '你好世界啊', durationMs: 900, seed: 7 })
  const c = createLipTrack({ text: '你好世界啊', durationMs: 900, seed: 8 })
  const ts = [10, 60, 130, 260, 400, 700]
  assert.deepEqual(a.sample(ts), b.sample(ts), '同 seed 必须一致')
  assert.notDeepEqual(a.sample(ts), c.sample(ts), '异 seed 应给出不同口型曲线')
})

test('createLipTrack：时长很短时受 minSlotMs 约束，不会抽风式连张', () => {
  const tr = createLipTrack({ text: '一二三四五六七八九十', durationMs: 300 })
  assert.equal(tr.units, 2, '300ms 最多 2 个音节（minSlotMs=110）')
})

test('createLipTrack：零时长退化成单音节且恒为闭嘴', () => {
  const tr = createLipTrack({ text: '你好', durationMs: 0 })
  assert.equal(tr.units, 1)
  assert.equal(tr.at(0), 0)
  assert.equal(tr.at(100), 0)
})

/* ---------------- 引擎注册表 ---------------- */

test('引擎表与降级链一一对应，没有悬空 id', () => {
  for (const id of TTS_FALLBACK) assert.ok(TTS_ENGINES[id], `TTS 降级链里的 ${id} 必须在表里`)
  for (const id of ASR_FALLBACK) assert.ok(ASR_ENGINES[id], `ASR 降级链里的 ${id} 必须在表里`)
  for (const id of Object.keys(TTS_ENGINES)) assert.ok(TTS_FALLBACK.includes(id), `TTS 表里的 ${id} 应出现在降级链里`)
  for (const id of Object.keys(ASR_ENGINES)) assert.ok(ASR_FALLBACK.includes(id), `ASR 表里的 ${id} 应出现在降级链里`)
})

test('pickEngine：尊重用户偏好，不可用时沿降级链走', () => {
  assert.equal(pickEngine('tts', 'sapi'), 'sapi')
  assert.equal(pickEngine('tts', 'edge'), 'edge')
  assert.equal(pickEngine('tts', 'edge', { edge: false }), 'sapi', 'edge 不可用应回退本机')
  assert.equal(pickEngine('tts', 'nope'), 'edge', '没见过的 id 应落回降级链首位')
  assert.equal(pickEngine('tts', 'sapi', { sapi: false }), 'edge', '偏好不可用就沿链回退')
  assert.equal(pickEngine('tts', 'gptsovits', { edge: false, sapi: false }), 'gptsovits', '偏好可用就直接用')
  assert.equal(pickEngine('asr', 'sherpa'), 'sherpa')
  assert.equal(pickEngine('asr', 'sherpa', { sherpa: false }), 'sapi', '离线模型没装就该落到本机识别')
  assert.equal(pickEngine('asr', 'sapi', { sherpa: true }), 'sapi', '用户明确选本机就尊重用户')
})

test('pickEngine：全不可用时返回 null，且 noEngineAvailable 能提前告警', () => {
  const allDown = { edge: false, sapi: false, cloud: false, gptsovits: false }
  assert.equal(pickEngine('tts', 'edge', allDown), null)
  assert.equal(noEngineAvailable('tts', allDown), true)
  assert.equal(noEngineAvailable('tts', { edge: true }), false)
})

test('凪的声线：每个 TTS 引擎都有预设，默认音色合法', () => {
  for (const id of Object.keys(TTS_ENGINES)) assert.ok(NAGI_VOICE[id], `引擎 ${id} 缺声线预设`)
  assert.ok(EDGE_VOICES.some((v) => v.id === NAGI_VOICE.edge.voice), 'edge 默认音色应在音色表里')
})

test('情绪 → 语音微调：六种情绪齐备，叠加后钳制在 ±50%', () => {
  for (const m of ['calm', 'smile', 'joy', 'puzzled', 'worry', 'pout']) {
    assert.ok(MOOD_SPEECH[m], `情绪 ${m} 缺语音微调`)
  }
  assert.deepEqual(mergeVoiceParams({ rate: -10, pitch: -2, volume: 100 }, 'joy'), {
    rate: -2,
    pitch: 2,
    volume: 100
  })
  assert.equal(mergeVoiceParams({ rate: 48, pitch: 0 }, 'joy').rate, 50, '应钳到 +50')
  assert.equal(mergeVoiceParams({ rate: -48, pitch: 0 }, 'pout').rate, -50, '应钳到 -50')
  assert.equal(mergeVoiceParams({ rate: 0, pitch: 0 }, 'calm').rate, 0)
})

/* ---------------- WAV 编解码 ---------------- */

test('encodeWav：编出来的头能被自己读回来（单声道 16-bit）', () => {
  const samples = new Float32Array(1600) // 0.1s @16k
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.5
  const wav = encodeWav(samples, 16000)
  assert.equal(wav.length, 44 + 1600 * 2)

  const h = readWavHeader(wav)
  assert.ok(h, '应能读出 WAV 头')
  assert.equal(h.channels, 1)
  assert.equal(h.sampleRate, 16000)
  assert.equal(h.bitsPerSample, 16)
  assert.equal(h.frames, 1600)
  assert.equal(pcmDurationMs(1600, 16000), 100)
})

test('encodeWav：超出 [-1,1] 的采样被钳制，不会绕回反相', () => {
  const wav = encodeWav(new Float32Array([2, -2]), 16000)
  const { pcm } = extractPcm(wav)
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const v0 = dv.getInt16(0, true)
  const v1 = dv.getInt16(2, true)
  assert.equal(v0, 32767, '正溢出应钳到正最大')
  assert.equal(v1, -32768, '负溢出应钳到负最大（不能绕回 +32768）')
})

test('extractPcm：剥出裸 PCM，并如实报告采样率', () => {
  const samples = new Float32Array(800)
  const wav = encodeWav(samples, 22050)
  const got = extractPcm(wav)
  assert.ok(got)
  assert.equal(got.pcm.length, 800 * 2)
  assert.equal(got.sampleRate, 22050)
  assert.equal(got.channels, 1)
})

test('extractPcm：不是 WAV 就返回 null', () => {
  assert.equal(extractPcm(new Uint8Array([1, 2, 3, 4])), null)
  assert.equal(extractPcm(new Uint8Array(64)), null)
})

test('resample：44.1k → 16k 的长度比符合预期', () => {
  const src = new Float32Array(44100)
  const out = resample(src, 44100, 16000)
  assert.ok(Math.abs(out.length - 16000) <= 1, `应约 16000 点，实际 ${out.length}`)
  assert.equal(resample(src, 16000, 16000), src, '采样率相同应原样返回')
})

test('resample：直流信号重采样后仍是同一个直流值', () => {
  const src = new Float32Array(1000).fill(0.25)
  const out = resample(src, 48000, 16000)
  for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6, '直流不该被改变')
})

test('trimSilence：掐掉首尾静音，保留中间内容', () => {
  const sr = 16000
  const samples = new Float32Array(sr) // 1 秒
  for (let i = sr * 0.25; i < sr * 0.75; i++) samples[i] = Math.sin(i / 10) * 0.5
  const out = trimSilence(samples, sr, { threshold: 0.012, padMs: 0 })
  assert.ok(out.length > sr * 0.4 && out.length < sr * 0.6, `应留下约一半，实际 ${out.length}`)
})

test('trimSilence：整段静音 → 返回空', () => {
  const out = trimSilence(new Float32Array(1600), 16000)
  assert.equal(out.length, 0)
})

test('rms / peak：能量与峰值算得对', () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0)
  assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9)
  // Float32 存不下 0.7，比较用容差
  assert.ok(Math.abs(peak(new Float32Array([0.1, -0.7, 0.3])) - 0.7) < 1e-6)
})

/* ---------------- edge-tts 协议（纯函数部分） ---------------- */

test('secMsGec：64 位大写十六进制，5 分钟窗口内稳定、跨窗口变化', () => {
  const t0 = new Date('2026-10-15T10:00:00Z').getTime()
  const a = secMsGec(t0)
  assert.match(a, /^[0-9A-F]{64}$/)
  assert.equal(a, secMsGec(t0 + 60_000), '同一 5 分钟窗口内应一致')
  assert.notEqual(a, secMsGec(t0 + 6 * 60_000), '跨窗口应变化')

  // 回归锁定：算法 = SHA256(窗口化 FILETIME 时间戳 + TrustedClientToken) 大写
  const ticks = Math.floor(t0 / 1000) + 11644473600
  const expected = createHash('sha256')
    .update(`${(ticks - (ticks % 300)) * 10000000}6A5AA1D4EAFF4E9FB37E23D68491D6F4`, 'ascii')
    .digest('hex')
    .toUpperCase()
  assert.equal(a, expected)
})

test('buildSsml：音色与三种参数都写进去，且 XML 该转义的转义', () => {
  const ssml = buildSsml({ text: 'a<b>&"c"', voice: 'zh-CN-XiaoxiaoNeural', rate: -10, pitch: -2, volume: 100 })
  assert.match(ssml, /<voice name='zh-CN-XiaoxiaoNeural'>/)
  assert.match(ssml, /rate='-10%'/)
  assert.match(ssml, /pitch='-2%'/)
  assert.match(ssml, /volume='100%'/)
  assert.ok(ssml.includes('a&lt;b&gt;&amp;&quot;c&quot;'), '特殊字符必须转义，否则 SSML 解析会炸')
  assert.ok(!/<prosody rate='-10%' pitch='-2%' volume='100%'><\/prosody>/.test(ssml), '文本不该为空')
})

test('buildSsml：离谱参数被钳到合法区间', () => {
  const ssml = buildSsml({ text: 'hi', rate: 999, pitch: -999, volume: 5000 })
  assert.match(ssml, /rate='50%'/)
  assert.match(ssml, /pitch='-50%'/)
  assert.match(ssml, /volume='100%'/)
})

/* ---------------- sherpa-onnx 线协议 ---------------- */

test('buildSherpaFrame：8 字节头是「采样率 + 样本总字节数」，其后是 float32 小端', () => {
  // 这条协议是本轮唯一「看文档才没踩死」的地方：首条消息 ≥8 字节，
  // 前 4 字节 = 采样率，次 4 字节 = **字节数**（不是样本个数），其余是 float32 归一化样本。
  const f32 = Float32Array.from([0, 0.5, -0.5, 1])
  const frame = buildSherpaFrame(f32, 16000)
  assert.equal(SHERPA_HEADER_BYTES, 8, '协议头固定 8 字节')
  assert.equal(frame.length, SHERPA_HEADER_BYTES + 16)

  const h = readSherpaHeader(frame)
  assert.equal(h.sampleRate, 16000)
  assert.equal(h.byteSize, 16, '必须是字节数：4 个 float32 = 16 字节')

  // 负载原样是 float32 小端
  const payload = new DataView(frame.buffer, frame.byteOffset + 8, 16)
  assert.equal(payload.getFloat32(0, true), 0)
  assert.equal(payload.getFloat32(4, true), 0.5)
  assert.equal(payload.getFloat32(8, true), -0.5)
  assert.equal(payload.getFloat32(12, true), 1)
})

test('buildSherpaFrame：空样本也给出合法头（服务端要求首条消息至少 8 字节）', () => {
  const frame = buildSherpaFrame(new Float32Array(0), 16000)
  assert.equal(frame.length, 8, '空音频只有头，但不能少')
  assert.deepEqual(readSherpaHeader(frame), { sampleRate: 16000, byteSize: 0 })
})

test('buildSherpaFrame：采样率非法时退回 16k，样本长度必须自洽', () => {
  const f32 = Float32Array.from([0.1, 0.2, 0.3])
  const frame = buildSherpaFrame(f32, 0)
  const h = readSherpaHeader(frame)
  assert.equal(h.sampleRate, 16000, '采样率 0 应退回默认 16k')
  assert.equal(h.byteSize, f32.byteLength)
  assert.equal(frame.length - 8, h.byteSize, '头里声明的字节数必须等于真实负载长度')
})

test('readSherpaHeader：不足 8 字节返回 null', () => {
  assert.equal(readSherpaHeader(new Uint8Array(7)), null)
  assert.equal(readSherpaHeader(null), null)
})

test('parseSherpaReply：正常 JSON 取 .text，非 JSON 原文兜底，空格归一', () => {
  assert.equal(parseSherpaReply('{"text":"你好我是","tokens":["你"]}').text, '你好我是')
  assert.equal(parseSherpaReply('{"text":""}').text, '')
  assert.equal(parseSherpaReply(' 随便一段话 \n').text, '随便一段话', '解析不了就当纯文本')
  assert.equal(parseSherpaReply('{"text":"a  \\n b"}').text, 'a b', '连续空白应归一')
  assert.equal(parseSherpaReply('{"text":"a  \n b"}').text, '{"text":"a b"}', 'JSON 字符串里放裸换行是非法 JSON，按纯文本兜底')
  assert.equal(parseSherpaReply('null').text, 'null', 'JSON null 不是对象，按纯文本处理')
  assert.ok(parseSherpaReply('{"text":"x","lang":"zh"}').json, '能解析时应把原始对象带上')
})

/* ---------------- 默认声线定稿（2026-10-15 用户选 A） ---------------- */

test('默认声线定稿为 edge 晓晓（zh-CN-XiaoxiaoNeural）', () => {
  // 2026-10-15 用户听完 docs/voice-samples/ 三份样本后选 A（晓晓·温暖）。
  // 这里把「默认是谁」锁死：换默认 = 改这两处 + 改本测试，不许悄悄漂移。
  assert.equal(DEFAULT_VOICE_SETTINGS.ttsEngine, 'edge')
  assert.equal(DEFAULT_VOICE_SETTINGS.voiceByEngine.edge, 'zh-CN-XiaoxiaoNeural')
  assert.equal(NAGI_VOICE.edge.voice, 'zh-CN-XiaoxiaoNeural')
  // 预填的音色必须真实存在于 edge 音色表里，否则设置页下拉会落空
  assert.ok(EDGE_VOICES.some((v) => v.id === DEFAULT_VOICE_SETTINGS.voiceByEngine.edge))
})

test('mergeVoiceSettings 保留 voiceByEngine 的 edge 默认音色', () => {
  // 用户只写过 ttsEngine 时，edge 的默认音色不能被抹掉
  const m = mergeVoiceSettings({ ttsEngine: 'edge' })
  assert.equal(m.voiceByEngine.edge, 'zh-CN-XiaoxiaoNeural')
  // 用户显式换过音色时以用户为准
  const m2 = mergeVoiceSettings({ voiceByEngine: { edge: 'zh-CN-XiaoyiNeural' } })
  assert.equal(m2.voiceByEngine.edge, 'zh-CN-XiaoyiNeural')
})

/* ---------------- 资源脚本的编码约定 ---------------- */

test('voice 的 PowerShell 脚本必须是纯 ASCII（无 BOM、无非 ASCII 字节）', () => {
  // 理由同 monitor-sampler.ps1：PS 5.1 无 BOM 时按系统代码页（中文 Windows = GBK）解析 .ps1，
  // 一旦混入非 ASCII 字节就可能被解码错、静默失效。这两个脚本刻意保持纯 ASCII。
  for (const name of ['tts-sapi.ps1', 'asr-sapi.ps1']) {
    const p = join(process.cwd(), 'resources', 'voice', name)
    const buf = readFileSync(p)
    assert.ok(!buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${name} 不该带 BOM`)
    const bad = buf.findIndex((b) => b > 0x7f)
    assert.equal(bad, -1, `${name} 第 ${bad} 字节是非 ASCII，请改成英文注释`)
  }
})
