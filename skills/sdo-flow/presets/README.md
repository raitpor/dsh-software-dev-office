# 流程 preset（生命周期）

pre·set = 预先设定好的**阶段与出口判据**。前三份对应 SDO 设计里的三个内置 policy（`waterfall`、`prototype`、`incremental`）；第四份 `agent-driven` 是本 skill 的扩展，按 agent 开发的特点设计，**不在设计稿的目录内**，判据里标 `agent.` 的条目属流程自检项。

选一个，抄进 `.sdo/01-计划.md` 的「阶段」段，之后按它排卡与收口。**不要**混用：一张卡只属于一条阶段序列。

选法：需求清楚且返工贵 ⇒ `waterfall`；需求不清先验证 ⇒ `prototype`；多线并行、人参与多 ⇒ `incremental`；产出主要由 agent 完成、人只在三个点介入 ⇒ `agent-driven`。

| preset | 什么时候用 | 阶段序列（`id`[`kinds`]） |
|---|---|---|
| `waterfall` | 需求明确、返工昂贵 | `req[requirement] → design[design] → build[implement] → verify[review] → deliver[deliver]` |
| `prototype` | 先做原型、再决定要不要产品化 | `explore[implement] → harden[requirement,design,implement,review] → deliver[deliver]` |
| `incremental` | 多条线并行、分批交付 | `req_design[requirement,design] → build[implement] → verify[review] → integrate[deliver]` |
| `agent-driven` | 主要产出由 agent 完成、人只做三个决定点（立项/计划签、抽样评审、收口签） | `frame[requirement,design] → build[implement] → verify[verify] → review[review] → sign[vet] → deliver[deliver]` |

## 怎么执行（勾选表就是门禁）

每个 stage 出口的 gate 落成**一张勾选表**：

- 表里每行 = 该 gate 的一条判据，列：判据 / 判定 / 证据（命令或 `文件:行`）/ 改回去会怎样。
- 全部 pass（或 partial 已被签接受）⇒ 才能进下一阶段；否则**停在本阶段**。
- 全局 core 三条（`spec_set.signed`、`assumption_set.signed`、`provenance.present`）在每个出口都要过。
  判定方式：`spec_set.signed` = 计划已人签（S 号）；`assumption_set.signed` = 意图 §7 假设表已随该签确认且每条写“不成立怎么办”；`provenance.present` = 每个判定都有命令或 `文件:行`。

