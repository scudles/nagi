# 凪 Nagi：三栏交接本（HANDOFF）

> 本文件是 🔴 Codex / 🔵 WorkBuddy / 🟢 豆包·绿区 三 Agent 协作的**交接本**。任一 agent 恢复上下文先读本页。
> 任务卡清单与逐项状态见 [TASKS.md](TASKS.md)；契约见 [CONTRACTS.md](CONTRACTS.md)；评测场景见 [EVAL.md](EVAL.md)。
> 源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。评审基线：`nagi-review-2026-10-18.zip`（提交 `d59768c`）。

> **2026-10-19 归属恢复（当前有效）**：作者要求绿区归还豆包，规格、评测、对账和验收状态维护由豆包负责；Codex 恢复红区职责。交接清单和分支状态见 [绿区归属恢复_2026-10-19.md](绿区归属恢复_2026-10-19.md)。下面的 2026-10-18 接管更新保留为历史，不代表当前归属。
> **2026-10-18 接管更新（历史）**：作者当时要求 Codex 全权接管豆包原负责的绿区规格、评测、对账。执行顺序见 [绿区接管方案_2026-10-18.md](绿区接管方案_2026-10-18.md)。当时绿区结论由 Codex 维护。P1-07 暂缓、B1 toast 待设备证据的状态不变。
> **首轮独立复核**：Node24 全量 919/918/0/1，构建 0，维护设备 12/12，D9 假桩 16/16（仅结构）；C5 已补真新进程重启与 `rag.recall` 异步断言，主对话后台抽取仍待验，详见 [绿区阶段2证据对账_2026-10-18.md](绿区阶段2证据对账_2026-10-18.md)。
> **阶段3 规格已补**：D3 关系事件、C3 主动开口时机、P3-08 统一导出已写入 CONTRACTS §13–15 与 EVAL §3.12–3.14；承诺簿遗忘语义已由作者裁决并写入 CONTRACTS §11.4，蓝区实现与绿区验收待续。规格完成不等于实现或验收通过。
> **D9 真模型首轮**：DeepSeek `deepseek-flash` 8×2 真实目标回复已采集，五个可观察文字维度初评 151/160，原始样本和限制见 [D9首轮评分记录_2026-10-18.md](D9首轮评分记录_2026-10-18.md)。多模态、首字时间、旧/新盲评与 D1 持久化声明未验，整卡不关。
> **B7/B9 核查**：五个待拆分 store 现状静态审计发现 36 处直接边界依赖；B9 隔离副本破坏实验已跑 14/14，命令和剩余覆盖缺口见 [B7_B9验证清单_2026-10-18.md](B7_B9验证清单_2026-10-18.md)。静态审计与局部破坏实验均不代表整卡通过。

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

### 阶段2 蓝区第四轮（2026-10-19，D1 红线修复：自然语言事实纠错的同属性槽确定性撤权）

**分支 `blue/stage2-d1-fix`，基线 `ff95ee3a`。决策见 [DECISIONS](DECISIONS.md) D66。本轮不自行标绿。**

- **为什么修**：绿区在 `green/stage2-integration` 上对 `ff95ee3a` 做独立验收，阶段二只剩 D1 一条红线。
  真机两 case（蓝→绿、杭州→上海）口头答对，但 memory/ledger/rag/重启 system 四层旧事实全活着。
  根因是撤权只靠抽模型逐字复现 `remove`，而 temp=1.3 下模型被纠正时只 `add` 不复现旧文本。
- **选型**：契约选项 **b**（`mergeMemoryEntries` 同槽归并），不用 a（意图识别后再构造 op）。
  b 是确定性的、不依赖用户怎么表达；模型 `remove` 保留为补充路径。
- **改了什么**（只动撤权链，未碰 `src/renderer/`、`loop.js`、记忆系统整体结构）：
  - `src/core/memory.js`：新增 `memorySlot` / `supersedeSameSlot` + 五条判据 + 槽位词表；
    `MEMORY_EXTRACT_PROMPT` 改口（`remove` 从"必须逐字"改为"尽量照抄，拿不准留空"，并说明系统会按属性确定性作废）。
  - `src/main/persist.js`：`mergeMemoryOps` 三来源逐个试 `deleteLedgerSource`，任一成功即算撤权；
    三种都没成功 → `ledgerRevocationFailed` 如实上交（不猜"查无此条"还是"写入失败"）。
  - `src/main/agent.js`：`syncFactsToRag` 返回 `{forgotten, failed}`，"没有这条"不算失败，
    其余进 `ragRevokeRetry`（上限 50、幂等、下次抽取自动重试）；新增 `reportRevocationGaps` 按 B8 上报。
    健康快照**只报条数与站点，不塞旧事实原文**（与 D65 对提醒正文的纪律同源）。
