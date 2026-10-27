#!/usr/bin/env python3
"""docs/ 的漂移检查器（防漂移的机械部分）。

用法：python3 docs/check.py                 # 任意目录下跑
退出码：0 无漂移；1 有漂移（逐条打印）。

规则：
  R1 H2 编号连续（1..N）
  R2 H3 编号必须归属当前 H2（### 7.2 只能在 §7 里）
  R3 相对 .md 链接必须可解析
  R4 docs/README.md 必须收录 sdonew 下每一篇
  R5 不许残留占位符（{N} / TMPX / 3bis）
  R6 02 的度量行数 == 反指标配对行数 == 文案里的中文数字
  R7 若存在 lang/*.lang：两包键集必须恰好相等、占位符集合相同
  R9 关键预算常量只许出现在定义处（白名单计数）
"""
import os, re, sys, glob

ROOT = os.path.dirname(os.path.abspath(__file__))                  # docs/
bad = []

def files():
    return sorted(glob.glob(os.path.join(ROOT, '*.md')))

def read(p):
    return open(p, encoding='utf-8').read()

# R1/R2/R5
for p in files():
    name = os.path.basename(p); s = read(p)
    h2 = [int(m.group(1)) for m in re.finditer(r'^## (\d+)\. ', s, flags=re.M)]
    if h2 and h2 != list(range(1, len(h2)+1)):
        bad.append(f'R1 {name}: H2 编号不连续 {h2}')
    cur = None
    for line in s.split('\n'):
        m = re.match(r'^## (\d+)\. ', line)
        if m: cur = int(m.group(1)); continue
        m3 = re.match(r'^### (\d+)\.(\d+) ', line)
        if m3 and cur is not None and int(m3.group(1)) != cur:
            bad.append(f'R2 {name}: §{cur} 里出现 ### {m3.group(1)}.{m3.group(2)}')
    for ph in ('{N}', '{N2}', 'TMPX', '3bis'):
        if ph in s: bad.append(f'R5 {name}: 残留占位符 {ph}')

# R3
for p in files():
    for m in re.finditer(r'\]\(([^)#]+\.md)\)', read(p)):
        t = os.path.normpath(os.path.join(ROOT, m.group(1)))
        if not os.path.exists(t):
            bad.append(f'R3 {os.path.basename(p)}: 断链 {m.group(1)}')

# R4
idx_path = os.path.join(ROOT, 'README.md')
if os.path.exists(idx_path):
    idx = read(idx_path)
    for p in files():
        name = os.path.basename(p)
        if name == 'README.md': continue
        if f']({name})' not in idx:
            bad.append(f'R4 {name}: 未被 docs/README.md 索引（缺 ]({name})）')
else:
    bad.append('R4 docs/README.md 不存在')

# R6
p02 = os.path.join(ROOT, '02-总览与边界.md')
s02 = read(p02)
try:
    sec = s02[s02.index('## 4.'):s02.index('## 5.')]
    mrows = len(re.findall(r'^\| \*\*([^*]+)\*\* \|', sec, flags=re.M))
    prows = len(re.findall(r'^\| ([^|*][^|]*) \| [^|]+ \|', sec[sec.index('### 4.1'):sec.index('### 4.2')], flags=re.M))
    zh = {'十一': 11, '十二': 12, '十三': 13, '十四': 14}.get(
        (re.search(r'这(十[一二三四])个数字', s02) or [None, None])[1], None)
    if not (mrows == prows == zh):
        bad.append(f'R6 02: 度量行 {mrows} / 配对行 {prows} / 文案 {zh} 不一致')
except (ValueError, AttributeError) as e:
    bad.append(f'R6 02: 结构不符（{e}）')

# R7
langs = sorted(glob.glob(os.path.join(ROOT, 'lang', '*.lang')))
if len(langs) >= 2:
    def keys(p):
        ks, ph = {}, {}
        for line in read(p).split('\n'):
            line = line.strip()
            if not line or line.startswith('#'): continue
            if '=' not in line: continue
            k, v = line.split('=', 1)
            ks[k.strip()] = v.strip()
            ph[k.strip()] = set(re.findall(r'\{p\d+\}', v))
        return ks, ph
    base_k, base_ph = keys(langs[0])
    for p in langs[1:]:
        k, ph = keys(p)
        miss, extra = set(base_k) - set(k), set(k) - set(base_k)
        if miss or extra:
            bad.append(f'R7 {os.path.basename(p)}: 键集不相等（少 {sorted(miss)[:3]} 多 {sorted(extra)[:3]}）')
        for key in set(k) & set(base_k):
            if ph[key] != base_ph[key]:
                bad.append(f'R7 {os.path.basename(p)}: {key} 的占位符不一致')

# R9
def count(pat):
    # 变更日志会合法引用历史数值，不参与 R9
    return sum(read(p).count(pat) for p in files() if os.path.basename(p) != 'HISTORY.md')
checks = [
    ('1500 字符', 2),   # 定义（06）+ 历史引用（01）
    ('8 KB', 1),
    ('< 50 ms', 1),
    ('< 10 ms', 1),
    ('< 5 s', 1),
    ('≤ 500', 1),
    ('240 字符', 1),
]
for pat, want in checks:
    got = count(pat)
    if got != want:
        bad.append(f'R9 常量「{pat}」出现 {got} 次，期望 {want}')

if bad:
    print('✗ 发现漂移 %d 处：' % len(bad))
    for b in bad: print('   -', b)
    sys.exit(1)
print('✓ 无漂移：R1–R7、R9 全过（%d 篇）' % len(files()))
