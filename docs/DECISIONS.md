# 双工具协作：DECISIONS

## 边界规则（先读）

- 🔴 ChatGPT 红线区（只做这些）：架构契约、Agent Loop+双通道、安全门、Playwright 核心、关键复核、疑难会诊。
- 🔵 WorkBuddy 蓝区（其余全部）：UI、标准工具、Provider preset、HA REST、测试、文档、常规修复。
- 冲突规则：默认归 WorkBuddy；WorkBuddy 不擅改红线区（只能提建议）；ChatGPT 不代改蓝区（只标注）。
- 本次交接文档初始化与测试是用户明确授权的单次工作；不扩大日常职责。当前暂停新增功能。

## 已确定的决策

下列记录于 **2026-10-16 ~ 2026-10-17**，依据用户指示与源码盘点；“已定”表示约束有效，不表示全部代码已实现或验收。

| ID | 决策 | 执行含义 / 依据 |
|---|---|---|
| D01 | 红区最小化，默认蓝区 | 红区合并为 TASKS 的 R01–R03；测试、文档、常规实现不因位于 core/main 就归红 |
| D02 | 暂停新功能，先建立交接 | 本轮只改四份文档并运行测试；待办中的功能项维持暂停，恢复范围由用户确定 |
| D03 | 保留四层架构与可切换 Provider 契约 | 复用现有 Agent、情绪、日记、关系、RAG、提醒；不做整体重写 |
| D04 | 真实经历优先，用户能解释、停止、纠错、忘记、导出 | 来源、时间、删除状态必须传递到召回和年鉴；事实、主观记录、创作分别展示；不虚构感知，不设计催促、挽留或愧疚机制 |
| D05 | 只录入之后的新日记 | 用户明确选择；不把旧日记批量补录入 RAG。旧数据迁移/账本索引不能改变这一限制 |
| D06 | 保留当前语音配置 | 用户明确要求；延迟测量和候选适配器工作不得悄悄切换引擎或音色。注册表桩不算已实现 |
| D07 | 敏感场景启用有限重试人格护栏 | 用户已选“加入有限重试护栏”；接受敏感回复缓冲带来的延迟。人格以 v2 为唯一基准，禁止靠固定回复掩盖模型失败 |
| D08 | 本地模型默认切换需证据 | 多轮人格、事实边界、工具结果与延迟验收后做关键复核；当前不能凭单次通过或旧文档宣称已达标 |
| D09 | 授权与操作完成必须可核查 | 按操作和目标授权；撤销/取消应及时生效；承诺完成需结果证据，重试不能重复外部动作 |
| D10 | 保留他人的未提交改动 | 进入本轮已存在 cloud-config.js 差异；由原修改者/WorkBuddy 处理，不把内容抄入文档或混入提交 |
| D11 | 验收按实际结果记账 | 本轮 347 项中 345 通过、0 失败、2 跳过；退出码绿灯不代表链接安全、真实设备和安装包人工验收已完成 |
| D12 | 一个任务一个修改者，按职责拆跨界改动 | TASKS 领取与交接；蓝区需要红区改动时只提建议，红区发现蓝区问题只标注；禁止并行改同一文件 |
| D13 | 外部原生子进程的路径参数必须 ASCII 可达 | 传统 `main()` C 程序（如 sherpa-onnx WS 服务）的 argv 按系统 ANSI 代码页（中文系统 cp936/GBK）转换，非 ASCII 路径（如 userData 含「凪」）会变乱码致服务启动即退；对策：cwd=目标目录 + 纯 ASCII 相对路径参数，兜底为 `%TEMP%` ASCII 镜像（硬链接）。powershell.exe 等 wmain Unicode 原生程序不受此限 |
| D14 | Live2D 资源磁盘名一律 ASCII，显示名保留原名 | 模型经 `nagi-local://` 拼 URL 再落 Windows 路径，中文文件名会被编码打坏（缅因交付包内已有文件名被打成 `[M%_O$@6(OU@R@SXLWP`N_G.png`）。故磁盘上用 `Maine/`、`blush.exp3.json`，`model3.json` 的 `Name` 仍写中文，UI/接口看到的是中文 |
| D15 | 取景带按模型分别标定，不共用一套 magic number | 不同模型美术范围差异很大（缅因横向只占 0.273~0.813，套通用 0.11~0.95 会被 contain 缩到 0.095）。`src/core/frame.js` 用 `FRAME_PROFILES` + `frameProfile(frame, modelName)` 匹配；换模型必须重新跑探针标定，命中不到回落通用预设 |
| D16 | Live2D 贴图最大边长 4096，超出即降采样 | 桌宠常驻时贴图是显存与启动耗时的大头：缅因原包 8192×8192 ×3 = 768MB 显存 / 94MB 磁盘 / 冷启动 6.4s。降到 4096 后 192MB / 13.5MB / 2.8s，PSNR 35.8~37.0dB 肉眼基本无感（桌宠最大窗 900×1300 时形象只画 751×901 px，4096 仍属过剩采样）。用 `scripts/shrink-textures.py`（先 `--scan`）；**原图一律归档不删**，改 `model3.json` 的 `FileReferences.Textures` 切目录。路径必须正斜杠（D14）——脚本曾用 `os.path.join` 写出反斜杠，在 `nagi-local://` URL 里会出问题 |
| D17 | 贴图降采样前先判类型，稀疏特效图集单独评估 | 判据：`--scan` 输出 alpha 覆盖率与法线贴图特征。缅因 `texture_02.png` 不透明像素仅 0.2%，是翅膀/花花/星星眼等特效小元素图集，降采样损失最大（PSNR 32.1dB vs 主贴图 37.0dB）；因特效在桌宠上显示很小仍一并降，但保留 `--keep=` 单独留 8192 的口子。法线贴图/UI/文字类贴图不降——本模型三张经判据扫描均非此类 |

