# sdo-flow

把 SDO 的项目管理流程做成一份**可携带的文本 skill**：意图 → 计划评审 → 卡 → 多轮评审 → 人签 → 读数门 → 偏差台账。

它不绑定任何 agent、插件或数据库：规则是 Markdown，人证是问答选项，门禁是判断清单 + 可复跑命令，检查器是一个零依赖 Node 脚本。

## 两条边界先说清楚

- 人签是**问答选项**，不是密码学签名：同一台机器上的模型可以替你点选项；不可抵赖只到“签字文件 + git 提交”。
- 账本、卡、读数都是文件，**可以改**；审计靠 git 历史，不防篡改。门禁靠人按清单判读。

这不是“降级版”。它是这套流程的**另一种实现形式**：文件与命令代替事件表与数据库，问答代替签名控件，检查脚本代替门禁引擎。

## 安装

分两步：先把 skill 放进 agent，再在项目里建 `.sdo/`。

### 1. 放进 agent

- **支持 skill 目录的 agent**：把整个 `skills/sdo-flow/` 拷进它约定的 skills 目录（项目级或用户级，范围随你）。常见约定是 `<项目根>/<agent 的 skills 目录>/sdo-flow/`（例如 `.agents/skills/sdo-flow/`），用户级位置见各自文档。
- **只有单一指令文件的 agent**：把 `SKILL.md` 并进 `AGENTS.md` / `CLAUDE.md`，`references/` 与 `templates/` 放同目录，脚本路径按实际位置改。

**一个容易踩的坑**：`SKILL.md` 的 YAML frontmatter 必须是合法 YAML。`description` / `whenToUse` 的值里出现 `: `（冒号加空格）会被解析成嵌套映射，严格解析器直接报错，而多数加载器只记一条 warning 就**跳过整个 skill**——表现为“装了但加载不到”，且没有任何显式报错。多行值用 `>-` 块标量。

装完确认两件事：

1. agent 的技能列表里出现 `sdo-flow`；
2. 能读到 `SKILL.md` 正文（随便抽读一节）。

不出现就先跑 `node <skill>/scripts/check.mjs`：它**始终会检查脚本自己所在的那个 skill 目录**的 frontmatter（即使 skill 装在用户级、不在项目里），会指出 `: ` 这类问题。`--presets` 也从脚本自身目录找 `presets/`，所以装在项目里、装到用户级、或在仓库里直接跑，三种位置都能用。

### 2. 在项目里初始化

```bash
# 0) 先确认 skill 装在哪：下面用 SKILL 指它（示例是项目级安装）
SKILL=.dsh/skills/sdo-flow

# 1) 建流程目录（按用途分子目录，不要平铺）
mkdir -p .sdo/cards .sdo/sign .sdo/readings .sdo/review .sdo/gates

# 2) 起步三件（这一步就能跑检查器）
cp $SKILL/templates/意图.md        .sdo/意图.md
cp $SKILL/templates/计划.md        .sdo/计划.md
mkdir -p .sdo/里程碑 && cp $SKILL/templates/里程碑.md .sdo/里程碑/M1.md   # 每个里程碑一个文件
cp $SKILL/templates/台账.md     .sdo/台账.md

# 3) 第一次写卡时再加（每张一份）
cp $SKILL/templates/card.md     .sdo/cards/<卡号>.md

# 4) 到第一次人签 / 第一次计划评审 / 第一次读数时再拷（sign 与 readings 提前拷会被占位检查报错；gates/review/board 不会）
cp $SKILL/templates/sign.md     .sdo/sign/S<n>.md
cp $SKILL/templates/review.md   .sdo/review/<M>-计划.md
cp $SKILL/templates/gates.md    .sdo/gates/<M>.md      # 出口勾选表（与读数分开：读数门要 overall）
cp $SKILL/templates/readings.md .sdo/readings/<M>.md
cp $SKILL/templates/看板.md        .sdo/看板.md
```

然后用编辑器写 `.sdo/意图.md`（目标/非目标/三条保证/判据/假设），把复述给人、问签；**没签不动工**。

**最小集（只想先试）**：`.sdo/` 目录 + `意图.md` + `计划.md` + `里程碑/M1.md` + `cards/M1-0.md`（卡号 `<M>-<n>`，见 references/01） + `台账.md`，并保留空的 `.sdo/sign/` 目录——第一次跑检查器会有 2 条 WARN（“还没有签字文件”与“还没有读数”，都是初始化期可接受），随 S1 与首次读数消失。里程碑读数与出口勾选表等用到时再拷模板。

