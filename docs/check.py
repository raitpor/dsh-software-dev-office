#!/usr/bin/env python3
"""docs/ 的漂移检查器（防漂移的机械部分）。

用法：python3 docs/check.py                 # 任意目录下跑
退出码：0 无漂移；1 有漂移（逐条打印）。

规则：
  R1 H2 编号连续（1..N）
  R2 H3 编号必须归属当前 H2，且子号连续（### 7.2 只能在 §7 里，且是第 2 个）
  R3 相对 .md 链接必须可解析
  R4 docs/README.md 必须收录 sdonew 下每一篇
  R5 不许残留占位符（{N} / TMPX / 3bis）
  R6 02 的度量行数 == 反指标配对行数 == 文案里的中文数字
  R7 若存在 lang/*.lang：两包键集必须恰好相等、占位符集合相同
  R9 关键预算常量只许出现在定义处（白名单计数）
"""
import os, re, sys, glob, collections

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
    sub = 0
    for line in s.split('\n'):
        m = re.match(r'^## (\d+)\. ', line)
        if m: cur = int(m.group(1)); sub = 0; continue
        m3 = re.match(r'^### (\d+)\.(\d+) ', line)
        if not m3: continue
        if cur is not None and int(m3.group(1)) != cur:
            bad.append(f'R2 {name}: §{cur} 里出现 ### {m3.group(1)}.{m3.group(2)}')
        sub += 1
        if int(m3.group(2)) != sub:
            bad.append(f'R2 {name}: §{cur} 的子号不连续（应为 {cur}.{sub}，实为 {m3.group(1)}.{m3.group(2)}）')
    for ph in ('{N}', '{N2}', 'TMPX', '3bis'):
        if ph in s: bad.append(f'R5 {name}: 残留占位符 {ph}')

# R1+ 标题质量：不得重复、不得含 ##、不得空节
for p in files():
    name = os.path.basename(p); s = read(p)
    hs = re.findall(r'^## (\d+)\. (.*)$', s, flags=re.M)
    titles = [t for _, t in hs]
    for t, c in collections.Counter(titles).items():
        if c > 1:
            bad.append(f'R1+ {name}: 标题重复「{t}」×{c}')
    for _, t in hs:
        if '##' in t:
            bad.append(f'R1+ {name}: 标题里含 ## 「{t}」')
    for m in re.finditer(r'^## (\d+)\. (.*)$', s, flags=re.M):
        body = s[m.end():]
        nxt = re.search(r'^## ', body, flags=re.M)
        chunk = body[:nxt.start()] if nxt else body
        if not chunk.strip():
            bad.append(f'R1+ {name}: §{m.group(1)} 是空节')

# R6+ README 的度量条数必须与 01 的文案一致
try:
    idx_txt = read(os.path.join(ROOT, 'README.md'))
    m = re.search(r'(\d+)\s*条可测度量', idx_txt)
    n01 = re.search(r'这(十[一二三四五])个数字', read(os.path.join(ROOT, '01-理论与边界.md')))
    zhmap = {'十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15}
    if m and n01 and int(m.group(1)) != zhmap.get(n01.group(1), -1):
        bad.append(f'R6+ README 说 {m.group(1)} 条度量，01 说 {zhmap.get(n01.group(1))} 条')
except Exception as e:
    bad.append(f'R6+ 校验失败：{e}')

# R10 表格行数 vs 标题里的中文数字（仅覆盖明确写了数量的标题）
ZH = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}
def zh2int(t):
    if t in ZH: return ZH[t]
    if len(t)==2 and t[0]=='十': return 10+ZH.get(t[1],0)
    if len(t)==2 and t[1]=='十': return ZH.get(t[0],0)*10
    if len(t)==3 and t[1]=='十': return ZH.get(t[0],0)*10+ZH.get(t[2],0)
    return None
for p in files():
    name = os.path.basename(p); s = read(p)
    for m in re.finditer(r'^## \d+\. (.*)$', s, flags=re.M):
        title = m.group(1)
        ms = re.findall(r'(\d+|[一二三四五六七八九十]+)\s*(个视图|个页面|张主表|张辅助表|个校验|条预算线)', title)
        if not ms: continue
        want = sum((int(a) if a.isdigit() else (zh2int(a) or 0)) for a, _ in ms)
        body = s[m.end():]
        nxt = re.search(r'^## ', body, flags=re.M)
        chunk = body[:nxt.start()] if nxt else body
        rows = [l for l in chunk.split('\n') if l.startswith('|') and not re.match(r'^\|[\s\-:|]+\|', l)]
        got = max(len(rows)-1, 0)   # 去掉表头
        if want is not None and got != want:
            bad.append(f'R10 {name}「{title}」: 表行 {got} ≠ 标题 {want}')

# R11 命名与路径的跨篇一致（禁止旧写法回流）
forbidden = {
    'v_gaps': 'view 名统一裸名（gaps）',
    'v_agents': 'view 名统一裸名（agents）',
    '.sdo-worktrees': 'worktree 路径统一 .worktrees/',
    'frontiur': '拼写 frontier',
    'freeze_two_signers': '判据名统一 independence_satisfied',
    'reuse.skipped': '旧事件名，已改为 agent.pick_declined',
}
for p in files():
    s = read(p)
    for f, why in forbidden.items():
        if f in s:
            bad.append(f'R11 {os.path.basename(p)}: 出现旧写法「{f}」（{why}）')

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
p02 = os.path.join(ROOT, '01-理论与边界.md')
s02 = read(p02)
try:
    sec = s02[s02.index('## 4.'):s02.index('## 5.')]
    mrows = len(re.findall(r'^\| \*\*([^*]+)\*\* \|', sec, flags=re.M))
    prows = len(re.findall(r'^\| ([^|*][^|]*) \| [^|]+ \|', sec[sec.index('### 4.1'):sec.index('### 4.2')], flags=re.M))
    zh = {'十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15}.get(
        (re.search(r'这(十[一二三四五])个数字', s02) or [None, None])[1], None)
    if not (mrows == prows == zh):
        bad.append(f'R6 01: 度量行 {mrows} / 配对行 {prows} / 文案 {zh} 不一致')
