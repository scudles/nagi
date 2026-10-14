# models/ —— Live2D 模型放置目录

本目录用于存放 Live2D Cubism 4 模型。模型文件体积较大且涉及版权，**不入 git**，
需要你自行下载后按下面的结构放进来。

## 主用模型：Lisette（ShiraLive2D）

- Booth 页：<https://booth.pm/ja/items/5354776>（`lisette_v2.zip`，约 31MB，免费·非商用）
- 作者免费模型页：<https://shiralive2d.com/live2d-sample-models/>
- 也可从作者的 Google Drive / VTube Studio Steam Workshop 获取

> 注意：Booth 下载需要登录，这一步必须你本人操作。

下载解压后，目录结构应类似：

```
models/
└── Lisette/
    ├── lisette.model3.json      ← 入口文件（名字以实际为准）
    ├── lisette.moc3
    ├── lisette.physics3.json
    ├── *.exp3.json              ← 表情
    ├── *.motion3.json           ← 动作
    └── *.png                    ← 贴图
```

启动后应用会自动扫描本目录下的 `*.model3.json`，在「设置 → Live2D → 模型」里选择。

## 已内置的验证模型：Mao（虹色まお，Live2D 官方免费示例）

本目录下已放好 **Mao**（官方免费示例，132 参数、8 表情、EyeBlink/LipSync 组齐全），
用于在拿到 Lisette 之前跑通并验证渲染管线。它**不入 git**，可用脚本随时重新拉取：

```bash
node scripts/fetch-sample-model.mjs          # 默认 Mao
node scripts/fetch-sample-model.mjs Hiyori    # 也可拉 Hiyori / Haru
```

> 坑位记录：官方示例仓库的二进制文件（`.moc3` / `.png`）在 `cdn.jsdelivr.net` 上会被
> 301 重定向到 `raw.githubusercontent.com`（本机常不可达）；脚本默认走 `gcore.jsdelivr.net`
> 镜像并做多镜像回退，可直接命中。

当然你也可以手动下载任意 Cubism 4 模型（Hiyori / Haru / 你自己的）放进本目录。

## 换用 Lisette（主用模型）

拿到 Lisette 后放进本目录（例如 `models/Lisette/`），在「设置 → Live2D → 模型」里切换即可。
若 Lisette 的表情命名不直观，可在模型目录里放一个可选的映射文件
`nagi-emotion.json` 覆盖默认的 6 情绪 → 表情对应（详见 `src/renderer/js/live2d.js` 顶部注释）。

## 加载方式

应用通过自定义特权协议加载模型：

```
nagi-local://models/<相对本目录的路径>
```

例如 `nagi-local://models/Lisette/lisette.model3.json`。
模型内部的贴图/动作/物理等相对路径会自动解析，无需额外处理。