**多人/多会话**：一卡一文件，台账是唯一共享追加文件（冲突保留双方行、按 id 排序）；签字文件只由签字人写（代笔须人确认并注明）；评审者与作者不同分支/会话。

## 维护（归档/恢复）

台账分卷：活跃卷 `.sdo/台账.md`、归档卷 `.sdo/ledger/vol-<n>.md`，索引 `.sdo/.index/ledger.json`（volumes + open）。`ledger.mjs rotate --to .sdo/ledger/vol-1.md` 把整卷改名（内容仅更新卷头行）并新建空活跃卷，不删行；`reindex` 从正文重建索引；`list --open`/`view next`/`check` 只读活跃卷与索引里的未决项；`check` 单次线性扫**台账分卷**（活跃卷 + `ledger/vol-*`；`.sdo/archive/` 里程碑归档不扫）复核 `open/rows/first/last`，sha256 只证**各卷文本未变**。索引正确性以 `reindex` 为准，不写“哈希相等 ⇒ 索引与正文一致”。手改正文后跑 `reindex`，否则 `check` 报 `index_stale`。默认快路径只对 `openRows>0` 的卷逐行扫描；`check.mjs --deep` 不看 `openRows`、审计所有卷（体积小/发布前用，性能不作预算）。两者都依赖索引与正文同权限同盘，**防不了“正文+索引+哈希一起伪造”**；要判断历史真伪，以 git 追加历史为准（`git log` 反查）。**操作性硬规则**：活跃卷 > 1000 行或里程碑收口时必须 `rotate`；`check` 对活跃卷 > 5000 行给 WARN「活跃卷过大，建议 rotate（大卷会让 add/view 变慢）」，WARN 不阻断。

`archive.mjs archive <M>` 用 `git mv` 把里程碑的卡/评审/读数/出口表搬进 `.sdo/archive/<M>/`，索引写 `.sdo/archive/INDEX.md`（manifest 含逐文件 sha256）；`restore <M>` 搬回。前置校验只覆盖“文件都在、哈希对”；若 `git mv` 中途失败，可能留下半搬状态，按 `git status` 手工回退（`git mv` 已暂存，可逐个 `git mv` 回原位）。

## 检查器与快捷视图

随包提供七个零依赖 Node 脚本（检查、阶段门、快捷视图、台账写入口、卡骨架/证据行/变异、签字材料 draft、里程碑归档）；`view.mjs next` 回答“现在能开工什么、还缺什么”；`check.mjs --plan` 查计划卡表与卡面的双向漂移（卡文件、依赖、write_scope、判据路径）。**用法属于流程的一部分，写在 `SKILL.md` §11**；这里只说明：需要 `node`，没有时退回人工。

## 适用与成本

- **值**：多会话、多 agent、要审计、要交接时——它把“谁在什么时候同意了什么”“为什么改了口径”落到文件与 git 历史里。
- **不值**：一次性小改、单人当天收尾的活——每张卡固定要几份文件、多轮评审、追问人签，重型流程会压过事情本身。
- 若已有更严格的合规流程，不要两套并行。

## 目录

```
skills/sdo-flow/
  SKILL.md            入口：这是什么 / 边界 / 选 preset / 七步 / 人签 / 判据 / 台账 / 多轮评审 / 自检
  references/01…07    按需加载：真源与账本、判据与门禁、签字与评审、计划与卡、读数与里程碑门、偏差台账、边界与自证
  presets/            瀑布 / 快速原型 / 增量 / agent 驱动：阶段序列 + 每个出口的判据勾选表 + 可迁移 policy
  templates/          9 份模板：意图 / 计划 / 卡 / 台账 / 看板 / gates / 读数 / 评审 / 签字
  scripts/            check.mjs（文本检查）/ gate.mjs（阶段门）/ view.mjs（快捷视图，含 next、archive）/ ledger.mjs（台账写入口）/ card.mjs（卡骨架、证据、变异）/ sign.mjs（签字材料）/ archive.mjs（归档与恢复）
```

## 已知边界

- 流程 preset 是**方法论层面的阶段预设**（瀑布 / 快速原型 / 增量），不是宿主的 agent preset。
- 检查器与视图需要 `node`；没有 Node 时退回人工检查，并在签字文件写“检查方式：人工”。
- 检查器只查**格式与结构**，不判断证据真假、不校验签名。
- 模板是示例，不替代设计文档；判据以你自己项目的判据源为准（`--presets <文件>` 可比对）。
