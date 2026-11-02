#!/usr/bin/env python3
"""生成设计图。

分工：
- **PlantUML**：流程图（activity）、类图、状态图、顺序图 —— UML 语义最正；
- **Graphviz**：N-S 图、PAD 图、判定树 —— PlantUML 没有对应的原生图形。

输出：design/diagrams/<name>.svg 与 .png；源文件 <name>.puml / <name>.dot。
用法：python3 design/diagrams/build.py
"""
from __future__ import annotations

import os
import subprocess
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name: str, suffix: str, body: str) -> str:
    path = os.path.join(HERE, f"{name}.{suffix}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return path


def plantuml(name: str, body: str) -> None:
    src = write(name, "puml", "@startuml\n" + textwrap.dedent(body).strip() + "\n@enduml\n")
    for fmt in ("png", "svg"):
        subprocess.run(["plantuml", f"-t{fmt}", src], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("ok(plantuml)", name)


def graphviz(name: str, body: str) -> None:
    src = write(name, "dot", "digraph G {\n  graph [bgcolor=white, pad=0.3];\n"
                                 "  node [fontname=\"Noto Sans CJK SC\", fontsize=11];\n"
                                 "  edge [fontname=\"Noto Sans CJK SC\", fontsize=10];\n"
                                 + textwrap.dedent(body) + "\n}\n")
    for fmt in ("svg", "png"):
        subprocess.run(["dot", f"-T{fmt}", src, "-o",
                        os.path.join(HERE, f"{name}.{fmt}")], check=True,
                       stdout=subprocess.DEVNULL)
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
package "L1 领域层" {
  component "fold" as fold
  component "criteria" as criteria
  component "gate" as gate
  component "admission" as admission
  component "dispatch" as dispatch
  component "review" as review
  component "execution" as exec
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
wf --> dispatch
wf --> release

fold --> core
criteria --> core
gate --> criteria
admission --> gate
admission --> VCS
dispatch --> VCS
review --> core
exec --> core
release --> gate
release --> VCS
sign --> core

fold --> ST
criteria --> ST
gate --> ST
admission --> ST
dispatch --> ST
review --> ST
exec --> ST
release --> ST
sign --> SG
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
if (输入重复?) then (是)
  :拒绝 duplicate_fixture;
  stop
else (否)
endif
:写 criterion + fixtures;
:发 criterion.registered;
stop
""")

plantuml("p4-admission", """
start
:admission.evaluate(task);
if (lease 有效?) then (否)
  :拒绝 no_lease;
  stop
else (是)
endif
if (workcopy 基于基线?) then (否)
  :拒绝 stale_workcopy;
  stop
else (是)
endif
if (diff ⊆ scope?) then (否)
  :拒绝 + boundary.violation;
  stop
else (是)
endif
if (判据全绿?) then (否)
  :拒绝 criteria_red;
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
:release.freeze;
:确定 in/out 集合;
:缺口 = 差集;
:checkout 目标 snapshot;
:build + pack;
:记 package_sha256 + snapshot_id;
if (与证据对得上?) then (否)
  :拒绝 artifact_mismatch;
  stop
else (是)
endif
:生成审计快照 JSONL;
:签字;
stop
""")


plantuml("uml-state-release", """
hide empty description
[*] --> draft
draft --> frozen : freeze(缺口=差集) + 签字
frozen --> delivered : 产物发布
delivered --> rolled_back : decision(kind=rollback)
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

# ============ 过程逻辑：N-S / PAD / 判定树（Graphviz） ============

graphviz("p2-gate-ns", """
  node [shape=box, style=filled, fillcolor="#f5f7fa"];
  n0 [label="取 baseline 与当前 frontier"];
  n1 [shape=diamond, fillcolor=white, label="frontier 不一致?"];
  s1 [fillcolor="#fde2e1", label="verdict = stale_fail"];
  n2 [label="逐条判据：不适用当前 stage ⇒ na；否则 run(c)"];
  n3 [shape=diamond, fillcolor=white, label="policy = all_of?"];
  v1 [label="verdict = 全部 ∈ {pass, na} ? pass : fail"];
  v2 [fillcolor="#fff4d6", label="verdict = 存在 pass ? pass : fail"];
  n4 [label="写 gate.judged（含每条读数与 data）"];
  n0 -> n1;
  n1 -> s1 [label="是"]; n1 -> n2 [label="否"];
  n2 -> n3;
  n3 -> v1 [label="是"]; n3 -> v2 [label="否"];
  v1 -> n4; v2 -> n4;
""")

graphviz("p3-two-phase-pad", """
  rankdir=TB;
  root [shape=box, label="confirm(request)"];
  s1 [shape=box, label="1 读 preview"];
  s1a [shape=box, style=filled, fillcolor="#fde2e1", label="不存在 ⇒ stale_preview"];
  s1b [shape=box, style=filled, fillcolor="#fde2e1", label="过期 ⇒ expired_preview"];
  s2 [shape=box, label="2 校验 payload_hash"];
  s2a [shape=box, style=filled, fillcolor="#fde2e1", label="不一致 ⇒ payload_changed"];
  s3 [shape=box, label="3 校验 frontier"];
  s3a [shape=box, style=filled, fillcolor="#fde2e1", label="已移动 ⇒ frontier_moved"];
  s4 [shape=box, label="4 领域校验 invariants"];
  s4a [shape=box, style=filled, fillcolor="#fde2e1", label="失败 ⇒ invariant_violated"];
  s5 [shape=box, style=filled, fillcolor="#e3f5e1", label="5 事务：追加事件 + 更新投影 + 标记 preview 已消费"];
  s6 [shape=box, style=filled, fillcolor="#e3f5e1", label="6 返回 {id, frontier}"];
  root -> s1; s1 -> s1a; s1 -> s1b; s1 -> s2;
  s2 -> s2a; s2 -> s3;
  s3 -> s3a; s3 -> s4;
  s4 -> s4a; s4 -> s5; s5 -> s6;
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
  + strength : Strength
  + baseline : BaselineHash
  + approve(by)
  + reaffirm(baseline)
}
class GoalNode {
  + id : NodeId
  + parent : NodeId
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
  + register()
}
class Fixture {
  + polarity : Polarity
  + input : string
  + expected : Verdict
}
class Gate {
  + id : GateId
  + policy : Policy
  + judge(readings) : Verdict
}
class StageRun {
  + id : StageRunId
  + baseline : BaselineHash
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
  + verdict : Verdict
  + open()
  + close()
}
class Agent {
  + id : AgentId
  + state : State
  + watermark : number
}
class Release {
  + id : ReleaseId
  + inSet : Set
  + outSet : Set
  + freeze()
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

Intent "1" --> "1" GoalNode : 根
GoalNode --> GoalNode : 分解
GoalNode --> Criterion : 叶验收
Task "1" --> "1" WorkUnit
WorkUnit --> Criterion
Criterion "1" --> "1..*" Fixture
Gate --> Criterion
StageRun --> Gate
Release --> Snapshot : 交付绑快照
Task --> Agent : 认领者
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
parked --> dead : 7 天未唤醒
busy --> dead : unwakeable
idle --> dead : unwakeable
dead --> [*]
""")

plantuml("uml-state-stagerun", """
hide empty description
[*] --> entered
entered --> judged : gate.judged
judged --> exited : stage.exited(verdict)
entered --> exited : na（该 policy 下无此阶段）
exited --> [*]
""")

plantuml("uml-state-review", """
hide empty description
[*] --> open
open --> verified : 全部 finding 已核实
verified --> closed : close(verdict)
open --> changes_requested : 未核实 / 判据红
changes_requested --> open : 作者修完
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
B --> R : 产物
note right of R : 缺口计算/校验/打包细节见 03 · P8（唯一处）
R -> Sig : sign(交付证据)
Sig -> E : decision.valid
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

print("done")
