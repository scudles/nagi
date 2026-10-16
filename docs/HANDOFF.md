# 双工具交接：HANDOFF

## 紧急交接 2026-10-16 23:11 ChatGPT

**用户要求立即停止开发，以保存现场为唯一目标。本节优先于下方历史交接。** 全部 Git 可见改动已用 `git add -A` 抢救至 **`wip/紧急收口-RED123-1016`，提交 `f56b595`**；已切回 `main`。main 业务源码仍为已知绿灯 `d2aa65e`，本次只追加 HANDOFF/TASKS 文档，不重新测试、不修复、不继续实现。

### 最后正在做的事 / 续做第一步

- 下一次光标：WIP 的 `src/main/presence.js:56`，`createPresenceService().observe(input)`；刚加入暂停/黑名单样本、再次离开、休眠时递增 epoch，使已生成中的归来候选失效；同文件 `refresh()` 第 28 行刚加入设置保护签名 `lastGuard`。**这最后一笔尚未运行测试或构建。** 对应新回归在 `test/presence-store.test.js:55`。
- 恢复第一条命令：`git checkout "wip/紧急收口-RED123-1016"`；先查看上述两处差异。获得继续授权后才运行定向测试：`node --experimental-test-module-mocks --test test/presence-store.test.js`，随后按实际结果决定全量测试/构建/verify；本轮不执行。

### 半成品清单（百分比仅进度估计，不是验收结论）

| 任务 / 完成度 | WIP 涉及文件与现状 |
|---|---|
| RED-1 / 90% | `docs/实感架构契约.md` 已有接口/schema/配置/两处 hook/BLUE 设计；尚需与最新实现核对、把完整 BLUE 输入输出验收登记 TASKS/HANDOFF。 |
| RED-2 / 90% | 新增 `src/core/presence/{circadian,away,reunion,engine,hooks}.js`、`src/shared/presence-protocol.js`、`src/main/{presence,presence-store,presence-hooks,presence-extensions,presence-selftest}.js`、`src/main/ipc/presence.js`；已接入 `core/context.js`、`core/diary.js`、`core/emotion/mood.js`、`core/monitor/engine.js`、`main/agent.js`、`main/index.js`、`main/monitor/index.js`、`main/ipc/{settings,voice}.js`、`main/voice/index.js`、`preload/index.js`、`shared/protocol.js`。新增 `test/presence.test.js`、`presence-store.test.js`、`presence-voice.test.js` 和 `scripts/verify-presence.mjs`；最后 epoch 修改未验。 |
| RED-3 / 90% | 契约第 5 节已有重要事项零遗忘、低风险可选表达延迟≤10%、低气压/安慰/补救方案；未实现业务。需最终核对 BLUE-4 能直接接的接口与后续红区接线边界，DECISIONS 尚未收口。 |
| 既有他人修改 / 未评定 | README、cloud-config.js、`src/core/agent/emotion-map.js` 删除、用户提供的 `docs/实感补足任务书.md` 及 `.nagi-*` 测试残留，按本次“全部抢救”指令一并入 WIP，未审定、未单独验收。不得把整个 WIP 直接合并回 main。 |

### 测试事实

- main 基点 `d2aa65e` 的本轮实跑基线：375 项，373 通过、0 失败、2 环境跳过（链接权限/环境）；WorkBuddy 的前一环境记录为 374 通过/1 跳过，不能混写。
- WIP 最后 epoch 补丁之前：全量 **396 项，394 通过、0 失败、2 跳过**；构建通过；真实 Electron `verify-presence` **11/11**；现有 `verify:s4` **9/9**、`verify:m4` **19/19**。这些结果不覆盖最后 epoch 补丁。
- 遇到过：受限环境中 Electron 在应用启动前退出（2147483651）；授权在隔离临时 userData 运行后启动成功。归来验收曾失败，诊断证明旧 M3 自测规则先消耗预算（backoff）；隔离 M3 自测触发、不绕过预算后 11/11 通过。没有声称当前最终 WIP 已全绿。
- 日志保留在 `E:\凪\.tools\presence-{baseline,full-test,build,verify,verify-s4,verify-m4}.log`（本机外部证据，未复制进仓库）。阶段 10 真机/发行包、语音听感、真实模型生成质量仍待验；用户已允许不阻塞本轮。忽略的 out 构建缓存不是 main 源码验收依据，下次启动开发模式会重建。

