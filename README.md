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
| `npm run verify:frame` | 取景/对齐实机矩阵：多窗口尺寸 + 面板宽度 + 真实像素不越界 |
| `npm run verify:s4` | 无头验证关系层（情绪跨重启延续 / 离线衰减 / 时间线落盘 / 保留策略） |
| `npm run verify:m4` | 无头验证日程提醒（到点→主动开口→日记落盘 / 重复推进 / 错过作废） |

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

**去掉模型自带的「红色形态」**：该模型的红色辉光由 8 个 `ParamRed*` 参数驱动，**默认已裁掉**；
想恢复某个模型的红色，在它的 `nagi-emotion.json` 里写 `"removeRedGlow": false` 即可。
原理见第十二节。

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
- **戳一戳**：点击桌宠（原地按一下再松手）→ TapBody 动作 + 气泡台词（闹别扭时 60% 用更冷淡的池），
  戳她也算互动（刷新冷落计时）。**按住拖动 = 搬窗口**——见「十一、互动与存在感」
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
├── scripts/verify-s4.mjs           # 关系层无头验证（真实 electron + 隔离 userData）
├── scripts/verify-m4.mjs           # 日程提醒无头验证（到点/重复推进/错过作废）
├── resources/                      # tray.png / icon.png / portraits 立绘
├── models/                         # Live2D 模型（Lisette/Mao）
└── src/
    ├── shared/protocol.js          # IPC 通道 / 事件 / 情绪 / 工具 / 风险等级
    ├── main/                       # 主进程
    │   ├── agent.js                # 会话编排：LLM + 工具 + 安全门 + 确认回路
    │   ├── persist.js              # 落盘：记忆 / 历史 / 情绪 / 关系统计
    │   ├── relation.js             # 关系层服务：关系统计 + 情绪时间线按天落盘
    │   ├── reminders.js            # 日程提醒服务：落盘 + 定时检查 + 到期回调（M4）
    │   ├── monitor/                # 活动监测：采样器 + 编排（M3）
    │   ├── native-tools.js         # 截屏 / 剪贴板 / 系统通知（Electron 原生）
    │   └── ...                     # 窗口、托盘、协议、密钥、IPC
    ├── preload/index.js            # contextBridge 暴露的安全 API
    ├── renderer/                   # 渲染层（Live2D、气泡、独白、对话、设置、关系页）
    └── core/                       # 与 Electron 无关的纯逻辑（可单测）
        ├── llm/                    # OpenAI 兼容封装 + SSE 归一化 + 情绪标签
        ├── emotion/mood.js         # 情绪状态机（含跨重启 serialize/restore）
        ├── relation/               # 熟悉度 + 情绪时间线采样（S4）
        ├── reminders/              # 日程提醒：自然语言时间解析 / 到期 / 重复推进（M4）
        ├── monitor/                # 活动监测：隐私三护栏 / 规则库 / 节流 / 引擎（M3）
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
- 活动监测默认开启，**首次启动弹窗告知**、可一键关掉或开勿扰；关闭 / 勿扰时**采集本身即停止**（不只是丢弃结果）

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
| **M3 活动监测与主动行为** | 前台窗口/空闲采集 + 隐私三护栏 + 主动规则 + 节流 | ✅（见第十三节） |
| **S4 关系层** | 情绪跨重启延续 + 熟悉度（五档）+ 情绪时间线 + 关系页 | ✅（见第十四节） |
| **M4 工作台增强** | 日程提醒 + 工具执行卡片 + 多会话（新对话）+ 日程面板 | ✅（见第十五节） |
| S4 记忆碎片剧情 | 身世解锁 UI + 触发条件 | ⬜ 前置：剧情大纲未写 |
| M5 语音全链路 | ASR + TTS | ⬜ 暂时跳过，先做主要功能 |

**验证情况**（2026-10-14 合并后全量复验 + S3；**当日第二轮「互动与存在感」及第三轮去红/取景增补后复验**）：
- 单测 **236/236**（累计：去红 83 + 互动与存在感 + S4 + M4 + 取景 8）；无头端到端全绿——
  假大脑全链路（工具调用→回喂→汇报）、凪云真连（对话 + 原生 function calling 工具闭环 +
  基于真实目录内容汇报）、双窗情绪同步、戳击链路、日记落盘与查看器渲染
- **取景/对齐实机矩阵**：`npm run verify:frame` 自起隔离实例，
  桌宠 200×300 / 320×480 / 400×600 / 640×960 / 900×1300 + 工作台 240/300/460 面板 × 矮窗/中窗/大窗
  = **45/45 通过**；每 case 用像素 alpha 包围盒确认真实画面不越出画布，控件栏在画布之外
- **浏览器 CDP 已真机验证**：以 Edge 155 开调试端口，`browser_open`/`browser_scrape`/
  `browser_act` 全链路走 CDP 通道通过（顺带修掉 `scrape()` 里 `evalOnSelectorAll` 的 API 误用）
