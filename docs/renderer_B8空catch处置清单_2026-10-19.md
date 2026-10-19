# B8 renderer 空 catch 处置清单（交绿区验收）

基线 `ff95ee3a`，排除 vendor；用 AST 按「catch 块没有语句」扫描为 **73 处**，另有 **4 处**吞失败的 Promise `.catch` 回调。共 77 处按 CONTRACTS §12.1 分类。改后同一 AST 条件剩 **0** 处；不把已有返回降级值的非空 catch 算成空块。

| 文件 | 可降级（只记轨迹） | 需可见状态 | 不可静默持久化 | 承诺失败 | 语义失败 | 合计 |
|---|---:|---:|---:|---:|---:|---:|
| `ambient.js` | 5 | 0 | 1 | 0 | 0 | 6 |
| `live2d.js` | 32 | 10 | 0 | 0 | 1 | 43 |
| `main.js` | 3 | 8 | 4 | 0 | 0 | 15 |
| `presence.js` | 0 | 2 | 0 | 0 | 0 | 2 |
| `voice.js` | 5 | 0 | 0 | 5 | 1 | 11 |
| **合计** | **45** | **20** | **5** | **5** | **2** | **77** |

**只记轨迹的理由**：`live2d.js` 的 32 处是模型无某参数、可选焦点/探针、动画叠加或资源卸载的局部降级；`ambient.js` 的 5 处是可选动作、忙碌判定及日志；`voice.js` 的 5 处是 URL/分析器/音频上下文清理和指针捕获；`main.js` 的 3 处是活动打戳和指针捕获。它们不宣称操作成功、不改变持久化事实。稳定站点名按 60 秒去重，可降级项只进脱敏轨迹，不弹窗、不把维护状态标红。

**需要状态的站点**：

- `live2d.js` 10 处：`resizeObserver/resizeCall`、`poseRelease/rhythmRelease/blinkCallback/blinkRelease/headRelease/microRelease/freezeRelease/modelDestroy`。动画或清理失败可能留下错误表现，进入健康状态；`stopMotion` 另归语义失败。
- `main.js` 8 处：`ambientRefresh/moodRead/settingsRead/secretStatus/modelList/maintenanceClear/poke/relationMemoryRead`。设置页复查与即时操作分别走既有维护区和原操作位置；`clearHistory` 失败后不再清空消息或报“已开始”。
- `presence.js` 2 处：`reunionCallback/initialStatus`，入口与快照异步失败留在健康状态，不弹后台窗。
- 持久化 5 处：`ambient.restyleReport`、`main.clearHistory/outfitReport`（同步与异步两路径）、`main.monitorNoticeSave`。其中当前请求路径在原位置反馈；监测告知保存失败保持面板可重试。
- 承诺 5 处：`voice.stopSession/pauseAudio/stopSessionOnCancel/abortBeforeRecord/recordingCleanup`。语音会话停止的 Promise 拒绝也被接住；录音清理分开停止录制器和媒体轨道，前一步异常不挡后一步。
- 语义 2 处：`live2d.stopMotion`、`voice.recorderWait`。此外审计发现的非空 `recorder.stop` 失败和语音试听播放失败也改为失败返回，试听不再伪报“结束”。

**批次 1 验证**：复用 core 的 `CATCH_CLASS`、脱敏轨迹和健康规则；新对话、告知保存、维护清空、互动等同步请求失败在原位置反馈。Node 24 全量 972/971/0/1、构建 exit 0、真机 `verify-maintenance-ui` 12/12；`test/renderer-catch.test.js` 包含吞掉必报失败后断言变红的破坏对照。

**批次 2 待绿区设备验收**：固定白名单共 17 个不同站点，覆盖上述 77 处中的 18 个失败位置（`main.outfitReport` 同步/异步两处共用一站点）：5 持久化、5 承诺、2 语义、6 个当前操作/隐私 visible。经 `health:report-renderer` 汇入现有 `getHealth()`，落盘 `userData/renderer-health.json`；renderer 仍有当前窗口即时状态和有界补报。余下 45 个 degrade、14 个纯展示 visible 的跨窗口/重启可见性只登记 P3-07。跨窗口、重启、恢复和脱敏须由绿区真机复验；红区不自行标绿。
