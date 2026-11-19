---
name: sdo-flow
description: Use when a project needs SDO discipline (intent → reviewed plan → cards → two-round review → human sign → milestone readings) and you want it carried entirely in files: Markdown ledgers as the source of truth, option-based questions as signatures, reproducible commands as gates. Works with any agent and any repository — no plugin, no database, no special tools beyond `git` (optional) and `node` (for the two checker scripts).
whenToUse: 需要“先对齐再动手、每步可审计、防漂移”的项目管理，用文件与命令把流程落地的场景（客户机器、临时会话、别人的仓库、纯 Web 会话）。
---

# SDO 流程（文件与命令实现）

一句话：**文件是真源，账本代替事件表，问答代替签名，命令代替门禁。**

## 0. 怎么装（任意 agent）

这套东西不绑定运行时：`SKILL.md` + `references/` 是给模型读的文本，`scripts/` 是可选的检查器。支持 skill 目录的 agent 把 `skills/sdo-flow/` 拷进去；只支持单一指令文件的把 `SKILL.md` 并进 `AGENTS.md`/`CLAUDE.md`；细节见 `references/08-移植到新仓库.md`。

项目产物固定放 **`.sdo/`**：`00-意图.md`、`01-计划.md`、`cards/`、`sign/`、`readings/`、`review/`、`台账.md`。

## 1. 何时用 / 何时不用

- **用**：要把流程带到别的会话/仓库；或不想为流程引入额外运行环境。**不用**：一次性小改动、已有更严格的合规流程（不要两套并行）。

## 2. 先看边界（读一遍再开工）

| 保证 | 这里怎么实现 | **挡不住什么** |
|---|---|---|
| 对齐 | 意图/复述文件 + 人签问答选项 | 没有密码学签名；同 uid 可以改文件 |
| 可审计 | 追加式 Markdown 账本 + 日期 + 出处 | 账本可改；只靠 git 历史与提交时间 |
| 防漂移 | 判据清单 + 可复跑命令 + 计划评审 | 没有机器门禁，靠人按清单判读 |

完整边界表见 `references/07-边界与自证.md`。**不要**把边界写成“已经解决”。

## 3. 先选流程 preset（阶段与出口）

| preset | 什么时候用 | 阶段序列 |
|---|---|---|
| `waterfall` | 需求明确、返工昂贵 | 需求→设计→实现→评审→交付 |
| `prototype` | 先做原型再决定 | 探索→加固（需求+设计+实现+评审）→交付 |
| `incremental` | 多条线并行 | 需求+设计→实现→评审→集成 |

选一个写进 `.sdo/01-计划.md` 的「阶段」段；每段结束过出口判据表，没过不开下一段。细节见 `presets/`。

## 4. 目录约定（签后可追加，签前可改）

```
.sdo/
  00-意图.md          立项：目标/非目标/三条保证/判据/假设/待确认
  01-计划.md          里程碑、卡表、依赖边、写域
  cards/<卡号>.md     一卡一文件（意图/判据/假设/证据/判定/评审）
  台账.md             偏差台账：gap / defect / explain，7 列
  sign/<S号>.md       人签记录（复述 + 选项 + 时间 + 被签对象）
  readings/<M>.md     里程碑读数（命令 + 输出摘要 + verdict）
  review/<M>-计划.md  计划评审记录
```

模板在 `templates/`，第一次用直接拷出来改。

## 5. 七步主循环

1. **立项**：写 `00-意图.md`；把复述给真人、问签（§6）；**没签不动工**。
2. **计划**：写 `01-计划.md`（选 preset + 卡表）；做计划评审（`references/04`）；改完再请人签计划。
3. **开卡**：一卡一文件；判据写死（每条可判死）、假设、预览、准入、证据。
4. **执行**：按卡改；写域外先问；**一卡两笔提交**（产物一笔、卡与台账一笔）；没有 git 时写「提交：无（无版本库）」并说明靠文件 mtime 审计。
5. **两轮评审**：第 1 轮判「可收卡 / 改完再审 / 拒绝」，改完第 2 轮复认（`references/03`）。
6. **人签收卡**：复述 + 三选项；签完写 `.sdo/sign/S<n>.md`，卡置 done。
7. **里程碑门**：跑读数（`references/05`）写 `.sdo/readings/<M>.md`；请人签门，partial 也照写。

