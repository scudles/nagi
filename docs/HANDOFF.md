# 凪 Nagi：三栏交接本（HANDOFF）

> 本文件是 🔴 Codex / 🔵 WorkBuddy / 🟢 豆包·绿区 三 Agent 协作的**交接本**。任一 agent 恢复上下文先读本页。
> 任务卡清单与逐项状态见 [TASKS.md](TASKS.md)；契约见 [CONTRACTS.md](CONTRACTS.md)；评测场景见 [EVAL.md](EVAL.md)。
> 源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。评审基线：`nagi-review-2026-10-18.zip`（提交 `d59768c`）。

> **2026-10-18 接管更新**：作者要求 Codex 全权接管豆包原负责的绿区规格、评测、对账。新责任人与执行顺序见 [绿区接管方案_2026-10-18.md](绿区接管方案_2026-10-18.md)。下文豆包分工及历史对账保留为当时记录；当前绿区结论由 Codex 维护。P1-07 暂缓、B1 toast 待设备证据的状态不变。
> **首轮独立复核**：Node24 全量 919/918/0/1，构建 0，维护设备 12/12，D9 假桩 16/16（仅结构）；C5 已补真新进程重启与 `rag.recall` 异步断言，主对话后台抽取仍待验，详见 [绿区阶段2证据对账_2026-10-18.md](绿区阶段2证据对账_2026-10-18.md)。
> **阶段3 规格已补**：D3 关系事件、C3 主动开口时机、P3-08 统一导出已写入 CONTRACTS §13–15 与 EVAL §3.12–3.14；承诺簿遗忘语义已由作者裁决并写入 CONTRACTS §11.4，蓝区实现与绿区验收待续。规格完成不等于实现或验收通过。
> **D9 真模型首轮**：DeepSeek `deepseek-flash` 8×2 真实目标回复已采集，五个可观察文字维度初评 151/160，原始样本和限制见 [D9首轮评分记录_2026-10-18.md](D9首轮评分记录_2026-10-18.md)。多模态、首字时间、旧/新盲评与 D1 持久化声明未验，整卡不关。
> **B7/B9 核查**：五个待拆分 store 现状静态审计发现 36 处直接边界依赖；B9 隔离副本破坏实验已跑 12/12，命令和剩余覆盖缺口见 [B7_B9验证清单_2026-10-18.md](B7_B9验证清单_2026-10-18.md)。静态审计与局部破坏实验均不代表整卡通过。

---

## 当前交接快照（2026-10-18）

- **协作制重启**：由 2026-10-16 起的"单人开发制"恢复为三 Agent 协作。分工：🔴 Codex（架构/并发/契约落地）、🔵 WorkBuddy（常规实现+测试）、🟢 豆包（规格/评测/对账）。此版本**不以增加工具数量为路线**，重心是打通"情境理解—表达选择—可靠行动"的统一回路（评审 A 节）。
- **验证基线**（Node 24.19.0，评审文档实跑 8 个包 112 项通过）：**2026-10-18 绿区实测全量 `npm test`（`--experimental-test-module-mocks`）= 786 项，785 通过、0 失败、1 跳过**（跳过为无符号链接权限环境项，依赖模型缺失的失败属预期但本轮未现）。`npm run build` 退出 0 沿用历史结论。历史基线（2026-10-17 收口）：全量 667/666/0/1。
- **本机环境要点**（沿用）：
  - Node 24 目录前置 PATH：`E:\凪\.tools\node24\node-v24.19.0-win-x64`；默认 node 22 会令 electron mock 测试假失败，**全量必须用 Node 24**；
  - 受限环境真机验证加 `NAGI_RENDERER_SANDBOX=0`（GPU 沙箱内 0xC0000005 崩溃）；手动起 electron 先 `unset ELECTRON_RUN_AS_NODE`；
  - 偶发环境噪音：safe-delete 批量守卫（阈值 50）与 trash 二进制超时，属本会话工具层，复跑即过，非代码缺陷。

---

## 🔴 红区交接（Codex · 契约/并发/架构实现）

**当前在办**：阶段 1 的 P0 缺陷修复（P1-01 提醒路径、P1-02 RAG 入队、P1-03 归来泄漏、P1-06 标题授权、P1-07 危机兜底），以及阶段 2 的 P2-03 钩子顺序 / P3-07 多模态快照。**P1-06（C4）绿区规格已定稿**（CONTRACTS §6 + EVAL §3.5，D63 已裁决），红区可直接施工。

**契约红线**（实现必须遵守，详见 CONTRACTS.md）：
- 重要提醒送达与角色措辞**解耦**：原样展示用户提醒内容，LLM 只做可选润色；勿扰是否拦重要提醒需产品规则（勿与普通闲聊默认共用）。
- 人格边界跨提供商一致：主对话/主动/日记/工具四入口同一约束；高风险表达走同一护栏；失败系统状态明确展示，拒绝候选不入历史/RAG。
- 危机兜底（D7）：L2/L3 禁用 liminal/自我怀疑/低气压/吃醋/依赖暗示；高风险回复先检查再显；无网仍给安全指引。
- 标题感知（C4）：三种数据流如实展示；独立标题出站开关默认开启；出站前按当前设置+epoch 重验；已发远端不可撤回如实说明；标题不得提升为高权威指令。
- 渲染层：固定有序钩子表 + 权重交叉淡变让位 + 眨眼/口型所有权 + 值域检查，验收须读整链终值（组合测试）。

**勿动**：不改已冻结契约语义；不写规格定稿；不做作者已裁决之外的产品取舍。改 preload/IPC/安全门须先复现再补回归。

