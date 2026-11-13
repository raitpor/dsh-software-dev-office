# 设计评审记录

> 本文件是 `design/` 的评审台账：每条发现都给**处置**与**落点**，避免"已通过"只剩 commit 信息作证。

**谁写的、谁审的（独立性怎么判）**：

- **作者**：本仓库的全部文档改动与 `git` 提交都出自**实现会话**；判口径是"谁实际改写了被评审的内容"。
- **评审**：各轮由**另一个会话**执行。它的工具面与作者**同构**——含 `write`/`edit`/`bash`，sandbox 同为 `workspace-write`。所以**不能说它"只读"，也不能说它"没有写权限"**。准确说法是：这些轮里它**一次也没调用写工具**，只做读/检索与一次性验证（在临时目录重建图表再比对，随后删除），**没有改写任何被评审文档，也没有产生提交**。
- **这条要诚实**：独立性是"事后可核对的痕迹"（仓库里没有它的改动），不是"它在权限上写不了"。要更强的独立性，应当给评审会话真正只读的 sandbox，而不是在台账里写"只读"。
- 判定口径：**看"谁改了文件"，不看"谁写过记忆"**。记忆节点的会话字段只说明"这条记忆是谁写的"，不能当作者身份用。

> 具体会话标识与工具调用计数属本机信息，**不入库**（需要追溯时查本地会话记录）。

## 1. 评审一（2026-11-02，评审会话）

**起点**：G1–G5 全 A 之后的第一版 design。**结论**：经四轮迭代，从 6 个 P0 收到 0 个阻断项，通过。

| 发现 | 处置 | 落点 |
|---|---|---|
| P3 两段式图有旁路边、幂等与 `will_change` 在事务之后 | 重画单链；幂等前移到读 preview 后；`will_change` 移到事务前 | `design/03` §4、`p3-two-phase-pad.dot` |
| Agent 的 7 天规则写成"唤醒" | 改 `parked` 自环（标 `stale`，不杀不唤醒） | `uml-state-agent.puml` |
| G2 派生列落点三处不一致（L1/L2） | 统一到 L1 fold/hash | `design/01` §9、`design/02` §6、`docs/14` |
| 类图新增跨聚合实线；组件图 L1 直连实现 | 跨聚合改虚线；组件图只连端口，补 `SignerPort` | `uml-class.puml`、`arch-components.puml` |
| P1 判据注册重复预检、无事务边界 | 删重复预检（只映射 `UNIQUE` 错误码）、补事务 | `design/03` §2 |
| 事件映射只有出口没有生产者 | 补 `review.round_closed`、`release.frozen`、新增 `release.delivered`/`verify.failed`；拒绝事件按"是否换状态"分类 | `docs/02`、`design/03` P4/P8/P9/P10 |
| P9 只查 4/10 | 扩成 A/B/C/D 四组覆盖 `docs/02` §14 十项 + G1/G5 + kind 闭包 | `design/03` §10 |
| P8 缺冻结前置、签字写成 `decision.valid` | 补前置四条 + 快照 verify；签字改 `decision.valid` + `decision.signed` | `p8-release.puml`、`design/03` §9 |
| `human_sign` 后二次 confirm 会再次命中 | 增 5.1「本 preview 已有有效签字」分支（按 `payload_hash + frontier` 匹配） | `p3-two-phase-pad.dot`、`design/03` §4 |
| 矩阵一行多不变量 / `verify` 当守卫 | 改 4 列（不变量/唯一守卫点/审计/类型），拆行；R25 强制 | `design/02` §5、`design/check.py` |

## 2. 评审二（2026-11-02 至 11-03，评审会话）

**起点**：产品定义改成三条保证、假设机制、24 条判据之后。**结论**：经四轮，通过；没有阻断项。

| 发现 | 处置 | 落点 |
|---|---|---|
| 第 2 条保证写成"不许静默选"，机制做不到 | 改成"**已声明的假设必须处置；未声明的选择不可检测**（靠评审/红队抽样）" | `docs/01` §1 |
| 第 1 条保证写成"东西是对的"，越界 | 拆成"记录忠实（可机械保证）+ 按判据做对（条件保证）" | `docs/01` §1 |
| `blast_radius` / assumption 状态没有存储落点 | `spec` 补 `status`、`blast_radius`、`is_core`；`status` 是投影；两个 `CHECK` | `docs/03`、probe 的建表脚本 |
| `is_core` 无定义 | 定义为 `risk_flags` 非空自动真，其余只能人标 | `docs/03`、`docs/04` |
| probe 不测 assumption | 新增第 13 项形状探针（16 → 17 PASS） | `probe/run.py` |
| probe 只测形状，别读成整套已验证 | `REPORT` §四显式声明状态机未覆盖 | `probe/REPORT.md` |
| 概念表 `spec` 行漏 `assumption` | 补 kind 列表 | `docs/01` §18 |
| `design/README` 状态自相矛盾 | 统一为"已通过，可进实现"，并指向本文件 | `design/README.md` |

## 3. 评审三（2026-11-03，评审会话）

**起点**：policy 定为 preset、P15 配置冻结、`artifact_kinds` 进 baseline 之后。**结论**：配置面方向正确；指出 1 个 P0 + 5 个 P1。处置后复评（§4）确认 P0 与 P1-1 已修好，P1-2 只修了一半、另追出 2 个 P1。

| 发现 | 处置 | 落点 |
|---|---|---|
| P0 空 gate 真空通过（`all_of` 空集为真） | `all_of` 空集 ⇒ `fail`；P15 校验加"每 gate ≥1 判据"（`gate_empty`） | `docs/04` §6、P15 |
| P1 `freeze` 被 release 与 baseline 共用，`scenarios_run` 必填冲突 | 新增 `decision_kind='baseline'`；P15 签 `baseline`，`freeze` 只用于 release；P9 检查只约束 `freeze` | `docs/06` §5.1/§5、P15、P9 |
| P1 换 baseline 后历史判定全红（拿判定 hash 与"当前"比） | 改为对"该判定引用的那版"对账；写清在飞卡用旧尺、release 必须声明 `baseline_hash`、旧尺通过的卡进新版本必须重判 | `docs/04` §5.2、P15 |
| P1 README 说"遗留项收口"但 REVIEW 列了 3 项未覆盖 | README 改为"配置面已通过；3 项未覆盖见 REVIEW §3" | `design/README` |
| P1 P15 不在里程碑 | `docs/09` M1 加 baseline 冻结 + 校验器 + 判死读数（空 gate 被拒） | `docs/09` §16.2 |
| P1 "核心不可关"与保证表互相拆台 | 拆成"机制必须记"与"判据可降级"；core 判据必须出现在每个 policy 的 gate 集，P15 校验 | `docs/08` §1 |
| P2 `engine` 漏在 P15 组 baseline | 补 `engine{version, criteria_manifest_hash}` | P15 |
| P2 `artifact_kinds` 缺 `throwaway` | 示例补全；覆盖规则改为按**枚举键**校验 | `docs/08` §1、P15 |
| P2 baseline 视图列不全 | 补 `thresholds/switches/assurance/engine/artifact_kinds` | `docs/05` |
| P2 图里 `policy = all_of?` | 改为 `policy_mode = all_of?` | `p2-gate-ns.dot` |
| P2 probe 注释写"G6 兜底" | 改为"DB 兜底；G6 是 gate id" | `probe` 建表脚本 |
| P2 "十三类漂移" | 改为十四类（R0a–R0d + R19–R28） | `design/README` |
| P2 `sdo_act` 没有 baseline 冻结动作 | 定义 `action='baseline_freeze'`（校验→`baseline.rejected` 或转 `request_sign`；"两段式"在 §4 P1-C 才补齐） | `docs/05` §1 |
| P2 冻结失败不落事件（不可追溯） | 落 `baseline.rejected(reason_code)`；登记进事件表 | `docs/02`、P15 |

## 4. 评审四（2026-11-03，复评）

**起点**：`4236edf`（空 gate、`decision_kind='baseline'`、尺子版本语义、core 绑定）之后。**结论**：P0 与 P1-1 真修好；P1-2 只修了一半；另指出 2 个新 P1 + 5 个 P2。全部核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-A `docs/02` 的 verify 仍拿"当前 baseline"比 | 改为"只核对它引用的那版：存在、已冻结、可复算"，**明确不与当前比**；`review.*` 的"当前"标成**评审时点**，`mandate.revalidated` 标成**重开时点**（两者故意不同） | `docs/02` §14、`docs/04` §4/§5.2、`design/03` §3/§15 |
| P1-B release 没真正绑 `baseline_hash` | `release` 表加 `baseline_hash`；冻结前置加第 ⑤ 条（不一致 ⇒ `baseline_mixed`）；`docs/09` §3 加第 7 条；`release.frozen` 记这个值；不变量矩阵加一行 | `docs/09` §2/§3、`design/03` §9、`design/02` §5 |
| P1-C `baseline_freeze` 不是两段式，影响面没进签名 | 改成**两段式**（preview 出 `will_change` + `guarantee_delta` + `payload_hash`，confirm 绑 hash）；签名 payload 加 `will_change_hash` 与 `guarantee_delta`；缺 `guarantee_delta` 不可签发 | `docs/05` §1、`docs/06` §5、`design/03` §16 |
| P1-D core 判据没有清单 | 按名字钉死三条：`spec_set.signed`、`assumption_set.signed`、`provenance.present`；写明**"防篡改"由 `verify` 与表约束承担、不算判据**（否则它就成了可解绑的配置） | `docs/04` §5.2 第 6 条、`docs/08` §1、P15 ⑤ |
| P2 校验器写"五条"（实际 ①–⑧ 八条） | 改八条 | `design/03` §16 |
| P2 README 同一句自相矛盾、指针错 | 改为"三、四轮遗留已收口；3 项未覆盖见 §5" | `design/README` |
| P2 把评审会话写成"只读、没有写权限"不实 | 改为"另一会话、有写能力但未改文件、未产生提交"，并写明更强的独立性要靠只读 sandbox | 本文件开头 |
| P2 `stale_fail` 与"在飞卡用旧尺判完"冲突 | 只在"判定用的 baseline ≠ 该 `stage_run` 记录的 baseline"时红；**"存在新 baseline"本身不触发** | `design/03` §3 |
| P2 `baseline` 的 `proposition` 没定义 | 定死句式：N 个 stage / M 个 gate、收紧 X、放松 Y、保证 1/2/3 各维持或降级 | `docs/06` §5、P15 |

## 5. 评审五（2026-11-03，复评）

**起点**：`d3aa2cd`（4 个 P1 修复）之后。**结论**：上一轮 4 个 P1 确认真修好；新指出 **3 个 P1 + 5 个 P2**，其中 P1-1 是结构性的（配置 schema 缺 `kind`）。全部核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-1 policy 的 stage 没有 `kind`：`applies_to` 的词表是 `requirement/design/implement/review/deliver`，preset 的 stage 名是 `req/build/verify/explore/harden`，两套词汇没接缝 ⇒ `na`、`na_stages[]`、保证表"harden 起恢复"全部悬空 | stage 加 **`kinds[]`**（五 kind 的子集，可多值：`harden` 同时承担 requirement/design/implement）；`applies_to` 按 kind 匹配；`na_stages[]` 由"缺哪个 kind"推出；三个 preset 的 DAG 标出每段 kinds；`stage_run.stage` 只存 id、kind 经 baseline 反查；`kinds` 进 hash | `docs/04` §4.1/§5.1、`docs/08` §1、`docs/03` stage_run、`docs/05` baseline 视图、`docs/09` M1、`design/01` §9、`design/03` P15 |
| P1-2 `assumption_set.signed` 在同一页被写成"非 core（可以不绑）"与"core（必须绑）" | 非 core 例子换成 `assumption.disposed` / `design.alternatives_declared`；保证表那行改成"不绑 `assumption.disposed` ⇒ 保证 2 降级（**签名集合仍由 core 的 `assumption_set.signed` 保**）" | `docs/08` §1 |
| P1-3 core 判据"绑在 `na` 阶段"也过校验（绑了 ≠ 查了） | P15 ⑥ 改为"必须**各有一个** gate，且 `stage` 的 `kinds` 与判据的 `applies_to` 有交集"（`core_not_effective`）；policy 结构上缺该 kind 时必须在 `guarantee_delta` 里显式降级（`core_waived_unstated`）；矩阵加两行 | `docs/04` §5.2 第 6 条、`design/03` P15、`design/02` §5 |
| P2 "两处是同一组前置（§3 七条全覆盖）"不准确 | 改成"§3 七项在本文都有落点；**前置五条只覆盖其中五项**，scenario 与快照是步骤 4/5，不在前置里" | `design/03` §9 |
| P2 release 级判据可能复用旧尺下的判定 | 明确 **7 条 release 判据一律在冻结时点现算**，用 release 声明的 `baseline_hash` | `design/03` §9 |
| P2 台账少算本轮 | 记为第五轮；结论措辞逐项点名，不写"遗留项已收口" | `design/README`、本文件 |
| P2 台账把评审会话的工具面写窄了 | 工具面与作者**同构**（含 `write`/`edit`），这几轮**未调用写工具**；独立性靠仓库痕迹，不靠权限声明 | 本文件开头 |
| P2 "只能收紧、永不放松"对二值判据没意义 | 改为"**只能保留或加强，永不删除或放宽**" | `docs/04` §5.2、`docs/08` §1 |

## 6. 评审六（2026-11-03，复评）