- **打包产物已启动验证**：`dist/win-unpacked/Nagi.exe` 与 `Nagi-Portable` 均能启动，
  从 `process.resourcesPath/models` 正确加载 Lisette、6/6 表情映射、凪云在线、日记窗正常
- **第二轮用 Playwright 走 CDP 接管实跑**（脚本驱动真实渲染进程）：桌宠模型加载 8 动作组 /
  戳一戳 → `pet:event` 广播 / 拖动窗口位移 Δ=(60,30) 命中 / 工作台凪面板 8 组 20 个动作按钮，
  4/4 通过、渲染层零 uncaught 异常
- **M3 活动监测**：单测累计 **110/110**；无头自测 `NAGI_SELFTEST_MONITOR=1` 验证
  「监测 → 规则 → 节流 → 主动搭话 + 日记」全链路；首次告知弹窗经 CDP 实跑确认渲染；
  **真机采样路径已用生产同款 spawn 实测通过**（并修掉「脚本缺 BOM 致中文乱码 / 关闭监测仍在采」两个 bug，详见第十三节）
- HA 控制仍需真实 HA 实例后实测
- **S4 关系层**：单测累计 **141/141**；`npm run verify:s4` 用真实 electron 进程 + 隔离 userData
  实跑 **9/9 通过**（情绪延续与离线衰减、长离线归零、时间线落盘、重启延续、统计累加、过期清理）；
  关系页经 CDP 核对 DOM 并截图确认（详见第十四节）
- **M4 工作台增强**：单测累计 **163/163**；`npm run verify:m4` 用真实 electron 进程 + 隔离 userData
  实跑 **14/14 通过**（到点→主动开口 + 情绪 + 日记落盘 + 触发标记、重复提醒整日步进、错过太久作废、
  未到期不动）；日程面板与工具卡片经 CDP 实跑 **9/9 + 11/11 通过**（详见第十五节）

> 声音线（TTS / ASR / GPT-SoVITS 音色训练）整体延后，本期交互为文字气泡 + 表情 + 日记 + 工具卡片。

---

## 九、无头自测钩子（开发用）

| 环境变量 | 作用 |
|---|---|
| `NAGI_MODE=workbench` | 启动时直接进工作台形态 |
| `NAGI_SELFTEST=1` | 渲染层 console 转发到 stdout；工作台自动发消息 + 情绪/戳击链路自测；桌宠轮换 6 情绪；日记窗（配合 `NAGI_SELFTEST_DIARY=1`）验证日记渲染 |
| `NAGI_SELFTEST_MSG=<文本>` | 覆盖自测消息内容（如触发工具调用的指令） |
| `NAGI_FAKE_LLM=1` | 用脚本化假大脑，不配 Key 也能验证 Agent 全链路 |
| `NAGI_SELFTEST_REMINDER=1` | 日程提醒自测：提速到 1.2 秒一轮，并塞一条 3 秒后到期的提醒 |
| `NAGI_SOFTWARE_GL=0` | 关闭强制软件渲染（真机想用硬件加速时） |

**端到端 UI 验证**（`scripts/verify-ui.mjs`，Playwright 走 CDP 接管真实渲染进程）：

```bash
# 一个终端：带调试端口启动
node_modules\electron\dist\electron.exe --remote-debugging-port=9222 .
# 另一个终端：
npm run verify:ui                      # 验证桌宠（模型/戳一戳/拖动窗口）
EXPECT=workbench npm run verify:ui     # 额外验证工作台凪面板
```
它断言的是真实链路：模型动作组数、戳一戳是否真的广播 `pet:event`、鼠标拖动后窗口
坐标是否真的位移（Δ 必须命中）。注意脚本**不能**调 `browser.close()`——connectOverCDP
下那会真的把凪关掉。

**渲染层调试钩子**（挂在 `window` 上，可选链调用即可）：

| 钩子 | 作用 |
|---|---|
| `__nagiTestEmotion(name)` | 按情绪触发表情 + 动作（`calm/smile/joy/puzzled/worry/pout`） |
| `__nagiTestMotion(group)` / `__nagiTestMotion2(group, index)` | 播放指定动作组的动作（后者可指定第几个） |
| `__nagiStopMotions()` | 回待机 |
| `__nagiMotionCatalog()` / `__nagiExpressionList()` | 列出动作目录 / 表情清单 |
| `__nagiTestExpression(name)` | 直接套用某个表情（绕过情绪映射） |
| `__nagiReadParams(ids)` | 采样参数（注意读的是**帧末**值，会被 `loadParameters()` 还原） |
| `__nagiRedParams()` | 当前模型被裁剪掉的红色参数名单 |
| `__nagiProbeRed()` | 在"裁剪已生效、网格尚未计算"的瞬间采样红光参数——验证去红专用 |
| `__nagiFrame()` | 取景/布局诊断（取景带、模型基准尺寸、渲染矩形、包围盒） |
| `__nagiSnapshot()` | 确定性抓帧（同帧 `app.render()` 后 `toDataURL()`，绕开 WebGL 截图空白） |
| `__nagiSetFrame(frame)` | 运行时切换 `'bust' / 'full'`（设置页重启才持久化） |
| `__nagiSetScale(v)` / `__nagiSetMirror(v)` | 运行时改缩放/镜像 |
| `__nagiArtBox()` | 读回当前帧像素求 alpha 包围盒（验证"真实画面有没有越界"） |

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