- **测试**：新增 `test/d1-natural-correction.test.js` **17 项**（A 层 12 纯函数 + B 层 5 三层落盘集成，
  mock electron / mock ledger 间谍 / 真 RagService，全假模型桩）。核心回归 A1/A2 与三层落盘 B1/B2
  用的都是绿区真机铁证原文。**反向验证**：摘掉 `supersedeSameSlot` → 8 项立刻变红，还原后 17/17。
- **数字**：全量 **987 / 986 过 / 0 失败 / 1 条件 skip**（基线 970 + 17）；`npm run build` **exit 0**。
  既有 `memory` 13/13、`persist` 6/6、`rag` 35/35、`rag-revocation` 5/5 无退化。
- **⚠️ 给绿区的重要提醒（自查发现，别被我的单测数字迷惑）**：第一版单测全绿时，我逐字核对了
  `scripts/verify-d1-persistence.mjs` 的 case 原文，发现**两处会让真机照样漏撤**的缺口——
  ① city 词表原本只有 `住在|居住`，认不出脚本里那句「我**住的是**上海」；
  ② `lexiconValue` 取第一个颜色词，会把「不是蓝色是绿色」里被否掉的旧值当成当前值，
  判据⑤直接放行。两处都已修（city 补 `住的?是`；lexiconValue 先剔否定词再取最后一个），
  并新增 A12 用真机 correct 原文钉住，反向验证（回退两处 → A2/A12 立刻变红）。
  **所以：我单测绿过不等于真机绿过，请务必按脚本原文复跑。**
- **留给绿区**：请用 `scripts/verify-d1-persistence.mjs` 复跑两 case + D8-FACT，四层
  （memory / ledger / rag / 重启 system）旧事实全撤权且新值唯一，才转绿、阶段二才关单。
  另请注意两处实现取向：① 槽位词表是**保守集**，认不出的属性不触发同槽撤权——这是"宁可漏撤，不可误删"的
  自觉取舍，若真机出现漏撤 case，应该是补词表，不是放宽判据；② **省略主语**的纠正句（"并非蓝色，是紫色"）
  不撤权，因为判据③（是用户自身 claim）不满足——绿区两 case 的 correct 都带主语，不影响验收。

### 阶段2 蓝区收口批次1（2026-10-19，分支 `blue/stage2-d1-hometown-g3`，基线 `cf5e09d`）

两件互不相干的小事，都不碰 `src/renderer/` 与 `loop.js`。决策见 DECISIONS D67。

**① D1：city 槽细分为「老家 / 现居」**（`src/core/memory.js`）
- D66 把 city 做成单槽，词表同时含 `老家|故乡|籍贯` 与 `住在|住的是|搬到|迁到` → 绿区探针复现存证：
  `supersedeSameSlot([{我老家在北京},{我住在杭州}], ["我住的是上海"])` 一次删两条，老家被误删。
  老家和现居是**两个独立事实**，不是同一个值的两个版本——同槽归并的前提在这里不成立。
- 修法：`memorySlot` 细分 `city:current` / `city:home`（不是在判据④外加特例——子语义是数据模型的
  一部分）。判据②「同槽」天然挡住跨子语义，判据链不动；`hasSlotKeyword` 从同一 `SLOT_RULES` 派生。
- 子语义顺序 **current 在前、home 在后**："我老家杭州，现居北京"这类同时含两类词的句子，
  归 home 会误撤别的老家，归 current 只会与别的现居同槽——**错得起价更小**（有意识取舍）。
- 测试 A13（5 条）/ A14（1 条），A10 槽断言同步改。反向验证：合并回单槽 → A10/A13/A14 立刻红。
- **给绿区**：老家 case 的真机形态（用户先说自己老家、再更正现居）请补一条，确认不误删。

