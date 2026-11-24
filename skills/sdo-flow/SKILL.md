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

一句话：**文件是真源，账本代替事件表，问答代替签名，命令代替门禁。** 本文只讲**项目管理流程本身**（顺序、判据、人签、多轮评审、偏差台账、读数门），产物都在 `.sdo/`（§4）；流程之外见 `README.md`。

## 1. 何时用 / 何时不用
- **用**：把流程带到别的会话/仓库，或不想为流程引入额外运行环境。**不用**：一次性小改动、已有更严格的合规流程（不要两套并行）。
## 2. 先看边界（读一遍再开工）
| 保证 | 这里怎么实现 | **挡不住什么** |
|---|---|---|
| 对齐 | 意图/复述文件 + 人签问答选项 | 没有密码学签名；同 uid 可以改文件 |
| 可审计 | 追加式 Markdown 账本 + 日期 + 出处 | 账本可改；只靠 git 历史与提交时间 |
| 防漂移 | 判据清单 + 可复跑命令 + 计划评审 | 检查器只验格式与结构（判据齐全/判定不缺/证据非空/partial 有签接受），不证证据真假 |

完整边界见 `references/07-边界与自证.md`；**不要**把边界写成“已经解决”。

## 3. 先选流程 preset（阶段与出口）
| preset | 什么时候用 | 阶段序列 |
|---|---|---|
| `waterfall` | 需求明确、返工昂贵 | 需求→设计→实现→评审→交付 |
| `prototype` | 先做原型再决定 | 探索→加固（需求+设计+实现+评审）→交付 |
| `incremental` | 多条线并行 | 需求+设计→实现→评审→集成 |
| `agent-driven` | 一个 agent 主导实现、人只做签字与门禁 | 定框→实现→验证→评审→签字→交付 |

**英文阶段 id（与 `presets/*.md` 的 `### <stage>` 同名同序）**。下面是段名清单，**不能直接抄进里程碑**（机检要求每段名带反引号，见紧随其后的可抄样例）：

```text
waterfall    : req → design → build → verify → deliver
prototype    : explore → harden → deliver
incremental  : req_design → build → verify → integrate
agent-driven : frame → build → verify → review → sign → deliver
```

里程碑「阶段」段里的行样例（反引号包阶段 id、`→` 连接）：

```text
阶段序列：`req_design`→`build`→`verify`→`integrate`
```

写进当前里程碑文件 `.sdo/milestones/<M>.md` 的「阶段」段（并写 `preset：` 与 `preset 选择理由：`）；每段结束过出口判据表，没过不开下一段。`agent-driven` 的 51 条判据里有 13 条 `agent.*` 是**流程自检项**（看 agent 行为，不看业务正确性；数量随 preset 演进，以 `presets/agent-driven.md` 为准）。细节见 `presets/`。**改 `presets/*.md` 前，先把仍在使用旧 preset 的活跃里程碑归档**；当前里程碑若就是变更发起者，须在其冻结段写 `preset 变更发起里程碑：M<n>`（恰好一行、未归档、且是当前里程碑）。`check --presets` 会点名未归档的使用者（`preset_change_requires_archive`），声明非法报 `preset_initiator_invalid`。

## 4. 目录约定（签后可追加，签前可改）
```
.sdo/
  意图.md             第 1 步建：cp templates/意图.md 后手填
  计划.md             第 3 步建：cp templates/计划.md 后手填
  milestones/<M>.md       第 3 步建：cp templates/milestone.md .sdo/milestones/<M>.md 后手填
  cards/<M>-<n>.md    第 4 步建：card.mjs new 生成
  baseline/           第 2 步建：mkdir + 从 templates/baseline.md 拆四份（见下）
  archive/<M>/        收口后：archive.mjs archive <M> 搬五类
  ledger/vol-<n>.md   轮转时：ledger.mjs rotate --to … 生成
  台账.md             第 1 步建：cp templates/台账.md
  sign/<S号>.md       第 7 步人签时建：cp templates/sign.md .sdo/sign/S<n>.md 后填
  readings/<M>.md     第 8 步建：cp templates/readings.md .sdo/readings/<M>.md
  review/<M>-计划.md  第 3 步建：cp templates/review.md .sdo/review/<M>-计划.md
  gates/<M>.md        第 8 步建：cp templates/gates.md .sdo/gates/<M>.md
  notes/<M>-使用笔记.md  M5 起可选：手写preset 使用体验
  看板.md             可选：view.mjs board 生成，或手写
```