---

## 十一、互动与存在感（2026-10-14 第二轮增补）

这一轮解决四件事：**她说话不再像念稿**、**待机时够醒目**、**在工作台里也看得见她**、
**能自由演动作**。外加一个顺手挖出来的底层坑。

### 1. 去模板化：让回复跟着上下文走

**问题定位**：不是模型笨，是提示词的问题。用同一句输入连打三次探测云端大脑，三次都
回同一句「……嗯，了解了」，根因是——① 口头禅被硬写成固定台词；② few-shot 示例被模型
原样抄；③ 完全没有上下文（她不知道现在几点、上次聊了什么）；④ 输出合同写死「1~3 句」；
⑤ 对话历史只存在内存里，重启即失忆。

**改法**（固定的是机制，不是句子）：

| 改动 | 文件 | 作用 |
|---|---|---|
| 「此刻」上下文注入 | `src/core/context.js` | 每次请求拼一段 `【此刻】`：日期/星期/时段（凌晨…深夜）/距上次互动多久/当前情绪 |
| 长期记忆 | `src/core/memory.js` + `src/main/persist.js` | 每轮对话后台异步抽取可长期记住的事实（上限 60 条，去重、溢出丢最旧），落盘 `userData/memory.json` |
| 对话历史持久化 | `src/main/persist.js` | `userData/history.json`（上限 40 条），重启后仍记得上次聊到哪 |
| 人格提示词重写 | `src/core/persona.js` | 口头禅降级为「语气参考·声纹」并明说「不是台词表，不要反复用」；去掉「1~3 句」的硬约束；加反复读规则 |
| 防复读选择器 | `src/core/persona.js` | 台词池带 `_recent` 记忆，同一句短时间内不重复；25% 概率换句式 |

效果（实拍）：重复打招呼时她会说——「哼…都说了这么多次，怎么还在重复打招呼？难道
电脑前的你…其实很闲？」，并且真的**调用了 `web_search` 去查"为什么有人会一直重复说你好"**。

默认大脑也从 `hunyuan-chat` 换成 **`deepseek-v4.1-flash`**（实测同等人格提示下复读最少、
最会引用上下文）。设置页可改。

### 2. 桌宠尺寸自由调节 + 待机醒目

- **四种调节方式**：右下角拖拽手柄（等比 2:3）、工具条 `＋/－`、`Ctrl+滚轮`、设置页滑杆；
  范围 200×300 ~ 900×1300，缩放锚定右下角（她不会跑掉），尺寸写回 settings 重启保持
- **待机加成**：3 分钟没互动就自动放大 15% 并换个待机姿势（`Idle` 组），20 秒一次小幅
  概率再动一下；你一碰她就恢复原尺寸。设置页可关（`idleBoost`）

### 3. 工作台里的凪面板

工作台右侧是一块**可折叠、可拖宽**的凪面板（宽度 240–460px，状态记在 localStorage）：
面板头显示当前情绪，下面是她本人（同一套 `live2d.js`，独立渲染进程），再下面是
尺寸滑杆 + **动作清单**（按模型的动作组自动生成按钮，点一下她就演一遍）+ 随机动作/
回待机/镜像。折叠后右侧留一个竖条按钮可展开。

### 4. 自由动作展示

- 动作组从 4 个（Idle/TapBody）扩到 **8 组 20 个动作**：`Idle`(4) / `TapBody` / `Greet` /
  `Happy` / `Sad`(2) / `Angry`(2) / `Frenzy`(2) / `Special`(7)，并补 `FadeInTime/FadeOutTime`
- `nagi-emotion.json` 升级为可带动作的写法：`"joy": {"expr":"nagi_joy","motion":"Happy","motionChance":0.75}`，
  情绪切换时按概率触发对应动作；**只在情绪真的变化时**才带动作（心跳重复广播只换表情，
  否则每 15 秒手舞足蹈一次）
- 说话口型挂在 `internalModel.on('afterMotionUpdate')`——这一帧动作参数刚写完、表情还没
  覆盖，写 `ParamMouthOpenY` 不会被吃掉
- `LipSync` 组从 `[]` 补成 `["ParamMouthOpenY","ParamMouthForm"]`

### 5. 顺手挖出的底层坑：两套 pixi

`pixi-live2d-display@0.4` 依赖的是 **pixi v6**（`@pixi/display` 6.5.10），而本工程用
**pixi.js v7.4.3**——于是模型是 v6 的 `Container`，舞台是 v7 的。v7 的事件系统在每次
`pointermove` 命中测试时会对场景树调 `currentTarget.isInteractive()`，v6 对象没有这个方法，
控制台被 `TypeError` 刷屏（实测一次运行 139 次）。

