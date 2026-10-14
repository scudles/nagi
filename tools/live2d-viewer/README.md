# Live2D 模型预览器（tools/live2d-viewer）

一个**零依赖、免打包**的本地 Live2D 预览工具：扫描模型目录 → 列出所有 `*.model3.json` →
在浏览器里渲染模型，并用鼠标交互查看动画、表情与物理效果。用于验收新模型（比如凪的
Lisette）、调试表情/动作接线、对比不同模型。

## 运行

```bash
# 在 nagi 工程根目录
npm run viewer                 # 等价于：node tools/live2d-viewer/server.mjs
```

启动后自动打开浏览器（默认 <http://127.0.0.1:8787/>），默认预览 `models/` 目录。

可选参数：

```bash
node tools/live2d-viewer/server.mjs --root D:/其他模型目录   # 换模型根目录
node tools/live2d-viewer/server.mjs --port 9000             # 换端口（被占用会自动 +1）
node tools/live2d-viewer/server.mjs --no-open               # 不自动开浏览器
```

## 交互

| 操作 | 效果 |
|---|---|
| 滚轮 | 缩放（以指针位置为中心） |
| 按住左键拖动 | 平移模型 |
| 单击模型 | 戳一戳（触发行内动作组，如 Lisette 的 `TapBody`） |
| 侧栏「表情」 | 列出模型声明的全部表情，点击即应用；「清除表情」复位 |
| 侧栏「动作」 | 列出动作组（如 `Idle` / `TapBody`），点击播放组内随机一个；可停止 |
| 模拟开关 | 物理演算 / 自动眨眼 / 呼吸起伏 / 视线跟随 / 水平镜像 |
| 顶栏 | 切换模型、重载、棋盘格背景（看半透明边缘） |
| 快捷键 | `0` 适应窗口　`M` 镜像 |

## 与 nagi 工程的关系

- **复用同一套运行库**：Cubism Core（`src/renderer/public/vendor/`）+ pixi 7 +
  pixi-live2d-display，直接读 `node_modules`，不额外安装、不打包。
- **复用同一批模型**：默认根目录就是工程的 `models/`，所以凪的 Lisette（含本项目
  接线的表情与动作）打开即可预览，Mao 作为对比模型也在列表里。
- **加载语义与桌宠一致**：同样走 `*.model3.json` 的 `FileReferences`（Moc/Textures/
  Physics/Expressions/Motions），因此**预览器里看到的表情/动作列表，就是桌宠
  `src/renderer/js/live2d.js` 能用的那一套**——可以拿它当接线验收工具。
- 差异：桌宠用 `nagi-local://` 特权协议读本地文件，预览器用 HTTP 静态服务；
  桌宠锚点对齐屏幕底部，预览器锚点在中心（便于缩放平移）。

## 模型目录约定

扫描规则与主程序 `src/main/ipc/settings.js` 的 `listModels()` 一致：
递归查找 `*.model3.json`（深度 ≤ 4，跳过隐藏目录与 `node_modules`）。

```
models/
├── Lisette/Lisette.model3.json     ← 默认模型
└── Mao/Mao.model3.json
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面提示缺少 Cubism Core | 在工程根执行 `npm install`（postinstall 会补 `src/renderer/public/vendor/live2dcubismcore.min.js`） |
| 模型列表为空 | 确认 `models/` 下有 `*.model3.json`，或用 `--root` 指向模型所在目录 |
| 画布全黑/空白 | 浏览器需支持 WebGL；换 Chrome/Edge 打开，检查是否禁用了硬件加速 |
| 贴图没更新 | 贴图有 5 分钟缓存，强制刷新（Ctrl+F5）即可 |

> 说明：切换模型时只从舞台移除旧模型、不销毁像素缓存（pixi 按 URL 缓存），
> 因此来回切换模型会很快；这是预览工具的取舍，主程序不涉及。