**起点**：`335368f`（stage `kinds`、core 适用性、非 core 清单）之后。**结论**：上一轮 3 个 P1 确认真修好；新指出 **3 个 P1 + 5 个 P2**，全部落在"新引入的配置元数据"上。核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-1 `guarantee_delta` 没有推导规则（工具无法判断某条保证是保持还是降级）、校验顺序倒置（第 2 步要 delta、delta 第 4 步才产出）、首次冻结没有"上一版" | 判据加 **`保证` 元数据**（`docs/04` §4 新增一列，`—` = 守机制完整性）；delta 由"该保证下的判据是否**有效绑定**"机械算出；P15 第 2 步**先算 delta 再校 core**；命题句式把"相对上一版"只留给 `will_change`，delta 改**绝对判定**，首次冻结写"首次"；手写 delta 一律忽略（第七轮进一步要求有效绑定：`all_of` + 不可豁免，见 §7） | `docs/04` §4/§5.1、`docs/06` §5、`docs/08` §1、`design/03` P15、`design/02` §5 |
| P1-2 `prototype` 的 `harden` 缺 `review` kind，与"harden 补评审""harden 全量"自相矛盾；`na_stages` 实际应为 `[review]` | `harden` 补 `review`：`[requirement, design, implement, review]`（五个 kind 齐 ⇒ `na_stages` 为空）；§5.2 里"prototype 不承担 requirement"的过时例子换成**只做实现与交付的 lite** | `docs/08` §1、`docs/13`、`docs/04` §5.2 |
| P1-3 P15 说"stage DAG 无环"，但 schema 里没有边（`stages[]` 只是列表 ⇒ 必然无环，校验空转）；`incremental` 的 lane 也无处表达 | stage 加 **`after[]`**；P15 ② 校验每条边指向存在、无环、全部可达；`incremental` 的 lane 明确为**派发层并行、不进 policy**；`req+design` 改名 `req_design` | `docs/08` §1、`docs/04` §4.1/§5.1、`docs/05`、`docs/01`、`design/01` §9、`design/03` P15、`design/02` §5 |
| P2 `req+design` 里的 `+` 容易被读成语义 | 改 `req_design` | `docs/08`、`docs/13` |
| P2 `na_stages` 名不符实（值是 kind） | 字段名保留，注释写死"元素是 **kind**，不是 stage id"（§4.1 与 P15 ⑨） | `docs/04`、`design/03` |
| P2 首次冻结的 delta 口径 | delta 改绝对判定；"相对上一版"只用于 `will_change`，首次写"首次" | `docs/06` §5、P15 |
| P2 轮次少算 | 本轮记为第六轮；README 改六轮、指针 §7 | `design/README`、本文件 |
| P2 未提交就写"处置完毕" | 上一版已提交（`335368f`）；本轮改动随下一次提交落库后再算收口 | — |

## 7. 评审七（2026-11-03，复评）

**起点**：第六轮之后的改动（`guarantee` 列、delta 推导、`after` 边、prototype 的 `review` kind）。**结论**：上一轮 3 个 P1 确认真修好；新指出 **3 个 P1 + 6 个 P2**，全部是"有效绑定只到 stage 适用"这一层不够。核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-1 core 绑在 `any_of` 门或可豁免 gate 上也算"有效"：门里别的一条绿了就放行、一纸 waiver 就过 | 定义 **有效绑定**五条（已注册 / 在 gate 的 `criteria[]` 里 / stage 适用 / `policy_mode='all_of'` / `waivable=false`）；P15 ⑥ 按它拒冻；delta 只把有效绑定算"保持" | `docs/04` §5.2/§6/§4、`design/03` P15、`design/02` §5 |
| P1-2 `work_unit.evidence_consistent` 是复合外键（P2 不执行）却挂保证 3 ⇒ **任何 policy 的保证 3 都永远降级** | 保证列改 `—`；写明 `—` 有两类：守机制完整性的、**表约束型**的（插入即拦、永远生效，绑不到 gate 上，故不参与判定） | `docs/04` §4 与列说明 |
| P1-3 preset 只给了 gate id、没给 `criteria[]` ⇒ **三个 preset 原样冻结一个都过不了 P15**（④每 stage 有 gate、⑤每 gate ≥1 判据），保证表没有支撑 | `docs/08` 补 **§1.1 三个 preset 的 gate 目录**（每门 `criteria[]`/`mode`/`waivable`）；并把"每个 preset 都能冻出三条保证全保持 + core 有效绑定"做成**机器规则 R29**（解析 doc 数据复算，已做正反例测试） | `docs/08` §1.1、`design/check.py` R29、`design/README` |
| P2 `after` 的"入口"没定义（多根时是哪个） | 定义为「`after` 为空的 stage 集合」，允许多个根 | `design/03` P15 ②、`docs/08` §1 |
| P2 `guarantee_delta_mismatch` 校验的是不存在的输入（`baseline_freeze` payload 里没有 delta） | 删掉该错误码；**手写 delta 一律忽略**，以工具算出的为准 | `docs/04`、`docs/06` §5、`docs/09` M1、P15 |
| P2 `waivable` 粒度：§6 写"判据不可豁免"，schema 里是 gate 字段 | 明确**gate 级**；§6 的措辞改掉 | `docs/04` §6 |
| P2 新注册判据不带 `guarantee` 会让 delta 漏项 | 注册门槛 **四→五条**（`guarantee_required`）；P1 判定表加一列，拒码登记 | `docs/04` §2、`docs/03`、`design/03` P1、`design/01` §7 |
| P2 prototype 保证 3 那行没写"harden 起恢复" | 补上（harden 承担 `review` kind） | `docs/08` §1 保证表 |
| P2 轮次少算 | 本轮记为第七轮；状态指针改 §8 | `design/README`、本文件 |

## 8. 评审八（2026-11-03，复评）

**起点**：第七轮之后的改动（有效绑定五条、表约束判据改 `—`、preset gate 目录、R29）。**结论**：上轮 3 个 P1 确认真修好；新指出 **2 个 P1 + 5 个 P2**，其中一个是「检查器与错数据互相背书」。核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-1 core 与 lite 自相矛盾：一处说「core 没有效绑定就拒冻」，另一处说「缺 kind 的 lite 可在 delta 里写降级、由人签字」，P15 里两条并存（后者那支永远到不了） | **选 A：core 强制**——删掉「写降级就放行」的分支（`core_waived_unstated` 作废）；lite 例子改成 `req[requirement] → build[implement] → deliver[deliver]`：缺 `design/review` ⇒ 保证 1/3 由 delta 算出降级，但 core 三条仍在；`docs/08` 的 core 段同步删掉同一条后门 | `docs/04` §5.2、`docs/08` §1、`design/03` P15 |
| P1-2 preset gate 写 `mode:`，schema 是 `policy_mode:`；R29 也只认 `mode:` ⇒ **检查器与被检查数据用同一个错字段，互相背书**（比缺字段更危险：它把错的判绿了） | 三份目录全部改 `policy_mode:`；R29 改读 `policy_mode:`，并**拒绝未知键**（只允许 `stage/criteria/policy_mode/waivable`），缺字段单独报；两条都做了反例测试 | `docs/08` §1.1、`design/check.py` R29 |
| P2 `node.integration_listed` 的 `applies_to` 含 `design`，但判据要「全部 connected + 有 evidence」，design 期不可能成立 | `applies_to` 收窄为 **deliver**（清单设计期就写，连通性只能交付前验）；preset 的绑定本来就在 deliver/integrate | `docs/04` §4.1 |
| P2 delta 规则仍写「绑在适用的 stage 的 gate 上」，没跟上 §6 的有效绑定 | 三处统一改成「达到 §6 的**有效绑定**」 | `docs/04` §4、`docs/06` §5、`docs/08` §1 |
| P2 `core_waived_unstated` 是死分支 | 删除（随 P1-1） | `design/03` P15 |
| P2 R29 没查 `guarantee` 值域与 `—` 的分配 | 加两条：值域强制 `{1,2,3,—}`（写错值不再被静默跳过，因为解析已改为取任意值再校验）；表约束判据 `work_unit.evidence_consistent` 必须 `—` | `design/check.py` R29 |
| P2 轮次少算 | 本轮记为第八轮；状态指针改 §9 | `design/README`、本文件 |

## 9. 评审九（2026-11-03，复评）

**起点**：第八轮之后的改动（core 强制、`policy_mode` 字段、R29 加固）。**结论**：上轮 2 个 P1 确认真修好；**本轮无 P0/P1**，剩 **2 个 P2 + 2 个流程项**。核实后：P2-1 已在第八轮修掉（报告引的是旧快照），P2-2 属实并已修，另两项按台账纪律处理。

| 发现 | 处置 | 落点 |
|---|---|---|
| P2-1 `node.integration_listed` 在 design 阶段必然红 | **上一轮已修**：`applies_to` 第八轮就收窄成 `deliver`（清单设计期写、连通性交付前验）；本轮再核一次，当前表里就是 `deliver` | `docs/04` §4.1 |
| P2-2 `review.required` 的 applies 写成 `review（也在 implement 复查）`，R29 按 `（` 截断 ⇒ implement 被静默丢掉 | `applies_to` 表改成**三列、第二列机器可解析**（只允许五个 kind + ` / `，备注放第三列，这就是漂移源）；`review.required` 明确写成 `review / implement`；`review.round_bound` 单列 `review`；R29 改成严格解析（非 kind 取值直接红），并补「有保证列却没 applies 行」的覆盖检查；另说明 prototype 的 explore 只承接低风险卡（高风险必须在 harden 收口） | `docs/04` §4.1、`docs/08` §1.1、`design/check.py` R29 |
| P2-3 轮次与提交 | 本轮记为第九轮；状态指针改 §10；"处置完毕"以提交状态为准 | `design/README`、本文件 |
| P2-4 R29 的反例只靠人跑过 | **写进检查器**：R29 末尾做三组自检（把含 core 的 gate 改成 `any_of`、改成可豁免、删掉一条 core 绑定），复算若仍全绿即报 `[R29-self]`——顺手用「把 `delta_errors` 改成恒返空」验证过：三组自检全部报警。反例从此不再依赖人记得跑 | `design/check.py` R29-self |

## 10. 评审十（2026-11-03，评审会话）

**起点**：作者自查那一版（`alignment` 模块、`Baseline`/`Policy` 类、R30）。**结论**：方向对，但 **OOM 只装了"谁是聚合根"，没装"聚合根里装什么"**；另缺三张协作图。指出 **3 个 P1 + 6 个 P2**，核实为真，已逐条处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1-1 `Baseline` 类只有 `policy`：`criteria/gates/thresholds/assurance/engine/frozenBy` 都不在类上，`validate(content)` 说不清校验了什么，`hash` 也证明不了覆盖范围 | 加 **`BaselineContent`** 值对象（policy/criteria/gates/thresholds/assurance/engine）+ `CriterionRef`（id/version/params/guarantee）+ `GateSpec`（stage/criteria/policyMode/waivable）；`Baseline *-- BaselineContent`，hash 覆盖后者；`Gate ..> GateSpec` | `design/diagrams/build.py`、`design/02` |
| P1-2 `Release` 类没有 `baselineHash`，P8 前置⑤ 在类模型里没有落点 | `Release` 加 `baselineHash`/`frontier`/`frozenBy`，`freeze(baselineHash)` | 同上 |
| P1-3 顺序图缺 P11/P12/P15：`alignment` 是新增模块却没有协作图，`Baseline` 是新增聚合却没有 P15 的协作图 | 新增 **`uml-seq-config`**（校验→preview→人签→freeze→落 amended/loosened）与 **`uml-seq-align`**（复述→假设→派发门→集合签字）；顺序图 5 → **7**，图 25 → **27** | `design/02` §4.6/4.7、`design/README`、`design/check.py` R23 计数 |
| P2 `Criterion` 缺 `guarantee`/`appliesTo` | 类上补两字段（注册已强制 `guarantee`，R29 按它算 delta） | `design/02` 类图 |
| P2 `Gate` 缺 `stage/criteria[]/policyMode/waivable` | 四条有效绑定判定的载体补进类（`policy` 字段改为 `GateSpec` 上的定义） | 同上 |
| P2 `StageRun` 缺 `gateId/criteria[]` | 补 `gateId` 与 `criteria[]`（`docs/03` 的 `stage_run` 本来就有这两列） | 同上 |
| P2 `Restatement` 与"刻意不是类"自相矛盾 | §2 改为：`restatement_diff` 是值对象/记录，**`Restatement` 有 id 与作废语义，是 Intent 聚合内实体** | `design/02` §2 |
| P2 `Baseline.prev/direction` 没进 `docs/04` 的 schema | baseline YAML 补 `prev` / `direction`，并注明 hash 覆盖 policy/criteria/gates/thresholds/assurance/engine/artifact_kinds | `docs/04` §5.1 |
| P2 轮次 | 本轮记为第十轮；状态指针改 §11 | `design/README`、本文件 |

## 11. 评审十一（2026-11-03，评审会话）

**起点**：第十轮之后的 OOM 补充（`BaselineContent`、`Release.baselineHash`、两张新顺序图）。**结论**：3 个 P1 确认真修好；新图暴露 **1 个 P1 + 5 个 P2**——全部是"图里画了、架构里没登记"或"图里画了旧关系"。核实为真，已处置。

| 发现 | 处置 | 落点 |
|---|---|---|
| P1 `dispatch → alignment` 在顺序图里出现，但模块表与组件图都没登记（R26 只查"表→图"，抓不到"图→表"的新调用） | 选"登记依赖"：`dispatch` 依赖加 `alignment`、组件图加 `dispatch --> align`；同时把 `design/01` §1 的依赖规则 2 改成"L1 可依赖**已登记的**同层服务"——旧文案"只依赖 L0 与端口"本来就与 `admission→gate`、`release→gate/sign` 矛盾；**新增 R31** 兜住这一类：顺序图里实线 `L1 → L1` 的调用必须在依赖列里登记（已做反例测试） | `design/01` §1/§3、`design/diagrams/build.py`、`design/check.py` R31 |
| P2 `handlers → gate` 没有组件边 | 加 `h --> gate` | 组件图 |
| P2 L2 直接写 `baseline.rejected`（`handlers` 无 store 依赖） | 图改成 `H -> G : reject(...)` → `G -> E : baseline.rejected`，写入归 `gate` | `uml-seq-config` |
| P2 `spec.defined` 挂在 `alignment` 名下（条款写入不是它的职责） | 改成只写 `assumption.recorded`；`decision.signed` 补成 `decision.valid / decision.signed`（P9/P10 要两条） | `uml-seq-align` |
| P2 `Gate ..> Policy` 成了悬空关系（`Gate` 已无 `policy` 字段） | 删掉，保留 `Gate ..> GateSpec` | 类图 |
| P2 轮次 | 本轮记为第十一轮；状态指针改 §12 | `design/README`、本文件 |

## 12. 评审十二（2026-11-03，评审会话）

**起点**：第十一轮之后的修补（`dispatch → alignment` 登记、R31、两张顺序图修正）。**结论**：上一轮 P1 确认真修好，**本轮无 P0/P1**，剩 2 个 P2 + 1 个流程项。

