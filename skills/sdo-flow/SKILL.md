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

# SDO 流程（文件与命令实现）

一句话：**文件是真源，账本代替事件表，问答代替签名，命令代替门禁。**

## 0. 本文讲什么
只讲**项目管理流程本身**：顺序、判据、人签、多轮评审、偏差台账、读数门。产物都在项目 `.sdo/`（§4）。流程之外（这套东西是什么、怎么放进 agent、附带工具）见 `README.md`。

## 1. 何时用 / 何时不用
- **用**：把流程带到别的会话/仓库，或不想为流程引入额外运行环境。**不用**：一次性小改动、已有更严格的合规流程（不要两套并行）。
## 2. 先看边界（读一遍再开工）
| 保证 | 这里怎么实现 | **挡不住什么** |
|---|---|---|
| 对齐 | 意图/复述文件 + 人签问答选项 | 没有密码学签名；同 uid 可以改文件 |
| 可审计 | 追加式 Markdown 账本 + 日期 + 出处 | 账本可改；只靠 git 历史与提交时间 |
| 防漂移 | 判据清单 + 可复跑命令 + 计划评审 | 检查器只验格式与结构（判据齐全/判定不缺/证据非空/partial 有签接受），不证证据真假 |

完整边界见 `references/07-边界与自证.md`。**不要**把边界写成“已经解决”。

## 3. 先选流程 preset（阶段与出口）

| preset | 什么时候用 | 阶段序列 |
|---|---|---|
| `waterfall` | 需求明确、返工昂贵 | 需求→设计→实现→评审→交付 |
| `prototype` | 先做原型再决定 | 探索→加固（需求+设计+实现+评审）→交付 |
| `incremental` | 多条线并行 | 需求+设计→实现→评审→集成 |
| `agent-driven` | 一个 agent 主导实现、人只做签字与门禁 | 定框→实现→验证→评审→签字→交付 |

写进 `.sdo/01-计划.md` 的「阶段」段；每段结束过出口判据表，没过不开下一段。`agent-driven` 的 46 条判据里有 13 条 `agent.*` 是**流程自检项**（看 agent 行为，不看业务正确性）。细节见 `presets/`。

## 4. 目录约定（签后可追加，签前可改）

```
.sdo/
  00-意图.md          立项：目标/非目标/三条保证/判据/假设/待确认
  01-计划.md          里程碑、卡表、依赖边、写域
  cards/<M>-<n>.md    一卡一文件（必需四段：判据/证据/判定/评审；其余建议段）
  台账.md             偏差台账：gap / defect / explain，7 列
  sign/<S号>.md       人签记录（复述 + 选项 + 时间 + 被签对象）
  readings/<M>.md     里程碑读数（命令 + 输出摘要 + verdict）
  review/<M>-计划.md  计划评审记录
  gates/<M>.md        阶段出口勾选表（与读数分开：读数门要 overall）
  notes/<M>-使用笔记.md  preset 使用体验与改进建议（M5 起）
  看板.md             卡板快照（可选；view.mjs board 现生成也行）
```

模板在 `templates/`，第一次用直接拷出来改。

## 5. 七步主循环
1. **立项**：写 `00-意图.md`；复述给真人、问签（§6）；**没签不动工**。
2. **计划**：写 `01-计划.md`（preset + 卡表）；按 `references/04` 做计划评审；改完请人签。
3. **开卡**：一卡一文件；判据可判死、假设、预览、准入。证据表分「命令与输出」「判定」——**证据只接受脚本生成**（`card.mjs evidence --run` 写 `exit=<code>` 或「未跑待复跑」；手填 `pass`/`ok`/`done`/`已通过`/空 会被拒）；判定由评审填。M5-2 起 done 卡每条判据还要有「## 变异」行（`expected=red actual=red`）或「不可变异：理由」+评审确认；`card.mjs mutation` 在临时副本跑，不碰工作树。
4. **执行**：按卡改；写域外先问；**一卡两笔提交**（产物一笔、卡与台账一笔）；无 git 时写「提交：无（无版本库）」并说明靠 mtime 审计。
5. **多轮评审**：每轮判「可收卡 / 改完再审 / 拒绝」；done 卡每条判据有合法判定，评审段有「评审者：」；改完送同一席位复认，**轮数不设上限**，直到「可收卡」（`references/03`）。
6. **人签收卡**：复述 + 三选项；签完写 `.sdo/sign/S<n>.md`，卡置 done。
7. **里程碑门**：跑读数（`references/05`）写 `.sdo/readings/<M>.md`；请人签门，partial 也照写。

## 6. 人签协议（唯一合法的人证方式）
- 用 agent 的“提问并给选项”能力（不同的 agent 名字不同；只能纯文本对话时就写三个编号选项让对方回数字），选项固定三种：**签：复述准确** / **改：复述不准（请指出）** / **不签：先不做**。
- 复述含四件：**范围**、**被签对象**（commit 或文件哈希）、**判据判定**（pass/partial/fail）、**已知边界**。
- 真人不在 ⇒ **阻塞**；不许模型自答，不许把“我问过”写成“签过了”。每次签字落文件：时间、选项、被签对象、未决项、谁签的。