模板在 `templates/`。空项目可直接运行 `node <skill>/scripts/init.mjs` 一次建好 `.sdo/` 的 18 项骨架（4 顶层文件 + baseline 四份 + 10 个目录）；幂等，`--dry-run` 只预览、`--force` 覆盖前打印清单。不要在**技能目录内部**（`sdo-flow/` 或其 `scripts/` 下）运行 `init.mjs`/`baseline.mjs init`：会得到 `nested_sdo_refused`、exit 2、零写入——技能目录是只读资产，`.sdo/` 必须建在项目根。

## 5. 八步主循环（每步：产物 / 命令 / 判据 / 常见错）

1. **立项**：产物 `.sdo/意图.md`（六节）与 S1 意图签。命令：`cp <skill>/templates/意图.md .sdo/意图.md` 后填；`node <skill>/scripts/check.mjs`。判据：人签问答通过、意图六节齐全、check 0 错。常见错：没签就开工；把愿望当可判目标。

2. **基线**：产物 `.sdo/baseline/` 四份（requirement/architecture/test-strategy/quality-risk）。**首选命令**：`node <skill>/scripts/baseline.mjs init`——生成四份**成品骨架**（各自最小合法，建完 `check` 0 错），并读 `templates/baseline.md` 做标题覆盖校验（模板标题 ⊆ 内置骨架，模板新增标题未同步 ⇒ `baseline_template_drift` exit 2 零写入）；已存在的文件跳过。手工路线（产物是骨架，需自行补成可判结构）：`templates/baseline.md` 是**一个含四小节的模板**，必须拆成四个文件；命令序列：
   ```bash
   mkdir -p .sdo/baseline
   awk '/^## 1\. requirement\.md/{on=1;next}/^## 2\./{on=0}on' <skill>/templates/baseline.md > .sdo/baseline/requirement.md
   awk '/^## 2\. architecture\.md/{on=1;next}/^## 3\./{on=0}on' <skill>/templates/baseline.md > .sdo/baseline/architecture.md
   awk '/^## 3\. test-strategy\.md/{on=1;next}/^## 4\./{on=0}on' <skill>/templates/baseline.md > .sdo/baseline/test-strategy.md
   awk '/^## 4\. quality-risk\.md/{on=1;next}on' <skill>/templates/baseline.md > .sdo/baseline/quality-risk.md
   node --input-type=module -e "import {baselineHash} from '<skill>/scripts/lib/hash.mjs';console.log(baselineHash(process.cwd()))"
   ```
   各节取模板对应编号段。**拆出来的是骨架，不是成品**：删掉 ```` ```markdown ```` / ```` ``` ```` 围栏、把 `<...>` 占位换成真实内容；`requirement.md` 至少 3 条 `### R-<号>` 且每条带 `- 验收：`，`architecture.md` 至少 1 条 `## ADR-1：`（数字编号，不是 `<n>`），`test-strategy.md` 保留表头并填 ≥3 行，`quality-risk.md` 的「质量属性」「风险登记」各 ≥1 条。填完后把算出的 `- 基线 hash：<64 位>` 写进当前里程碑冻结段。判据：check 校验四份格式与 hash；里程碑读到同一 hash。常见错：跳过基线直接写计划；改了基线却不追加签；骨架里的 `<...>` 未替换 ⇒ `structural_placeholder_left`。

