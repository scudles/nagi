# models/ —— Live2D 模型放置目录

本目录用于存放 Live2D Cubism 4 模型。模型文件体积较大且涉及版权，**不入 git**
（`models/*` 已加入 .gitignore，仅本 README 例外），原始压缩包 `lisette_v2.zip`
保留在项目根目录作为 pristine 备份。

## 主用模型：Lisette v2（已安装 ✅）

- 角色来源：**Lisette**（游戏《Pocket Mirror》角色，© AstralShift）
- Live2D 制作：**shiranui_bzw**（Booth 免费下载，**禁止商用**，仅限个人使用）
- Booth 页：<https://booth.pm/ja/items/5354776>（`lisette_v2.zip`，约 31MB）
- 解压位置：`models/Lisette/`（2026-10-14 由苦瓜瓜下载后合入）

### 我们对模型做的接线改动（仅改解压副本，zip 原件未动）

原版 `Lisette.model3.json` 只挂了 Moc/贴图/物理，表情和动作是散放的
（给 VTube Studio 用）。为接入 nagi 的情绪系统，在副本里增加了：

- **Expressions**：原作者全部表情（angry / sad / shy / tear / tongue_out / frenzy /
  sans_eye_glow / dark_mask×4）+ 4 个 nagi 定制表情（见下）
- **Motions**：
  - `Idle` 组：breathing / hand_fiddle_idle / shy_idle（空闲时自动轮换）
  - `TapBody` 组：jump_ani（戳一戳反馈）
  - ⚠️ `sukato_no_naka_ani`（裙底动画）**未接线**，不适合常驻桌宠场景

### nagi 定制表情（`Expressions/nagi_*.exp3.json`，本项目作者编写）

| 文件 | 参数 | 用途 |
|---|---|---|
| `nagi_calm` | 空操作（切换即复位其他表情） | 平静 = 回到默认面容 |
| `nagi_joy` | ParamEyeL/RSmile + ParamCheek | 开心：笑眼 + 脸红 |
| `nagi_puzzled` | ParamBrowLY +0.6 / ParamBrowRY +0.1 | 疑惑：不对称挑眉 |
| `nagi_pout` | ParamBrowL/RY -0.5 | 闹别扭：沉眉（原版 angry 红眼光效太夸张，未采用；想换回原版改 `nagi-emotion.json` 即可） |

### 6 情绪 → 表情映射（`models/Lisette/nagi-emotion.json`）

```
calm → nagi_calm    smile → shy        joy → nagi_joy
puzzled → nagi_puzzled    worry → sad      pout → nagi_pout
```

想调整映射就改这个文件（值必须是 model3.json 里存在的表情名），重启桌宠生效。

## 已内置的验证模型：Mao（虹色まお，Live2D 官方免费示例）

`models/Mao/`（132 参数、8 表情、EyeBlink/LipSync 组齐全），在拿到 Lisette 之前
用于验证渲染管线，现留作 fallback。它**不入 git**，可用脚本随时重新拉取：

```bash
node scripts/fetch-sample-model.mjs          # 默认 Mao
node scripts/fetch-sample-model.mjs Hiyori    # 也可拉 Hiyori / Haru
```

> 坑位记录：官方示例仓库的二进制文件（`.moc3` / `.png`）在 `cdn.jsdelivr.net` 上会被
> 301 重定向到 `raw.githubusercontent.com`（本机常不可达）；脚本默认走 `gcore.jsdelivr.net`
> 镜像并做多镜像回退，可直接命中。

## 换模型

启动后应用会自动扫描本目录下的 `*.model3.json`，在「设置 → Live2D → 模型」里选择。
默认模型为 `Lisette/Lisette.model3.json`（见 `src/shared/protocol.js` 的
`DEFAULT_SETTINGS.live2d.modelPath`；若在设置里保存过其他选择，以保存值为准）。

## 加载方式

应用通过自定义特权协议加载模型：

```
nagi-local://models/<相对本目录的路径>
```

例如 `nagi-local://models/Lisette/Lisette.model3.json`。
模型内部的贴图/动作/物理等相对路径会自动解析，无需额外处理。
