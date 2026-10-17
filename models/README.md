# models/ —— Live2D 模型放置目录

本目录用于存放 Live2D Cubism 4 模型。模型文件体积较大且涉及版权，**不入 git**
（`models/*` 已加入 .gitignore，仅本 README 例外）。

## 主用模型：缅因妹妹（已安装 ✅，2026-10-17 换装）

- 目录：`models/Maine/`
- 角色：**缅因妹妹**（猫娘，缅因猫设定）
  - 立绘：赛博撸猫人　建模：糖糖锦鲤（B 站工坊售卖，**禁止二传、禁止商用**）
  - 交付包：`缅因妹妹完整版+(2).zip`（约 92MB），原件保留在桌面
- 加载入口：`nagi-local://models/Maine/Maine.model3.json`
  （默认模型，见 `src/shared/protocol.js` 的 `DEFAULT_SETTINGS.live2d.modelPath`）

### 为什么目录叫 `Maine` 而不是「缅因妹妹」

`nagi-local://` 要拼 URL、Windows 又要过一层路径编码，中文文件名是实打实的坑
（交付包里已经有一张图的文件名被编码打成了 `[M%_O$@6(OU@R@SXLWP`N_G.png`）。
所以**磁盘上一律 ASCII**：`Maine.moc3` / `Maine.8192/` / `Expressions/blush.exp3.json`；
而 `model3.json` 里的 `Name` 保留作者原名（脸红、星星眼、丸子头…），
所以动作面板、设置面板、`listExpressions()` 里看到的仍然是中文。

### 接线改动（原包是给 VTube Studio 用的，表情/动作都是散放的）

原版 `缅因妹妹.model3.json` 只声明了 Moc / 贴图 / 物理，表情和动作一个都没挂。
在副本里补齐了：

- **Expressions**：31 个原包表情全部挂上，另加 5 个本项目自写的 `nagi_*`（见下）
- **Motions**：4 个原包动作 + 1 个自写待机，按组归类（见下）
- **Groups**：`LipSync` 原本是空数组（口型驱动不起来），补成
  `ParamMouthOpenY` + `ParamMouthForm`；`EyeBlink` 沿用原包（`ParamEyeLOpen/ROpen`）
- **Physics / DisplayInfo**：原包自带，原样挂上（`Maine.physics3.json` 340KB，
  头物理 + 眼睛物理 + 兽耳都会动）

### 动作组（Motions）

| 组 | 内容 | 谁在用 |
|---|---|---|
| `Idle` | `nagi_idle`（**本项目自写**：9s 轻摆，只动 `ParamBodyAngleY/Z`） | `main.js` 空闲轮换 |
| `TapBody` | 挥手← / 挥手→ / 双手挥手 | 戳一戳 `pokeHer()` |
| `Greet` | 双手挥手 / 挥手← / 挥手→ | 打招呼、疑惑时低概率 |
| `Happy` | 双手挥手 | 开心（joy），60% 概率 |
| `Scene` | `scene_effects` = 原包 `Scene1`（10.8s 特效场景：尾巴/翅膀/困/鼻涕泡/花花…） | 只放在面板/接口里，**不参与 randomMotion** |

两个取舍记一下：

1. **原包没有待机动作**。`Scene1` 会把哭哭、流汗、花花、鼻涕泡、困这些特效轮一遍，
   拿它当待机会让桌宠一直"演"，所以单独塞进 `Scene` 组；待机由自写的 `nagi_idle` 承担
   （只动身体旋转、幅度很小，且避开自动呼吸已经接管的 `ParamAngle*` / `ParamBreath`，
   免得两种摆动叠在一起晃）。
2. **原包没有音效**：4 个 `motion3.json` 的 `UserDataCount` 全是 0，包里也没有
   mp3/wav。桌宠的语音本来就走 TTS 侧（`core/voice`），**不需要接模型音效**。

### 本项目自写的表情（`Expressions/nagi_*.exp3.json`）

这套模型原包的表情是"按键特效"导向的（脸红 / 星星眼 / 哭哭 / 流汗 / 发型 / 配件开关…），
**没有安静的日常面容**，而凪的设定是「表层干净、情绪起伏很小」。所以沿用
`models-archive/Lisette` 的做法，用模型自带参数自己拼了一组：

| 文件 | 参数 | 用途 |
|---|---|---|
| `nagi_neutral` | 复位（+ 关水印） | 平静 = 回到默认面容 |
| `nagi_smile` | `ParamEyeL/RSmile` + `ParamCheek` 0.35 | 微笑：笑眼 + 一点脸红 |
| `nagi_joy` | `ParamEyeL/RSmile` + `ParamCheek` 0.8 + `ParamMouthOpenY` 0.35 | 开心（罕见真笑） |
| `nagi_puzzled` | `ParamBrowLY` +0.55 / `ParamBrowRY` +0.12 | 疑惑：不对称挑眉 |
| `nagi_pout` | `ParamBrowL/RY` −0.45 | 闹别扭 / 存在性不安的轻量外显：沉眉 |

### 装束（`models/Maine/nagi-outfit.json`，2026-10-17 新增）

把模型自带的**配件开关**组织成可以切换的装束。参数语义来自原包作者的按键说明
（`_source/缅因妹妹按键说明.txt`）加逐个渲染实测：

| 槽位 | 参数 | 选项 |
|---|---|---|
| 发型 | `Param2/3/4/5` | 长发（默认）/ 短发 / 丸子头 / 高马尾 / 侧编发 |
| 眼镜 | `Param20` | 戴 / 不戴（该参数 1 = 摘下，实测默认是戴着） |
| 兽耳 | `Param` | 露出 / 收起 |
| 蝴蝶结 | `Param11` | 系着 / 收起 |
| 披肩 | `Param466` | 披着 / 收起 |
| 尾巴 | `Param322`·`Param467` | 垂着 / 翘起来 / 收起来 |

预设 6 套：`daily` 日常（默认）/ `home` 宅家 / `going_out` 出门 / `work` 做事 / `lazy` 赖着 /
`night` 睡前。想加自己的：往 `looks` 里加一条 `{ id, name, desc, slots: { 槽位: 选项id } }` 即可，
设置页与托盘菜单会自动出现（启动时渲染层会把清单上报宿主）。

**为什么是参数不是表情**：Live2D 的 expression 是独占的——用表情做装束会把当前情绪表情顶掉。
装束走渲染层的"参数保持层"（每帧按绝对值写回），所以**装束与情绪面容可以同时存在**。
切换时还有眨眼掩护，不会"啪"地一下变。

### 面部表达三层（`models/Maine/nagi-face.json`，2026-10-17 新增）

这个模型是给面捕直播做的，五官参数很全。之前只用 exp3 切表情、静止时脸完全不动，浪费了这些参数。
现在一份配置管三层：

| 段 | 内容 | 说明 |
|---|---|---|
| `emotions` | 情绪 → 五官「肌肉」向量 | 满强度(1.0)的值，实际表现 = 向量 × `mood.intensity`。比例沿用美术调好的 exp3（`nagi_joy`/`nagi_puzzled`/`nagi_pout`），并给原先只有特效符号的 `smile`（原来只有脸红）、`worry`（原来只有紧张汗）补上真正的五官结构 |
| `tremor` | 静止时的五官微动 | 7 路不同频正弦 + 眼球微扫视。左右刻意不同频不同相——同步抖动看起来像故障。`amplitude` 调明显程度（1 = 当前，0 = 关掉） |
| `blink` | 自动眨眼 | 框架在动作播放时会跳过眨眼（`if (!motionUpdated)`），而 Idle 常驻循环 → 必须自己排。`minGapMs/maxGapMs` 控制频率（默认 2.2~5.6 秒），`closeMs/holdMs/openMs` 控制形状（闭得快开得慢），`doubleChance` 是连眨两下的概率 |
| `visemes` | 元音口型 | `a/i/u/e/o` 各自的 `JawOpen` / `MouthForm` / 嘴距形状，说话时每 150~260ms 换一个 |

想加情绪或调表情：往 `emotions` 里加一条 `{ 参数ID: 值 }` 即可（键要和 `nagi-emotion.json` 里的表情名对上，
比如 `nagi_joy`）。**参数名必须是模型真实拥有的**——`test/face-expression.test.js` 有静态断言会拦住写错的。

### 瞬时微表情（`models/Maine/nagi-microexpr.json`，2026-10-17 新增）

模型里那些"一次性特效表情"（星星眼、花花、吐舌…）现在有了出路：待机时**闪一下再收回**。
8 个池子条目、各 1.2~2.2 秒，按待机基调与权重随机挑，不连着两次同一个。

| id | 名字 | 参数 | 适用基调 |
|---|---|---|---|
| star | 星星眼 | `Param16` | 你看视频/游戏 |
| heart | 爱心眼 | `Param17` | 你看视频/游戏 |
| flower | 花花 | `Param14` | 通用 |
| sweat | 流汗 | `Param116` | 你在忙 |
| puff | 鼓嘴 | `Param315` | 通用 |
| tongue | 吐舌 | `Param26`+`Param317` | 通用 |
| angry | 炸毛 | `Param93`+`Param321` | 通用 |
| cry | 委屈 | `Param13` | 你在忙 |

**关键**：池里的参数**刻意避开**情绪（眉毛/脸颊/眼笑/嘴张/水印）与装束（发型/眼镜/兽耳/尾巴…）
已经在用的那些——重叠会互相覆盖，"多一双星星眼"就变成了"换一张脸"。
`test/microexpr.test.js` 有一条静态断言卡住这条，改池子时会被立刻打回来。

实现走**参数层 + add**（不是 expression）：expression 独占会顶掉情绪表情；
add 是叠加，她该有的脸还在。而且框架每帧末会把参数恢复成"动作之后、表情之前"的定格值
（见 [D25](../docs/DECISIONS.md)），所以 add 只在当帧有效，钩子一卸载就干净回落。

### 撅嘴（`Expressions/nagi_pout.exp3.json`）2026-10-17 增强

原来只压眉毛（`ParamBrowLY/RY = −0.45`），画面差只有 **0.2%**——等于看不见。
模型里其实有 `Param29 撅嘴 Mouth Shrug`、`ParamMouthForm 嘴变形`、`ParamBrowLY2 生气/瞪眼`，
补上后同一个表情现在能测到 **1.2%~12.2%**。绝对值仍不算大，是因为嘴在胸像取景里
本来就只占画面零点几个百分点（不是没做出来）。

### 6 情绪 → 表情映射（`models/Maine/nagi-emotion.json`）

```
calm → nagi_neutral      smile → nagi_smile
joy  → nagi_joy (+Happy 60%)    puzzled → nagi_puzzled (+Greet 15%)
worry → 紧张汗           pout → nagi_pout
 blush → 脸红（非情绪键，预留给"被夸奖→脸红一下"的瞬时反应）