| 发现 | 处置 | 落点 |
|---|---|---|
| P2-1 `handlers` 的依赖列写「L1 服务」，R31 只查 L1→L1，L2→L1 抓不到 | 二选一里选了「显式声明抽象」：`design/01` §3 加注说明这是刻意抽象（L2 编排入口按需调用各 L1）、`R26` 对 `handlers` **显式跳过并写注释**、README 的 R31 行标注这条已知边界。**不假装已覆盖**——缝留在明处，比留一条检查不到的暗缝好 | `design/01` §3、`design/check.py` R26/R31 注释、`design/README` |
| P2-2 `check.py` 的 docstring 只列到 R30，与 README/实现三处不一致 | docstring 改成 `R0a–R0d + R19–R31`，补 R29/R30/R31 各查什么，并写明 L2 那条已知边界 | `design/check.py` |
| P2-3 轮次与提交 | README 实际已写十一轮（报告读到的是上一版快照）；本轮记为第十二轮、状态指针改 §13；提交仍待用户指令 | `design/README`、本文件 |

## 13. 评审十三（2026-11-03，**另一个评审会话**，整套设计审）

**起点**：第十二轮之后的树。**结论**：配置面通过、不要再重开；但**假设状态机不闭合是 P0**，另有 4 个 P1（OOM 聚合根字段、`goal_node` 无 `intent_id`、写网关只有 confirm、R28 失配）+ 2 组 P2。逐条核实：**全部属实**。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P0 假设状态机不闭合**：`status` 只从 `assumption.recorded`/`invalidated`/`decision(assumption_set)` 折叠，而集合必须覆盖全部 `open` ⇒ 签集合就等于"全部确认"；`rejected`/`converted` 没有生产者，P12 的"rejected 无后继"分支不可达 | 补 **`assumption.disposed`** 事件（`disposition ∈ {confirmed,rejected,converted}` + `successor_ref`），它是 `status` 的**唯一迁移生产者**；`confirmed` 仍要求进 `assumption_set`；`rejected/converted` 必须带后继；`invalidated` 回 `open` 并重签。补 **Assumption 状态图**（第 28 张图，R21 登记 + "状态图必须登记"检查）；`assumption_set` 的 payload 加工具渲染的 `dispositions[]`；**probe #15** 照抄规则验证三条迁移可达、`open` 拦派发、无后继被拒 | `docs/02/03/04/06`、`design/02` §3.9、`design/03` P12、`design/diagrams/build.py`、`probe/run.py` |
| P1 OOM 聚合根仍是空壳：`Intent`/`Spec`/`Task`/`ReviewRound`/`GoalNode` 缺 `source_text`/`status`/`blast_radius`/`inputs`/`baseline_hash`/`frontier`/`intent` 等 | 按 `docs/03` 的列补进类图（守卫点 `ReviewRound.close`、`GoalNode.declare`、`Spec` 才有字段可读） | 类图 |
| P1 `goal_node` 没有 `intent_id`，"根唯一且指向 Intent"没有落点 | 加 `intent_id` 外键 + `CHECK (kind<>'intent' OR intent_id IS NOT NULL)` + **部分唯一索引** `UNIQUE(intent_id) WHERE kind='intent'`；矩阵拆成两行（指向 vs 根唯一）；**probe #14a–c** 验证根唯一、子节点不误伤、根必须有 intent | `docs/03`、`design/02` §5、probe 的建表脚本与 `run.py` |
| P1 写入协议只有 confirm：preview 的生成与单步写都没有落点 | `handlers` 明确为**写网关三入口**：`preview`（算 `will_change`/`rework_units`/`payload_hash`）、`confirm`、`append`（单步白名单：认领/附证据/narration/加锁/记缺陷）；`docs/11` §8 同步，P3 补"preview 是谁生成的" | `design/01` §1/§3/§5、`docs/11` §8、`design/03` P3 |
| P1 R28 失配：找 `### 16.1`（实际 17.1）、只做字符串包含（24 条都在 P2 §3.1 里，恒绿）、表里 4 行错位 | §17.1 改成**执行点表**（`P2` / `02 矩阵` + 数据来源列）；R28 改成解析该表、按执行点核对正文、并查覆盖率——**删一行、改错执行点都会红**（已做反例）；P11 补"复述必须早于第一条 `spec`"；P14 的"frontier 不是当前"改成"≠ **被评对象的当前版本** frontier" | `design/03` §15/§17.1、`design/check.py` R28 |
| P2 schema/hash 三洞 | `decision` 表补 `decision_kind`/`status`（生成列/折叠列 + 索引）；release 不变量补"`baseline_hash` 必须非空"；`prev`/`direction` 进 hash、进 `decision(baseline)` 载荷、P15 组装清单，`verify` 按内容 diff 复算 direction；矩阵里"证据与判据一致"的 `G4` 误标改成表约束 | `docs/04/06/09`、`design/02/03` |
| P2 台账与状态声明过度 | `REVIEW` 的"未覆盖 1"改为"规则已闭合、只有 probe 的规则级验证，实现仍未测"；`README` 状态改为"配置面可进入实现；假设/派发链规则已闭合（状态机进 probe），运行时未验"；`design/01` §7 的"5 个 GAP 未决期间兜底"改成历史说明 | `design/README`、本文件、`design/01` §7 |

## 14. 评审十四（2026-11-03，**另一个评审会话**，复审 `63241ad`）

**起点**：第十三轮之后的提交。**结论**：第十三轮的 4 个 P1 与大部分 P2 确认真修好；但**假设面的 P0 没真闭合**——从"迁移不可达"变成了"可达但无授权、且顺序自相矛盾"。核实：**属实**。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P0 `assumption_set` 与 `assumption.disposed` 的顺序与授权没定**：先处置 ⇒ 不再是 `open` ⇒ 进不了"覆盖全部 open"的集合 ⇒ `confirmed` 永远不成立；先签 ⇒ `dispositions[]` 要求按事件渲染，事件还没发生。且 `rejected`/`converted` 只要求"有后继"、不要求人签——模型可以自己拒绝一条假设，从此它不再 `open`、永不进入人签集合 | **改成「先签后处置」**：`assumption_set` 是**唯一授权**，`assumption.disposed` 只是它的**投影**——事件必须带 `decision_id`（指向覆盖该条的集合签字）、`disposition` 与载荷一致，否则**一律拒**。签名载荷里 `spec_ids[]` = **这一批被审的假设**（preview 时的 `open` 集合）、`dispositions[]` = **人选的结果**（不是事件回填）；`assumption_set.signed` 的完整性改成「**没有未授权的 `open`**」；失效回 `open` 必须重签一批。**probe #15 重写**：无签字处置被拒、载荷与事件不一致被拒、仍在 `open` 拦派发 | `docs/02/03/04/06`、`design/03` P12、probe `run.py` #15 |
| P2 `Release` 矩阵仍缺「`baseline_hash` 非空」 | 矩阵行改成「**非空**，且与每条发布证据的 baseline 相同」 | `design/02` §5 |
| P2 README / 检查器说明停在上一版（"十二轮"、"假设未进 probe"、R28 说排除 §16.1） | README 改十四轮、指针 §15、未覆盖项改成「运行时/抽样；假设规则已进 probe #15 但实现未写」；`check.py` 的 R28 说明改成"§17.1 执行点表与正文核对" | `design/README`、`design/check.py` |
| P2 假设状态图多了一条 `rejected -> converted` 边，`docs/03` 没有这条迁移 | 删掉这条边（拒绝的后继是 `spec.revised`/`change.applied`，不是"转成假设"）；图与 docs 的迁移集合保持一一对应 | `design/diagrams/build.py`、`docs/03` |

## 15. 评审十五（2026-11-05，**另一个评审会话**，续评工作树）

**起点**：第十四轮的未提交改动。**结论**：先签后处置的主体修对了，但 **core 判据的 freshness 没实现**，且同一处留了一条方向相反的旧注释。**2 个 P1 + 4 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 `assumption_set.signed` 会放行旧签字**：判据写"没有 open 落在有效签字之外"——`invalidated` 回 `open` 后，该假设仍在旧 `decision` 的 `spec_ids[]` 里 ⇒ 判 PASS；而 `assumption.disposed` 只查 `task.inputs[]`、且是**非 core**（lite 可不绑），所以 core 兜底漏了 | 谓词改成三条**同时**成立：①**没有任何 `open` 假设**（回 `open` 即红，旧签字不算覆盖）；②每条非 `open` 的状态都由**带有效 `decision_id`** 的 `assumption.disposed` 投影；③存在有效集合签字（空集也要签）。**probe #15 补 freshness**：签→处置→invalidate ⇒ 断言 `set_signed=false`；重签→处置 ⇒ `true` | `docs/04`、`probe/run.py` #15 |
| **P1 `docs/06` 的 payload 注释仍是"事件先于签字"** | 注释改成「按 preview 时的人选结果渲染；签后事件由这份载荷投影」 | `docs/06` §5 |
| P2 `content_hash` 没写明覆盖 `spec_ids[]` / `dispositions[]` | 覆盖说明补上：集合签字签的是「哪些对象、每条怎么处置」，漏在 hash 外等于签了一个看不见的集合 | `docs/06` §5 |
| P2 `decision.revoked` 对假设处置没有级联 | 补规则：撤销 `assumption_set` ⇒ 它投影的 `disposed` 失效、覆盖的假设回 `open`，必须重签；`spec_set`/`baseline` 同理 | `docs/06` §5、probe #15 的撤销用例 |
| P2 `assumption.invalidated` 的检测没算法 | 补 **fold 规则**：`inputs[]` 记 `{kind,id,hash}`，每次 条款修订与变更事件 后比对，任一 hash 变 ⇒ 落一条 `invalidated`；以 `(spec_id,input_id,旧hash)` 幂等，回 `open` 后按新 hash 重建边 | `docs/03` |
| P2 矩阵还是旧口径（"覆盖全部 open"） | 改成「签字批覆盖 **preview 时**的 open；gate 判据要求全部已处置、无 open」 | `design/02` §5 |

## 16. 评审十六（2026-11-05，**另一个评审会话**，复审 `54374fb`）

**起点**：第十五轮的提交。**结论**：判据本身修对了，但**旧谓词还留在另外两处**（签字表与 P12），实现照抄会把洞重开。**1 个 P1 + 4 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 旧谓词残留**：`docs/06` 的完整性、`design/03` P12 的"什么时候算处置完"仍写"open 的假设都必须已被有效签字覆盖"——这正是 freshness 漏掉的那句；与 `docs/04` 的新三条直接冲突 | 两处都改成同一套谓词：①**不存在 `open`**；②每条非 `open` 由**带有效 `decision_id`** 的 `disposed` 投影；③存在有效集合签字（空集也要签）。**并加机器规则 R32**：在 `docs/` 与 `design/01–03` 里禁止旧句式（"仍为 open 的假设都必须已被…"/"覆盖当前全部 open"），已做反例 | `docs/06` §5.1、`design/03` P12、`design/check.py` R32 |
| P2 `assumption.invalidated` 的触发范围窄：只写了 `spec.revised`/`change.applied`，依赖 `intent` 的假设不会被触发 | 改成"**任何让 input hash 变化的事件**"（不按事件类型枚举——枚举必漏） | `docs/03` |
| P2 P12 没有 fold 检测算法，矩阵却把守卫点指向 P12 | P12 补一行"失效怎么被检测出来"（引用 `docs/03` 的 fold 规则：逐条 `inputs[]` hash 比对、`(spec_id,input_id,旧hash)` 幂等、回 `open` 后按新 hash 重建） | `design/03` P12 |
| P2 `verify` 没对 `assumption.disposed` 的授权链对账 | P9 的 C 组加一条：每条 `disposed` 的 `decision_id` 必须指向有效 `assumption_set`，且其 `spec_ids[]`/`dispositions[]` 覆盖这条并一致，状态与事件一致 | `design/03` P9 |
| P2 probe #15 没测空集与撤销后写入 | 补三条断言：零假设无签字 ⇒ 未签；零假设 + 空集签字 ⇒ 已签；撤销后用旧签字写处置 ⇒ 被拒 | `probe/run.py` #15 |

## 17. 评审十七（2026-11-05，**另一个评审会话**，复审工作树）

**起点**：第十六轮的未提交改动。**结论**：**无 P0/P1**，P1 确认真闭合（三处谓词已一致，R32 兜底）；剩 **5 个 P2**，全是台账/文档与提交，不动设计语义。

| 发现 | 处置 | 落点 |
|---|---|---|
| `design/check.py` 的 docstring 仍写 `R19–R31`（R32 已实现） | 改成 `R19–R32` 并补 R32 的说明 | `design/check.py` |
| REVIEW 第十六轮写「1 个 P1 + 3 个 P2」，表里实际 4 个 | 改成 4 | 本文件 |
| `probe/README` 的探针表只列到 13，14a–c/15 没进表 | 补两行（根唯一、假设状态机） | `probe/README` |
| `probe/REPORT` 的结果表同样缺 14/15，且 #15 摘要没提空集与撤销后写入 | 补两行并在边界声明里写清「#15 不测 fold 的真实执行」 | `probe/REPORT` |
| 第十六轮的 7 个文件未提交 | 随本轮一起提交 | — |

## 18. 评审十八（2026-11-05，**评审会话 1**，整套设计审）

