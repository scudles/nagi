# 双工具交接：HANDOFF

## 边界规则（先读）

- 🔴 ChatGPT 红线区（只做这些）：架构契约、Agent Loop+双通道、安全门、Playwright 核心、关键复核、疑难会诊。
- 🔵 WorkBuddy 蓝区（其余全部）：UI、标准工具、Provider preset、HA REST、测试、文档、常规修复。
- 冲突规则：默认归 WorkBuddy；WorkBuddy 不擅改红线区（只能提建议）；ChatGPT 不代改蓝区（只标注）。
- 初始化由用户单次授权；本轮另明确授权 R01 红区修复、测试/构建、三份交接文档更新与提交。普通文档和测试代码仍归蓝区。当前暂停写新功能，待办登记不代表恢复开发。

## 现在从这里接手

截至 **2026-10-16**，源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。

- R01 起始 HEAD：`726b557`（`Tighten local persona guard for goodbyes`）。进入本轮时已有 README 初始化修改、三份未跟踪的交接文档，以及 `cloud-config.js` 修改（2 行新增、2 行删除）。本次仅提交红区代码与三份交接文档；README 与 cloud-config.js 原有差异保留未暂存。
- 本轮修改 `src/core/agent/loop.js`、新增 `src/core/safety/confirmation.js`、修改 `src/main/agent.js` 和 `src/main/ipc/settings.js` 的取消/授权边界；另更新三份交接文档。语音、人格、UI、标准工具和 Provider 配置未改。R01 的外部路径竞态按用户决定保留未完成。
- [TASKS](TASKS.md) 是唯一执行队列：**3 件红线任务、19 件蓝区任务**，含暂停功能、待资源和待验收项。先读具体状态与前置条件；发现蓝区问题只登记，发现红区问题由 WorkBuddy 提建议。
- [DECISIONS](DECISIONS.md) 记录持续有效的取舍。总背景仍见包根目录 `00_交接说明_HANDOFF.md`；人格唯一基准仍为 `01_项目文档/凪_人格设定_v2.md`。旧文档“已完成”不是验收证据。

## 事实基线与证据

| 项目 | 本轮实际结果 / 限制 |
|---|---|
| 单元与边界测试 | `npm test` 等价命令已执行，退出码 0；347 项，345 通过、0 失败、2 跳过 |
| 跳过项 | `test/security-boundary.test.js` 中“内部链接指向外部时读、写、列目录均拒绝”和“Windows 目录接合点单独验证越界”；当前环境不能创建所需链接，归 B07 补验 |
| 环境 | Windows / Node 24.19.0 / npm 11.6.4 |
| 原始测试日志 | 最新 `E:\凪\.tools\r01-test-2026-10-16.log`；初始文档基线为 `handoff-baseline-2026-10-16.log`。本机文件，换机需另存脱敏副本 |
| 定向验证 | 临时 stdin 验证：Agent/确认门 11/11，真实 settings IPC 处理函数配模拟依赖 4/4；日志为同目录 `r01-targeted-2026-10-16.log`、`r01-ipc-2026-10-16.log`。未新增蓝区测试文件，固化用例交 B07 |
| 构建与真机 | `npm run build` 等价命令退出 0，main/preload/renderer 均产出；日志 `E:\凪\.tools\r01-build-2026-10-16.log`。有现有 Cubism classic script 的 Vite 提示；未修改加载方式。未重跑真人、发行包验收 |
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

## 交接给 WorkBuddy

**本次顺序：B07 固化 R01 回归 → B05 收尾确认 UI → B08 同步记录。** B06 仅准备下面已标注风险的模拟复现与红区建议；其余蓝区任务仍见 TASKS 原状态，尤其暂停的新功能不得自行恢复。R02、R03 及 R01 未完成项继续归 ChatGPT。

### 交付任务、输入与输出

