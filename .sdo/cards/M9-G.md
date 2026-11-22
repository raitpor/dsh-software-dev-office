# M9-G 读数门（R38–R43）

status: open
owner: impl-core
write_scope: [.sdo/readings/, .sdo/gates/M9.md, .sdo/review/, .sdo/sign/, .sdo/notes/M9-使用笔记.md, .sdo/milestones/M9.md, .sdo/cards/M9-G.md, .sdo/台账.md]
references: [R-02, R-03]
read_refs: [.sdo/milestones/M9.md, .sdo/gates/]

依赖：M9-0, M9-1, M9-2, M9-3, M9-4

## 意图

按 M9.4 的四门取证：R38–R43 逐条给可复跑命令与首条输出，写出口表、使用笔记，收口并同步已安装副本。

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
| C1 | `.sdo/readings/M9.md` 覆盖 R38–R43，每条有命令、首条输出与 verdict；overall 与逐条一致 | 结构 | 改一条 verdict 与逐条不符 ⇒ `check` 报读数不一致 |
| C2 | `.sdo/gates/M9.md` 四门合计 **34 行全在**（16+6+6+6），判定列只允许 pass/partial/fail 三态；确实不适用的判据在**说明列**写 N/A：<依据>（不占判定列），卡面列出允许 N/A 的判据白名单并由评审逐条确认；含一行显式 `trace exit 0`；`gate.mjs --file` exit 0 | 结构 | 删一行 ⇒ `gate` 报缺判据；判定列写 N/A ⇒ `gate` 报“没有判定”，本判据红 |
| C3 | `.sdo/notes/M9-使用笔记.md` ≥3 条摩擦，每条含“现象/命令/结论” | 结构 | 删到 2 条 ⇒ 判据红 |
| C4 | 已安装副本 `.dsh/skills/sdo-flow/` 与本仓库 `diff -r` 无差异 | 结构 | 不同步 ⇒ diff 有输出，判据红 |

## 证据

| 判据 | 命令与输出 | 判定 |
|---|---|---|
| C1 | `node skills/sdo-flow/scripts/check.mjs` ⇒ `检查完成：134 个 Markdown，0 个错误，0 个警告`（2026-11-22T22:56+08:00）；`.sdo/readings/M9.md` 的 `## overall：partial` 与逐条一致（R38–R42 pass、R43 partial）。变异：把 overall 改 `pass` ⇒ `ERROR .sdo/readings/M9.md:3: overall=pass 与逐条不一致：有读数判 partial ⇒ overall 必须是 partial`、exit 1（复原后 0 错） | pass |
| C2 | `node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M9.md` ⇒ `G_req_design pass 16 / G_build_exit pass 6 / G_verify_exit pass 6 / G_integrate pass 7`，`门禁检查通过（全部 pass，或 partial 已被本表人签接受）`、exit 0；34 条 = 16+6+6+6，判定列只有 pass/partial/fail，N/A 白名单为空（34 条均适用），`trace.exit_zero` 为额外第 35 行不占 34 条。变异：删 G_build_exit 的 `spec_set.signed` 行 ⇒ `ERROR .sdo/gates/M9.md: 缺判据 spec_set.signed（preset 的 gate 要求）`、exit 1 | pass |
| C3 | `wc -l .sdo/notes/M9-使用笔记.md` ⇒ 30；`grep -c '^## [0-9]'` / `grep -c '^- 现象：'` / `grep -c '^- 命令：'` / `grep -c '^- 结论：'` 均 4（4 条摩擦，每条三要素齐全） | pass |
| C4 | 同步前 `diff -r skills/sdo-flow .dsh/skills/sdo-flow` 有差异（agent-driven preset 少 `requirement.claimed_or_na` 行等，判据红）；执行 `rm -rf /tmp/sdosync && mkdir -p /tmp/sdosync && git archive HEAD skills/sdo-flow \| tar -x -C /tmp/sdosync && rsync -a --delete /tmp/sdosync/skills/sdo-flow/ .dsh/skills/sdo-flow/` 后 `diff -r skills/sdo-flow .dsh/skills/sdo-flow` 无输出、exit 0 | pass |

门签前必须 `check`、`--trace`、`--presets`、`--plan --milestone M9` 全绿。

## 变异

| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|
| C1 | `.sdo/readings/M9.md` 的 `## overall：partial` 改成 `pass` | `node skills/sdo-flow/scripts/check.mjs` | exit 1：`overall=pass 与逐条不一致：有读数判 partial`；复原后 0 错 |
| C2 | 删 `.sdo/gates/M9.md` 的 `G_build_exit` `spec_set.signed` 行 | `node skills/sdo-flow/scripts/gate.mjs --file .sdo/gates/M9.md` | exit 1：`缺判据 spec_set.signed（preset 的 gate 要求）`；复原后 exit 0 |
| C3 | 删笔记到 2 条 | 人工评审（无脚本） | 结构判据由评审读数，脚本不拦；M9-G 评审需确认 ≥3 条与三要素 |
| C4 | 不同步 `.dsh/` | `diff -r skills/sdo-flow .dsh/skills/sdo-flow` | 有输出（同步前实测），判据红；同步后无输出 exit 0 |

## 判定

| 判据 | 判定 | 说明 |
|---|---|---|
| C1 | pass | 读数 6 条四列齐全，overall partial 与逐条一致（R43 partial）；变异红证见上 |
| C2 | pass | 四门 34+1 行全在，gate exit 0；N/A 白名单为空 |
| C3 | pass | 4 条摩擦，每条现象/命令/结论 |
| C4 | pass | 已安装副本同步后 `diff -r` 无输出（`.dsh/` 由 Lead 复核） |

## 协作偏差

- 台账 D-186 曾不在原 write_scope；已由追加签 S42-F 把 `.sdo/台账.md` 补进卡面与计划卡表写域，现在不再是越界。
- 安装副本 `.dsh/skills/sdo-flow/` 属写域外：只执行 Lead 给的同步命令，未提交；由 Lead 复核。

## 评审

- 评审者：（待填，独立会话）
- 第 1 轮：待评审（骨架见 `.sdo/review/M9-G.md`；重点：R43 partial 是否被门签显式接受、34 条证据真实性、C4 同步）
- 判定：（待填）

## 收口

- [ ] 条件与证据齐全
- [ ] 评审为「可收卡」
- [ ] 报告交人签
