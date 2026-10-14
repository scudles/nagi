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
| `npm run pack` | 只打包到目录 `dist/win-unpacked`（快速验证，不出安装包） |
| `npm run dist` | 构建 + 打包出安装包与免安装版到 `dist/` |
| `npm test` | 跑 `src/core` 纯逻辑单测（node --test） |

打包产物（Windows x64）：
- `dist/Nagi-Setup-<版本>.exe` —— NSIS 安装包（可选安装目录、建桌面/开始菜单快捷方式），
  装完即用；**这是让桌宠脱离开发环境、长久挂机的正解**
- `dist/Nagi-Portable-<版本>.exe` —— 免安装单文件版，双击即跑、拷走即用

> 详细打包说明与国内加速见「十、打包与分发」。

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

**默认大脑 = 凪云（免密钥）**：应用内置 WorkBuddy 云服务公开键配置（`cloud-config.js`），
开箱即用无需注册，实测支持 OpenAI 原生 function calling（含混元系列，网关侧做协议转换）。
云端不可用时自动降级本地 persona 关键词大脑（会提示原因，不会静默装死）。

需要换自己的模型时，「设置 → 大脑（LLM）」：

| 提供商 | Base URL | 备注 |
|---|---|---|
| 凪云（免密钥，默认） | —（内置） | WorkBuddy 云服务，原生 tools |
| OpenAI ChatGPT | `https://api.openai.com/v1` | 需海外网络 + 支付 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | 原生 tools |
| DeepSeek | `https://api.deepseek.com` | 国内直连、便宜 |
| 通义 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | |
| Kimi | `https://api.moonshot.cn/v1` | |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | |
| 本地 Ollama | `http://localhost:11434/v1` | 离线 |
| OpenRouter | `https://openrouter.ai/api/v1` | 多模型聚合 |

API Key 通过 Electron `safeStorage` 加密落盘（`userData/secrets.json`），**渲染进程拿不到明文**。

### 情感系统（合并自桌宠原型，2026-10-14）

- **连续情绪状态机**（`src/core/emotion/mood.js`）：6 离散情绪 + 强度 0~1，同情绪叠加、
  异情绪粘性接管、每 15s 衰减；环境推力——被冷落 25min 闹别扭、深夜 23-7 点担心、
  90s 内连聊 4 条开心；强度 ≥0.5 时把情绪写进 LLM 提示保持回复连贯
- **内心独白日记**（D2 决策：后台静默）：主进程每 42s（50% 概率）把独白连同当时情绪
  写入 `userData/monologue/diary-日期.md`；工作台侧栏「看看她的日记」或托盘菜单打开
  日记查看器按需阅读
- **戳一戳**：点击桌宠 → TapBody 动作 + 气泡台词（闹别扭时 60% 用更冷淡的池），
  戳她也算互动（刷新冷落计时）
- **双窗同步**：情绪状态机是主进程单例，桌宠窗和工作台窗看到同一份情绪

---

## 三、浏览器自动化（Playwright）

两种模式：

**① 接管你日常的浏览器（默认，推荐）**
用 CDP 连接已开调试端口的浏览器 —— 这样她用的是你已登录的浏览器。**Chrome 与 Edge 均可**
（同为 Chromium 内核，Edge 是 Windows 预装，无需额外安装）。

Windows（先完全退出浏览器，再执行）：
```bat
:: Chrome
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
:: 或 Edge（Windows 预装）
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```
macOS：
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```
应用连接 `http://localhost:9222`。若浏览器较新，建议加 `--remote-allow-origins=*`。

> **已实测（2026-10-14，S3 真机验证）**：本机用 Edge 155 开 `9222`，nagi 的
> `browser_open` / `browser_scrape` / `browser_act`（填表+点击）全链路走 CDP 通道通过。
> 验证脚本：`node scripts/verify-cdp.mjs`（需已有浏览器开着调试端口）。

**② 托管模式**
连不上 CDP 时自动回退到 Playwright 自带的独立浏览器（`launchPersistentContext`，
数据目录放在 `userData`，能保持登录）：
```bash
npx playwright install chromium
```
> 注：打包版仅内置 Playwright 运行库（支持 CDP 接管）；托管模式仍需在目标机器执行上一条命令装 Chromium。

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
├── electron-builder.yml            # 打包配置（NSIS 安装包 + portable）
├── cloud-config.js                 # 凪云公开键配置（免密钥默认大脑）
├── start-pet.bat                   # 双击启动（清 ELECTRON_RUN_AS_NODE 后拉起）
├── scripts/setup-core.mjs          # postinstall 下载 Cubism Core
├── scripts/fetch-sample-model.mjs  # 拉取官方免费模型（Mao/Hiyori/Haru）
├── scripts/gen-icons.py            # 生成托盘/应用图标
├── scripts/convert-portraits.py    # 表情差分 PNG → WebP 入库
├── scripts/verify-cdp.mjs          # CDP 接管真机验证（调用生产代码）
├── resources/                      # tray.png / icon.png / portraits 立绘
├── models/                         # Live2D 模型（Lisette/Mao）
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
确认 Chrome/Edge 已用 `--remote-debugging-port=9222` 启动且已完全退出重启过一次；
应用会自动回退到托管浏览器。

**打包（`npm run dist`）下载卡住 / 极慢（国内网络）**
electron-builder 需要从 GitHub 拉 winCodeSign、NSIS 等二进制，国内直连常只有几十 KB/s。
改用国内镜像（实测 4.5MB/s）：
```bash
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```
Electron 本体无需下载——配置里已用 `electronDist: node_modules/electron/dist` 复用本地已装的发行版。

