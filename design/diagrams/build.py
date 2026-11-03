#!/usr/bin/env python3
"""生成设计图。

分工：
- **PlantUML**：流程图（activity）、类图、状态图、顺序图 —— UML 语义最正；
- **Graphviz**：N-S 图、PAD 图、判定树 —— PlantUML 没有对应的原生图形。

输出：design/diagrams/<name>.svg 与 .png；源文件 <name>.puml / <name>.dot。
用法：
  python3 design/diagrams/build.py            # 重建全部产物
  python3 design/diagrams/build.py --check    # 只在临时目录重建，比对产物是否已过期
"""
from __future__ import annotations

import filecmp
import os
import subprocess
import sys
import tempfile
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = "--check" in sys.argv[1:]
OUT = tempfile.mkdtemp(prefix="sdo-diagrams-") if CHECK else HERE
RENDERED: list[str] = []


def write(name: str, suffix: str, body: str) -> str:
    path = os.path.join(OUT, f"{name}.{suffix}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return path


def plantuml(name: str, body: str) -> None:
    src = write(name, "puml", "@startuml\n" + textwrap.dedent(body).strip() + "\n@enduml\n")
    for fmt in ("png", "svg"):
        subprocess.run(["plantuml", f"-t{fmt}", src], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    RENDERED.append(name)
    if not CHECK:
        print("ok(plantuml)", name)


def graphviz(name: str, body: str) -> None:
    src = write(name, "dot", "digraph G {\n  graph [bgcolor=white, pad=0.3];\n"
                                 "  node [fontname=\"Noto Sans CJK SC\", fontsize=11];\n"
                                 "  edge [fontname=\"Noto Sans CJK SC\", fontsize=10];\n"
                                 + textwrap.dedent(body) + "\n}\n")
    for fmt in ("svg", "png"):
        subprocess.run(["dot", f"-T{fmt}", src, "-o",
                        os.path.join(OUT, f"{name}.{fmt}")], check=True,
                       stdout=subprocess.DEVNULL)
    RENDERED.append(name)
    if not CHECK:
        print("ok(graphviz)", name)



# ============ 结构化设计：组件图 ============

plantuml("arch-components", """
skinparam componentStyle rectangle
package "L3 接口层" {
  component "tools" as tools
  component "cli" as cli
  component "views" as views
}
package "L2 应用层" {
  component "handlers" as h
  component "workflow" as wf
  component "query" as q
}
package "端口（L1 只通过它访问外部）" {
  component "DatabasePort" as DBPort
  component "VcsPort" as VcsPort
  component "SignerPort" as SignerPort
}
package "L1 领域层" {
  component "fold" as fold
  component "criteria" as criteria
  component "gate" as gate
  component "alignment" as align
  component "admission" as admission
  component "dispatch" as dispatch
  component "review" as review
  component "execution" as exec
  component "verify" as verify
  component "release" as release
  component "sign" as sign
}
package "L0 内核" {
  component "core" as core
}
node "stored（持库钥）" as ST
node "signerd（持私钥）" as SG
component "内嵌 git 对象库" as VCS
database "SQLite / SQLCipher" as DB

tools --> h
cli --> h
views --> q
q --> fold
h --> fold
h --> admission
h --> align
h --> gate
wf --> dispatch
wf --> release

fold --> core
criteria --> core
gate --> criteria
align --> core
admission --> gate
review --> core
exec --> core
release --> gate
release --> sign
sign --> core

fold --> DBPort
criteria --> DBPort
gate --> DBPort
align --> DBPort
admission --> DBPort
dispatch --> align
dispatch --> DBPort
review --> DBPort
exec --> DBPort
release --> DBPort
verify --> DBPort
sign --> DBPort
DBPort --> ST
VcsPort --> VCS
admission --> VcsPort
dispatch --> VcsPort
release --> VcsPort
verify --> VcsPort
sign --> SignerPort
SignerPort --> SG
ST --> DB
""")



# ============ 过程逻辑：流程图（PlantUML activity） ============

plantuml("p1-criterion-register", """
start
:register(request);
if (字段齐全?) then (否)
  :拒绝 invalid_field;
  stop
else (是)
endif
if (remedy 非空?) then (否)
  :拒绝 remedy_required;
  stop
else (是)
endif
if (有负例夹具?) then (否)
  :拒绝 negative_fixture_required;
  stop
else (是)
endif
if (正例实跑 = pass?) then (否)
  :拒绝 positive_fixture_failed;
  stop
else (是)
endif
if (负例实跑 = fail?) then (否)
  :拒绝 negative_fixture_not_red;
  stop
else (是)
endif
if (单次执行 < 200ms?) then (否)
  :拒绝 budget_exceeded;
  stop
else (是)
endif
:事务：写 criterion + fixtures + criterion.registered;
if (UNIQUE 冲突（同输入已存在）?) then (是)
  :回滚 ⇒ 映射 duplicate_fixture;
  stop
else (否)
endif
:提交 ⇒ 返回 criterion_id;
stop
""")

plantuml("p4-admission", """
start
:admission.evaluate(task);
if (lease 有效?) then (否)
  :拒绝 no_lease ⇒ admission.rejected + 卡 blocked;
  stop
else (是)
endif
if (workcopy 基于基线?) then (否)
  :拒绝 stale_workcopy ⇒ admission.rejected + 卡 blocked;
  stop
else (是)
endif
if (diff ⊆ scope?) then (否)
  :拒绝 ⇒ boundary.violation + admission.rejected + 卡 blocked;
  stop
else (是)
endif
if (判据全绿?) then (否)
  :拒绝 criteria_red ⇒ admission.rejected + 卡 blocked;
  stop
else (是)
endif
if (主树干净?) then (否)
  :阻塞 dirty_main_tree;
  stop
else (是)
endif
:合并卡快照 → 主树重检出 → 落库;
stop
""")

plantuml("p8-release", """
start
:确定 in/out 集合;
:缺口 = 差集（release.gaps_match）;
if (冻结前置五条全过（见 03 §9）？) then (否)
  :拒绝 freeze_blocked(reason_code);
  stop
else (是)
endif
if (证据在冻结 frontier 内有效、弃用窗口未过期？) then (否)
  :拒绝 release.evidence_valid / release.deprecation_window;
  stop
else (是)
endif
if (人执行 scenario 抽样：≥3 条、高风险条款每条款 ≥1？) then (否)
  :拒绝 scenario_not_run（模型跑的不算）;
  stop
else (是)
endif
:生成审计快照 JSONL（frozen_at_frontier）;
if (审计快照 verify 通过？) then (否)
  :拒绝 release.snapshot_verified;
  stop
else (是)
endif
:签字：decision.valid + decision.signed;
:写 release.frozen（status='frozen' 的唯一生产者）;
:checkout(snapshot_id);
:build + pack;
:记 package_sha256 + snapshot_id;
if (产物与证据对得上？) then (否)
  :拒绝 artifact_mismatch（停在 frozen，不落 delivered）;
  stop
else (是)
endif
:写 release.delivered（status='delivered' 的唯一生产者）;
stop
""")


plantuml("uml-state-release", """
hide empty description
[*] --> draft
draft --> frozen : release.frozen（前置五条 + decision.signed）
frozen --> delivered : release.delivered（绑 package_sha256 + snapshot_id）
delivered --> rolled_back : decision(kind=rollback) + release.superseded
rolled_back --> [*] : 原记录保留，另开新 release
delivered --> [*]
""")

plantuml("uml-state-criterion", """
hide empty description
[*] --> draft
draft --> active : 注册门槛通过（remedy + 正负例）
active --> retired : 连续 3 迭代 caught=0 ⇒ 退休候选 → 退休
retired --> [*]
note right of draft : 退休候选是 gaps 行，不是状态
""")


plantuml("p9-verify", """
start
:verify（全量对账）;
note right: 条目定义在 docs/02 §14（十项）+ docs/14 两条兜底；这里只分组与失败码
:A 事件链：hash 链连续、prev 存在、cursor 与事件数一致;
if (A 全过?) then (否)
  :红：chain_broken;
  :写 verify.failed + blocked(verify_failed) + attention.raised;
  stop
else (是)
endif
:B 引用：subject 外键可解析、claim.derived_by 已注册、snapshot_parent 无悬空、kind ⊆ event_kind;
if (B 全过?) then (否)
  :红：reference_dangling;
  :写 verify.failed + blocked(verify_failed) + attention.raised;
  stop
else (是)
endif
:C 判定：派生列 = 重算值、判据有正例且负例、baseline.hash 一致、签名可验且 signer ≠ producer;
if (C 全过?) then (否)
  :红：judgement_mismatch;
  :写 verify.failed + blocked(verify_failed) + attention.raised;
  stop
else (是)
endif
:D 运行态：busy 卡有未过期 lease 且 actor 一致、库加密状态与 assurance 一致;
if (D 全过?) then (否)
  :红：runtime_inconsistent;
  :写 verify.failed + blocked(verify_failed) + attention.raised;
  stop
else (是)
endif
:写 verify.passed（含四组读数）;
stop
""")

plantuml("p10-sign", """
start
:请求签字（模型只说 request_sign）;
:组成 payload（命题 + 证据 + frontier + content_hash）;
if (payload/frontier 与 preview 一致?) then (否)
  :拒绝 payload_moved ⇒ 写 decision.rejected;
  stop
else (是)
endif
if (signer ≠ producer?) then (否)
  :拒绝 self_sign ⇒ 写 decision.rejected;
  stop
else (是)
endif
if (独立性满足（dual_human 或冷却）?) then (否)
  :blocked(awaiting_signature) + attention;
  stop
else (是)
endif
:signerd 签名（私钥不出进程）;
:落 decision.valid + decision.signed;
stop
""")

# ============ 过程逻辑：N-S / PAD / 判定树（Graphviz） ============

graphviz("p2-gate-ns", """
  node [shape=box, style=filled, fillcolor="#f5f7fa"];
  n0 [label="取 baseline 与当前 frontier"];
  n1 [shape=diamond, fillcolor=white, label="frontier 或 baseline_hash 不一致?"];
  s1 [fillcolor="#fde2e1", label="verdict = fail（reason_code=stale_fail）"];
  n2 [label="逐条判据：不适用当前 stage ⇒ na；否则 run(c)"];
  n3 [shape=diamond, fillcolor=white, label="policy_mode = all_of?"];
  v1 [label="verdict = 全部 ∈ {pass, na} ? pass : fail"];
  v2 [fillcolor="#fff4d6", label="verdict = 存在 pass ? pass : fail"];
  map [shape=box, label="stage_run.verdict：pass→pass；fail→changes_requested；na→na"];
  n4 [label="写 gate.judged（含每条读数、data 里的 elapsed_ms）"];
  n5 [shape=diamond, fillcolor=white, label="整组耗时 ≥ 2s?"];
  n6 [fillcolor="#fff4d6", label="记一行 gaps（拆门/加索引）；不改变 verdict"];
  n0 -> n1;
  n1 -> s1 [label="是"]; n1 -> n2 [label="否"];
  s1 -> map;
  n2 -> n3;
  n3 -> v1 [label="是"]; n3 -> v2 [label="否"];
  v1 -> map; v2 -> map;
  map -> n5;
  n5 -> n6 [label="是"]; n5 -> n4 [label="否"];
  n6 -> n4;
""")

graphviz("p3-two-phase-pad", """
  rankdir=TB;
  root [shape=box, label="confirm(request)"];
  s1 [shape=box, label="1 读 preview"];
  s1a [shape=box, style=filled, fillcolor="#fde2e1", label="不存在 ⇒ stale_preview"];
  s1b [shape=box, style=filled, fillcolor="#fde2e1", label="过期 ⇒ expired_preview"];
  s52 [shape=box, label="2 幂等：preview 已消费？"];
  s52a [shape=box, style=filled, fillcolor="#e3f5e1", label="是 ⇒ 返回首次结果（不再校验、不再写）"];
  s2 [shape=box, label="3 校验 payload_hash"];
  s2a [shape=box, style=filled, fillcolor="#fde2e1", label="不一致 ⇒ payload_changed"];
  s3 [shape=box, label="4 校验 frontier"];
  s3a [shape=box, style=filled, fillcolor="#fde2e1", label="已移动 ⇒ frontier_moved"];
  s3g [shape=box, label="5 权限/影响面（grant × scope）"];
  s3h [shape=box, style=filled, fillcolor="#f5f7fa", label="5.1 本 preview 已有有效签字？按 payload_hash + frontier 匹配 decision(status=valid)"];
  s3ha [shape=box, style=filled, fillcolor="#e3f5e1", label="有 ⇒ 视为已授权，继续"];
  s3ga [shape=box, style=filled, fillcolor="#fff4d6", label="无且未覆盖/超 max_impact ⇒ requires=human_sign：返回 pending_sign，不消费 preview"];
  s3gb [shape=box, label="无且覆盖 ⇒ requires=delegated"];
  s35 [shape=box, label="6 baseline 方向：收紧自动 / 放宽需人签"];
  s35a [shape=box, style=filled, fillcolor="#fde2e1", label="放宽但无签名 ⇒ baseline_loosened"];
  s4 [shape=box, label="7 领域校验 invariants"];
  s4a [shape=box, style=filled, fillcolor="#fde2e1", label="失败 ⇒ invariant_violated"];
  s51 [shape=box, label="8 will_change 与 preview 逐条一致"];
  s51a [shape=box, style=filled, fillcolor="#fde2e1", label="不一致 ⇒ will_change_drift"];
  s5 [shape=box, style=filled, fillcolor="#e3f5e1", label="9 事务：追加事件 + 更新投影 + 标记 preview 已消费"];
  s6 [shape=box, style=filled, fillcolor="#e3f5e1", label="返回 {id, frontier}"];
  root -> s1;
  s1 -> s1a; s1 -> s1b; s1 -> s52;
  s52 -> s52a; s52 -> s2;
  s2 -> s2a; s2 -> s3;
  s3 -> s3a; s3 -> s3g;
  s3g -> s3h;
  s3h -> s3ha; s3h -> s3gb;
  s3ha -> s35;
  s3gb -> s3ga; s3gb -> s35;
  s35 -> s35a; s35 -> s4;
  s4 -> s4a; s4 -> s51;
  s51 -> s51a; s51 -> s5;
  s5 -> s6;
""")

graphviz("p5-dispatch-tree", """
  rankdir=TB;
  a [shape=diamond, label="候选集为空?"];
  b [shape=diamond, label="存在可复用候选?"];
  c [shape=diamond, label="new_reason 合法?"];
  y1 [shape=box, style=filled, fillcolor="#e3f5e1", label="复用（不允许新起）"];
  y2 [shape=box, style=filled, fillcolor="#e3f5e1", label="派发新会话"];
  n1 [shape=box, style=filled, fillcolor="#fde2e1", label="拒绝 new_reason_required"];
  a -> b [label="否"]; a -> c [label="是"];
  b -> y1 [label="是"]; b -> c [label="否"];
  c -> y2 [label="是"]; c -> n1 [label="否"];
""")

graphviz("p6-append-pad", """
  rankdir=TB;
  r [shape=box, label="append(event)"];
  s1 [shape=box, label="1 BEGIN IMMEDIATE"];
  s1a [shape=box, style=filled, fillcolor="#fff4d6", label="拿不到锁 ⇒ busy"];
  s2 [shape=box, label="2 计算 frontier′ = closure(frontier ∪ {new})"];
  s3 [shape=box, label="3 hash = sha256(prev_hash + canonical(payload))"];
  s4 [shape=box, label="4 insert event + 更新受影响投影（同一事务）"];
  s5 [shape=box, style=filled, fillcolor="#e3f5e1", label="5 commit ⇒ 返回 id"];
  s5b [shape=box, style=filled, fillcolor="#fde2e1", label="失败 ⇒ 回滚（事件与投影一起）"];
  r -> s1; s1 -> s1a; s1 -> s2; s2 -> s3; s3 -> s4; s4 -> s5; s4 -> s5b;
""")

graphviz("p7-change-tree", """
  rankdir=TB;
  a [shape=diamond, label="受影响对象类型?"];
  b [shape=box, label="spec(requirement)：重渲染下游 design；旧 claim 标记 stale"];
  c [shape=diamond, label="实现卡状态?"];
  c1 [shape=box, label="未开工 ⇒ 回 ready，被阻断"];
  c2 [shape=box, label="在飞 ⇒ blocked(upstream_changed)，保留工作副本"];
  c3 [shape=diamond, label="重验 intent.baseline_hash"];
  c3a [shape=box, style=filled, fillcolor="#e3f5e1", label="成立 ⇒ reopened + 重新举证"];
  c3b [shape=box, style=filled, fillcolor="#fff4d6", label="不成立 ⇒ 需人重签（attention）"];
  d [shape=box, label="release：冻结前必须处理（进/出本版）"];
  a -> b [label="requirement"]; a -> c [label="task"]; a -> d [label="release"];
  c -> c1; c -> c2; c -> c3;
  c3 -> c3a [label="是"]; c3 -> c3b [label="否"];
""")

# ============ OOM：类图（PlantUML） ============

plantuml("uml-class", """
skinparam classAttributeIconSize 0
hide circle
class Intent {
  + id : IntentId
  + statement : string
  + sourceText : string
  + strength : Strength
  + approvedBy : ActorId
  + contentHash : ContentHash
  + baseline : BaselineHash
  + approve(by)
  + reaffirm(baseline)
}
class GoalNode {
  + id : NodeId
  + parent : NodeId
  + intent : IntentId
  + goal : string
  + kind : Kind
  + scope : ScopePaths
  + acceptance : CriterionRef
  + declare()
  + acceptViaIntegration()
}
class Task {
  + id : TaskId
  + status : Status
  + lease : LeaseRef
  + block : BlockCode
  + inputs : InputRef[]
  + claim(lease)
  + complete(evidence)
  + reopen(reason)
}
class WorkUnit {
  + id : WorkUnitId
  + criterion : CriterionId
  + spec : SpecId
  + evidence : EvidenceId
}
class Criterion {
  + id : CriterionId
  + remedy : Remedy
  + guarantee : Guarantee
  + appliesTo : list
  + register()
}
class Fixture {
  + polarity : Polarity
  + input : string
  + expected : Verdict
}
class Gate {
  + id : GateId
  + stage : StageId
  + criteria : list
  + policyMode : Mode
  + waivable : bool
  + judge(readings) : Verdict
}
class StageRun {
  + id : StageRunId
  + gateId : GateId
  + baseline : BaselineHash
  + criteria : list
  + verdict : Verdict
}
class Snapshot {
  + id : SnapshotId
  + oid : GitOid
  + take(parents)
  + checkout(to)
}
class Decision {
  + id : DecisionId
  + payload : PayloadHash
  + frontier : Frontier
  + sign(signer)
}
class ReviewRound {
  + id : RoundId
  + taskId : TaskId
  + baselineHash : BaselineHash
  + frontier : Frontier
  + verdict : Verdict
  + signer : ActorId
  + open()
  + close()
}
class Agent {
  + id : AgentId
  + state : State
  + watermark : number
}
class Spec {
  + id : SpecId
  + intent : IntentId
  + kind : Kind
  + status : Status
  + blastRadius : string
  + isCore : bool
  + alternatives : list
  + noAlternativeReason : string
  + createdBy : ActorId
  + producer : ActorId
  + contentHash : ContentHash
  + riskFlags : list
}
class Evidence {
  + id : EvidenceId
  + artifactSha256 : string
  + snapshot : SnapshotId
  + commit : string
}
class Lease {
  + id : LeaseId
  + agent : AgentId
  + task : TaskId
  + expiresAt : Timestamp
}
class WorkCopy {
  + id : WorkCopyId
  + task : TaskId
  + base : SnapshotId
}
class SnapshotParent {
  + snapshot : SnapshotId
  + parent : SnapshotId
}
class Release {
  + id : ReleaseId
  + inSet : Set
  + outSet : Set
  + status : Status
  + baselineHash : BaselineHash
  + frontier : Frontier
  + frozenBy : list
  + freeze(baselineHash)
  + deliver(packageSha256, snapshotId)
  + rollback(newReleaseId)
}
class Baseline {
  + id : BaselineId
  + hash : BaselineHash
  + prev : BaselineId
  + direction : Direction
  + frozenBy : ActorId
  + content : BaselineContent
  + freeze(content, prev, direction) : BaselineId
  + validate(content) : ReasonCode[]
}
class BaselineContent {
  + policy : Policy
  + criteria : CriterionRef[]
  + gates : GateSpec[]
  + thresholds : Map
  + assurance : Assurance
  + engine : Engine
}
class CriterionRef {
  + id : CriterionId
  + version : number
  + params : Map
  + guarantee : Guarantee
}
class GateSpec {
  + id : GateId
  + stage : StageId
  + criteria : list
  + policyMode : Mode
  + waivable : bool
}
class Policy {
  + id : PolicyId
  + preset : string
  + stages : StageDef[]
  + gates : GateBinding
  + switches : Map
  + regression : Regression
  + artifactKinds : Map
}
class Restatement {
  + id : RestatementId
  + intent : IntentId
  + inputs : list
  + at : Timestamp
  + invalidate()
}
class Attention {
  + id : AttentionId
  + task : TaskId
  + question : string
  + options : list
  + answeredBy : ActorId
}
interface IntentRepository
interface EventStore {
  + append(event)
  + readTo(frontier)
}
interface SnapshotRepo
interface SignerPort {
  + sign(payload)
}
class ClockPort {
  + now()
}

Intent "1" ..> "1..*" Spec : 跨聚合
Spec "1" ..> "1..*" Criterion : 跨聚合
WorkUnit ..> Evidence
Task ..> Lease
Task ..> WorkCopy
Snapshot "1" --> "1..*" SnapshotParent
Intent "1" --> "1..*" Restatement : 复述（聚合内）
Intent "1" ..> "1" GoalNode : 根（跨聚合）
GoalNode --> GoalNode : 分解
GoalNode ..> Criterion : 叶验收（跨聚合）
Task "1" --> "1" WorkUnit
WorkUnit ..> Criterion : 跨聚合
Criterion "1" --> "1..*" Fixture
Gate ..> Criterion : 引用（跨聚合）
StageRun ..> Gate : 引用
Release ..> Snapshot : 交付绑快照（跨聚合）
Baseline "1" *-- "1" BaselineContent
BaselineContent "1" *-- "1" Policy
BaselineContent "1" *-- "1..*" CriterionRef
BaselineContent "1" *-- "1..*" GateSpec
Gate ..> GateSpec : 定义来自（跨聚合）
Intent ..> Baseline : 批准时依据（跨聚合）
StageRun ..> Baseline : 判定绑哪版尺子（跨聚合）
Release ..> Baseline : 本版按哪把尺子判（跨聚合）
Decision ..> Baseline : 冻结/放宽签字（跨聚合）
Task ..> Attention : 等人回答（跨聚合）
Task ..> Agent : 认领者（跨聚合）
Intent ..> IntentRepository
Task ..> EventStore
Snapshot ..> SnapshotRepo
Decision ..> SignerPort
StageRun ..> ClockPort
""")

# ============ OOM：状态图（PlantUML） ============

plantuml("uml-state-task", """
hide empty description
[*] --> planned
planned --> ready : 依赖满足
ready --> in_progress : claim(lease)
in_progress --> blocked : 上游变更 / 等输入
blocked --> in_progress : 解除
in_progress --> done : complete(判据绿)
done --> in_progress : reopened(reason)
ready --> dropped
done --> dropped : delivered_deferred
done --> [*]
dropped --> [*]
""")

plantuml("uml-state-agent", """
hide empty description
[*] --> idle
idle --> busy : dispatch(lease)
busy --> idle : 任务返回
busy --> compacting : watermark ≥ 阈值
compacting --> idle : report_compaction
idle --> parked : 停泊
parked --> idle : 唤醒
parked --> parked : 7 天未唤醒 ⇒ 标 stale（不杀、不唤醒，进 gaps）
busy --> dead : unwakeable
idle --> dead : unwakeable
parked --> dead : unwakeable（探测失败）
dead --> [*]
""")

plantuml("uml-state-stagerun", """
hide empty description
[*] --> running : stage.entered
running --> closed : stage.exited（exited_at 非空）
running --> closed : na（该 policy 下无此阶段）
note right of closed : verdict 是属性：pass / changes_requested / na
closed --> [*]
""")

plantuml("uml-state-intent", """
hide empty description
[*] --> draft
draft --> proposed : 提交
proposed --> signed : 人签（approved_by + content_hash）
signed --> proposed : statement 变 ⇒ content_hash 变（必须重签）
signed --> superseded : 被新意图取代
superseded --> [*]
signed --> [*]
""")

plantuml("uml-state-assumption", """
hide empty description
[*] --> open : assumption.recorded
open --> confirmed : assumption.disposed(confirmed) + 进 assumption_set
open --> rejected : assumption.disposed(rejected, successor_ref)
open --> converted : assumption.disposed(converted, successor_ref=新条款)
rejected --> converted : 后继条款落地后补记
confirmed --> open : assumption.invalidated（依赖变了）
rejected --> open : assumption.invalidated
converted --> open : assumption.invalidated
open --> [*]
confirmed --> [*]
rejected --> [*]
converted --> [*]
""")

plantuml("uml-state-spec", """
hide empty description
[*] --> defined
defined --> revised : spec.revised（必带 reason 与影响面）
revised --> revised : 再次修订（旧版本保留）
defined --> [*]
revised --> [*]
""")

plantuml("uml-state-review", """
hide empty description
[*] --> open
open --> open : finding 追加 / 逐条核实
open --> closed : close(verdict)
note right of closed : verdict ∈ {pass, changes_requested} 是属性，不是状态
closed --> [*]
""")

# ============ OOM：顺序图（PlantUML） ============

plantuml("uml-seq-claim", """
autonumber
participant "Dispatch" as D
participant "AgentPool" as P
participant "Lease" as L
participant "SnapshotService" as S
participant "Task" as T
participant "EventStore" as E

D -> P : pick(card)
P --> D : 复用候选 / 需新起（new_reason）
D -> L : issue(lease)
D -> S : checkout(base)
D -> T : claim(lease)
T -> E : task.claimed
T -> T : 执行中（过程逻辑见 03 P6）
T -> E : evidence.attached + report.recorded(ready)
T -> S : take(parent=[base])
T -> E : task.done
""")

plantuml("uml-seq-admission", """
autonumber
participant "Admission" as A
participant "Lease" as L
participant "SnapshotService" as S
participant "GateEvaluator" as G
participant "EventStore" as E

A -> L : 校验 lease
A -> S : 取 workcopy 与基线
A -> S : diff(workcopy, base)
A -> G : 复跑判据
G --> A : 读数
note right of A : 判定与分支见 03 · P4（唯一处）
A -> S : 合并卡快照
A -> S : 主树重检出
A -> E : 落库（admission 结果）
""")

plantuml("uml-seq-review", """
autonumber
participant "ReviewRound" as R
participant "Reviewer" as V
participant "Author" as A
participant "Decision" as D
participant "EventStore" as E

R -> V : open(subject, subject_hash, subject_producer)
V -> E : review.recorded(finding)
E --> A : 待核实
A -> E : review.finding_verified(verdict)
note right of R : 收口条件见 02 · 状态图 ReviewRound（唯一处）
R -> D : close(verdict)
D -> E : decision.valid
R -> E : review.round_closed(verdict, findings)
""")

plantuml("uml-seq-release", """
autonumber
participant "Release" as R
participant "SnapshotService" as S
participant "Build" as B
participant "SignService" as Sig
participant "EventStore" as E

R -> S : 取目标快照
S --> B : 工作目录
R -> Sig : sign(缺口清单 + frozen_at_frontier)
Sig -> E : decision.valid + decision.signed
R -> E : release.frozen（status='frozen' 的唯一生产者）
B --> R : 产物
note right of R : 缺口计算/校验/打包细节见 03 · P8（唯一处）
R -> E : release.delivered（绑 package_sha256 + snapshot_id）
""")

plantuml("uml-seq-config", """
autonumber
actor 人
participant "tools" as tools
participant "handlers" as H
participant "gate（Baseline）" as G
participant "store" as E
participant "sign" as S
participant "signerd" as D

tools -> H : sdo_act(baseline_freeze, config)
H -> G : validate(content)
G --> H : reason_codes[] 或 空
alt 校验不过
  H -> G : reject(content, reason_codes)
  G -> E : baseline.rejected(reason_code)
  G --> H : reason_code
  H --> tools : 回执 reason_code
else 校验通过
  H -> G : buildPreview(content)
  G --> H : will_change + guarantee_delta + payload_hash
  H --> tools : pending_sign(preview_id)
  人 -> D : 解锁并确认这一版影响面
  S -> D : sign(payload)
  D --> S : signature
  S -> E : decision.valid / decision.signed
  tools -> H : confirm(preview_id, payload_hash, frontier)
  H -> G : freeze(content, prev, direction)
  G -> E : baseline.frozen 或 baseline.amended 或 baseline.loosened
  H --> tools : {baseline_id, hash}
end
note right of G : 收紧落 amended、放宽落 loosened，两者都建新行（03 · P15 唯一处）
""")

plantuml("uml-seq-align", """
autonumber
participant "alignment" as A
participant "store" as E
participant "dispatch" as P
participant "sign" as S

A -> E : restatement.recorded（绑 intent + 关键条款 hash）
A -> A : diff 逐条 disposition
A -> E : restatement.diff_dispositioned
A -> E : assumption.recorded（spec(kind='assumption')）
P -> A : 派发前查假设是否处置
alt 还有 open 假设
  A --> P : 不派发
  A -> E : attention.raised
else 全部处置
  S -> E : decision.valid / decision.signed（assumption_set，空集也签）
  A --> P : 允许派发
end
note right of A : 复述作废与假设失效传播见 03 · P11/P12（唯一处）
""")

plantuml("uml-seq-change", """
autonumber
participant "ChangeService" as C
participant "FoldService" as F
participant "Task" as T
participant "Mandate" as M
participant "EventStore" as E

C -> F : 求影响集
F --> C : 受影响对象
C -> T : 处置已完成卡
C -> M : 重验授权依据
note right of C : 分支（重开/重签）见 03 · P7（唯一处）
M --> C : 结论
C -> E : task.reopened 或 attention.raised
""")

if not CHECK:
    print("done")

if CHECK:
    stale = []
    exts = (".svg", ".png", ".puml", ".dot")
    for name in sorted(os.listdir(OUT)):
        ext = os.path.splitext(name)[1]
        if ext not in exts:
            continue
        fresh = os.path.join(OUT, name)
        kept = os.path.join(HERE, name)
        if not os.path.exists(kept) or not filecmp.cmp(kept, fresh, shallow=False):
            stale.append(name)
    total = sum(1 for n in os.listdir(OUT) if os.path.splitext(n)[1] in (".svg", ".png"))
    if stale:
        print(f"✗ 图文件与模板不一致 {len(stale)} 个：")
        for s in sorted(stale):
            print("   -", s)
        print("  修法：python3 design/diagrams/build.py（产物与源文件都只由模板生成，不许手改）")
        sys.exit(1)
    print(f"✓ 图产物与模板一致（{total} 个产物文件，{len(RENDERED)} 张图）")