修法：`app.stage.eventMode = 'none'` 让 v7 直接剪枝整棵树，不再触碰模型；交互全部改由
原生 DOM 事件实现。

**连带发现**：`#pet-root` 原本是整块 `-webkit-app-region: drag`，而拖拽区会把鼠标事件
全部吞掉——**「戳一戳」和 `Ctrl+滚轮` 其实一直收不到事件**。改成：窗口拖动由渲染层用
原生 `pointer` 事件 + `win.moveTo`（新 IPC `window:move`）实现，于是有了更顺的语义——
**抓着她任意部位拖 = 搬家；原地松手 = 戳一下**。

### 6. 顺手修掉：`start-pet.bat` 启动不了

脚本里有中文注释，而 cmd.exe 在默认控制台代码页下会把 UTF-8 字节拆错，整段脚本散成
乱码命令（`'1，会…electron' 不是内部或外部命令`），**双击等于没启动**。已改为纯 ASCII
注释（文件头有注释说明原因，别再塞中文进去）。

### 7. 胸像取景（2026-10-15 增补）

需求：

1. 以后 Live2D 只显示**胸像（上半身）**，不再全身出镜；
2. 工作台里凪面板下方的「尺寸 / 动作」控件栏**不再被双脚/裙摆遮住**；
3. 形象**被约束在自己的 UI 方框内**，各分辨率/面板宽度下都对齐。

**问题定位**：之前 pixi 把 canvas 的 inline 高度写成固定像素，当凪面板被动作清单撑高/压缩时，
舞台高度变了、画布高度没跟上，于是下半身溢出舞台、盖住下方控件栏。另一个坑是
`internalModel.originalHeight` 不稳定（有时返回画布高度、有时返回原点 Y 的一半），直接读它做
layout 会让桌宠窗口变超大特写。

**改法**（固定的是机制，不是某组 magic number）：

| 改动 | 文件 | 作用 |
|---|---|---|
| 取景纯逻辑 | `src/core/frame.js` | `FRAME_PRESETS.bust/full`、`fitBand()` 做 contain 装框；取景带按实测美术范围左右留量，支持偏心（`centerOffset`） |
| 渲染层装框 | `src/renderer/js/live2d.js` | `load()` 时缓存稳定基准尺寸；`ResizeObserver` 监听容器变化并 `layout()`；底部锚定，左右随带 |
| 调试钩子 | `src/renderer/js/main.js` | `__nagiFrame` / `__nagiSnapshot` / `__nagiSetFrame` / `__nagiArtBox`：看取景参数、抓帧、换帧、测真实像素范围 |
| 多分辨率验证 | `scripts/verify-frame.mjs` | 自起隔离实例，把「桌宠 200×300~900×1300」和「工作台面板 240/300/460 + 矮窗/中窗/大窗」跑成矩阵；读回像素确认：① canvas 尺寸 == 容器尺寸 ② 取景矩形在可用区 ③ 真实像素不越出画布 ④ 控件栏在画布之外 ⑤ 取景是胸像 |
| 美术范围探针 | `scripts/probe-art.mjs` | 一次性开发工具：量出 Lisette 的真实绘制范围，用来决定取景带该留多少余量 |

取景带的最终数值（基于 Lisette 实测）：

```js
bust: { left: 0.11, right: 0.95, top: -0.02, bottom: 0.46 }
```

- 左右不对称：Lisette 的美术本身偏右，取景带跟着偏，`centerOffset` 让实际形象落在画面正中；
- 横向留量覆盖静止姿态下头发/手臂的最宽范围，大幅动作时手臂会短暂伸到画布边缘被裁——这是 Live2D 桌宠常态，且**永远不会盖住 UI**：画布被容器 `overflow:hidden` 裁切，UI 是 HTML 绘制在画布之上的；
- `bottom: 0.46` 就是从腰截断，下半身不再出现。

设置页 / 模型目录 `nagi-emotion.json` 里可写：

```json
{ "frame": "full" }
```

临时切回全身查看，默认仍是 `bust`。

**结果**：

- 工作台凪面板无论拖宽/折叠/展开动作列表，画布尺寸始终等于舞台尺寸，下半身不再盖住控件栏；
- 桌宠 200×300~900×1300、工作台面板 240/300/460 各尺寸下，静止姿态时形象四边都有余量，头部完整、无双脚；
- 大幅挥手动作时手臂会到画布边缘（被裁），但不会跑到窗口外、也不会遮住 UI。

**验证**：

- 单测 **236/236**（新增 `test/frame.test.js`：默认胸像 / 取景带覆盖实测美术范围 / 偏心摆正 / contain 不越界 / 安全边距）
- `npm run verify:frame`：自起隔离实例，矩阵 5（桌宠尺寸）×1 + 4（工作台窗口×面板宽度）= **45/45 通过**；每 case 抓整窗截图，确认胸像与控件栏不重叠