### 未决问题 / 已定约束

- 停在最后失效保护补丁后的未验证状态；原计划先验证此补丁，再对齐契约、记录 BLUE-1～4 和红区决策，最后独立提交。现已停止，不尝试最后修复。
- 用户已批准以现有任务卡、人格 v2/增补和本轮要求补齐契约；已确认 WorkBuddy 停工并保留其改动；活动默认仅内存，显式开启后只保存之后的新活动到 userData，不回填开启前或关机期间活动。保留当前语音配置，不实现 voice-profile 映射、不接外部写操作。
- 契约还需明确：`proactive-delivered` 事件、损坏活动文件保留策略、BLUE-4 仅方案接口与后续接线位置；本次不再改。蓝区历史 HA extra 目标覆盖与 R01 外部路径竞态仍未修，不能启用 HA 主动控制。

### 给 WorkBuddy / 恢复路径

- **禁止修改 WIP 红线半成品**：上表 RED-2 核心/编排/协议/桥接、RED-1/3 契约及相关核心测试；不能为了接蓝区补 hook、改 Agent 或安全门。实感 BLUE-1～4 暂缓，等待红区恢复并完成契约验收；本轮不授予继续开发权限。
- 不依赖实感的历史蓝区任务（B05 人工 UI 验收、B07 发行/链接补验、B08 文档、B19 测试残留维护等）技术上不受影响，获用户授权后可在 main 继续。**请 WorkBuddy 修/处理**：其既有 README/config 差异与 emotion-map 删除的独立归属、`.nagi-*` 残留；先从 WIP 按文件审查恢复，不整体合并、不公布配置内容。
- 下次只使用稳定版本就留在 `main`；恢复 RED-1/2/3 才 checkout 上述 WIP。最新紧急说明在 main，可在 WIP 用 `git show main:docs/HANDOFF.md` 查看。所有现场仅本地提交，未推送；WIP 包含未经审查的配置与测试残留，先审查再分享。

## 边界规则（先读）

- 🔴 ChatGPT 红线区（只做这些）：架构契约、Agent Loop+双通道、安全门、Playwright 核心、关键复核、疑难会诊。
- 🔵 WorkBuddy 蓝区（其余全部）：UI、标准工具、Provider preset、HA REST、测试、文档、常规修复。
- 冲突规则：默认归 WorkBuddy；WorkBuddy 不擅改红线区（只能提建议）；ChatGPT 不代改蓝区（只标注）。
- 初始化由用户单次授权。2026-10-16 用户授权 WorkBuddy 执行 B07/B05/B08/B06 四项蓝区任务、测试/构建与交接文档更新；**该轮已收口并移交回 ChatGPT（见文末「交接给 ChatGPT」）**，下一轮范围待用户重新授权。普通文档和测试代码仍归蓝区。当前暂停写新功能，待办登记不代表恢复开发。

## 现在从这里接手（ChatGPT）

截至 **2026-10-16 22:40**，源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。当前 HEAD：`2ab5530`（WorkBuddy 本轮蓝区收口提交）。

- 本轮授权 WorkBuddy 的蓝区工作已全部交付：B07（R01 回归固化，`b3de4bf`）、B05（确认 UI 失效收尾，`ba44a56`）、B08（任务书恢复与对账，`d1db560`）、B06（HA extra 漏洞复现与红区建议，`2ab5530`）。交付细节见下方「交接给 ChatGPT」。
- R01 剩余外部进程替换路径竞态、R02、R03 仍归 ChatGPT；B06 复现出的 HA extra 覆盖目标问题已备好证据与建议方向，等 ChatGPT 决定（见「红区建议」节）。
- [TASKS](TASKS.md) 是唯一执行队列：**3 件红线任务、19 件蓝区任务**。B05–B08 本轮已交付但维持「部分完成」（各有真机/设备/放行待办，不整包关闭）；其余蓝区任务原状态不动，尤其暂停的新功能不得自行恢复。
- [DECISIONS](DECISIONS.md) 记录持续有效的取舍。总背景仍见包根目录 `00_交接说明_HANDOFF.md`；人格唯一基准仍为 `01_项目文档/凪_人格设定_v2.md`。旧文档“已完成”不是验收证据。
- README 与 `cloud-config.js` 工作区仍有原修改者未提交差异（B09），本轮未代提交；`docs/实感补足任务书.md` 是用户放置的新一轮红蓝任务卡，用户自述“不要插队”，未处理。