**起点**：`759c3c7`。**结论**：设计质量 A-、产品保证 B+；**2 个 P1** 都不是"缺机制"，而是**检查点只做了一次**；另 7 个 P2。核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 `assumption_set.signed` 检查点不连续**：preset 里只绑在 req/harden/req_design 的出口；req 之后新增的**无卡假设**（`assumption.disposed` 查不到）可以一路 `open` 到交付 | ①**把 `assumption_set.signed` 与 `provenance.present` 绑到每个 stage 出口**（三份 preset 的 9 道 gate 全补）；②P15 的 core 规则从"有一个 gate"改成"**凡 `kinds` 与 `applies_to` 相交的每个 stage 出口都必须有效绑定**"（"只在某一个 stage 绑过"算没查）；③R29 同步按 stage 逐个核；④prototype 的 explore 出口现在要求签字（explore 里可记假设、开工不受阻，**出 explore 前必须签**） | `docs/08` §1.1、`docs/04` §5.2、`design/03` P15、`design/check.py` R29 |
| **P1-2 评审抽样未落地**：「必须评审」全靠作者可自评的 `risk_flags`/契约/release | policy 加 `review{sample_every, sample_seed}`（进 baseline）；P14 加"抽样命中"分支：按卡 id 与 seed 的稳定 hash 取模，每 N 张必抽 1 张，**低风险也不例外**；结果落 `gaps`；`review.required` 判据加该触发条件 | `docs/08` §1、`docs/04` `review.required`、`design/03` P14、`docs/13` §7、`design/02` §5 |
| P2 先签后处置的崩溃窗口 | 补恢复规则：**按 `decision_id` 幂等重放** `assumption.disposed`（重复重放不产生第二条） | `docs/06` §5.1 |
| P2 `na_stages` 示例仍是 `build→deliver`（缺 requirement ⇒ core 无处绑、必被拒冻） | 改成 `req→build→deliver`，并写明"不能连 requirement 也缺" | `docs/04` §4.1 |
| P2 probe 号称的设计表其实是子集 | `probe/README`/`REPORT` 都改成"**探针子集**（`task`/`release`/`decision`/`baseline` 等未建）" | `probe/README`、`probe/REPORT` |
| P2 机制预算没有按轮报读数 | 状态节补「机制预算读数」：判据/过程/表/模块/图/规则数 + 本轮新增机制类 = 0 + 退休候选（暂无；先例是第七轮删掉的 `core_waived_unstated`） | 本文件 §19 |
| P2 M1/M2 没把假设链与抽样写进任务 | M1「做」补假设处置链（disposed 投影、先签后处置、失效 fold、撤销级联）与评审抽样；M2 补撤销级联 | `docs/09` §16 |

## 19. 评审十九（2026-11-05，**评审会话 1**，复审第十八轮）

**起点**：第十八轮的未提交改动。**结论**：抽样（P1-2）真修好；**P1-1 只修了 2/3**——`spec_set.signed` 仍只在 requirement 出口，新增 requirement 可绕过集合签字。核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 `spec_set.signed` 只在 requirement 出口**：requirement 签过之后 `spec.revised`/change 新增条款，旧 `spec_ids[]` 不覆盖，而 build/deliver 的 gate 里即使写它也会判 `na` ⇒ 新条款可直接实现、交付 | 把 `spec_set.signed` 的 `applies_to` 扩成**全阶段**（"需求集合完整性"本来就是全局不变量），并绑到**每个 stage 出口**；P15 的 core 规则（每个适用 stage 都要有效绑定）与 R29 自动覆盖；R29 在补绑过程中真抓出漏绑 | `docs/04` §4.1/§5.2、`docs/08` §1.1、`design/check.py` R29 |
| P2 `mandate.revalidated` 在 deliver 缺失 | 补进三份 preset 的交付 gate（waterfall `G_deliver_exit`、prototype `G_deliver_exit`、incremental `G_integrate`） | `docs/08` §1.1 |
| P2 抽样用 hash 取模 ≠ "每 N 张必抽 1 张" | 改成**按单调卡序号**取模（`(seq - sample_seed) mod sample_every == 0`）：任意连续 N 张恰好 1 张；hash 不参与判定，只用于选起点/打散 | `docs/04` `review.required`、`design/03` P14、`docs/13` §7 |
| P2 `sample_every` 边界没校验 | P15 加第 ⑪ 条：`sample_every ≥ 2`；显式设 `0` 表示关闭抽样，此时 `guarantee_delta` 必须写保证 3 降级，否则拒冻 | `design/03` P15、`docs/08` §1 注 |
| P2 `review` 配置没进 baseline 视图 | `baseline` 视图列补 `review{sample_every,sample_seed}` | `docs/05` |
| P2 崩溃重放没有触发点 | P9 C 组加对账：每条有效 `assumption_set` 的 `dispositions[]` 都必须有对应 `disposed` 事件；缺 ⇒ 按 `decision_id` 幂等重放，重放后仍缺 ⇒ 红 | `design/03` P9 |

## 20. 评审二十（2026-11-06，**评审会话 1**，复审第十九轮）

**起点**：第十九轮的未提交改动。**结论**：P1 修好了，但**修过头**——`spec_set.signed` 被铺到 prototype 的 explore 出口，而 explore 阶段还没有 requirement，按 docs/06「空集不可能」它必然 fail ⇒ **prototype 第一段走不出去**。核实为真。另 3 个 P2。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 `spec_set.signed` 在 prototype explore 必然 fail**：explore 只有 `implement` kind、还没有 requirement 条款；判据要求"存在覆盖全部 requirement 的 decision"，而 `spec_set` 空集按设计不存在 ⇒ `all_of` 整道门 fail。R29 只查绑定，所以照样绿 | 给判据补 `na` 分支：**本期还没有任何 requirement ⇒ 判 `na`（`reason='no_requirement_yet'`），不是 pass；一旦存在 requirement，就必须被有效集合签字覆盖**。这样 explore 放行、harden 起强制，且不需要引入"空集 spec_set"这个与 docs/06 冲突的东西 | `docs/04` `spec_set.signed`、`docs/06` §5.1 |
| P2 `sample_every=0` 与 `guarantee_delta` 矛盾：P15 要求"0 ⇒ 保证 3 降级"，但 delta 只按判据绑定推导，必然算出"保持" | **禁止 0**：`sample_every` 必须 `≥ 2`；真不想抽就设一个很大的 N（会写进 baseline、被人看见）。删掉"0=关闭"的分支 | `design/03` P15 ⑪、`docs/08` §1 注 |
| P2 抽样用的 `seq` 没定义 | `task` 表补 **`seq`**：全局单调递增建卡序号（`task.created` 计数、唯一、不复用），抽样按它取模才能保证"任意连续 N 张恰好 1 张" | `docs/07` task 表、`docs/04` `review.required` |
| P2 轮次/提交 | 本轮记为第二十轮；提交仍未做（等指令） | `design/README`、本文件 |

## 21. 评审二十一（2026-11-06，**评审会话 1**，复审第二十轮）

**起点**：`f42506f`。**结论**：**无 P0/P1**，P1 确认真闭合（`spec_set` 的 `na` 分支、抽样改 `seq`、禁 `sample_every=0`、`mandate` 补交付 gate）；剩 **4 个 P2**，都是措辞与边界规则。

| 发现 | 处置 | 落点 |
|---|---|---|
| `docs/13` 与 P14 的低风险口径没排除"抽样命中" | 两处都改成「**未被抽样命中**的低风险卡才可以只走 `task.complete`；命中的即使低风险也必须评审」 | `docs/13` §7、`design/03` P14 |
| `docs/09` M1 仍写"按哈希取模抽卡"（已改 `seq`） | 改成"按卡的单调建卡序号取模（hash 只用于选起点）" | `docs/09` §16.2 |
| `sample_every` 没上界：设 10^9 等于偷偷关抽样，而 delta 仍记"保持" | P15 ⑪ 改成区间 **[2, 100]**：既禁 0，也禁超大 N；上限 100 保证"每 N 张必抽"仍可验证 | `design/03` P15 |
| 卡序号 `seq` 的迁移/回填没有落点 | M0 导入器条目补：**存量卡的 `seq` 按建卡事件顺序回填**（唯一不复用），校验"不同 seq 数 = 卡数、空值 0" | `docs/09` §16.1 |
| 轮次/提交 | 记第二十一轮、指针 §22；提交等指令 | `design/README`、本文件 |

## 22. 评审二十二（2026-11-06，**评审会话 1**，复审第二十一轮）

**起点**：第二十一轮的未提交改动。**结论**：上轮 4 个 P2 全部确认修好；**无 P0/P1**，剩 **2 个 P2**（抽样强度与递归）+ 台账。

| 发现 | 处置 | 落点 |
|---|---|---|
| `sample_every` 上限 100 仍允许 1% 抽样，而保证表仍写"强" | 上限降到 **20**：`N ∈ [2,20]`，"每 20 张至少抽 1 张"成为保证 3 的下限；delta 只按判据绑定推导，表达不了"抽样变弱"，所以用上界兜住而不是加新字段 | `design/03` P15 ⑪、`docs/08` §1 注 |
| 抽样会把 `kind='review'` 的评审卡也算进去 ⇒ "评审卡也需要评审"的递归 | 抽样**只对 `kind ≠ 'review'` 的卡**；评审卡不参与（P14 与 `review.required` 同步写明） | `docs/04` `review.required`、`design/03` P14、`docs/13` §7 |
| 轮次/提交 | 记第二十二轮、指针 §23；提交等指令 | `design/README`、本文件 |

## 23. 评审二十三（2026-11-06，**评审会话 1**，复审第二十二轮）

**起点**：`fbf46ae`。**结论**：core 的连续性已闭合，但**非 core 的保证判据仍不连续**——晚到的 requirement/design 只过集合签字，不过 2 正 1 反、设计覆盖、红队处置、复述。**1 个 P1 + 4 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 晚到的 requirement/design 只过 `spec_set`，不过各自阶段的判据**：`spec_set` 的 payload 是 `spec_ids[]`，不含"每条有没有 2 正 1 反 / 有设计承接 / 有红队处置"；而这些判据只在 requirement/design 阶段跑 | ①P13 加"**条款级重判**"：`spec.revised`/`change` 新增或改了 requirement/design 条款 ⇒ 按该 kind 的适用判据对该条款重跑，读数落 `stage_run.criteria[]`（`scope='clause'`）；②`spec_set` 签字载荷必须渲染**每条 requirement 最近一次修订之后**的适用判据读数，**缺读数 ⇒ 拒签**；③P4 准入加 `clause_unjudged`：卡关联条款在最近修订后没有读数 ⇒ 拒绝准入 | `design/03` P13/P4、`docs/04` `spec_set.signed`、`design/01` §7 |
| P2 `sample_every=20` 是 5% 抽样，保证表仍写"强" | 保证表下加注：`N ∈ [2,20]` 都算绑着，但 **N 越大覆盖越弱**；`guarantee_delta` 不反映 N，看 delta 时要同时看 baseline 里的 N | `docs/08` §1 |
| P2 `seq` 回填范围只写了 v1 导入 | 明确"存量卡 = v1 导入 **+ 已存在的 v2 库**" | `docs/09` §16.1 |
| P2 台账 | 记第二十三轮、指针 §24 | `design/README`、本文件 |

## 24. 评审二十四（2026-11-06，**评审会话 1**，复审第二十三轮）

**起点**：`e4a8fc1`。**结论**：上一轮的 P1 修得太窄——**2 个新 P1**：集合签字自指死锁、重判闭包只按 kind。核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 自指死锁**：`spec_set.signed` 的 `applies_to` 是全阶段，于是它也算 requirement 的"适用判据"；签字前它没有读数 ⇒ 渲染载荷时拒签 ⇒ 永远签不出来；`clause_unjudged` 准入同样死锁 | 「适用判据」明确**不含集合签字自身**（`spec_set.signed`/`assumption_set.signed`）——它们的读数就是签字本身，由 `decision` 提供 | `docs/04` `spec_set.signed`、`design/03` P13 |
| **P1-2 重判闭包只按 kind**：新 requirement 只重跑 requirement 类判据，不会触发 `design.covers_spec`（applies design）⇒ 新需求可以没有设计承接就实现；晚改 intent 不触发复述；晚拆 `goal_node` 不触发验收 | 闭包改成**按依赖**：被改对象 ∪ 沿 `inputs[]` 反向可达的 consumer，闭包内每个对象重跑「把它当输入」的判据。P13 补一张**变更闭包表**（requirement→`design.covers_spec`；design→`design.no_spec_creep`/`design.code_matches`；intent→`restatement`/`intent.restated_consistent`；goal_node→`node.acceptance_bound`/`node.integration_listed`）；`clause_unjudged` 用同一闭包 | `design/03` P13 |
| P2 `sample_every=20` 只有 5% 抽样，撑不起"强" | 上限**降到 10**（每 10 张至少抽 1 张），并在保证表注明"N 越大覆盖越弱、delta 不反映 N" | `design/03` P15、`docs/08` §1 |
| P2 `clause_unjudged` 行所有前置列都是 `—`，易读成"不依赖其他前置" | 行内注明"**独立前置，与其余列同时判**" | `design/03` P4 |
| P2 台账 | 记第二十四轮、指针 §25 | `design/README`、本文件 |

## 25. 评审二十五（2026-11-06，**评审会话 1**，复审第二十四轮）

**起点**：第二十四轮的未提交改动。**结论**：自指与跨 kind 闭包都修对了，但**闭包用错了时点**——`clause_unjudged` 在准入（开工前）用同一闭包，其中含 `task.complete`/`design.code_matches`/`node.integration_listed`，这些要等工作做完才有读数 ⇒ "先做完才能开工"的死锁。**1 个 P1**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 闭包时点错位**：`clause_unjudged` 在 P4 准入用"同一闭包"，把 post-work 判据也算进开工前检查 | 闭包拆两段：**pre-work**（requirement/design/alignment/redteam/restatement/acceptance，不需要产物）与 **post-work**（`task.complete`/`design.code_matches`/`node.integration_listed`，各自时点判）；**准入只用 pre-work**；`spec_set` 签字载荷只渲染 pre-work 的 requirement 读数（含 `design.covers_spec`） | `design/03` P13 闭包表 + P4、`docs/04` `spec_set.signed` |
| P2 `sample_every=10` 的 10% 抽样强度 | 已有注明（N 越大越弱、delta 不反映 N），保留；不再改口径 | `docs/08` §1 |
| P2 `clause_unjudged` 独立前置 | 已注明，无需再改 | `design/03` P4 |
| P2 台账/提交 | 记第二十五轮、指针 §26；本轮提交 | `design/README`、本文件 |

## 26. 评审二十六（2026-11-06，**评审会话 1**，复审第二十五轮）

**起点**：`cda1b77`。**结论**：P1 全部闭合（不自指、闭包按依赖、准入只查 pre-work、post-work 各自时点）；**无 P0/P1**，剩 2 个 P2 + 台账。

| 发现 | 处置 | 落点 |
|---|---|---|
| 保证表把保证 3 写成「强」，而实际是「三类全覆盖 + 最多 10% 抽样」，容易被读成 100% 覆盖 | 保证表下加**口径注**：「强」= 风险/契约/release 三类全覆盖 + 抽样兜底（`sample_every ∈ [2,10]`），**不是 100% 覆盖**；要更密就把 N 调小并写进 baseline | `docs/08` §1 |
| `clause_unjudged` 的 pre-work 清单只在 P13 闭包表里，P4 读者要翻页才知道 | P4 行内直接列出八条 pre-work 判据（`alignment.examples_present`/`redteam.disposed`/`stage.requirement_complete`/`design.covers_spec`/`design.no_spec_creep`/`design.alternatives_declared`/`intent.restated_consistent`/`node.acceptance_bound`） | `design/03` P4 |
| 台账 | 记第二十六轮、指针 §27 | `design/README`、本文件 |