![各尺寸/布局下的胸像取景验证矩阵](docs/frame-matrix.png)

> 上图：第一行从左到右是工作台 1400×900 默认面板、1000×640 窄面板、1000×640 宽面板、1180×760 宽面板；
> 第二三行是桌宠 200×300 / 320×480 / 400×600 / 640×960 / 900×1300。均可看到身体从腰部被裁、下半身不再出现，工作台控件栏完整露出。

---

## 十二、去掉「红色形态」（2026-10-14 第三轮）

模型自带一个"红色形态"：整屏红色辉光 + 红眼，闹别扭 / 生气 / 狂暴 / 红眼发光 / 扔剪刀
都会点亮它。需求是**只去掉红色，其余形态与功能一律不动**。

### 它到底是什么

红色完全由 8 个参数驱动（偏离 0 就泛红：正值亮红、负值暗红），**不是贴图、也不是另一套模型**：

| 参数 | 作用 |
|---|---|
| `ParamRedGlow` | 红色辉光强度（主体） |
| `ParamRedGlowMove` / `Sway` / `Sway2` | 辉光的飘动与摇摆 |
| `ParamRedGlowPhysics` / `Physics2` / `Physics3` | 物理输出的伴生值 |
| `ParamRedHighlight` | 辉光高光 |

所以"去掉形态"不需要删任何资源——删表情/删动作反而会连带动到别的形态。

### 怎么去掉的

在渲染层统一拦截：每帧在**所有参数都写完、网格还没计算**的那一瞬间把它们压回 0。

```
motion 写参 → 表情写参 → 目光/呼吸 → 物理 → 【beforeModelUpdate】← 在这里压 0 → 算网格
```

挂在 `internalModel.on('beforeModelUpdate')`（`pixi-live2d-display` 在 `coreModel.update()`
之前派发），动作 / 表情 / 物理三条来源一次全覆盖。

开关的**判定与选参**抽成了纯函数 `src/core/redform.js`（能单测，不依赖渲染环境）：
默认**开启裁剪**——即使模型配置缺失、或换了个自带红色形态的模型，也不会漏；
想给某个模型放行，在它目录的 `nagi-emotion.json` 里写：

```json
{ "removeRedGlow": false }
```

改完重启应用即恢复（不用改代码）。没有红色参数的模型（红参数列表为空）会自动跳过，零副作用。

### 结果

![改前 / 改后对照](docs/red-form-before-after.png)

> 上排 = 改前（闹别扭 / 生气 / 狂暴 / 红眼发光 / 扔剪刀 都泛红）；下排 = 改后（红光消失，
> 生气的神态、暗面、哭泣、剪刀动作全部保留）。

- 闹别扭 / 生气 / 狂暴 / 红眼发光 / 扔剪刀：动作、表情、神态**全部保留**，只是不再泛红
- 动作组仍是 **8 组 20 个**；6 情绪映射、随机动作、工作台动作面板、戳一戳全部不变
- 像素级量化：全部形态的最高鲜红占比 **15.11% → 0.15%**（0.15% 是她本身的暖色高光）

### 修改后怎么切换形态

和以前**完全一样**，没有任何入口被改动：

| 想做什么 | 怎么做 |
|---|---|
| 日常情绪形态 | 自动——她回复时的情绪标签驱动表情与动作（担心/开心/疑惑/闹别扭…） |
| 看当前情绪 | 工作台右侧面板顶部；设置页也会同步 |
| 播放某个动作 | 工作台右侧「动作（点一下她就演）」按 8 个动作组列好按钮，点一下演一遍 |
| 随机来一个 | 面板上的「随机动作」 |
| 回待机 | 面板上的「回待机」 |
| 左右镜像 | 面板上的「镜像」 |
| 戳一下 | 原地单击她（触发 TapBody + 台词气泡） |

也就是说：**红色形态不是"少了一个可选形态"，而是把红色从所有形态里摘掉了**——
原本会泛红的那几个动作仍在列表里、仍能播放，只是演出来不再红。

### 验证

- 单测 **83/83**（新增 `test/redform.test.js`：锁住默认开关、红色参数选取、以及"其余情绪映射与动作组没被删"）
- CDP 实跑采样：`__nagiProbeRed()` 在"压 0 之后、算网格之前"读参数——
  闹别扭 / `Angry#0` / `Frenzy#0` / `Special#6` 全部返回 `{ParamRedGlow:0, ParamRedHighlight:0}`，
  桌宠窗与工作台面板**两份渲染进程都验证过**
- 像素统计：逐形态比对改前/改后。非红色形态红占比不变（约 0.05–0.15%）；
  原红色形态从 7.3%–15.1% 全部回落到 0.03%–0.13%

---

## 十三、活动监测与主动行为（M3，2026-10-14）

到这里，她不再只是「你说话她才应」——她开始**看你在做什么**，并在合适的时候主动开口。

### 她怎么知道你在做什么

