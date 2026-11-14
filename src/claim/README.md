# `src/claim/` — v1 结论回执 → `claim` 表（M1-6）

`claim` 是**结论型读数**（`docs/03` §3）：只能由渲染器从视图导出，不是 fold 投影，
因此它**不经过** `src/db/write.ts` 的 `SUPPORTED_KINDS`/物化集。

## 两条写路径（各自唯一入口）

| 目的 | 唯一入口 | 说明 |
|---|---|---|
| 事件 | `src/db/write.ts` 的 `append()` | M1-0 网关；claim 重建出的 `task.*`/`criterion.registered`/`evidence.attached` 也走这里 |
| `claim` 行 | `src/claim/gateway.ts` 的 `writeClaimRows()` / `importClaims()` | 本目录；`BEGIN IMMEDIATE` 内校验后插入 |

`importClaims(db, claims)` 的顺序：先取 M1-6 的**落库子集**
（`src/importer/rebuild.ts` 的 `landingEvents()`，只有 `task.created` + `task.claimed`）→
用 `rebaseEvents()` 把 `prev` 接到**库内真实链头**（`imp:<claim_no>:root` 不入库）→
`append()` 一次 → `writeClaimRows()` 写结论行。

**原子性口径（P1-1 评审修正）**：能前移的失败全部前移到 `append` 之前
（渲染器注册、字段完整）——“渲染器伪造 ⇒ 0 事件”。`append` 之后仍可能失败，
但**不回滚已提交的事件**：事件是真源，claim 是渲染器投影，用
`renderClaimsFromEvents(db)` **从已有事件重算 claim 行**（不产生新事件、幂等）即可恢复。
反向回滚已提交事件才是危险动作。失败返回照实报 `events_written`（写了 40 就报 40），
并给 `claims_written`、`resumable:true`、`next_step:'render_only'`。

**落库子集 ≠ 离线重建（D-045）**：离线重建仍产出四类事件，用于 M0-7 的 work_unit
对账；`criterion.registered`/`evidence.attached` 的 FK 上游（spec→intent→decision）
在 v1 导出里不存在，补链只能伪造签字（`decision.signature` 非空即被 verify/P9 当作
真实授权），所以 M1 **不落库**这两类，交回 M2 迁移卡。因此
`verify().legacy_criterion_registrations` 在本卡上应为 **0**（不是 20）。

## 渲染器注册（D-034 代理）

`src/claim/renderers.ts` 的 `RENDERERS` 常量 ∩ `view_catalog` 里声明的视图名。
v1 只有 `renderer:gate-result → board`。未注册 ⇒ `renderer_unregistered`。
M2 接真正的 `renderer_catalog` 后只替换 `isRegisteredRenderer` 的实现，契约不变。

## 拒绝码

`renderer_unregistered` / `frontier_empty` / `frontier_unknown` / `claim_conflict` /
`claim_invalid` / `event_rejected`（透传 `append()` 的 `AppendReason`）。

## 库层护栏与边界

- `migrations/005_claim_guards.sql`：`claim` 只追加——UPDATE/DELETE 被触发器拒绝。
- **INSERT 无法在库层区分“网关”与“直插”**（SQLite 触发器看不到连接级标记）。直插
  不会报错，这是 `best-effort` 边界：静态扫描保证生产代码零直插；第三方直插由
  `verifyClaims()` 兜底（见下）。M2 的 renderer 网关接入后重新评估。
- **对账分层**：`sdo verify` 管事件链 + `task`/`spec`/`release`/`decision` 四张 fold
  投影表；`claim` 不进 core verify（避免 core → claim 的分层倒挂），由 `src/claim/verify.ts`
  的 `verifyClaims(db)` 独立兜底：
  · 结构：`derived_by` 必须已注册、`as_of_frontier` 非空且每个事件 id 存在；
  · 内容：从事件重算期望行，逐列比对，报 `missing` / `unexpected` / `mismatch`。
  直插一行（哪怕带不存在的 frontier）会让 `verifyClaims()` 红。
- `claim.as_of_frontier` 入库存 JSON 数组文本（该 claim 重建出的事件 id）；
  空数组 ⇒ `frontier_empty`，任一 id 不存在 ⇒ `frontier_unknown`。
- `value` 只存 `canonicalJson({code, value|params})`，不存长文字（C8）。
- 恢复入口：`renderClaimsFromEvents(db)`；CLI 侧等价 `sdo_import --render-only`（**M1 只提供库函数**，调用入口在 M2/CLI 卡；本卡不接 CLI，别以为现在就能敲命令）。
- **生产调用点**：M1 只交付库函数，`verifyClaims`/`renderClaimsFromEvents` 的全仓调用点目前只有测试与 README；M2 的 `sdo_import` / CLI 接入后才有生产调用。
- **resumable 的两种情形**：`importClaims` 失败时——① `events_written=0`（append 前/append 全失败）⇒ 不可恢复（没有事件可渲染，`resumable:false`）；② `events_written>0` 且 claim 写失败 ⇒ `resumable:true`、`next_step:'render_only'`（事件已提交，用 `renderClaimsFromEvents` 补 claim）。边界：若 claim 写失败原因是 `claim_conflict`（存储行与事件重算结果不一致），render-only 重跑仍会冲突、`resumable:false`、`next_step` 为空——这类需要人工对账，不是重跑能修的。