## 事实基线与证据

| 项目 | 本轮实际结果 / 限制 |
|---|---|
| 单元与边界测试 | `npm test` 等价命令已执行，退出码 0；收口复跑（2026-10-16 22:33，Node 24.19.0）**375 项，374 通过、0 失败、1 跳过**；此前基线 347 项，B07/B05 后逐轮提升 |
| 跳过项 | `test/security-boundary.test.js` 中“内部链接指向外部时读、写、列目录均拒绝”和“Windows 目录接合点单独验证越界”中的文件符号链接项；当前环境不能创建所需链接（无 SeCreateSymbolicLinkPrivilege），归 B07 补验；junction 项本机真实创建并通过 |
| 环境 | Windows / Node 24.19.0 / npm 11.6.4；本机 PATH 默认 node 22 会导致 7 个 electron mock 测试假失败，须将 Node 24 目录前置 |
| 原始测试日志 | R01 轮 `E:\凪\.tools\r01-test-2026-10-16.log`；收口轮 `E:\凪\.tools\wb-final-build-2026-10-16.log`（同含构建输出）。初始文档基线为 `handoff-baseline-2026-10-16.log`。本机文件，换机需另存脱敏副本 |
| 定向验证 | 临时 stdin 验证：Agent/确认门 11/11，真实 settings IPC 处理函数配模拟依赖 4/4；日志为同目录 `r01-targeted-2026-10-16.log`、`r01-ipc-2026-10-16.log`。已由 B07 固化为永久回归 |
| 构建与真机 | `npm run build` 等价命令退出 0，main/preload/renderer 均产出；收口轮（2026-10-16 22:34）重跑通过，日志 `E:\凪\.tools\wb-final-build-2026-10-16.log`。有现有 Cubism classic script 的 Vite 提示；未修改加载方式。未重跑真人、发行包验收 |
| 历史证据入口 | [演进验收记录](演进验收记录.md)、[阶段10人工验收清单](阶段10人工验收清单.md)、[本地模型实测](M6_端侧模型实测_2026-10-16.md)；其中遗留项见 TASKS |

本机 npm 未在常规 PATH 时，实际执行方式如下（其他机器正常用 `npm test`）：

```powershell
$env:TEMP = 'E:\凪\.tools\tmp'
$env:TMP = 'E:\凪\.tools\tmp'
node E:\凪\.tools\npm\package\bin\npm-cli.js test
```

## 源码事实与保留约束

- 沿用 `core/main/renderer/shared`。已有 Agent 原生工具调用与 JSON 回退、授权策略、IPC 来源校验和渲染沙箱。R01 的取消/确认/文件授权撤销已修；外部路径竞态仍未闭合。
- 账本、三层记忆、纠错/忘记/导出、关系与主动预算、提醒承诺簿、生活信号、年鉴均有实际代码及测试；跨文件中断一致性、真实设备和用户操作仍有待验收项。
- **只让之后的新日记进入 RAG**；旧日记可保留在账本索引，不批量补录成可召回经历。保留来源、事实/主观/创作区分与删除状态。
- 用户已同意敏感场景有限重试人格护栏。当前已有缓冲检查和有限重试实现，但不能把规则检查等同于语义安全；本地模型默认切换仍需 R02 复核。不得以固定台词替代生成，也不得重试已执行的外部动作。
- **维持现有语音引擎与音色配置**。语音注册表中 cloud / GPT-SoVITS 等条目不代表已有真实适配器。
- 历史清理已移除可重建的 `dist/win-unpacked`；需要时用 `npm run pack` 重建。临时测试目录可能已清理，不把旧目录路径视为永久证据。

## 如何判断红蓝边界

