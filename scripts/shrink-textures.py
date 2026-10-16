#!/usr/bin/env python
# scripts/shrink-textures.py
# Live2D 贴图降分辨率工具（2026-10-17：缅因妹妹 8192→4096）
#
# 为什么要有这个脚本：桌宠常驻时三张 8192×8192 RGBA 贴图解出来约 768MB 显存，
# 显存带宽与解码时间都压在渲染线程上，表现就是掉帧、动作发涩。降到 4096 后约 192MB。
#
# 设计原则：
#   1. **不覆盖、不删除**：原图移到 <模型>/_source/原尺寸目录/，新图另存 <模型>/<模型>.<边长>/，
#      改 model3.json 的 FileReferences.Textures 指过去。随时可以改回来。
#   2. 保持宽高比、优先 2 的幂（8192→4096 正好对半，是最理想的缩放比）。
#   3. 保通道：RGBA 就还是 RGBA，不丢 Alpha（Live2D 靠 Alpha 裁形）。
#   4. 先 --scan 看清单与风险，确认后再真跑。
#
# 用法：
#   python scripts/shrink-textures.py --scan                     # 只扫描出清单和建议
#   python scripts/shrink-textures.py --model=Maine --max=4096   # 真跑
#   python scripts/shrink-textures.py --model=Maine --max=4096 --keep=texture_02.png
#
# 注意：Windows 控制台默认代码页会把 UTF-8 输出拆错，本文件**不含中文注释**；
# 运行日志用 ASCII（与项目其它脚本一致的约定）。
import argparse
import json
import os
import shutil
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow not installed. pip install Pillow')

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(ROOT), 'models')


def human(n):
    return f'{n / 1048576:.1f}MB' if n >= 1048576 else f'{n / 1024:.0f}KB'


def pow2_floor(n):
    """不超过 n 的最大 2 的幂"""
    p = 1
    while p * 2 <= n:
        p *= 2
    return p


def target_size(w, h, cap):
    """保持宽高比缩到最大边长 <= cap，并落到 2 的幂"""
    scale = min(1.0, cap / float(max(w, h)))
    tw, th = int(round(w * scale)), int(round(h * scale))
    # 原图若本来就是 2 的幂，缩放后也应当是；否则各自向下取到 2 的幂
    if w & (w - 1) == 0:
        tw = pow2_floor(tw)
    if h & (h - 1) == 0:
        th = pow2_floor(th)
    return max(1, tw), max(1, th)


def looks_like_normal_map(im):
    """法线贴图判据：整体偏蓝紫，B 通道明显高于 R/G，且没有大片透明"""
    small = im.resize((64, 64), Image.BOX)
    px = list(small.convert('RGBA').getdata())
    opaque = [p for p in px if p[3] > 200]
    if len(opaque) < len(px) * 0.5:
        return False, 'mostly transparent'
    r = sum(p[0] for p in opaque) / len(opaque)
    g = sum(p[1] for p in opaque) / len(opaque)
    b = sum(p[2] for p in opaque) / len(opaque)
    if b > r + 30 and b > g + 30 and b > 140:
        return True, f'avg RGB=({r:.0f},{g:.0f},{b:.0f}) bluish'
    return False, f'avg RGB=({r:.0f},{g:.0f},{b:.0f})'


