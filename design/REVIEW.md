# 设计评审记录

> 本文件是 `design/` 的评审台账：每条发现都给**处置**与**落点**，避免"已通过"只剩 commit 信息作证。

**谁写的、谁审的（独立性怎么判）**：

- **作者**：本仓库的全部文档改动都来自实现会话（有写工具并实际改文件）；
- **评审**：两轮都由**只读会话**执行——它们的工具面只有读/检索/记忆，**没有写权限**，改不了被评审的对象；
- 判定口径：**看"谁有写工具并实际改了文件"，不看"谁写过记忆"**。记忆节点的会话字段只说明"这条记忆是谁写的"，不能当作者身份用。

> 具体会话标识与工具调用计数属本机信息，**不入库**（需要追溯时查本地会话记录）。

## 1. 评审一（2026-11-02，独立只读会话）

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

## 2. 评审二（2026-11-02 至 11-03，独立只读会话）

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

## 3. 评审三（2026-11-03，独立只读会话）

**起点**：policy 定为 preset、P15 配置冻结、`artifact_kinds` 进 baseline 之后。**结论**：配置面方向正确；指出 1 个 P0 + 5 个 P1，已全部处置。

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
| P2 `sdo_act` 没有 baseline 冻结动作 | 定义 `action='baseline_freeze'`（非两段式；校验→`baseline.rejected` 或转 `request_sign`） | `docs/05` §1 |
| P2 冻结失败不落事件（不可追溯） | 落 `baseline.rejected(reason_code)`；登记进事件表 | `docs/02`、P15 |

## 4. 当前状态与未覆盖项

- 判据 **24 条**、过程 **15 个**、图 **25 张**、表 **26 张**；G1–G5 全 A；探针 **17 PASS / 0 GAP**。
- **未覆盖（明确不声称已验）**：
  1. assumption 状态机（`assumption.disposed` / `assumption.invalidated` / `assumption_set` 空集）只在判据与 P12，未进 probe；
  2. 运行时未验：`stored` / `sign` / isomorphic-git 并发 / P95 / T0 安装；
  3. "必须评审"目前按风险/kind 判定，**抽样强制**（每 N 张卡必抽 1 张）尚未落地——作者仍可只送稳的卡。
- 下一轮评审若继续，优先看上面三项，而不是再加文档。
