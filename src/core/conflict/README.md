# `src/core/conflict/` — 冲突可见（M3-2）

冲突 = **同一对象的同一字段被两个 actor 基于同一旧版并发写**：一个成功，另一个 409，
失败者的主张进 `conflict` 表，等人裁决。**不是** `disputed`（那是语义分歧，走评审）。

## 纪律

- 纯函数：不读时钟/env/文件、不碰库；检测只收 `currentRow`/`latestActor`/`event`。
- `base_hash` 口径 = `rowHash(写入者看到的投影行)`，与 M1-5 的 `rowHash` 同源。
- 不做自动合并（无 CRDT / LWW / 时间戳选边）；裁决必须是人签 decision。
- 事件载荷约定：参与 CAS 的业务事件带 `field` + `base_hash`；缺任一 ⇒ 不做 CAS。

## 文件

- `types.ts`：冲突行/检测结果/裁决载荷类型与拒绝码、`rowHash` 重导出。
- `detect.ts`：`extractConflictClaim(event)`、`detectConflict({currentRow,latestActor,event})`。
- `resolve.ts`：`verifyResolutionDecision(decisionRow, conflictId, side, actors)`（只认已签名、
  `payload.conflict_resolution = {conflict_id, adopted_actor, note}` 的 decision；
  `adopted_actor` 必须是所选 side 上的人）。
- `verify.ts`：`verifyConflicts(db)` —— 由事件重算冲突行并与库内行对账。

## 边界（D-089）

- `decision_kind` 枚举在 001 冻结为 `sign`，M3-2 不新增 `conflict_resolution` kind；
  裁决复用 `decision(kind='sign')`，签名载荷带
  `extra.conflict_resolution = {conflict_id, adopted_actor, note}`。
  **M3 用通用 `sign`；v2.1 若要独立 kind 再改 `docs/06` 枚举。**
- `verify()` 现在对账 5 张表：`task/spec/release/decision/conflict`。直改 `conflict`
  表会被抓（`runtime_inconsistent/conflict`）；直改 `conflicts` **视图**不会报——
  视图没有自己的状态，且 SQLite 拒绝直接 UPDATE/DELETE 视图（测试已锁死）。
- `conflicts` 暂未注册进 `view_catalog`（`sdo_query` 只执行 catalog 里的 SQL）；
  这是 **M3-4 控制台卡的收口项**（届时要同步 13→14 视图断言）。
- `conflict.detected`/`conflict.resolved` 是链上事件，行由 fold reducer 投影；
  `conflicts` 视图 join `decision` 展示签字人/签名，便于审计。
