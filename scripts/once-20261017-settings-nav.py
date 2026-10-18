# scripts/once-20261017-settings-nav.py
#
# 一次性重构脚本（D49 二级菜单）：把设置面板从「20 个 h3 连续滚动」
# 改成「左侧 6 个分组导航 + 组内 <details> 折叠高级项」。
#
# 为什么用脚本而不是手改：中间那段有 385 行说明文字与控件，手抄必错。
# 这里只做**行的重排与包装**，所有 id / 文案 / 属性一字不动 —— 这也是
# main.js 无需改取值逻辑的前提（它全靠 getElementById）。
#
# 用法：python scripts/once-20261017-settings-nav.py
# 会先备份 index.html.bak-20261017-nav，再原地改写。

import io, os, shutil

SRC = os.path.join(os.path.dirname(__file__), '..', 'src', 'renderer', 'index.html')
SRC = os.path.normpath(SRC)
BAK = SRC + '.bak-20261017-nav'

lines = io.open(SRC, encoding='utf-8').read().split('\n')
# lines[i] = 第 i+1 行

# ---- 分组：每组包含哪些 h3 块（1-based 闭区间，行号取自改动前的 index.html）----
GROUPS = [
    ('person', '她这个人', [
        (250, 262),   # Live2D
        (264, 274),   # 装束
        (276, 296),   # 她自己待着的时候
        (298, 313),   # 她会不会「想一下再表现」
    ]),
    ('voice', '她的声音', [
        (315, 347),   # 她的声音（语音输出）
        (349, 366),   # 听你说话（语音输入）
    ]),
    ('memory', '她的记忆', [
        (368, 377),   # 她的记忆
        (379, 386),   # 共同经历账本
        (388, 393),   # 双人年鉴
        (395, 436),   # 记忆档案（长期记忆检索）
    ]),
    ('company', '陪伴', [
        (460, 472),   # 陪伴 · 时间感
        (474, 491),   # 时间感 · 高级（整块折叠）
        (493, 495),   # 打扰控制（整块折叠）
        (497, 514),   # 她留下的东西
        (516, 530),   # 陪伴 · 可选表达（不完美机制）
        (532, 536),   # 主动陪伴
        (538, 550),   # 活动监测
    ]),
    ('brain', '大脑与工具', [
        (227, 248),   # 大脑（LLM）
        (438, 458),   # 工具与隐私
    ]),
    ('connect', '连接', [
        (552, 559),   # 日历信号
        (561, 568),   # 音乐信号
        (570, 577),   # 位置信号
        (579, 602),   # 智能家居
    ]),
]

# ---- 块内折叠：这些行区间折进 <details>（块外的其余部分留在主级）----
FOLDS = {
    (276, 296): [(283, 284), (292, 293)],   # 待机：微注视 / 自主动作 / 热键
    (298, 313): [(308, 310)],               # 想一下：三个频率数字
    (315, 347): [(335, 340)],               # 语音：情绪映射 / 语气音
    (349, 366): [(354, 363)],               # 语音输入：离线模型与下载
    (395, 436): [(408, 417), (424, 425)],   # 记忆档案：本机模型 / 自动压缩
    (438, 458): [(442, 451)],               # 隐私：独处活动落盘
    (497, 514): [(505, 509)],               # 她留下的东西：外部目录说明
    (516, 530): [(525, 526)],               # 不完美：低气压 / 修复
}
# 整块折叠（连标题一起进 details）
WHOLE_FOLD = {(474, 491), (493, 495)}

SUMMARY = '高级 · 一般不用动'


def wrap_details(inner):
    return [
        '        <details class="sp-adv">',
        '          <summary>%s</summary>' % SUMMARY,
        '          <div class="sp-adv-body">',
    ] + inner + [
        '          </div>',
        '        </details>',
    ]


def render_block(span):
    start, end = span
    if span in WHOLE_FOLD:
        return wrap_details(lines[start - 1:end])
    folds = FOLDS.get(span, [])
    out = []
    i = start
    while i <= end:
        hit = None
        for f in folds:
            if f[0] == i:
                hit = f
                break
        if hit:
            out += wrap_details(lines[hit[0] - 1:hit[1]])
            i = hit[1] + 1
        else:
            out.append(lines[i - 1])
            i += 1
    return out


# ---- 组装 ----
head = lines[0:226]          # 1..226，含 <div class="sp-body">
tail = lines[602:]           # 603..626，从 </div>(sp-body 关) 起

nav = ['      <nav class="sp-nav">']
for idx, (key, label, _) in enumerate(GROUPS):
    active = ' is-active' if idx == 0 else ''
    nav.append('        <button class="sp-nav-item%s" data-group="%s">%s</button>' % (active, key, label))
nav.append('      </nav>')

body = []
for key, label, spans in GROUPS:
    active = ' is-active' if key == GROUPS[0][0] else ''
    body.append('        <section class="sp-group%s" data-group="%s">' % (active, key))
    for sp in spans:
        body += render_block(sp)
    body.append('        </section>')

new = head + nav + body + tail

# ---- 覆盖检查：所有原行都必须出现，一个字都不能丢 ----
original_block = lines[226:602]
joined = '\n'.join(new)
missing = [l for l in original_block if l.strip() and l not in joined]
if missing:
    raise SystemExit('有 %d 行没进新文件，中止：\n%s' % (len(missing), '\n'.join(missing[:10])))

shutil.copyfile(SRC, BAK)
io.open(SRC, 'w', encoding='utf-8').write('\n'.join(new))
print('备份:', BAK)
print('新文件行数:', len(new))
print('覆盖检查: 原 227-602 行全部保留 (%d 行)' % len(original_block))