except (ValueError, AttributeError) as e:
    bad.append(f'R6 02: 结构不符（{e}）')

# R9 预算常量（唯一定义处，读 budgets.yaml 对账；变更日志不参与）
def count_constant(pat):
    return sum(read(p).count(pat) for p in files() if os.path.basename(p) != 'HISTORY.md')
by = os.path.join(ROOT, 'budgets.yaml')
if not os.path.exists(by):
    bad.append('R9 docs/budgets.yaml 缺失')
else:
    cur = {}
    for line in read(by).split('\n'):
        t = line.strip()
        if t.startswith('- name:'):
            cur = {'name': t.split(':', 1)[1].strip()}
        elif t.startswith('forms:'):
            raw = t.split(':', 1)[1].strip()
            raw = raw[1:-1] if raw.startswith('[') else raw
            cur['forms'] = [x.strip().strip('"').strip() for x in raw.split(',') if x.strip()]
        elif t.startswith('expect:'):
            cur['expect'] = int(re.split(r'[\s#]', t.split(':', 1)[1].strip())[0])
            for f in cur.get('forms', []):
                got = count_constant(f)
                if got != cur['expect']:
                    bad.append(f"R9 常量「{f}」({cur['name']}) 出现 {got} 次，期望 {cur['expect']}")

# R12 事件 kind 闭包：事件域的 `x.y` 必须登记在 02 的事件类型表里
#     判据 code（`perf.*` / `release.*` / `security.*` 等）与字段名不算事件，跳过。
try:
    s02k = read(os.path.join(ROOT, '02-真源-存储事件与折叠.md'))
    sec = s02k[s02k.index('## 10. 事件类型'):]
    nxt = re.search(r'^## ', sec[2:], flags=re.M)
    sec = sec[:nxt.start() + 2] if nxt else sec
    kinds = set(re.findall(r'`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`', sec))
    domains = {k.split('.')[0] for k in kinds}

    # 判据 code：任何文档中“表格首列”的 `x.y`，以及 06/09 判据小节里的
    crit = set()
    for q in files():
        for line in read(q).split('\n'):
            m = re.match(r'^\|\s*`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`', line)
            if m:
                crit.add(m.group(1))

    # 非事件命名空间（显式声明，不是“猜”）：字段、判据 code、基准、库/工具名
    non_event_ns = {'perf','security','release','metrics','bench','redact','process',
                    'claim','decision','evidence','intent','criterion','lease','baseline',
                    'state','core','adapter','artifact','contract','defect','assurance',
                    'lock','node','path','schema','semver','i18n','restore'}
    allow = {'node_modules', 'path.join', 'schema.sql', 'core.autocrlf', 'foo.ts',
             'office.ts', 'index.ts', 'semver.major', 'i18n.fallback'}
    for q in files():
        for m in re.finditer(r'`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`', read(q)):
            tok = m.group(1)
            tail = tok.split('.')[-1]
            fieldish_exact = {'id','by','hash','at','status','prefix','sha256','digest',
                              'kind','count','actor','name','type','list','set','ms','bytes',
                              'frontier','payload','signature','remedy'}
            fieldish_suffix = ('_id','_by','_hash','_at','_status','_prefix','_sha256',
                               '_digest','_kind','_count','_actor','_name','_type','_ms','_bytes')
            if tok in kinds or tok in crit or tok in allow: continue
            if tok.split('.')[0] in non_event_ns: continue
            if tail in fieldish_exact or tail.endswith(fieldish_suffix): continue
            bad.append(f'R12 {os.path.basename(q)}: 未登记的事件 kind `{tok}`（02 事件表里没有）')
except Exception as e:
    bad.append(f'R12 校验失败：{e}')

# R13 分隔线之后、下一个 H2 之前不得有正文（孤儿块）
for p in files():
    name = os.path.basename(p)
    lines = read(p).split('\n')
    for i, ln in enumerate(lines):
        if ln.strip() != '---': continue
        j = i + 1
        while j < len(lines) and not lines[j].strip(): j += 1
        if j < len(lines) and not lines[j].startswith('## ') and not lines[j].startswith('#'):
            bad.append(f'R13 {name}: 第 {i+1} 行分隔线后出现无标题正文（可能是合并残留）')

# R14 列表项不得只是分隔线
for p in files():
    name = os.path.basename(p)
    for i, ln in enumerate(read(p).split('\n')):
        if re.match(r'^\s*(\d+\.|-)\s*---\s*$', ln):
            bad.append(f'R14 {name}: 第 {i+1} 行列表项是分隔线')

if bad:
    print('✗ 发现漂移 %d 处：' % len(bad))
    for b in bad: print('   -', b)
    sys.exit(1)
print('✓ 无漂移：R1、R1+、R2、R3、R4、R6、R6+、R9、R10、R11、R12、R13、R14 全过（%d 篇）' % len(files()))
