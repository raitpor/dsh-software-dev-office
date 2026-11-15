# `src/core/pm/` · M2-5 PM 最小环路

把只读的 `pm_queue` 变成“每一行都有合法动作能推走、且动作留痕”的最小闭环：

```
读 pm_queue（src/query 的 view 投影）→ 建卡（task.created）→ 预占/派发（task.claimed）
→ 请求签字（request_sign）   [escalate / grant 留 M3/M4]
```

- **卡**：`plan/cards/M2-5.md`（C1–C8）。
- **不做什么**：不存队列状态（`pm_queue` 是视图，A3）；不代签；不实现 grant/escalate 真机制；不重写视图排序（D-011：只许执行 `catalog.sql` 子查询）。
- **写入口**：所有写动作只经 `src/db/write.ts` 的 `append()`（唯一写网关）。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | `PmContext`（actor/actorKind 来自进程配置，D-056）、结构化失败码 |
| `rights.ts` | 静态席位权限表（`plan/01` §2 写域 + `docs/07` §5 授权），`scopesCovered`/`scopesOverlap` |
| `state.ts` | 读事件链 + `fold`；按链头/哈希拼事件（不写库） |
| `queue.ts` | 调 `src/query` 读 `pm_queue`；`reason_code → 动作`映射表 |
| `card.ts` | `createCard`（C1 完整性）、`requestRework`（幂等键 `(change_id, subject)`） |
| `act.ts` | `assignCard`（C2 权限前置 + 跨泳道预占拒）、`unblockCard`（C4 白名单）、`requestSignature`（C3 幂等、不代签）、`raiseAttention`；`escalate`/`grant`/`sign` 明确拒绝（C6） |
| `index.ts` | 公共入口 |

## 静态权限表（C2，grant M4 前恒空）

| 席位 | 读视图 right | 写域 glob | PM 权 |
|---|---|---|---|
| `lead`（M2 的 PM） | signer | `*` | plan@*、assign@*、escalate@* |
| `impl-core` | reader | `src/core/**`、`src/db/**`、`migrations/**`、`test/core/**`、`test/db/**` | — |
| `impl-surface` | reader | `src/views|query|ui|align|check|preview|core/pm/**`、对应 `test/**`、`scripts/**`、`package.json` | — |
| `impl-import` | reader | `src/importer/**`、`src/claim/**`、测试夹具 | — |
| `impl-security` | reader | `src/sign/**`、`signerd/**`、`test/sign/**` | — |
| `reviewer` | reviewer | （只读，无写域） | — |

读权限（`readPmQueue`）走 `src/query/` 的 `viewsForRight` 投影；**写动作权限按上表静态矩阵判定**
（`docs/07` §2；读才是投影）。同一 `right` 下静态 `viewRight` 与 `viewsForRight` 的视图集合由
`test/core/pm/pm.test.ts` 的「P2-3」守卫用**独立参照物**（人工从 `docs/05` §3 的 13 视图与 min_right、`docs/07` §2 席位职责抄下的期望表）断言，不与自己同源；改静态矩阵或视图目录必须同时改该期望表。`readPmQueue` 对未知/空 actor
fail-closed ⇒ `no_permission`（不回退 reader）。

派发前：①actor 要有 `assign` 权覆盖卡写域；②assignee 的写域要覆盖卡 `scope_paths`
（`kind='review'/'docs'` 的只读卡豁免覆盖检查，reviewer 可被派评审卡）；③与其他
`in_progress`/`blocked` 卡的写域重叠 ⇒ `scope_mismatch`（事先拒，不是事后冲突）。

## `reason_code → 动作`（C5）

| reason_code | 建议动作 | PM 可执行动作 / 事件 |
|---|---|---|
| `waiting_human` | wait | 无（等人答；escalate 留 M3） |
| `blocked` + `lease_expired`/`lease_revoked` | unblock | `unblockCard` → `task.unblocked`（C4 白名单） |
| `blocked` + `upstream_changed`/`clause_unjudged` | rework | `requestRework` → `task.created(kind=implement)` |
| `blocked` + 其他 block_code | attention | `raiseAttention` → `attention.raised` |
| `gate_red` | rework | `requestRework` → `task.created` |
| `assumption_open` | attention | `raiseAttention` → `attention.raised` |
| `sampled_review` | assign | `createCard(kind=review)` + `assignCard` |
| `rework_pending` | rework | `requestRework`（幂等键 `(change_id, subject)`） |
| `unclaimed` | assign | `assignCard` → `task.claimed` |

`wait` 不写事件（等待不是动作）；其余动作全部落事件，`actor` 是 PM 本人（C7）。

**C5 边界（评审 P1/P2，D-079）**：(a) 只有 **`unclaimed`（dispatch 后离开）** 与 **`blocked` 且
`block_code ∈ {lease_expired, lease_revoked}`（unblock 后离开）** 承诺“动作执行后该行离开队列”，e2e 用例；
`blocked` 的其它 `block_code`（如 `upstream_changed`）走 `rework` 只建新卡、原 blocked 行仍在，归 (b)。
(b) `gate_red`/`sampled_review`/`assumption_open`/`waiting_human` 以及非白名单 blocked 这类由**其它实体状态派生**的行，
本卡只承诺“动作可执行 + 副作用可验证（返工卡/评审卡/attention 真的落下、幂等、留痕）”，行何时消失由被派生
实体的状态决定（如 `gate_red` 要等新的 `gate.judged` 覆盖该 stage）——这是边界，不是本卡能推走的。

