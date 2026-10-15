# RAG 长期记忆系统设计 v1

> 2026-10-15。目标：突破当前「长期记忆 ≤60 条 + 对话历史 ≤40 条」的容量天花板，
> 让凪拥有**近乎无限**的经历记忆，同时守住三条底线：隐私（本地处理）、
> 性能（常驻低占用）、稳定（任何组件失效都能静默退回现状）。
>
> 需求锚点：《AI角色需求文档_v1》FR-5「记忆：短期对话上下文 + 长期记忆」、
> 技术架构「本地结构化存储 + **轻量向量检索**」、NFR「LLM/TTS/ASR 全接口抽象」。

---

## 0. 现状与缺口

| 层 | 现状 | 缺口 |
|---|---|---|
| 精选事实层 | `core/memory.js` + `main/persist.js`：LLM 抽取「关于用户的事实」，≤60 条，**全量**注入提示词 | 只能存"事实"，存不下"经历"；60 条硬上限，超出丢最旧 |
| 对话历史层 | `main/persist.js`：≤40 条滑窗，重启后仍只带最近 40 条 | 滑出窗口的对话**永久丢失**——三个月前聊过的事她想不起来 |
| 经历层 | 无 | 共同经历（"那天你说的那个项目""你上次难过的那次"）无法召回 |

**设计原则：RAG 不推翻现有两层，而是新增第三层「经历档案层」。**
事实层保人格连续性（永远全量注入），档案层保经历细节（按需召回）。

---

## 1. 向量数据库选型与存储结构

### 1.1 选型结论：自建纯 JS 扁平索引，不引入外部数据库

候选对比：

| 方案 | 结论 |
|---|---|
| Qdrant / Milvus / Chroma（外部服务） | ❌ 桌宠不该拖一个数据库服务进来，违背 NFR「常驻低占用」 |
| sqlite-vec / better-sqlite3 | ❌ better-sqlite3 需按 Electron ABI 重编译，正是 Vosk/ffi-napi 踩过的坑 |
| hnswlib-node / vectordb | ❌ 同为原生预编译，Electron ABI 风险同級 |
| **自建扁平索引（brute-force cosine）** | ✅ 个人助理的量级（估 5 万 chunk 上限）根本不需要 HNSW；纯 JS 零原生依赖，进 asar 无坑，可完整单测 |

量级测算：5 万 chunk × 512 维 × 4 字节 = **97MB** 向量常驻内存（Float32Array 连续存储），
单次全量扫描 5 万 × 512 ≈ 2560 万次乘加，JS 紧循环约 **20–40ms**——
检索发生在调 LLM 之前一次，对首响（NFR ~1s）的影响可忽略。
真到 20 万 chunk 那天，再换 HNSW（接口已抽象，store 可替换）。

### 1.2 存储结构（`userData/rag/`）

```
userData/rag/
├── meta.json        # { version, model, dims, count, deletedCount, updatedAt }
├── vectors.bin      # 二进制：header(dims,count) + Float32 行连续存储，追加写
├── chunks.jsonl     # 元数据，一行一条，追加写；删除=写 tombstone 行
└── pending.jsonl    # 还没嵌入成功的文本 chunk（模型没装/推理失败），启动时 backfill
```

**chunk 记录**（`chunks.jsonl` 每行）：

```json
{
  "id": "c_20261015_ab12cd",      // 稳定 id：日期+内容哈希前 6 位
  "kind": "turn",                  // turn=一轮对话 | fact=精选事实 | diary=独白 | event=事件
  "role": "both",                  // user | assistant | both（一轮对话算一条）
  "text": "他：…\n我：…",           // 实际被嵌入的文本
  "at": 1760000000000,             // 发生时间
  "day": "2026-10-15",
  "hit": 0,                        // 被召回次数（衰减/淘汰策略用）
  "lastHitAt": 0,
  "vec": true                      // 是否已嵌入（pending 里为 false）
}
```

**为什么 vectors.bin 与 chunks.jsonl 分开**：向量是定长 Float32，二进制连续存储才能做到
「追加写 + 启动时一次读入 Float32Array」；元数据是变长 JSON，JSONL 追加 + compact 最省事。
两者用 `meta.json.count` 对齐行号。

**写入路径**：`append`（JSONL 追加 + vectors.bin 追加 + meta.count++）→ 防抖落盘。
**compact**：tombstone 超过 30% 或文件超过阈值时，重写两文件（照抄现有 `persist.js`
的「临时文件 + rename」原子写模式）。

### 1.3 隐私边界

- 所有 chunk 只存**对话文本**，与日记同款约束：不存窗口标题、不存监测数据。
- 默认走**本地模型嵌入**，内容不出本机；云端 embedding 是显式可选项，选之前明确告知「这段对话会传给第三方」。

---

## 2. 对话历史的向量化与索引方案

### 2.1 嵌入引擎（接口抽象，可无缝切换）

`core/rag/embedding.js` 定义契约，两个适配器：

