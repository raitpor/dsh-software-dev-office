# 流程 preset（生命周期）

pre·set = 预先设定好的**阶段与出口判据**。这里的三份对应 SDO 设计里的三个内置 policy：`waterfall`、`prototype`、`incremental`。

选一个，抄进 `sdo/01-计划.md` 的「阶段」段，之后按它排卡与收口。**不要**混用：一张卡只属于一条阶段序列。

| preset | 什么时候用 | 阶段序列（`id`[`kinds`]） |
|---|---|---|
| `waterfall` | 需求明确、返工昂贵 | `req[requirement] → design[design] → build[implement] → verify[review] → deliver[deliver]` |
| `prototype` | 先做原型、再决定要不要产品化 | `explore[implement] → harden[requirement,design,implement,review] → deliver[deliver]` |
| `incremental` | 多条线并行、分批交付 | `req_design[requirement,design] → build[implement] → verify[review] → integrate[deliver]` |

## 无插件版怎么执行

没有 `judgeStage`，每个 stage 出口的 gate 降级成**一张勾选表**：

- 表里每行 = 该 gate 的一条判据，列：判据 / 判定 / 证据（命令或 `文件:行`）/ 改回去会怎样。
- 全部 pass（或 partial 已被签接受）⇒ 才能进下一阶段；否则**停在本阶段**。
- 全局 core 三条（`spec_set.signed`、`assumption_set.signed`、`provenance.present`）在每个出口都要过，判定方式：人签 + 意图/计划/假设文件存在。

## 与插件的对应

每份 preset 文件末尾有等价的 `policy` YAML 片段；将来装回插件时直接粘进 baseline，字段名一致。
