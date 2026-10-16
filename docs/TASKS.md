# 凪 Nagi 待办：TASKS

## 当前状态（先读）

- **2026-10-16 起为单人开发制**：ChatGPT 侧额度耗尽，WorkBuddy 全权接手。原双工具红蓝边界废止；架构契约、安全门与人格硬约束继续有效（见 [DECISIONS](DECISIONS.md) 与 [实感架构契约](实感架构契约.md)）。
- 源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。最新验证基线（2026-10-16 BLUE-1 后，Node 24.19.0）：全量测试 **409 项，408 通过、0 失败、1 跳过**（跳过为无符号链接权限环境项）；`npm run build` 退出 0；`verify-presence` 11/11、`verify:s4` 9/9、`verify:m4` 19/19（BLUE-1 未改 presence 核心，真机三项沿用 RED123 收口结果）。
- **2026-10-17 工作区实测（含 BLUE-4 不完美机制，非干净基线）**：Node 24.19.0 全量 **512 项 511 通过、0 失败、1 跳过**；`npm run build` 退出 0；`npm run verify:imperfection` **8/8**（120 天 seeded 模拟，重要事项 720/720 零漏送）、`npm run verify:imperfection:ui` 真机 **4/4**；`npm run verify:notes` 真机 12/12、`npm run verify:rhythm` 真机 15/15。
- **2026-10-17 媒体/坐标感知修复（BLUE-5，A/B/C 三级全做）**：真机 `scripts/verify-signals.mjs` **10/10**（授权→真实读取→独立撤销闭环；媒体观测落在网易云音乐「约定 / 王菲」，位置观测经 IP 回退成功）；本次改动相关单测 `music-signal 5/5`、`players 4/4`、`geo-signal 3/3`、`monitor 29/29`。排查报告见 `E:\凪\媒体与坐标感知_排查与修复方案_2026-10-17.md`（诊断脚本在 `E:\凪\diag\`）。
- **2026-10-17 02:16 三次排查（真身确实有两个真 bug，已修）**：截图来自**用户新实例**（PID 31168，01:58:13 启动，build=01:43:27，真实数据目录），即"代码已是修复版仍答不出"。① **凪把自己当成正在播放的媒体**：她说 TTS 时 Chromium 把她注册成 SMTC 会话（`electron.exe` / 标题「凪 Nagi」），`probeMedia` 见"有会话在 playing"即早退 → 真正放歌的网易云被挤掉，且提示词里出现「正在播放：凪 Nagi」→ 模型回「没检测到你播放音频…检查任务栏」；② **兜底探针在负载下超时**：`player-title.ps1` 原来逐个进程名调 9 次 `Get-Process`，负载高时整脚本 >16s（8s 超时+8s 宽限仍被杀）→ `timeout (8000ms)`；`status()` 失败即清空 `last` 且 60s 后才重试 → 这一分钟什么都读不到。修法：自身会话过滤（纯函数三件套 + 数量变化才打日志）、脚本改一次 `Get-Process -Name $wanted`、超时 8s→20s、失败**不清空**上次成功观测（120s TTL 兜底）、监视器自调度（成功 60s / 失败 10s 重试）。证据：真实 settings 副本 + 假 LLM 抓到提示词含 `「Trust Me I'm A Thief」 / The Guggenheim Grotto（来自网易云音乐）`、`【此刻】`块存在；`verify:media-chat` **8/8**（新增"读到的不是凪自己"回归）、`music-signal` 6/6、`npm run build` 退出 0、全量 489/485/3/1（3 项失败仍为本会话 safe-delete 拦截）。详见报告 4.6 节。
- **2026-10-17 01:40 二次排查（用户复测仍失败）**：根因**不是**代码——是**应用没有退出重启**。证据：Electron 主进程 PID 18888 启动于 00:11:30（全部子进程 ParentProcessId=18888），而 `out/main/index.js` 是 01:28:18 才构建的，改动源码也都在 01:02–01:14；`requestSingleInstanceLock()` 使「再点一次启动」只会唤起旧窗口。同一时刻直接跑 `resources/music/player-title.ps1` 能读到网易云「Monster (Album Version) - Meg & Dia/Dia Frampton」，说明数据源正常。次因：`geo.json` 不存在（坐标从未授权，属设计内的预期空值）。处置：① 代码加 `writeBootStamp()`（`userData/boot.json` 记 pid/构建时间，一眼判陈旧）；② 新增 `scripts/verify-media-chat.mjs`（`npm run verify:media-chat`，端到端 + 陈旧自检）。详见 `E:\凪\媒体与坐标感知_排查与修复方案_2026-10-17.md` 第四节。
- **2026-10-17 收尾复核（Node 24.19.0，便携版在 `/e/凪/.tools/node24/node-v24.19.0-win-x64`，须正斜杠前置 PATH）**：全量 **442 项、438 通过、3 失败、0 取消、1 跳过**；`npm run build` 退出 0。3 项失败逐条核对均为**本会话工具层环境项**、与产品代码无关：`ledger-actions`「纠错与忘记清理…重启不复活」被 safe-delete 批量守卫拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，count 55 > threshold 50）、`companion-main`「打扰预算落盘」与 `ledger`「旧数据只索引原件」被 safe-delete 的 trash 二进制超时拦截（`genie-trash win32-x64.exe ETIMEDOUT`）。另：`pose-guard`/`rhythm-pose` 的模型实扫项在模型换装（Lisette→Maine 归档）后已由并行会话改为扫 `models-archive/`，当前 26/26 全绿（见 FIX-5）。对照：Node 22 下同一套件为 437 项/406 通过/15 失败/12 取消，多出的失败全是 `The requested module 'electron' does not provide an export named 'app'` 的 mock 兼容问题——**全量必须用 Node 24 跑，Node 22 结果不可采信**。
- **2026-10-17 形象换装收尾（缅因妹妹 Maine 成为唯一生效模型）**：全量（Node 24）**442 项、441 通过、0 失败、1 跳过**（上一轮 3 项 safe-delete 环境失败本轮未复现）；`npm run build` 退出 0；`npm run verify:maine` **7/7**（501 参数 / 3 贴图 / 物理 true / 口型 true、36 表情、6 情绪映射全命中、5 动作组可播、36/36 表情可应用、不透明像素 33.4%、0 控制台报错）；美术范围探针定出 Maine 专属取景带，拟合 0.095→0.139；**真机** `npm run verify:maine-live` **6/6**、`npm run verify:frame` **45/45**（Electron 需 `NAGI_RENDERER_SANDBOX=0`，此前"GPU 起不来"是漏了这个开关的误判，已更正）。决策记 D14/D15（见 [DECISIONS](DECISIONS.md)），仅剩真人观感待用户，记 B22。
- **2026-10-17 未提交工作收口（分四组提交：安全门放宽 / BLUE-5 媒体坐标 / 缅因换装 / 启动标记）**：Node 24.19.0 全量 **512 项、511 通过、0 失败、1 跳过**（跳过为无符号链接权限环境项）；`npm run build` 退出 0；真机 `npm run verify:media-chat` **8/8**（首条即 boot.json 构建时间自检，确认实例非陈旧）、`npm run verify:signals` 10/10、`verify:maine` 7/7、`verify:maine-live` 6/6、`verify:frame` 45/45。四组提交：`c4b9edc` 只读观察类免确认、`f184c53` BLUE-5、`afbc0c8` 缅因、`b572b62` 启动标记（本条为第 5 个，仅文档）。
- 记录规则：完成必须有实际结果（测试命令/退出码/跳过数）；尝试、模拟通过、人工通过分别记录；未验证写「未验证」；待真机项不得标完成。
- 本机环境：测试/真机验证须将 Node 24 目录前置 PATH（`export PATH="/e/凪/.tools/node24/node-v24.19.0-win-x64:$PATH"`，**正斜杠**，反斜杠会被 Git Bash 转义吃掉 → 实际跑成默认的 node 22，会令 15 个 electron mock 相关测试假失败）；受限环境真机验证加 `NAGI_RENDERER_SANDBOX=0`（GPU 进程沙箱内 0xC0000005 崩溃）；手动起 electron 先 `unset ELECTRON_RUN_AS_NODE`。

