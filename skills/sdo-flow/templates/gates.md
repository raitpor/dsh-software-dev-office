# 读数：<M>（里程碑门）

> 用途：出口勾选表：把某阶段 gate 的 criteria 逐条列出，供人勾选判读。

证据时点：<ISO> ｜ 被取证树：`<commit>` ｜ 命令：见下

## 1. 出口勾选表（对应 preset 的 `G_*`）

| # | 判据 | 判据说明 | 证据（命令/文件:行） | 判定 |
|---|---|---|---|---|
| 1 |  |  |  | pass / partial / fail |
| 2 |  |  |  |  |

> core 三条每个出口都要过：`spec_set.signed`、`assumption_set.signed`、`provenance.present`。

## 2. 偏差（没过的项）

| 判据 | 为什么没过 | 下一步 | 谁接受 partial |
|---|---|---|---|

## 3. 人签

- 选项：签：复述准确（含 partial）/ 改：复述不准（请指出） / 不签：先不做
- 时间：<ISO>
- 被签对象：<commit + 本文件 sha256>