## 后续怎么记

### 2026-10-16：实感 RED123 收口（全权接手后）

- 用户宣布 ChatGPT 侧额度耗尽，由 WorkBuddy 全权接手后续开发；双工具红蓝边界与本文件顶部边界规则同时废止，后续按单一负责制执行，契约与安全约束仍有效。
- RED-1/2/3 半成品（契约 + circadian/away/reunion/engine/hooks + main 接线）经验证通过后收口：全量测试 **397 项 396 过 0 败 1 跳**、构建退出 0、`verify-presence` 真机 **11/11**、`verify:s4` 9/9、`verify:m4` 19/19 无回归。最后一笔 epoch 失效补丁（隐私暂停/再离开/配置撤销使归来候选失效）补验通过，消费者在 `agent.js handleReunion`。
- 抢救提交 `f56b595` 中误入的 74 个测试残留文件已移除，`.gitignore` 补 `.nagi-*`；README「双工具协作入口」改写为「开发入口」并补第十九节实感说明。
- cloud-config.js 的真实 endpoint/publishableKey 经审查为**公开配置**（文件设计即进 git，非密钥），保留提交；`src/core/agent/emotion-map.js` 删除为已确认死代码，保留。
- 环境事实：本机受限环境下 Electron GPU 进程在沙箱内 0xC0000005 崩溃，`NAGI_RENDERER_SANDBOX=0` 下稳定；跑测试/真机验证须用 Node 24 前置 PATH；`ELECTRON_RUN_AS_NODE=1` 会令手动启动的 electron 退化为 node。
- 实感 BLUE-1~4 与 RED-4 复核、B06 HA extra 覆盖漏洞、R01 外部路径竞态、R03 Playwright 生命周期纳入 TASKS 队列，按序推进。
- 活动记录边界不变：默认仅内存，显式开启后才保存之后的新活动；模拟活动不是用户离开期间的真实外界经历；归来开口受打扰预算与窗口可见限制，用户对话优先。

### 2026-10-16：BLUE-1 语音情绪参数映射（全权接手后首个蓝区任务）

