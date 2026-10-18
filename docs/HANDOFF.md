# 凪 Nagi：三栏交接本（HANDOFF）

> 本文件是 🔴 Codex / 🔵 WorkBuddy / 🟢 豆包·绿区 三 Agent 协作的**交接本**。任一 agent 恢复上下文先读本页。
> 任务卡清单与逐项状态见 [TASKS.md](TASKS.md)；契约见 [CONTRACTS.md](CONTRACTS.md)；评测场景见 [EVAL.md](EVAL.md)。
> 源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。评审基线：`nagi-review-2026-10-18.zip`（提交 `d59768c`）。

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

**待补的绿区规格**（TASKS 中 🟢 标"待写/待验证"）：
- P2-05 B7 分层契约（纯计算/IO 适配器/编排）规格；P2-06 C5 遗忘端到端验证；P2-08 B9 验收不变量；P3-01 D3 关系事件规格；P3-06 C3 主动开口时机规格。

**对账职责**：维护 EVAL 对账区；定期跑场景集；对红/蓝区提交的验收结果做对账复核。

**阶段1蓝区收口前对账（2026-10-18，只写结论，不改代码）**：
- **验证基线**：Node24 全量 `npm test` **824 项 / 823 通过 / 0 失败 / 1 跳过**（较上轮 +38 项，为 B4/B5/C4 新增测试）；`npm run build` 退出 0。B5+C4 相关单测 46/46 全绿。
- **P1-05（B5）✅ 符合**：主进程唯一权威（agent.js DONE 先固定 tone 进快照再 `mood.propose(…,'llm')`）；`core/emotion/resolve.js` longMood/tone 显式分层、tone 不写回；renderer `applyMood` 只消费快照、删掉 onDone 满强度重设；mood.js idle/night/rhythm 推力 `interaction:false` 不刷新 lastInteraction、liminal 在线/离线同衰减曲线。测试 `emotion-resolve 5 + mood 补 3` 覆盖。
- **P1-06（C4）✅ 符合**：EVAL §3.5 八条断言全被 `title-outbound.test.js` 覆盖（C4-SW-01/02、DND、REVOKE-01/02、BLACK、AUTH、FLOW）；独立开关 `privacy.titleOutbound` 默认开、三护栏优先；`agent.js` 出站前 `titleOutboundAllowed` 按设置+epoch 重验；presence guard 纳入 titleOutbound。真机 `verify:title-outbound` 6/6（四跳全通）。
- **P1-04（B4）✅ 符合**：`generation.test.js` + `persona-guard.test.js` 覆盖 provider 矩阵同决策、重写预算 1、分通道兜底、crisis 兜底永不为空且不给具体号码、拒绝候选不入消息。`maxRetries` 2→1 已按契约对齐并记录（见 TASKS）。
- **P1-01（B1）⚠️ 部分**：真机 `verify:reminder` **10/10**（Codex 更正：终态 10/10，早前 9/10 是修脚本前首跑、F7 为脚本假设错、产品代码未动）；余 1 项需人眼看 Windows 通知中心 toast；"勿扰是否拦重要提醒"为**作者裁决项**，已进 PENDING-CODEX 升级单 1。
- **偏离/缺失**：① PENDING-CODEX 原引用"§6 红区接口骨架"已漂移，本轮修正为 **§8**；② P1-02/P1-03 关单记录缺失（Codex 凭 `9abf398` 关单，TASKS 未回填，见升级单 2）；③ D6（P3-03）/D2（P2-01）测试为空属阶段归属，进入阶段2/3 时须按 EVAL 回填，防"我能帮你什么"红线漏测。
- **结论**：阶段1蓝区（P1-05 B5）与共建实现（P1-04/P1-06）实现符合契约、测试全绿；**但 Codex 复判打回 B4/B5/C4 三处运行边界**（绿区已核实属实，见 PENDING-CODEX 升级单 4），阶段1 **暂不能整体收口**，待三处闭环 + B1 作者裁决 + B2/B3 关单复核。

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
