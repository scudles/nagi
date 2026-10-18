# -*- coding: utf-8 -*-
# B8：把已标为非 degrade 的空 catch 接进 reportCatch（可见 + 可查）。
# 站点名取"模块.外层函数名"，诊断时能直接定位到人读得懂的那一行。
import io, re, json

ledger = json.load(io.open('docs/b8-catch-ledger.json', encoding='utf-8'))['sites']
todo = {}
for s in ledger:
    if s['cls'] == 'degrade':
        continue
    todo.setdefault(s['file'], []).append(s)

KEYWORDS = set('if for while switch catch try return function class new typeof await else do'.split())
FN = re.compile(r'(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)', re.M)
CLS2CONST = {'visible': 'VISIBLE', 'must-persist': 'MUST_PERSIST', 'promise': 'PROMISE', 'semantic': 'SEMANTIC'}
TAIL = re.compile(r'catch(\s*\(([^)]*)\)|\s*)\{\s*$')

def site_name(head, path):
    mod = path.rsplit('/', 1)[-1][:-3]
    for g in reversed(FN.findall(head)):
        for n in g:
            if n and n not in KEYWORDS:
                return '%s.%s' % (mod, n)
    return mod

applied = []
for path, sites in sorted(todo.items()):
    src = io.open(path, encoding='utf-8').read()
    if 'CATCH_CLASS' not in src:
        nslash = path.count('/')
        if path.startswith('src/main/'):
            imp = '../' * (nslash - 1) + 'maintenance.js'
        else:
            imp = ('../' * (nslash - 2) or './') + 'maintenance/reporter.js'
        line = "import { reportCatch, CATCH_CLASS } from '%s'\n" % imp
        m = re.search(r'^import .*?$\n', src, re.M)
        src = (src[:m.end()] + line + src[m.end():]) if m else (line + src)

    sites = sorted(sites, key=lambda s: s['line'])
    # 按 (cls, reason) 分组：同一句话标记出现几次就处理几次，避免串组
    groups = {}
    for s in sites:
        groups.setdefault((s['cls'], s['reason']), []).append(s)
    for (cls, reason), group in groups.items():
        marker = '/* B8:%s — %s */' % (cls, reason)
        parts = src.split(marker)
        if len(parts) - 1 != len(group):
            print('  !! %s 标记出现 %d 次但台账有 %d 条（%s）' % (path, len(parts) - 1, len(group), reason))
        out = ''
        for i, s2 in enumerate(group):
            prev = parts[i]
            mt = TAIL.search(prev)
            if mt:
                bind = mt.group(2)
                head = prev if bind else prev[:mt.start()] + 'catch (__err) {'
                bind = bind or '__err'
            else:
                print('  !! 找不到 catch 头部', path, s2['line'])
                head, bind = prev, '__err'
            site = site_name(head, path)
            newp = "{ reportCatch('%s', CATCH_CLASS.%s, %s) }" % (site, CLS2CONST[cls], bind)
            out += head + newp
            applied.append((path, site, cls))
        out += ''.join(parts[len(group):])
        src = out
    io.open(path, 'w', encoding='utf-8', newline='').write(src)

print('接线 %d 处' % len(applied))
for a in applied:
    print('   %-34s %-12s %s' % (a[1], a[2], a[0]))