- **系统空闲**：Electron `powerMonitor.getSystemIdleTime()`（零依赖，最可靠）
- **前台窗口**：常驻 PowerShell 采样进程 `resources/monitor-sampler.ps1`（P/Invoke 调 `GetForegroundWindow`
  + `GetWindowThreadProcessId`，取进程名与窗口标题），每 5 秒刷新一次
- 窗口信息拿不到时（脚本缺失 / 进程退出 / 输出陈旧）**自动降级为「仅系统空闲」**——
  久坐、离开、回来依然有效，只是少了「在用什么程序」这一维，不会整体失效

> 依赖取舍：`get-windows` 这类 npm 库与 PowerShell 是**同一层能力的二选一**（都是「拿前台窗口」），
> 引入原生模块会让安装与打包都多一层坑，故本项目只走 PowerShell；拿不到就降级，不并行维护两套。

### 隐私三护栏（`src/core/monitor/privacy.js`）

| 护栏 | 做法 |
|---|---|
| **黑名单** | 窗口标题 / 应用名按 `*` 通配匹配（裸词=包含、带 `*`=通配），命中即**丢弃该条样本**，不进统计；默认含密码、银行、支付、无痕等 21 条 |
| **勿扰模式** | 一键停采（设置页开关）。**采集本身即停止**（`collectionAllowed` 在采样前判定，采样进程随之 `dispose`），不只是丢弃结果 |
| **不落盘** | 样本只用于**当场判断**；统计层只保留「应用类别 + 时长」，窗口标题原文不写日记、不进日志、不进 LLM 上下文 |

首次启动会弹一次告知（`privacy.noticeShown`）：「知道了」或「先关掉监测」由你决定，之后在「设置 → 活动监测」里随时改。

### 主动规则（`src/core/monitor/rules.js`）

| 规则 | 触发条件 | 情绪 |
|---|---|---|
| `welcome_back` | 离开 ≥5 分钟又回来 | 微笑 |
| `late_night_awake` | 凌晨 1–5 点还在用电脑 | 担心 |
| `sit_too_long` | 连续盯着屏幕 ≥90 分钟（游戏/视频时让位给对应规则） | 担心 |
| `gaming_too_long` | 连续游戏 ≥60 分钟 | 疑惑 |
| `video_too_long` | 连续看视频 ≥75 分钟 | 疑惑 |
| `deep_focus` | 连续专注工作 ≥120 分钟 | 平静（安静陪着，不打扰） |

规则只决定「该不该开口 + 什么情绪 + 用哪个台词池」，**具体说什么由 persona 的 `proactive` 池即兴挑**
（随机 + 反重复，池子够大所以同类场景不会重复），符合《凪_人格设定》的「引导式自由」原则。

### 节流（`src/core/monitor/throttle.js`）

三道闸，避免打扰感：**全局最小间隔 3 分钟** → **单规则冷却**（8–150 分钟）→ **每日上限**（2–6 次，按本地日期归零）。

### 她开口时

- **桌宠形态**：气泡说一句
- **工作台形态**：进对话流（当作她的一条消息）
- 同时记进**内心独白日记** `userData/monologue/diary-日期.md`
- 正在和你对话时不抢话，只安静记一笔

### 设置入口

「设置 → 活动监测」：开启监测 / 勿扰模式 / 黑名单（每行一条，支持 `*`）。

### 验证

- 单测 **110/110**（`test/monitor.test.js` 26 项：隐私护栏、应用分类、活跃统计、六条规则、三道节流、编排引擎端到端、
  「关闭就停采」与采样脚本契约）
- 无头自测 `NAGI_SELFTEST_MONITOR=1`：注入「凌晨 2:30 + 前台在工作」假样本 →
  第一次 tick 命中 `late_night_awake` 并主动搭话，随后每次 tick 均被节流拦住；
  日记落盘实测写入 `- 23:25 ［担心·35%］ ……屏幕亮着，人却是困的。去休息。`
- CDP 实跑：桌宠窗首次告知弹窗正常渲染（遮罩 + 面板 + 双按钮 368×311），工作台窗不弹；设置页「活动监测」区块可读写

### 真机验证（2026-10-14 晚，真机路径实测）

用**与生产完全相同的 spawn 路径**（Node `child_process.spawn` → `powershell.exe -File monitor-sampler.ps1`）实跑，
证明 P/Invoke 采样在真实环境可用——注意：本开发工具的 Bash / PowerShell 通道会拦 `Add-Type`，
但**应用自己 spawn 的 PowerShell 不受影响**，所以这条路径是能在这里验证的。

实测拿到真实前台窗口样本（应用名 + 标题 + 空闲秒数），链路与编码均正确。

**期间修掉两个真 bug：**

