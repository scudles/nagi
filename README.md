# 凪 Nagi

> 住在你电脑里的桌面 Live2D 智能助手。三无优等生少女，桌宠 × 工作台双形态。
> **个人自制、非商用** —— 因此可以使用免费但非商用的模型资源。

一段话说明它是什么：一个透明置顶、停在屏幕角落的 Live2D 少女；点开工作台可以和她文字对话，
她能调用浏览器 / 文件 / 程序等工具真正干活，也能控制 Home Assistant 智能家居。

---

## 快速开始

```bash
npm install        # 会自动下载 Live2D Cubism Core 到 src/renderer/public/vendor/
npm run dev        # 开发模式启动
```

启动后：桌宠窗透明置顶停在屏幕右下角；系统托盘可切换「工作台 / 桌宠 / 退出」。

> 若 `npm install` 时 Cubism Core 或 Electron 二进制下载失败（网络问题），见文末「常见问题」。

### 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（electron-vite dev，热重载） |
| `npm run build` | 构建到 `out/` |
| `npm start` | 预览构建产物 |
| `npm run dist` | 构建 + electron-builder 打包 |
| `npm test` | 跑 `src/core` 纯逻辑单测（node --test） |

---

## 一、放好 Live2D 模型

模型不进 git，需要你自行下载后放进 `models/`。主用 **Lisette**（ShiraLive2D，免费·非商用）：

1. 打开 Booth 页 <https://booth.pm/ja/items/5354776>（需登录，Agent 无法代劳）
2. 下载 `lisette_v2.zip`（约 31MB）并解压
3. 放到 `models/Lisette/`，确保里面有 `*.model3.json`

```
models/
└── Lisette/
    ├── lisette.model3.json   ← 入口
    ├── lisette.moc3
    ├── *.exp3.json  *.motion3.json  *.png ...
```

没有 Lisette 时，可先用 Live2D 官方免费模型跑通管线——本工程已内置 **Mao**（官方免费示例，
132 参数、8 表情），可用脚本随时重新拉取：

```bash
node scripts/fetch-sample-model.mjs          # 默认 Mao；也可 Hiyori / Haru
```

启动后应用自动扫描 `models/` 下的 `*.model3.json`，在「设置 → Live2D」里选择。
换模型后点「保存 Live2D 设置」，回到桌宠即生效。

**情绪 → 表情映射**：加载后按优先级取 ① 模型目录里的可选 `nagi-emotion.json`（形如
`{"calm":"exp_01","smile":"exp_02",...}`）→ ② 内置模型 profile（Mao/Haru 已配好）→ ③ 通用命名候选。
只映射模型里真实存在的表情，不会引用不存在的参数。

模型通过自定义特权协议加载：`nagi-local://models/<相对路径>`，模型内部相对路径会自动解析。

---

## 二、配置大脑（LLM）

应用统一走 **OpenAI 兼容协议**，换 `baseURL + key + model` 即可切换各家模型。

「设置 → 大脑（LLM）」：

| 提供商 | Base URL | 备注 |
|---|---|---|
| OpenAI ChatGPT（主用） | `https://api.openai.com/v1` | 需海外网络 + 支付 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | hunyuan-chat 无原生 tools，走 JSON 兜底 |
| DeepSeek | `https://api.deepseek.com` | 国内直连、便宜 |
| 通义 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | |
| Kimi | `https://api.moonshot.cn/v1` | |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | |
| 本地 Ollama | `http://localhost:11434/v1` | 离线 |
| OpenRouter | `https://openrouter.ai/api/v1` | 多模型聚合 |

API Key 通过 Electron `safeStorage` 加密落盘（`userData/secrets.json`），**渲染进程拿不到明文**。

---

## 三、浏览器自动化（Playwright）

两种模式：

**① 接管你日常的 Chrome（默认，推荐）**
用 CDP 连接已开调试端口的 Chrome —— 这样她用的是你已登录的浏览器。

Windows（先完全退出 Chrome，再执行）：
```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```
macOS：
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```
应用连接 `http://localhost:9222`。

**② 托管模式**
连不上 CDP 时自动回退到 Playwright 自带的独立浏览器（`launchPersistentContext`，
数据目录放在 `userData`，能保持登录）：
```bash
npx playwright install chromium
```

---

## 四、智能家居（Home Assistant）

HA 作为中枢统管各品牌设备。

1. 让 HA 跑在一个常开设备上（树莓派 / 旧电脑 / NAS / 虚拟机均可）
2. 在 HA 个人资料页 → 底部「长期访问令牌」→ 创建令牌
3. 应用「设置 → 智能家居」填 HA 地址（默认 `http://homeassistant.local:8123`）+ 令牌，点「测试连接」

**接入米家设备**：在 HA 里通过 HACS 安装 **Xiaomi Miot Auto**
（仓库 <https://github.com/al-one/hass-xiaomi-miot>），登录小米账号后设备自动出现。
Matter 设备原生接入；涂鸦等用官方集成。

---

## 五、目录结构

