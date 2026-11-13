# S1 · M0 里程碑门签字

- **待签对象**：`docs/09` §16.1 的四条判死读数（M0 的出口门）
- **报告**：[`plan/milestone/M0-读数.md`](../milestone/M0-读数.md)（机器可读版 `M0-读数.json`）
- **取证命令**：`npm run readings`（可复跑；两次运行除 `generatedAt` 外逐字节一致）
- **被签的树**：提交 `ebb28f7`（M0 九卡收口的代码与文档）
  - `plan/milestone/M0-读数.md` 的 sha256：`6652a8632f382ec497af362a4fbab231732d2469889b6e5cb0826474b0d5f576`
- **独立评审**：第 58 轮「改完再审」（2 P1，均指向 R1 测量方式）→ 第 59 轮「收卡」→ 第 60 轮对修完的 P2 判「可签」

## 签的四条读数

| 读数 | 结论 | 实测 |
|---|---|---|
| R1 一次 status 查询里事件表被读几次 | **pass**（结构口径） | `overview`（status 读数面）打开事件表游标 **0 次**、打开事件索引游标 0 次，上界“1 次”成立。口径 = `EXPLAIN` 里 `OpenRead/OpenWrite` 且目标为 `event` 表/索引 rootpage；**不是运行期行访问次数**（边界见台账 D-023）。红证：单表 SQL 表开 1、`UNION ALL` 两份表开 2、覆盖索引 `max(at)` 表开 0/索引开 1、把某视图 SQL 复制成两份后该视图读数 1→2 |
| R2 同一 `as_of` 两次查询逐字节相同 | **pass** | 13 个视图全量：同进程两次 + 两个独立子进程互比 + 对父进程比，整包 `JSON.stringify` 逐字节相等；且结果形状被断言（`view` 名匹配、不是 `miss`），排除“全 miss 也相等”的假绿 |
| R3 读只留探针、写由 `verify` 发现 | **pass** | 3 次 `query()` ⇒ 库同目录 `access.log` 恰 3 行；裸连接改 `task.title` ⇒ `runtime_inconsistent`（`table=task`、`objectId=TASK-1`）；改事件 hash ⇒ `event_hash_mismatch`。**不承诺归因**，报告无任何“谁改的”结论 |
| R4 `gaps` 能看到 `query_miss` 的聚合 | **partial（显式标出，未标绿）** | 写入 3 条合法 `query_miss`（先 `verify` 自证 `ok=true`、`eventCount=9`、`problems=0`）后，`gaps` 按视图聚合成 2 组 3 条。**缺**：`query_miss` 的生产写入路径（M0 只到 `MissSink`，属 M1，台账 D-012） |

## 签署者当场确认的两件事

1. **接受 R4 部分达标**：视图侧聚合已通，写入路径属于 M1 范围（D-012），不在 M0 内补。
2. **接受 R1 的口径收窄**：读数口径是“打开事件表游标的次数（结构）”，不是运行期行访问次数；边界记在台账 D-023，等 M1 有真实采样再补运行期计数。

## 结论

**签。M0 门通过，进入 M1。**

> 纪律（`plan/04`）：绿灯只对提交 `ebb28f7` 这棵树成立。之后任何代码改动都要重新取证并重新签。