**② G3：settings.json 写盘静默（B8 必修，涉隐私）**（`src/main/settings-store.js` + 5 调用方 + `persist.js`）
- 根因：`saveSettings` 先 `cache = next` 再 try 写盘，catch 只 `console.error` 后**无条件 return next**。
  → IPC/托盘/监测授权/外部便签全"成功"，renderer 刷成新值，磁盘没写，重启恢复默认。
  对 `privacy.noticeShown` / `monitorAuthorizedAt` / 监测开关就是**隐私假关闭**。
  它能在 B8 审计下存活，是因为那是**带 console.error 的非空 catch**，空 catch 扫描扫不到；
  调用方的 `try/catch + reportCatch` 也永远不会触发（这里根本不抛）——一层假防护。
- 修法：① 落盘成功才更新 cache（失败时内存与磁盘一致）；② 单点上报 `settings.saveSettings`
  / MUST_PERSIST；③ 向上抛。`settings.json` 同时纳入 `PERSIST_FILES`（退出刷盘 + persist-warnings）。
  调用方只做控制流：IPC 靠 throw 自然 reject（**代码零改动**）、托盘失败不广播且菜单回滚、
  便签授权/撤销失败回 `{ok:false}`、装束失败回 `{ok:false}`、启动初始化失败不崩（幂等可重试）。
- 上报与抛出的错误**不含文件路径**（只带 fs code），用户设置正文不进健康快照。
- **踩的坑**：第一版把 `windows.resizePetWindow` / `outfit.registerOutfitIpc` 的 reportCatch 当
  "重复上报"删了 → `B8-AUDIT-01` 立刻红。那两处是 B8 **防回潮清单**钉的关键站点，已恢复。
  双报不是 bug：「设置写不进去」和「桌宠尺寸因此没记住」是两个关注点。
- 测试 `test/g3-settings-persist.test.js` **5/5**（mock fs 造 EACCES）：G3-A 抛错+cache 不更新+磁盘不变+上报；
  G3-A2 脱敏（不含路径/不含设置字段）；G3-B IPC reject 且不广播、不跑后置刷新；G3-C 成功路径不回归；
  G3-D flushPersist 纳入 settings.json + 失败进 persist-warnings + 可取回清空。
  反向验证：换回旧静默实现 → G3-A/A2/B/D 立刻红，只有成功路径 G3-C 保持绿（应该的）。

**数字**：d1 **19/19**、g3 **5/5**、B8 catch 审计退出 0（50 处全分级）、全量 **994 / 993 过 / 0 失败 /
1 条件 skip**（基线 987 + 7）、`npm run build` 退出 0。

**与红区 `red/stage2-renderer-catch` 零重叠**：红区相对共同基线 `ff95ee3` 只改 `src/renderer/*`（6 js +
index.html）+ `test/renderer-catch.test.js` + 2 份绿区文档，与本轮 10 个文件交集为空。`loop.js` 未碰。

**⚠️ 交红区的一条（本轮按纪律未动 renderer）**：`src/renderer/js/main.js` 的 `maybeShowMonitorNotice`
（约 1129-1136 行）是「先隐藏遮罩再 await、`catch { /* ignore */ }`」。即使主进程现在 reject，
**遮罩已隐藏且不会重显**——用户点「关闭监测」落盘失败时仍看不到"保存失败，请重试"。
红区只需把那个 catch 改成显示 `err.message`（主进程已给中文可读文案），并按
`settings.privacy.noticeShown` 仍为 false 重显遮罩。设置页路径（`bindSaveButton`）与托盘路径
**已满足**"不显示已授权/可重试"，不受此影响。



---

### 阶段3 P3-08 C5 统一导出（2026-10-19，分支 `blue/stage3-p3-08-export`，基线 `969c377`）

**受测提交**：本块所在提交（`git log -1 --oneline`），基线 `969c377`（绿区阶段2 关单基线）。
**契约断言**：CONTRACTS §15（统一导出、逐项来源、主观/模拟/已删标注、外部副本不静默删除）+
EVAL §3.14 C5-EXPORT-01..04。

**做了什么**
- `src/core/export/build.js`（纯函数 497 行）：信任层五类（`user-confirmed`/`observed`/`subjective`/
  `simulated`/`unverified`）、条目投影、**跨来源墓碑清洗**（拿账本已删条目正文去撞流水/日记/便签/痕迹/锚点）、
  `buildExportBundle`/`serializeExport`/`parseExport`。不碰 fs、不读时钟。