按职责和改动内容判断，不按整个目录染色：

| 范围 | 分工 |
|---|---|
| `core/agent/loop.js`、`json-protocol.js`、`persona-guard.js` 及 `main/agent.js` 编排部分 | Agent 循环、双通道、重试/取消安全契约由红区处理 |
| `core/safety/*`、IPC 来源/权限、真实路径、沙箱与本地协议边界 | 安全门为红；标准工具业务实现为蓝，不能绕过既有安全门 |
| `core/tools/browser.js` | Playwright 核心连接、生命周期、执行边界为红；外围测试、UI 和文档为蓝 |
| `shared` 协议、preload 桥接、产品契约文档 | 架构/授权契约变更为红；沿既有契约的常规实现与文档整理为蓝 |
| renderer、标准工具、Provider preset、HA REST、持久化常规实现、测试与脚本 | 默认蓝；若需改契约或安全门，拆出最小红区子任务 |

同一文件包含两种职责时按代码段拆分，不能以“同文件”为由越界。关键复核只覆盖有明确风险或切换决策的任务，不把全部蓝区工作变成红区审批。

## 交接给 WorkBuddy（历史授权范围，本轮已完成）

**本轮顺序：B07 固化 R01 回归 → B05 收尾确认 UI → B08 同步记录 → B06 复现与建议。** 四项均已交付（下表）；其余蓝区任务仍见 TASKS 原状态，尤其暂停的新功能不得自行恢复。R02、R03 及 R01 未完成项归 ChatGPT。

### 本轮蓝区交付结果

| 编号 | 提交 | 交付内容 | 遗留（不整包关闭的原因） |
|---|---|---|---|
| B07 | `b3de4bf` | 22 项永久回归：`test/agent-cancel.test.js` 18 项（native/JSON 双通道等待时取消、批准同时取消、ACTING 时取消、正常批准恰好执行 1 次、取消后未开始 executeTool 为 0、未决 Promise/迟到拒绝、严格布尔、重复/过期 token、取消后迟到批准、跨回合重复模型 ID 生成不同宿主 token）+ `test/settings-file-root.test.js` 4 项（撤销/换根先取消再保存、取消 picker 不改授权、通用设置不能换根）；junction 链接本机真实创建并通过；symlink 项因无符号链接权限跳过，并已防「静默降级为普通文件」假失败 | 在可创建文件符号链接的环境补跑 symlink 项；安装版/免安装版物理断网、跨重启、撤权、迁移、导出人工验收（参照 `阶段10人工验收清单.md`），保留版本与哈希证据 |
| B05 | `ba44a56` | `src/renderer/js/ui.js` 确认条生命周期（同一时刻一条、新确认替换时旧按钮立即失灵、`dismissConfirm` 以 null 落款、`isConfirmActive`）+ `markToolCardsStopped`；`src/renderer/js/chat.js` 五条路径收条（STATUS 离开 waiting / TOOL_CALL / TOOL_RESULT / DONE / ERROR）+ 回传被拒时显示「确认已失效」；`base.css` 新增 `.tl-card.stopped`；`test/ui-confirm.test.js` 6 项（取消后收条且不回传、能再次发送、超时失效、旧按钮不能批准下一操作、正常批准/拒绝护栏、执行中取消的旧操作卡标记、多窗口只接受一次响应） | 真实双窗（桌宠+工作台）人工点按验收；原生目录/保存对话框、来源查看、纠错忘记、导出重读、稍后、勿扰/只陪着、多显示器与隐私黑名单人工清单 |
| B08 | `d1db560` | 从 2026-10-15 会话存档恢复《凪_Nagi_完善任务书》全文至 `docs/完善任务书_2026-10-15.md`（原文件从未入 git、磁盘已失）；新建 `docs/完善任务对账_2026-10-16.md` 逐项对账 22 个 ID（✅ 9 / 🟡 11 / ⬜ 3，含 T02/T04/U01/U03/U04 缺口与 S05 日志原文、S06 明文降级两项待修）；`docs/演进验收记录.md` 补记 dist 重建哈希（Portable `da7ca61e…`、Setup `b644362c…`）；TASKS 状态行更新 | README 五项更新（M5 语音状态、M6 护栏已落地标注、测试计数、历史快照标注、哈希补记）——README 工作区有他人未提交修改，按边界规则不代提交，待用户放行或对方先提交后再应用 |
| B06 | `2ab5530` | `scripts/verify-b06-ha-extra.mjs` 用假 HA 客户端复现 `home_set` 的 `extra.entity_id` 覆盖成立（确认框显示 `light.living_room`、实际对 `lock.front_door` 下达 `light.turn_off`，结果摘要同样显示诱饵）；证据 `docs/verify/b06-ha-extra-20261016.json`；修复建议见「红区建议」节。**未改任何标准工具代码** | 真实 HA 只读→单独授权控制、撤销与活动音乐会话的读取/隐私验证（无账号设备前保留待真机项）；红区修复后的回归协作 |