```text
任务 ID / 状态：
基准提交 / 改动文件 / 用户可感知变化：
测试命令 / 退出码 / 通过、失败、跳过：
剩余风险 / 待真机项：
下一步 / 前置条件：
```

## A. 实感系列（当前主线）

| ID | 状态与范围 | 完成标准 / 证据 |
|---|---|---|
| RED-1 实感总契约 | ✅ 已完成并验证（2026-10-16） | `docs/实感架构契约.md`：模块签名/schema/配置/两处 hook/BLUE 设计齐全 |
| RED-2 实感核心 | ✅ 已完成并验证（2026-10-16） | `core/presence/{circadian,away,reunion,engine,hooks}.js` + main 接线 + 3 个测试文件 + `scripts/verify-presence.mjs`；epoch 失效补丁补验通过（`presence-store.test.js` 5/5）；全量 397/396/0/1、构建 0、真机 11/11 |
| RED-3 不完美机制方案 | ✅ 方案已成文（契约第 5 节），业务未实现 | 零遗忘保证、概率门、低气压、补救回路、配额；BLUE-4 的输入 |
| BLUE-1 语音情绪参数映射 | 🔧 代码完成，待真机试听迭代（2026-10-16） | 已建 `core/voice/voice-profile.js`（纯函数：情绪×强度+时段+语气 → `{voice,rate,pitch,volume}`，数值集中在 `VOICE_PROFILE` 常量表）+ `main/extensions/voice-profile.js`（glob 自动加载，经 `registerVoiceParamsProvider` 接线，**未改 voice 编排本体**）+ 设置页「语音情绪映射」开关（`presence.voiceProfileEnabled`，默认 false）；单测 12 项全绿（情绪×时段方向性、夜晚必降音量、强度幅度、null/异常安全回退、hooks 校验域兼容、SAPI 无 pitch 基准、用户偏移折叠）；全量 409/408/0/1、构建 0；试听清单已交用户，按反馈只改常量表 || BLUE-2 时段表现与设置页 | ✅ 已完成并真机验证（2026-10-17） | 实现 `core/presence/rhythm-pose.js` 纯映射：night/afternoon 参数叠加预设 + 模型参数过滤 + 抑制随机待机 + 归来便签入口门；`renderer/js/live2d.js` 加 `beforeModelUpdate` rhythmHook（与 redGuard/poseHook 三 hook 叠加，add 指数平滑）；`renderer/js/presence.js` 订阅主进程广播并驱动 `applyCurrentRhythm` / `onReunion` 入口；`renderer/js/main.js` 设置页「陪伴·时间感」与「高级」「打扰控制」「隐私」接线（时段表 5 边界编辑器、保存前 core 预校验、非法递增/阈值倒挂拦截）；单测 `test/rhythm-pose.test.js` 19 项；真机 `npm run verify:rhythm` **15/15**。设置页表单、时段表保存、非法边界/阈值拦截、隐私按钮真机验证通过 |
| BLUE-3 环境留痕 | ✅ 已完成并真机验证（2026-10-17，外部写入按设计未开放） | 3a：`core/presence/notes.js` 候选闸（三类可信事实 + 幂等 + 每天≤3 + 间隔≥30min + 勿扰不展示 + 默认关闭 + 不虚构正文）+ 应用内查看器（工作台/桌宠入口，只读列表，如实标注「外部写入暂未开放」）；3b：`core/presence/traces.js` 规范化（白名单字段/240 字截断/幂等/条数与天数上限/`completionVerified` 恒 false）+ `main/extensions/traces.js` 接线 + `main/presence-notes.js` 落盘（默认不创建、关闭即清内存并删文件）；3c：`core/presence/anchors.js`（来源重验 + 熟悉度门槛 + ≤5% + 每天≤1 + 无锚点不掷骰），查看器只读展示、不自动开口；3d：`core/presence/ha-rules.js` 接口位（默认禁用、只产候选、逐次授权标记、不接受外部覆盖字段）。测试：`test/notes.test.js` 16 项 + `test/anchors.test.js` 16 项 + `test/notes-store.test.js` 12 项；真机 `npm run verify:notes` **12/12** |
| BLUE-4 不完美机制 | ✅ 已完成并验证（2026-10-17） | `core/presence/imperfection.js` 纯策略：`classifyIntention`（默认 important；提醒/日程/截止时间/时间敏感/强调/敏感领域一律重要）+ `decideOptionalFollowup`（概率门只在可选表达层：概率上限 10%、默认 0、每天≤1 次、同一候选只判一次、10 分钟可恢复、重要项分支不调用随机数）+ 低气压（opt-in、非忙碌非危机、24h 一次、10–30 分钟自然恢复、安慰最多减半且每段一次、不碰互动计时）+ 补救回路（停/负面/越界识别，立即停止、每天 1 次间隔 6h、被勿扰压制仍保持停止、无辩解不求原谅）+ 每日配额与全局关闭清缓存。`main/extensions/imperfection.js` 接线：侧车状态仅内存，概率门接在**归来开口**这一可选表达入口（`agent.js handleReunion` 一处，默认概率 0 → 行为不变）。**未改 reminders 调度、承诺证据语义或安全门**，也不提供可拦截 onDue 的接口。测试：`test/imperfection.test.js` 23 项；`npm run verify:imperfection` **8/8**（120 天 seeded 模拟：重要事项 720/720 零漏送、延迟率 6.18%≤10%、每日峰值 1）；真机 `npm run verify:imperfection:ui` **4/4** |
| BLUE-5 媒体与坐标感知 | ✅ 已完成并真机验证（2026-10-17） | 根因：①网易云桌面端（Qt/Win32）不注册 SMTC 会话，而旧实现只读 `GetCurrentSession()` 单会话 → 曲目全丢；②`musicContext()` 非 playing 一律不产出 → 暂停/停止/未知三态盲；③坐标能力从未实现。修法（A/B/C 三级全做）：A `resources/music/smtc.ps1` 改 `GetSessions()` 全量枚举 + `core/signals/music.js` 重写（`pickActiveSession` 按 playing>paused>stopped>unknown 排序选主会话，四态均出 context，无会话时明确说「没在播放」）；B 新增 `core/signals/players.js` + `resources/music/player-title.ps1`（`Get-Process.MainWindowTitle`，兼容最小化窗口）作窗口标题兜底，与 SMTC 按优先级合并；C 新增 `core/signals/geo-store.js` + `main/signals/geo.js`（WinRT Geolocator 优先，本机不可用→ipwho.is/ip-api 回退）+ `main/ipc/geo.js` + 设置页「位置信号」区。附带修：`core/monitor/privacy.js` 加 `repairBlacklist()` 修复用户设置里 GBK 乱码中文隐私规则失效；媒体探针纳入 `serialize()` 串行队列。新增/扩展测试 `test/{music-signal,players,geo-signal,monitor}.test.js`：单文件 `music-signal 5/5`、`players 4/4`、`geo-signal 3/3`、`monitor 29/29`；`npm run build` 退出 0；真机 `verify-signals` **10/10**；**端到端 `npm run verify:media-chat` 7/7**（探针→提示词→模型→界面闭环 + 陈旧实例自检）；全量（Node 24）**收口复测 512/511/0/1、0 失败**（2026-10-17 07:52；早前记录的 442/438/3/1 中 3 项失败系本会话 safe-delete 拦截项，收口时已不复现） |
| RED-4 最终复核 | ✅ 已完成（2026-10-17，BLUE-1~4 全部完成后） | 复核报告 `docs/verify/RED-4复核_2026-10-17.md`。结论：契约符合性 通过（红区文件在 BLUE 期间 0 次改动）、hook 未被绕过（扩展只经 api.*、dispose 注销、无新增周期 timer）、配额生效（便签 3/天+30min、留痕 200/7天、锚点 ≤5%+1/天、可选延迟/低气压/补救各 1/天）、无人设硬约束违背（违禁扫描仅命中规则注释；无催促/挽留/愧疚/索取安慰；不谎称外部效果与遗忘）。验证：全量 512/511/0/1、构建 0、`verify:imperfection` 8/8、`verify:imperfection:ui` 4/4、`verify:notes` 12/12、`verify:rhythm` 15/15 |