- `src/main/export.js`：取数复用 P2-06 数据地图同一批位置（账本含已删 / memory.json / 流水 / 独白日记 /
  年鉴 / 便签+痕迹+锚点 / 承诺簿 / 对话历史），落盘走「系统保存框 → existsSync 预检 → `.partial` →
  `linkSync` 原子占位」，失败清残局并按 B8 `degrade` 上报；**外部旧副本永不删改**；预览不写盘。
- `src/main/ipc/export.js` + `IPC.DATA_EXPORT`/`DATA_EXPORT_PREVIEW` + preload `dataExport.run/preview`。
- 只读辅助：`readAllJournalDays()`（`main/journal.js`）、`listDiaryFiles()`（`main/diary.js`）。

**命令与退出码**
| 命令 | 结果 |
|---|---|
| `node --experimental-test-module-mocks --test`（Node 24.19.0 前置 PATH） | **1030 项 / 1029 过 / 0 失败 / 1 条件 skip**，exit 0 |
| `node_modules/.bin/electron-vite.cmd build` | **exit 0** |
| `node scripts/b8-catch-audit.mjs scan` | **50 处全分级（degrade 50），exit 0** |
| `node --test test/export-build.test.js` | **15/15** |
| `node --test test/export-io.test.js` | **7/7** |
| `npm run verify:p3-08-export`（真机 Electron） | **18/18** |

**证据路径**：`test/export-build.test.js`、`test/export-io.test.js`、`scripts/verify-p3-08-export.mjs`、
DECISIONS **D68**。真机脚本自带隔离 profile（`%TEMP%/nagi-p308-*`），跑完自清。

**反向验证（用户要求）**：三处同时打断——① 已删条目不再输出墓碑；② 关掉跨来源正文清洗；
③ 写盘去掉存在性预检直接覆盖 → **纯函数 3 红（A2/B1/B5）、IO 4 红（IO-1..IO-4）、
真机 6 红（C6/C7/C8/C12/E1/E2）**；还原后三层全绿（15/15、7/7、18/18）。

**结论**：实现完成，**未自行标 ✅**。C5-EXPORT-01/03/04 已由真机脚本走真实链路取证；
C5-EXPORT-02（外部副本不静默删除）由"只写一个新文件、桌面选择器选目标、不触碰既有文件"结构性保证 +
E1/E2（同日二次导出失败且原文件一字节不动）覆盖。

**缺口（两件，都需别人接）**
1. **设置页缺「导出全部数据」按钮**——主进程/IPC/preload 全通，用户当前无可视入口
   （`#btn-ledger-export` 只导账本）。按纪律**不碰 `src/renderer/`**（红区同文件未合流），
   接入片段见 DECISIONS D68 ⑦。
2. **真机脚本里种子的 id 必须按 `sourceId()` 契约算**（`e_`+sha256(`type:ref`).slice(0,20)），
   且种子 profile 必须带 `ledger/migration.json`，否则旧档迁移会掺副本。绿区若自造 profile 请照此办。

---

### 阶段3 core 边界迁移第一批（2026-10-19，分支 `blue/stage3-p3-08-export`）

**受测提交**：本块所在提交。**契约**：B7 core 边界（`audit:b7:core` / `audit:b7:gate`）——core 不读全局时钟/随机、不碰 fs。

**分批清单**：`docs/b7-core-batches.md`（127 处剩余 → 8 批，逐文件标 now/rng/crypto/fs 与风险）。

**本轮做完的是批 1（8 处）**：`signals/{calendar,foreground,music,players}.js` 6 处 +
`export/build.js` 2 处（本分支自己新欠的债，一并清掉）。做法：新增 `src/core/clock.js` 的
`requireNow(now, site)`，签名去掉 `now = Date.now()` 默认值，缺依赖当场抛
`TypeError: <site> 缺少注入依赖：now`。

**为什么这批零语义风险**：所有调用点本来都显式传了 `now`，默认值是死重量；既有测试
**一行没改**即全绿（calendar 3/3、foreground 8/8、music-signal 8/8、players 7/7、export 15/7）。