### 必须遵守的契约

1. `CONFIRM.id` 是宿主一次性 token，**不等于**模型工具 ID；UI 只原样回传该 token 和布尔值。TOOL_CALL/TOOL_RESULT 仍通过原工具 ID 关联，不依赖确认 ID 关联卡片。
2. 确认超时、取消、拒绝或过期不授予权限；对返回 `{ ok: false }` 的迟到点击不能显示“已执行”。停止后不再启动尚未开始的动作；已开始的外部动作不承诺撤回。
3. 文件授权通过原生选择器授予；换根和撤销终止旧回合，不能自动用新根继续旧请求。普通 shell 仍需其原有确认，不能将 cwd 限制宣传为 OS 文件沙箱。
4. IPC 仍只接受注册窗口顶层应用页；沙箱保持默认开启，不能为了 UI/测试通过放开导航、来源或权限检查。模型护栏重试不得执行工具。
5. 保留语音配置、只把新日记进入 RAG、事实/主观/创作分层与来源/删除契约。

### 禁止擅改的红线区文件/部分（本轮及此后有效）

- `src/core/agent/loop.js`、`json-protocol.js`、`persona-guard.js`；`src/core/safety/*`（含本次 confirmation.js）。
- `src/core/tools/browser.js`（R03 待办）；`src/main/agent.js` 的 Agent 编排、执行入口、确认与取消部分。
- `src/main/ipc/trusted.js`、`chat.js` 的来源/确认入口；`settings.js` 的文件根选择/撤销与防绕过部分。
- `src/main/local-protocol.js` 的真实路径边界、`src/main/windows.js` 的沙箱/导航/IPC 来源策略；`src/core/tools/files.js` / `system.js` 的真实路径与授权边界。
- `src/shared/protocol.js` / preload 的权限和消息契约；其他文件内涉及安全门的代码段同样只提建议。蓝区标准工具代码不能借修业务而绕过上述边界。

### “请 WorkBuddy 修”清单（本轮完成情况）

- **B05（已完成，`ba44a56`）**：取消后残留确认条/等待操作卡——已按仅 UI 层原则修复并固化 6 项回归；真实双窗人工验收仍待用户操作。
- **B07（已完成，`b3de4bf`）**：15 项临时验证已固化为 22 个永久回归；symlink 链接项待可创建链接的环境补跑，发行版人工验收待排期。
- **B08（已完成，`d1db560`）**：任务书已从会话存档恢复并逐项对账；README 五项更新因他人未提交修改未应用，待放行。
- **B06（已完成复现与建议，`2ab5530`）**：漏洞复现成立，失败证据与修复建议已留存，修复本身等 ChatGPT 红区决定。

### 红区建议（B06 复现产出，2026-10-16 WorkBuddy，待 ChatGPT 决定；未擅改）

- **问题**：`src/core/tools/registry.js` `planHomeService()` 在 `state:'on'|'off'` 分支与仅 extra 兜底分支中，把 `args.extra` 展开在 `entity_id` **之后**（`data: { entity_id, ...extra }`），`extra.entity_id` 可覆盖已核验目标。复现（`scripts/verify-b06-ha-extra.mjs`，假 HA 客户端，不接真实设备；证据 `docs/verify/b06-ha-extra-20261016.json`）：
  - 调用 `home_set(entity_id='light.living_room', state='off', extra={entity_id:'lock.front_door'})`；
  - 确认框显示 `控制设备：light.living_room → off`（`describeToolCall` 读 args 原文），用户批准的是“关灯”；
  - 实际执行 `light.turn_off {entity_id:'lock.front_door'}`——**对门锁下达了关闭指令**；结果摘要同样显示 `light.living_room`（也读 args 原文），用户与日志都被蒙在鼓里。
  - 违反任务书 S02「控制参数不得通过 extra 等字段替换已核验的目标」「确认展示的对象与实际执行对象一致」。