- 落地 `src/core/voice/voice-profile.js`：纯函数 `resolveVoiceProfile({emotion,intensity,rhythm,toneTag,engine})`，输出恒为 hooks 校验域内的绝对参数（rate/pitch ±50、volume 0–100、整数、`voice` 恒空串=沿用音色）；所有数值集中在 `VOICE_PROFILE` 常量表，真机听感反馈只改表不改逻辑。
- 情绪语义按任务书卡 B 独立于旧 `MOOD_SPEECH` 表（worry 为「放慢低沉」，与旧表「略快」有意不同）：两条路径互不影响，关开关即回旧路径。
- 接线只走蓝区扩展 `src/main/extensions/voice-profile.js`（glob 自动加载），**未改 `main/voice` 编排本体**；设置页「语音情绪映射」开关写 `presence.voiceProfileEnabled`（默认 false，deepMerge 单键写入不影响其余 presence 配置）。
- 用户偏移折叠：设置页语速/音量滑条折进基准后再做情绪/时段调制（与编排层 `paramsFor` 同语义），避免开开关后滑条失效。
- 验证：新增单测 12 项（含「喂给 `createPresenceHooks` 原样通过」的契约兼容测试）；全量 409/408/0/1、构建 0；未改 presence 核心，真机三项沿用 RED123 收口结果。待用户按「6 情绪+夜晚」清单真机试听后迭代常量。
- 已知边界（非本次引入）：profile 开启时编排层整体替换参数，用户自定义音色（`voiceByEngine`）不受影响（voice 空串），但**每引擎自定义音色以外的显式 rate/volume 仅能经设置页滑条表达**；句间停顿由分句架构天然提供，精确停顿时长需编排层支持（属红线，未动）。

### 2026-10-17：用户反馈情绪起伏偏弱——记为待观察项（OBS-1），暂不动角色设定

- 用户真机初听 BLUE-1 后反馈：听感上凪的情绪起伏偏弱、整体过于含蓄；初步判断成因可能在角色设定侧（台词风格、情绪阈值或语气处理方式限制了情绪外显），不是语音参数表本身的问题。
- 决定：**本步不修改角色设定或台词**，在 TASKS 记 OBS-1 待观察项。后续 BLUE-2（表现层）/ BLUE-4（不完美机制）/ RED-4（复核）三个环节重点复核「情绪表达是否足够鲜明、可辨识」。
- 若后续确认问题存在，调整方向限定为：情绪分层、语气强度、表现方式（先评估再动手，改动需注明范围与验证）。

### 2026-10-17：BLUE-4 不完美机制实现决策（全权接手后第四个蓝区任务）

- 落点：`core/presence/imperfection.js`（纯策略，可单测）+ `main/extensions/imperfection.js`（侧车状态与接线，仅内存、不落盘）+ 设置页「陪伴 · 可选表达」。
- 硬边界（实现时逐条落实）：`classifyIntention` **默认 important**，只有白名单齐全才 low-risk；提醒/日程来源、截止时间、时间敏感、明确强调（含「别忘/务必/deadline」等文本信号）、敏感领域（文件/设备/钱/健康安全）、以及**无法可靠分级**的项一律重要；重要项分支**不调用随机数**（这是「零遗忘」的可验证支点）。
- 概率门只接在**可选表达**层：本期唯一接入点是 `agent.js handleReunion` 的归来开口（一处 3 行），概率默认 0 → 默认行为完全不变；上限 10%（配置写大也被夹回）、每天≤1 次 defer、同一候选只判一次（按 ID 存决策，重复调用不再掷）、defer 最长 10 分钟到期恢复且保留决策记录。**未提供也不接受**可拦截 `reminders.onDue`／调度／工具执行的接口。
- 不谎称遗忘：defer 的语义是「这次选择不说」——记录保留、不说「忘了」，也不以任何方式改变提醒/承诺的完成状态。
- 低气压：opt-in、非忙碌非危机、24 小时一次、10–30 分钟自然恢复；`comfort()` 最多缩短剩余时间一半且每段一次，**只改低气压 until，绝不碰互动计时**（不伪造用户安慰）；不关闭功能、不变慢工具、不扣减可靠性。本期只暴露语气档位与状态，实际文案表达由后续人格侧决定。
- 补救：只识别「停 / 明确负面 / 越界」三类信号，**停止立即生效**（即使被勿扰压制不出文案也保持停止）；每天 1 次、间隔 6 小时；短句轮换而非固定道歉台词、无辩解、不索求原谅；不新增主动吐槽发生器。
- 配额与开关：defer/低气压/补救均按**本地日期**每日归零（三个入口共用一套跨日逻辑，避免「每天一次」退化成「一辈子一次」——实现中抓到过这个 bug）；全局关闭立即清缓存与积压，不重放。
- 验证：`test/imperfection.test.js` 23 项；`npm run verify:imperfection` **8/8**（120 天、固定种子、概率按上限 10% 跑：重要事项 720/720 全送达零漏送；可选意向延迟率 6.18% ≤ 10%；单日 defer 峰值 1；重复调用既不重掷也不改判）；`npm run verify:imperfection:ui` **4/4**（真实应用：默认值全关、设置页开关与概率写入、关开关概率强制归零、扩展装配无失败）；全量 512/511/0/1、构建 0。