**命令与退出码**
| 命令 | 结果 |
|---|---|
| `node --test test/b7-batch1-now-injection.test.js` | **8/8** |
| `node scripts/audit-b7-boundary.mjs --strict`（门禁 8→14 文件） | **0 处越界，exit 0** |
| `node scripts/audit-b7-boundary.mjs --scope=core` | **135 → 127 处**（-8） |
| 全量 `node --experimental-test-module-mocks --test`（关沙箱） | **1038 项 / 1037 过 / 0 失败 / 1 条件 skip** |
| `electron-vite.cmd build` | **exit 0** |

**证据路径**：`test/b7-batch1-now-injection.test.js`、`src/core/clock.js`、
`docs/b7-core-batches.md`、`docs/b7-boundary-core-report.json`、DECISIONS **D69**。

**反向验证**：把 `musicContext` 的默认值放回去并绕过 `requireNow` → **B7-1-04 与 B7-1-08 立刻变红**，还原后 8/8。

**结论**：批 1 完成，**未自行标 ✅**；门禁已扩到本批文件（回潮即红）。

**下一批建议**：批 2 `signals/ha-consent.js`（5 处，fs+crypto+隐私授权，**必须单独一批**）→
批 3 `rag/chunk.js`+`rag/recall.js`（8 处，纯计算）。`loop.js` 按纪律不动；`face/*` 四处
先评估再决定是硬迁还是行内 `B7:allow` 豁免（逐帧热路径）。

---

### 阶段3 无依赖入口小卡（P3-04 C1 / P3-05 C2）· 2026-10-19：**阻塞在规格，未写代码**

**先说结论**：`CONTRACTS.md` 里**没有 C1/C2 的章节**（现有 1–15 节里既无「常驻理由三时刻」也无「冷启动」），
`EVAL.md` 里**没有任何 C1-*/C2-* 断言编号**，`TASKS.md` 这两行的「规格」列本身写的就是 `—`。
按纪律**不自定产品口径**，所以本轮交的是问题清单，不是实现。

**已核实的现状（供绿区写规格时对齐现实，不是提案）**

| 卡 | 代码里已经有的东西 |
|---|---|
| C1 三时刻 | `core/presence/{reunion,away,circadian,engine,hooks}.js`（回来/离开/时段判定与上下文注入）、`rhythm-pose.js`；`core/promises/book.js` + `main/reminders.js`（交办与提醒）；`core/tools/*`（工具产物）；设置页「勿扰 / 只陪着」与 `ambient.js` |
| C2 冷启动 | `core/relation/familiarity.js`（`firstMetAt`/熟悉度分级）、`core/presence/anchors.js` 的 `nickname` 锚点、`main/presence-notes.js` 会把提到称呼的记忆归为 `nickname`；`core/persona.js` 已写「不说主人/用户，用名字或专属称呼」 |

**P3-04 C1 · 需要产品口径的 5 个问题**

1. **「回来」的判定边界**：多长不在算回来？沿用 `away.js` 现在的阈值，还是另设？「不审问」禁的是
   疑问句本身，还是禁「盘问具体去哪」？（决定做成 prompt 约束还是固定文案——两种成本差一个量级）
2. **「工作安静」与现有「勿扰 / 只陪着」是什么关系**：新增一档，还是复用？安静期间一次日程提醒算不算打扰？
3. **「交办有结果」的形态**：对话里一句 / 工作台卡片 / 系统通知？**失败**算不算「有结果」
   （按 B8 语义失败必须可见，但"可见"落在哪个面需要定）？
4. **「工具产物可读」**：产物指路径、摘要还是正文？允许她把文件内容念出来吗（隐私边界）？
5. **「工作台不冲淡陪伴」的可测口径**：没有可测口径就写不出 EVAL 断言。例如「工作台打开时，
   主动开口频率不得低于 X」「她的形象区域不被工作台遮挡超过 Y%」——具体指标请绿区定。

**P3-05 C2 · 需要产品口径的 6 个问题**

1. **「首次」以什么为准**：`relation.firstMetAt` 为空？presence 首次启动？换 profile / 重装算不算首次？
2. **「称呼偏好可跳」**：入口在哪（设置页 / 对话内一次性问）？**跳过后默认怎么称呼**
   （"你"？省略主语？）——这条会直接进 persona，必须由作者/绿区定，我不猜。
