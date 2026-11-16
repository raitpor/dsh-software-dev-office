#!/usr/bin/env python3
r"""plan/ 的机器检查（R1 表格列数、R2 里程碑卡表的依赖边）。

为什么单独有一条：`docs/check.py`（R19）与 `design/check.py`（R35）只扫各自的目录，
而 `plan/` 是执行面里表格最多、最常手改的地方（卡、台账、看板、计划）。第 45 轮
`docs/04` 的表格断行事故证明这类错误人眼很容易漏；台账本身就因为“8 列行混进 7 列表”
漂了很久（2026-11-13 修）。

R1：表头 / 分隔行 / 每一行的列数必须相等（`\|` 转义不算分隔，围栏代码块跳过）。
实现共用仓库根的 `mdtable.py`——和 docs/design 用的是同一个解析器，避免三处三套口径。

R2：`plan/00-开发计划.md` 里每个 `### M<n>` 里程碑段必须有一张卡表（表头含「卡」与「依赖」），
且每张卡的「依赖」只能指向**在它之前出现过**的卡；门卡（`*-G`）必须至少依赖一张产卡。

为什么有 R2：2026-11-16 我把 M5 写成“先派评审再插件化”——评审门排在了它的被评审对象前面。
这不是信息不足，是**顺序没有落成数据**：散文里的先后关系机器看不见，人眼也会漏。依赖边一旦
是表里的列，`M5-1` 依赖 `M5-0` 就变成可执行断言（前向引用直接红），比“再派一个 PM 复核”便宜。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import mdtable  # noqa: E402  (路径依赖：先插 ROOT 再 import)

PLAN = Path(__file__).resolve().parent
PLAN_DOC = PLAN / "00-开发计划.md"

_SECTION = re.compile(r"^###\s+(M\d+)\b")
_CARD_ID = re.compile(r"^M\d+-[0-9A-Za-z]+$")
_DEP_SPLIT = re.compile(r"[、,，/]")


def _tables(lines: list[str]):
    """产出 (起始行号, 表头单元格, 行列表)，只认「表头 + 分隔行」。"""
    i = 0
    while i < len(lines) - 1:
        head, sep = lines[i], lines[i + 1]
        if head.lstrip().startswith("|") and mdtable._SEP.match(sep.strip()):
            rows = []
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                rows.append((j + 1, mdtable.cells(lines[j])))
                j += 1
            yield i + 1, mdtable.cells(head), rows
            i = j
            continue
        i += 1


_RANGE = re.compile(r"^(M\d+-\d+)\s*(?:…|\.\.\.|~|-{1,2}>)\s*(M\d+-\d+)$")


def _expand(dep: str) -> list[str]:
    """`M0-1…M0-7` 展开成逐个卡号；单卡原样返回。"""
    m = _RANGE.match(dep)
    if not m:
        return [dep]
    lo, hi = m.group(1), m.group(2)
    pre_lo, _, n_lo = lo.rpartition("-")
    pre_hi, _, n_hi = hi.rpartition("-")
    if pre_lo != pre_hi or not n_lo.isdigit() or not n_hi.isdigit():
        return [dep]
    a, b = int(n_lo), int(n_hi)
    return [f"{pre_lo}-{n}" for n in range(a, b + 1)]


def _sections(lines: list[str]) -> list[tuple[str, int, int]]:
    """`### M<n>` 段的 (名字, 起始行, 结束行)，1-based 闭区间。"""
    heads: list[tuple[str, int]] = []
    for idx, line in enumerate(lines, start=1):
        m = _SECTION.match(line)
        if m:
            heads.append((m.group(1), idx))
    out = []
    for k, (name, start) in enumerate(heads):
        end = heads[k + 1][1] - 1 if k + 1 < len(heads) else len(lines)
        out.append((name, start, end))
    return out


def check_dependencies(path: Path) -> list[str]:
    """R2：里程碑段的卡表 + 依赖边只能回指。"""
    problems: list[str] = []
    lines = path.read_text(encoding="utf-8").splitlines()
    sections = _sections(lines)

    seen: list[str] = []
    per_section: dict[str, list[str]] = {name: [] for name, _, _ in sections}
    for start, header, rows in _tables(lines):
        cols = [c.strip() for c in header]
        if not any("卡" in c for c in cols) or not any("依赖" in c for c in cols):
            continue
        i_card = next(k for k, c in enumerate(cols) if "卡" in c)
        i_dep = next(k for k, c in enumerate(cols) if "依赖" in c)
        section = next((n for n, a, b in sections if a <= start <= b), None)
        for lineno, cells in rows:
            if len(cells) <= max(i_card, i_dep):
                continue
            raw_card = cells[i_card].strip().strip("`")
            card = raw_card.split()[0] if raw_card else ""
            if not _CARD_ID.match(card):
                continue
            dep_raw = cells[i_dep].strip()
            deps: list[str] = []
            for chunk in _DEP_SPLIT.split(dep_raw):
                chunk = chunk.strip().strip("`")
                if chunk and chunk not in {"—", "-"}:
                    deps.extend(_expand(chunk))
            if card.endswith("-G") and not deps:
                problems.append(f"{path.name}: 第 {lineno} 行门卡 {card} 没有依赖（门必须依赖产卡）")
            for dep in deps:
                if not _CARD_ID.match(dep):
                    problems.append(f"{path.name}: 第 {lineno} 行 {card} 的依赖 `{dep}` 不是卡号")
                elif dep not in seen:
                    problems.append(
                        f"{path.name}: 第 {lineno} 行 {card} 依赖 `{dep}`，但它不在本卡之前出现"
                        f"（前向引用/不存在：这正是「评审门排在插件化之前」那种形态）"
                    )
            seen.append(card)
            if section:
                per_section[section].append(card)

    for name, _, _ in sections:
        if not per_section[name]:
            problems.append(f"{path.name}: 里程碑段 `{name}` 没有卡表（表头需含「卡」与「依赖」）")
    return problems


def main() -> int:
    bad: list[str] = []
    files = sorted(PLAN.rglob("*.md"))
    for path in files:
        text = path.read_text(encoding="utf-8")
        bad.extend(mdtable.scan(text, str(path.relative_to(ROOT))))

    bad.extend(check_dependencies(PLAN_DOC))

    if bad:
        print("plan 检查未通过：")
        for item in bad:
            print(f"  {item}")
        return 1

    print(f"plan 检查通过：{len(files)} 篇文档，表格列数一致（R1）、里程碑依赖边可回指（R2）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