### 2026-10-17：BLUE-3 环境留痕实现决策（全权接手后第三个蓝区任务）

- 分层：纯逻辑放 `core/presence/{notes,traces,anchors,ha-rules}.js`（可 node --test），落盘与接线放 `main/presence-notes.js` + `main/extensions/traces.js`，只读出口放新文件 `main/ipc/notes.js` + `shared/notes-protocol.js`（**不改红区的 `shared/presence-protocol.js` 与 `main/ipc/presence.js`**）。
- 默认关闭：`notesEnabled / tracesEnabled / anchorsEnabled` 全关时**不读盘、不建文件、不产生记录**；全关后同步一次即清内存并删 `userData/notes.json`。开关打开只记「打开之后」的事，不回填。
- 不虚构：便签正文只能由「活动类型 + 时长 / 归来分档 / 工具名 + 返回状态」推出；模拟活动带 `provenance:'simulation'` + `activityId` 并在界面标「模拟活动」；动作类只写「跑过、返回了」，`completionVerified` **恒 false**（上游乱写也压回），摘要不含 args/stdout/二进制。
- 撤回传播：`activity-forgotten` 事件会让派生便签一起消失（不能引用已删除的东西）。
- 回忆物只做「可选 + 克制」：来源重验（每个 sourceId 都要在可访问登记表里且未删）、私密锚点（称呼/共同引用/承诺）需熟悉度 ≥ familiar、每次概率 ≤5%（配置写大也夹回 5%）、每天 ≤1 次、**没有可用锚点时连随机数都不掷**（不为凑概率制造回忆）。本期只在查看器里只读展示「可能想起来的」，**不自动开口**——说什么、怎么说属人格表达策略，与 OBS-1 一起评估。
- HA 规则只落接口位：`evaluateHaRules` 默认禁用（禁用时连候选都不产）、只产候选、按目标标 `requiresAuthorization`、规范化只取白名单字段（B06 的 extra 覆盖在这里进不来），不接真机、不直调 REST。
- 实现取舍（一处有意偏离契约字面）：扩展的订阅**恒建立**，开关关闭时靠回调里的闸短路。原因是若要「按开关决定是否订阅」，用户开启后必须重启才有反应；事件本身稀疏（工具返回/离开归来），短路成本可忽略，也不新增任何 timer。
- 未开放项：外部便签文件写入（契约要求复用原生目录授权 + 逐次确认）本期**不做**，界面如实写「暂未开放」，`externalWriteAvailable:false`，绝不假装写成功；已登记 TASKS B20。
- 验证：`test/notes.test.js` 16 项、`test/anchors.test.js` 16 项、`test/notes-store.test.js` 12 项（含「默认关闭不建文件」「关闭即删文件」「来源被忘记即撤回」「上限与保留天数」「HA 外部覆盖字段进不来」）；全量 489/488/0/1、构建 0；真机 `npm run verify:notes` 12/12（真实聊天 → 假大脑发出 file_list → 工具执行 → action-trace hook → 扩展 → 落盘，全程可核）。

### 2026-10-17：BLUE-2 时段表现实现决策（全权接手后第二个蓝区任务）

