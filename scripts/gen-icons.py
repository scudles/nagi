"""生成托盘/应用图标（凪：深色圆角底 + 奶油色小花饰）。
运行：python scripts/gen-icons.py（或由本工作流的助手直接执行）
输出：resources/tray.png(32) / tray@2x.png(64) / icon.png(256)
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
os.makedirs(OUT, exist_ok=True)

BG = (32, 36, 47, 255)      # 与界面 --bg-panel 一致
RING = (143, 167, 255, 255)  # --accent
PETAL = (245, 236, 205, 255)  # 奶油色


def draw(size, ss=4):
    S = size * ss
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    pad = int(S * 0.06)
    radius = int(S * 0.24)
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=BG)

    cx = cy = S / 2

    # 外圈细环
    ring_r = S * 0.30
    ring_w = max(1, int(S * 0.028))
    d.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], outline=RING, width=ring_w)

    # 六瓣小花
    petal_r = S * 0.135
    petal_d = S * 0.115
    for i in range(6):
        a = math.radians(i * 60 - 90)
        px = cx + math.cos(a) * petal_r
        py = cy + math.sin(a) * petal_r
        d.ellipse([px - petal_d, py - petal_d, px + petal_d, py + petal_d], fill=PETAL)

    # 花心
    core = S * 0.085
    d.ellipse([cx - core, cy - core, cx + core, cy + core], fill=RING)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for name, size in [("tray.png", 32), ("tray@2x.png", 64), ("icon.png", 256)]:
        img = draw(size)
        path = os.path.join(OUT, name)
        img.save(path)
        print("saved", path, img.size)


if __name__ == "__main__":
    main()