3. **「默认安静」**：新装默认关闭主动开口吗？现在 `DEFAULT_SETTINGS` 的默认值请绿区核一遍再定口径。
4. **「一次可查看结果的小任务」**：具体是哪一个任务？结果展示在哪？（需要作者从现有能力里挑一个，
   否则就是我在自定产品）
5. **「允许纠正"你误会我了"」**：纠正之后要发生什么——撤回上一轮理解 / 记一条偏好 / 仅口头承认？
   这是**数据层语义**（要不要写进 memory / ledger），不能由实现方猜。
6. **「无打卡无登录压力」**：要不要一条可测断言（例如首启界面不出现任何签到/登录元素）？

**需要绿区一并补的**：C1/C2 的 EVAL 断言编号（`C1-*`/`C2-*`）。没有断言编号，实现完也没有验收依据，
这跟 C5 当初"无导出能力前保持待验"是同一个问题。

**本轮未做**：未改任何代码、未改任何默认值、未新增文案。收到规格后这两张卡都属"入口与小流程"，
改动面小（预估各 1 个提交）。

---

### 补证（2026-10-19 18:51，分支 `blue/stage3-p3-08-export`，受测提交 `c70a37e`）：本机**有** Ollama，`verify:local-llm` **44/44**

**先认错**：我之前三次写「`verify:local-llm` 三项失败是缺设备（本机未安装 Ollama）」，**这是错的**。
判断只看了 `ollama` 是否在 PATH、两个默认安装目录、`11434` 是否连通——便携版不注册 PATH、
不在默认目录、没起服务，**观测结果与"未安装"完全同形**，我把"没看见"当成了"不存在"。
更打脸的是 `docs/M6_端侧模型实测_2026-10-16.md` 第 29 行本来就写着这套 `verify:local-llm` **23/23 通过**，
查一圈文档就能否掉这个结论。

**实际有什么**：`E:\凪\.tools\ollama\`，27G。
`runtime/ollama.exe` v0.34.0（同目录还留着 1.47G 的源 zip）+ `models/` 24G，6 个模型：
`qwen2.5:latest`、`qwen3:4b`、`qwen3:4b-instruct`、`qwen3:8b`、`qwen3.5:4b`、`qwen3.5:9b-q4_K_M`。

**为什么像没有**：`~/.ollama/` 下只有 `id_ed25519{,.pub}`，**没有 `models/` 目录**。
默认模型目录是空的，直接 `ollama serve` 于是一个模型都列不出来。

**复跑口径**（照抄即可）：

```bash
cd /e/凪/.tools/ollama/runtime
OLLAMA_MODELS='E:\凪\.tools\ollama\models' OLLAMA_HOST=127.0.0.1:11434 ./ollama.exe serve
# 另开一个终端
cd E:/凪/凪_交接包_2026-10-16/02_工程源码_nagi
NAGI_RENDERER_SANDBOX=0 node scripts/verify-local-llm.mjs
```

**结果（六要素）**

| 项 | 内容 |
|---|---|
| 受测提交 | `c70a37e`；工作区无源码改动（`git diff HEAD --stat` 为空），本轮**零代码改动** |
| 契约断言 | 脚本自带 44 项 M6 真机验收（EVAL 里无 `M6-*` 编号，脚本即口径） |
| 命令与退出码 | `electron-vite build` → 0；`NAGI_RENDERER_SANDBOX=0 node scripts/verify-local-llm.mjs` → **44 ✔ / 0 ✘，退出 0** |
| 证据路径 | `/e/凪/.tools/local-llm-verify-2026-10-19.log`（44 ✔ / 0 ✘）；userData `%TEMP%\nagi-local-llm-zA8Zci`；**DECISIONS D71** |
| 结论 | 暂缓项消解，全链路真机通过；`模拟日历事件经可信 IPC 只读可见` 通过 = D69/B7 注入构造的行为证据 |
| 缺口 | ① 待绿区独立复验，**蓝区不标 ✅**；② **只证接口与链路，不证模型人格质量**（B03 `benchmark-local-llm` 边界集未跑）；③ 服务是本会话手动起的，机器重启后要按上面命令重起 |

**顺带纠正一条检索习惯**：判「某工具在不在本机」，除了 PATH 和默认安装目录，**必须查 `E:\凪\.tools\`**
——本项目所有便携工具都在这儿（`node24/`、`ollama/`、`npm/`、`isogit-runtime/`）。

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
