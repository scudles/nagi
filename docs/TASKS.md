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
- **2026-10-17 表情映射命名空间修复（D37，B31）**：`__nagiResolve` 逐个解析 6 个情绪键，发现 `smile`/`worry` 返回 **null** —— 这两张脸从来没有任何路径能显示，且不抛错不打日志（纯静默）。根因：`nagi-emotion.json` 填的是表情**文件名**（`blush`/`nervous_sweat`），而 `resolveExpression` 按 `model3.json` 的表情 **Name** 匹配（这两个的 Name 是「脸红」「紧张汗」）。修法：映射改真名（`smile → nagi_smile` 定制的日常微笑，原先错绑"脸红"等于每次打招呼都满脸通红；`worry → 紧张汗`）、`nagi-face.json` 肌肉表键对齐（`nervous_sweat → 紧张汗`、`blush → 脸红`）、「脸红」保留为 `blush` 非情绪键入口（预留"被夸奖→脸红一下"瞬时反应）、**静态锁进单测**（映射里每个 expr 必须是模型里真实存在的 Name + 必须有肌肉向量——这把锁在修订过程中真的抓到了一次键名不一致）。证据：`verify:face` **10/10**（解析链 `smile→nagi_smile`/`worry→紧张汗` 全命中；I 项「紧张睁大眼 1.00」恢复；A 项 7 情绪含新入口）；全量单测 **667 项 665 通过 / 1 已知环境噪音（safe-delete 守卫，非代码缺陷）/ 1 skip**；`test/face-expression.test.js` 44 项全绿。仅动配置与测试，无渲染层代码变化，桌宠重启（或重载模型）即生效。
- **2026-10-17 全量回归与验收自身修复（D38~D40，B32）**：D37 之后跑全量回归，暴露并修掉五类"验收自身"的问题：① verify:turns A/C 像素判据在低帧率+物理余震下假失败 → 改读 `__idleHeadLast` 写入值并带 **seq 序号**只认新鲜帧（钩子早退时的陈旧残留是关窗读到 \|z\|=4.68° 的根因）；② D 项读 DOM 气泡全空还假通过 → 渲染层 `EVT.PET` 记历史 `__nagiPokeBubbles`，判据加 `spoken>=6`；③ verify:face H 阈值 0.35 卡在游走分布均值上（6 秒窗实测 0.24~0.34）→ 窗口拉到 10 秒（实测 0.59~0.67），阈值不动；④ **产品层真 bug（D39）**：姿态（思考）激活时眼球游走用 set 覆盖了姿态的 add 写入——思考时目光会自己飘走（实测 ΔEyeBallX=0.468≠0.35）→ `eyeWanderHook` 加 `if (poseState) return` 让位，验收侧同步按住游走；⑤ **验收脚本腐烂（D40）**：verify:maine / verify:maine-live 的情绪映射硬编码还是 D37 前的 `smile→脸红`（静默漂移）→ 改为从 `nagi-emotion.json` 实读；verify:pose 是全仓唯一漏 `NAGI_RENDERER_SANDBOX=0` 的脚本（"桌宠页未就绪"连续超时的根因）→ 补上。**最终全绿证据**：全量单测 **667 项 666 过 / 0 败 / 1 skip**（live2d.js 改动后复跑）；`verify:face` **10/10**（两次）、`verify:turns` **5/5**（两次，含数值判据下的新鲜帧计数）、`verify:ambient` **14/14**、`verify:pose` **13/13**（ΔEyeBallX=0.3500 精确命中、收回 0.0000 归零）、`verify:maine` **7/7**（C 项如实显示 smile→nagi_smile）、`verify:maine-live` **6/6**（同上，smile 差分 6.3%）、`verify:reaction` **5/5**。删除一次性探针 `probe-turns-a.mjs` 与死代码 `sample()`。
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
| BLUE-1 语音情绪参数映射 | 🔧 代码完成，待真机试听迭代（2026-10-16） | 已建 `core/voice/voice-profile.js`（纯函数：情绪×强度+时段+语气 → `{voice,rate,pitch,volume}`，数值集中在 `VOICE_PROFILE` 常量表）+ `main/extensions/voice-profile.js`（glob 自动加载，经 `registerVoiceParamsProvider` 接线，**未改 voice 编排本体**）+ 设置页「语音情绪映射」开关（`presence.voiceProfileEnabled`，默认 false）；单测 12 项全绿（情绪×时段方向性、夜晚必降音量、强度幅度、null/异常安全回退、hooks 校验域兼容、SAPI 无 pitch 基准、用户偏移折叠）；全量 409/408/0/1、构建 0；试听清单已交用户，按反馈只改常量表。**2026-10-17 已按 OBS-1 加大幅度**（两极语速差 16→31、任意两情绪至少一轴 ≥5、night 音量 −28→−34）+ 单测补「幅度下限」断言，`voice-profile.test.js` 13/13（D41）。⚠️ 开关 `presence.voiceProfileEnabled` 默认 false，**默认路径仍是 `MOOD_SPEECH`**，本表改动在默认配置下听不到 —— 是否同步拉大 `MOOD_SPEECH` 或改默认开关，待用户裁决 || BLUE-2 时段表现与设置页 | ✅ 已完成并真机验证（2026-10-17） | 实现 `core/presence/rhythm-pose.js` 纯映射：night/afternoon 参数叠加预设 + 模型参数过滤 + 抑制随机待机 + 归来便签入口门；`renderer/js/live2d.js` 加 `beforeModelUpdate` rhythmHook（与 redGuard/poseHook 三 hook 叠加，add 指数平滑）；`renderer/js/presence.js` 订阅主进程广播并驱动 `applyCurrentRhythm` / `onReunion` 入口；`renderer/js/main.js` 设置页「陪伴·时间感」与「高级」「打扰控制」「隐私」接线（时段表 5 边界编辑器、保存前 core 预校验、非法递增/阈值倒挂拦截）；单测 `test/rhythm-pose.test.js` 19 项；真机 `npm run verify:rhythm` **15/15**。设置页表单、时段表保存、非法边界/阈值拦截、隐私按钮真机验证通过 |
| BLUE-3 环境留痕 | ✅ 已完成并真机验证（2026-10-17，外部写入按设计未开放） | 3a：`core/presence/notes.js` 候选闸（三类可信事实 + 幂等 + 每天≤3 + 间隔≥30min + 勿扰不展示 + 默认关闭 + 不虚构正文）+ 应用内查看器（工作台/桌宠入口，只读列表，如实标注「外部写入暂未开放」）；3b：`core/presence/traces.js` 规范化（白名单字段/240 字截断/幂等/条数与天数上限/`completionVerified` 恒 false）+ `main/extensions/traces.js` 接线 + `main/presence-notes.js` 落盘（默认不创建、关闭即清内存并删文件）；3c：`core/presence/anchors.js`（来源重验 + 熟悉度门槛 + ≤5% + 每天≤1 + 无锚点不掷骰），查看器只读展示、不自动开口；3d：`core/presence/ha-rules.js` 接口位（默认禁用、只产候选、逐次授权标记、不接受外部覆盖字段）。测试：`test/notes.test.js` 16 项 + `test/anchors.test.js` 16 项 + `test/notes-store.test.js` 12 项；真机 `npm run verify:notes` **12/12** |
| BLUE-4 不完美机制 | ✅ 已完成并验证（2026-10-17） | `core/presence/imperfection.js` 纯策略：`classifyIntention`（默认 important；提醒/日程/截止时间/时间敏感/强调/敏感领域一律重要）+ `decideOptionalFollowup`（概率门只在可选表达层：概率上限 10%、默认 0、每天≤1 次、同一候选只判一次、10 分钟可恢复、重要项分支不调用随机数）+ 低气压（opt-in、非忙碌非危机、24h 一次、10–30 分钟自然恢复、安慰最多减半且每段一次、不碰互动计时）+ 补救回路（停/负面/越界识别，立即停止、每天 1 次间隔 6h、被勿扰压制仍保持停止、无辩解不求原谅）+ 每日配额与全局关闭清缓存。`main/extensions/imperfection.js` 接线：侧车状态仅内存，概率门接在**归来开口**这一可选表达入口（`agent.js handleReunion` 一处，默认概率 0 → 行为不变）。**未改 reminders 调度、承诺证据语义或安全门**，也不提供可拦截 onDue 的接口。测试：`test/imperfection.test.js` 23 项；`npm run verify:imperfection` **8/8**（120 天 seeded 模拟：重要事项 720/720 零漏送、延迟率 6.18%≤10%、每日峰值 1）；真机 `npm run verify:imperfection:ui` **4/4** |
| BLUE-5 媒体与坐标感知 | ✅ 已完成并真机验证（2026-10-17） | 根因：①网易云桌面端（Qt/Win32）不注册 SMTC 会话，而旧实现只读 `GetCurrentSession()` 单会话 → 曲目全丢；②`musicContext()` 非 playing 一律不产出 → 暂停/停止/未知三态盲；③坐标能力从未实现。修法（A/B/C 三级全做）：A `resources/music/smtc.ps1` 改 `GetSessions()` 全量枚举 + `core/signals/music.js` 重写（`pickActiveSession` 按 playing>paused>stopped>unknown 排序选主会话，四态均出 context，无会话时明确说「没在播放」）；B 新增 `core/signals/players.js` + `resources/music/player-title.ps1`（`Get-Process.MainWindowTitle`，兼容最小化窗口）作窗口标题兜底，与 SMTC 按优先级合并；C 新增 `core/signals/geo-store.js` + `main/signals/geo.js`（WinRT Geolocator 优先，本机不可用→ipwho.is/ip-api 回退）+ `main/ipc/geo.js` + 设置页「位置信号」区。附带修：`core/monitor/privacy.js` 加 `repairBlacklist()` 修复用户设置里 GBK 乱码中文隐私规则失效；媒体探针纳入 `serialize()` 串行队列。新增/扩展测试 `test/{music-signal,players,geo-signal,monitor}.test.js`：单文件 `music-signal 5/5`、`players 4/4`、`geo-signal 3/3`、`monitor 29/29`；`npm run build` 退出 0；真机 `verify-signals` **10/10**；**端到端 `npm run verify:media-chat` 7/7**（探针→提示词→模型→界面闭环 + 陈旧实例自检）；全量（Node 24）**收口复测 512/511/0/1、0 失败**（2026-10-17 07:52；早前记录的 442/438/3/1 中 3 项失败系本会话 safe-delete 拦截项，收口时已不复现） |
| RED-4 最终复核 | ✅ 已完成（2026-10-17，BLUE-1~4 全部完成后） | 复核报告 `docs/verify/RED-4复核_2026-10-17.md`。结论：契约符合性 通过（红区文件在 BLUE 期间 0 次改动）、hook 未被绕过（扩展只经 api.*、dispose 注销、无新增周期 timer）、配额生效（便签 3/天+30min、留痕 200/7天、锚点 ≤5%+1/天、可选延迟/低气压/补救各 1/天）、无人设硬约束违背（违禁扫描仅命中规则注释；无催促/挽留/愧疚/索取安慰；不谎称外部效果与遗忘）。验证：全量 512/511/0/1、构建 0、`verify:imperfection` 8/8、`verify:imperfection:ui` 4/4、`verify:notes` 12/12、`verify:rhythm` 15/15 |
| 加分项 C 非语言语气音 | ✅ 已完成并单测覆盖（2026-10-17，**默认关闭**） | 新增 `core/voice/backchannel.js` 纯决策层（phase×情绪×时段×勿扰×每日配额×最小间隔×概率 → `{text,kind,reason,state}`，时钟与随机数注入）+ `test/backchannel.test.js` 13 项（出厂默认必须关闭、概率上限 0.3 在代码里夹死、有意留白、勿扰优先于深夜、配额/跨日归零、候选抽取不退化、脏输入安全、状态不可变、全组合扫描）。接线只碰渲染层 `voice.js` 的 `beginReply`/`finishReply`（往既有 `reply.queue` push），**不改 `main/voice` 编排、不新增 IPC/引擎**；设置页加开关 + 概率滑条（0–30%），保存整块写回。**未做轻笑**：文本 TTS 念「呵」是音节不是笑声，真笑声需音频素材（= 新依赖，违反约束），如实记在模块注释（D42）。验证：13/13、构建 0、全量 686/681/1skip（4 项失败经隔离复跑 8/8 全过，系沙箱 safe-delete 守卫）。**真机听感未验证**（默认关闭，需用户开启后自听） |
| B23 外部便签文件写入 | ✅ **已完成并单测覆盖（2026-10-17）**，剩真机走一遍（需用户亲自选目录） | ① **core** `core/presence/notes-file.js`：路径归属硬校验（`..` 穿越**不解析掉**、盘符/UNC、软链逃逸验**目录** realpath）+ 文件名/正文规范化 + 配额沿用 3/天&30min + **记账只在写成功后**（失败不占额度可重试），`test/notes-file.test.js` 13/13（D43）。② **main 桥接** `src/main/notes-file.js`（**全项目唯一 fs 写盘处**）：目录只能由系统选择器选出并立刻 realpath；写入前带真实 realpath 再跑一遍 core 校验；**每次写入都弹原生确认框**（默认焦点"取消"，无"以后都不问"）；`flag:'wx'` 同名已存在即失败，**绝不覆盖**；失败如实返回 reason，界面绝不显示"已保存"；撤销只清授权、**不删已写出的文件**；状态只存内存（重启归零，靠 `wx` 兜底）。`test/notes-file-main.test.js` **8/8**（真实临时目录真写盘）。③ 接线：`shared/notes-protocol.js` 三条 IPC、`preload`、`main/ipc/notes.js`、`presence-notes.js`（`externalWriteAvailable`=能力 / `external.available`=许可）、渲染层便签卡「写到文件夹里」与「已保存到 …」。**默认关闭**（`externalNotesEnabled:false` + 未选目录）。验证：`notes-file-main` 8/8、`notes-store` 12/12、构建 0、全量 **708 项 705 过 / 1 skip**（2 项失败经隔离复跑 1/1、2/2 全过，系沙箱 safe-delete 噪音）（D44/D45） |
| 加分项 D 回忆物时间线视图 | ✅ 已完成并单测覆盖（2026-10-17） | `core/presence/anchors.js` 加 `sortAnchorsByTime` / `groupAnchorsByDay` 纯函数（不改入参、时间缺失排最后且**不补默认值**）+ `test/anchors.test.js` 16 → **21 项**。渲染层「可能想起来的」改为「共同的时间线」：按发生时间倒序、按天加日期小标题（同年只显示月日）、标出「第一次/外号/共同的梗/答应过的事」与信任来源（你说过的/有来源的/她自己的感受）、超过 20 条如实说明只显示最近 N 条；新增 `.np-day` 样式。**只读、不自动开口**（是否提起仍由 ≤5% 概率门决定，与此视图无关）。验证：21/21、构建 0 |