- 分层明确：表情/面容归情绪状态机 `mood.applyRhythm`（RED-2 已接线），本模块**不夺面容**；参数叠加层由 `core/presence/rhythm-pose.js` 负责，映射到模型**实际存在**的参数（cdi3.json 321 项实扫），过滤后为空则不施加；动作组按模型实际存在的组回退。
- 预设保守：night = 垂目/低头/慢呼吸/微阖眼；afternoon = 半眯眼/微张口/低头/慢呼吸（模型无哈欠动作组，用参数近似慵懒，不做假动作）；morning/noon/evening 无预设；全部通过 `isSubtlePose` 口径（角度 ≤10°、眼珠 ≤1 量级）。
- 机制：Live2D 在 `beforeModelUpdate` 追加参数偏移，与 redGuard（红色裁剪）、poseHook（思考姿态）三 hook 互不干扰叠加；进入/退出均走 `easePose` 指数平滑；night 的 motion 建议 'quiet' 落地为「抑制随机待机动作」。
- 双窗同步：主进程通过 `presence:changed` 向所有渲染进程广播同一份快照，`renderer/js/presence.js` 各自订阅、各自渲染，与情绪广播同一机制。
- 归来便签入口：`rhythm-pose.js#reunionPrompt(prev, next, config)` 只判断「离开态→在场」且时长 ≥ reunionMinMs；离开起点用**上一份快照**的 `away.since`（`returnNow()` 会把新快照的 since 置 null）。便签数据/配额走 BLUE-3，本期只有 UI 入口，不伪造内容。
- 设置页：时段表按标准六段表渲染 5 个 `type="time"` 边界输入；自定义多段表保留原值并在编辑器中注明；保存前用 `presenceConfig` 预校验，非法递增/越界/阈值倒挂均中止保存并说明；隐私按钮独立保存（模拟活动 persist/保留天数/条数上限）。
- 验证：单测 `test/rhythm-pose.test.js` 19 项（含预设参数真实存在于 Lisette 模型的静态锁、availableIds 过滤、开关/异常/null 安全回退、抑制随机动作、reunionPrompt 上一态 since 语义）；真机 `npm run verify:rhythm` 15/15，通过改 settings 时段表驱动整条生产链路：端到端广播、night/afternoon 参数方向性、平滑切换、关开关收回、无预设时段、设置页表单/保存/非法拦截/隐私按钮。

### 2026-10-17：语音识别乱文/空结果根因修复——Windows 非 ASCII 路径 argv 坑（D13）

- 现象（用户真机）：麦克风采集链路正常，但识别结果乱文（实际说「能听到我说话吗」，返回「你 后我说晃了」之类）或整段为空。
- 排查：**先证伪再定性**。逐段验证 SAPI 回退链路本身（干净 16k WAV → 输出正确）、渲染层 22.05k→16k 重采样数值（正确）、sherpa WS 线协议对照 v1.13.8 官方源码（完全一致）——三段均无误，故问题不在采样率/编码/VAD/分帧。
- 根因链：`package.json` `productName: "凪 Nagi"` → `userData = %APPDATA%\凪 Nagi`（非 ASCII）→ `sherpa-onnx-offline-websocket-server.exe` 为传统 `main()` C 程序，子进程 argv 按系统 ANSI 代码页（cp936/GBK）转换，`凪`（U+6BAA）不在 GBK → `--paraformer/--tokens` 绝对路径变 `?M Nagi` → 服务端报 `tokens.txt does not exist` 启动即退 → 旧 `waitForPort` 仍干等满 60s → `recognizeAudio` 静默回退 SAPI → Windows 内置 zh-CN 听写对真实麦克风音频产出碎片/乱文。开发期 userData 为 ASCII（`nagi`）故从未暴露；SAPI 路径经 powershell.exe（wmain，Unicode 原生）不受影响，掩盖了故障。
- 修复（4 文件）：新增 `src/core/voice/sherpa-launch.js`（纯决策 `isAsciiPath` / `sherpaLaunchPlan`，可单测、不碰 fs/spawn）；`src/main/voice/sherpa.js` 的 `startServer` 改两轮方案——① 非 ASCII 模型目录：`cwd` = 模型目录 + 纯 ASCII 相对路径参数；② 兜底：模型硬链接到 `%TEMP%` ASCII 镜像目录（同卷不占空间，失败退拷贝）；新增 `waitForPortOrExit`（子进程 exit/error 立即判死，不再白等 60s）、`stopping` 标志（启动中被 stop 不再起下一方案）、旧子进程 exit 不清新服务状态的守卫；镜像懒创建（首选方案能用上就不碰 %TEMP%），下载新模型后清镜像防硬链接指向旧 inode。
- 验证：`test/voice.test.js` **50/50**（新增 3 项：`isAsciiPath` ASCII 放行/中日文与引号拦下、`sherpaLaunchPlan` 两种路由）；生产模块真链路（electron 打桩 + ESM loader，userData 桩为真实 `%APPDATA%\凪 Nagi`）：服务经「相对路径」方案 **1548ms 就绪**，识别结果 **「能听到我说话吗」完全正确**，全程 1639ms；`npm run build` 退出 0，产物 `out/main/index.js` 含修复标记。
- 剩余：B04 真机复测（按住说话、真实麦克风），必要时再看 `%TEMP%` 镜像是否被触发（首选方案生效时不会创建）。