## 27. 评审二十七（2026-11-06，**评审会话 1**，复审第二十六轮）

**起点**：第二十六轮的未提交改动。**结论**：**无 P0/P1**，也没有设计语义问题；只剩台账与提交。设计可进 M1。

| 发现 | 处置 | 落点 |
|---|---|---|
| 台账：README 写二十六轮，本轮是第二十七次；4 个文件未提交 | 记第二十七轮、指针 §28，随本轮提交 | `design/README`、本文件 |

**评审自己给的验收口径**（值得抄进实现期）：
- core 三条：`spec_set.signed`/`assumption_set.signed`/`provenance.present` 在**每个适用 stage 出口**有效绑定；
- 条款级：晚到/改过的 requirement/design 有 **pre-work 读数**，`spec_set` 签字载荷含这些读数；
- 准入：`clause_unjudged` 只查 pre-work 八条，与其余前置**同时**判；
- post-work：`task.complete`/`design.code_matches`/`node.integration_listed` 在各自时点判。

## 28. 评审二十八（2026-11-06，**评审会话 2**，整套设计审）

**起点**：`8e04319`。**结论**：方向都通过，但最后几轮新增的"晚到条款"链**没有闭环**——设计写了、签字 schema / 流程图 / 实施计划没接住。**3 个 P1 + 4 个 P2**，核实为真；也修正了我上一轮"无 P1"的说法（那是只看了配置面）。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 `spec_set` 签字载荷没有绑定条款读数**：docs/04 要求"签字前渲染每条 requirement 的 pre-work 读数"，但 payload 只有 `spec_ids[]`/`dispositions[]`，没有 `readings[]`/`readings_hash` ⇒ 人签的是集合，签完后读数变了签名仍有效 | payload 加 **`clause_readings[]`**（`spec_id`/`spec_version_hash`/`criterion`/`verdict`/`stage_run_id`/`data_hash`）与 **`readings_hash`**；`content_hash` 覆盖 `readings_hash`；P9 C 组加对账（复算不一致即红）；`Decision` 类加该字段 | `docs/06` §5、`design/03` P9、类图 |
| **P1-2 P4 流程图没有 `clause_unjudged` 分支**（判定表有、图没有 → 两张表达漂移；R19 只保证图能重建） | `p4-admission` 模板加分支（在"判据全绿"之后、"主树干净"之前）；重建；**新增 R33**：P4 表里「拒绝/阻塞」的每个 code 必须出现在流程图里（已做反例：删掉分支即红） | `design/diagrams/build.py`、`design/check.py` R33 |
| **P1-3 M1/M2 没排晚到条款链**：M1 有假设链与抽样，但没有 `spec_set` 签字载荷、`clause_unjudged`、P13 重判 ⇒ 设计补了、实施计划不会建 | M1「做」补：`spec_set` 载荷含 `clause_readings[]`/`readings_hash`、P13 按依赖闭包重判、P4 `clause_unjudged`；判死读数加"晚到 requirement 未重判 ⇒ 准入被拒；缺读数 ⇒ 拒签"。M2 补 `spec_set` 的签/撤销级联 | `docs/09` §16.2/§16.3 |
| P2 `clause_unjudged` 不查"条款在有效 `spec_set` 里" | 明确写死：`spec_set.signed` 是 **stage 出口门**、不是准入前置（避免自指）；准入只查读数 | `design/03` P4 |
| P2 `docs/07` 准入没写 `clause_unjudged` | 19.3 流程图与 19 节准入表都补上该前置 | `docs/07` |
| P2 README 还写"配置面" | 改成「设计基线可进入实现；配置面、假设面、条款质量面均已通过」 | `design/README` |
| P2 台账 27 轮说"无 P1" | 本轮补 §28 更正：27 轮只覆盖配置面，晚到条款链的 P1 由会话 2 查出 | 本文件 |

## 29. 评审二十九（2026-11-09，**评审会话 2**，按"PM 是头号用户"审）

**起点**：`1f868d5`（新增 PM 环路）。**结论**：PM 的方向对（权限 + 环路，不新增角色），但**还不是一等用户**——读集没被授权、动作没被定义。**3 个 P1 + 3 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 PM 读不到自己环路里的视图**：`review_queue` 要 decider、`gaps` 要 reviewer、`alignment` 视图**根本不存在**（第 ① 步必然 `query_miss`） | ①第 ① 步改读 `alignment` + `pm_queue`（人签字入口不是 PM 的队列）；②**新增 `alignment` 视图**（12 个）；③`gaps` 的 `min_right` 从 reviewer 降到 reader（只读计数与 id，不含秘密），PM 的完成读数才有出处 | `docs/05` §3/§10.1、`docs/15` §2、`docs/02`/`docs/09` 计数 |
| **P1-2 PM 的动作契约没定义**：`restate`/`unblock`/`rework`/`deliver` 没有权与事件；尤其 `deliver` 要 `decide@release + sign`，PM 不能签 | docs/15 加**PM 动作表**（action → 权 → 事件 → 幂等键）；`docs/07` 矩阵补 `restate`（`plan@domain`）/`unblock`（`assign@scope`）/`rework`（`plan@domain`）；**`deliver` 从 PM 动作里删掉**——PM 只 `request_sign`，签后由 release 流程交付 | `docs/15` §4、`docs/07` §2 |
| **P1-3 解阻塞没有事件**（补动作表时暴露）：`task.unblocked` 未登记、无生产者 | 登记 `task.unblocked`；P5 补"解阻塞"段（只解环境/依赖类，问题类等人答）；R27 随即要求生产者，已补 | `docs/02` 事件表、`design/03` P5 |
| P2-1 `pm_queue` 的 `action` 列写大了 PM 的权（"处置假设""修配置再冻""重判"PM 都做不了） | 八行 `action` 全改成 PM 真能做的：**等/改派/解阻塞/补 attention/建返工卡/准备+升级/建评审卡+派发/升级给人**；不能做的写明"升级给人" | `docs/05` §10.1 |
| P2-2 M1/M2 没有 PM 环路（主用户要等到 M4） | M2 加 **PM 最小环路**（读 `pm_queue`/`alignment` → 建卡 → 预占/派发 → `request_sign`），`plan`/`assign` 权在 M2 先落最小版；M3 注明"多 PM 与独立性在此补齐"；并写明 **M1/M2 的 PM 是人**（或人临时授权的单 agent） | `docs/09` §16.3/§16.4 |
| P2-3 `docs/15` 自己矛盾：§1 写 `assign` "语义待定"，§8 写"已定" | §1 改成"预占/派发/收回（见 §4）" | `docs/15` §1 |

## 30. 评审三十（2026-11-09，**评审会话 2**，PM 视角复审）

**起点**：PM 读集/动作表那轮的未提交改动。**结论**：读集与动作表基本闭合，但 **`unblock` 这一条动作的边界没定死**——一个事件三种落点、可解 code 没有白名单。**2 个 P1 + 3 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 `task.unblocked` 三种落点**：P5 说回 `ready`、状态图说回 `in_progress`、事件表只登记不写 `to` | 定死：**解阻塞一律回 `ready` 并清 lease**（解阻塞 ≠ 恢复授权，必须重新派发）；状态图边改成 `blocked --> ready : task.unblocked`（**第一次只改了产物 `uml-state-task.puml`，被 `build.py` 重建立刻覆盖；复审指出后改成改模板**），docs/03 状态机同步；R21 双向核对随之通过；**新增 R34 核迁移边**（只核状态集合会漏掉这类） | `docs/03` §4、`design/03` P5、`uml-state-task.puml` |
| **P1-2 `unblock` 的"可解集合"没定义**：`block_code` 无枚举、无白名单，PM 可能把 `awaiting_signature`/`verify_failed` 直接解掉 | docs/03 §4 加**枚举表**（`lease_expired`/`lease_revoked` 可解；`upstream_changed`/`clause_unjudged`/`awaiting_signature`/`verify_failed`/`dirty_main_tree`/`redteam_deferred` 不可解）；P5 只读白名单；`pm_queue` 的 `blocked` 行按 code 过滤；`verify` D 组加"PM 解了不可解 code ⇒ 红" | `docs/03` §4、`design/03` P5 与 verify、`docs/05` |
| P2-1 `gaps` 从 reviewer 降到 reader 太宽 | 恢复 `gaps` 为 reviewer；新增 **`pm_gaps`**（只读计数，reader）给 PM 做完成读数；视图 12 → 13 | `docs/05` §3、`docs/15` §6 |
| P2-2 `docs/02` 事件表的粗体写坏（`**` 配对错位） | 去掉嵌套反引号粗体，改成 `**`task.assigned` / … / `task.unblocked`**` | `docs/02` |
| P2-3 `pm_queue` 有 8 个 reason code 而 `row_budget` 是 7：`baseline_rejected` 永远看不见 | 把 `baseline_rejected` **并进 `waiting_human`**（同为"等人/等权"），code 数正好 7 = 预算 | `docs/05` §10.1 |

## 31. 评审三十一（2026-11-09，**评审会话 2**，PM 视角复审）

**起点**：第三十轮的未提交改动。**结论**：PM 读集/动作表闭合；**1 个 P1**——`task.unblocked` 的状态图仍是旧边（`blocked --> in_progress : 解除`），而 docs/P5/台账都说回 `ready`。核实为真，且是**我上一轮自己造的**：改了产物 `.puml`，却没改 `build.py` 模板，随即被重建立刻覆盖。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 状态图没改**：三处说回 `ready`、图说回 `in_progress`；R21 只核状态集合，不核迁移边 | 改 **`build.py` 模板**（不是产物）为 `blocked --> ready : task.unblocked（清 lease，重新派发）`，重建；**新增 R34**：docs 迁移串里写的每条 `A → B`（含多目标 `B`、`C`）必须在图里有边，已做反例（还原旧边即红） | `design/diagrams/build.py`、`design/check.py` R34 |
| P2 `pm_queue` 的 `blocked` 行没暴露 `block_code` | 行加 `block_code` 列；`action` 按白名单现算（可解 ⇒ `unblock`，不可解 ⇒ `attention`/`rework`），不让 PM 点了才被 `verify` 拒 | `docs/05` §3/§10.1 |
| P2 台账说"状态图已改"但没改 | §30 的处置改成如实记录："第一次只改产物、被重建覆盖；复审指出后改成改模板" | 本文件 §30 |
| P2 R21 只查状态集合 | **R34** 补迁移边核对（见上）；README 规则表加 R34，绿色范围改"二十类" | `design/check.py`、`design/README` |

## 32. 评审三十二（2026-11-09，**评审会话 2**，PM 视角复审）

**起点**：`4990541`。**结论**：**PM 作用域内无 P1**（读集/动作/解阻塞边界闭合）；剩 4 个 P2。**注意：这只覆盖 PM 线**——同一轮的全量审在 §33 里又查出一个 P10 的 P1，别把这里的"无 P1"读成全局。

| 发现 | 核实 | 处置 |
|---|---|---|
| R34 代码前后各有一段**完全相同**的 R21 报错块，状态不匹配时会报两次 | 真 | 删掉重复块（现只 1 处） |
| `design/check.py` docstring 停在 `R19–R32` | 真 | 改成 `R19–R34` |
| README 规则表顺序是 R34 → R33 → R32 | 真 | 按编号重排为 R32 → R33 → R34 |
| README 写"三十轮"、REVIEW 到第三十一轮 | **不成立**（复审读的是改前快照） | 已随本轮更新到三十二轮、§33；此条仅作记录 |

## 33. 评审三十三（2026-11-09，**评审会话 2**，全量复审）

**起点**：第三十二轮的未提交改动。**结论**：PM 线通过；但**全量审还剩一个 P1**——P10 签字过程没把 `clause_readings` 写进去。核实为真：schema、P9 对账、`Decision` 类都补了，唯独"签字动作"这一步还只写 `spec_ids[]`，实现者只看 P10 就会签出没有读数的集合。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1 P10 的集合签字没写读数**：docs/06 有 `clause_readings[]`/`readings_hash`，P9 会复算，但 P10 的集合签字仍只有 `spec_ids[]` | P10 补：`spec_set` 还要渲染每条 requirement 最近一次修订后的 pre-work 读数与 `readings_hash`；`assumption_set` 还要渲染 `dispositions[]`；**缺读数 ⇒ 拒签（`readings_missing`）**。P10 流程图"组 payload"后加判定分支（`build.py` 模板，已重建） | `design/03` P10、`design/diagrams/build.py` |
| P2 台账说"无 P1"但只是 PM 作用域 | §32 加上作用域说明，并指向 §33 的全量 P1 | 本文件 §32 |
| P2 §32 那条 README 轮次说明已过期 | 改成"已随本轮更新到三十二轮、§33" | 本文件 §32 |
| P2 三个文件未提交 | 待提交（等指令） | — |

## 34. 评审三十四（2026-11-09，**评审会话 2**，审"参考宿主团队插件"那批改动）

**起点**：参考宿主团队插件补的 `blocked_by[]`/上限/wait 三块。**结论**：方向对，但**只"参考"没"接线"**——新字段没进事件、上限没进 baseline、wait 把宿主能力写成了前提。**3 个 P1 + 3 个 P2**，核实为真。