3. **计划**：产物 `.sdo/计划.md` + `.sdo/milestones/<M>.md`（读数、门禁与判据、卡表、写域、阶段、冻结段）与计划签。**首选命令**：`node <skill>/scripts/milestone.mjs new <M> --topic "<主题>"`——硬编码生成六段骨架（`.0`–`.5`，冻结段带 `- 门禁：`/`- 判据：` 占位，**不写 `preset` 字段**；成功后按 `.sdo/计划.md` 实际表头**追加一行索引**（`preset` 列填 `—`、无 `<...>` 占位；已存在则跳过；计划文件不存在则不创建、只提示））；`node <skill>/scripts/milestone.mjs freeze <M>` 就地把冻结段 `hash:` 行写成 64 位（幂等，二次执行不变）。 `node <skill>/scripts/milestone.mjs declare <M> --gates G_a,G_b --criteria c1,c2 [--map "G_a=c1,c2"]` 只重写冻结段 `- 门禁：`/`- 判据：`/`- 门禁判据：`（一行一门，只渲染不校验内容）；**声明改完必须再跑 `freeze`**（`declare` 不动 `hash:` 行）。`--map` 里写了未声明的门或池外判据会先落盘，由后续 `check` 报。**应写映射**：不写则并集闭合，每个门会列出全部判据，极长且容易误填。索引行由 `new` 写入（七列，表头见 `templates/计划.md`；示例：`| M1 | 主题 | — | 待签 | — | .sdo/milestones/M1.md | 进行中 |`）；若计划文件缺失，按提示补建后再跑 `new`，否则 `view next`/门签找不到里程碑；**卡文件建好后保持 `status: open`**——`done` 会触发收卡规则（S1 人签、语义自检、证据与变异），冷启动阶段先别置 done；每个里程碑在阶段段自选 `preset：<名>` 并写 `preset 选择理由：`（≥8 字、非套话）。**口头授权≠流程放行**。命令：`node <skill>/scripts/check.mjs --plan --milestone <M>`；要在里程碑冻结段写 `hash:` 时，用 `node <skill>/scripts/check.mjs --plan --milestone <M> --print-frozen-hash`（`--print-frozen-hash` 只与 `--plan` 同用，输出完整 64 位）。**签前预期红码**：计划签写入前跑 `--plan` 会报「本里程碑尚无计划签（S<n> 计划）」并 exit 1——这是预期，不是格式错误。放行顺序：`--print-frozen-hash` → 写 `S<n>` 计划签 → 再跑 `--plan` 得 0 漂移。

   冻结段 hash 行的**精确形态**：独立一行、ASCII 冒号、无前缀、不加粗：

   ```text
   hash:<64 位小写十六进制>
   ```

   不是 `- hash:`，不是 `hash：`（全角），不是表格行。**除这一行外不要再出现任何其它 hash 行**（`- hash:`、表格行、全角冒号都算）：检查器只认 canonical 行，额外行会被忽略——被忽略不等于合规。迭代法：**先删掉该行** → 跑 `--print-frozen-hash` 得到 H → 追加 `hash:H` → 再跑一次 `--print-frozen-hash` 复核（应仍为 H）。读数表前写「探底：」段，逐行列出与读数表 `R<n>` 对齐的探底动作：

   ```text
   探底：
   - 探底 R44：在 `/tmp` 空项目跑 `init.mjs`，记录卡点数与额外读文件数
   - 探底 R45：`/tmp` 副本跑 `check --plan`，记录能否拿到完整冻结段 hash
   ```

   判据：0 漂移、计划评审记录存在、人签 S<n>。常见错：把口头“可以开工”当放行；把“改完再审”当判词；门禁/判据/阶段/hash 留 `<...>` ⇒ `structural_placeholder_left`；写中文/未知阶段 id ⇒ `phase_unknown`；已签里程碑缺 hash 行 ⇒ `frozen_hash_missing`。

