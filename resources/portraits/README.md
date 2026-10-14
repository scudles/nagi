# resources/portraits — 凪 · 表情差分立绘

8 张赛璐璐动画风透明底表情差分（1024×1536 WebP，约 180KB/张）。

## 来源与用途

- **来源**：2026-10-13 形象设计迭代的定稿基准（乌黑长直齐刘海 + 细框眼镜 + 奶油色小花饰 + 黑色哥特蕾丝高领裙 + 十字架项圈），原图为 1024×1536 PNG（约 2.6MB/张），经 `scripts/convert-portraits.py` 转 WebP 入库（quality=88，实测视觉无损）。
- **原稿位置**：`../手机端任务_去水印/透明底/`（项目根，不入库）。
- **用途**：
  1. **未来 Live2D 建模参考**——委托绑定/重绘时给画师作表情与服装基准；
  2. **备用静态立绘**——D1 决策不做「模型加载失败自动降级」，但此处资源保留，
     需要时（如文档、宣传图、README 配图）可直接引用。

## 情绪对照

| 文件 | 原稿 | Live2D 表情（Lisette） |
| --- | --- | --- |
| 01_calm.webp | 表情1_平静 | nagi_calm |
| 02_puzzled.webp | 表情2_疑惑 | nagi_puzzled |
| 03_smile.webp | 表情3_微笑 | shy |
| 04_worry.webp | 表情4_皱眉 | sad |
| 05_pout.webp | 表情5_闹别扭 | nagi_pout |
| 06_joy.webp | 表情6_罕见真笑 | nagi_joy |
| 07_blink.webp | 表情7_眨眼 | （眨眼差分，无对应常驻表情） |
| 08_mouth_open.webp | 表情8_开口 | （开口差分，说话口型参考） |

> 注：Live2D 映射由 `src/renderer/js/live2d.js` 的通配候选表 + 模型目录
> `nagi-emotion.json` 覆盖机制管理；本表仅为对照参考。

## 版权

仅限本项目（凪桌面助手）内部使用，请勿外传。