def scan_texture(path):
    im = Image.open(path)
    w, h = im.size
    mode = im.mode
    size = os.path.getsize(path)
    # 不透明像素占比 + 有效内容包围盒（降采样到 512 统计，够用且快）
    probe = im.convert('RGBA').resize((512, 512), Image.BOX)
    data = probe.getdata()
    n = len(data)
    opaque = 0
    minx, miny, maxx, maxy = 512, 512, -1, -1
    for i, p in enumerate(data):
        if p[3] > 16:
            opaque += 1
            x, y = i % 512, i // 512
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
    cover = opaque / n
    if maxx < 0:
        bbox = None
        fill = 0.0
    else:
        bw, bh = maxx - minx + 1, maxy - miny + 1
        bbox = (minx / 512, miny / 512, (maxx + 1) / 512, (maxy + 1) / 512)
        fill = opaque / (bw * bh)
    is_normal, why = looks_like_normal_map(im)
    return {
        'file': os.path.basename(path),
        'size': (w, h), 'mode': mode, 'bytes': size,
        'cover': cover, 'bbox': bbox, 'fill': fill,
        'normal': is_normal, 'normal_why': why
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='Maine')
    ap.add_argument('--max', type=int, default=4096, help='max edge, power of two')
    ap.add_argument('--scan', action='store_true', help='scan only')
    ap.add_argument('--keep', default='', help='comma separated files to leave untouched')
    ap.add_argument('--quality', default='lanczos', choices=['lanczos', 'bicubic'])
    args = ap.parse_args()

    model_dir = os.path.join(MODELS, args.model)
    model3 = os.path.join(model_dir, f'{args.model}.model3.json')
    if not os.path.exists(model3):
        sys.exit(f'model3.json not found: {model3}')
    cfg = json.load(open(model3, encoding='utf-8'))
    tex_refs = (cfg.get('FileReferences') or {}).get('Textures') or []
    if not tex_refs:
        sys.exit('no Textures in FileReferences')

    keep = {s.strip() for s in args.keep.split(',') if s.strip()}
    rows = []
    for rel in tex_refs:
        p = os.path.join(model_dir, rel)
        if not os.path.exists(p):
            print(f'  MISSING {rel}')
            continue
        info = scan_texture(p)
        info['rel'] = rel
        w, h = info['size']
        tw, th = target_size(w, h, args.max)
        info['target'] = (tw, th)
        info['shrink'] = w > args.max or h > args.max
        rows.append(info)

    print(f'model: {args.model}   cap: {args.max}\n')
    print(f"{'file':<16}{'current':<12}{'target':<12}{'size':<10}{'alpha':<8}{'fill':<8}note")
    print('-' * 96)
    total_now = total_new = 0
    for r in rows:
        w, h = r['size']
        tw, th = r['target']
        # 粗略估算：体积与像素数近似成正比
        est = r['bytes'] * (tw * th) / float(w * h)
        total_now += w * h * 4
        total_new += (tw * th if r['shrink'] and r['file'] not in keep else w * h) * 4
        notes = []
        if r['normal']:
            notes.append('NORMAL-MAP? ' + r['normal_why'])
        if r['cover'] < 0.08:
            notes.append(f'sparse atlas (alpha {r["cover"]*100:.1f}%)')
        if r['fill'] < 0.5 and r['bbox']:
            notes.append(f'content fills {r["fill"]*100:.0f}% of bbox')
        if r['file'] in keep:
            notes.append('KEEP (user)')
        if not r['shrink']:
            notes.append('already <= cap')
        print(f"{r['file']:<16}{f'{w}x{h}':<12}{f'{tw}x{th}':<12}{human(r['bytes']):<10}"
              f"{r['cover']*100:>5.1f}%  {r['fill']*100:>5.0f}%  {'; '.join(notes)}")

    print('-' * 96)
    print(f'VRAM (RGBA, decoded): {total_now/1048576:.0f}MB -> {total_new/1048576:.0f}MB '
          f'(-{(1-total_new/total_now)*100:.0f}%)')

    if args.scan:
        print('\n[scan only] re-run without --scan to apply.')
        return

    # ---- apply ----
    cap_dir = os.path.join(model_dir, f'{args.model}.{args.max}')
    os.makedirs(cap_dir, exist_ok=True)
    backup = os.path.join(model_dir, '_source', f'{args.model}.orig')
    os.makedirs(backup, exist_ok=True)

    resample = Image.LANCZOS if args.quality == 'lanczos' else Image.BICUBIC
    new_refs = []
    for r in rows:
        rel = r['rel']
        src = os.path.join(model_dir, rel)
        dst = os.path.join(cap_dir, r['file'])
        if r['file'] in keep or not r['shrink']:
            shutil.copy2(src, dst)
            # 必须用正斜杠：model3.json 里的路径会被拼进 nagi-local:// URL，
            # Windows 的 os.path.join 给出反斜杠，在 URL 里会出问题（D14）
            new_refs.append(f'{args.model}.{args.max}/{r["file"]}')
            print(f'  copy   {r["file"]}')
            continue
        w, h = r['size']
        tw, th = r['target']
        im = Image.open(src)
        if im.mode != 'RGBA':
            im = im.convert('RGBA')
        im = im.resize((tw, th), resample)
        im.save(dst, 'PNG', optimize=True)
        # 备份原图（不覆盖同名文件）
        bk = os.path.join(backup, r['file'])
        if not os.path.exists(bk):
            shutil.move(src, bk)
        new_refs.append(f'{args.model}.{args.max}/{r["file"]}')  # 正斜杠，见 D14
        print(f'  resize {r["file"]}: {w}x{h} -> {tw}x{th}  {human(r["bytes"])} -> {human(os.path.getsize(dst))}')

    cfg.setdefault('FileReferences', {})['Textures'] = new_refs
    json.dump(cfg, open(model3, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'\nupdated {os.path.basename(model3)}: Textures -> {args.model}.{args.max}/')
    print(f'originals kept in: {os.path.relpath(backup, model_dir)}')


if __name__ == '__main__':
    main()