- **次要不一致**：`climate.set_temperature` 与 `light+brightness_pct` 分支完全不展开 extra（正当透传字段如 `transition` 在这些分支被静默丢弃）——同一参数三种行为，建议统一。
- **建议方向（供红区选择，不代改）**：
  1. `extra` 改白名单制（仅允许 `transition`/`flash` 等 HA 服务数据字段），且最终 `data` 中 `entity_id` 最后写入、不可被覆盖；或直接移除 extra 透传，高级参数走显式 schema 字段；
  2. 确认描述与结果摘要改读 `planHomeService` 的产物（post-plan），确保“确认对象 = 执行对象”；
  3. 修复后由红区补回归（假客户端断言 `plan.data.entity_id === args.entity_id`），WorkBuddy 可协助补测试。

### 待确认与保留风险

- 用户已同意保留外部进程替换路径竞态；是否另做原生句柄方案留待 ChatGPT/用户后续决定，当前没有安全隔离完成声明。
- 文件符号链接场景仍待可创建链接的环境（junction 项本机已真实通过）；真实 UI 双窗点按、发行包、物理断网与设备验收未因本轮测试/构建通过而关闭。
- `cloud-config.js` 仍由原修改者确认（B09）；本轮未读出或提交配置差异。README 工作区差异同样未代提交。
- 构建为源码产物（out/ 已重建），既有安装包/免安装版没有重打包。Vite 的 Cubism 脚本提示保留，不能直接加 `type="module"` 破坏原有加载方式。
- `src/core/agent/emotion-map.js` 在工作区显示被删除（HEAD 存在、磁盘没有、零代码引用，为已确认死代码）；删除未代提交，去向待用户/ChatGPT 决定。`.nagi-*` 测试临时目录每次跑测试新增一批，建议 `.gitignore` 补充。

## 交接给 ChatGPT

**WorkBuddy 本轮（2026-10-16）蓝区工作已收口，测试与构建通过，工作区可运行。以下为移交内容。**

### 1. WorkBuddy 做了什么

按 HANDOFF 授权顺序完成 B07 → B05 → B08 → B06 四项蓝区任务（详见上「本轮蓝区交付结果」表）：R01 取消/确认/授权撤销的回归固化；确认 UI 的失效生命周期收尾（含多窗口竞态）；旧完善任务书的存档恢复与 22 项对账；HA extra 覆盖目标漏洞的模拟复现与红区建议。未触碰任何红线区文件，未恢复暂停的新功能，未代提交他人工作区改动。

### 2. 改动文件（本轮四个提交，仅限蓝区）

| 提交 | 文件 |
|---|---|
| `b3de4bf` | `test/agent-cancel.test.js`（新增）、`test/settings-file-root.test.js`（新增）、`test/security-boundary.test.js`（改：junction 真实创建 + symlink 静默降级防护）、`docs/TASKS.md`（改） |
| `ba44a56` | `src/renderer/js/ui.js`（改）、`src/renderer/js/chat.js`（改）、`src/renderer/css/base.css`（改）、`test/ui-confirm.test.js`（新增）、`docs/TASKS.md`（改） |
| `d1db560` | `docs/完善任务书_2026-10-15.md`（新增，存档恢复）、`docs/完善任务对账_2026-10-16.md`（新增）、`docs/演进验收记录.md`（追加）、`docs/TASKS.md`（改） |
| `2ab5530` | `scripts/verify-b06-ha-extra.mjs`（新增）、`docs/verify/b06-ha-extra-20261016.json`（新增）、`docs/HANDOFF.md`（改：B06 行+红区建议节）、`docs/TASKS.md`（改） |

### 3. 已验证结果

