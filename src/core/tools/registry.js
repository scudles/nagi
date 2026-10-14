// src/core/tools/registry.js
// 工具注册表：给模型看的 schema（原生通道）+ 统一执行入口（两条通道共用）。
// 依赖注入：文件/系统/浏览器/搜索/HA/Electron 原生能力，全部由 main 层组装进来。

const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } })

const S = { type: 'object', properties: {}, required: [] }
const str = (desc) => ({ type: 'string', description: desc })
const num = (desc) => ({ type: 'number', description: desc })
const bool = (desc) => ({ type: 'boolean', description: desc })

/** 全部工具的 OpenAI function calling schema */
export const TOOL_SCHEMAS = [
  fn('web_search', '网页搜索，返回标题/链接/摘要列表', {
    type: 'object',
    properties: { query: str('搜索关键词'), count: num('返回条数，默认5，最多8') },
    required: ['query']
  }),
  fn('browser_open', '打开一个网页（接管用户Chrome或托管浏览器）', {
    type: 'object',
    properties: { url: str('网址'), newTab: bool('是否新开标签页') },
    required: ['url']
  }),
  fn('browser_act', '对当前页面执行操作', {
    type: 'object',
    properties: {
      action: str('goto/click/fill/press/scroll/back/select/wait'),
      selector: str('CSS选择器（click/fill/select时需要）'),
      value: str('填入的内容/滚动的像素/等待的毫秒'),
      key: str('press时按键名，如 Enter'),
      url: str('goto时的网址')
    },
    required: ['action']
  }),
  fn('browser_scrape', '抓取当前页面（或指定网址）的正文与链接', {
    type: 'object',
    properties: { url: str('可选，不填抓当前页'), selector: str('可选，只抓某元素'), maxChars: num('正文截断长度，默认4000') }
  }),
  fn('file_read', '读取授权目录内的文本文件', {
    type: 'object',
    properties: { path: str('相对授权目录的路径'), maxBytes: num('最多读取字节数，默认64KB') },
    required: ['path']
  }),
  fn('file_write', '写入/追加授权目录内的文件', {
    type: 'object',
    properties: { path: str('相对授权目录的路径'), content: str('要写入的内容'), append: bool('true=追加，默认覆盖') },
    required: ['path', 'content']
  }),
  fn('file_list', '列出授权目录内的文件与子目录', {
    type: 'object',
    properties: { path: str('相对授权目录的路径，默认根'), depth: num('递归深度1-3，默认1') }
  }),
  fn('run_command', '执行系统命令（高危，需用户确认；系统命令黑名单会被直接拒绝）', {
    type: 'object',
    properties: { command: str('要执行的命令'), cwd: str('可选，工作目录'), timeoutMs: num('可选，超时毫秒，默认30000') },
    required: ['command']
  }),
  fn('open_app', '打开一个应用程序', {
    type: 'object',
    properties: { name: str('应用名，如 notepad / calc'), path: str('或应用完整路径') }
  }),
  fn('screenshot', '截取当前屏幕', S),
  fn('clipboard_read', '读取剪贴板文本', S),
  fn('clipboard_write', '写入剪贴板（需用户确认）', {
    type: 'object',
    properties: { text: str('要写入的文本') },
    required: ['text']
  }),
  fn('notify', '弹出系统通知', {
    type: 'object',
    properties: { title: str('通知标题'), body: str('通知正文') },
    required: ['title', 'body']
  }),
  fn('home_list', '列出 Home Assistant 设备/实体', {
    type: 'object',
    properties: { domain: str('可选，按域过滤：light/switch/sensor/climate/media_player…') }
  }),
  fn('home_get', '查询一个实体的状态', {
    type: 'object',
    properties: { entity_id: str('实体ID，如 light.living_room') },
    required: ['entity_id']
  }),
  fn('home_set', '控制设备（开/关/亮度/温度等）', {
    type: 'object',
    properties: {
      entity_id: str('实体ID'),
      state: str("目标状态：'on' 或 'off'"),
      brightness_pct: num('亮度百分比（灯）'),
      temperature: num('目标温度（空调）'),
      extra: { type: 'object', description: '其他要透传给 HA 服务的参数' }
    },
    required: ['entity_id']
  }),
  fn('home_scene', '触发一个场景或脚本', {
    type: 'object',
    properties: { entity_id: str('scene.xxx 或 script.xxx') },
    required: ['entity_id']
  }),
  fn('reminder_add', '设置一条日程提醒；到点后你会主动提醒用户（这是你自己记下的事，不是系统闹钟）', {
    type: 'object',
    properties: {
      text: str('要提醒的内容，例如「开会」「该吃药了」'),
      when: str('什么时候提醒。可用自然语言：「10分钟后」「明天9:00」「下午3点半」「今晚8点」「周五10点」'),
      at: num('也可以直接给绝对时间戳（毫秒）'),
      repeat: str("是否重复：'none'（默认）/ 'daily'（每天）/ 'weekly'（每周）"),
      say: str('可选：你到点想说的那句话。不填就由你到时候临场组织')
    },
    required: ['text']
  }),
  fn('reminder_list', '列出还没到点的提醒', S),
  fn('reminder_cancel', '取消一条/多条提醒（按 id，或按内容关键词）', {
    type: 'object',
    properties: { id: str('提醒 id（reminder_list 会给出）'), text: str('或按内容关键词匹配') }
  })
]