**下一轮（2026-10-18 绿区整理，承接阶段2蓝区首批对账，见 PENDING-CODEX 升级单5）**：
1. **拍板 modelHint 接通方式**：`resolveIntent` 的 modelHint 分支已备好且被单测覆盖（`src/core/agent/intent.js`），但 `agent.js:962` 调用处未接——接通需 `stream-normalize` 多带字段 + loop 透传一行。铁律"loop.js 零改动"由你定。拍：加那一行接通，还是接受"次轮生效"（本轮 modelHint 恒 null）。结论写回升级单5 第1项。
2. **拍板 C5-EXPORT-01 前置**：仓库无统一导出模块，绿区规格 EVAL §3.10 的 C5-EXPORT-01 依赖导出功能。拍：单开一张"记忆/数据导出"卡（阶段2/3）承接导出，C5-EXPORT-01 标注依赖它；还是从本阶段验收剔除。结论写回升级单5 第2项。
3. **阶段2 红区剩余**：P2-03 B6 已收口。确认阶段2 红区是否还有承接卡，或转阶段3（D5 多模态快照 P3-07 依赖 P1-05/P2-03，可预留）。

---

## 🔵 蓝区交接（WorkBuddy · 常规实现/测试）

**当前可并行**（TASKS 中 🔵 且无前置依赖的卡）：
- P1-05 情绪裁决统一（B5）：主进程产出 resolved 表达快照，renderer 不在 DONE 满强度重设，统一在线/离线衰减。
- P2-04 空 catch 分类 + 事件轨迹（B8）：按后果分类，持久化/承诺失败不可静默；有界脱敏事件轨迹。
- P3-04 常驻理由三时刻（C1）、P3-05 冷启动（C2）——均为入口与小流程，改动独立。
- （完成规格回填后）P2-01 D2 表达意图 + P3-03 D6 负面情绪的蓝区实现部分。

**每次续做先跑**：Node 24 前置 PATH 的 `npm test` → `npm run build` → 相关 `verify:*`。改动后回填 TASKS 状态与证据（测试命令/退出码/通过失败跳过数），待真机项不得标完成。

### 阶段1 蓝区收口（2026-10-18 14:0x，blue 自述）

**改动文件**（本轮共 5 个功能/验收提交：`f0c85be` B4、`a9cf064` B5、`a7cf0b5` C4、`02ce134` 验收脚本）：
- 新增：`src/core/agent/generation.js`、`src/core/emotion/resolve.js`、`src/core/signals/title-outbound.js`、`test/generation.test.js`、`test/emotion-resolve.test.js`、`test/title-outbound.test.js`、`scripts/verify-reminder-delivery.mjs`、`scripts/verify-title-outbound.mjs`
- 改动：`src/main/agent.js`（统一生成入口 / 四通道 / 分通道兜底 / `saySomething` 出站闸 / resolved 快照）、`src/core/agent/persona-guard.js`（`maxRetries` 2→1、`alwaysReview`）、`src/core/emotion/mood.js`（情绪归因、idle/night 不刷新互动、liminal 离线衰减）、`src/main/presence.js`（guard 纳入 `titleOutbound`）、`src/core/signals/foreground.js`（观测前缀 / 权威边界 / `enabled`）、`src/main/signals/music.js`（`currentObservationContext`）、`src/shared/protocol.js`（`privacy.titleOutbound` 默认 true）、`src/renderer/index.html`、`src/renderer/js/main.js`、`test/persona-guard.test.js`、`test/mood.test.js`、`package.json`
- 未动（红区）：`src/core/agent/loop.js` 本轮**零改动**；`persona-guard` 只改重写预算与 `alwaysReview` 开关，**规则正则一条未改**。

**已验证结果**（Node 24.19.0，`NAGI_RENDERER_SANDBOX=0` 用于真机）：
- `npm test`：**824 项 / 823 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:reminder`（真实 Electron + 临时 profile + 无 API key）：**10/10**
- `npm run verify:title-outbound`（假 LLM 抓真实 system 提示词）：**6/6**
- 说明：首跑全量时曾出现 8 项失败，**全部**是 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（count 50–53 ≥ 阈值 50），隔离复跑 `persist 6/6 + rag-revocation 5/5 + reminder-delivery 3/3 + reminder-recovery 1/1` 全过 → 环境噪音，非代码缺陷。

**新增测试 31 项**：`generation` 14（字段冻结 / provider 矩阵同决策 / 重写预算=1 / 分通道兜底 / crisis 永不为空 / 取消不重试）、`emotion-resolve` 5（longMood 与 tone 分层）、`title-outbound` 8（含设置页文案与"已发远端不可撤回"的来源断言）、`mood` +3（idle/night 不刷新互动、liminal 在线离线同衰减）、`persona-guard` 2 条改口 + 1 条新增（"预算为 1 不是 0"）。

**请豆包对账点**：
1. **数字更正**：`verify:reminder` 终态是 **10/10**。你栏里与本栏早前引用的 `9/10` 是修脚本前的首跑——失败项 F7 是**脚本自己的假设错**（只隐了工作台，桌宠窗仍可见），改为隐藏全部窗口后即 10/10；产品代码未为此改动。请把 EVAL 对账区与 PENDING-CODEX 的这处数字一并改口。
2. **C4-FLOW-01 的"长期记录不落盘"证据链**：我目前的证据是"`monitor/sampler.js` 的 `latest` 只在内存、日志只打 `titleLen` 不打标题原文、`music-store` 只存 `authorizedAt`"，属代码级旁证而非 store 级断言。请确认这个强度是否够；若要求更强，建议在 P2-08（B9 不变量）里补一条"采样落盘面无 title 字段"的结构断言。
3. **D7-CROSS-01 的 provider 矩阵口径**：我在 policy 层用四种适配器形状（云端原生流 / OpenAI 兼容 JSON 兜底 / 本地原生流 / 占位单次）验证"同一敏感输入同一决策"，**未接真实 Ollama**。请确认这是否满足 `[mock-io]` 层要求，或必须真本地模型跑一遍。
4. **勿扰口径空位**：B1 的"勿扰是否拦重要提醒"仍无产品规则，当前实现是"气泡不发、系统通知照发"。请在 CONTRACTS 里冻结一句裁决原文（我只能实现，不能定口径）。

**请 Codex 复核点**：
1. `instrumentGuard`（`core/agent/generation.js`）只是**包装** persona-guard 的 `review/retryInstruction` 做计数，判定结果原样透传；我以此拿到 `retryCount`/`ruleId`，从而**没有改 `loop.js` 的返回契约**。请确认这条路不违反"`agent.js` 唯一权威、不得擅改 Agent Loop 语义"。
2. 主动/日记/归来这些**没有用户输入**的通道，用 `createPersonaGuard('', { alwaysReview: true })` 只应用 `intent==='all'` 的三条通用红线（`self_destruct`/`sensor_claim`/`scripted_quote`）+ `empty_reply`，告别/身份/独占不硬套。请确认这个裁剪符合 §8"四通道同一约束"。
3. 我把 `saySomething` 当作主动/归来/微反应/监测的**共同出站闸**，并显式让 `kind==='reminder'` 不走该闸（提醒正文是用户原话，可靠性优先）。请确认这与 B1 的"提醒送达与措辞解耦"不冲突。
4. `presence` 的 guard 数组加入了 `privacy.titleOutbound`，改这个开关会让 `epoch++`。请确认不会误伤 B3（归来控制器）"10 分钟可恢复"的 epoch 语义。

**升级项**（沿用并补充）：
1. 绿区升级单 1（勿扰口径）→ 需作者裁决；裁决后我补 verify（≤1h）。
2. 绿区升级单 2（P1-02/P1-03 纯红区卡）→ Codex 排期。
3. 绿区升级单 3（D6/D2 测试空缺）→ 阶段2/3 回填。
4. **新增（蓝区）**：`scripts/verify-settings-nav.mjs` 已老化——它直接找 `#btn-pet-settings`，但 CDP 连上的是工作台页（只有 `#btn-open-settings`），当前必然超时。建议改为"按 mode 选入口 / 找不到就回落"，属验收脚本维护，**不动产品代码**。

