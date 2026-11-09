#!/usr/bin/env python3
"""design/ 的机器校验（不是 docs/check.py 的替代）。

规则（R0a–R0d + R19–R34）：
  R0a 文档引用的图片都存在；
  R0b 每个 `.puml` / `.dot` 都有对应的 `.svg` 与 `.png`；
  R0c 图与**文档**里出现的事件 kind 都在 `docs/02` 的登记表里（只读登记表，不抓全篇反引号）；
  R0d `design/01` 模块表里的模块，都在组件图里有对应 component；
  R19 产物等于 `build.py` 重建结果（在临时目录重建后逐字节比对）；
  R20 标题编号：`## N.` 严格递增、`### N.M.` 的 N 必须等于当前章号、M 严格递增；
  R21 状态图的状态集合与 `docs/` 的状态枚举逐项一致（双向，多一个少一个都算漂移）；
  R22 组件图分层依赖：L3→L2→L1→L0/端口，L1 不得直连实现（VCS/DB/signerd）；
  R23 计数一致：`N 张表` / `N 张图` / `N 条判据` 与真实数量相等（跨 docs/design/probe）；
  R24 P3 无旁路边（四道校验必须串联）；
  R25 不变量矩阵的守卫点可落地（类/模块/03 P 号，Class.method 必须存在），表约束行写具体约束名；
  R26 模块依赖列 → 组件图必须有对应边（store→DBPort、vcs→VcsPort，core 不查）；
  R27 每个登记事件要么在 design 里有生产者，要么在 EXTERNAL_EVENTS 里逐条点名；
  R28 §17.1 的执行点表必须与正文对得上：`P2` 的判据要在 P2 正文里、`02 矩阵` 的要在矩阵里，24 条一个不少。
  R29 三个 preset 的 gate 目录必须真的能冻出「三条保证全保持」：按 docs/04 的 guarantee 与
      applies_to 复算有效绑定（all_of + 不可豁免 + stage 适用），core 三条也必须有效绑定；
  R30 每个过程（P1–P15）都必须在 03 §17 表里有模块归属，且名字在 01 模块表里；
  R31 顺序图里**实线**的 L1→L1 调用必须在源模块依赖列里登记（虚线 `-->` 是返回，不算）。
      *已知边界*：L2 编排层 `handlers` 的依赖写作「L1 服务」（刻意抽象），L2→L1 不做逐边校验。
  R32 已废弃的判据句式不许留在实现面（docs/ 与 design/01–03）：出现「仍为 open 的假设都必须已被…」这类
      旧谓词即红——它把 freshness 漏了，改一处不改别处就会把洞重开。

退出码：0 通过；1 有漂移。
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
DIA = os.path.join(DESIGN, "diagrams")

bad: list[str] = []


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def read_doc(name: str) -> str:
    return read(os.path.join(DOCS, name))


def diagram_sources() -> dict[str, str]:
    return {
        n: read(os.path.join(DIA, n))
        for n in sorted(os.listdir(DIA))
        if n.endswith((".puml", ".dot"))
    }


def md_files() -> list[str]:
    return sorted(n for n in os.listdir(DESIGN) if n.endswith(".md"))


# ---------- R0a 图片引用存在 ----------
for name in md_files():
    text = read(os.path.join(DESIGN, name))
    for ref in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text):
        if not os.path.exists(os.path.normpath(os.path.join(DESIGN, ref))):
            bad.append(f"[R0a] 图片缺失：{name} → {ref}")

# ---------- R0b 源文件都有产物 ----------
for name in os.listdir(DIA):
    base, ext = os.path.splitext(name)
    if ext in (".puml", ".dot"):
        for out in (".svg", ".png"):
            if not os.path.exists(os.path.join(DIA, base + out)):
                bad.append(f"[R0b] 产物缺失：{base}{out}（源 {name}）")

# ---------- R0c 事件 kind 闭包（文档 + 图，只读登记表） ----------
DOC02 = read_doc("02-真源-存储事件与折叠.md")
start = DOC02.find("| 域 | kind | 何时写 |")
end = DOC02.find("**明确不许进事件流的**", start)
registry_block = DOC02[start:end] if start != -1 and end != -1 else ""
if not registry_block:
    bad.append("[R0c] docs/02 找不到事件登记表（表头 `| 域 | kind | 何时写 |`）")
registered = set(re.findall(r"`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`", registry_block))

# 判据 code 不是事件（`stage.gate_bound`、`release.gaps_match` 这类）——从 docs 的判据表里抓
criteria: set[str] = set()
for doc_name in os.listdir(DOCS):
    if doc_name.endswith(".md"):
        criteria |= set(re.findall(r"^\| `([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)` \|",
                                   read_doc(doc_name), flags=re.M))
# 字段 / 方法 / 错误码，长得像事件但不是
NON_EVENTS = {
    "intent.baseline_hash", "intent.strength", "spec.content_hash", "spec.kind", "spec.risk_flags",
    "event.kind", "release.freeze", "admission.evaluate", "criterion.spec_id", "work_unit.id",
    "baseline.hash", "decision.signature", "lease.actor", "lease.expires_at",
    "snapshot.git_oid", "decision.frontier", "task.status", "agent.watermark",
    "task.inputs", "intent.source_text", "spec.alternatives", "restatement.draft_specs",
}
EVENT_PREFIX = {
    "intent", "spec", "task", "goal", "report", "attention", "workcopy", "snapshot",
    "evidence", "review", "criterion", "gate", "stage", "release", "decision", "actor",
    "auth", "schema", "backup", "restore", "verify", "store", "lock", "lease", "agent",
    "change", "node", "act", "baseline", "boundary", "admission", "orphan", "redaction", "i18n",
}


def scan_events(text: str, where: str) -> None:
    for tok in set(re.findall(r"\b([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\b", text)):
        if tok.split(".")[0] not in EVENT_PREFIX:
            continue
        if tok in registered or tok in criteria or tok in NON_EVENTS:
            continue
        if tok.rsplit(".", 1)[-1] in {"png", "puml", "dot", "svg", "md", "py", "jsonl"}:
            continue
        bad.append(f"[R0c] 事件 kind 未登记：{where} → {tok}")


for name, text in diagram_sources().items():
    scan_events(text, name)
for name in md_files():
    scan_events(read(os.path.join(DESIGN, name)), name)

# ---------- R0d 模块表 ↔ 组件图 ----------
module_doc = read(os.path.join(DESIGN, "01-结构化设计.md"))
mods = set(re.findall(r"^\| \*\*([a-z][a-z0-9_]*)\*\*", module_doc, flags=re.M))
arch = diagram_sources().get("arch-components.puml", "")
comps = set(re.findall(r'component "([a-z][a-z0-9_]*)"', arch))
comps_for_depths = comps | set(re.findall(r'(?:component|node)\s+"[^"]+"\s+as\s+(\w+)', arch))
labels = set(re.findall(r'(?:component|node)\s+"([^"]+)"', arch))
# 两个模块在图上不叫模块名，而是"承载它的进程/对象"；仍然必须出现在图里，不许无声跳过
MODULE_LABEL = {"store": "stored", "vcs": "内嵌 git 对象库"}
for m in sorted(mods - comps):
    if m in MODULE_LABEL and any(MODULE_LABEL[m] in lb for lb in labels):
        continue
    bad.append(f"[R0d] 模块未进组件图：{m}")
for c in sorted(comps - mods):
    bad.append(f"[R0d] 组件不在模块表：{c}")

# ---------- R19 产物 == build.py 重建结果 ----------
proc = subprocess.run([sys.executable, os.path.join(DIA, "build.py"), "--check"],
                      capture_output=True, text=True)
if proc.returncode != 0:
    bad.append("[R19] 图产物与模板不一致：\n" + (proc.stdout + proc.stderr).strip())

# ---------- R20 标题编号 ----------
for name in md_files():
    chapter = 0
    section = 0
    for lineno, line in enumerate(read(os.path.join(DESIGN, name)).splitlines(), 1):
        m = re.match(r"^## (\d+)\.\s", line)
        if m:
            n = int(m.group(1))
            if n != chapter + 1:
                bad.append(f"[R20] {name}:{lineno} 章号应为 {chapter + 1}，实际 {n}")
            chapter, section = n, 0
            continue
        m = re.match(r"^### (\d+)\.(\d+)\s", line)
        if m:
            c, s = int(m.group(1)), int(m.group(2))
            if c != chapter:
                bad.append(f"[R20] {name}:{lineno} 节号 {c}.{s} 不属于当前第 {chapter} 章")
            elif s != section + 1:
                bad.append(f"[R20] {name}:{lineno} 节号应为 {c}.{section + 1}，实际 {c}.{s}")
            section = s

# ---------- R21 状态集合双向一致 ----------
# 每张状态图对应 docs/ 的一处枚举；两处都必须逐项相等（多一个/少一个都红）。
STATE_SOURCES: dict[str, tuple[set[str], str, str]] = {
    "uml-state-task": ({"planned", "ready", "in_progress", "blocked", "done", "dropped"},
                       "03-链条-意图到声明.md", r"\*\*task\*\*：`([^`]+)`"),
    "uml-state-intent": ({"draft", "proposed", "signed", "superseded"},
                         "03-链条-意图到声明.md", r"\*\*intent\*\*：`([^`]+)`"),
    "uml-state-spec": ({"defined", "revised"},
                       "03-链条-意图到声明.md", r"\*\*spec\*\*：`([^`]+)`"),
    "uml-state-criterion": ({"draft", "active", "retired"},
                            "03-链条-意图到声明.md", r"\*\*criterion\*\*：`([^`]+)`"),
    "uml-state-agent": ({"idle", "busy", "compacting", "parked", "dead"},
                        "12-代理池与生命周期.md", r"state\s+TEXT NOT NULL,\s*--\s*([^\n]+)"),
    "uml-state-release": ({"draft", "frozen", "delivered", "rolled_back"},
                          "09-交付与迁移.md", r"status\s+TEXT NOT NULL,\s*--\s*([^\n]+)"),
    "uml-state-stagerun": ({"running", "closed"},
                           "03-链条-意图到声明.md", r"\*\*stage_run\*\*：`([^`]+)`"),
    "uml-state-review": ({"open", "closed"},
                         "03-链条-意图到声明.md", r"\*\*review_round\*\*：`([^`]+)`"),
    "uml-state-assumption": ({"open", "confirmed", "rejected", "converted"},
                             "03-链条-意图到声明.md", r"\*\*状态图\*\*：`([^`]+)`"),
}
for f in sorted(os.listdir(DIA)):
    if f.startswith("uml-state-") and f.endswith(".puml") and f[:-5] not in STATE_SOURCES:
        bad.append(f"[R21] 状态图 {f} 没在 STATE_SOURCES 里登记（新增状态图必须同时给出 docs 枚举）")

for name, (expected, doc, pattern) in STATE_SOURCES.items():
    path = os.path.join(DIA, name + ".puml")
    if not os.path.exists(path):
        bad.append(f"[R21] 状态图缺失：{name}.puml")
        continue
    text = read(path)
    got: set[str] = set()
    for a, b in re.findall(r"^\s*(\S+)\s*-->\s*(\S+?)(?:\s*:|$)", text, flags=re.M):
        for s in (a, b):
            if s != "[*]":
                got.add(s)
    if got != expected:
        extra, missing = sorted(got - expected), sorted(expected - got)
        bad.append(f"[R21] {name}.puml 状态集不一致：多 {extra}，少 {missing}")
    if doc and pattern:
        m = re.search(pattern, read_doc(doc))
        if not m:
            bad.append(f"[R21] 在 {doc} 找不到状态枚举（模式 {pattern}），无法双向核对")
        else:
            doc_states = set()
            for seg in re.split(r"[→|]", m.group(1)):
                word = re.match(r"[^a-zA-Z_]*([a-z_]+)", seg)
                if word:
                    doc_states.add(word.group(1))
            if doc_states != expected:
                bad.append(f"[R21] {doc} 的状态枚举与 {name} 期望值不一致：{sorted(doc_states)}")
            # R34：迁移串里写了的边，图里必须有（状态集合一致 ≠ 边一致）
            # 串的写法：`A → B → C` 是连续迁移；一个位置写 `B | C` 表示同一源的多条目标；`…` 跳过
            chain = m.group(1)
            if "→" in chain:
                tokens = [t.strip() for t in chain.split("→")]
                alts: list[set[str]] = []
                for t in tokens:
                    names = set()
                    for piece in t.split("|"):
                        mm = re.match(r"[^a-zA-Z_]*([a-z_]+)", piece)
                        if mm:
                            names.add(mm.group(1))
                    alts.append(names)
                want_edges: set[tuple[str, str]] = set()
                for a_set, b_set in zip(alts, alts[1:]):
                    for a in a_set:
                        for b in b_set:
                            if a != b:
                                want_edges.add((a, b))
                got_edges = set(re.findall(r"^\s*([a-z_]+)\s*-->\s*([a-z_]+)", text, flags=re.M))
                for a, b in sorted(want_edges - got_edges):
                    bad.append(f"[R34] {name}.puml 缺迁移边 {a} --> {b}"
                               f"（docs 迁移串写了、图里没有）")
# ---------- R22 分层依赖白名单 ----------
if arch:
    layer: dict[str, str] = {}
    current = ""
    depth = 0
    for line in arch.splitlines():
        if depth and line.strip() == "}":
            depth = 0
            current = ""
            continue
        pm = re.match(r'\s*package\s+"([^"]+)"\s*\{', line)
        if pm:
            depth = 1
            label = pm.group(1)
            current = ("PORT" if "端口" in label
                       else "L3" if "L3" in label else "L2" if "L2" in label
                       else "L1" if "L1" in label else "L0" if "L0" in label
                       else "OTHER")
            continue
        em = re.match(r'\s*(?:component|node|database|queue)\s+"[^"]+"\s+as\s+(\w+)', line)
        if em:
            layer[em.group(1)] = current if depth else "EXTERNAL"
    allowed = {("L3", "L2"), ("L2", "L1"), ("L1", "L0"), ("L1", "PORT"),
               ("L1", "L1"), ("PORT", "EXTERNAL"), ("EXTERNAL", "EXTERNAL"), ("L0", "L0")}
    for a, b in re.findall(r"^\s*(\w+)\s*-->\s*(\w+)\s*$", arch, flags=re.M):
        la, lb = layer.get(a, "?"), layer.get(b, "?")
        if (la, lb) not in allowed:
            bad.append(f"[R22] 越层依赖：{a}({la}) --> {b}({lb})；L1 只能连 L0 与端口（同层互调除外）")

# ---------- R23 计数一致 ----------
schema = read(os.path.join(ROOT, "probe", "schema.sql"))
n_tables = len(re.findall(r"^\s*CREATE TABLE", schema, flags=re.M | re.I))
n_diagrams = len(diagram_sources())
doc04 = read_doc("04-判据-门禁与负例.md")
s4 = doc04.find("| 判据 code |")
s4_end = doc04.find("### 4.1", s4)
n_criteria = len(re.findall(r"^\| `[a-z][a-z0-9_.]*` \|", doc04[s4:s4_end], flags=re.M))

checks = [
    (r"(\d+)\s*张(?:设计)?表", n_tables, "张表"),
    (r"(\d+)\s*张图", n_diagrams, "张图"),
    # 只核对"当前这套阶段判据"的说法；v1 的 68 条、散句里的"一条判据"不在其列
    (r"(\d+)\s*条阶段判据", n_criteria, "条阶段判据"),
]
for folder in ("docs", "design", "probe"):
    for name in sorted(os.listdir(os.path.join(ROOT, folder))):
        if not name.endswith(".md"):
            continue
        text = read(os.path.join(ROOT, folder, name))
        for pattern, real, unit in checks:
            for m in re.finditer(pattern, text):
                claimed = int(m.group(1))
                if claimed != real:
                    bad.append(f"[R23] {folder}/{name} 写 {claimed} {unit}，实际 {real}")

# ---------- R24 P3 无旁路边 ----------
p3 = diagram_sources().get("p3-two-phase-pad.dot", "")
if p3:
    # 校验链的顺序（与 docs/11 §9 的四行一致）：payload → frontier → grant/scope → baseline → 不变量 → will_change → 事务
    chain = ["s2", "s3", "s3g", "s3h", "s3ha", "s35", "s4", "s51", "s5"]
    edges = set(re.findall(r"\b(\w+)\s*->\s*(\w+)\b", p3))
    for i, a in enumerate(chain[:-1]):
        if (a, chain[i + 1]) not in edges:
            bad.append(f"[R24] P3 缺串联边 {a}->{chain[i + 1]}")
    for a, b in edges:
        if a in chain and b in chain:
            i = chain.index(a)
            if b != chain[i + 1]:
                bad.append(f"[R24] P3 出现旁路边 {a}->{b}：校验必须逐环串联，不能绕")

# ---------- R25 不变量矩阵的守卫点必须可落地 ----------
oom = read(os.path.join(DESIGN, "02-面向对象模型.md"))
class_puml = diagram_sources().get("uml-class.puml", "")
classes = set(re.findall(r"^class (\w+)", class_puml, flags=re.M))
methods: dict[str, set[str]] = {}
for m in re.finditer(r"^class (\w+) \{(.*?)^\}", class_puml, flags=re.M | re.S):
    methods[m.group(1)] = set(re.findall(r"^\s*[+\-~#]\s*(\w+)\s*\(", m.group(2), flags=re.M))
matrix_start = oom.find("| 不变量 | 唯一守卫点 |")
matrix_end = oom.find("## 6.", matrix_start)
matrix_rows = 0
seen_invariants: set[str] = set()
for line in oom[matrix_start:matrix_end].splitlines():
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) != 4 or not cells[1] or "---" in cells[0]:
        continue
    invariant, guard, audit, kind = cells
    matrix_rows += 1
    if invariant in seen_invariants:
        bad.append(f"[R25] 矩阵出现重复不变量：{invariant}")
    seen_invariants.add(invariant)
    if re.search(r"[+/]", guard):
        bad.append(f"[R25] 一行写了多个守卫点：{invariant} → {guard}（拆成多行，或只留真正拦得住的那个）")
    if "verify" in guard.lower():
        bad.append(f"[R25] 守卫点写了 verify：{guard}——verify 是事后对账，不是守卫，应放进“审计”列")
    if "领域" in kind:
        words = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", guard))
        cited = re.search(r"03\s*P\d+|P\d+", guard)
        if not (words & classes) and not (words & mods) and not cited:
            bad.append(f"[R25] 矩阵守卫点不可落地：{guard}（不在类图、不是模块、也没引 03 的 P 号）")
        for cls, meth in re.findall(r"\b([A-Z]\w*)\.(\w+)", guard):
            if cls not in classes:
                bad.append(f"[R25] 矩阵守卫点引用了不存在的类：{cls}.{meth}")
            elif meth not in methods.get(cls, set()):
                bad.append(f"[R25] 矩阵守卫点引用了不存在的方法：{cls}.{meth}")
    elif "表约束" in kind:
        if not re.search(r"UNIQUE|外键|CHECK|NOT NULL", guard):
            bad.append(f"[R25] 矩阵守卫点声明为表约束但没写具体约束：{guard}")
if matrix_rows < 20:
    bad.append(f"[R25] 不变量矩阵只有 {matrix_rows} 行，疑似被合并回'一行多不变量'")

# ---------- R26 模块依赖列 ↔ 组件图（双向） ----------
# `store`/`vcs` 依赖落到端口（DBPort/VcsPort），`core` 是隐含基座不画全，`ports(...)` 单列。
DEP_ALIAS = {"store": "DBPort", "vcs": "VcsPort", "handlers": "h", "execution": "exec",
             "query": "q", "views": "views", "alignment": "align"}
PORT_DEP = {"DBPort": "store", "VcsPort": "vcs", "SignerPort": "signer"}


def module_rows(doc: str):
    for line in doc.splitlines():
        m = re.match(r"^\| \*\*([a-z][a-z0-9_]*)\*\* \|[^|]*\| ([^|]*) \|", line)
        if m:
            yield m.group(1), m.group(2)


if arch:
    edges = set(re.findall(r"^\s*(\w+)\s*-->\s*(\w+)\s*$", arch, flags=re.M))
    known_targets = comps_for_depths | set(DEP_ALIAS.values()) | {"DBPort", "VcsPort", "SignerPort"}
    for mod, deps in module_rows(module_doc):
        if mod == "handlers":
            # 刻意抽象的 L2 编排层：依赖写作「L1 服务」，不逐条枚举（见 design/01 §3）
            continue
        for raw in deps.split(","):
            dep = raw.replace("**", "").replace("`", "").replace("L1 服务", "").replace("L2 ", "").strip()
            if not dep or dep == "core" or dep.startswith("ports(") or dep == "无":
                continue
            target = DEP_ALIAS.get(dep, dep)
            if target not in known_targets:
                bad.append(f"[R26] 依赖列写了未知模块/端口：{mod} -> {dep}（拼错？或没在组件图/别名表里）")
                continue
            source = DEP_ALIAS.get(mod, mod)
            if (source, target) not in edges:
                bad.append(f"[R26] 依赖列写了 {dep}，组件图缺边 {mod}->{target}")
    # 反向：图里画了模块→端口，依赖列必须写出对应能力
    for mod, deps in module_rows(module_doc):
        deps_text = deps.replace("**", "").replace("`", "")
        source = DEP_ALIAS.get(mod, mod)
        for port, capability in PORT_DEP.items():
            if (source, port) in edges and capability not in deps_text:
                bad.append(f"[R26] 组件图有 {mod}->{port}，依赖列却没写 {capability}（图与表必有一边错）")

# ---------- R27 每个登记事件要么有生产者，要么显式登记为"过程外" ----------
# 只认"过程侧"的出处：03（过程逻辑）+ 图（状态图/顺序图/流程图）。
# 散文里提一句"消费了 X"不算有生产者。
EXTERNAL_EVENTS = {
    "actor.enrolled": "sign", "auth.login": "sign", "auth.unlock": "sign", "auth.failed": "sign",
    "store.unlocked": "store", "store.open_suspected": "store",
    "schema.migrated": "store", "backup.taken": "store", "restore.done": "store",
    "agent.spawned": "dispatch", "agent.reused": "dispatch", "agent.pick_declined": "dispatch",
    "agent.compaction_attempted": "dispatch", "agent.report_compaction": "dispatch",
    "agent.parked": "dispatch", "agent.retired": "dispatch", "agent.handoff": "dispatch",
    "lock.acquired": "dispatch", "lock.released": "dispatch",
    "lease.issued": "dispatch", "lease.expired": "dispatch",
    "workcopy.created": "dispatch", "workcopy.removed": "dispatch",
    "change.proposed": "workflow", "change.applied": "workflow",
    "node.reset": "workflow", "act.cancelled": "workflow",
    "goal.declared": "workflow", "goal.integrated": "workflow", "goal.reparented": "workflow",
    "intent.proposed": "workflow", "intent.signed": "workflow",
    "spec.defined": "workflow", "contract.defined": "workflow", "scope.declared": "workflow",
    "design.locked": "workflow", "criterion.revised": "criteria",
    "restatement.recorded": "workflow", "restatement.diff_dispositioned": "workflow",
    "restatement.invalidated": "workflow",
    "task.created": "execution", "task.dropped": "execution", "orphan.expired": "dispatch",
    "snapshot.taken": "vcs",
    "redteam.recorded": "review", "redteam.disposed": "review",
    # baseline.frozen / amended / loosened 已在 P15 正文里有生产者（收紧/放宽都建新行），不再登记为过程外
    "decision.revoked": "sign", "redaction.applied": "store", "i18n.fallback": "store",
    "attention.answered": "execution",
}
producer_text = read(os.path.join(DESIGN, "03-过程逻辑.md")) + "".join(diagram_sources().values())
for kind in sorted(registered):
    if kind in producer_text:
        continue
    if kind in EXTERNAL_EVENTS:
        owner = EXTERNAL_EVENTS[kind]
        if owner not in mods:
            bad.append(f"[R27] {kind} 的登记生产者 {owner} 不在模块表里")
        continue
    bad.append(f"[R27] 事件 {kind} 在 03/图里没有生产者，也没登记为过程外（docs/02 有、design 无人写）")

# ---------- R28 §17.1 的"执行点"必须与实际正文对得上 ----------
doc04 = read_doc("04-判据-门禁与负例.md")
s4 = doc04[doc04.find("| 判据 code |"):doc04.find("### 4.1")]
criteria_codes = set(re.findall(r"^\| `([a-z][a-z0-9_.]*)` \|", s4, flags=re.M))
d03 = read(os.path.join(DESIGN, "03-过程逻辑.md"))
d02 = read(os.path.join(DESIGN, "02-面向对象模型.md"))

map_start = d03.find("### 17.1")
if map_start == -1:
    bad.append("[R28] design/03 找不到 ### 17.1（判据落点表改名了？检查器要跟着改）")
    map_sec = ""
else:
    nxt = re.search(r"\n## \d+\. ", d03[map_start + 10:])
    map_sec = d03[map_start:map_start + 10 + nxt.start()] if nxt else d03[map_start:]

# P2 正文：从 "## 3. P2" 到下一个二级标题
p2 = re.search(r"\n## \d+\. P2[^\n]*\n(.*?)(?=\n## \d+\. )", d03, flags=re.S)
p2_text = p2.group(1) if p2 else ""

claimed = set()
for line in map_sec.splitlines():
    m = re.match(r"^\| ([^|]+?) \| (P2|02 矩阵) \|", line)
    if not m:
        continue
    codes = re.findall(r"`([a-z][a-z0-9_.]*)`", m.group(1))
    target, body = m.group(2), (p2_text if m.group(2) == "P2" else d02)
    for c in codes:
        claimed.add(c)
        if c not in criteria_codes:
            bad.append(f"[R28] §17.1 写了 docs/04 里没有的判据 {c}")
        elif c not in body:
            bad.append(f"[R28] {c} 声称执行点是 {target}，但那儿找不到它"
                       f"（表里写的和正文对不上）")
for c in sorted(criteria_codes - claimed):
    bad.append(f"[R28] 判据 {c} 没出现在 §17.1 的落点表里（一条不少）")


# ---------- R29 preset 的 gate 目录必须冻出"三条保证全保持" ----------
KINDS = ("requirement", "design", "implement", "review", "deliver")
guarantee = {}
for m in re.finditer(r"^\| `([a-z][a-z0-9_.]*)` \| ([^|]+) \|", s4, flags=re.M):
    guarantee[m.group(1)] = m.group(2).strip()   # 值域在下面查（不能只匹配合法值，否则写错值会被静默跳过）

# applies_to 表是机器解析的：第二列只能是「五个 kind，用 / 分隔」，不许带括号备注。
s41 = doc04[doc04.find("### 4.1"):doc04.find("## 5. ")]
applies = {}
for m in re.finditer(r"^\|([^|]+)\|([^|]+)\|([^|]*)\|", s41, flags=re.M):
    codes = re.findall(r"`([a-z][a-z0-9_.]*)`", m.group(1))
    if not codes:
        continue
    cell = m.group(2).strip()
    kinds = {k.strip() for k in cell.split("/") if k.strip()}
    unknown = kinds - set(KINDS)
    if unknown:
        bad.append(f"[R29] applies_to 表出现非 kind 取值 {sorted(unknown)}（只允许 {'/'.join(KINDS)}，"
                   f"备注请放第三列）")
        continue
    if not kinds:
        bad.append(f"[R29] applies_to 表有空的 kind 列：{m.group(1).strip()[:40]}")
        continue
    for c in codes:
        applies[c] = kinds
for c in sorted(guarantee):
    # 只有参与降级判定的判据（保证 1/2/3）必须有 applies_to；`—` 里包含表约束型（没有 stage 语义）
    if guarantee[c] in ("1", "2", "3") and c not in applies:
        bad.append(f"[R29] 判据 {c} 标了保证 {guarantee[c]} 但 applies_to 表里没有它——delta 会把它静默漏掉")

d08 = read_doc("08-方法论与策略.md")
preset_stages = {}
for name in ("waterfall", "prototype", "incremental"):
    m = re.search(r"^\| `%s` \|.*$" % name, d08, flags=re.M)
    if not m:
        bad.append(f"[R29] docs/08 找不到 preset 行 {name}")
        continue
    cells = [c.strip() for c in m.group(0).strip().strip("|").split("|")]
    dag = next((c for c in cells if "[" in c and "]" in c), "")
    preset_stages[name] = {sid: set(k.strip() for k in kinds.split(","))
                           for sid, kinds in re.findall(r"(\w+)\[([a-z,\s]+)\]", dag)}
    if not preset_stages[name]:
        bad.append(f"[R29] {name} 的 stage DAG 解析不出 kinds")

blocks = re.findall(r"```yaml(.*?)```", d08[d08.find("### 1.1"):d08.find("**什么时候配")], flags=re.S)
catalogs = []
for b in blocks:
    flat = " ".join(b.split())
    gates = {}
    for gm in re.finditer(r"(\w+)\s*:\s*\{([^{}]*)\}", flat):
        inner = gm.group(2)
        gid = gm.group(1)
        keys = set(re.findall(r"([A-Za-z_]\w*)\s*:", inner))
        extra = keys - {"stage", "criteria", "policy_mode", "waivable"}
        if extra:
            bad.append(f"[R29] gate {gid} 有未知键 {sorted(extra)}——只允许 stage/criteria/policy_mode/"
                       f"waivable（写成 mode 之类的错字段名会被当缺省，检查器不能和错数据互相背书）")
        st = re.search(r"stage:\s*(\w+)", inner)
        pm = re.search(r"policy_mode:\s*(all_of|any_of)", inner)
        wv = re.search(r"waivable:\s*(true|false)", inner)
        cr = re.search(r"criteria:\s*\[([^\]]*)\]", inner)
        if not (st and pm and wv and cr):
            missing = [k for k, v in (("stage", st), ("policy_mode", pm),
                                      ("waivable", wv), ("criteria", cr)) if v is None]
            bad.append(f"[R29] gate {gid} 缺字段 {missing}")
            continue
        gates[gid] = {"stage": st.group(1), "policy_mode": pm.group(1),
                      "waivable": wv.group(1) == "true",
                      "criteria": [x.strip() for x in cr.group(1).split(",") if x.strip()]}
    if gates:
        catalogs.append(gates)

for c, g in sorted(guarantee.items()):
    if g not in ("1", "2", "3", "—"):
        bad.append(f"[R29] 判据 {c} 的「保证」取值 {g!r} 不在 {{1,2,3,—}} 里")
if guarantee.get("work_unit.evidence_consistent") != "—":
    bad.append("[R29] work_unit.evidence_consistent 是表约束（P2 不执行、绑不到 gate），保证列必须是 —，"
               "否则任何 policy 的该条保证都会永远降级")

CORE = ("spec_set.signed", "assumption_set.signed", "provenance.present")


def delta_errors(stages, gates):
    errs, eff = [], set()
    for gid, g in gates.items():
        sk = stages.get(g["stage"])
        if sk is None:
            errs.append(f"gate {gid} 指向不存在的 stage {g['stage']}")
            continue
        for c in g["criteria"]:
            if c not in applies:
                errs.append(f"gate {gid} 引用了 docs/04 里没有的判据 {c}")
                continue
            if g["policy_mode"] == "all_of" and not g["waivable"] and (applies[c] & sk):
                eff.add(c)
    for c in CORE:
        # 不是"某一个 stage 绑了就行"：凡 kinds 与 applies_to 相交的 stage 出口都必须有效绑定
        need = [sid for sid, sk in stages.items() if applies.get(c, set()) & sk]
        for sid in need:
            if not any(c in g["criteria"] and g["stage"] == sid
                       and g["policy_mode"] == "all_of" and not g["waivable"]
                       for g in gates.values()):
                errs.append(f"core 判据 {c} 在 stage {sid} 出口没有有效绑定（检查点不连续）")
    for c, g in guarantee.items():
        if g in ("1", "2", "3") and c not in eff:
            errs.append(f"保证 {g} 的判据 {c} 没绑定，preset 会冻出降级")
    return errs


resolved = {}
for name, stages in preset_stages.items():
    match = [g for g in catalogs if {v["stage"] for v in g.values()} == set(stages)]
    if not match:
        bad.append(f"[R29] {name} 没有对应的 gate 目录（docs/08 §1.1 缺块或 stage 名不一致）")
        continue
    resolved[name] = match[0]
    for e in delta_errors(stages, match[0]):
        bad.append(f"[R29] {name}: {e}")

# R29 自检：三条"该拦"的反例必须真的被拦（否则规则只是看着像在管）
if "waterfall" in resolved:
    base = resolved["waterfall"]
    st = preset_stages["waterfall"]
    core_gate = next(gid for gid, g in base.items()
                     if "spec_set.signed" in g["criteria"])

    def mutate(fn):
        g = {gid: dict(v, criteria=list(v["criteria"])) for gid, v in base.items()}
        fn(g)
        return delta_errors(st, g)

    cases = [
        ("把含 core 的 gate 改成 any_of", lambda g: g[core_gate].update(policy_mode="any_of")),
        ("把含 core 的 gate 改成可豁免", lambda g: g[core_gate].update(waivable=True)),
        ("删掉一条 core 判据的绑定",
         lambda g: g[core_gate].update(criteria=[c for c in g[core_gate]["criteria"]
                                                 if c != "spec_set.signed"])),
    ]
    for label, fn in cases:
        if not mutate(fn):
            bad.append(f"[R29-self] {label}，delta 复算却仍然全绿——校验没真正拦住")

# ---------- R30 每个过程都必须有模块归属（P1–P15 一个不落） ----------
d03_full = read(os.path.join(DESIGN, "03-过程逻辑.md"))
sec17 = d03_full[d03_full.find("## 17. 与文档的对应"):d03_full.find("### 17.1")]
proc_rows = {}
for line in sec17.splitlines():
    m = re.match(r"^\| (P\d+) [^|]*\|[^|]*\|[^|]*\|\s*([^|]*)\|\s*$", line)
    if m:
        proc_rows[m.group(1)] = [x.strip().strip("`") for x in m.group(2).split("/") if x.strip()]
want = {f"P{i}" for i in range(1, 16)}
for pid in sorted(want - set(proc_rows)):
    bad.append(f"[R30] 过程 {pid} 在 §17 表里没有模块归属（过程无家可归）")
for pid, owners in sorted(proc_rows.items()):
    if not owners:
        bad.append(f"[R30] 过程 {pid} 的模块列是空的")
    for o in owners:
        if o not in mods:
            bad.append(f"[R30] 过程 {pid} 指向的模块 {o} 不在 design/01 的模块表里")

# ---------- R31 顺序图里的 L1→L1 调用必须在模块依赖列里登记 ----------
ARCH = diagram_sources().get("arch-components.puml", "")
l1_mods = set()
m = re.search(r'package "L1 领域层" \{(.*?)\}', ARCH, flags=re.S)
if m:
    for nm, alias in re.findall(r'component "([a-z][a-z0-9_]*)" as (\w+)', m.group(1)):
        l1_mods.add(nm)
deps_by_mod = {mod: [d.replace("**", "").replace("`", "").strip()
                     for d in deps.split(",") if d.strip()]
               for mod, deps in module_rows(module_doc)}
# 已知边界：L2 编排层（handlers）的依赖列写的是「L1 服务」——刻意的抽象，不逐条枚举，
# 所以 L2→L1 的调用不做逐边校验（这条缝是显式的，见 design/01 §3 的说明）。
for fname, src in sorted(diagram_sources().items()):
    if not fname.startswith("uml-seq-"):
        continue
    alias2mod = {}
    for label, alias in re.findall(r'(?:participant|actor)\s+"([^"]+)"\s+as\s+(\w+)', src):
        mod = None
        if alias in l1_mods:
            mod = alias
        else:
            for cand in l1_mods:
                if cand in label:
                    mod = cand
                    break
        if mod:
            alias2mod[alias] = mod
    # 只认实线调用 `->`；虚线 `-->` 是返回，不构成依赖
    for a, b in re.findall(r"^\s*(\w+)\s*->\s*(\w+)\s*:", src, flags=re.M):
        if a in alias2mod and b in alias2mod:
            src_mod, dst_mod = alias2mod[a], alias2mod[b]
            if src_mod == dst_mod:
                continue
            if dst_mod not in deps_by_mod.get(src_mod, []):
                bad.append(f"[R31] {fname}: {src_mod} 调用 {dst_mod}，但模块依赖列没登记"
                           f"（图里出现了、架构里没登记）")

# ---------- R32 已废弃的判据句式不许留在实现面文档里 ----------
# 旧谓词"open 被有效签字覆盖"把 freshness 漏掉了，实现照抄会重开这个洞。
BANNED_PHRASES = (
    "仍为 `open` 的假设都必须已被",
    "仍是 `open` 的假设都必须已被",
    "覆盖当前全部 `open`",
)
banned_hits = []
for path in sorted(glob.glob(os.path.join(DOCS, "*.md"))) + [
        os.path.join(DESIGN, n) for n in ("01-结构化设计.md", "02-面向对象模型.md", "03-过程逻辑.md")]:
    text = read(path)
    for ph in BANNED_PHRASES:
        if ph in text:
            banned_hits.append(f"[R32] {os.path.basename(path)} 里还有已废弃的旧谓词：{ph}"
                               f"（freshness 会漏，改成 docs/04 §4 的三条）")
bad.extend(banned_hits)

# ---------- R33 P4 判定表的拒绝码必须出现在 P4 流程图里 ----------
p4_sec = re.search(r"\n## \d+\. P4[^\n]*\n(.*?)(?=\n## \d+\. )", d03, flags=re.S)
p4_dot = diagram_sources().get("p4-admission.puml", "")
if p4_sec and p4_dot:
    codes = set()
    for line in p4_sec.group(1).splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 6:
            # 只取「拒绝/阻塞」后面那个 code，别把正文里提到的其它标识当拒绝码
            codes |= set(re.findall(r"(?:拒绝|阻塞)[^`|]*`([a-z_.]+)`", cells[-1]))
    for code in sorted(codes):
        if code not in p4_dot:
            bad.append(f"[R33] P4 判定表里的 {code} 没出现在 p4-admission 流程图里"
                       f"（表与图两张表达，必有一边漏）")

if bad:
    print(f"✗ design 漂移 {len(bad)} 处：")
    for b in bad:
        print("   -", b)
    sys.exit(1)

print("✓ design 无漂移：图片、产物&源文件重建一致、事件 kind（文档+图）、模块↔组件、"
      "标题编号、状态枚举、迁移边、分层依赖、计数、P3 串联、矩阵守卫点、依赖列、事件生产者、判据落点、preset 保证、过程归属、顺序图依赖、废弃句式、P4 表图一致")