/** 把 home_set 的参数翻译成 HA 服务调用 */
export function planHomeService(args) {
  const entityId = String(args.entity_id || '')
  const domain = entityId.split('.')[0] || 'switch'
  if (domain === 'scene' || domain === 'script') {
    return { domain, service: 'turn_on', data: { entity_id: entityId } }
  }
  if (args.temperature != null && domain === 'climate') {
    return { domain, service: 'set_temperature', data: { entity_id: entityId, temperature: Number(args.temperature) } }
  }
  if (args.brightness_pct != null && domain === 'light') {
    return {
      domain,
      service: 'turn_on',
      data: { entity_id: entityId, brightness_pct: Math.min(Math.max(Number(args.brightness_pct), 0), 100) }
    }
  }
  const state = String(args.state || '').toLowerCase()
  if (state === 'on' || state === 'off') {
    return { domain, service: `turn_${state}`, data: { entity_id: entityId, ...(args.extra || {}) } }
  }
  if (args.extra && Object.keys(args.extra).length) {
    return { domain, service: 'turn_on', data: { entity_id: entityId, ...args.extra } }
  }
  return { domain, service: 'toggle', data: { entity_id: entityId } }
}

/**
 * 组装统一执行入口。
 * @param {object} deps { files, system, browser, ha, native, reminders }
 *   files:    createFileTools 的返回
 *   system:   createSystemTools 的返回
 *   browser:  createBrowserTools 的返回
 *   ha:       HAClient 实例（可为 null）
 *   native:   Electron 原生工具 { screenshot, clipboardRead, clipboardWrite, notify }
 *   reminders: main/reminders.js 的 reminderTools()（{ add, list, cancel }）
 */
export function createToolRunner(deps) {
  const unknown = (name) => ({ ok: false, summary: `未知工具：${name}` })

  return async function executeTool(name, args = {}) {
    switch (name) {
      case 'web_search': {
        const { webSearch } = await import('./search.js')
        return webSearch(args)
      }
      case 'browser_open':
        return deps.browser.open(args)
      case 'browser_act':
        return deps.browser.act(args)
      case 'browser_scrape':
        return deps.browser.scrape(args)

      case 'file_read':
        return deps.files.read(args)
      case 'file_write':
        return deps.files.write(args)
      case 'file_list':
        return deps.files.list(args)

      case 'run_command':
        return deps.system.run(args)
      case 'open_app':
        return deps.system.open(args)

      case 'screenshot':
        return deps.native.screenshot()
      case 'clipboard_read':
        return deps.native.clipboardRead()
      case 'clipboard_write':
        return deps.native.clipboardWrite(args)
      case 'notify':
        return deps.native.notify(args)

      case 'home_list': {
        if (!deps.ha?.configured) return { ok: false, summary: 'Home Assistant 未配置' }
        const list = await deps.ha.listEntities(args)
        const lines = list.slice(0, 60).map((e) => `${e.entity_id}  ${e.name} = ${e.state}${e.unit}`)
        return { ok: true, summary: `共 ${list.length} 个实体（显示前 ${lines.length}）：\n` + lines.join('\n'), data: { count: list.length } }
      }
      case 'home_get': {
        if (!deps.ha?.configured) return { ok: false, summary: 'Home Assistant 未配置' }
        const s = await deps.ha.getState(args.entity_id)
        if (!s) return { ok: false, summary: `找不到实体 ${args.entity_id}` }
        return { ok: true, summary: `${s.name}（${s.entity_id}）= ${s.state}` }
      }
      case 'home_set': {
        if (!deps.ha?.configured) return { ok: false, summary: 'Home Assistant 未配置' }
        const plan = planHomeService(args)
        await deps.ha.callService(plan.domain, plan.service, plan.data)
        return { ok: true, summary: `已调用 ${plan.domain}.${plan.service}（${args.entity_id}）` }
      }
      case 'home_scene': {
        if (!deps.ha?.configured) return { ok: false, summary: 'Home Assistant 未配置' }
        await deps.ha.trigger(args.entity_id)
        return { ok: true, summary: `已触发 ${args.entity_id}` }
      }

      case 'reminder_add':
        if (!deps.reminders) return unknown(name)
        return deps.reminders.add(args)
      case 'reminder_list':
        if (!deps.reminders) return unknown(name)
        return deps.reminders.list()
      case 'reminder_cancel':
        if (!deps.reminders) return unknown(name)
        return deps.reminders.cancel(args)
      default:
        return unknown(name)
    }
  }
}