**下一步（蓝区）**：① 等人眼确认 Windows 通知中心那条 toast（唯一未闭环项）；② 作者裁决勿扰口径后补 verify；③ 阶段2 蓝区卡 P2-04（B8 空 catch 分类）、P3-04（C1）、P3-05（C2）；④ 顺手修 `verify-settings-nav.mjs`（待允许）。

**下一轮（2026-10-18 绿区整理，承接你的提交 `16b1ee6`；对账见 PENDING-CODEX 升级单5，绿区逐条核实全部属实）**：
- **直接做（规格已就绪，无依赖）**：
  1. **activity 白名单装配**（P2-01 二期，CONTRACTS §8 D2 + §9 B7）：`context.js` 的 `normalizeSceneActivity` 已具备白名单+TTL，但 `agent.js:955-957` 传 null。按 CONTRACTS §8 D2"来源白名单"接线：只收 ①当前仍获授权的 monitor 活动分类、②获授权的当前媒体状态（播放/暂停照实标）、③presence 离线/模拟活动（`origin='simulated'` 不得说成真实经历）；未授权/过期/缺来源一律 null，宁缺勿造。验收：EVAL §3.x D2 场景化断言。
  2. **B8 按 CONTRACTS §12 补"可见"落地**（你要的标准已给）：主进程暴露只读健康 API（如 `getHealth()`）+ IPC 可查；持久化失败/承诺失败在设置页有状态标记（非仅 warn）；即时 UI 提示仅当失败影响用户当下操作，后台小错不打扰。验收：EVAL §3.11 B8-PERSIST/PROMISE/HEALTH/DEGRADE/SEMANTIC。
- **等拍板后再做**：③ modelHint 接通——等 Codex 拍"加一行 or 次轮生效"，未拍前保持恒 null；④ C5-EXPORT-01——等绿区/Codex 确认是否单开导出卡，已提交的"便签一跳"保持，勿自行扩展导出。
- **铁律**：无台词铁律；loop.js 未获 Codex 批准前零改动；完成回填 TASKS 状态与证据。

### 阶段1 闭环二轮（2026-10-18 14:5x，按 PENDING-CODEX 升级单 4 / Codex 三处打回）

**改动文件（本轮）**
- 新增：`src/core/agent/crisis.js`（L3→L2→L1 保守判定）、`src/core/agent/messages.js`（`assembleTurnMessages` + `isObservationMessage`）、`src/core/emotion/tone.js`（tone 生命周期）、`test/crisis.test.js`、`test/messages.test.js`、`test/emotion-tone.test.js`
- 改动：`src/main/agent.js`（crisis 接进 `safetyLevel`、危机空正文兜底、tone 按轮清除、观测行移出 system、`trimHistory` 剔除观测段）、`src/core/agent/persona-guard.js`（新增 `crisis` 开关 + `CRISIS_RULES`，**原有规则正则未改**）、`test/reminder-delivery.test.js`（裁决 A 两项）、`scripts/verify-title-outbound.mjs`（改断言位置）、`scripts/verify-reminder-delivery.mjs`（新增 G 段勿扰）
- 仍未动：`src/core/agent/loop.js`（**零改动**）；契约语义未改。

