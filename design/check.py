#!/usr/bin/env python3
"""design/ 的机器校验（不是 docs/check.py 的替代）。

规则（4 条基础 + R19–R24）：
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
  R25 不变量矩阵的守卫点可落地（类/模块/03 P 号），表约束行写具体约束名。

退出码：0 通过；1 有漂移。
"""
from __future__ import annotations

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

# 判据 code 不是事件（`stage.gate_bound` 这类）
criteria = set(re.findall(r"^\| `([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`",
                          read_doc("04-判据-门禁与负例.md"), flags=re.M))
# 字段 / 方法 / 错误码，长得像事件但不是
NON_EVENTS = {
    "intent.baseline_hash", "intent.strength", "spec.content_hash", "spec.kind", "spec.risk_flags",
    "event.kind", "release.freeze", "admission.evaluate", "criterion.spec_id", "work_unit.id",
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
    # 这两张的状态是设计层命名（docs 里以事件与结论描述），没有列枚举，故只校验图本身
    "uml-state-stagerun": ({"running", "closed"}, "", ""),
    "uml-state-review": ({"open", "closed"}, "", ""),
}

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
            doc_states = set(re.findall(r"[a-z_]+", m.group(1)))
            if doc_states != expected:
                bad.append(f"[R21] {doc} 的状态枚举与 {name} 期望值不一致：{sorted(doc_states)}")

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
    chain = ["s2", "s3", "s3g", "s3gb", "s35", "s4", "s51", "s5"]
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
classes = set(re.findall(r"^class (\w+)", diagram_sources().get("uml-class.puml", ""), flags=re.M))
matrix_start = oom.find("| 不变量 | 唯一守卫点 | 类型 |")
matrix_end = oom.find("## 6.", matrix_start)
matrix_rows = 0
for line in oom[matrix_start:matrix_end].splitlines():
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) != 3 or not cells[1] or "---" in cells[0]:
        continue
    guard, kind = cells[1], cells[2]
    matrix_rows += 1
    if "领域" in kind:
        words = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", guard))
        cited = re.search(r"03\s*P\d+|P\d+", guard)
        if not (words & classes) and not (words & mods) and not cited:
            bad.append(f"[R25] 矩阵守卫点不可落地：{guard}（不在类图、不是模块、也没引 03 的 P 号）")
    elif "表约束" in kind:
        if not re.search(r"UNIQUE|外键|CHECK|NOT NULL", guard):
            bad.append(f"[R25] 矩阵守卫点声明为表约束但没写具体约束：{guard}")
if matrix_rows < 20:
    bad.append(f"[R25] 不变量矩阵只有 {matrix_rows} 行，疑似被合并回'一行多不变量'")

if bad:
    print(f"✗ design 漂移 {len(bad)} 处：")
    for b in bad:
        print("   -", b)
    sys.exit(1)

print("✓ design 无漂移：图片、产物&源文件重建一致、事件 kind（文档+图）、模块↔组件、"
      "标题编号、状态枚举、分层依赖、计数、P3 串联、矩阵守卫点")
