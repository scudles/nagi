# core 边界存量迁移 · 分批清单（B7 延续）

> 数据来源：`node scripts/audit-b7-boundary.mjs --scope=core` → `docs/b7-boundary-core-report.json`。
> 口径：一次扫描的**实测值**，不是估算。每批完成后重跑本命令，数字必须下降，否则视为该批没生效。
> 门禁：`node scripts/audit-b7-boundary.mjs --strict`（`MIGRATED_GATE` 里的文件回潮即 exit 1）。
> 本文只管「怎么分批」和「每处属于哪一类」；具体做法与取舍记在 `docs/DECISIONS.md`。

## 口径说明

| 规则 | 含义 | 替代路径 |
|---|---|---|
| `globalClock` | 直接调 `Date.now()` | 注入 `now`（纯函数 → `requireNow()`；有状态对象 → 构造参数 `now`） |
| `globalRandom` | `Math.random()` / `randomUUID()` | 注入 `rng`（缺了抛错，不许退回全局随机） |
| `directCrypto` | 直接 `import node:crypto` | 同上（多半就是 randomUUID/sha 的别名问题） |
| `directFs` | 直接 `import node:fs` | 注入文档/行式 IO 端口（`core` 不碰文件系统） |
| 路径 | 直接 `node:path` 拼路径 | 也走端口：core 连路径形状都不该知道 |

`/* B7:allow:<rule> — 理由 */` 只用于**确定性纯计算**（不依赖"现在"、不依赖随机、不碰 IO 的地方），
必须写清为什么它不该被注入。拿它当"消红灯"的手段等于把门禁关掉。

## 现状

- 基线（`969c377`，即阶段2 关单基线）：**133 处**
- 批 1 之前：**135 处**（本分支 P3-08 新增的 `core/export/build.js` 自己也带进 2 处默认值，
  已在批 1 里一并清掉——新代码不给自己留债）
- 批 1 完成后（本分支）：**127 处**（135 - 8 = 127，相对阶段2 基线净 -6）
- 剩余：**127 处 / 35 文件 / 15 组**

## 分批

### 批 1 · signals 纯函数层 + 导出组装层（本轮已完成，**8 处**）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/signals/calendar.js` | 2 | globalClock |
| `src/core/signals/foreground.js` | 1 | globalClock |
| `src/core/signals/music.js` | 2 | globalClock |
| `src/core/signals/players.js` | 1 | globalClock |
| `src/core/export/build.js` | 2 | globalClock |

**为什么先挑这组**：都是纯函数，只差一个"现在"就能算；调用点（5 个 store + main 的 signals 层）
本来就逐个显式传了 `now`，默认值是**死重量**——去掉默认值后既有测试零改动即全绿，
说明这批改动只删噪音、没动语义。替代路径统一 `requireNow()`（`src/core/clock.js`）。
防回潮 `test/b7-batch1-now-injection.test.js` **8/8**。

### 批 2 · signals 收尾：ha-consent（**5 处**，风险偏高，单列）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/signals/ha-consent.js` | 5 | directFs 1 / directCrypto 1 / globalRandom 1 / globalClock 2 |

**为什么单列**：这是 core 里少数**直接读写文件**的地方（`signals/ha.json` 的临时文件 + rename），
且紧挨隐私授权（智能家居读写授权）。迁移需要：① main 侧建一个文档 IO 端口给它；
② `rng` 注入替掉 `randomUUID` 临时名；③ `allowRead/allowControl` 的 `at` 必传。
动的是"授权是否生效"，做错会变成隐私假授权——**必须单独一批、单独验证**，不和别的混。

### 批 3 · rag 纯函数（**8 处**，低风险）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/rag/chunk.js` | 6 | globalClock |
| `src/core/rag/recall.js` | 2 | globalClock |

切块与召回打分的时间戳，纯计算，调用点在同一层。风险低，可整批做。

### 批 4 · tools（**17 处**，中风险）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/tools/browser.js` | 9 | globalClock |
| `src/core/tools/system.js` | 6 | globalClock |
| `src/core/tools/files.js` | 2 | globalClock |

工具层的时间戳多用于超时/节流判断，改动本身机械，但**这些地方最好别改语义**
（超时阈值偏一点就变成"工具莫名失败"）。建议按文件分三次提交，每文件跑一次工具测试。

