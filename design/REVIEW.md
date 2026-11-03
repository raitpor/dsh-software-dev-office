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

## 10. 当前状态与未覆盖项

- 判据 **24 条**、过程 **15 个**、图 **25 张**、表 **26 张**；G1–G5 全 A；探针 **17 PASS / 0 GAP**。
- **未覆盖（明确不声称已验）**：
  1. assumption 状态机（`assumption.disposed` / `assumption.invalidated` / `assumption_set` 空集）只在判据与 P12，未进 probe；
  2. 运行时未验：`stored` / `sign` / isomorphic-git 并发 / P95 / T0 安装；
  3. "必须评审"目前按风险/kind 判定，**抽样强制**（每 N 张卡必抽 1 张）尚未落地——作者仍可只送稳的卡。
- 下一轮评审若继续，优先看上面三项，而不是再加文档。