**打包报 `Cannot create symbolic link ... libcrypto.dylib`（winCodeSign 解压失败）**
winCodeSign 包含 macOS 符号链接，Windows 无符号链接权限时 7za 退出码非 0，electron-builder 会重试并失败。
解法：把已解出的内容放到正确的缓存名下（`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`，
缺那两个 darwin `.dylib` 不影响 Windows 打包），或开启 Windows「开发者模式」以允许创建符号链接。

---

## 八、当前状态

> 2026-10-14：桌宠原型（M2 实验场）已合并进本工程，原型目录归档只读。
> 合并内容：persona 人格台词库、连续情绪状态机、凪云免密钥大脑、戳一戳、独白日记。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 形象 | Live2D 模型（**Lisette 已入库**，专属表情 nagi_calm/joy/puzzled/pout 全命中） | ✅ |
| M1 桌宠原型 | 透明置顶窗 / 托盘 / 双形态 / 戳一戳 | ✅ |
| M2 情感系统 | 连续情绪状态机 + 独白日记 + 6/6 情绪映射 + 情绪注入 LLM | ✅ |
| T7 LLM 适配 | 凪云（默认，免密钥）+ OpenAI 兼容 + 双通道 | ✅ |
| T8 Agent Loop | 步数上限 / 事件广播 / 工具结果回喂 / 中止 | ✅ |
| T9 工具集 | 浏览器 / 文件 / 命令 / 截屏 / 剪贴板 / 通知 / 搜索 | ✅（浏览器工具已真机验证） |
| T10 安全门 | 风险分级 / 高危确认 / 命令黑白名单 / 路径边界 | ✅ |
| T11 智能家居 | HA REST + WS 事件订阅 + 主动提醒 | ✅ 代码，待真机 |
| **S3 打包与真机验证** | electron-builder 安装包 + 免安装版；CDP 接管真机实测 | ✅ |
| M3 监测与主动行为 | 活动监测（前台窗口/进程） | ⬜ 下一步 |
| M5 语音全链路 | ASR + TTS | ⬜ 本期不做 |

**验证情况**（2026-10-14 合并后全量复验 + S3）：
- 单测 **59/59**；无头端到端全绿——假大脑全链路（工具调用→回喂→汇报）、凪云真连
  （对话 + 原生 function calling 工具闭环 + 基于真实目录内容汇报）、双窗情绪同步、
  戳击链路、日记落盘与查看器渲染
- **浏览器 CDP 已真机验证**：以 Edge 155 开调试端口，`browser_open`/`browser_scrape`/
  `browser_act` 全链路走 CDP 通道通过（顺带修掉 `scrape()` 里 `evalOnSelectorAll` 的 API 误用）
- **打包产物已启动验证**：`dist/win-unpacked/Nagi.exe` 与 `Nagi-Portable` 均能启动，
  从 `process.resourcesPath/models` 正确加载 Lisette、6/6 表情映射、凪云在线、日记窗正常
- HA 控制仍需真实 HA 实例后实测

> 声音线（TTS / ASR / GPT-SoVITS 音色训练）整体延后，本期交互为文字气泡 + 表情 + 日记。

---

## 九、无头自测钩子（开发用）

| 环境变量 | 作用 |
|---|---|
| `NAGI_MODE=workbench` | 启动时直接进工作台形态 |
| `NAGI_SELFTEST=1` | 渲染层 console 转发到 stdout；工作台自动发消息 + 情绪/戳击链路自测；桌宠轮换 6 情绪；日记窗（配合 `NAGI_SELFTEST_DIARY=1`）验证日记渲染 |
| `NAGI_SELFTEST_MSG=<文本>` | 覆盖自测消息内容（如触发工具调用的指令） |
| `NAGI_FAKE_LLM=1` | 用脚本化假大脑，不配 Key 也能验证 Agent 全链路 |
| `NAGI_SOFTWARE_GL=0` | 关闭强制软件渲染（真机想用硬件加速时） |

---

## 十、打包与分发（S3）

把 nagi 打成 Windows 桌面应用，脱离开发环境运行——这也是桌宠在 agent 沙箱里「随启随用」问题的正解。

### 产物

| 文件 | 说明 |
|---|---|
| `dist/Nagi-Setup-<版本>.exe` | NSIS 安装包：可选安装目录、建桌面/开始菜单快捷方式（快捷名「凪 Nagi」） |
| `dist/Nagi-Portable-<版本>.exe` | 免安装单文件版：双击即跑、拷走即用 |
| `dist/win-unpacked/` | 未压缩的应用目录（调试用，直接跑 `Nagi.exe`） |

### 打包

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"  # 国内加速
npm run dist        # 出安装包 + 免安装版
npm run pack        # 只出目录 dist/win-unpacked，快速验证
```

打包配置见 `electron-builder.yml`，要点：
- **代码进 asar**：`out/` + `package.json` + 生产依赖
- **模型与资源走 extraResources**：`models/`、`resources/` 释放到 `process.resourcesPath`
  —— Live2D 模型必须能被 `nagi-local://` 协议以真实文件路径读取，不能压在 asar 里；
  主进程 `src/main/paths.js` 已按 `app.isPackaged` 分流解析
- **playwright 从 asar 解出**（`asarUnpack`），CDP 接管依赖它的运行库
- **复用本地 Electron**（`electronDist`），避免打包时再从 GitHub 下载

### 安装与自启

装完（或解压免安装版）后想让它开机常驻：`Win+R` → `shell:startup`，把
「凪 Nagi」的快捷方式（或免安装版 exe）拖进去即可。

> 未签名：本工程为个人自制非商用，未做代码签名，首次运行 Windows SmartScreen 可能提示
> 「未知发布者」，点「仍要运行」即可。