## 待观察项（用户反馈，暂不改动）

| ID | 反馈与初步判断 | 处置 |
|---|---|---|
| OBS-1 情绪外显度不足 | 2026-10-17 用户真机初听 BLUE-1 反馈：凪的情绪起伏偏弱、整体过于含蓄；初步判断成因可能在角色设定侧（台词风格、情绪阈值或语气处理方式限制了情绪外显），而非语音参数表本身 | **暂不修改角色设定或台词**（本条即记录该决定）。后续环节（BLUE-2 表现层、BLUE-4 不完美机制、RED-4 复核）重点复核情绪表达是否足够鲜明、可辨识；若确认存在，再从情绪分层、语气强度、表现方式等方向评估针对性调整 |

## B. 安全债（高优先，随时可做）

| ID | 状态与范围 | 完成标准 / 证据 |
|---|---|---|
| FIX-1 HA extra 覆盖漏洞 | 待修（复现已成立，`docs/verify/b06-ha-extra-20261016.json`） | `planHomeService` 中 `extra.entity_id` 可覆盖已核验目标：确认框显示 `light.living_room`、实际对 `lock.front_door` 下达 `light.turn_off`。修法（建议方向）：extra 白名单且 `entity_id` 最后写入不可覆盖（或移除 extra 透传）；确认描述与结果摘要改读 post-plan；brightness 分支展开方式统一。修后补假客户端回归（断言 `plan.data.entity_id === args.entity_id`） |
| FIX-2 R01 外部进程替换竞态 | 未修（用户曾同意保留，现按安全债排队） | `run_command`/`open_app` 替换外部进程路径的检查/使用竞态；先复现再修；不宣称安全隔离完成 |
| FIX-7 自身媒体会话污染 | ✅ 已修（2026-10-17 02:16） | 她说 TTS 时 Chromium 把她注册为 SMTC 会话（AUMID `electron.exe`/打包态「凪 Nagi.exe」，标题=产品名），探针把它当"正在播放的媒体"→ 挤掉真播放器 + 提示词出现「正在播放：凪 Nagi」。修：`core/signals/music.js` 新增 `selfSessionIds/isSelfSession/filterSelfSessions`（按 AUMID 匹配可执行文件名与产品名，大小写不敏感），`main/signals/music.js` 合并前过滤、全过滤则按 no-session 落兜底。证据：单测新增 1 项（`music-signal` 6/6）、`verify:media-chat` 新增断言「读到的不是凪自己」通过 |
| FIX-8 兜底探针超时 + 重试过久 | ✅ 已修（2026-10-17 02:16） | `player-title.ps1` 逐个进程名调 9 次 `Get-Process`，负载高时 >16s 被误判超时 → `timeout (8000ms)`；`status()` 失败清空 `last` 且 60s 才重试。修：脚本改一次 `Get-Process -Name $wanted`（数组形式，隐私边界不变）、探针超时 8s→20s、失败**不清空**上次成功观测（120s TTL 自然过期）、监视器自调度（成功 60s / 失败 10s 重试）、`status()` 增 `lastError` 字段便于解释"为什么这次没数据"。证据：真实 settings 副本复现前后对比、`verify:media-chat` 8/8 |
| FIX-6 陈旧实例致「修复无效」 | ✅ 已处置（2026-10-17 01:40） | 主进程 00:11:30 启动后一直跑修复前的 `out/main/index.js`，加上单实例锁，用户以为重启过其实没有 → 复测全线失败。处置：`src/main/index.js` 加 `writeBootStamp()`（落 `userData/boot.json`：pid/startedAt/构建时间 + `[boot]` 日志），`scripts/verify-media-chat.mjs` 首条检查即断言「boot.json.build == out/main/index.js mtime」。**流程纪律**：以后改主进程代码 → `npm run build` → 必须**彻底退出凪**（托盘→退出 / 结束 electron.exe）再启动，关窗口或再点启动都不算 |
| FIX-5 模型归档致测试 ENOENT | ✅ 已澄清（2026-10-17，非缺陷） | 已确认是**有意换装**：主模型改为「缅因妹妹 Maine」，Lisette/Mao 归档到 `models-archive/`；对应测试（`test/pose-guard.test.js`、`test/rhythm-pose.test.js`）已改为在归档目录实扫并带 skip 兜底（并行会话于 01:36 完成）。当前 `pose-guard`+`rhythm-pose` 26/26 全绿，无需再动 |
| FIX-4 隐私黑名单 GBK 乱码失效 | ✅ 已修（2026-10-17，随 BLUE-5） | 用户 `settings.json` 中中文隐私规则被以 GBK 读入后乱码（如 `*密码*`→`*瀵嗙爜*`），规则形同失效。`core/monitor/privacy.js` 新增 `mojibakeOf()/repairBlacklist()`，加载时补齐正常条目（仅对 `乱码值 !== 原值` 的条目补，避免纯 ASCII 条目误判）；`main/settings-store.js` 载入即修复；`test/monitor.test.js` 补回归。已修证据：`monitor.test.js` 29/29；全量（Node 24）**收口复测 512/511/0/1、0 失败**（早前 442/434/4/4 的环境项已不复现）、构建 0 |
| FIX-3 R03 Playwright 生命周期 | 未修（源码可见风险，未复现） | `core/tools/browser.js`：CDP 成功分支可绕开清理 `starting` 的 finally；旧页面关闭事件操作全局 page；dispose 未清理 starting。先复现（关闭/崩溃/重连/切换页）再修核心生命周期 |