## 6. 人签协议（唯一合法的人证方式）

- 用你的 agent 提供的“提问并给选项”能力（不同的 agent 名字不同；只能纯文本对话时就写三个编号选项让对方回数字），选项固定三种：**签：复述准确** / **改：复述不准（请指出）** / **不签：先不做**。
- 复述必须含四件：**范围**、**被签对象**（commit 或文件哈希）、**判据判定**（pass/partial/fail）、**已知边界**。
- 真人不在 ⇒ **阻塞**；不许模型自答，不许把“我问过”写成“签过了”。每次签字落文件：时间、选项、被签对象、未决项、谁签的。

## 7. 判据即门禁

- 一条判据要能判死：**“当 X 时，Y 必须成立”**，并给 1 个正例 + 1 个反例（反例要能真的红）。
- 三态：pass / partial / fail。partial 必须写“缺什么、何时补、谁认”。
- 门禁 = 勾选表 + 命令证据：**没有命令或文件:行的 pass 不算 pass**。
- 每个“绿”先问一句：**把它改回去会不会也绿？** 会 ⇒ 这条证据无效（变异红证，见 `references/03`）。

## 8. 偏差台账（防止“这样也行”）

- 每个绕过、缺口、口径变化都记一行：`D-<号> | kind | 位置 | 现象 | 影响 | 处置 | 状态`。
- kind：`gap`（缺）、`defect`（做错）、`explain`（口径解释）。不记 = 没发生；改口径的标 `superseded` 并保留旧行。

## 9. 评审（两轮制）

- 评审者必须是**没写这段的人/会话**；没有独立席位就明写“自审，非独立”。判词三选一：可收卡 / 改完再审 / 拒绝；问题分 P0–P3，每条带 `文件:行号` 或可复现命令。“可以提交”只对**它看过的那棵树**成立；改一行就要复认。

## 10. 参考资源（按需加载，不要整包读）

| 文件 | 什么时候看 |
|---|---|
| `references/01-真源与账本.md` | 建目录、写账本、对账、id 规则 |
| `references/02-判据与门禁.md` | 写判据、三态、勾选表 |
| `references/03-签字与评审.md` | 人签、两轮评审、变异红证 |
| `references/04-计划与卡.md` | 计划评审八项自检、卡面字段、依赖与写域 |
| `references/05-读数与里程碑门.md` | 读数格式、树冻结、哈希、门签 |
| `references/06-偏差台账.md` | kind、7 列、编号、口径统一 |
| `references/07-边界与自证.md` | 边界、四条「挡不住」、三条硬阻塞 |
| `references/08-移植到新仓库.md` | 三步初始化、最小集 |

## 11. 文本检查器与快捷视图

```bash
node <skill>/scripts/check.mjs            # 台账/表格/签字/卡/读数（默认只查 .sdo/ 与带 SKILL.md 的 skill 目录）
node <skill>/scripts/check.mjs --presets   # preset 与发布快照比对（可再传外部判据源文件）
node <skill>/scripts/check.mjs --all       # 连仓库其它 .md 一起查（默认不查，免被别人的文档绊倒）
```
`<skill>` 是这套 skill 在你项目/宿主里的实际目录（例如 `skills/sdo-flow`）。
只需要 `node`；没有 Node 时退回人工，并在签字文件写“检查方式：人工”。只查**格式与结构**，不判断证据真假。
收卡与出门前各跑一次；红了先修，别绕过。

**快捷视图**（把 `.sdo/` 的文件拼成一屏，省得每次翻五个文件）：

`view.mjs` 六个只读视图：`state`（总览）、`queue`（待办）、`board`、`ledger --open`、`signs`、`plan`；任意视图加 `--json` 出结构化数据。

## 12. 收卡/收门前自检

1. 意图与计划都有签字文件？ 2. 选定了 preset 且本阶段出口表填完？ 3. 每条判据都能判死？ 4. 每个判定都有命令或 `文件:行`？ 5. 台账记了？ 6. 有没有“模型自签/自审”混进来（评审者 = 作者？代笔但没人确认）？ 7. 一卡两笔、且已脱敏？