### 2026-10-17：角色形象整体换装为缅因妹妹 Maine（用户交付新模型）

- 决定：以用户交付的 **缅因妹妹**（B 站工坊售卖，禁止二传/商用）**完整替换**原形象，成为**唯一生效**角色；旧模型 Lisette、Mao **移出 `models/` 归档到工程根 `models-archive/`，不删除**（测试仍以它们为参数/资源基准）。
- 资源接入：原包是 VTube Studio 配置，`model3.json` 只挂了 Moc/贴图/物理，31 个表情与 4 个动作全散放——在副本里全部挂上，并把原本为空的 `LipSync` 组补成 `ParamMouthOpenY` + `ParamMouthForm`；物理沿用原包（头/眼/兽耳）。**原包无音效**（4 个 motion3 的 `UserDataCount` 全 0，包内无音频），语音本就走 TTS 侧，故不接模型音效。
- 自写资产（依据角色设定「表层干净、情绪起伏很小」）：原包表情是按键特效导向，缺安静日常面容 → 补 `nagi_{neutral,smile,joy,puzzled,pout}`；原包无待机动作、`Scene1` 是 10.8s 特效秀不适合常驻循环 → 自写 `nagi_idle`（9s，只动 `ParamBodyAngleY/Z`，避开自动呼吸已接管的 `ParamAngle*`/`ParamBreath`），`Scene1` 单独进 `Scene` 组且**不参与随机动作**。
- 不进情绪映射：发型/配件开关类、**脸黑**（与 2026-10-15「移除 dark_mask 系列」同源）、**身体消失**、姿势类；它们资产都在、面板可点，只是抽不到。
- 取景：缅因实测美术范围 fx∈[0.273,0.813]、fy∈[0.046,0.459]，通用带把它缩到 fit 0.095 → 新增 Maine 专属带 `{left:0.255,right:0.83,top:-0.01,bottom:0.46}`，fit 0.139（放大约 46%），5 种桌宠尺寸无溢出（见 D15）。
- 打包/仓库：`.gitignore` 加 `models-archive/`；`electron-builder.yml` 的 `files` 加 `!models-archive/**/*`（43MB 不该进 asar）。
- 验证：`npm run verify:maine` **7/7**（加载 501 参数 / 3 贴图 / 物理 true / 口型 true；36 表情；6 情绪映射全命中；5 动作组可播；36/36 表情可应用；不透明像素 33.4%；0 控制台报错）；全量单测（Node 24）**441 通过 / 0 失败 / 1 跳过**；`npm run build` 退出 0。
- 验证：`npm run verify:maine` **7/7**（独立浏览器 + 预览页，验模型文件与接线）；**`npm run verify:maine-live` 6/6**（真起 Electron 桌宠，验生产渲染层：取景预设命中缅因、36 表情、6 情绪映射的面容指纹与直接点表情一致、5 动作组参数真的在摆、画面非空、0 控制台报错）；`npm run verify:frame` **45/45**（真机取景矩阵）；全量单测（Node 24）**441 通过 / 0 失败 / 1 跳过**；`npm run build` 退出 0。
- 环境澄清（**更正此前误判**）：本机 Electron 并非"GPU 进程起不来"——是**没设 `NAGI_RENDERER_SANDBOX=0`**（见 MEMORY「环境硬约束」）。设上就能真机验，之前的独立浏览器方案只是当时的绕行，不作为结论。
- 未完成：桌面宠物窗内的**真人观感**（构图审美、以及 4096 下的画质是否满意）仍待用户日常确认，已记 TASKS 的 B22。

### 2026-10-17：贴图降分辨率（8192 → 4096）