## C. 数据一致性

| ID | 状态与范围 | 完成标准 / 证据 |
|---|---|---|
| B01 持久化中断窗口 | 待修 | `main/persist.js` 临时写入后先删原文件再重命名存在中断窗口；flush 失败未可靠上传结果；`ledger-actions.js` 可能继续报成功。注入写失败/中断/重启，证明账本、RAG、年鉴不再召回旧内容 |
| B02 提醒/承诺恢复补验 | 待补验 | 双文件存储与启动对账已有实现；补中断点测试、失败/取消/完成证据与重启恢复；恢复不得自动重放已执行的外部操作 |

## D. 验收项（需真机/环境/用户）

| ID | 状态与范围 | 完成标准 / 证据 |
|---|---|---|
| B03 本地模型多轮实测 | 待测（Ollama 本机可用） | `scripts/benchmark-local-llm.mjs` + 固定边界集：告别/人格/事实/工具证据/延迟；记录失败样本；提交证据后再议默认切换 |
| B04 语音全链路真机 | 🔧 ASR 根因已修（2026-10-17），**待真机复测** | 根因：userData 非 ASCII → 外部原生子进程 argv 按 GBK 转换失败 → 离线服务启动即退、静默回退 SAPI 产出乱文（见 DECISIONS D13）。已修证据：单测 50/50（新增 3 项）、生产模块真链路识别「能听到我说话吗」正确（服务 1548ms 就绪，全程 1639ms）、`npm run build` 退出 0 且产物含修复。剩余：真实麦克风→识别→模型→首音/停止时间；Edge/SAPI 验收；对照约 1 秒目标 |
| B05 双窗人工 UI | 待用户 | 真实双窗点按确认条全套场景；原生对话框/来源查看/纠错忘记/导出重读/稍后/勿扰/多显示器/隐私黑名单清单；时间感设置页时段表与开关已真机覆盖（`verify:rhythm` 15/15），最终仍待用户日常确认 |
| B07 链接与发行版 | 待环境/排期 | 可创建文件符号链接的环境补跑 symlink 项；安装版/免安装版物理断网、跨重启、撤权、迁移、导出（`阶段10人工验收清单.md`）；保留版本与哈希证据 |
| B20 媒体/坐标人工验收 | 待用户（2026-10-17 代码+端到端已通，等日常确认） | **先做第 0 步：彻底退出凪并重新启动**（单实例锁下关窗口/再点启动都不生效，见 FIX-6；启动后 `userData/boot.json` 的 build 应等于 `out/main/index.js` 的修改时间）。自动验收：`npm run verify:media-chat` **7/7**（含「实例加载的是当前构建」自检）、`npm run verify:signals` 10/10。六条人工清单：① 网易云放歌→问「我在听什么」应答歌名/艺人；② Edge 放视频→问「我在看什么」应答片名；③ 暂停→问应答「暂停」而非「不知道」；④ 授权坐标→问「我在哪」应答城市/坐标且说明是粗略位置；⑤ 撤销授权→再问答「你没让我知道」；⑥ 勿扰开关生效期间全部静默。已知限制：窗口标题兜底只报曲名艺人、**播放状态未证实（`playbackStatus:'unknown'`）**；WinRT Geolocator 本机不可用，坐标走 IP 回退（城市级） |
| B10 RAG 长期容量 | 待数据 | 长期数据量/磁盘碎片/查询延迟/删除后召回；判断是否需调度策略 |
| B09 cloud-config | ✅ 已处理（2026-10-16） | 真实 endpoint/publishableKey 经审查为公开配置（设计进 git），随实感收口提交 |
| B23 外部便签写入安全桥接 | 待办（BLUE-3 明确未开放，界面已如实标注） | 契约 §4 要求：外部便签文件默认关闭、必须复用已有原生目录授权 + 逐次写操作确认、不得从订阅回调直接 fs 写桌面。现只有应用内候选（`externalWriteAvailable:false`）。实现时需把 writer 接到授权根校验与确认流，并补「未授权必须被拒」的安全边界测试 |