```
nagi/
├── electron.vite.config.mjs
├── scripts/setup-core.mjs          # postinstall 下载 Cubism Core
├── scripts/fetch-sample-model.mjs  # 拉取官方免费模型（Mao/Hiyori/Haru）
├── scripts/gen-icons.py            # 生成托盘/应用图标
├── resources/                      # tray.png / icon.png
├── models/                         # Live2D 模型（Mao 已内置，Lisette 自行放入）
└── src/
    ├── shared/protocol.js          # IPC 通道 / 事件 / 情绪 / 工具 / 风险等级
    ├── main/                       # 主进程
    │   ├── agent.js                # 会话编排：LLM + 工具 + 安全门 + 确认回路
    │   ├── native-tools.js         # 截屏 / 剪贴板 / 系统通知（Electron 原生）
    │   └── ...                     # 窗口、托盘、协议、密钥、IPC
    ├── preload/index.js            # contextBridge 暴露的安全 API
    ├── renderer/                   # 渲染层（Live2D、气泡、独白、对话、设置）
    └── core/                       # 与 Electron 无关的纯逻辑（可单测）
        ├── llm/                    # OpenAI 兼容封装 + SSE 归一化 + 情绪标签
        ├── agent/                  # Agent Loop + JSON 兜底 + 情绪映射
        ├── tools/                  # 注册表 + 浏览器 / 文件 / 程序 / 搜索
        ├── homeassistant/          # HA REST + WS
        └── safety/policy.js        # 工具白名单、风险分级、确认策略
```

---

## 六、安全与隐私

- 工具分三级风险：**low**（只读）/ **medium**（可逆写）/ **high**（不可逆、对外、涉及钱）
- **high 级必须经你确认**才会执行（确认条 → 允许 / 拒绝）
- `run_command` 命令黑名单（格式化、批量删除、注册表关键操作等）**永久拒绝**
- 文件工具限定在授权目录内，禁止越权访问系统目录
- 密钥只在主进程内存中出现，落盘加密，不进日志
- 活动监测默认关闭，可一键勿扰

---

## 七、常见问题与回退

**Cubism Core 下载失败**
手动下载 <https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js>
另存为 `src/renderer/public/vendor/live2dcubismcore.min.js`（约 200KB）。

**Electron 二进制下载失败（国内网络）**
```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

**`npm install` 报 esbuild EBUSY / 脚本失败**
```bash
npm install --ignore-scripts
node node_modules/electron/install.js
npm install --no-save @esbuild/win32-x64@0.21.5
```

**模型加载失败 / 白屏**
先确认 `vendor/live2dcubismcore.min.js` 存在，且模型目录里有 `*.model3.json`；
F12 打开 DevTools 看控制台报错。

**屏幕是黑的 / 图形异常（虚拟机、远程桌面）**
默认已开软件渲染。若仍异常，试着关掉硬件加速：设置环境变量 `NAGI_SOFTWARE_GL=1` 后启动。

**本机 shell 里跑 electron 相关命令没输出 / electron 启动即崩（Node ESM 报错）**
本机全局设了 `ELECTRON_RUN_AS_NODE=1`，会让 electron 退化成 node。启动 dev 前在**同一个 shell 内**
`unset ELECTRON_RUN_AS_NODE` 再运行（不要用 `env -u`，那会把 stdout 一起吞掉）：
```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

**Chrome CDP 连不上**
确认 Chrome 已用 `--remote-debugging-port=9222` 启动且已完全退出重启过一次；
应用会自动回退到托管浏览器。

---

## 八、当前状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 形象 | Live2D 模型（Mao 验证通过，Lisette 待放） | ✅ 管线 |
| M1 桌宠原型 | 透明置顶窗 / 托盘 / 双形态 / 戳一戳 | ✅ |
| M2 情感系统 | 6 情绪 → 表情映射（自测 6/6 命中）+ 情绪标签契约 | ✅ |
| T7 LLM 适配 | OpenAI 兼容 + 双通道（原生 tools / JSON 兜底） | ✅ |
| T8 Agent Loop | 步数上限 / 事件广播 / 工具结果回喂 / 中止 | ✅ |
| T9 工具集 | 浏览器 / 文件 / 命令 / 截屏 / 剪贴板 / 通知 / 搜索 | ✅ |
| T10 安全门 | 风险分级 / 高危确认 / 命令黑白名单 / 路径边界 | ✅ |
| T11 智能家居 | HA REST + WS 事件订阅 + 主动提醒 | ✅ 代码，待真机 |
| M3 监测与主动行为 | 活动监测（前台窗口/进程） | ⬜ 下一步 |
| M5 语音全链路 | ASR + TTS | ⬜ 本期不做 |

**验证情况**：单测 37/37 通过；无头端到端已验证——桌宠窗透明置顶定位正确、Mao 模型加载渲染、
6/6 情绪映射命中真实表情、对话 IPC→Agent→工具执行（file_list 真实列目录）→结果回喂→最终回复全链路通。
浏览器 CDP 接管与 HA 控制需要真实环境（Chrome 调试端口 / HA 实例）后实测。

> 声音线（TTS / ASR / GPT-SoVITS 音色训练）整体延后，本期交互为文字气泡 + 表情 + 独白面板。

---

## 九、无头自测钩子（开发用）

| 环境变量 | 作用 |
|---|---|
| `NAGI_MODE=workbench` | 启动时直接进工作台形态 |
| `NAGI_SELFTEST=1` | 渲染层 console 转发到主进程 stdout；工作台自动发一条消息；桌宠轮换 6 情绪验证映射 |
| `NAGI_FAKE_LLM=1` | 用脚本化假大脑（第一轮发 file_list 工具调用、第二轮汇报），不配 Key 也能验证 Agent 全链路 |
| `NAGI_SOFTWARE_GL=0` | 关闭强制软件渲染（真机想用硬件加速时） |