**已验证结果**（Node 24.19.0，真机 `NAGI_RENDERER_SANDBOX=0`）
- `npm test`：**845 项 / 844 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:reminder`：**14/14**（原 10 项 + G 段 4 项）
- `npm run verify:title-outbound`：**7/7**（A2 直接断言 system 里无观测标记；A1/C3 断言观测段在 user 角色）

**新增测试 21 项**：crisis 10（L3/L2/L1 分层、危机护栏四红线、兜底非空无号码、D7-CROSS-01 三适配器同决策、D7-GUARD-01 首稿合格）、messages 6（C4-AUTH-02 位置、顺序、无观测不产空段、前缀去重、可识别剔除、对抗标题）、emotion-tone 4（beginTurn 清空 / 连续两句独立 / 空白不产虚假来源 / 只读）、reminder-delivery +2（裁决 A 正反两面）。

**请豆包对账点**
1. **D7 只做到"接线"**：L1 的表达策略（承认感受／最多一个低问题／不推热线）未实现，EVAL §3.1 的 24 场景集也未跑。P1-07 我标的是"🔵部分落地"，别被"crisis 已接"误读成 D7 全绿。
2. `crisis.js` 的规则是**从 EVAL §3.1 样例 + §2.1 表反推的保守正则**，请按 §2.2 红线 2（正则只作辅助）给一句口径：这类判定要不要进 EVAL 作为"允许的近似"，还是必须等模型/规则混合判定。若你补充样例，我按样例补规则与测试。
3. **C4-AUTH-02 的"低权威"判定口径**：我实现成"独立 user 消息 + 固定抬头"，并在 `trimHistory` 里剔除（否则采样会固化进历史）。若你认为"user 段之前还需要一轮 assistant 才能算真正低权威"，请明示，我照改。

**请 Codex 复核点**
1. `crisis.js` 是我（蓝区）写的**判定器**，不是你指定的架构件。按 §8"agent.js 是唯一生成入口、persona-guard 是唯一审核规则"，我把判定放在 core 的独立纯模块、由 agent.js 调用；如果你认为判定应归红区或应走模型判定，请指路，我把这层换掉（接口只依赖 `classifyCrisis(text) → {level, safetyLevel}`）。
2. 观测段挪成独立 user 消息后，**同一轮会出现两条连续 user 消息**（观测段 + 原话）。OpenAI 兼容与云端网关都接受，但如果你对某些 provider 的连续同角色有顾虑，请指出——替代方案是把观测段并进最后一条 user 消息的前缀（同样不在 system）。
3. `mockRun` 也接入了 crisis（占位大脑同样走危机兜底）。这会让没有模型的机器在危机输入下输出安全指引而不是占位台词，请确认这符合 B1"无模型也要兜底"的预期。

**升级项**
1. 沿用：P1-07 剩余（L1 表达策略 + EVAL 场景集）、`verify-settings-nav.mjs` 老化、toast 人眼确认。
2. **新增**：`crisis.js` 需要绿区补一组"误判/漏判"对照样例（如转述他人、"电影里"），否则保守正则的边界只由我一人判断——这属于规格工作，我不越权自定。

### 阶段1 三轮（B4 占位大脑危机路径 · Codex 二轮复判打回）

**改动文件**
- 新增：`src/core/agent/offline.js`（`composeOfflineReply` + `OFFLINE_SELF_DEPRECATION`）、`test/offline-crisis.test.js`、`scripts/verify-crisis-offline.mjs`
- 改动：`src/core/agent/generation.js`（`CRISIS_GUIDANCE{L2,L3}` / `crisisGuidance(level)` / `generationFallback` 增加 `level`）、`src/main/agent.js`（`mockRun` 重写：危机轮不取角色台词、先定稿再送审、禁尾句、指引被误伤时保留指引；真实模型路径的危机兜底也按级别取文案）、`package.json`（`verify:crisis-offline`）
- 仍未动：`loop.js` 零改动；契约语义未改。

**已验证结果**
- `npm test`：**852 项 / 851 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:crisis-offline`：**11/11**（临时 profile 不配 key + 假服务器计数 → 断言"零模型请求"，即真·断网/无模型）
- `npm run verify:title-outbound`：**7/7**（回归）

**新增测试 7 项**（`offline-crisis.test.js`）：L3「我已经吃了很多药」→ 急救/到场且无占位台词；L2「我不知道还能撑多久」→ 先问此刻是否安全且不越级甩急救指令；announce 尾句顺序（普通轮有、危机轮无）；普通轮行为不变；未知级别按 L3；两段指引能过危机护栏；无具体号码。

**请豆包对账点**
1. 打回场景的复现句是 `…我现在接不上大脑。等接上了，我再好好回你。`——这句在**普通轮**仍然会出现（它是占位大脑的设计台词）。本轮只保证**危机轮**不再出现它，并额外保证首启动的自嘲尾句不再逃过审核。若你认为普通轮也不该说这句，请给规格，我另开。
2. `CRISIS_GUIDANCE.L2` 我刻意没提急救电话（L2 先确认安全、不越级）；L3 才给急救/到场。请确认这个分级与你 §2.1.1 的 L1/L2/L3 措辞策略一致。
3. 需要补的仍是 §3.1.1 场景集实跑与 §3.1.2 误判/漏判样例——本轮只做到"每条路径都有确定性文本"，没有跑 24 场景。

**请 Codex 复核点**
1. `mockRun` 里危机指引若被 guard 规则误伤，我选择**保留指引**（安全地板）而不是替换文案，并把 `ruleId` 记进 `guardDecision`。这与你"最终展示正文统一过 guard"的要求有一个取舍：过审是必须的，但当过审与"危机不许空"冲突时我让安全赢。若你要"误伤即视为规则 bug 并拦下"，请指路。
2. 危机轮的安全指引**会写入 history**（`guardDecision.ok` 为 true 时照常记账）。真实模型路径的"空正文危机兜底"是不入历史的（ok:false）。两条路径在这一点上不一致，我按"占位大脑的指引就是它这一句回复"处理；若要求统一为"安全指引一律不入历史"，我改一行。
3. `composeOfflineReply` 是纯函数、放在 core/agent；`mockRun` 只负责取词与送审。若你希望把"占位大脑定稿"收进 span 内某个既有模块，请指路。

**升级项**
1. 沿用：P1-07 的 L1 表达策略 + EVAL §3.1 场景集、toast 人眼确认、`verify-settings-nav.mjs` 老化。
2. **新增**：`verify:crisis-offline` 依赖"无 key"这一前提；若将来引入免密钥的本地模型默认值，这条脚本会静默变成"真模型路径测试"。建议在 B9（三层验收）里加一条"占位大脑路径的判定方式"约定。

### 阶段2 蓝区骨架（D2 实现 / B8 / C5，2026-10-18）

> 策略按作者指示「三张并行铺骨架」，本轮推进到**首批完成**：三条链路都已接进主流程并有
> 按 EVAL ID 钉住的测试（D6-CLS-01..04、D6-STOP-01、D6-ANGER-01、C5-FORGET-01、
> C5-RESTART-01、C5-BG-01）。三张卡仍**未到「完成」**，剩余项见每卡末尾。

**改动文件**
- 新增：`src/core/agent/intent.js`（六意图 + 规则层 + `resolveIntent` 优先级 + `intentDirective` + `parseIntentHint`）、`src/core/maintenance/event-trace.js`（有界/脱敏/可删）、`src/core/maintenance/catch-audit.js`（五类后果 + 上报器）、`src/main/maintenance.js`（单例装配）、`docs/遗忘数据地图.md`
- 改动：`src/core/context.js`（`buildSceneContext` / `normalizeSceneActivity` / `normalizeMemoryRefs`）、`src/main/agent.js`（`buildMessages` 接场景与意图裁决、system 追加「本轮怎么回应」、`intentState()` 调试出口）、`src/main/rag/store-io.js` + `src/main/reminders.js`（两处空 catch → 分类上报）
- 新增测试：`test/intent.test.js` 10 项、`test/scene.test.js` 7 项、`test/maintenance-trace.test.js` 7 项