## E. 暂停功能（等用户恢复指示，不擅自动）

| ID | 内容 | 前置 |
|---|---|---|
| B11 | 截图/文件多模态记忆入口 | 恢复后沿来源/授权/删除契约 |
| B12 | 日历复杂规则与同步 | 恢复后补真实样例与撤销传播 |
| B13 | 稳定性与启动体验测量 | 先留证据再分阶段 |
| B14 | 可选语音适配器（cloud/GPT-SoVITS） | 用户选服务后接入 |
| B15 | 专属音色制作 | 素材与授权 |
| B16 | 正式美术与 Live2D | 用户确认资源 |
| B17 | 人格叙事细节草案 | 先出草案供用户选 |
| B18 | 后续身世/年鉴/纪念体验 | B17 批准后 |

## F. 维护

| ID | 内容 |
|---|---|
| B19 | 依赖/发行/可再生文件维护；签名发行需真实资源时单独登记；不无目的升级、不清模型与用户数据 |
| B21 ✅ | `models/` 现状核对（2026-10-17 已完成）：Maine 为唯一现行模型、Lisette/Mao 归档到 `models-archive/` 系有意换装；`models/README.md` 已重写、根 `README.md` 模型/取景/命令表章节已同步；`pose-guard`/`redform`/`rhythm-pose` 三个测试改扫归档目录并带 skip 兜底。验收 `npm run verify:maine` **7/7**、全量（Node 24）**441 通过 / 0 失败 / 1 跳过**、`npm run build` 退出 0 |
| B22 🟡 | 缅因妹妹**真人观感**验收（待用户）：自动验收已全绿——`npm run verify:maine-live` **6/6**（真机 Electron 桌宠：取景命中缅因预设、36 表情、6 情绪面容指纹一致、5 动作组参数真的在摆、0 报错）+ `verify:frame` 45/45 + `verify:maine` 7/7。贴图已于 2026-10-17 降到 4096（显存 768→192MB、冷启动 6.4→2.8s，见 B23）。剩下只能人看的：4096 下画质是否满意、桌宠窗内构图审美 |
| B23 ✅ | 贴图降分辨率（2026-10-17 已完成）：三张 8192×8192 统一降到 4096（`scripts/shrink-textures.py`，先 `--scan` 后执行）。磁盘 94.2→13.5MB、显存 768→192MB、冷启动 6.4→2.8s、PSNR 35.8/37.0/32.1dB。原图迁到 `models-archive/Maine-textures-8192/`（未删）。回归：`verify:maine-live` 6/6、`verify:frame` 45/45、`verify:maine` 7/7。注意：稳态帧率在本机验证环境无显著提升（软件渲染，瓶颈不在纹理），已如实记入 DECISIONS D16/D17 |