1. **脚本缺 UTF-8 BOM → 中文全乱**。`monitor-sampler.ps1` 原本是无 BOM 的 UTF-8，而 Windows PowerShell 5.1
   无 BOM 时按系统代码页（中文 Windows = GBK）解析脚本：中文注释被拆错字节、甚至吞掉换行，
   令后续语句被并入注释而**静默失效**（加注释后就踩到了）。同时输出侧也按 GBK 编码，
   中文窗口标题到达 Node 变乱码 → **隐私黑名单里的中文规则（`*密码*`/`*银行*`/`*支付*`/`*无痕*`）全部匹配失败**。
   修法：脚本以 **UTF-8 带 BOM** 保存；输出改用 `StreamWriter(Console.OpenStandardOutput(), UTF8)` 直写，
   不依赖 `Console.OutputEncoding`（后者在 stdout 被重定向时并不可靠）。已加单测锁定「必须带 BOM」。
2. **「关闭监测」没有真的停采**。原先 `tickOnce()` 是**先采样、后过隐私闸**，
   于是关闭监测 / 勿扰期间 PowerShell 仍在持续读取窗口标题，只是把结果丢掉——那不算停采。
   修法：新增 `collectionAllowed(privacy)` 并在**采样之前**判定；采样进程也随开关起停
   （`main/monitor/index.js` 的 `syncSampler()` 每次 tick 按设置同步，关闭时 `dispose()` 掉采样进程）。
   另修一处启动顺序：旧设置迁移（`monitorEnabled` 旧默认 false → 新默认 true）原先写在
   `startActivityMonitor()` **之后**，首启会读到旧值而漏采一整个会话，已提前。

诊断抓手：`NAGI_DEBUG_MONITOR=1` 启动，每 tick 打一行 `[monitor:sample]`（应用名 + 标题长度 + 类别，
**不打标题原文**，保持「标题不进日志」原则）。真机上若日志里始终没有出现
`降级为「仅系统空闲」`，即说明窗口采集正常。

---

## 十四、关系层：情绪延续 + 熟悉度 + 情绪时间线（S4，2026-10-15）

M2 的情绪与 M3 的主动关心，**一关就归零**——每次开机她都是陌生人，"关心"也没有累积感。
S4 补的正是这一环：她记得自己刚才的心情，也记得和你多熟。

### 1. 情绪跨重启延续（`core/emotion/mood.js` + `userData/mood.json`）

`serialize()` / `restore()` 一对纯函数。三条设计约定：

| 约定 | 理由 |
|---|---|
| **离线按同样心跳速率衰减** | 她不在的时候也照常"淡忘"：40 秒后回来只掉两步（0.80 → 0.62），一夜回来直接归零。与运行时行为一致，也就不会出现"三天前的闹别扭还挂在脸上" |
| **开机视作刚见过一面** | 冷落计时重新起算。否则每次重启都会立刻闹别扭——那只是技术事件，不是社交事件 |
| **跨天重置深夜标记** | "今晚已经担心过"不该跨天继承；连聊窗口里过期的时间戳一并丢弃 |

`lastInteraction` 保留真实值——「此刻」上下文里那句"距离上次和他说话：8 小时前"是真的。
落盘带限流：情绪换脸或刚互动过**立刻**写，纯强度衰减 30 秒最多写一次。

### 2. 熟悉度（`core/relation/familiarity.js` + `userData/relation.json`）

由「相识时长 **0.3** + 活跃天数 **0.4** + 互动次数 **0.3**」三条饱和曲线加权成 0~1 的关系分，
分五档：**陌生 / 认识 / 熟悉 / 默契 / 深交**。

- **用活跃天数而不是天数**：装完放半年不用，不该算熟
- **每档自带一句行为约束**，随「此刻」上下文一起下发 —— 落实人格设定里
  「熟悉度门槛不装亲密」那条护栏（陌生档明确写着"别装作很熟"）
- 互动 = 他说话 / 戳她；**主动搭话不算**（那是她开口的）

### 3. 情绪时间线（`core/relation/timeline.js` + `userData/timeline/YYYY-MM-DD.json`）

状态机每 15 秒心跳一次，全记下来一天 5760 个点。采样规则：情绪切换**必记**；
同情绪只在强度变化 ≥0.15 且距上一点 ≥1 分钟时才记；单日上限 600 点。保留 30 天
（启动时清理，单次最多删 20 个文件）。

### 4. 关系页

工作台侧栏「看看我们的关系」→ 熟悉度等级与进度条、认识天数 / 互动次数 / 活跃天数 / 她记得几条，
**今日 24 小时情绪色带**（0/6/12/18/24 刻度）、近 7 天迷你柱、六色图例。
色带用的是与主进程**同一份** `toSegments()`，避免两处各算各的。

### 验证

- 单测 **141/141**（新增 `test/relation.test.js` 28 项 + `test/context.test.js` 关系行 3 项）
- `npm run verify:s4` 走真实 electron 进程 + 隔离 `--user-data-dir`，**9/9 通过**：
  短离线延续并衰减（0.80 → 0.62）、长离线归零、聊天后情绪落盘、时间线有采样点、
  重启延续（微笑 48%）、关系统计累加、过期时间线被清理
- CDP 实跑关系页：熟悉度 60% / 「熟悉」档、四项统计读数正确、今日色带 11 段 6 色且
  段宽累加 **100.0%**、近 7 天 7 格、图例 6 项