**已验证结果**（首批完成时）
- `npm test`：**898 项 / 897 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:title-outbound` **7/7**、`npm run verify:crisis-offline` **11/11**、`npm run verify:reminder` **14/14**（回归，未受影响）

**首批新增/改动（相对骨架那一轮）**
- D2：意图规则补齐 D6-CLS 六条（情绪倾诉、求安静、愤怒指向、"帮我把…写了"夹宾语、求建议、先别讲道理）；
  新增 `sceneFactsBlock()` 做**事实 / 表达材料分离**（事实段只放白名单事实，并声明材料只能参考语气细节）。
- B8：新增 `createHealthRegistry()` 站点健康状态（计数/最近类别/最近消息脱敏），上报器可挂载；
  `maintenanceHealth()` 暴露只读快照；`clearMaintenanceTrace()` 同时清健康状态。
- C5：`presence-notes.pruneNotesReferencing()` 接进 `scrub()`，**便签一跳补上了**；
  片段匹配会按标点切子句（便签常只写原文一截，整句对不上会漏删）。

**D2 剩下的缺口（不是待优化，是没做完）**
1. **模型建议通道未接**：`resolveIntent` 支持 `modelHint` 且优先级/回退都测了，但"模型在同一次回复里给意图"需要 `stream-normalize` 多带字段 + `loop` 透传一行——**本轮铁律不许动 loop.js**，`modelHint` 恒为 `null`。**请 Codex 定**：给 loop 加一行透传，还是接受"次轮生效"。
2. **`activity` 白名单还没装配**：`buildSceneContext` 的 activity 仍固定 `null`（宁缺勿造）；需要 monitor 分类 / 媒体状态的授权快照接入。
3. **「按模型/用途存参数」未做**：现在只有 `llmProfiles`（按提供商存 baseURL/model/temperature），没有按**用途**（主对话/日记/抽取）的差异化参数。
4. **行为层未验证**：`intentDirective` 是否真能改变回答形态，需要 EVAL 场景集对照（绿区评测）。

**请豆包对账点**
1. D2 的 `userNeed` 是**规则层**判的；D6-CLS 六条已按 ID 钉住，但场景集里其他的说法我未必覆盖。请按 EVAL 场景集核一遍：**漏词就是漏意图**，给我缺失的句式我补规则（不要我猜）。
2. C5 数据地图里 **便签已实现**（`pruneNotesReferencing`，按标点切子句匹配）；还剩**承诺簿**（超契约自查项）和 **C5-EXPORT-01**——仓库目前**根本没有导出功能**，标注"主观/模拟/已删"需随导出一起做，请确认这条要不要单开卡。
3. B8 的"需可见状态"仍只做到"进轨迹 + warn"，**没接 UI**；健康状态也只到 `maintenanceHealth()`（无 IPC）。若 §3.7/§3.9 要求用户可见，请给具体位置与判定标准。

**请 Codex 复核点**
1. `src/core/maintenance/*` 放在 core 是否合适（我按"纯逻辑可单测"放的）；`src/main/maintenance.js` 是单例装配，未接任何 IPC——如果你希望轨迹能被工作台读到，需要一个只读 IPC，我没擅自加。
2. `store-io.readText` 我判成 `must-persist`（读失败≠没有数据）。但它在 `existsSync` 为假时返回 `''` 是**正常路径**——我只在真异常时上报。请确认这不会在"首次启动、文件尚不存在"时产生噪音。
3. `reminders.js` 的 `setInterval(... .catch(...))` 原来完全静默，现在进轨迹；重试仍由下一拍承担（未做退避）。若 B8 要求"承诺失败可重试 + 健康状态"，退避与健康状态需要单独设计，我这轮没做。

**升级项**
1. **Codex 决策项**：意图模型建议通道（loop 透传 or 次轮生效）——**仍未拍，modelHint 继续保持 null**。
2. **绿区规格项**：承诺簿的遗忘口径；C5-EXPORT-01 是否单开导出卡。
3. **蓝区剩余**：其余空 catch 逐点分类；按模型/用途存参数。

### 阶段2 蓝区二批（2026-10-18，activity 装配 + B8 可见落地）

**改动文件**
- 新增：`src/main/ipc/maintenance.js`、`test/maintenance-health.test.js`、`scripts/verify-maintenance-ui.mjs`
- 改动：`src/core/context.js`（`pickSceneActivity` + `SCENE_CATEGORY_LABELS` + `SCENE_PRESENCE_LABEL`）、`src/main/agent.js`（活动来源注入、monitor 授权戳）、`src/shared/protocol.js`（`monitorAuthorizedAt` + `MAINTENANCE_IPC`）、`src/main/index.js`、`src/preload/index.js`、`src/renderer/index.html`、`src/renderer/js/main.js`、`test/scene.test.js`、`package.json`

**已验证结果**
- `npm test`：**908 项 / 907 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:maintenance` **7/7**（新）、`verify:title-outbound` 7/7、`verify:crisis-offline` 11/11、`verify:reminder` 14/14

**D2 activity 装配（§8 白名单）**
- `pickSceneActivity` 优先级：媒体（播放/暂停照实标）> monitor 分类 > presence 模拟；三类都必须带 `authorizedAt`，**`authorizedAt=0` 视为"从没授权"直接丢弃**——不用当前时间冒充授权时间。
- monitor 授权戳在 `startActivityMonitor()` 里写一次 `privacy.monitorAuthorizedAt`；监测关掉后不再产生新分类，旧值由 TTL 兜住。
- 标题仍不进活动事实：`pickSceneActivity` 只认白名单字段，即使传了 title 也不会被用（有测试）。

**B8 可见落地（§12.2）**
- 主进程 `maintenanceHealth()` → 只读 IPC `maintenance:health`（附最近 10 条轨迹）；`maintenance:clear` 可删。
- 设置页「连接」组新增**维护状态**区：只列"最近一次仍是异常"的站点（`lastClass !== 'degrade'`），可降级不显示、不打扰；打开设置与点该分组都会刷新。
- `verify:maintenance` 覆盖 preload → IPC → 渲染三层；首跑 B1/B2 失败是**脚本自己绕过 openSettings 直接去 hidden**，改走真实入口后 7/7。

**请绿区对账**
1. B8 的"即时 UI 提示"我**没做**：现在只有设置页状态 + 轨迹。§12.2 说"仅当失败影响用户当下操作才弹"，我找不到可判定的"影响当下操作"信号。需要一条可执行规则，否则不擅自加弹窗。
2. `privacy.monitorAuthorizedAt` 是新写进 settings 的字段。如果你认为"授权时间"该有独立展示（帮用户确认何时开的），请一并说。

**请 Codex 复核**
1. `pickSceneActivity` 放在 `core/context.js`；媒体状态走 `musicStatus(false)`（读缓存，不新起探针）——请确认不会每轮对话都拉起一次媒体探针进程。
2. 设置页新增一块只读区域（连接组顶部），未改任何既有开关语义；若你认为设置页结构要冻结，我可以挪到工作台单独面板。

### 阶段2 蓝区三批（2026-10-18，作者裁决 B：监测授权时间可见）

**改动文件**
- `src/renderer/index.html`（监测区新增 `#monitor-authorized-at`，默认 hidden）、`src/renderer/js/main.js`（`renderMonitorAuthorizedAt`；保存后即时刷新；**打开设置时重取 settings**）、`src/main/monitor/index.js`（`syncAuthorizationStamp`：开启打戳 / 关闭清零 / 勿扰不重置；`refreshMonitorPrivacy` 与 `startMonitor` 都经过它）、`src/main/agent.js`（撤掉重复打戳，避免两处时间戳漂移）
- 新增测试：`test/monitor-authorized-visible.test.js` 4 项（展示位/位置/文案语义/打戳只在主进程）；`scripts/verify-maintenance-ui.mjs` 增 D 段 5 项

**已验证结果**
- `npm test`：**912 项 / 911 通过 / 0 失败 / 1 skip，exit 0**
- `npm run build`：**exit 0**
- `npm run verify:maintenance` **12/12**（原 7 + 裁决 B 5）、`verify:title-outbound` 7/7、`verify:crisis-offline` 11/11、`verify:reminder` 14/14

**口径（按裁决 B 冻结，勿改语义）**
- 文案固定为「监测于 <本地化时间> 授权」；无可信戳时**整行不显示**，不显示"未授权"也不拿当前时间凑。
- 时间只来自主进程 `privacy.monitorAuthorizedAt`；界面不写这个字段。
- 打戳规则：开启监测且无戳 → 打；关掉监测 → 清零；勿扰 / 只陪着是临时状态，**不重置**。

**顺带修的真 bug（不是为测试改）**
- 设置面板原来用渲染层缓存的 `settings` 填表，托盘/另一窗/主进程改过的字段会停在旧值上——裁决 B 这行正好暴露了它（真机上首次跑 D3/D5 失败就是这个）。现在 `openSettings()` 每次重取一次 settings。

**请豆包对账**
1. 这一行属于"状态展示"，没有任何动画/交互；若你说的"设置页监测区域"指的不是 `data-group="companion"` 里的「活动监测」块，请指出我挪。
2. B8 即时提示的判定信号我按你给的口径**没有新增任何弹窗**（保存失败仍走内联 + 设置页状态），本轮只加了裁决 B 这一行。

### 阶段2 蓝区收口（2026-10-18，带暂缓项）

**本轮补的最后一块：按模型/用途存参数（P2-01）**
- `core/llm/providers.js`：`resolveLlm(cfg, purpose = 'chat', { defaultTemperature })`，认 `cfg.purposeParams[purpose]`（temperature 0–2 / model / baseURL），非法值忽略、不改入参。
- 接线：主对话 `'chat'`；日记 `'diary'`（缺省仍是 0.9，可被 `purposeParams.diary.temperature` 覆盖）。
- 设置默认 `llm.purposeParams: {}` —— **空表时行为与改造前逐字一致**（有测试守着这条）。
- 未做：设置页没有给用途参数做 UI（只能改 settings.json）。这是"能力已通、界面未做"，不算完整，故 P2-01 仍标 🔵。

**收口数字**
- `npm test` **919 / 918 通过 / 0 失败 / 1 skip，exit 0**；`npm run build` **exit 0**
- `verify:maintenance` **12/12**、`verify:title-outbound` **7/7**、`verify:crisis-offline` **11/11**、`verify:reminder` **14/14**

**四张清单（哪些已完成、哪些明确暂缓）**
| 卡 | 阶段2 交付 | 未完成（暂缓/依赖） |
|---|---|---|
| P2-01 D2 | 六意图裁决 + 优先级 + 场景白名单（媒体/monitor/simulated）+ 事实/材料分离 + 按用途参数 + 裁决 B | `modelHint`（Codex 裁决：后续实施轮）、用途参数无 UI |
| P2-04 B8 | 五类分类 + 有界脱敏轨迹 + 站点健康 + 只读 IPC + 设置页状态区 | 其余空 catch 未逐点分类（117 处粗数，不做无差别加壳） |
| P2-06 C5 | 数据地图 + 便签清理 + FORGET/RESTART/BG | C5-EXPORT-01（P3-08）、承诺簿口径（绿区） |
| 裁决 B | 设置页「监测于 <时间> 授权」+ 主进程打戳规则 + 真机 12/12 | 无 |

**请绿区/红区在阶段2 对账时注意**
1. P2-01 的"参数按提供商保存"是**旧有能力**（`llmProfiles`），我这次只补了"按用途"；对账时别把前者算成本轮成果。
2. B8 的 117 处空 catch，我**刻意没有批量套壳**：那属于大搬移，且多数是可选探针（真降级）。真要全覆盖，建议单开一张"逐模块审计"卡，按模块分批，而不是在 B8 里一次性改完。



---

## 🟢 绿区交接（豆包 · 规格/评测/对账）

**已完成的绿区规格草稿**（写入 CONTRACTS.md / EVAL.md）：
- CONTRACTS §1 人格最小一致集（身份锚/表达铁律/事实边界/关系边界 + 验收）。
- CONTRACTS §2 D7 危机兜底三层原则 + 红线（L1 低落 / L2 强烈绝望 / L3 立即危险）。
- CONTRACTS §3 D6 负面情绪接住策略（倾诉/建议/执行/安静分类 + 行为契约）。
- CONTRACTS §4 D4 liminal 短弧线（四拍弧线 + 一天一次 + 不冻结生命体征 + 触发须真实）。
- CONTRACTS §5 D2 表达意图枚举（brief-ack/listen/clarify/solve/reminisce/boundary + 使用规则）。
- CONTRACTS §6 C4 标题感知三种数据流 + 独立标题出站开关 + 出站前撤销重验（D63 已裁决）。
- EVAL.md 24 场景框架（普通闲聊4/负面情绪4/工具提醒4/记忆纠错4/告别身份独占危机4/断网迟回忽略重启4）+ 评测方法 + 红线 + 对账表 + §3 可直接转测试断言（D7/D6/D4/C4/人格一致集，共 38 条）。

**阶段2 绿区规格（2026-10-18 已落地，只写 docs 不动业务代码）**：
- P2-05 **B7 分层契约** → CONTRACTS §9（纯计算/IO 适配器/Electron 编排三层 + now/rng/路径边界注入 + 渐进迁移）+ EVAL §3.7（B7-PURE/INJECT/IO/ORCH）。
- P2-08 **B9 验收不变量** → CONTRACTS §10（三层测试结构 + 关键项独立 + 参数错十倍必红 + 测试自身防腐）+ EVAL §3.8（B9-KEY/×10/NOFOLLOW/SABO）。
- P2-07 **D8 长期一致性** → EVAL §3.6 断言补全（D8-STAB/FACT/TONE/NOGRID/REPEAT）。
- P2-02 **D9 场景评测口径** → EVAL §3.9（抽 8 高频×2、六维 0–2 分、红线一票否决）。

- P2-06 **C5 遗忘端到端验证** → CONTRACTS §11（数据地图 + 验证目标 + 验收）+ EVAL §3.10（C5-FORGET/RESTART/BG/EXPORT/CORRECT）。

**待补的绿区规格**（TASKS 中 🟢 标"待写/待验证"）：
- P3-01 D3 关系事件规格；P3-06 C3 主动开口时机规格。

**对账职责**：维护 EVAL 对账区；定期跑场景集；对红/蓝区提交的验收结果做对账复核。

**阶段1蓝区收口前对账（2026-10-18，只写结论，不改代码）**：
- **验证基线**：Node24 全量 `npm test` **824 项 / 823 通过 / 0 失败 / 1 跳过**（较上轮 +38 项，为 B4/B5/C4 新增测试）；`npm run build` 退出 0。B5+C4 相关单测 46/46 全绿。
- **P1-05（B5）✅ 符合**：主进程唯一权威（agent.js DONE 先固定 tone 进快照再 `mood.propose(…,'llm')`）；`core/emotion/resolve.js` longMood/tone 显式分层、tone 不写回；renderer `applyMood` 只消费快照、删掉 onDone 满强度重设；mood.js idle/night/rhythm 推力 `interaction:false` 不刷新 lastInteraction、liminal 在线/离线同衰减曲线。测试 `emotion-resolve 5 + mood 补 3` 覆盖。
- **P1-06（C4）✅ 符合**：EVAL §3.5 八条断言全被 `title-outbound.test.js` 覆盖（C4-SW-01/02、DND、REVOKE-01/02、BLACK、AUTH、FLOW）；独立开关 `privacy.titleOutbound` 默认开、三护栏优先；`agent.js` 出站前 `titleOutboundAllowed` 按设置+epoch 重验；presence guard 纳入 titleOutbound。真机 `verify:title-outbound` 6/6（四跳全通）。
- **P1-04（B4）✅ 符合**：`generation.test.js` + `persona-guard.test.js` 覆盖 provider 矩阵同决策、重写预算 1、分通道兜底、crisis 兜底永不为空且不给具体号码、拒绝候选不入消息。`maxRetries` 2→1 已按契约对齐并记录（见 TASKS）。
- **P1-01（B1）⚠️ 部分**：真机 `verify:reminder` **10/10**（Codex 更正：终态 10/10，早前 9/10 是修脚本前首跑、F7 为脚本假设错、产品代码未动）；余 1 项需人眼看 Windows 通知中心 toast；"勿扰是否拦重要提醒"为**作者裁决项**，已进 PENDING-CODEX 升级单 1。
- **偏离/缺失**：① PENDING-CODEX 原引用"§6 红区接口骨架"已漂移，本轮修正为 **§8**；② P1-02/P1-03 关单记录缺失（Codex 凭 `9abf398` 关单，TASKS 未回填，见升级单 2）；③ D6（P3-03）/D2（P2-01）测试为空属阶段归属，进入阶段2/3 时须按 EVAL 回填，防"我能帮你什么"红线漏测。
- **结论**：阶段1蓝区经 **Codex 二轮复判**（见 PENDING-CODEX 顶部"阶段 1 二轮 Codex 复判"）：B2/B3/B5/C4 **通过**（绿区读码确认 B5/C4 属实：`lastTone` 重构为 `createToneState()`+`beginTurn` 清除、C4 观测行移出 system 为低权威 user 段）；**B4 仍打回**。**注意**：蓝区 104 行"mockRun 已接 crisis"是误读——`safetyLevel` 虽传进 mockRun，但 crisis 轮仍先走 `NagiPersona.reply` 普通文本，`{crisis:true}` guard 判定"接不上大脑"合格即展示，未强制走安全指引。阶段1 **仍不能整体收口**，待：B4 修（🔵）、toast 设备证据（👤/🔵）、P1-07 剩余 L1 策略+场景集（🟢）。详见 PENDING-CODEX。

**Codex 二轮复判 · 绿区核实（2026-10-18）**：
- B5 ✅ 属实：`lastTone` 已重构为 `createToneState()`（tone.js，agent.js:165）；`beginTurn` 每轮清除（:1020-1022）、`settle` 本句固定（:257），比"置 null"更完整。
- C4 ✅ 属实：观测行移出 system（agent.js:932 注释、:934 `observationContextLines`），独立低权威 user 段（:936 `assembleTurnMessages({system,history,observation,userText})`），符合 CONTRACTS §6.4 与 EVAL C4-AUTH-02。
- B4 ⚠️ 打回属实（根因已定位）：`mockRun`（agent.js:789-837）crisis 轮仍 `body = r.text`（NagiPersona.reply 普通文本），guard 判定合格即展示；"接不上大脑"不违反红线 → 直接展示。修法见 PENDING-CODEX 顶部复判第 16 行（占位大脑 L2/L3 直接走确定性安全指引 + announce 前定正文 + 危机轮禁自嘲尾句 + 补 mockRun L2/L3 断网/无模型测试）。
- 阶段2 前置契约：CONTRACTS §8 D5/B6/D2/B9 均已"已可直接施工"，属实。
- **P1-07 剩余（绿区待办，Codex 指派）**：L1 表达策略未完成；EVAL §3.1 场景集未完成；`crisis.js` 保守正则在转述/虚构语境下的误判漏判需绿区补对照样例并评测。

**阶段2 Codex 裁决 · 绿区核实（2026-10-18）**：
- **modelHint 本轮不接**：Codex 指出时序关键——`buildMessages` 在模型请求前裁决意图并写进 system，模型输出的 hint 晚于该时点，单行透传无法参与本轮裁决。取舍正确（避免"下一轮继承上一轮 hint"污染）；保留 `loop.js` 零改动，P2-01 保持部分完成（首批完成、待二批 activity+参数保存+后续实施轮接 modelHint）。
- **C5-EXPORT-01 新增 P3-08**：新增阶段3 P3-08「记忆/数据导出」卡，C5-EXPORT-01 标「待验」依赖 P3-08；阶段2其余 C5 遗忘断言独立验收不阻塞。正确（导出能力缺失不删验收，单开卡承接）。
- **红区排期**：P2-03 B6 已关；阶段2无新增红区卡；P3-07 D5 预留阶段3（前置 P1-05/P2-03 已落地）。属实。
- 提交 `da21d16`（意图单测 17/17）：git 未装无法复核提交，但升级单5 裁决内容已在；TASKS P3-08/P2-01/P2-03 已同步。
- **待办**：WorkBuddy 二批——activity 白名单装配、按模型/用途存参数、B8 按 CONTRACTS §12 补可见落地；Codex 阶段3 承接 P3-07/P3-08。

**对 Codex 四问的回应（2026-10-18）**：
1. **C4-FLOW-01"长期记录不落盘"证据链**：代码级旁证（sampler `latest` 只在内存、日志只打 `titleLen` 不打原文、music-store 只存 `authorizedAt`）**满足 `[mock-io]` 层要求**；可在 P2-08（B9）补一条"采样落盘面无 title 字段"结构断言作加固，非本阶段阻塞。
2. **D7-CROSS-01 provider 矩阵口径**：policy 层四种适配器形状（云原生流 / 兼容 JSON 兜底 / 本地原生流 / 占位单次）验证同一敏感输入同一决策，**满足 `[mock-io]` 层要求**（mock-io 即主进程 mock IO）；未接真实 Ollama 属 `[device]` 层抽样，阶段1 不强制。
3. **勿扰口径**：绿区建议冻结——**"勿扰开启时：桌面气泡不发，重要提醒仍发系统通知"**，待作者裁决；裁决前 Codex/WorkBuddy 不得自行改动该默认。
4. **`verify:reminder` 10/10**：确认采纳，EVAL 对账区与 PENDING-CODEX 的 9/10 已改口为 10/10。

---

## 项目事实与保留约束（三区共享，改动须先复现）

- 沿用 `core/main/renderer/shared` 四层。Agent 双通道（native tools / JSON 兜底）、确认门一次性 token、授权快照核验、IPC 来源校验、渲染沙箱、命令黑白名单、文件真实路径边界均为有效契约。
- 记忆体系：账本（四类经历+信任分层+纠错/遗忘/导出）、RAG（只收新日记、崩溃自愈、tombstone）、关系层（熟悉度五档+情绪时间线）、年鉴（引用式）、承诺簿（完成需证据）。**只让之后的新日记进入 RAG**，不批量补录旧日记。
- 人格：《灵魂与程序》为唯一基准；无固定台词；情绪标签只驱动表情；宕机是"短暂失去熟练"而非长时间失能；不设计催促/挽留/愧疚机制。
- 语音：维持现有引擎与音色（edge 晓晓→SAPI 降级链、sherpa→SAPI）；注册表桩不算实现。
- 活动记录边界：默认仅内存；模拟活动**不是**真实外界经历，不得升级为共同经历；休眠/关机不补造。
- 打包：electron-builder NSIS+portable，asarUnpack playwright，模型走 extraResources；`npm run pack` 快速验证。

## 安全债（详见 TASKS 历史 B 节）

- FIX-1（HA extra 覆盖）**已修**（2026-10-17）；FIX-2（外部进程替换竞态）已评估未复现降级为已知限制；FIX-3（Playwright 生命周期）**已修**（2026-10-17）。FIX-4/5/6/7/8 均已修/澄清。历史详细结论见 TASKS.md 原 B 节。

## 恢复路径（如果再次中断）

1. 留在 `main`（本地提交、无远程）。续做入口：TASKS 顶部"2026-10-18 新版评审任务卡"，当前是阶段 1。
2. 先读本页三栏 → 各自栏的待办 → 对应任务卡（TASKS）→ 契约（CONTRACTS）→ 评测（EVAL）。
3. 每次续做先跑：Node 24 前置 PATH 的 `npm test` → `npm run build` → 相关 `verify:*`。
4. 真机/发行版/设备验收清单见 `docs/阶段10人工验收清单.md` 与 TASKS D 节，未完成项不得标注完成。
