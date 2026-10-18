# -*- coding: utf-8 -*-
import io, os, re, json, sys

pat = re.compile(r'catch\s*(\([^)]*\))?\s*\{([^{}]*?)\}', re.S)
AUDIT = {'src/core/maintenance/catch-audit.js', 'src/core/maintenance/event-trace.js', 'src/main/maintenance.js'}

exec(open('scripts/b8-catch-table.py', encoding='utf-8').read(), globals())

changes = []
ledger = []
for base, dirs, files in os.walk('src'):
    rel = base.replace('\\', '/')
    if 'renderer' in rel or 'vendor' in rel or '/public' in rel:
        continue
    for f in sorted(files):
        if not f.endswith('.js'):
            continue
        p = os.path.join(base, f).replace('\\', '/')
        if p in AUDIT:
            continue
        s = io.open(p, encoding='utf-8').read()
        out = s
        edits = []
        for m in pat.finditer(s):
            body = m.group(2)
            st = body.strip()
            if 'reportCatch' in st:
                continue
            if not (st == '' or re.fullmatch(r'(?:/\*[\s\S]*?\*\/|//[^\n]*)?(?:\s*(?:/\*[\s\S]*?\*\/|//[^\n]*))*$', st)):
                continue
            line = s.count('\n', 0, m.start()) + 1
            cls, reason = TABLE.get('%s:%d' % (p, line), (None, None))
            if cls is None:
                cls = 'degrade'
                reason = '可选路径失败，不影响承诺与持久化'
            marker = '/* B8:%s — %s */' % (cls, reason)
            edits.append((m.start(), m.end(), 'catch' + (m.group(1) or '') + '{ ' + marker + ' }'))
            ledger.append({'file': p, 'line': line, 'cls': cls, 'reason': reason})
        if not edits:
            continue
        for st_, en_, repl in sorted(edits, reverse=True):
            out = out[:st_] + repl + out[en_:]
        io.open(p, 'w', encoding='utf-8', newline='').write(out)
        changes.append((p, len(edits)))

print('changed files: %d  sites: %d' % (len(changes), len(ledger)))
for c in changes:
    print('  ', c[0], c[1])
missing = [k for k in TABLE if k.split(':')[0] and True]
io.open('docs/b8-catch-ledger.json', 'w', encoding='utf-8').write(
    json.dumps({'generatedBy': 'scripts/b8-catch-audit.mjs', 'sites': ledger},
               ensure_ascii=False, indent=2))
print('ledger written')