| 发现 | 处置 | 落点 |
|---|---|---|
| **P1-1 `blocked_by[]` 没有生产者与环检测**：事件表没有它、`Task` 类没字段、"图无环"没人查、`spec`/`goal_node` 的"满足"没定义 | ①登记事件 **`task.dependencies_changed`**（`{task, blocked_by[], reason}`，创建时随 `task.created`）；②写路径做**环检测**（环 ⇒ `dependency_cycle` 拒），`Task.claim` 只判满足；③`verify` B 组查环；④`Task` 类补 `blockedBy`；⑤写明满足条件（task=`done`；spec=在有效 `spec_set` 的 `spec_ids[]`；goal_node=叶卡全 `done` 且验收判据过） | `docs/02`、`docs/07`、`design/02`、`design/03` P5/P9、类图 |
| **P1-2 上限说"进 baseline"但 schema 里没有**：8/16/64 KiB/5 s 可以不被签字地改 | 加 **`policy.limits{max_members, max_pending_attention, max_payload_bytes, cleanup_timeout_s}`**：进 policy schema、baseline 字段、`baseline` 视图、P15 的 3 组 baseline、hash | `docs/08`、`docs/04`、`docs/05`、`design/03` P15 |
| **P1-3 wait 被写成宿主前提**：SDO 工具面没有 `wait`，却写"PM 不该轮询"（**该表述只出现在未提交草稿，git 上不可审计**；修正后已落成可选两路径） | 改成**可选 + 退化**：宿主有 wait ⇒ 用（只观察调用后的变化 / 无人跑即 `noProgress` / 醒来先重列）；没有 ⇒ **有界轮询**（退避 + 连续两次 `noProgress` 就升级）。SDO 不要求宿主提供 wait | `docs/12` §6.2 |
| P2-1 新上限的拒绝码没进错误模型 | 补 `attention_overflow` / `payload_too_large` / `cleanup_timeout` 与 `dependency_cycle` | `design/01` 错误码表 |
| P2-2 `blocked_by` 的 spec/goal_node 条件含糊 | 已在 P1-1 里写死 | `docs/07` |
| P2-3 `Task` 的 OOM 没跟上 | 类图补 `blockedBy : DependencyRef[]` | `design/diagrams/build.py` |

## 35. 评审三十五（2026-11-09，**teammate 独立评审**，只读、fresh 上下文）

第一次用 Agent Teams 跑"评审者=独立 teammate"。它看不到作者的 34 轮上下文，只读工作树。**结论"不能收"**：5 个 P1 + 若干 P2，核实后**大部分属实**，其中 2 条我判定为"取证不足/口径可调整"。

| 发现 | 核实 | 处置 |
|---|---|---|
| **P1-1 `blocked_by` 的改路径没有动作/权限/过程**：任何持有人清空依赖即可绕过 `unblock` 白名单 | 真（`task.dependencies_changed` 只在 docs/02 登记、design/03 散文提了一句） | 新增动作 `dependencies`（`plan@domain`，**在飞卡禁改**）；`design/01` 逐过程表补 4 个拒绝码；`verify` D 组加"在飞卡依赖被篡改即红" |
| **P1-2 `limits` 只到载体、没到校验与执行**；且"每 actor attention 上限""失败创建算配额"用现有表算不出 | 真 | P15 加第 ⑫ 条（范围 + **缺省由工具写入并进 hash**）；`attention` 表补 `asked_of`（队列归属可算）；**删掉"失败创建算配额"**（不可算，不硬造载体）；`cleanup_timeout` 从 reject 移到 fail 类 |
| **P1-3 verify 的环检测只在派生表、没进真源 `docs/02`**；且只查环不查悬空 | 真 | `docs/02` §14 加一项、§15 加不变式；矩阵 verify 列改成"引用可解析 + 无环"；B 组两项分开查 |
| **P1-4 `goal_node` 的满足条件不可实现**（没写"卡→节点"怎么关联、父/叶混用） | 真 | 改成复用既有规则：**节点验收通过**（叶看验收判据，父看集成清单 + 整体跑一次） |
| **P1-5 `pm_queue` 的 `blocked` 与依赖等待冲突**：依赖没到只落 `unclaimed`，PM 永远推不动 | 真 | `blocked` 行定义扩成"`status='blocked'` **或** `blocked_by[]` 未满足"，行里带 `blocked_by[]`；action 按 code/依赖现算 |
| P2 拒绝码只进散文、`cleanup_timeout` 归错类 | 真 | 逐过程表 + `docs/02` 写路径枚举补齐；`cleanup_timeout` 归 fail |
| P2 `docs/12` §6 与 §6.1 两个"8"、`max_members` 口径冲突 | 真 | §6 改成指向 `limits`；删掉不可算的"失败配额"行 |
| P2 `task` 表关键列没有 `blocked_by[]` | 真 | 补进关键列 |
| P2 矩阵 verify 列与 B 组不一致 | 真 | 统一为"引用可解析 + 无环" |
| P2 `docs/12` §6.2 引用不存在、轮询下 `noProgress` 没定义 | 真 | 引用改成「不对宿主提要求」；轮询的 `noProgress` 定义为"两次读到相同 `pm_queue`" |
| P2 `docs/01` §16.1 对"三条保证"的归纳不准、来源无出处 | 真 | 改成按 §1 的"靠什么"逐条；去掉"借宿主插件写法"的出处声明 |
| P2 `task.dependencies_changed` 的"已接线"是假绿（R27 只查字样） | 真 | 不改检查器（成本高），在 README 的 R27 行**写明已知边界**：只查出现、不查动作/权限/拒绝码 |
| P2 机制预算读数没随本批更新 | 真 | §36.2 更新：本批新增 1 事件、1 动作、4 baseline 字段、5 拒绝码、3 个 pm_queue 列/归属列；**独立机制 0**（都挂在既有 task/dispatch/baseline 上），并给两条退休条件 |
| 报告中"REVIEW §34 P1-3 前提无法验证" | 成立（该表述只在未提交草稿） | §34 已注明"git 不可审计" |

## 36. 评审三十六（2026-11-11，作者自检，**非独立**）

用户批准六项机制变更（A-2 / A-4 / D-2 / D-3 / D-9 / D-10）后逐项落地。**本节是作者自检，不是独立评审**；独立性由上述非作者轮次提供。

| 变更 | 落地 | 自检 |
|---|---|---|
| A-2 意图进签名链 | `decision_kind` 增 `intent`；`intent` 增 `decision_id`（`approved_by` 降为投影）；P10 单对象 payload；`verify` 增“intent 的 decision 有效且 signer=approved_by” | 检查器无对应项，已写进 `docs/02` §14 与 P9（手工核对） |
| A-4 树由人签的 plan 长 | `decision_kind` 增 `plan`；`goal_node.decision_id`；PM 动作 `declare`/`split` → `propose_plan`；矩阵守卫改 `GoalNode.declare` | 同上，`verify` 增“节点在 `node_ids[]` 内” |
| D-2 grant 延后 M4 | `docs/07` §5 顶部启用时点声明；`docs/05`/`docs/11`/`docs/09` 标注 M1–M3 无 delegated；`docs/14` G6 | 机械项：R27 不查 delegated（过程外未登记），无新增检查需求 |
| D-3 limits 移出 baseline | `docs/08` 删 `policy.limits`；`docs/04`/`docs/05`/`design/03` 去字段；P15 ⑫ 改为部署配置；`docs/12` §6.1 | `config.changed` 进 `docs/02` 事件表（运维域），R12/R27 绿 |
| D-9 缺口 = requirement 差集 | `docs/09` §5 定义、`release.gaps_match`、视图与验收读数 | 纯口径变更，无新载体 |
| D-10 M1 收窄 | `docs/09` §16.2 只留六表+对齐+判据框架+core；假设处置链/抽样/晚到条款链移 M2 | 与 §16.3 的 `assumption_set` 撤销级联一致 |

**顺带补的缺口**（按“缺口直接补”）：`defect` 表 + `defect.recorded/closed`（A-3）；`attention` 的 `expires_at`/`state` + 到期读数（`expires_at` 派生，不是事件）与撤回事件（A-16，防僵尸问题占满 16 条配额）；`docs/03` 辅助表 18→19。

## 37. 评审三十七（2026-11-11，**teammate 独立评审**，审未提交工作树）

> 作用域：**增量 + 两个视角**（写得对不对 / 机制合不合理），对象是六项机制变更（A-2/A-4/D-2/D-3/D-9/D-10）与两个补缺（A-3 defect、A-16 attention）的未提交改动。结论原话是"**不可提交**"。

审出的模式很一致：**字段、事件、句子都加了，载体/动作/权限/拒绝码/校验点没接上**——正是本项目历史上反复出现的"文档加了、机制没接住"。逐条处置：

| # | 发现 | 处置 |
|---|---|---|
| P0-1 | D-3 把 `limits` 移出 baseline，却全库无 `config` 表/写入动作/权限/拒绝码；P15 ⑫ 还保留"配置不合法 ⇒ 拒绝冻结" | 补最小闭环：`config` 表 + `config` 动作（`admin@domain`）+ `config_invalid`/`config_missing` + 写入时校验 + `config.changed` 折叠读数（第 38 轮补：`design/03` P5/P6 的四个读点 + `docs/02` §14 对账行，否则只有"写"没有"用"）；**P15 删 ⑫**，配置非法只拒写入/拒启动，不产出 `baseline.rejected`；`design/01` 去 limits |
| P0-2 | intent/plan 不在 `docs/06` 必须签表与 payload schema；verify 只查 membership；`goal.reparented` 走默认变更可绕过；`goal.declared` 无过程落点；`intent.signed` 双真源 | §4 加"分解树（plan）"必须签；§5 加 `intent{source_text,strength,content_hash}` 与 `plan{node_ids[],tree[],tree_hash}`；content_hash 覆盖单对象载荷；verify 逐字段比对；P10 成功分支同事务写 `intent.signed`/`goal.declared`/`goal.reparented`（幂等键 `(decision_id,node_id)`）；`intent.signed` 声明为 `decision.signed` 的投影、查 1:1；P13 明确改挂不走默认变更 |
| P0-3 | `gaps_match` 的 requirement 差集无范围、无 requirement 级条目 | release 加 `scope_spec_set`（冻结时引用的有效 `spec_set`）；`release_item` 加 `kind='requirement'` 与 `requirement_id`；§5 定义全集与两边现算 |
| P1-1 | M1 要冻结 baseline，但签字链在 M2 ⇒ M1 判死读数不可达 | M1 只留 P15 **静态**校验（对文件、不落冻结）+ 离线 `sdo_check`；冻结与门禁移到 M2，判死读数同步改 |
| P1-2 | defect 只有表/事件，无生产者/权限/关闭载体；"修复者签 `defect.closed`"违反"签字只签 decision" | `defect.closed` 由**工具**在复验 `verify_run` 通过后写；P8 集成回归落 `defect.recorded(kind=integration)`；`docs/07` 加记/关缺陷动作；OOM 加 `Defect` 类 + 矩阵两行 |
| P1-3 | attention 的到期读数由"投影侧清理"凭空写事件 | `expired` 改为 `expires_at` 的**派生读数**，不是状态、不是事件；只保留 `withdrawn`（提问者、`escalate@scope`）；`design/02` 同步 |
| P1-4 | `verify_run` 是发布证据唯一信任锚却无 DDL；元组 `at` 重复 | `docs/02` §5 补 DDL（去重）、唯一写入路径、`actor_kind` 由凭据决定、发布只认 human/service 或人签 |
| P1-5 | OOM 没接住本批字段：`Intent`/`GoalNode` 无 `decisionId`、`Attention` 无状态列、全图无 `Defect` | `build.py` 模板补齐并重建；矩阵补守卫行 |
| P2 | 计数（"十二项"实际 14、"十条"实际 12）、`design/01` 残留 limits、旧 `approved_by` 口径、`docs/00` §10 坏锚点、机制预算仍写 4 个 baseline 字段、README 把非独立自检当证据 | 逐条改；probe 同步（`intent` 的 `decision_id`、`config`/`defect`/`verify_run` 三表、`#16` 四个子项，21→25 PASS） |

**这轮补的机器检查**：`R25` 现在要求矩阵守卫点精确指向类图里的类与方法（`Defect.record`/`Defect.close`/`Attention.withdraw` 都被它逼着落地）；`R27` 把 `config.changed` 登记为 `handlers` 的过程外事件（它没有 P 号，属于写网关）；`R23` 的表数改由 探针 DDL 现算（29）。

## 38. 评审三十八（2026-11-11，**teammate 独立评审**，复评第 37 轮处置）

> 作用域：增量续审 + 六个重点（config 消费方、plan 树唯一入口、scope 撤销、M1 依赖方向、`#16` 覆盖、台账真实性）。结论原话仍是“**不可提交**”。已确认接上：A-2、A-4、D-2、P1-3、P1-4、P1-5 与多数 P2。

第 38 轮指出的问题与处置：

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P0 | `config` 只有“表 + 动作 + 事件”，没有消费方：`design/03` 0 处、`docs/05` 0 处、`docs/02` §14 无行，执行点只活在 `docs/12` 散文里 | 真 | `design/03` P5 加 `max_members`（候选前）与 `cleanup_timeout_s`（revoke/回收）、P6 加 `max_pending_attention`（提问前）与 `max_payload_bytes`（追加前），读不到键一律 `config_missing` 失败关闭；`docs/02` §14 加“`config` 表 = `config.changed` 逐键折叠 + 四键存在”对账行；`docs/05` 的“16 条”改为默认值（从 `config` 读）；`design/03` 写出“上限的消费者清单”，缺一即视为没接住 |
| P1 | 矩阵审计列写 `verify C`/`verify D`，但 §14 与 P9 的 C/D 组都没有 defect 关闭、attention 撤回的检查；`docs/03` 的 defect 表缺 `verify_run_id`/`closed_by` | 真 | defect 表补两列并写明“关闭凭复验、由工具写”；§14 加 defect 关闭、attention 撤回两行；P9 D 组同步；`design/03` 的“范围 = 十四项”改“十七项”（§14 现 17 项） |
| P1 | M1 的 `sdo_check` 仍要 baseline：`docs/04` 规定“没有 baseline 的判定无效”，M1 没有 baseline 行 ⇒ 产出的 `gate.judged` 全无效 | 真 | M1 的 `sdo_check` 明确为**只读预览、不落 `gate.judged`**；`docs/04` §5.2 规则 1 与 `docs/05` 工具表同步；M1 判死读数加第 7 条“跑完 `sdo_check` 后 `gate.judged` 行数为 0” |
| P1 | release 的 `scope_spec_set` 被撤销后无规则；`requirement_id` 的“必填”只在注释里 | 真 | `docs/09` §13 加不变式 7（scope 决定必须仍 `valid`；被撤 ⇒ 缺口失效、不能交付；**第 39 轮改**：不原地回 `draft`，冻结行不可变，只能 `release.superseded` 重做）；`release_item` 加 `CHECK (kind='requirement' OR requirement_id IS NOT NULL)`，并在冻结写入路径强制（缺 ⇒ `invalid_field`） |
| P2 | `docs/06` 可见 `status` 含 pending/awaiting_unlock，但 `decision` 行只有三态 | 真 | 拆成“decision 行三态 + 请求态（pending/awaiting_unlock）”；人签前库里没有半成品 decision |
| P2 | `docs/03` 仍写 `goal_node` “只由需求/设计阶段显式声明” | 真 | 改“只能由人签的 plan 落树（PM 只能 `propose_plan`）” |
| P2 | goal_node 对账只有单向（漏“载荷节点被静默删”） | 真 | §14 与 P9 C 组都改成**双向**：树→载荷逐字段相等，且每条有效 plan 载荷的 `node_ids[]` 必须仍在树里 |
| P2 | 台账夸大：§37 的“消费者”只是自述、README 写“逐条处置完毕” | 真 | §37 该行改为“+ 第 38 轮补的四个读点与 §14 对账行”；README 改为“已按轮处置，第 38 轮仍判不可提交” |
| P2 | `#16` 只测 SQLite CHECK | 真（§39 已自认） | 不把它当机制证据；README/REPORT 维持“只到 DDL 约束” |