4. **开卡**：产物 `.sdo/cards/<M>-<n>.md`。命令：`node <skill>/scripts/card.mjs new <M>-<n> --owner … --intent … --criteria "C1:结构:文字;C2:语义:文字"`；`--criteria` 每项是 `编号:类型:文字`（类型只 `结构`/`语义`/`边界`），多项用**分号**分隔，**禁止半角逗号**（逗号会被当成项内文字）。卡面 `write_scope` 与计划卡表写域同形：值不加引号、每项一个仓库相对路径，`skills/sdo-flow/` 下的文件可写相对该目录的路径（检查器按 `skills/sdo-flow/` 归一）。反例：写裸文件名 `calc.js` 会被计划侧归一成 `skills/sdo-flow/calc.js`，卡面再带引号 `"calc.js"` 会把引号并入 token，两边对不上。

  正例（同一 token）：
  - 计划卡表写域：`skills/sdo-flow/scripts/check.mjs`
  - 卡面：`write_scope: [skills/sdo-flow/scripts/check.mjs]`

  判据：判据表含「类型」列（结构/语义/边界）、写域与准入清楚、每条判据可判死。常见错：判据写“做好/合理”；缺准入依赖；用引号/逗号写 `--criteria`。

5. **执行**：产物实现文件 + 脚本证据。命令：`node <skill>/scripts/card.mjs evidence <卡> --criterion C1 --cmd '<命令>' --run`。判据：证据列以 `exit=<code>` 开头、写域外先问、一卡两笔提交。常见错：手填 `pass`/`ok`；用“我试过”代替可复跑命令。

   **黑盒复核（可选，按需开席）**：何时开——卡涉及交互/文档可读性/新命令，或计划评审判「需要外部视角」时；用 `templates/blackbox-task.md` 生成任务书，交给**无上下文**席位只读 `skills/sdo-flow/` 与任务指定的目标产物；产出放 `.sdo/notes/<里程碑>-黑盒记录-<n>.md`（原文保留、不改写）。视角问题由无上下文席位回答，**结论由评审者下**（黑盒不替代白盒）；n=1 只证记录存在且原文未改，不证视角逐项被回答。

6. **评审**：产物评审记录、判定、变异表。命令：`node <skill>/scripts/card.mjs mutation --card <卡> --criterion C1 --mutate '<改坏>' --expect '<应红命令>'`。判据：评审者非作者、判词三选一、有语义判据的 done 卡写 `- 语义自检：`、每条判据有 `expected=red actual=red` 或“不可变异+理由+确认”。常见错：改完再审后不复认；只看历史行不看最后判词。

7. **收卡/人签**：**git 是可选的**：有 git 时被签对象写 `git:<sha>`（需 HEAD/commit）；**没有 git 也能签**，`sign.mjs new` 写 `tree:<内容指纹>`（纯 Node，规则见 `lib/fingerprint.mjs`），不需要 `git init`，也不把外层仓库当锚点。产物 `.sdo/sign/S<n>.md` + 卡 status done。`sign.mjs draft` 有 git 时需要可解析的 `git HEAD`（先 commit）；无 git 时正常输出 `版本：tree:<指纹>`，不阻断。首行 `CLEAN`/`DIRTY`（仅 git 工作树脏检查）不变；锚点行：`SAME`/`DIFF`（tree 同/异）、`SAME`/`AHEAD n`/`BEHIND n`（git）、`NO_ANCHOR`（无锚点或两形态不匹配）；**形态不匹配绝不静默 SAME**。命令：`node <skill>/scripts/sign.mjs draft --milestone <M>` 取材料；`cp <skill>/templates/sign.md .sdo/sign/S<n>.md`，把 `<n>` 换成下一个编号（规则：`ls .sdo/sign | sort -V | tail -1` 取最大号；**新签** +1，如 S52 后写 `S53.md`；**追加签**用同号加字母 `S<n>-<A>`，不是继续加号），`范围`/`被签对象`/`判定`/`已知边界` 照 draft 填，`- 冻结段 hash：` **唯一来源是第 3 步 `--print-frozen-hash`**（draft 里的同名行只作核对，不一致以 `--print-frozen-hash` 为准并报错停下）；再由真人确认。判据：四要素齐全（范围/被签对象/判定/已知边界）、签署者是人、签后树不再动。前置：`--write-scope` 命中的文件必须**已存在且已入库**（有 git 时先 `git add/commit` 再 `sign.mjs draft`）；`TREE_MISMATCH`/`DIRTY` 报错末尾带「下一步：…」，照它做。常见错：模型自签；代笔无确认；“我问过”写成“签过”。