### 批 5 · presence（**33 处**，最大一组，需再拆）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/presence/imperfection.js` | 12 | globalClock 10 / globalRandom 2 |
| `src/core/presence/notes-file.js` | 6 | globalClock |
| `src/core/presence/notes.js` | 5 | globalClock |
| `src/core/presence/anchors.js` | 5 | globalClock 4 / globalRandom 1 |
| `src/core/presence/traces.js` | 3 | globalClock |
| `src/core/presence/reaction.js` | 1 | globalClock |
| `src/core/presence/ha-rules.js` | 1 | globalClock |

`imperfection.js` 的随机是**语义本身**（"不完美"就是随机迟到/打错字），不能简单换成注入后当常量；
需要"注入 rng 但默认可测"的设计（注入一个可复现序列），这决定了它得单独一批。
`notes-file.js` 是"外部便签写盘"的决策层（真写盘在 main），时钟用于节流判断。

### 批 6 · core 顶层散件（**17 处**）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/context.js` | 5 | globalClock |
| `src/core/diary.js` | 5 | globalClock 4 / globalRandom 1 |
| `src/core/journal.js` | 4 | globalClock |
| `src/core/memory.js` | 2 | globalClock |
| `src/core/ambient.js` | 1 | globalClock |

`memory.js` 那两处是 `mergeMemoryEntries/applyMemoryOps` 的 `now = Date.now()` 默认值——
**注意**：D66 的撤权链依赖这两个函数的 `now`，改必传时要一并检查 `persist.js` 的调用点，
否则会变成"抽取写完记忆但时间戳 undefined"。

### 批 7 · 三个 store 相邻文件（**22 处**）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/promises/book.js` | 10 | globalClock 6 / globalRandom 2 / directCrypto 1 / directFs 1 |
| `src/core/companion/budget.js` | 6 | globalClock |
| `src/core/reminders/schedule.js` | 6 | globalClock |
| `src/core/relation/familiarity.js` | 5 | globalClock |
| `src/core/relation/timeline.js` | 1 | globalClock |

`promises/book.js` 同时有 fs + crypto + random + clock，是**唯一一个四类齐全**的文件，
迁移量最大、也最容易把承诺簿写盘弄坏——单独一批、配 `c5-promise*` 全套回归。
`budget.js` / `schedule.js` 都是"算下一次什么时候"的纯时间逻辑，适合一起做。

### 批 8 · voice / face / monitor / emotion / llm / agent（**19 处**，逐文件零散）

| 文件 | 处数 | 类型 |
|---|---|---|
| `src/core/voice/backchannel.js` | 5 | globalClock |
| `src/core/voice/enum-cache.js` | 2 | globalClock |
| `src/core/face/blink.js` | 1 | globalClock |
| `src/core/face/expression.js` | 1 | globalClock |
| `src/core/face/eye.js` | 1 | globalClock |
| `src/core/face/turn.js` | 1 | globalClock |
| `src/core/monitor/engine.js` | 1 | globalClock |
| `src/core/monitor/throttle.js` | 1 | globalClock |
| `src/core/monitor/tracker.js` | 1 | globalClock |
| `src/core/emotion/mood.js` | 1 | globalClock |
| `src/core/llm/cloud-workbuddy.js` | 2 | directCrypto 1 / globalRandom 1 |
| `src/core/agent/loop.js` | 2 | directCrypto 1 / globalRandom 1 |

**`loop.js` 不动**（作者纪律：蓝区不碰编排）。`face/*` 的四处时钟在每帧热路径上，
注入会带来逐帧参数传递——**先量收益再动**，很可能这四处的正确做法是
`/* B7:allow:globalClock — 逐帧缓存的失效判定，注入会穿透到每个参数写入点 */`。

## 执行纪律（每批都适用）

1. 先跑一次 `--scope=core` 记下**本批要动的文件 + 处数**，改完复跑，数字下降才算生效；
2. 本批文件加进 `MIGRATED_GATE`（回潮即红），并补一条"缺依赖当场抛"的锁测试；
3. 相关单测 + `--strict` + `npm run build` + 全量，缺一不可；
4. 一批一个提交，提交说明写清"本批文件 / 处数 / gate 数字 / 家底数字 / 反向验证"。
