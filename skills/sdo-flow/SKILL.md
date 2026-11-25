---
name: sdo-flow
description: >-
  Use when a project needs SDO discipline (intent -> reviewed plan -> cards ->
  multi-round review (no round cap) -> human sign -> milestone readings) and
  you want it carried entirely in files: Markdown ledgers as the source of truth,
  option-based questions as signatures, and reproducible commands as gates.
  Works in any agent and any repository, with nothing beyond the files themselves.
whenToUse: >-
  需要“先对齐再动手、每步可审计、防漂移”的项目管理，用文件与命令把流程落地时
  （客户机器、临时会话、别人的仓库、纯 Web 会话）。
---

# SDO Flow：用文件跑完「意图 → 评审计 → 人签 → 读数门」

> 目的：任何 agent 只读本文件加一个 refs 分册，就能在任意仓库跑完整的软件交付纪律，不需要外部服务。

## 1. 30 秒上手

```bash
node skills/sdo-flow/scripts/init.mjs            # 建 .sdo/（18 项）
node skills/sdo-flow/scripts/baseline.mjs init   # 基线四份
node skills/sdo-flow/scripts/milestone.mjs new M1 --topic "第一个里程碑"
node skills/sdo-flow/scripts/check.mjs           # 每次改完都跑；绿=可继续
```

- `.sdo/` 是账本：意图、计划、里程碑、卡、签、评审、读数、门、台账。全部 Markdown + append-only。
- 先读 `references/01-流程说明.md` 了解顺序；命令细节看 `references/02-脚本使用.md` 与各脚本 `--help`。
- 写完文件不知道对不对：`check.mjs` 报什么修什么，不猜。

## 2. 一次完整流程

1. **意图**：填 `.sdo/意图.md` 六节 + §12（要什么/不要什么/边界）。改一次要一次意图签。
2. **基线**：`baseline.mjs init` 建四份；基线只引用不复制（引 R/ADR 编号）。
3. **计划**：`.sdo/计划.md` 加里程碑索引行（7 列），`milestone new` 后填六段：认领、读数+探底、卡表、共享写域、阶段序列（preset 仅作抄写参考，真源不写 `preset：` 字段）、冻结段。
4. **计划评审**：非作者评审八项自检（见 01 §3）；问题写 `.sdo/review/`；判词三档。
5. **冻结与计划签**：六段填完 → `milestone.mjs freeze`（同时更新 `hash:` 与 `- 基线 hash：`）→ `check.mjs --plan --milestone <M>` 0 漂移 → `sign.mjs new --kind 计划` → 人签 → `check`。改基线或改六段后必须重冻。
6. **建卡**：`card.mjs new`（写域/判据/视角骨架）→ 认领 → 开工；一卡一提交。
7. **实现与证据**：`card.mjs evidence --run` 逐判据留 `exit=`；变异用 `card.mjs mutation` 或卡面表。
8. **卡评审**：≥1 轮，作者之外；每轮三档判词；修完再审，不设上限。
9. **读数门**：`readings.mjs init` 后填 R*（真路径）；`gate.mjs init` 四门表；门签用「选项：签：接受」放行 partial。
10. **收口与归档**：全部 done + 门签 → 计划状态「已收口」→ `archive.mjs` 移入 `.sdo/archive/<M>/`。
11. **交付**：签、评审、读数、门表、台账都在 `.sdo/`，可离线复跑。

## 3. 失败对照表（先看 ERROR 首行）

| 症状/错误码 | 修法 |
|---|---|
| `frozen_hash_missing` | 里程碑冻结段补 `hash:<64hex>` |
| `signed_anchor_mismatch` | 查追加签旧/新 hash 与链条顺序 |
| `signed_tree_unknown` | 被签对象 commit 不存在或无权限；改用当前树 hash |
| `gate_criteria_undeclared` | 冻结段缺 `- 门禁：`/`- 判据：` 两行 |
| `missing_declared_criterion` | 门表缺声明判据行；补行或走声明豁免 |
| `criterion_not_whitelisted` | 判据不在规范池；换池内判据或先扩池 |
| `preset_field_removed` | 新签里程碑真源不许写 `preset：` 字段 |
| `baseline_drift` | 冻结段变了：更新 hash + 追加签，不改基线 |
| `requirement_missing` | 里程碑缺 `认领需求：R-…`/`需求：无（理由）` |
| `phase_unknown` | 阶段序列 id 与 preset 不一致 |
| `structural_placeholder_left` | 冻结段还有 `<...>` 占位 |
| `plan_sign_unsigned` | 计划签草案未人签 |
| 退出码 2 | 参数用法错；看 `--help`，别猜 |
| 脚本崩栈 | 记命令+stderr 尾，报维护者；不要靠重跑 |

## 4. 四册索引（只读需要的）

| 册 | 内容 | 何时读 |
|---|---|---|
| `references/01-流程说明.md` | 主线/生命周期/评审签字/读数门/边界 | 第一次接触、要决定下一步 |
| `references/02-脚本使用.md` | 命令地图/初始化/计划/卡/签字/门/检查/排错 | 要跑命令、读输出、处理失败 |
| `references/03-编写规范.md` | 真源/卡面/判据门禁/证据变异/签记录/里程碑格式/台账/归档 | 写文件、改结构、补规范 |
| `references/04-参考资源.md` | 判据池/门与 preset/错误码/视角矩阵/模板/生成命令 | 查速查表、生成清单 |

- 模板在 `templates/`；生成命令与清单以 `criteria-doc --emit`、`declare --list`、`check --help` 为准。

## 5. 边界与不可机检（必须诚实）

- 口头授权≠流程放行；`check` 绿只证明结构与声明自洽，不证明意图正确。
- preset 只作抄写参考，不写进真源；真源是冻结段「门禁/判据」声明；出现 `preset：` 字段即 `preset_field_removed`。
- 签只证明「人确认过某个 hash/commit」，不证明内容对；签前必须亲眼看被签对象。
- 挡不住：评审者走过场、读数量了假路径、判定两份恰好一样却各有实现（这类必须抽单点或交人判）。
- 不可机检项（意图是否合理、方案是否最优）归评审与人签；不得把 partial 改成 pass。
- 碰到判据无法判死/证据无法复跑：停下补文档，不降标准；明确「不适用」须写理由。