## 7. 判据即门禁
- 一条判据要能判死：**“当 X 时，Y 必须成立”**，并给 1 个正例 + 1 个反例（反例要能真的红）。
- 三态：pass / partial / fail。partial 必须写“缺什么、何时补、谁认”。
- 门禁 = 勾选表 + 命令证据：**没有命令或文件:行的 pass 不算 pass**。
- 每个“绿”先问：**改回去会不会也绿？** 会 ⇒ 证据无效（变异红证，见 `references/03`）。卡面变异结果行是声明，检查器不能证明真跑过；评审须复跑，核对卡号与判据一致。

## 8. 偏差台账（防止“这样也行”）
- 每个绕过、缺口、口径变化记一行：`D-<号> | kind | 位置 | 现象 | 影响 | 处置 | 状态`。
- kind：`gap`（缺）、`defect`（做错）、`explain`（口径解释）。不记 = 没发生；改口径标 `superseded` 并保留旧行（旧行不改，由新行取代）。

## 9. 评审（多轮制，不设上限）
- 评审者必须是**没写这段的人/会话**（“非作者”即可，复用现有席位，不必新开）。判词三选一：**卡评审=可收卡 / 改完再审 / 拒绝**，**skill/提交评审=可提交 / 改完再审 / 拒绝**；问题分 P0–P3，每条带 `文件:行号` 或可复现命令。“可以提交”只对**它看过的那棵树**成立；改一行就要复认。

## 10. 参考资源（按需加载）

| 文件 | 什么时候看 |
|---|---|
| `references/01-真源与账本.md` | 建目录、写账本、对账、id 规则 |
| `references/02-判据与门禁.md` | 写判据、三态、勾选表 |
| `references/03-签字与评审.md` | 人签、多轮评审、变异红证 |
| `references/04-计划与卡.md` | 计划评审八项自检、卡面字段、依赖与写域 |
| `references/05-读数与里程碑门.md` | 读数格式、树冻结、哈希、门签 |
| `references/06-偏差台账.md` | kind、7 列、编号、口径统一 |
| `references/07-边界与自证.md` | 边界、四条「挡不住」、两条硬阻塞 + 一条降级 |

## 11. 检查器与快捷视图（门禁用）

```bash
node <skill>/scripts/check.mjs [--presets|--all]  # 台账/表格/签字/卡/读数；--presets 比对快照，--all 连仓库其它 .md
node <skill>/scripts/gate.mjs [--list|G_req_exit]  # 阶段门：默认判所有勾选表；--file/--json 可用；exit 1/2
node <skill>/scripts/view.mjs <view>|next  # 六个只读视图；next=能开工什么（五节，未知状态 exit 1）；均支持 --json
node <skill>/scripts/ledger.mjs add|close|list              # 台账唯一写入口：add/close 只追加行、旧行不改；list 只读（--open）
node <skill>/scripts/card.mjs new|evidence                 # 卡骨架与证据行：同判据一行、重复原地更新；--run 真跑（30s 超时）
node <skill>/scripts/sign.mjs draft --milestone M4          # 签字材料 draft：只出事实到 stdout、不写文件；退出码 0/1/2
node <skill>/scripts/archive.mjs archive|restore M3  # 归档/恢复里程碑；git mv 搬运，索引含逐文件 sha256；check 只读索引
node <skill>/scripts/check.mjs --plan [--milestone M4]  # 计划↔卡面漂移：卡表/依赖/写域/路径；漂移 exit 1，环境/参数 exit 2
```

`<skill>` 是这套流程包的实际目录（例如 `skills/sdo-flow`）。**收卡与出门前各跑一次**；红了先修，别绕过。

- 只查**格式与结构**，不判断证据真假；证据仍以“可复跑命令或 `文件:行`”为准。
- 需要 `node`；没有时退回人工（核对列数、字段、签字三字段），并在签字文件写“检查方式：人工”。
- 视图只读、只做拼接，不改产物。
- `gate.mjs` 判七件事：①表头必须有判定列；②表头必须有证据列；③每行有判据名或判定，判据不能没判定；④pass 的证据不能为空或占位（`gate.mjs` 只判空/占位，不判“是不是真命令”——命令形态靠评审）；⑤partial 的证据不能为空（“缺口”是否写清由评审判）；⑥preset 要求的判据齐全、core 三条必须 pass；⑦fail 行直接算问题，且有 fail/partial 时第 3 节必须有「选项：签：…」接受。它不判断证据真假，但会挡住“空证据 + pass”。

## 12. 收卡/收门前自检
1. 意图与计划都有签字文件？ 2. 选定 preset 且本阶段出口表填完？ 3. 每条判据都能判死？ 4. 每个判定都有命令或 `文件:行`？ 5. 台账记了？ 6. 有没有“模型自签/自审”混进来（评审者 = 作者？代笔没人确认）？ 7. 一卡两笔、且已脱敏？
