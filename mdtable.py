#!/usr/bin/env python3
"""GFM 表格列数检查（docs/check.py 的 R19 与 design/check.py 的 R35 共用）。

为什么单独成模块：同一个坑在 docs/ 和 design/ 都出现过——表格里某一行的
裸竖线（**即使包在反引号里也算分隔符**，GFM 的管表解析先于行内解析）会把
那一行切成多一格，渲染时整个表塌掉。规则只写一份，两边才不会漂。

已知边界（刻意不做的）：
  - 只认「分隔行上一行是表头」这一种表；没有分隔行的“伪表”不管；
  - 围栏代码块（``` / ~~~）里的内容整段跳过（那里不是表格）；
  - 行首/行尾竖线可省略（合法 GFM），省略时按内容切分；
  - 只数单元格，不检查对齐/转义后的渲染结果。
"""
from __future__ import annotations

import re

_FENCE = re.compile(r"^\s*(```|~~~)")
_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def cells(line: str) -> list[str]:
    """按未转义的 | 切单元格；行首/行尾的可选竖线先剥掉。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    out, cur, i = [], "", 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur += "|"
            i += 2
            continue
        if ch == "|":
            out.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    out.append(cur)
    return out


def scan(text: str, name: str = "") -> list[str]:
    """返回列数不一致的表格行描述；空列表表示该文件表格自洽。"""
    lines = text.split("\n")
    bad: list[str] = []
    fenced = False
    i = 0
    while i < len(lines) - 1:
        line = lines[i]
        if _FENCE.match(line):
            fenced = not fenced
            i += 1
            continue
        if fenced:
            i += 1
            continue
        head, sep = line.strip(), lines[i + 1].strip()
        if _SEP.fullmatch(sep) and head and "|" in head and not _SEP.fullmatch(head):
            n = len(cells(head))
            if len(cells(sep)) != n:
                bad.append(f"{name}: 第 {i + 1} 行表头 {n} 列、分隔行 {len(cells(sep))} 列")
            j = i + 2
            while j < len(lines):
                row = lines[j]
                if not row.strip() or "|" not in row or _FENCE.match(row) or _SEP.fullmatch(row.strip()):
                    break
                if len(cells(row)) != n:
                    bad.append(f"{name}: 第 {j + 1} 行列数 {len(cells(row))} ≠ 表头 {n}")
                j += 1
            i = j
            continue
        i += 1
    return bad