### 没做的：记忆碎片剧情

需求里 S4 还有"记忆碎片"，但它要做「身世解锁 UI + 触发条件」，而**剧情大纲至今没写**
（`下一步待办清单_v1.md` 的 A2 仍空）——没有大纲，碎片内容就是空壳。
本轮只把它依赖的数据底座（相识时长 / 活跃天数 / 互动次数）先落好，等大纲定了再接。

---

## 十五、工作台增强（M4，2026-10-15）

语音（M5）暂时跳过，先把「她真能帮你干活」从能用变好用。三件事：**替你记事（日程提醒）**、
**干活有交代（工具卡片）**、**能开新话题（新对话）**。

### 1. 日程提醒：她替你记着的事，到点由她开口

需求 FR-3 能力清单里最后一块空白。你说「三点提醒我开会」「十分钟后提醒我喝水」「每天早上九点提醒我吃药」——
**这不是系统闹钟，是她替你把这件事记下了，到点由她张嘴叫你**。

- **自然语言时间**（`core/reminders/schedule.js`，纯函数）：相对（`10分钟后`/`半小时后`/`一会儿`）、
  绝对（`明天9:00`/`下午3点半`/`今晚8点`/`周五十点`/`中午1点`/`明天早上`）、
  ISO 日期（`2026-10-20 09:00`）、纯数字时间戳（**10 位按秒、其余按毫秒**，自动判别）；识别不了会明确报错，不瞎猜
- **三态重复**：一次 / 每天 / 每周。重复项触发后**推进到下一次**（错过的多次只推一次，不补偿）
- **「不能错过」语义**：到点的提醒即使你正开着工作台对话，她也会开口（`force=true`）；
  活动监测的主动搭话则相反（你在聊就不抢话）。两者共用同一个 `saySomething()` 出口
- **落盘**：`userData/reminders.json`（上限 100 条，溢出先丢已完成的）
- **错过太久的自动作废**：一次性提醒错过 >12 小时就直接作废——关着应用错过了的事，事后提醒没意义；
  重复提醒不受此限（会被推到下一次）

**她怎么记住"有这几件事等着"**：每次生成回复时，最多 3 条未到期的提醒会作为一行注记拼进「此刻」上下文，
所以她会自然地提到"你还让我 3 点提醒你开会"。

### 2. 工具执行卡片：干活有交代

对话流里她每调一次工具，不再是干巴巴一行日志，而是一张**卡片**：工具名 + 风险标 + 运行/完成/失败状态 +
一句话结果摘要，可展开看完整参数与返回。工具调用对她和你都变成"看得见的一步"。

### 3. 多会话（新对话）

输入框旁「新对话」按钮：一次点击**清空短期对话上下文**（`userData/history.json` + 内存历史），
但**长期记忆、关系、情绪、日程一律保留**——相当于"换个话题重新开始"，而不是"忘了你"。

### 4. 日程面板

工作台侧栏「她的日程」→ 独立面板：列出全部提醒（时间 / 剩余 / 重复标注 / 完成态），
可直接**手动加一条**（内容 + 时间 + 重复）或删除。面板数据与她的调度器读的是**同一份** `reminders.json`。

### 涉及文件

| 层 | 文件 | 作用 |
|---|---|---|
| core | `reminders/schedule.js` | 时间解析 / 到期判定 / 重复推进 / 展示格式化（纯函数，可单测） |
| main | `reminders.js` | 落盘 + 定时检查（默认 20s）+ 到期回调 + 工具三件套 |
| main | `agent.js` | `handleReminderDue` + `saySomething({force})` + 上下文注入 |
| core | `tools/registry.js` | `reminder_add` / `reminder_list` / `reminder_cancel`（全 LOW 风险） |
| renderer | `js/ui.js` + `chat.js` | 工具执行卡片；`js/main.js` 日程面板 + 新对话 |

### 验证

- 单测 **163/163**（新增 `test/reminders.test.js` 18 项 + `test/registry-files.test.js` 4 项）
- `npm run verify:m4` 真实 electron 进程 + 隔离 `--user-data-dir`，**14/14 通过**：
  - 全链路：自测提醒到点 → `[reminder] 到点：…` → `[mood] → smile 0.35 (reminder)` →
    日记 `- HH:MM ［微笑·35%］ …` → `reminders.json` 写入 `firedAt`/`doneAt`
  - 重复提醒触发后 `at` 整日步进（前移 48h）且未完成；错过 13h 的一次性提醒被作废且**没有打扰用户**；
    未到期的保持原样；只有真正到点的事进了日记
- CDP 实跑：日程面板 **9/9**（开面板 / 空态 / 加一条 / 列表顺序 / 时间列 / 重复标注 / 双操作按钮 /
  非法时间被拒 / 删除生效），工具卡片与「新对话」**11/11**（卡片生成 / 展开参数 / 结果摘要 /
  状态标记 / 新对话清空消息流但不清记忆 / 日程列表与空态切换）