```

想调映射就改这个文件（**值必须是 `model3.json` 里表情的 `Name`，不是文件名**——2026-10-17
踩过：smile 填文件名 `blush`、worry 填 `nervous_sweat`，而这两个表情的 Name 是「脸红」
「紧张汗」，`resolveExpression` 静默返回 null，微笑/担心两张脸彻底不出现还不报错。
`test/face-expression.test.js` 有静态锁卡这条），重启桌宠生效。

**没进映射的表情**（资产都在、面板里能点，只是不会被情绪系统抽到）：

- 发型 / 配件开关类：丸子头、侧编发、短发、高马尾、眼镜、耳朵、尾巴上/关闭、披肩关闭、
  蝴蝶结关闭、水印关闭
- **脸黑**（`Param18`，整脸压黑）——与 2026-10-15「移除 dark_mask 系列」的决定同源，
  不进映射；如需一并封死，可把它加进 `src/renderer/js/live2d.js` 的
  `HIDDEN_EXPRESSIONS`
- **身体消失**（`Param468`）——桌宠不该自己消失
- 姿势类：坐下、zZZ、嗷呜1/2、身前手、身前手2、麦克风、挥手、挥手1
- 情绪备胎：哭哭、流汗、爱心眼、星星眼、生气、生气气泡、花花

### 贴图：已降到 4096（2026-10-17）

原包给的是 **8192×8192 ×3 张**（`Maine.8192/`，磁盘 94MB，解码后显存约 **768MB**），
桌宠常驻明显吃力。已统一降到 4096：

| | 8192（原） | 4096（现） |
|---|---|---|
| 磁盘 | 94.2MB | **13.5MB**（−86%） |
| 解码后显存 | 768MB | **192MB**（−75%） |
| 冷启动到桌宠就绪 | 6.4s | **2.8s**（快 2.3 倍） |
| 画质（PSNR，越高越好） | — | 35.8 ~ 37.0 dB（>30dB 肉眼基本无感） |

- 现贴图在 `Maine.4096/`，`model3.json` 的 `FileReferences.Textures` 已指过去；
- **原 8192 一张没删**，移到了 `models-archive/Maine-textures-8192/`（不入库、不打进安装包）；
- 重跑/换尺寸用 `python scripts/shrink-textures.py --model=Maine --max=4096`
  （先 `--scan` 看清单和风险再真跑；支持 `--keep=某张.png` 单独保留）；
- 想还原：把 `models-archive/Maine-textures-8192/` 的三张拷回 `models/Maine/Maine.8192/`，
  再把 `model3.json` 的 `Textures` 改回去（`Maine.model3.json.bak-20261017` 是压缩前的原配置）。

**为什么 4096 够用**：桌宠最大尺寸 900×1300 时形象实际只画 751×901 像素，
4096 贴图对屏幕像素仍是过剩采样；再降到 2048 才会在大窗/放大时开始糊。

**三张里唯一要单独说的是 `texture_02.png`**：它不透明像素只占全图 **0.2%**，
装的是翅膀、花花、星星眼、汗滴、鼻涕泡这类**特效小元素的图集**（`Param220 翅膀2` 等，
`Scene` 动作会用到）。这类"图集里塞一堆小东西"的贴图降采样损失最明显
（PSNR 32.1 dB，比主贴图低一档），但特效在 400×600 桌宠上显示尺寸本来就很
小，实际观感影响有限。若你特别在意特效锐利，可单独保留它 8192：
`--keep=texture_02.png`（代价：显存回到约 384MB）。

**没有需要特殊对待的法线贴图 / UI 贴图 / 文字贴图**：三张都是普通 RGBA 彩色贴图
（已用"整体偏蓝紫 + B 通道显著高于 R/G"的判据扫过，无一张是法线贴图）；
模型里唯一跟文字有关的是**水印**（`Param469`），它画在主贴图上，降分辨率会让它更糊——
这反而是好事，且 `nagi_*` 表情本来就默认关水印。

### ⚠ 另一个要留意的点

**水印**：原包默认带水印（作者给的去除方式是 `ctrl+shift`）。
   `Param469` 是水印开关；本目录把它写进了 `nagi_*` 表情，切到这些表情时水印是关的。
   要彻底常关，在 `nagi-emotion.json` 里加 `"holdParams": {"Param469": 1}`
   需要渲染层配合（尚未接线）。

## 旧模型归档

原来在用的 **Lisette v2**（《Pocket Mirror》同人，shiranui_bzw 制作）与
**Mao**（Live2D 官方示例，仅用于验证渲染管线）已于 2026-10-17 移出 `models/`，
放到 **`models-archive/`**（工程根目录下）。

- 目的：让缅因妹妹成为**唯一生效**的角色形象（设置面板里不会再出现旧模型）
- 文件都还在，没有删；想换回去把目录挪回 `models/` 即可
- `models-archive/` 不在 electron-builder 的 `extraResources` 里，不会打进安装包
- 想重新拉 Mao：`node scripts/fetch-sample-model.mjs`（默认 Mao，也可 Hiyori / Haru）

## 加载方式

应用通过自定义特权协议加载模型：

```
nagi-local://models/<相对本目录的路径>
```

例如 `nagi-local://models/Maine/Maine.model3.json`。
模型内部的贴图/动作/物理等相对路径会自动解析，无需额外处理。

启动后应用会扫描本目录下的 `*.model3.json`（深度 ≤ 4），在「设置 → Live2D → 模型」里选择。