8. **读数/门**：产物 `.sdo/readings/<M>.md`、`.sdo/gates/<M>.md`、门签。命令：`cp <skill>/templates/readings.md .sdo/readings/<M>.md`（替换每行 `<M>`/`<命令>`/verdict）；`cp <skill>/templates/gates.md .sdo/gates/<M>.md`（替换 `<M>`、`<preset>`、`<gate-id>` 并按 preset criteria 逐条复制行）；然后 `node <skill>/scripts/check.mjs --trace`；`node <skill>/scripts/gate.mjs --file .sdo/gates/<M>.md`。判据：读数 overall 与逐条一致、gate exit 0、门签标题必须是 `# 签字 S<n> · M<n> 里程碑门`。门表行是 `判定：待判` 时不能过 gate——报错给出行号，按行填 `pass/partial/fail`，并补证据列（命令或 `文件:行`）。常见错：partial 改写成 pass；没跑 `--trace` 就送门。覆盖开关：`sign.mjs new --force` 只覆盖“未人签”草案（判定为空/待填/待签），已有人签判词的签文件拒绝覆盖；`gate.mjs init <M> --force` 覆盖前打印 `将覆盖：<文件>`，只重建门表生成物，不覆盖手写判定/证据内容；`readings.mjs init` 无 force（已存在跳过）。 **未签阶段 gate 预期红码**：`core 判据 <id> 不是 pass（partial）`、`<门> 有 partial 项（…）但本表第 3 节没有「选项：签：…」`——这是签前预期，不是流程坏了；签后由 `sign batch`/人签补齐第 3 节接受。

**不可机检项的归因**：语义正确性、架构合理性等机器证明不了的东西，由评审与人签负责；发现不了不是流程失败，不许因此返工流程——只补判据、补评审，不许把 partial 改成 pass。

### 5.1 基线四份与四向闭合
`requirement.md` 每条需求写成 `### R-<号> <标题>`，下面必须有 `- 验收：<可判语句>`；`architecture.md` 每个决策写成 `## ADR-<号>：<标题>`（含决策/备选/后果）；`test-strategy.md` 用「变更类型 | 测试技术」表；`quality-risk.md` 必须有「质量属性」「风险登记」两节。四份的哈希由 `scripts/lib/hash.mjs` 统一计算，写进里程碑冻结段的 `- 基线 hash：<64 位>`，基线一改就要追加签。
常见码与改法：

| 码 | 触发条件 | 怎么改 |
|---|---|---|
| `baseline_requirement_malformed` | `.sdo/baseline/requirement.md` 少于 3 条 `### R-<号>`，或某条缺 `- 验收：` | 补足三条需求并逐条写验收 |
| `baseline_template_malformed` | `templates/baseline.md` 缺失，或缺四小节/ADR 三字段/测试表头/质量风险小节/`- 验收：` 字段 | 修模板本身（不是改项目里的基线） |
| `basis_section_missing` | 新判据写了 `依据：§12.<n>`，但 `.sdo/意图.md` §12 没有该小节 | 补意图 §12 小节，或改判据依据编号 |
| `trace_orphan_card` | 活跃 done 卡没有 `references:`；已签里程碑冻结段声明「孤儿卡基线段」的历史卡豁免 | 给卡写 `references: [R-xx]`（或按里程碑 `认领需求：` 登记） |