## 不代签（C3）

`requestSignature` 只落 `request_sign` 事件（ACK，不投影、不产生 decision 行）。
**幂等键由服务端计算**：`payload_hash = sha256(canonicalJson({decision_kind, payload, proposition, task_id}))`
（覆盖全部请求字段，与 D-055 同口径；同 payload 换 decisionKind/proposition/taskId 不会再幂等复用旧请求），
调用方传 `payloadHash` 只做一致性校验（不符 ⇒ `invalid_field`）；同一 `(计算 hash, signer)`
重复调用返回同一条请求、不追加事件。
并发边界：当前“先读事件再 append”没有 DB 唯一约束兜底；同一进程串行调用安全，
跨进程并发同一 key 的重放属于已知边界（M3 请求表落库后加唯一索引）。
`sign` 动作恒返 `not_a_signer`。真实签字仍走 `src/sign/`（signerd）+ 人。

## 事件 kind 说明（台账 D-066）

`docs/15` 的动作表要求 `request_sign` 事件，但 `docs/02` §11 的登记表与
`migrations/003_event_kinds.sql` 里没有该 kind。M2-5 新增迁移
`migrations/007_event_kind_request_sign.sql` **并**在 `src/core/fold/ack.ts` 登记为 ACK
（写网关的 kind 白名单是静态的，只有迁移行不够）——`ack.ts` 是跨泳道一行，已在
`plan/03-偏差台账.md` D-066 报备。

## 测试

```
node --test lib/test/core/pm/
```

覆盖：C1 建卡完整性、C2 权限/跨泳道、C3 幂等与不代签、C4 白名单 8 码、C5 七个
reason_code 映射 + `unclaimed` 端到端、C6 未实现动作零写、C7 `verify` 与重放。

## M3-5：撤权后的可见性（`docs/09` §16.4 判死读数 ③ 的数据层）

撤权不是删行：事件与历史不动，只让“你能看到的待审项”跟着当前权限走。

- **判权端口**：`src/core/pm/access.ts` 的 `RightsPort{actor, has(right, scope)}` 是唯一判权
  入口。生产路径用 `dbRightsPort(db, actor)`（真库 `scope` 表、未撤销 grant、语义同
  `hasRight` 的 grant 覆盖）；actor 无任何有效 grant ⇒ **显式 deny-all**。
  M3-5 收口后 `PmContext.rights` 缺省也是 deny-all，**不存在静态席位放行回退**；测试必须
  显式注入端口（`rightsPortFrom`/假端口）。`src/` 里由 grep 守卫测试钉死无 `seatRightsPort`（D-101 收口）。
- **再队列过滤**：`readReviewQueueAccess(db, rights, session?)` 把 `review_queue` 行按“所属 task 的域”
  分成 `rows`/`hidden`；给了 session 就透传给 `query()`（query 只判视图级 `min_right`，
  行级域判定唯一在 PM 侧 `read+decide` 双查——两者维度不同，不是重复判权）；`filterPmQueueRows(rows, rights)` 隐藏“owner 是我且我已无
  `read@domain:pm`”的行（全局行 `owner=null` 仍可见）。视图与排序口径不动（D-011）。
- **申请入口**：`ApplyEntry{scope, action:'escalate', reason_code:'no_permission', hint}`；
  M4 换真 `grant` 前先指向 `escalate`。入口本身不判权，提交动作判权（卡 A2）。
- **`escalate`**：`escalate(db, ctx, input)` 必须同时有 `read@scope` 与 `escalate@scope`，
  且 task 的域要覆盖该 scope（否则 `scope_mismatch`）。跨域升级 ⇒ `no_permission`。
- **撤回**：`withdrawAttention(db, ctx, input)` 只能撤自己提的（reducer 兜底）、需要
  `escalate@scope`，且 attention 所属任务的域要覆盖 `input.scope`（否则 `scope_mismatch`）；
  写 `attention.withdrawn`，不删行。
- **历史不变**：`historySnapshot(db)` 同时快照 decision/attention 的 id 与内容哈希，撤权前后逐字段相等
  （测试 C3）；已签 decision 仍有效。
- **review 行可见性**：`read` 与 `decide` **双查**（只判 decide 会泄露 proposition）；显式
  `RightsPort.denied` 表示 deny-all（未知身份），`ReviewQueueAccess.filtered` 汇总“本次是否按权限过滤”，
  UI 只认 `filtered`（空队列 + deny-all 也不出假 `to_decide=0`）。

测试：`lib/test/core/pm/revoke.test.ts`（C1–C5）、`lib/test/ui/apply-entry.test.ts`（页面
`data-apply-entry`、无权限不出数字）。行级可见性用假 `RightsPort` 驱动，M3-1 接线后改真；
夹具的写权限按真实矩阵点状播种（`test/core/pm/helpers.ts` 的 `seedRights`：plan/assign/escalate@domain:core、
write@module:core），不用大礼包。