- 起因：用户反馈运行时明显吃力、帧率偏低。定位到贴图是显存与启动耗时大头——缅因原包 8192×8192 ×3 张，磁盘 94.2MB，解码后 RGBA 显存 **768MB**。
- 决定：统一降到最大边长 4096（保持宽高比、2 的幂、RGBA 不丢 alpha、文件名不变），用 `scripts/shrink-textures.py` 批量处理；**原图一张不删**，迁到 `models-archive/Maine-textures-8192/`（不入库、不进 extraResources），`model3.json` 的 `Textures` 改指 `Maine.4096/`（见 D16/D17）。
- 类型排查结论：三张都是普通 RGBA 彩色贴图，**无法线贴图**（用"整体偏蓝紫 + B 通道显著高于 R/G"判据扫过）、**无 UI 贴图**、**无文字贴图**；唯一跟文字有关的是画在主贴图上的水印（`Param469`），糊掉反而无所谓（且 `nagi_*` 表情默认关水印）。
- 唯一需单独评估的是 `texture_02.png`：alpha 覆盖率仅 **0.2%**，是翅膀/花花/星星眼/汗滴等特效小元素图集，降采样损失最大（PSNR 32.1dB，主贴图 35.8~37.0dB）。因特效在 400×600 桌宠上显示很小，仍一并降；脚本留了 `--keep=texture_02.png` 可单独保留 8192（代价显存回到 384MB）。
- 实测（同机、同一验证脚本前后对照）：显存 **768MB → 192MB（−75%）**、磁盘 **94.2MB → 13.5MB（−86%）**、**冷启动到桌宠就绪 6.4s → 2.8s**；画质 PSNR **35.8 / 37.0 / 32.1 dB**（>30dB 肉眼基本无感），锐度指标基本持平。
- **诚实说明**：稳态帧率在本验证环境下没有明显提升（8192 约 37~43fps、4096 约 40~42fps，差异落在噪声内）——该环境走软件渲染，瓶颈不在纹理填充率。贴图降分辨率的主要确定收益是显存与加载耗时，低端机/集显上还会有填充率收益。
- 回归：`verify:maine-live` 6/6、`verify:frame` 45/45、`verify:maine` 7/7，均复跑通过。

### 2026-10-16：R01 本次收口（ChatGPT）

- 用户明确选择：先完成 Agent 取消、确认失效和授权撤销；外部进程替换路径竞态保留为未完成红线项。本次不引入原生文件访问方案，也不宣称 R01 整包完成。
- `CONFIRM.id` 改为宿主生成的一次性 UUID，绑定当前操作；模型工具 ID 继续用于 TOOL_CALL/TOOL_RESULT 与模型协议。批准只接受布尔 `true`，超时、取消、拒绝、过期 token 均不授权。注册确认等待后才发出确认事件，避免即时回复丢失。
- 取消必须立即结束确认等待，并在工具执行前复查；本轮 controller 在准备阶段即创建。文件根重新选择/撤销使旧回合失效，执行入口再次核验授权根快照。已开始的 OS/外部操作不承诺回滚；普通 shell 确认授权不是文件根沙箱。
- 复核保留现有 IPC 来源校验、默认渲染沙箱及护栏重试禁工具约束；UI 与永久测试文件交蓝区处理，不通过放宽安全门解决 UI 问题。新临时验证 15/15、全量测试 345 通过/2 跳过、构建退出 0；真实链接与人工 UI 验收仍未完成。

### 2026-10-17：主进程改动「改了也必须重启才生效」——把陈旧实例变成可一眼诊断（D14，FIX-6）

- **背景**：BLUE-5（媒体/坐标感知）代码改完、构建通过、`verify:signals` 10/10，用户复测仍全线失败（答不出在听什么、答不出城市）。
- **决定**：
  1. **明确定义**：本项目主进程代码经 `npm run build` 产出 `out/main/index.js`，**只有进程重新启动才会重新加载**。`app.requestSingleInstanceLock()` 的存在使「再点一次启动」只会唤起旧实例（`second-instance → win.show()`），因此"关窗口"与"再启动一次"都**不算**重启；必须托盘退出/结束本项目 electron.exe。
  2. **把它变得可诊断**：`src/main/index.js` 启动时写 `userData/boot.json` = `{version,pid,startedAt,packaged,build}`（`build` = `out/main/index.js` 的 mtime），并打一行 `[boot]` 日志。以后任何"修复看起来无效"，先比 `boot.json.build` 与 `out/main/index.js` 的修改时间即可判定实例是否陈旧。
  3. **覆盖此盲区要进验收基线**：新增 `scripts/verify-media-chat.mjs`（`npm run verify:media-chat`），首条检查就是陈旧自检（`boot.json.build == out/main/index.js mtime`），其余检查走**端到端**（真探针 → 系统提示是否带曲目 → 界面回复是否带曲目 → 撤销后是否收回），不再以"信号层读得到"等同于"功能正常"。