## 旧待办归并（防重复做）

| 旧来源 | 当前归属 |
|---|---|
| 完善任务书 22 ID 对账（`docs/完善任务对账_2026-10-16.md`） | ✅ S01/S03/S04/D01/D03/U02/V01/V02；🟡 S02(→FIX-1)/S05(agent.js 日志打印记忆原文)/S06(密钥明文降级策略)/D02(→B01)/U01(停止入口+isComposing)/T01(只回喂 summary)/T04(交付 IPC→BLUE-3)/T05(重复失败检测/预算)/U04(稍后提醒/系统通知)/M01(事实键/重要性)/C01(搜索错误分类)；⬜ T02(→FIX-3)/T03/U03 |
| 实感补足任务卡 RED-1~4 / BLUE-1~4 | 见 A 节（RED-1/2/3 已完成） |
| 原 R01/R02/R03 红线包 | R01→FIX-2；R02 契约待 B01/B02/B03 证据后议；R03→FIX-3 |
| 原 B05–B08 | 已完成（见 git log 与 HANDOFF 历史节）；遗留真机项见 D 节 |
| 原 B09–B19 | 见 C/D/E/F 节 |

## 下一步

按 A→B→C→D 顺序推进：BLUE-1 代码已完成（等用户真机试听反馈迭代常量）；BLUE-2 已完成并真机 15/15；**BLUE-5 媒体与坐标感知已完成并真机 10/10，待用户按 B20 六条清单日常确认**。下一步 BLUE-3（环境留痕）；安全债 FIX-1（HA extra）随时可插入修复。缺账号/素材/设备不阻塞独立工作，待真机项不标完成。
