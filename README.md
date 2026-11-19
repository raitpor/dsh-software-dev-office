# sdo-flow

把 SDO 的项目管理流程做成一份**可携带的文本 skill**：意图 → 计划评审 → 卡 → 两轮评审 → 人签 → 读数门 → 偏差台账。

它不绑定任何 agent、插件或数据库：规则是 Markdown，人证是问答选项，门禁是判断清单 + 可复跑命令，检查器是一个零依赖 Node 脚本。仓库自己就是用这套流程做出来的（`.sdo/` 里是全过程）。

## 两条边界先说清楚

- 人签是**问答选项**，不是密码学签名：同一台机器上的模型可以替你点选项；不可抵赖只到“签字文件 + git 提交”。
- 账本、卡、读数都是文件，**可以改**；审计靠 git 历史，不防篡改。门禁靠人按清单判读。

这不是“降级版”。它是这套流程的**另一种实现形式**：文件与命令代替事件表与数据库，问答代替签名控件，检查脚本代替门禁引擎。

## 怎么用

1. 拷 `skills/sdo-flow/` 到你的 agent 能找到的位置：
   - 支持 skill 目录的 agent：把 `skills/sdo-flow/` 放进它约定的 skills 目录（或软链过去）
   - 只有单一指令文件：把 `SKILL.md` 并进 `AGENTS.md` / `CLAUDE.md`，`references/` 放同目录
2. 在项目里建 `.sdo/`，从 `skills/sdo-flow/templates/` 拷出意图/计划/卡/台账，按 `references/08-移植到新仓库.md` 的三步初始化。
3. 让 agent 先读 `SKILL.md`，按七步循环走；每次人签都用三选一（签 / 改 / 不签）。

可选：`node skills/sdo-flow/scripts/check.mjs`（账本/表格/签字/卡/读数 + preset 自洽）与 `node skills/sdo-flow/scripts/view.mjs state|queue|board|ledger|signs|plan`（快捷视图，`--json` 可解析）。

## 目录

```
skills/sdo-flow/
  SKILL.md            入口：怎么装 / 边界 / 选 preset / 七步 / 人签 / 判据 / 台账 / 两轮评审 / 自检
  references/01…08    按需加载：真源与账本、判据与门禁、签字与评审、计划与卡、读数与里程碑门、偏差台账、边界与自证、移植
  presets/            瀑布 / 快速原型 / 增量：阶段序列 + 每个出口的判据勾选表 + 可迁移 policy
  templates/          9 份模板：意图 / 计划 / 卡 / 台账 / 看板 / gates / 读数 / 评审 / 签字
  scripts/check.mjs   文本检查器（Node 零依赖；--presets 校验 preset 自洽与发布快照）
  scripts/view.mjs    六个只读视图，按文件拼给 agent 看
.sdo/                 本项目自己的流程产物（意图 / 计划 / 卡 / 签字 / 读数 / 评审 / 偏差台账）
```

## 已知边界

- 流程 preset 是**方法论层面的阶段预设**（瀑布 / 快速原型 / 增量），不是宿主的 agent preset。
- 检查器与视图需要 `node`；没有 Node 时退回人工检查，并在签字文件写“检查方式：人工”。
- 检查器只查**格式与结构**，不判断证据真假、不校验签名。
- 模板是示例，不替代设计文档；判据以你自己项目的判据源为准（`--presets <文件>` 可比对）。