**这轮的结论**：第 37 轮的病根是“加字段不加消费方”，第 38 轮把它逐点补成了“写入校验 + 读取点 + §14 对账”三件套；但**运行时仍未验证**，所以即便下一轮判“可提交”，提交的也只是**设计稿**，不是“机制已被证明会跑”。

## 39. 评审三十九（2026-11-11，**teammate 独立评审**，复评第 38 轮处置）

> 作用域：增量续审 + 九条处置核对。结论仍“**不可提交**”：4 组 P1 未闭合，其中两条是“台账声称已改、工作树没改”。这几条是本项目的老毛病在第 38 轮修复里复发：**改了文档、忘了真源表；写了规则、忘了执行点**。

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P1 | `docs/03` 的 defect 表仍无 `verify_run_id`/`closed_by`，而 §14 与矩阵已把 verify 绑到这两列；§38 却称“已补两列” | 真（上一轮替换串没匹配上，静默失败） | defect 表补两列（关闭由 `defect.closed` 投影、工具写）；probe 的 `defect` 补 `closed_by` 并收紧 CHECK（`open` 或 复验+关闭人）；`#16b` 同步 |
| P1 | release 的 scope 规则只在 `docs/09` 散文里：P8 没有 `scope_spec_set`/`requirement_id` 校验，§14 与 P9 无 release scope 对账；“回 draft”与不变式 1（冻结行不可变）冲突 | 真 | P8 前置加第⑥条（scope decision `valid`、逐行 `requirement_id`、必须在 `spec_ids[]` 内，违者 `scope_invalid`/`invalid_field`）；§14 加 release scope 对账行（18 项）；不变式 7 改为“冻结行不变、不能交付、`verify` 记 `runtime_inconsistent` + 落 `defect.recorded(kind=consistency, criterion_id='release.gaps_match')`，只能 `release.superseded` 重做” |
| P1 | config 读点与 `docs/12` 三处行为矛盾（park vs 拒绝、cleanup 阻塞 vs 不阻塞、`attention_overflow` vs `config_invalid`），键名三处不一致（`limits.*` vs 裸键），初始化与折叠对账自举失败 | 真 | 读点统一按 `docs/12`：成员满先 park 最久 idle、全 busy 才拒；清理超时标 `stale` 进 `gaps` 不阻塞；提问超限用 `attention_overflow`；键名统一 `limits.*`；§14 写明“含迁移初始化事件”；P6 写明初始化走 boot 路径、不受 payload 上限约束 |
| P1 | attention 撤回对账绑错对象：§14 用 `asked_of`（被问的人），而真源表没有“提问者”列 | 真 | attention 表加 `raised_by`；§14 与 P9 都改成 `withdrawn_by = raised_by`，删掉“或提问者本人”这种无载体的说法 |
| P2 | P9 口径“十七项”仍不实（C/D 组有 §14 外检查） | 真 | 改为“十八项 + 本节补充项” |
| P2 | `design/03` §17 说 config 由 handlers 承接，但 handlers 的 append 白名单不含 config | 真 | 写明“config 写入是 handlers 的独立动作，不在 append 白名单；读取点在 P6” |
| P2 | 待签请求无载体：队列只物化已落库 decision | 真（有意） | 在 `docs/05` 待审队列契约里明说“待签在会话态 preview，不入库、不进队列”，不给半签行造真源 |
| P2 | release scope 撤销落 `defect.recorded(kind=consistency)` 但没 `criterion_id` | 真 | 指定 `criterion_id='release.gaps_match'` |
| P2 | `scope_invalid` 未进拒绝码表 | 真 | 补进 `docs/02` §11 与 `design/01` §7（与 `attention_overflow`/`payload_too_large` 一起） |
| P2 | `design/README` 头行仍写“可进入实现”，与 §38 结论矛盾 | 真 | 改为“仍在评审环里，reviewer 明确‘可以提交’之前不声称可进入实现” |

**这轮的教训（写进流程）**：sed/replace 的静默失败会让“台账说改了、工作树没改”；以后每轮处置完，先对**真源表**与**执行点**各 grep 一次再写台账。

## 40. 评审四十（2026-11-11，**teammate 独立评审**，复评第 39 轮处置）

> 作用域：增量续审 + 五组处置核对。结论仍“**不可提交**”，但已无 P0；只剩一条 P1（不变式 7 的执行点）与五条 P2。这轮的特征是：**文本载体已经在了，执行点还差一步**——上一轮说“范围被撤不能交付”，却没写哪一行代码/哪一步过程去拦。

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P1 | 不变式 7 的三个执行点不存在：P8 交付路径不复查 scope、P9 的 A–D 组没有 release scope 项、`grep scope_spec_set design/03` 只命中冻结前置⑥ | 真 | ①`design/03` P8 加**步骤 10「交付前复查范围仍有效」**（decision 仍 `valid`、`requirement_id` 仍在载荷内，否则 `scope_invalid`、不落 `release.delivered`），原步骤 10 顺延为 11；②P9 **D 组**加“`frozen`/`delivered` 的 release 其 `scope_spec_set` 仍 `valid` 且行在载荷内”；③P9 **C 组**加“发布引用的 `verify_run` 必须 human/service 或经人签” |
| P2 | 矩阵审计列指空：`Defect.close` 写 `verify C` 实际在 D 组；`发布引用的 verify_run` 写 `verify C 组` 而 A–D 一处都没有 | 真 | `Defect.close` 改 `verify D`；`verify_run` 信任检查**补进 C 组**（现在审计列有落点，不再靠改名糊过去）；§14 的 18 项因此都能在 A–D 找到落点（**口径**：夹具那项只复核 active 子集，见 §41） |
| P2 | config 初始化只写“迁移写四个缺省值”，§14 却要求“含四个初始化事件”；`config.changed` 需 admin 而迁移没有身份 | 真 | `docs/12` 明说迁移写四条 `config.changed`（`actor='migration'`、`before=NULL`）；迁移 actor **免 admin 校验、免 payload 上限**（只此一个例外，否则新库自举死锁）；P6 同步 |
| P2 | 执行点措辞两处不一致（`dispatch` 前 vs 候选集前）；池满拒绝复用 `config_invalid`（语义是写入值非法） | 真 | `docs/12` 统一为“进入候选集之前”；池满改用独立码 **`member_capacity`**，登记进 `docs/02` §11 与 `design/01` §7 的拒绝码清单 |
| P2 | release §12 七条判据没有 scope 有效性，`gaps_match` 在 scope 被撤后仍可算绿；不变式 7 的“缺口读数失效”无可观测判据 | 真 | **不新增第 8 条判据**（避免计数与落点成倍扩散）：把 scope 有效性**并入 `release.evidence_valid`**（“证据在 frontier 内有效，且 scope 决定仍 `valid`”）；不变式 7 落的缺陷 `criterion_id` 从 `release.gaps_match` 改 `release.evidence_valid`——红的是它，`gaps_match` 的差集公式本身不红 |
| P2 | `defect.criterion_id` 能指向 `release.*` 但没有语义，`family` 会把两类判据混族 | 真 | `docs/03` 的 `defect` 行写明：`criterion_id` 可指阶段判据，也可指内置 `release.*`/`security.*`（内置不进 24 条注册表）；`kind ≠ criterion` 只记归属；`family` 聚合时**内置判据单独成族** |

**这轮的教训（写进下一轮的自检）**：写完“某时点必须成立”的规则，立刻回 `design/03` 找**那个时点的过程步骤与 verify 分组**；找不到就等于没写。`make all` 与 `grep` 都不认识“应该存在”的东西——R27 只查事件有没有生产者，不查不变量有没有执行点。

## 41. 评审四十一（2026-11-11，**teammate 独立评审**，复评第 40 轮处置）

> 作用域：增量续审 + 六条处置核对。结论仍“**不可提交**”，无 P0；2 个 P1 + 4 个 P2。这轮的特征是：**上一轮补的“检测侧”对了，“处置侧”还是死胡同**——说“不能交付”，却没说“这版怎么收尾”。

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P1 | `frozen` release 因 scope 被撤而不能交付后**没有可执行的补救路径**：`release.superseded` 只有 rollback 一个生产者，而 rollback 的语义与状态图都是 `delivered` 态（绑产物 sha256），`frozen` 没有出边 | 真 | 不新增 `decision_kind`：**同一个 `decision(kind=rollback)` 可以作用于未交付的冻结版**——载荷 `artifact_sha256` 留空、`release.superseded` 绑新 release id、本版进 `rolled_back`；状态图加 `frozen --> rolled_back`（第 42 轮补正：当初声称“`design/03` P8 步骤 10 也写了”，实际只有图模板写了，正文漏了——本轮已按正文补齐） |
| P1 | `config` 初始化豁免只写在 `docs/12` 散文：真源 `docs/02` 的 `config.changed` 仍写“需 admin”，`docs/07` 权限表没有 migration/boot actor | 真 | `docs/02` 运维行补 boot 例外（`actor='migration'`、`before=null`、免 admin 与 payload 上限）；`docs/07` 加“初始化部署配置”一行，写明 boot 系统 actor 是**唯一**豁免处，且照样落 `config.changed`、可由 §14 对账 |
| P2 | 三张图源没跟上第 40 轮文本：`p8-release` 与 `uml-state-release` 仍写“前置五条”，`p9-verify` 注“§14（十项）”且 C/D 组示意行缺新检查；R19 只重建不查语义 | 真 | 改 `build.py` 模板：五条→六条、十项→十八项、p8 加“交付前复查 scope”分支、release 状态图加 frozen 出边、p9 的 C/D 组示意行补齐新检查；重建 png/svg |
| P2 | 矩阵没有不变式 7 的守卫行（M-03 要求一条不变量一个守卫点） | 真 | 矩阵加一行：“`frozen`/`delivered` 的 release 其 scope 决定仍 `valid`、行仍在载荷内”，守卫点 `Release.freeze`（前置⑥ + 交付步 10），审计列 `verify D` |
| P2 | `design/01` §7 逐过程拒绝表没同步新码：P5 派发缺 `member_capacity`/`config_missing`，P8 交付缺 `scope_invalid`/`release.evidence_valid`/`release.deprecation_window`，全表无 P6 行 | 真 | P5 派发行补两码；新增 P6 行（`attention_overflow`/`payload_too_large`/`config_invalid`/`config_missing`/`no_permission`）；P8 行改“交付（冻结与交付）”并补齐九码 |
| P2 | “§14 十八项全部被 A–D 覆盖”措辞略宽：第 5 项是“所有 criterion 有正负例”，C 组只复核 active 子集 | 真 | `design/03` P9 加“覆盖口径”说明：夹具那项只查 active；未激活与 `na` 的约束在 P1 注册与有效绑定里；不得读成“每项都是全量检查” |

**这轮的教训**：写“某状态不能做 X”时，必须再写“那它能做什么”——否则就是造死胡同。检测点（不能交付）与处置点（怎么收尾）要成对出现，和“事件要有生产者”是同一条纪律。

## 42. 评审四十二（2026-11-11，**teammate 独立评审**，复评第 41 轮处置）

> 作用域：增量续审 + 六条处置核对。结论：**可以提交**。无 P0、无 P1；5 条 P2 属载体与措辞（不阻塞提交）。这是本项目第一次拿到“可提交”的独立结论，依据是：第 41 轮的两条 P1 确实落下去了、`make all` 绿、三张图源与真源四处一致、矩阵与逐过程表同步。

| # | P2 发现 | 核实 | 处置（提交前一并做掉） |
|---|---|---|---|
| P2-1 | 台账称“三处同步”，但 `design/03` P8 步骤 10 正文没写回滚路径，只有图模板写了 | 真 | 步骤 10 正文补“收尾 = `decision(kind=rollback)` + `release.superseded` 换新 release”；§41 那格改成“第 42 轮补正：声称三处、实际只写了图模板，本轮补正文”——**不掩盖，只留痕** |
| P2-2 | rollback / `release.superseded` 的签字与载荷载体不完整：必须签表无“回滚”行、payload 无专有字段、`docs/02` 只写“见 09” | 真 | `docs/06` §4 加“回滚 / 作废冻结版”必须签行；§5 加 `rollback{release_id, frontier, artifact_sha256（可为 null）, successor_release_id}`（successor 由工具生成，同一次写入建 draft 行）；`docs/02` 的事件行写死载荷字段 |
| P2-3 | “既 rolled_back 又能 delivered”没有真源守卫：`release` 的 `status` 没有折叠优先级/终态互斥规则，§14 与 P9 D 组都没查 | 真 | `docs/02` §14 加第 19 项（状态 = 事件序列折叠、终态互斥、违反 ⇒ 红）；`docs/09` 加不变式 8；P8 加**步骤 11 终态前置**（拒 `state_conflict`）；P9 D 组同步；`design/03` 计数 18→19 |
| P2-4 | `docs/09` §7 两句并列有歧义（先读“必须绑产物”，下一句才说未交付可空） | 真 | §7 首句改为“已交付版必填、未交付 frozen 版为 null，见下”，下一句只留处置细节 |
| P2-5 | `design/01` §7 逐过程表行序非 P 号（P4 在 P5 后、P6/P8 在 P10 后） | 真 | 按 P4 / P5 依赖 / P5 派发 / P6 / P8 / P10 重排；P8 行补 `state_conflict` |

**提交前的最后一条自检**（写进纪律）：改完 P2 还要再送一次确认——因为“可提交”是针对**评审看到的那棵树**说的，之后任何改动都让结论过期。所以第 42 轮的“可提交”在补正后需要第 43 轮复认，通过才提交。