## 待观察项（用户反馈，暂不改动）

| ID | 反馈与初步判断 | 处置 |
|---|---|---|
| OBS-1 情绪外显度不足 | 2026-10-17 用户真机初听 BLUE-1 反馈：凪的情绪起伏偏弱、整体过于含蓄；初步判断成因可能在角色设定侧（台词风格、情绪阈值或语气处理方式限制了情绪外显），而非语音参数表本身 | **暂不修改角色设定或台词**（本条即记录该决定）。后续环节（BLUE-2 表现层、BLUE-4 不完美机制、RED-4 复核）重点复核情绪表达是否足够鲜明、可辨识；若确认存在，再从情绪分层、语气强度、表现方式等方向评估针对性调整 | **2026-10-17 补充**：用户裁决「2 只调整语音参数、不动台词」→ 语音侧已加大 `VOICE_PROFILE` 幅度并补下限断言（D41）；**台词/人设仍未动**。语音侧上限另见 `docs/语音自然度评估_2026-10-17.md`：全局 rate/pitch 只能让她"说快/说尖"，模拟不了 F0 动态范围，真正的情绪维度要等 T5（`mstts:express-as`） |

## B. 安全债（高优先，随时可做）

| ID | 状态与范围 | 完成标准 / 证据 |
|---|---|---|
| FIX-1 HA extra 覆盖漏洞 | ✅ 已修（2026-10-17） | 复现：`planHomeService` 里 `extra.entity_id` 可覆盖已核验目标——确认框显示 `light.living_room`、实际对 `lock.front_door` 下达 `light.turn_off`（`docs/verify/b06-ha-extra-20261016.json`）。修法（两道保险 + 一条诚实）：① 新增 `sanitizeHaExtra` 清洗 `extra`，剔除保留键 `entity_id`（**大小写不敏感**，入参来自模型不赌它守规矩），其余键照旧透传（不擅自替用户决定哪些参数合法）；② 所有分支改成 `{...extra, entity_id}` —— **entity_id 最后写入**，即使将来清洗被绕过也盖不掉；③ brightness 分支展开方式与其它分支统一（也吃 extra）；④ 结果摘要改读 `plan.data.entity_id` 而非入参——**摘要不许跟着撒谎**。回归：`test/registry-files.test.js` 14/14（新增 3 项：绕过尝试含大小写变体/亮度分支/纯 extra 分支全被挡、其它键照旧透传且脏输入安全、假客户端断言 `sent[0].data.entity_id === args.entity_id` 且摘要说真话）。**未做**：extra 全面白名单（会把合法参数也挡掉，收益不抵成本，已在 D46 说明） |
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
| B01 持久化中断窗口 | ✅ 已完成（2026-10-17） | 三处病灶全修：① `core/persist-io.js` 新纯函数模块（写 tmp→rename 直接替换，失败路径绝不碰原文件）；② `persist.js` 的 `writeJsonSoon`/`flushPersist` 改走原子写，flush 返回 `{ok,written,failed}` 逐文件结果，失败落 `persist-warnings.json` 供下次启动如实提示（`index.js` whenReady 消费）；③ `ledger-actions.js` 的 scrub/correct 检查 flush 结果，失败即抛错、账本状态不动、返回 ok:false。顺带修两个 latent bug：flush 前未 load 会把用户数据覆盖成空（启动即退出即清空）、`agent.js` 退出刷盘静默 ignore。`rag/store-io.js` 的 atomicWrite 同款"先删后 rename"一并换共享实现。测试：`persist-io` 8/8（假 fs 证失败不删原文件）、`persist` 6/6（真临时目录 + 目录占用注入两种写失败）、`ledger-actions-flush` 3/3（mock persist 桩证伪报成功已堵）；相关既有 `ledger`/`ledger-actions` 22/22 无破坏；`npm run build` 退出 0 |
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
| B23 外部便签写入安全桥接 | ✅ 已完成（2026-10-17，用户 2026-10-17 裁决「1 开放」） | 契约 §4 逐条落地：默认关闭（开关 + 未选目录双重拒绝）、目录只能由**系统选择器**选出并 realpath、**每次写入弹原生确认**（不提供"以后都不问"）、不得从订阅回调直接 fs 写盘（写盘收口到 `src/main/notes-file.js`，由 IPC 触发）、`wx` 不覆盖用户文件、失败如实回 reason。「未授权必须被拒」的安全边界测试已补：`test/notes-file.test.js` 13/13（core 四类穿越 + 软链逃逸）+ `test/notes-file-main.test.js` 8/8（真写盘：未授权/取消/重复/节流/选目录-撤销/同名不覆盖）。**剩真机走一遍**：需用户亲自选目录、看确认框文案、打开生成的 .txt（D44/D45） |

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
| B24 ✅ | 自然待机行为与装束（2026-10-17 已完成）：装束走参数保持层（D18）、微注视是"有节制"的修订（D19/D20）、全局热键为本地触发（D21）。新增 `models/Maine/nagi-outfit.json`（6 槽位 / 6 套装束）、`src/core/outfit.js`、`src/core/ambient.js`、`src/core/gaze.js`、`src/renderer/js/ambient.js`、`src/main/{gaze,shortcuts,ambient-host,outfit-state}.js`、`src/main/ipc/outfit.js`。真机 `npm run verify:ambient` **9/9**；单测 `test/{outfit,ambient,gaze}.test.js` 共 51 项。用户控制：热键 Ctrl+Alt+O / Ctrl+Alt+Shift+O / Ctrl+Alt+E、托盘装束子菜单、桌宠右键菜单、设置页装束面板 + 待机行为开关。保守档：小动作 5~10 分钟一次、换装一天 ≤3 次且间隔 ≥90 分钟 |
| B32 ✅ | 全量回归 + 验收自身修复（2026-10-17 完成，D38~D40）：① verify:turns A/C 改读写入值 + seq 新鲜帧过滤（关窗陈旧残尾假失败）；② D 项气泡改读 `__nagiPokeBubbles` 历史 + spoken>=6（DOM 全空假通过）；③ verify:face H 窗口 6s→10s（阈值卡分布均值）；④ 产品层：`eyeWanderHook` 姿态激活时让位（set 曾覆盖姿态的 add，思考时目光自己飘走）；⑤ verify:maine/maine-live 映射改实读 `nagi-emotion.json`（硬编码还是 D37 前旧值）、verify:pose 补 `NAGI_RENDERER_SANDBOX=0`（全仓唯一漏网）。全绿：单测 666/667（0 败 1 skip）、face 10/10、turns 5/5、ambient 14/14、pose 13/13、maine 7/7、maine-live 6/6、reaction 5/5 |
| B31 ✅ | 表情映射命名空间修复（2026-10-17 完成，D37）：`smile`/`worry` 两个情绪键解析返回 null、两张脸静默消失（填了文件名而非模型 Name）。修为：`nagi-emotion.json` 改真名（smile→`nagi_smile`、worry→`紧张汗`，新增 `blush→脸红` 非情绪键入口）、`nagi-face.json` 肌肉表键对齐、`test/face-expression.test.js` 加两条静态锁（expr 必须是真实 Name + 必须有肌肉向量）。`verify:face` **10/10**、全量 665/667（1 已知环境噪音）；仅配置与测试，无渲染层代码变化 |
| B30 ✅ | 眨眼 / 眼神跟随 / 节奏对比（2026-10-17 完成）：① 眨眼是**真 bug** —— 框架在动作播放时跳过眨眼、Idle 常驻循环 → 一次都不眨，改为自排（2.2~5.6 秒、偶发双眨）；② 转向与待机摆动时眼珠跟着头走（头 28.5° → 眼珠 0.43）；③ 动作节奏改簇发（34% 概率 18~42 秒内追加一个，簇尾强制回长安静，长安静后第一个动作加大）。`verify:face` 7/7、`verify:turns` 5/5、`verify:pose` 13/13 |
| B29 ✅ | 转头/转身 + 幅度加大 + 戳一戳重写（2026-10-17 完成）：新增转向层（六种契机，头 28.5°/身 9°，到值域上限）+ 待机头部摆动（原来恒为 0）+ 动作期头身叠加（原包动作没有角度曲线）+ 注视响应曲线放大 + 戳一戳按连戳次数分级（24 条池子，7 次以上不出声只别过头）。`npm run verify:turns` **5/5** |
| B28 ✅ | 面部表达三层（2026-10-17 完成）：情绪改「五官肌肉向量 × intensity」（原来 intensity 完全不参与表情，smile/worry 甚至只写了个特效符号）+ 7 路五官微动与眼球微扫视 + 元音口型。配置 `models/Maine/nagi-face.json`、纯逻辑 `core/face/expression.js`、渲染层三个钩子。`npm run verify:face` **6/6**（强度 0.2/0.5/0.85 → 画面差 5.4%/8.2%/14.4% 单调递增；微动开 7.29% vs 关 1.56%）、单测 23 项 |
| B27 ✅ | 「她想一下再表现」（2026-10-17 完成，用户提出并选定 L2/只发分类/以表情为主）：`core/presence/reaction.js`（思考闸门 + JSON 校验 + 提示词）+ `main/reaction.js`（引擎，依赖注入）+ `agent.js:startReactionEngine`。模型只输出**语义**（feel/strength/mode/flash/why/say），持续走 `mood.propose`（只提议不强设），闪回走微表情；发出去的只有活动分类。`npm run verify:reaction` **5/5**（假模型桩，含"没有标题泄露"检查）、单测 36 项。设置页可关，关掉/没配模型时退回硬编码规则 |
| B26 ✅ | 闲置表情/动作资源补强（2026-10-17 完成）：① `nagi_pout` 补上 `Param29 撅嘴`/`ParamMouthForm`/`ParamBrowLY2`（原来只压眉毛，画面差 0.2% ≈ 看不见；现 1.2%~12.2%）；② 新增瞬时微表情层（`nagi-microexpr.json` 8 个池子 + `core/microexpr.js` + `live2d.js` 的 `playMicroExpr` 参数层），自主动作约 1/3 变成闪微表情；③ TapBody 3 个变体纳入待机候选；④ Scene 做成罕见专场（一天 ≤1 次，空闲 ≥30min 且心情好，安静基调不演）。`verify:ambient` **14/14**、`test/microexpr.test.js` 16 项 |
| B25 🟡 | 待机行为**真人观感**验收（待用户）：自动验收全绿，但"瞟一眼的频率会不会烦""她自己在没人的时候换装会不会违和""热键组合是否与你的软件冲突"只能真机日常感受。若嫌吵：设置页把活跃程度调到"保守"以下（或直接关掉"允许她自己做动作、自己换装"）；热键冲突会在应用日志里列出被占用的组合 |
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

截至 2026-10-17：BLUE-1 代码已完成（**等用户裁决**：是否同步拉大 `MOOD_SPEECH` 或把 `voiceProfileEnabled` 默认改 true——不改的话默认配置听不到新表）；BLUE-2 已完成并真机 15/15；BLUE-3 环境留痕已完成并真机 12/12；BLUE-4 已完成；**BLUE-5 媒体与坐标感知已完成并真机 10/10，待用户按 B20 六条清单日常确认**。A/B/C/D 四项（外部便签写入 B23、语音参数、语气音、回忆时间线）**代码已全部完成**，只剩真机走一遍（B23 需用户亲自选目录）。安全债 **FIX-1 已修**（2026-10-17）；**FIX-2（外部进程替换竞态）/ FIX-3（Playwright 生命周期）仍未修**——两者都要求"先复现再修"，未复现前不宣称安全。缺账号/素材/设备不阻塞独立工作，待真机项不标完成。
