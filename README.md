# sdo-flow

把 SDO 的项目管理流程做成一份**可携带的文本 skill**：意图 → 计划评审 → 卡 → 两轮评审 → 人签 → 读数门 → 偏差台账。

它不绑定任何 agent、插件或数据库：规则是 Markdown，人证是问答选项，门禁是判断清单 + 可复跑命令，检查器是一个零依赖 Node 脚本。仓库自己就是用这套流程做出来的（`.sdo/` 里是全过程）。

## 两条边界先说清楚

- 人签是**问答选项**，不是密码学签名：同一台机器上的模型可以替你点选项；不可抵赖只到“签字文件 + git 提交”。
- 账本、卡、读数都是文件，**可以改**；审计靠 git 历史，不防篡改。门禁靠人按清单判读。

这不是“降级版”。它是这套流程的**另一种实现形式**：文件与命令代替事件表与数据库，问答代替签名控件，检查脚本代替门禁引擎。

## 安装

分两步：先把 skill 放进 agent，再在项目里建 `.sdo/`。

### 1. 放进 agent

- **支持 skill 目录的 agent**：把整个 `skills/sdo-flow/` 拷进它约定的 skills 目录（项目级或用户级，范围随你）。常见项目级位置如 `<项目根>/.dsh/skills/sdo-flow/`、`<项目根>/.agents/skills/sdo-flow/`；用户级位置见各自文档。
- **只有单一指令文件的 agent**：把 `SKILL.md` 并进 `AGENTS.md` / `CLAUDE.md`，`references/` 与 `templates/` 放同目录，脚本路径按实际位置改。

**一个容易踩的坑**：`SKILL.md` 的 YAML frontmatter 必须是合法 YAML。`description` / `whenToUse` 的值里出现 `: `（冒号加空格）会被解析成嵌套映射，严格解析器直接报错，而多数加载器只记一条 warning 就**跳过整个 skill**——表现为“装了但加载不到”，且没有任何显式报错。多行值用 `>-` 块标量。

装完确认两件事：

1. agent 的技能列表里出现 `sdo-flow`；
2. 能读到 `SKILL.md` 正文（随便抽读一节）。

不出现就先跑 `node <skill>/scripts/check.mjs`，frontmatter 那条检查会指出问题。

**更新**：改了仓库里的 `skills/sdo-flow/` 之后，重新覆盖安装位置的目录即可（例如 `rm -rf .dsh/skills/sdo-flow && cp -r skills/sdo-flow .dsh/skills/sdo-flow`）；安装目录属于本机环境，不要提交进仓库。

### 2. 在项目里初始化

```bash
# 建流程目录（按用途分子目录，不要平铺）
mkdir -p .sdo/cards .sdo/sign .sdo/readings .sdo/review .sdo/gates

# 从模板拷出骨架，按用途改名
T=skills/sdo-flow/templates
cp $T/00-意图.md   .sdo/00-意图.md
cp $T/01-计划.md   .sdo/01-计划.md
cp $T/台账.md      .sdo/台账.md
cp $T/board.md     .sdo/看板.md
cp $T/readings.md  .sdo/readings/<M>-读数.md
cp $T/card.md      .sdo/cards/<卡号>.md        # 每张卡一份
cp $T/review.md    .sdo/review/<M>-计划.md     # 计划评审与卡评审各一份
cp $T/gates.md     .sdo/gates/<M>.md           # 每段出口勾选表（与读数分开：读数门要 overall）
cp $T/sign.md      .sdo/sign/S<n>.md           # 每次人签一份
```

然后用编辑器写 `.sdo/00-意图.md`（目标/非目标/三条保证/判据/假设），把复述给人、问签；**没签不动工**。

**最小集（只想先试）**：只留 `.sdo/00-意图.md`（立项 + 人签）、`.sdo/cards/C-01.md`（第一张卡）、`.sdo/台账.md`（可以空表）也能跑；里程碑门与读数等第二次再用。

**多人/多会话**：一卡一文件，台账是唯一共享追加文件（冲突保留双方行、按 id 排序）；签字文件只由签字人写（代笔须人确认并注明）；评审者与作者不同分支/会话。

## 检查器与快捷视图

```bash
node <skill>/scripts/check.mjs             # 台账/表格/签字/卡/读数（默认只查 .sdo/ 与带 SKILL.md 的 skill 目录）
node <skill>/scripts/check.mjs --presets   # preset 与发布快照比对（可再传外部判据源文件）
node <skill>/scripts/check.mjs --all       # 连仓库其它 .md 一起查（默认不查，免被别人的文档绊倒）
node <skill>/scripts/view.mjs state|queue|board|ledger|signs|plan   # 六个只读视图，--json 出结构化数据
```

只查**格式与结构**，不判断证据真假；需要 `node`，没有时退回人工并在签字文件写“检查方式：人工”。脚本是可选辅助，流程本身不依赖它——证据仍以“可复跑命令或 `文件:行`”为准。

## 适用与成本

- **值**：多会话、多 agent、要审计、要交接时——它把“谁在什么时候同意了什么”“为什么改了口径”落到文件与 git 历史里。
- **不值**：一次性小改、单人当天收尾的活——每张卡固定要 5 份文件、两轮评审、追问人签，重型流程会压过事情本身。
- 若已有更严格的合规流程，不要两套并行。

## 目录

```
skills/sdo-flow/
  SKILL.md            入口：这是什么 / 边界 / 选 preset / 七步 / 人签 / 判据 / 台账 / 两轮评审 / 自检
  references/01…07    按需加载：真源与账本、判据与门禁、签字与评审、计划与卡、读数与里程碑门、偏差台账、边界与自证
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