| 引擎 | 实现 | 说明 |
|---|---|---|
| `local`（默认） | `main/rag/embed-local.js` | onnxruntime-web（**纯 WASM**）+ @huggingface/tokenizers（WASM，360KB）+ 下载量化 ONNX 模型；零原生编译，无 Electron ABI 风险 |
| `openai`（可选） | `main/rag/embed-openai.js` | 任何 OpenAI 兼容 `/v1/embeddings` 端点；需用户显式开启并知晓隐私含义 |
| `none` | — | 都没就绪时 RAG 静默关闭，系统行为与今天完全一致 |

**模型选型**：`bge-small-zh-v1.5`（512 维，中文检索 SOTA 级小模型，量化版 ~25MB）。
备选 `multilingual-e5-small`（384 维，多语言）。下载走 **hf-mirror → huggingface 双源回退**
（与 sherpa 模型下载同款链路，已验证可用）。GGUF/ONNX 量化版由 Xenova 社区导出，直接可用。

**为什么不用 `@huggingface/transformers` 官方包**：它会拖入 `onnxruntime-node`（原生，
Electron ABI 不符）和 `sharp`（原生）。我们只用它的 WASM 部分，自己写 ~80 行的
pipeline（tokenize → session.run → mean/CLS pooling → L2 归一化），
换来：依赖干净（无原生）、包体可控、全链路可单测（能用已知句对验证相似度排序）。

### 2.2 什么进索引（chunk 生产）

| 来源 | 时机 | kind |
|---|---|---|
| 每轮对话（user+assistant 整轮为一条） | `runTurn` 的 `finally`，fire-and-forget | `turn` |
| LLM 抽取出的新事实 | `extractMemoriesAsync` 成功后同步一条 | `fact` |
| 滑出 40 条窗口的历史轮次 | `trimHistory` 时补记（防重启丢） | `turn` |
| 日记/独白、提醒完成 | 二期接 | `diary`/`event` |

- **去重**：内容哈希相同直接跳过（同句不发两次向量）。
- **失败容错**：先写 `pending.jsonl`（纯文本），嵌入成功再升级进正式索引；
  模型没装 / 推理失败都不阻塞对话，下次启动 `backfill()` 补齐。

### 2.3 索引结构

扁平索引：`vectors.bin` 读入为一个 `Float32Array(count × dims)`，第 i 行 = 第 i 条 chunk。
检索 = 全表 cosine。附带两个廉价优化：

1. **候选池预筛**：`fact` 类 + 最近 90 天的 `turn` 全量在池内；更老的轮次按
   `score × recencyDecay` 自然沉底（不删除，只是排不下来）。
2. **命中记账**：被召回进提示词的 chunk `hit++`，为压缩/淘汰提供数据。

---

## 3. 相似度检索与上下文召回策略

`core/rag/recall.js`（纯函数，可单测）：

```
输入：query 文本 + 当前时间 + 索引 + 预算
  ↓ ① 嵌入 query（与入库同模型同预处理）
  ↓ ② 全表 cosine → 原始分
  ↓ ③ 时间衰减：score *= 0.5 ^ (ageDays / 45)     // 45 天半衰：旧的沉但不消失
  ↓ ④ 类型权重：fact ×1.15 / turn ×1.0
  ↓ ⑤ 阈值：score < 0.32 丢弃（宁可不注入，不可注错——注错记忆=人格漂移）
  ↓ ⑥ MMR 去冗余：λ=0.7，避免 5 条全是同一件事的复读
  ↓ ⑦ 预算截断：总字符 ≤ 600（约 300–400 token），按分排序取
输出：[{ id, text, at, score }] → 格式化成带时间感的句子
```

**召回格式**（注入提示词时长这样，时间感是「经历」的关键）：

```
- 你想起的相关往事：
  「三个月前（08-12）他说过：在做一款叫凪的桌宠项目…」
  「上周三（10-08）你们聊到：他担心发布会讲不好…」
```

**与现有注入的关系**：`buildContextBlock` 新增 `recalled` 参数，排在 `memories`（事实层）
之后——事实优先，经历补充。两层互不覆盖。

**反漂移护栏**（承接《人格设定增补》）：召回段落带「你想起的」前缀，明确这是**检索到的记忆**
不是刚发生的事；阈值 + MMR 双重防注错；用户可在设置页一键关闭 RAG 回到现状。

---

## 4. 记忆压缩与更新机制

| 机制 | 规则 |
|---|---|
| **滚动摘要** | 每 20 轮或跨天首次对话，把已滑出窗口的历史压成一条 `摘要 chunk`（复用现有 `callModelOnce`，temp 0.4）；原轮次标记 `archived:true` 仍可检索但降权 ×0.8 |
| **事实合并**（补现有短板） | 新 fact 与旧 fact 向量相似度 > 0.90 且文本不同 → 让模型判断「更新/无关」；判更新则旧 fact 进 `memory.json` 删除队列（现有 `applyMemoryOps` 只能按原文精确匹配删，这一步补上语义去重） |
| **淘汰** | **不主动删除**。磁盘便宜，「近乎无限」靠不丢 + 降权实现。仅当用户点「清理记忆」时 compact 掉 tombstone |
| **容量护栏** | chunk 超 5 万时设置页提示「可归档早期记忆」；超 20 万强制提示（预计 = 每天 50 轮聊三年） |

