#!/usr/bin/env python3
r"""plan/ 的机器检查（R1）：Markdown 表格列数一致。

为什么单独有一条：`docs/check.py`（R19）与 `design/check.py`（R35）只扫各自的目录，
而 `plan/` 是执行面里表格最多、最常手改的地方（卡、台账、看板、计划）。第 45 轮
`docs/04` 的表格断行事故证明这类错误人眼很容易漏；台账本身就因为“8 列行混进 7 列表”
漂了很久（2026-11-13 修）。

规则只有一条：表头 / 分隔行 / 每一行的列数必须相等（`\|` 转义不算分隔，围栏代码块跳过）。
实现共用仓库根的 `mdtable.py`——和 docs/design 用的是同一个解析器，避免三处三套口径。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import mdtable  # noqa: E402  (路径依赖：先插 ROOT 再 import)

PLAN = Path(__file__).resolve().parent


def main() -> int:
    bad: list[str] = []
    files = sorted(PLAN.rglob("*.md"))
    for path in files:
        text = path.read_text(encoding="utf-8")
        bad.extend(mdtable.scan(text, str(path.relative_to(ROOT))))

    if bad:
        print("plan 表格列数不一致：")
        for item in bad:
            print(f"  {item}")
        return 1

    print(f"plan 检查通过：{len(files)} 篇文档，表格列数一致（R1）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