- 全量测试（收口复跑，Node 24.19.0）：**375 项，374 通过、0 失败、1 跳过**；跳过项为无符号链接权限环境限制，非代码问题。
- 构建：`npm run build` 退出码 0，out/ 下 main/preload/renderer 均于 2026-10-16 22:34 产出；日志 `E:\凪\.tools\wb-final-build-2026-10-16.log`。
- B06 复现：判定 `entityIdOverridable / confirmShowsDecoy / summaryAlsoLies / vulnerable` 全为 true（假客户端，未接真实设备）。
- 已知环境噪音（非回归）：偶发一次 `test/ledger.test.js` cleanup 被 WorkBuddy safe-delete shim EPERM 打断，复跑即过。

### 4. 请 ChatGPT 重点复核的点（少而关键）

1. **B05 UI 失效逻辑与红区 token 契约的衔接**：`ui.js` 的 `dismissConfirm` 以 `null` 落款、`chat.js` 对 `{ok:false}` 回传显示「确认已失效」——请复核这与确认门「过期/别处已处理返回 `{ok:false}`」的语义是否完全对齐，有无遗漏路径（尤其启动准备阶段取消、双通道并行）。
2. **B07 回归是否真正覆盖 R01 全部子项**：22 项中跨回合重复模型 ID 生成不同宿主 token、迟到批准不生效等场景，请核对与 R01 修复代码（`loop.js`/`confirmation.js`）的一一对应，指出未覆盖面。

### 5. 需要 ChatGPT 决定的事项（红线区建议）

- **B06 HA extra 覆盖目标漏洞**（详见「红区建议」节）：`planHomeService` 中 `data: { entity_id, ...extra }` 允许 `extra.entity_id` 覆盖已核验目标，确认展示与执行对象不一致。三个建议方向：① extra 白名单且 entity_id 最后写入不可覆盖（或移除 extra 透传改显式 schema）；② 确认描述与结果摘要改读 post-plan；③ 修复后补回归（假客户端断言 `plan.data.entity_id === args.entity_id`，WorkBuddy 可协助）。**请选择或组合后决定是否由 ChatGPT 实施。**
- **R01 外部进程替换路径竞态**：用户已同意本轮保留；是否另做原生句柄方案，请给方向。
- **R02/R03 排期**：R02 待 B01/B02 契约与 B03/B04 证据；R03 待复现后修复。

### 6. 满足升级条件的问题

**无。** 本轮未遇「卡死且属红线区」的问题：B05/B07 遇阻均在蓝区内自行解决（模块 mock 隔离、DOM 桩隔离、Node 24 环境定位）；B06 按约定只复现+建议，未触碰红线代码即取得证据。测试/构建均通过，无需要 ChatGPT 会诊的报错。

### 7. 剩余蓝区任务（TASKS 原状态，未授权不擅动）

- B05/B06/B07/B08 维持「部分完成」（真机/设备/放行待办，见各任务行）；
- 待前置/资源：B01、B02（待 R02）、B03（待本地模型实测）、B04（待真机语音）、B09（待 cloud-config 原修改者）、B10（待长期容量数据）；
- 暂停功能：B11–B18（截图多模态、日历复杂规则、稳定性测量、语音适配器、音色素材、美术 Live2D、人格叙事、年鉴纪念）；
- 待常规维护：B19（依赖与可再生文件）。
- 用户待决：README 五项更新放行时机、`emotion-map.js` 删除去向、新一轮「实感补足任务书」排队。

## 每次交接只补这些

先在 TASKS 领取任务、写明修改者与基准提交；避免两个工具同时改同一文件。完成必须有实际结果，尝试、模拟通过、人工通过分别记录。未验证写“未验证”。

```text
任务 ID / 归属 / 状态：
基准提交 / 已有未提交改动：
改动文件 / 用户可感知变化：
测试命令 / 退出码 / 通过、失败、跳过：
剩余风险 / 待真机项：
下一步 / 前置条件 / 是否需要对方建议：
```

普通文档与测试结果更新由 WorkBuddy 完成；契约决策由 ChatGPT 在红区任务中说明，再交接相应实现。不要自动提交他人的工作区改动。