需求、设计、实现、测试靠 `check --trace` 四向闭合：`trace_orphan_requirement`（需求没人认领）→ `trace_dangling_ref`（卡引用了不存在的需求）→ `trace_duplicate_claim`（同一里程碑多卡争认领）→ `trace_orphan_test`（done 卡没有可复跑测试引用）；另有 `trace_orphan_card`（done 卡没有 `references:`）与 `trace_test_unverifiable`（有文本但不合口径）。卡面用 `references: [R-01]` 认领，里程碑用 `认领需求：` 行登记；门签前 `--trace` 必须 0 问题。认领行样例（每条需求一行，或整段写「需求：无（理由）」）：

```text
认领需求：R-01、R-02
```

`--print-frozen-hash` **只算 hash、不校验漂移**，它不是计划合规证据；合规仍须 `check --plan --milestone <M>` 0 漂移 + 计划签。

### 5.2 六条硬约束锚点（评审只核锚点与自足性）
| # | 硬约束 | SKILL 锚点 | references 锚点 |
|---|---|---|---|
| 1 | 不代签：签字只由真人做 | §6 人签协议 | `references/03` §2 问答即签字 |
| 2 | “改完再审”不是判词 | §9 评审（判词三选一） | `references/03` §3 多轮评审 |
| 3 | 证据只由脚本写 | §5 第 5 步（`evidence --run`） | `references/04` §2 卡面字段（证据） |
| 4 | 口头授权 ≠ 流程放行 | §5 第 3 步（只认签字文件） | `references/04` §1 计划评审 |
| 5 | 判据表必须有「类型」列 | §5 第 4 步（结构/语义/边界） | `references/04` §2 卡面字段 |
| 6 | done 卡要有变异证据 | §5 第 6 步（`expected=red actual=red`） | `references/03` §4 变异红证 |

## 6. 人签协议（唯一合法的人证方式）
- 用 agent 的“提问并给选项”能力（不同的 agent 名字不同；只能纯文本对话时就写三个编号选项让对方回数字），选项固定三种：**签：复述准确** / **改：复述不准（请指出）** / **不签：先不做**。
- 复述含四件：**范围**、**被签对象**（commit 或文件哈希）、**判据判定**（pass/partial/fail）、**已知边界**。
- 真人不在 ⇒ **阻塞**；不许模型自答，不许把“我问过”写成“签过了”。每次签字落文件：时间、选项、被签对象、未决项、谁签的。

**追加签**：同一对象需再签一次时，新增 `S<编号>-<A…Z>.md`（如 `S20-A.md`），旧签字文件不改；换了树或范围用新编号。

## 7. 判据即门禁
- 一条判据要能判死：**“当 X 时，Y 必须成立”**，并给 1 个正例 + 1 个反例（反例要能真的红）；三态 pass/partial/fail，partial 必须写“缺什么、何时补、谁认”。
- 门禁 = 勾选表 + 命令证据：**没有命令或文件:行的 pass 不算 pass**。
- 每个“绿”先问：**改回去会不会也绿？** 会 ⇒ 证据无效（变异红证，见 `references/03`）。卡面变异结果行是声明，检查器不能证明真跑过；评审须复跑。审签批次一次问答最多合并 **3** 项，每项独立成 `S<n>.md`；`sign.mjs batch <M>` 只把 ≤8 行草案写 stdout（含范围/被签对象/判定/已知边界），不落盘。

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
| `references/08-归档与版本.md` | 归档/恢复、INDEX、`archive_*` 码、`currentMilestone` |

## 11. 检查器与快捷视图（门禁用）
```bash
node <skill>/scripts/check.mjs [--presets|--all]  # 台账/表格/签字/卡/读数；--presets 比对快照（改 preset 前先归档使用者；含 preset_change_requires_archive / preset_initiator_invalid / criterion_without_basis / basis_section_missing），--all 连仓库其它 .md
node <skill>/scripts/gate.mjs [--list|G_req_exit]  # 阶段门：默认判所有勾选表；--file/--json 可用；exit 1/2
node <skill>/scripts/view.mjs <view>|next  # 九个只读视图；next=能开工什么（五节，未知状态 exit 1）；trace=需求→卡引用原型；均支持 --json
node <skill>/scripts/ledger.mjs add|close|list|rotate|reindex  # 唯一写入口；rotate 整卷改名+新空卷，reindex 重建索引
# 硬规则：活跃卷 >1000 行或收口必须 rotate；check 对活跃卷 >5000 行 WARN（不阻断）
node <skill>/scripts/card.mjs new|evidence  # 卡骨架/证据行；--run 真跑（30s）
node <skill>/scripts/sign.mjs draft --milestone M4  # 签字材料 draft：只出事实、不写文件
node <skill>/scripts/archive.mjs archive|restore M3  # 归档/恢复五类；INDEX 是登记处，check 只读索引
node <skill>/scripts/check.mjs --plan [--milestone M4]|--deep|--trace --js|--help  # 计划漂移/卷审计/追溯链/用法；trace 与 plan/deep 互斥
```