| 编号 / 归属 | 说明与输入 | 输出与验收 |
|---|---|---|
| B07 / 🔵 WorkBuddy | 输入：本次四个红区源码文件、下述契约和 15 项临时验证场景。固化 native/JSON 两通道的等待时取消、批准同时取消、ACTING 时取消、正常批准；再覆盖未决 Promise/迟到拒绝、严格布尔值、重复/过期 token、跨回合重复模型 ID，以及 root revoke/pick/cancel/generic settings 绕过 | 输出：永久回归测试及命令/结果；取消后未开始的 executeTool 调用次数必须为 0，正常批准只执行 1 次；文件根撤销/换根先取消再保存，取消 picker 不改授权。补两个链接测试和发行版人工项时如缺环境，保留待验，不伪报通过 |
| B05 / 🔵 WorkBuddy | 输入：`src/renderer/js/chat.js` 的 handleConfirm/onAgentEvent、`ui.js` 的 showConfirm，以及新的 CONFIRM token 契约。取消后确认 UI 可能仍留在屏幕，旧操作卡也可能持续显示等待 | 输出：仅 UI 层关闭/失效过期确认条与待处理显示；旧按钮不能批准下一操作，取消后能再次发送，多窗口响应只接受一次。用模拟事件/实际 UI 证明；不能更改红区 token、取消或授权规则 |
| B08 / 🔵 WorkBuddy | 输入：本交接、TASKS/DECISIONS、已有 README 未提交初始化差异、本轮测试/构建日志 | 输出：按实际结果同步 README/验收文档，单独审阅提交原 README 差异，保留跳过/未完成项。不要混入 cloud-config.js；缺失旧任务书继续追索，未找到就记录缺口 |
| B06 / 🔵 WorkBuddy（仅复现/建议） | 输入：`src/core/tools/registry.js` 的 planHomeService，`home_set.args.extra` 与顶层 entity_id。源码显示 extra 可覆盖确认展示的 entity_id；此项尚未运行复现 | 输出：使用假 HA 客户端给出“显示目标与实际服务目标是否一致”的测试证据与修复建议；不得接真实设备试错，涉及授权目标的代码修改先交 ChatGPT 红区处理 |

### 必须遵守的契约

1. `CONFIRM.id` 是宿主一次性 token，**不等于**模型工具 ID；UI 只原样回传该 token 和布尔值。TOOL_CALL/TOOL_RESULT 仍通过原工具 ID 关联，不依赖确认 ID 关联卡片。
2. 确认超时、取消、拒绝或过期不授予权限；对返回 `{ ok: false }` 的迟到点击不能显示“已执行”。停止后不再启动尚未开始的动作；已开始的外部动作不承诺撤回。
3. 文件授权通过原生选择器授予；换根和撤销终止旧回合，不能自动用新根继续旧请求。普通 shell 仍需其原有确认，不能将 cwd 限制宣传为 OS 文件沙箱。
4. IPC 仍只接受注册窗口顶层应用页；沙箱保持默认开启，不能为了 UI/测试通过放开导航、来源或权限检查。模型护栏重试不得执行工具。
5. 保留语音配置、只把新日记进入 RAG、事实/主观/创作分层与来源/删除契约。

### 禁止 WorkBuddy 擅改的红线区文件/部分

- `src/core/agent/loop.js`、`json-protocol.js`、`persona-guard.js`；`src/core/safety/*`（含本次 confirmation.js）。
- `src/core/tools/browser.js`（R03 待办）；`src/main/agent.js` 的 Agent 编排、执行入口、确认与取消部分。
- `src/main/ipc/trusted.js`、`chat.js` 的来源/确认入口；`settings.js` 的文件根选择/撤销与防绕过部分。
- `src/main/local-protocol.js` 的真实路径边界、`src/main/windows.js` 的沙箱/导航/IPC 来源策略；`src/core/tools/files.js` / `system.js` 的真实路径与授权边界。
- `src/shared/protocol.js` / preload 的权限和消息契约；其他文件内涉及安全门的代码段同样只提建议。蓝区标准工具代码不能借修业务而绕过上述边界。

### “请 WorkBuddy 修”清单

- **请 WorkBuddy 修（B05）**：取消后残留确认条/等待操作卡；目前是源码发现，尚未人工 UI 复现。本次后端已阻止旧确认执行，UI 仍需明确失效显示。
- **请 WorkBuddy 修（B07）**：将上列临时回归固化到 test，补足授权撤销与一次性 token 的持续保护；现有全量测试数没有覆盖全部新场景。
- **请 WorkBuddy 修（B08）**：README 与旧验收记录的状态对账；两个链接测试不得写成已通过，R01 整包不得标成完成。
- **请 WorkBuddy 修（B06，先复现并提建议）**：核对 HA extra 覆盖目标问题；若复现，保留失败证据交红区，不能自行改授权目标契约。

### 待确认与保留风险

- 用户已同意本次保留外部进程替换路径竞态；是否另做原生句柄方案留待后续决定，当前没有安全隔离完成声明。
- 两个 Windows 链接场景仍待可创建链接的环境；真实 UI、发行包、物理断网与设备验收未因本次测试/构建通过而关闭。
- `cloud-config.js` 仍由原修改者确认（B09）；本轮未读出或提交配置差异。现有 README 差异也没有混入本次红区提交。
- 构建为源码产物，既有安装包/免安装版没有重打包。Vite 的 Cubism 脚本提示保留，不能直接加 `type="module"` 破坏原有加载方式。

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