---

## 5. 与现有系统的集成接口

### 5.1 文件布局（四层架构不变：core 纯逻辑 / main 适配 / shared 协议 / renderer）

```
src/core/rag/            # 纯逻辑，node --test 全覆盖
├── chunk.js             # chunk 构造/规范化/内容哈希/预算截断
├── embedding.js         # 引擎注册表 + pickEmbedEngine + 预处理归一
├── store.js             # 向量库纯逻辑：序列化/反序列化/cosine/topK/MMR
├── recall.js            # 召回策略：衰减/权重/阈值/MMR/预算/格式化
└── compress.js          # 摘要触发判断（shouldSummarize 等纯函数）
src/main/rag/
├── store-io.js          # 文件读写：load/append/compact/clear（仿 persist.js 原子写）
├── embed-local.js       # WASM pipeline + 模型下载（hf-mirror 双源回退，仿 sherpa.js）
├── embed-openai.js      # OpenAI 兼容 embeddings 适配器
└── index.js             # 门面：ingestTurn / recall / backfill / status / rebuild / clear
src/main/ipc/rag.js      # STATUS/RECALL_TEST/REBUILD/CLEAR/SET_MODEL + 下载进度广播
src/shared/rag-protocol.js  # 独立协议文件（避开并行会话，同 voice-protocol.js 先例）
```

### 5.2 接线点（最小侵入，5 处）

1. **`main/agent.js#buildMessages`**：`memories` 后加 `recalled: await recallRag(userText)`
   （带 3s 超时 + try/catch，失败静默退回——RAG 挂了她照样能说话）
2. **`main/agent.js` runTurn 的 finally**：`ingestRag({ userText, assistantText })`
   fire-and-forget，不阻塞、不影响回复
3. **`main/agent.js#extractMemoriesAsync`**：`add` 成功的事实同步写一条 `fact` chunk
4. **`preload/index.js`**：暴露 `nagi.rag.*`（status/recallTest/rebuild/clear/setEnabled）
5. **设置页「她的记忆」区块**：加 RAG 状态卡（模型/条目数/磁盘占用/最近召回测试/开关/重建），
   下载进度走 `voice:progress` 同款广播模式

**`core/context.js#buildContextBlock`**：新增可选参数 `recalled: string[]`，
为空时输出与今天逐字一致（不破坏现有 verify 脚本断言）。

---

## 6. 实施计划与验证

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 探针** | 装 onnxruntime-web + tokenizers，下载 bge-small-zh 量化模型，在**本工程 Electron 主进程**里跑通「两句中文 → 384/512 维向量 → 相似度排序正确」 | 探针脚本输出：相关句对 cos > 0.7，无关句对 < 0.3；WASM 无原生编译 |
| **P1 核心库** | `core/rag/*` 五个模块 + 单测（cosine/topK/MMR/衰减/预算/哈希/序列化往返） | 新增单测全绿，全量不回退 |
| **P2 IO + 本地嵌入** | `main/rag/*` + 模型下载双源回退 + backfill + compact | E2E：写 200 条造对话 → 重启 → 检索命中预期条目 |
| **P3 接线** | agent.js 两处 + IPC + preload + 设置页状态卡 | 真机：聊过的事隔轮能召回并注入（日志可见 `[rag] 召回 N 条`）；关闭 RAG 后行为与今天一致 |
| **P4 真机验证** | `scripts/verify-rag.mjs`（CDP 套路同 verify-voice） | 灌造对话→提问召回→提示词含召回段落；破坏性用例（模型删了/向量文件损坏）不崩、静默退回 |

**默认行为**：模型没下载时 RAG **静默关闭**（ingest 仍写 pending，装好模型下次启动自动 backfill），
今天的行为一帧不变。

**破坏性用例**（P4 必测）：vectors.bin 截断 / chunks.jsonl 半行 / meta 对不上 →
启动时检测到不一致走 `rebuild()`（从 pending + chunks 重新嵌入或标记不可用），**绝不白屏/崩溃**。

---

## 7. 待你定夺的三个点

1. **嵌入引擎默认**：推荐「本地 WASM 模型」（~25MB 一次下载，之后完全离线、免费、隐私最好）；
   备选「云端 embeddings」（零下载，但每轮对话内容会传给第三方，且按量付费）。
2. **模型**：`bge-small-zh-v1.5`（512 维，中文更强，25MB）还是 `multilingual-e5-small`（384 维，15MB，中英混聊更好）？推荐前者——她是中文角色。
3. **滚动摘要默认开吗**：开 = 更省 token 但多一次后台 LLM 调用；关 = 更简单。推荐开（20 轮触发一次，成本可忽略）。

回「Y」= 按推荐方案（本地 + bge-small-zh + 摘要开）从 P0 开做；或直接说改哪项。