`check --trace` 的读法：四码按固定顺序 `trace_orphan_requirement` → `trace_dangling_ref` → `trace_duplicate_claim` → `trace_orphan_test`（另有 `trace_test_unverifiable`、`explore_conclusion_malformed`），命中任一即 exit 1，但一次报全；`trace_orphan_test` 只报“证据行缺失/命令为空”，有文本但不合口径报 `trace_test_unverifiable`，两码互斥。`--trace` 与 `--plan` 互斥，未知 flag exit 2。**`check` 默认不跑 trace**（避免把追溯链绑进日常格式检查）；门签前必须单独跑 `node <skill>/scripts/check.mjs --trace` 并达到 exit 0、0 问题。`需求数/已覆盖数/卡引用数/孤儿需求数/孤儿卡数` 五行证明真的扫过。默认只对 `done` 卡强制闭合，open 卡只列不判。`测试引用基线段`（M8.5）里列出的历史里程碑 done 卡不回溯判测试引用；基线段只认 `.sdo/milestones/M8.md` 的行首声明。

`view state` 走索引，索引损坏/不一致 ⇒ exit 2（要一致性）；`ledger list --open` 直接读正文，索引坏了仍可用（要可用性）。这是 S45 边界 2。
`<skill>` 是这套流程包的实际目录（例如 `skills/sdo-flow`）。**收卡与出门前各跑一次**；红了先修，别绕过。
路径优先级：项目内 `skills/sdo-flow` 优先，否则用脚本自身目录；两处并存以项目内为准。缺 `.sdo/意图.md`、`.sdo/台账.md` 或 `.sdo/baseline/*.md` 时，脚本输出 `SDO_E_MISSING_*` 与可复制的 `cp` 命令，不用读源码。

- 只查**格式与结构**，不判断证据真假；证据仍以“可复跑命令或 `文件:行`”为准。
- 需要 `node`；没有时退回人工（核对列数、字段、签字三字段），并在签字文件写“检查方式：人工”。
- 视图只读、只做拼接，不改产物。
- `gate.mjs` 判七件事：①表头必须有判定列；②表头必须有证据列；③每行有判据名或判定，判据不能没判定；④pass 的证据不能为空或占位（`gate.mjs` 只判空/占位，不判“是不是真命令”——命令形态靠评审）；⑤partial 的证据不能为空（“缺口”是否写清由评审判）；⑥preset 要求的判据齐全、core 三条必须 pass；⑦fail 行直接算问题，且有 fail/partial 时第 3 节必须有「选项：签：…」接受。它不判断证据真假，但会挡住“空证据 + pass”。
## 12. 收卡/收门前自检
1. 意图与计划都有签字文件？ 2. 选定 preset 且本阶段出口表填完？ 3. 每条判据都能判死？ 4. 每个判定都有命令或 `文件:行`？ 5. 台账记了？ 6. 有没有“模型自签/自审”混进来（评审者 = 作者？代笔没人确认）？ 7. 一卡两笔、且已脱敏？

- `gate_criteria_undeclared_legacy`：历史豁免列表内的旧里程碑缺声明（WARN，不追溯）；`gate_criteria_undeclared_legacy_malformed`：豁免行格式错（只允许 M 编号列表）。
