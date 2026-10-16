# 凪 Nagi：当前状态与恢复路径（HANDOFF）

## 当前状态（2026-10-16 23:50）

- **单人开发制**：ChatGPT 侧额度耗尽后由 WorkBuddy 全权接手，双工具红蓝边界废止；架构契约、安全门与人格硬约束继续有效。
- 源码：`E:\凪\凪_交接包_2026-10-16\02_工程源码_nagi`。实感 RED123 半成品已收口（见下节），分支 `main` 与 `wip/紧急收口-RED123-1016` 均为本地提交、无远程。
- 验证基线（Node 24.19.0）：全量测试 **397 项，396 通过、0 失败、1 跳过**；`npm run build` 退出 0；`verify-presence` 11/11、`verify:s4` 9/9、`verify:m4` 19/19。日志在 `E:\凪\.tools\wip-presence-*.log`。
- 本机环境要点：
  - 跑测试/真机验证把 Node 24 目录前置 PATH（`E:\凪\.tools\node24\node-v24.19.0-win-x64`）；默认 node 22 会令 7 个 electron mock 测试假失败；
  - 受限环境真机验证加 `NAGI_RENDERER_SANDBOX=0`（否则 GPU 进程沙箱内 0xC0000005 崩溃，主进程默认已强制 SwiftShader 软件渲染）；
  - 手动起 electron 先 `unset ELECTRON_RUN_AS_NODE`（本机全局设了该变量，会让 electron 退化成 node）；
  - 偶发环境噪音：`test/ledger.test.js` cleanup 被 safe-delete shim EPERM 打断，复跑即过，非代码问题。

## 实感系列状态（RED-1/2/3 已完成，BLUE-1~4 待办）

**已完成并验证（2026-10-16）**：`docs/实感架构契约.md`（RED-1）；`core/presence/{circadian,away,reunion,engine,hooks}.js` + main 接线（RED-2）；契约第 5 节不完美机制方案（RED-3，业务未实现）。验证矩阵：presence 单测 22/22、定向 epoch 回归 5/5、全量 397/396/0/1、构建 0、真机 `verify-presence` 11/11、`verify:s4` 9/9、`verify:m4` 19/19 无回归。最后一笔 epoch 失效补丁（隐私暂停/再离开/配置撤销使已取走的归来快照失效）补验通过，消费者在 `agent.js handleReunion`（`epoch!==snapshot.epoch` 即放弃）。

**半成品清理记录**：抢救提交 `f56b595` 误入的 74 个 `.nagi-*` 测试残留已移除并补 `.gitignore`；README「双工具协作入口」改写为「开发入口」并补第十九节实感说明；cloud-config.js 真实配置经审查为公开键保留；`emotion-map.js` 死代码删除保留。

**待办**（详见 TASKS A 节）：BLUE-1 语音情绪映射（下一步）→ BLUE-2 时段表现+设置页 → BLUE-3 环境留痕 → BLUE-4 不完美机制 → RED-4 复核。BLUE 任务输入/产出/验收以 `docs/实感补足任务书.md` 卡 B 与契约为准。

## 项目事实与保留约束

- 沿用 `core/main/renderer/shared` 四层。Agent 双通道（native tools / JSON 兜底）、确认门一次性 token、授权快照核验、IPC 来源校验、渲染沙箱、命令黑白名单、文件真实路径边界均为有效契约；改这些必须先复现并补回归。
- 记忆体系：账本（四类经历+信任分层+纠错/遗忘/导出）、RAG（只收新日记、崩溃自愈、tombstone）、关系层（熟悉度五档+情绪时间线）、年鉴（引用式）、承诺簿（完成需证据）。**只让之后的新日记进入 RAG**，不批量补录旧日记。
- 人格：v2 为唯一基准；敏感场景有限重试护栏，重试不得执行工具；不得以固定台词替代生成，不设计催促/挽留/愧疚机制。v2 已删毒舌人设。
- 语音：维持现有引擎与音色（edge 晓晓→SAPI 降级链、sherpa→SAPI）；注册表桩不算实现。实感语音 hook 默认关闭，显式试听永远优先。
- 活动记录边界：默认仅内存；显式开启后只保存之后的新活动到 `userData/presence.json`；模拟活动**不是**用户离开期间的真实外界经历，不得升级为共同经历；休眠/关机不补造。
- 打包：electron-builder NSIS+portable，asarUnpack playwright，模型走 extraResources；`npm run pack` 快速验证。历史 `dist/` 哈希证据见 `docs/演进验收记录.md`。

## 安全债（详见 TASKS B 节，附 FIX-1 完整结论）

- **FIX-1 HA extra 覆盖目标（复现成立，未修）**：`core/tools/registry.js` `planHomeService()` 的 `state:'on'|'off'` 与仅 extra 兜底分支中 `data:{entity_id,...extra}` 允许 `extra.entity_id` 覆盖已核验目标。假客户端复现：`home_set(entity_id='light.living_room',state='off',extra={entity_id:'lock.front_door'})` 确认框显示关灯、实际对门锁下发 `light.turn_off`，结果摘要同样显示诱饵（证据 `docs/verify/b06-ha-extra-20261016.json`）。约定修法：extra 白名单且 entity_id 最后写入不可覆盖；确认描述/摘要读 post-plan；brightness 分支展开方式统一；修后补假客户端回归。**修复前不启用 HA 主动控制（契约 4 节 HA 规则保持禁用）。**
- FIX-2 外部进程替换路径竞态、FIX-3 Playwright 生命周期：源码可见风险，先复现再修。

## 历史：双工具协作期（2026-10-14 ~ 10-16，已完结）

- R01 取消/确认/授权撤销：ChatGPT 修复（`831e980`），WorkBuddy 固化 22 项回归（`b3de4bf`）；外部路径竞态保留为 FIX-2。
- B05 确认 UI 失效收尾（`ba44a56`）、B08 任务书恢复与对账（`d1db560`）、B06 HA extra 复现与建议（`2ab5530`）、蓝区收口（`d2aa65e`）；实感抢救（`f56b595`）与清理（`ffcf607`）。提交序列与证据以上述 git log 为准。
- `docs/完善任务对账_2026-10-16.md`：旧完善任务书 22 ID 对账（✅9/🟡11/⬜3），🟡 项已归并 TASKS 各节。

## 恢复路径（如果再次中断）

1. 留在 `main`；`wip/紧急收口-RED123-1016` 内容已全部审查并清理，实感功能已验证——**该分支已无未审查内容，可随时删除或归档**（删除前确认 `git log main` 含实感收口提交）。
2. 续做入口：TASKS「下一步」节；当前是 BLUE-1（`core/voice/voice-profile.js` + hook 接线 + 单测）。
3. 每次续做先跑：Node 24 前置 PATH 的 `npm test`（预期 397/396/0/1）→ `npm run build` → 相关 `verify:*`。
4. 真机/发行版/设备验收清单见 `docs/阶段10人工验收清单.md` 与 TASKS D 节，未完成项不得标注完成。