## 43. 评审四十三（2026-11-11，**teammate 独立评审**，复认第 42 轮补正）

> 作用域：增量复认（第 42 轮判“可提交”之后又改了 5 条 P2，结论因此过期）。结论：**不可提交**——补正本身没写错，但 P2-2 把 rollback 变成“冻结版唯一出口”后，暴露出两个新 P1：**这条出口没有授权人**，而且**它要求建的 successor draft 行按现有 DDL 根本建不出来**。上一轮的死胡同没有打开，只是换了失败点。

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P1-1 | `rollback` 必须签、又是唯一出口，但 `docs/07` §2 动作矩阵没有这一行（查不到谁发起、谁签、独立性怎么算）；`design/03` §17 的过程外动作清单也不含它 | 真 | `docs/07` 加“**回滚 / 作废冻结版**”行：`decide@release` + `sign`，不能自签，**独立性不低于冻结**（`dual_human` 或 T0 `solo_cooldown(15m)`）；`design/03` §17 的过程外清单补 `rollback` |
| P1-2 | “同一次写入建 successor 的 draft 行”写不下去：release DDL 的 `frontier`/`baseline_hash`/`scope_spec_set` 都是 NOT NULL，此刻三列都没有值；`docs/02` 也没有任何“创建 release 行”的事件（只有冻结/交付/作废三个） | 真 | **选最简单的第三条路**：回滚**不建 successor 行**——只把旧版收尾（`release.superseded` + `rolled_back`），新版本走常规路径（声明范围 → 人签 `spec_set` → P8 冻结）。`docs/09` §7、`docs/06` payload、`docs/02` 事件行三处同步删掉 `successor_release_id` 与“同一次写入建行” |
| P2-1 | `p8-release` 图只有 scope 复查、没有步骤 11 的终态前置（`state_conflict`）节点 | 真 | `build.py` 模板补该分支并重建 |
| P2-2 | `p9-verify` 的 D 组示意行没有“终态互斥” | 真 | 模板 D 组行补“release scope 仍 valid 且终态互斥（rolled_back 后无 delivered）” |
| P2-3 | 覆盖口径句残留旧数字“18 项全覆盖” | 真 | 改 19 |
| P2-4 | rollback 示例 `"frontier": 812` 是整数，真源是字符串 hash | 真 | 改 `"f:9c1e…"` |
| P2-5 | `docs/09` 的“冻结写入路径（P8 步骤 2）”措辞错位（步骤 2 是前置校验，写 `release.frozen` 在步骤 7） | 真 | 改“冻结前置校验（P8 步骤 2）” |

**教训（第三条，记下来）**：修一个“没有出口”的缺口时，先问“这条出口自己要什么”——授权、载体、DDL 约束、事件来源。**出口不能比原路更贵**；如果新出口需要造一条没有事件来源的记录，就不要造，退回常规路径。

## 44. 评审四十四（2026-11-11，**teammate 独立评审**，复认第 43 轮补正）

> 作用域：增量复认（第 43 轮判“不可提交”后的 2 P1 + 5 P2）。结论：**可以提交**——本台账里第一次在“所有 P1 归零、补正落在载体而不只是文案”的状态下拿到绿灯。绿灯对应的树就是提交 `89e1d8c`（提交信息：第 38–44 轮评审修复）。

确认项（reviewer 逐条核）：rollback 授权行与冻结行同权同独立性、不更便宜；`successor_release_id` 与“同一次写入建 draft”在**真源**里清零（只剩本台账的历史处置行）；p8 图节点顺序 scope 复查 → 终态前置 → delivered 与正文步骤 10/11/12 一致；§14 实为 19 条、`design/03` “十九项”与覆盖口径一致；`state_conflict` 三处齐；`REVIEW`/`README` 编号自洽；`make all` 绿（probe 25 PASS、design 20 类）。

**未关闭但不阻塞提交**（提交后、进 M1 前处理）：
1. **P2 台账历史行**：§41 与 §42 的处置格仍写当时的 successor 方案，需要加“第 43 轮已撤销”的标注——否则后来人 grep 会误以为字段还在；
2. **P2 `release` 行的创建时机没有载体**（既有缺口，非本轮引入）：`docs/09` 允许 `deferred_to` 指向 draft release、`scope_spec_set` 要求“已声明”，但没有任何“建 release 行”的事件或动作，且 `frontier`/`baseline_hash`/`scope_spec_set` 三列 NOT NULL——三者不能同时成立。进 M1 前必须二选一定死：**①行只在 P8 冻结事务内建**（`release.frozen` 的载荷已含 in/out 集合，删掉 draft 相关表述与 `draft→frozen` 边）；**②保留 draft 行**（补“声明范围”动作与创建事件，DDL 放宽为 draft 行可空）；
3. **P3 措辞**：p9 的 D 组示意行补全“delivered 与 superseded 同时成立⇒红”；`design/03` 步骤 10 的“换成新 release 重做”改成“另开新 release 重做”（避免被读成同一笔写入建行）。

**纪律**：绿灯只对那一棵树成立。提交之后任何改动都要重新走一轮复认，**不要拿这次“可以提交”去覆盖后续改动**。

## 45. 评审四十五（2026-11-13，**teammate 独立评审**，表格渲染修复的增量复认）

> 作用域：增量（用户点名 `docs/04` 第 76 行表格渲染错之后的那 4 个文件：`docs/04`、`docs/03`、`docs/02`、`docs/check.py`）。结论：**可以提交**，2 个 P2 + 3 个 P3 均不阻塞。

起因不是评审：用户肉眼发现 `docs/04` 的判据表**表头 6 列、分隔行只有 5 段**，末列被吞。核实为真，且 `docs/03` 两行多一格、`docs/02` 载荷里的 `` `artifact_sha256|null` `` 裸竖线（包在反引号里也切格——GFM 的管表解析先于行内解析）。修完后加 **R19** 防复发。

| # | 发现 | 核实 | 处置 |
|---|---|---|---|
| P2-1 | 同一类断行在 `design/*.md` 还有 3 处，而 R19 只扫 `docs/*.md`：`design/README.md:66` 与 `design/REVIEW.md:418` 里「B 竖线 C」的写法、`design/REVIEW.md:590` 里「artifact_sha256 竖线 null」的写法 | 真（三行都被切多一格，与 04 同类） | 三行改写成不含裸竖线的写法（多目标写作 `B`、`C`；可空写作“（可为 null）”）；把检查**抽成仓库根 `mdtable.py`**，`docs/check.py` 的 R19 与 `design/check.py` 新增的 **R35** 共用一份实现——规则只写一处，两边不再漂 |
| P2-2 | R19 旧实现对 GFM 合法写法不可靠：省略首竖线的表**漏检**、省略尾竖线的行**误报**、围栏代码块里的表形内容**误报**、反斜杠+分隔符连写的边界少算一列 | 真（变异测试复现） | 重写为 `mdtable.scan()`：跳过围栏、行首/行尾竖线可选、只按**未转义**竖线切分；7 组单测（标准/省略首尾/只省尾/多一格/围栏内/转义/反引号内）全过，边界写进模块 docstring |
| P3-1 | `docs/check.py` 头部规则清单缺 R10–R18（既有，不是本轮引入） | 真 | docstring 补“R10–R18 见正文各段注释” |
| P3-2 | `docs` 的 R19（表格）与 `design` 的 R19（图产物重建）同号异义 | 真 | design 侧的新规则用 **R35**；docs 侧 R19 标注“docs 表格”，避免只写“R19 绿”时的歧义 |
| P3-3 | `artifact_sha256\|null` 也可用转义竖线保持原记号 | 可选 | 不采：表内少一个陷阱比记号统一更重要；`docs/06`/`docs/09` 在表格外仍用「`artifact_sha256` 可为 `null`」的写法，语义一致 |

**这一轮暴露的方法问题**：R19 第一版插在 `if bad: … sys.exit(1)` **之后**，等于没跑——是负例测试（把 04 的分隔行改回 5 段）才发现的。**新加的检查必须先证明它能红**，否则只是给通过行加了一个名字。

## 46. 当前状态与未覆盖项

- 判据 **24 条**、过程 **15 个**、图 **28 张**、设计表以 `docs/03` 表清单为准（探针子集 29 张）、模块 **20 个**；G1–G6 全 A（G6 = grant 真源，M4 再建）；探针 **25 PASS / 0 GAP**。
- **未覆盖（明确不声称已验）**：
  1. **假设状态机的规则已闭合，实现未写**：迁移规则、状态图、`disposition` 载荷、`probe #15`（规则级）都有了；但"代码里真的这么跑"、`assumption_set` 空集签字的落库、失效传播的实际执行，仍未验证；
  2. 运行时未验：`stored` / `sign` / isomorphic-git 并发 / P95 / T0 安装；
  3. 评审抽样的**规则**已进 `review.required` 与 P14，但**没跑过一轮**（P14 的抽样只在文档里），仍然只能靠实现期验证；
  4. **探针只到 DDL 约束**：`#16` 证明"配置非法值、无复验关缺陷、`actor_kind` 越界会被 SQLite 拒"，不证明 `config` 动作的权限/拒绝码、`config.changed` 的投影、缺陷关闭的 verify 对账——这些仍要靠实现与 verify 测。
- 下一轮评审若继续，优先看上面三项，而不是再加文档。

### 46.1 评审作用域（结论只在所述作用域内成立）

这套台账里两个会话的审法不同，**结论必须带作用域**，否则会被读成全局结论：

| 作用域 | 怎么审 | 能发现什么 | 不能发现什么 |
|---|---|---|---|
| **增量** | 只核上一轮的处置，加上它触达的面 | 修错、修窄、修过头 | 上一轮没提到的整块缺口 |
| **整套** | 从三条保证重推一遍，覆盖全部载体（判据/签字 schema/流程图/里程碑/probe） | 跨载体的"写了没接住" | 细节回归（那是增量的事） |

**教训**：第 27 轮（增量）写"无 P1"，第 28 轮（整套）立刻找出 3 个 P1。不是谁漏了，是**作用域不同**。所以：

- 每轮标题里的"复评/复审"默认是**增量**；只有写"整套设计审"的才是整套；
- **"无 P1" 只在所述作用域内成立**，台账里不再用它暗示"可收口"；
- **整套审放在里程碑门上**（进 M1 前、发版前各一次），不是每轮都做——每轮做增量，成本低、回归快。

### 46.2 机制预算读数（`docs/01` §11 要求）

| 项 | 现在 | 本轮新增机制类 |
|---|---|---|
| 判据 | 24 | 0（抽样是 `review.required` 的输入，不新增判据） |
| 过程 | 15 | 0 |
| 表 | 29 | +3（`config`/`defect`/`verify_run`） |
| 模块 | 20 | 0 |
| 图 | 28 | 0 |
| 机器规则 | **20 类（R0a–R0d + R19–R34）** | 0（R29–R34 是检查规则，不是产品机制） |
| 本批（六项变更）新增 | 2 个 `decision_kind`（`intent`/`plan`）、1 动作（`propose_plan`）、3 表（`config`/`defect`/`verify_run`）、3 拒绝码（`config_invalid`/`config_missing`/`member_capacity`）、2 列（`release` 的 `scope_spec_set` 列、`release_item.requirement_id`） | **独立机制 1**：部署配置从 baseline 拆出（旋钮不是尺子）；其余挂在既有对象上 |

**退休候选（`caught=0` 且无人消费）**：①`cleanup_timeout_s`——若 M2 前仍没有"清理"执行点就删掉；②`payload_too_large`——若 M1 实测正常签字包都远小于 64 KiB 且从未触发，就把它改成只报警不拒绝。先例是第七轮删掉的 `core_waived_unstated`（"写降级就放行"的分支，从未被走到）——给新机制定退休条件时，照这个做：**只要一个分支永远不可达，就删掉它，而不是留着"看起来在管"。**

### 46.3 结构与 OOM 覆盖自查（作者自查，非评审）

按"概念表 → 类/上下文/模块"和"过程 → 模块"两个方向对了一遍，查出 5 处覆盖缺口（都已修）：

| 缺口 | 处置 |
|---|---|
| `Baseline` / `Policy` 在 OOM 里没有身份：`Gate.policy : Policy` 引用了未定义类型，baseline 只以 `BaselineHash` 出现 | 类图加 `Baseline`（id/hash/prev/direction/freeze/validate）与 `Policy` 值对象；OOM §1 增「配置」上下文；矩阵加 3 条：冻结后不可变（收紧/放宽都建新行）、放宽须 `decision`、`kinds`/`after`/`artifact_kinds` 在 hash 内 |
| P15 的配置校验没有模块归属（`gate` 只写到"门禁判定 + baseline 冻结"） | `gate` 职责补「P15 配置校验（`kinds`/`after`/`guarantee_delta`/`na_stages`/`artifact_kinds`/`engine`）」；`design/01` §9 写明 `Baseline.validate` 是纯函数、归属 gate |
| `baseline.amended` / `baseline.loosened` 登记了却**没有语义与生产者** | P15「变更」段定死：收紧落 `amended`、放宽落 `loosened`，二者都是**新行**（`prev` + `direction`），绝不原地改 hash；`docs/04` §5.2 同步 |
| **P11 对齐/复述与 P12 假设处置两个过程没有任何模块** | 新增 L1 模块 `alignment`；模块数 19→20；**加机器规则 R30**：`design/03` §17 表新增「模块」列，P1–P15 每个过程都必须有归属 |
| `Attention` 是"在等谁"的唯一源却没有任何对象；`Restatement` 只有过程没有对象 | 类图加 `Attention`、`Restatement`（Intent 聚合内实体）；`Release`/`Decision` 补到 `Baseline` 的跨聚合虚线 |

> 第 37 轮复审后已同步：`Intent`/`GoalNode` 的 `decisionId`、`Attention` 的三态与寿命列、`Defect` 类都已进类图模板与矩阵（不再只是文档字段）。

另有两处**刻意不补**，已写进 `design/02` §2/§3 免得下次被当遗漏：

- `redteam`/`scenario`/`restatement_diff`/`report`/`receipt`/`scope_decl` 是记录或值对象，随聚合写、无独立身份，所以不进核心类图；
- `Baseline`/`Attention` 没有状态机：前者"当前用哪版"是查询（取最新已冻结行）、后者 `answered_by` 非空即已答——画成状态图会造出第二个状态源。

**这一节是作者自查，不构成独立性证据**；评审口径仍看上面 1–13 轮。