- **依据**：主进程 PID 18888 启动于 00:11:30，`out/main/index.js` 构建于 01:28:18，全部改动源码 mtime ≥ 01:02；同刻直接跑 `resources/music/player-title.ps1` 可读到网易云当前曲目 —— 数据源与代码均无问题，唯一变量是"没重启"。端到端脚本修正后 7/7（含 `Monster (Album Version)` 命中）。
- **影响**：不改任何用户可见行为（只多一个诊断文件与一行日志）；新增一个 npm 验收脚本。原先 `verify:signals` 只验到信号层，容易被误当成端到端通过，这条认知盲区就此关闭。
- **替代**：无（新增纪律，不改旧决策）。与 D13（外部原生子进程 argv 的 ASCII 可达）同属"环境事实类"决策，两类都要在集成点主动检查。

### 2026-10-17：媒体信号的两条硬约束——排除自身会话、失败不清空观测（D15，FIX-7/FIX-8）

- **背景**：BLUE-5 的代码与端到端脚本都已通过，用户真身复测仍答不出在听什么。三次排查后确认是两个真实缺陷（报告 4.6 节）。
- **决定一（必须排除凪自己的媒体会话）**：凪说 TTS 语音时，Chromium 会把本应用注册成一条 Windows 媒体会话（`SourceAppUserModelId` = `electron.exe`，打包态为「凪 Nagi.exe」；标题 = 产品名）。任何"读系统媒体状态"的实现都**必须**先按 AUMID 把它剔掉，否则：① 主源看到"有会话正在播放"就早退，窗口标题兜底永远轮不到；② 注入给模型的是一句自我指涉的胡话。识别只认 AUMID（不认标题，标题会被本地化），比较可执行文件名、去 `.exe` 的词干与产品名，全部小写。
- **决定二（瞬时读取失败不清空上一次成功观测）**：`MusicSignal.status()` 探针失败时**保留** `this.last`，只记录 `lastError` 并把错误抛给调用方（UI 仍能显示"读取失败"）。理由是观测量本身带 120 秒 TTL，过期自然失效，保留旧值不构成"编造"；而清空会让一次被误判的超时把她整分钟的媒体感知抹掉。监视器同时改为自调度：成功 60 秒、**失败 10 秒**后重试（旧实现固定 60 秒，恰好在启动期踩坑时把她静音一分钟）。
- **依据**：真机复现 —— 探针返回 `{"app":"electron.exe","title":"凪 Nagi","playbackStatus":"playing","sessionCount":2}`，同一时刻网易云窗口标题是可读的；`player-title.ps1` 在负载下报 `timeout (8000ms)`（实际跑了 >16 秒，含 8 秒宽限）。修后以真实 `settings.json` 副本复跑，提示词稳定带 `「曲名」 / 艺人（来自网易云音乐）`，`verify:media-chat` 8/8。
- **影响**：探针逻辑与监视器节奏变化；新增 `lastError` 字段（向后兼容，仅新增）。脚本 `player-title.ps1` 改为单次 `Get-Process -Name $wanted`（仍只查白名单，隐私边界不变）。**不改**人格、不触发主动开口、不把曲目写入共同记忆这三条纪律。
- **替代**：无。补充了 D14（陈旧实例）之外的另一类"环境事实"：**被观测系统里包含观测者自己**，这类集成点都要先问一句"这里会不会读到我自己"。

---

仅在做出新决策或明确替代旧决策时追加：日期、任务 ID、决定、依据、影响、替代哪条。不要把计划写成成果，也不要在这里记录凭证、私密对话或模型推测的共同经历。普通整理由 WorkBuddy 维护；涉及架构、安全和 Agent 契约的决定属于红区。
