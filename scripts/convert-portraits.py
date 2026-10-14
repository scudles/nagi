# 表情差分 → WebP：把透明底 PNG 压缩进 nagi/resources/portraits/
# D3 决策：转 WebP 入库，原图保留在 手机端任务_去水印/ 不动
from PIL import Image
import os
import glob

SRC = '手机端任务_去水印/透明底'
DST = 'nagi/resources/portraits'
os.makedirs(DST, exist_ok=True)

MAPPING = {
    '表情1_平静': '01_calm',
    '表情2_疑惑': '02_puzzled',
    '表情3_微笑': '03_smile',
    '表情4_皱眉': '04_worry',
    '表情5_闹别扭': '05_pout',
    '表情6_罕见真笑': '06_joy',
    '表情7_眨眼': '07_blink',
    '表情8_开口': '08_mouth_open',
}

total_src = total_dst = 0
for f in sorted(glob.glob(os.path.join(SRC, '*.png'))):
    base = os.path.splitext(os.path.basename(f))[0]
    out_name = MAPPING.get(base, base) + '.webp'
    im = Image.open(f).convert('RGBA')
    out = os.path.join(DST, out_name)
    im.save(out, 'WEBP', quality=88, method=6)
    s, d = os.path.getsize(f), os.path.getsize(out)
    total_src += s
    total_dst += d
    print(f'{base}.png -> {out_name}  {s/1024:.0f}KB -> {d/1024:.0f}KB  {im.size[0]}x{im.size[1]}')

print(f'--- total {total_src/1024/1024:.1f}MB -> {total_dst/1024/1024:.1f}MB ({total_dst/total_src*100:.0f}%) ---')
