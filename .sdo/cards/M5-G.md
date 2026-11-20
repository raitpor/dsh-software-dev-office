# M5-G · 读数门（R19–R25）+ 使用笔记 + 门签

status: open
owner: impl-core
write_scope: [`.sdo/readings/`, `.sdo/sign/`, `.sdo/review/`, `.sdo/notes/`, `.sdo/gates/`, `.sdo/01-计划.md`（只改本段状态）]

## 意图
在同一棵树上跑 R19–R25，出读数、写 M5 出口表、记录 agent-driven preset 的使用不便（由人确认讨论结论），请人签门。

## 风险标记

risk_flags：无

## 对齐
- 该做：逐条读数带命令与结果；使用笔记 ≥3 条；门签前请独立评审；出口表 `.sdo/gates/M5.md` 由本卡产出。
- 不该做：不把“跑过命令”写成“证明了业务正确”；不代填判定；不拿旧读数给新树签门。

## 判据
| 判据 | 内容 | 证据怎么给（含反例） |
|---|---|---|
| C1 | R19 三类假绿全红 | 三个夹具各 exit 1 并点名判据；反例：任一为 exit 0 ⇒ 本判据 fail |
| C2 | R20 变异红证真跑 | 记录 expected/actual 与恢复后的 exit；反例：只有结论没有两次输出 ⇒ fail |
| C3 | R21 归档效果：扫描文件数下降 ≥10% 且不随里程碑增长 | 归档前后数字各一组；反例：数字不变 ⇒ fail |
| C4 | R22 restore 可逆：逐文件 sha256 与 manifest 相等、`git status` 空 | 命令与输出；反例：任一文件哈希不等 ⇒ fail |
| C5 | R23 1 万/10 万行性能达标（三次取中位） | 两档三命令计时、机器与 Node 版本；反例：超预算仍写 pass ⇒ 违反本卡 C1 精神，判 fail |
| C6 | R24 索引漂移检测与 reindex 恢复（reindex 后 diff 为空） | 两例 exit 1、reindex 后 0 错；反例：reindex 后索引与正文仍不一致 ⇒ fail |
| C7 | R25 使用笔记 ≥3 条具体不便（含复现与建议），门签时由人确认讨论结论并落台账 | 笔记 ≥3 条 + 台账有 explain 行；反例：只写“没问题”或模板占位 ⇒ fail |
| C8 | 读数完整性与门前提 | `check` 每条 R 有 verdict、overall 与逐条一致、零 warn；**`.sdo/gates/M5.md` 存在且 `gate.mjs` 对它 exit 0**；M5-0…M5-4 已收卡；反例：删出口表 ⇒ `gate.mjs` exit 2 且本判据 fail；任一卡未收 ⇒ fail |

## 假设
A1：`/tmp` 跨界会被清空 ⇒ 所有夹具在单次调用内完成。
A2：合成数据只用于计时，不含真实项目内容。

## 预览
预计改：见 `write_scope`。
验：`node <skill>/scripts/check.mjs` 0 错 0 警；本卡判据逐条有证据。

## 准入
依赖：M5-0、M5-1、M5-2、M5-3、M5-4

## 证据
| 判据 | 命令 | 输出摘要 | 判定 |
|---|---|---|---|
| C1 | `/tmp` 副本三夹具：清空 M5-1 C1 证据行 / 结果列手写 `pass` / M4 一条 verdict 改 partial 而 overall 仍 pass | 三例均 `check` exit 1，分别报 `证据行为空`、`证据结果列不是脚本形态`、`overall=pass 与逐条不一致` | pass |
| C2 | `card.mjs mutation --card M5-2 --criterion C5 --mutate 'sed … process.exit(1)…' --expect 'node … check.mjs'` | `expected=red actual=red`、`restored=green`，exit 0；前后工作树 status sha 相同 | pass |
| C3 | `/tmp` git 副本：`check` 基线 → `archive M1/M2/M3` → `archive M4` → 新增 M9-0 再 archive M9 | 91 篇/45.2ms → 78 篇/39.2ms（−14.3%）→ 69 → 70/69；一进一出不变 | pass |
| C4 | `/tmp` 副本 `archive M3` → 提交 → `restore M3` → 逐文件 sha → 提交 | restore 后 status = `M INDEX` + 4 条 `R`；4/4 sha 与 manifest 相等、mismatch 0；提交后 status 0 行、check 91 篇 0/0 | pass |
| C5 | 单次 bash 合成三档，各三次中位：`ledger add` / `view next` / `check` | 10k 活跃 69.3/30.5/56.2 全达标；100k 全 open 435.4/199.6/468.5（add/check 超）；100k 归档(0 open)+200 活跃(100 open) 30.8/21.9/71.8 全达标 | partial |
| C6 | `/tmp` 副本：改 D-1 状态不 reindex、删一行不 reindex、`reindex` 两次 | 前两例 exit 1 `index_stale`；两次 reindex stdout 与索引 sha 相同，check 0/0 | pass |
| C7 | `.sdo/notes/M5-使用笔记.md` + 台账 D-100 | 6 条（原 4 + 新 2，含现象/复现/建议）；人确认待门签 | partial |
| C8 | `check.mjs`、`check.mjs --plan --milestone M5`、`view next`、`gate.mjs`；S21–S25 | check 113 篇 0 错 0 警；--plan 0 漂移；view next 5 节；gate exit 0；S21–S25 已签（M5-2/3/4 已补 `status: done` 与回溯证据） | pass |

## 判定
- C1 pass：三假绿均真红，消息点名判据。
- C2 pass：`mutation` 两段输出与恢复均实测，工作树未变。
- C3 pass：冻结树副本归档 M1–M3 后扫描数 91→78（−14.3%），一进一出稳定，与里程碑数解耦。
- C4 pass：按正确闭包（先提交 archive，再 restore 后提交）4/4 哈希与 manifest 相等；restore 后 status 为 `M INDEX`+4 `R`，提交后 0 行；check 91/0/0。
- C5 **partial**：10k 全达标；100k 全 open add 435.4/check 468.5 超预算、view 199.6 过；100k 归档(0 open)+200 活跃(100 open) 30.8/21.9/71.8 全达标（check 按 openRows 跳过无未决归档卷）；缺口 D-95/D-98。
- C6 pass：两处手改不 reindex 均 `index_stale` exit 1；reindex 两次幂等、check 恢复 0/0。
- C7 **partial**：笔记 6 条、台账 D-100/D-103 已落；门签时的人类讨论确认尚未发生。
- C8 pass：check 113 篇 0 错 0 警（check WARN=0；gate 2 条 WARN 属 CORE 与 preset 列表差异）、--plan 0 漂移、view next 5 节、gate exit 0；M5-0…M5-4 已 done 且 S21–S25 已签。
- overall：partial（C5/C7），待门签 S26 由人决定接受或返工。

## 已知边界
- 默认快路径只对 `openRows>0` 的卷逐行扫描；`check --deep` 不看 `openRows`、审计所有卷。两者都依赖索引与正文同权限同盘，防不了“正文+索引+哈希一起伪造”；历史真伪以 git 追加历史为准。

## 评审
- 评审者：待派（非作者、只读）
