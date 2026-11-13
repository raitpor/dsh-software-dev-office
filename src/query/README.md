# src/query/ · sdo_query

职责：把 `view_catalog` 变成**唯一读入口**——`query(db, args)` 只执行目录里的 `sql` 子查询，
按 `min_right` 裁剪并留痕，超预算截断给游标，每次返回带 `as_of`（M0-4）。

- 写域：`surface` 泳道（impl-surface）。不碰 `src/views/`、`migrations/`、fold 与写网关。
- 纪律：成本是契约（docs/02 §7）——超预算必须结构化截断 + 游标，不许静默扫全表。
- 本卡不做：`query_miss` 事件写入（属 M1 写网关，见 `plan/03` D-012）、列级裁剪、
  每轮 1500 字符注入预算的运行时掐断、where/order 下推。

## 文件

| 文件 | 内容 |
|---|---|
| `src/query/execute.ts` | `query()`：参数校验 → 权限 → 只读校验 → 子查询执行 → 预算截断/游标 → 结构化 miss |
| `src/query/budget.ts` | 预算常量的**唯一定义处**：8KB / 500 行 / 1500 字符 / P95 50ms（C8） |
| `src/query/cursor.ts` | 不透明 base64url 游标：`(view,args,as_of,offset,last_row_hash)`；`decodeCursor` fail-closed |
| `src/query/rights.ts` | `min_right` 裁剪：`resolveRight` / `canRead`（复用 `src/views/catalog.ts` 的 `RIGHT_LEVELS`） |
| `src/query/miss.ts` | `QueryMiss` / `MissSink` / `NOOP_MISS_SINK`；事件写入等 M1 网关 |
| `test/query/*.test.ts` | C1–C8 的读数（执行路径、只读、权限、预算、游标、as_of、miss、常量单点） |

## 唯一执行路径（C1）

- 视图按 `catalog.sql` 执行：`SELECT <投影列> FROM (<catalog.sql>) LIMIT ? OFFSET ?`。
  源码里**没有** `FROM ${name}` 插值，也**不解析** `nativeViewName()`：`baseline`/`evidence`
  与 001 的表同名（台账 D-011），拼名字会静默读到错的对象。
- `view:'list'` 是目录的只读投影（`viewsForRight`），不含 `sql` 列；行形状
  `{name, doc, columns:[{name,label,unit?,type}], min_right, row_budget}`——目录原样返回，
  不为了预算削数据形状；目录行超 8KB 时与其他视图一样 `truncated=true` + `next_cursor`，
  按游标续查拼回全部行（当前 13 行整包 8917B，decider 首屏 10 行 / 7225B）。
- 参数只支持 `view / select / limit / cursor / as_of`；`where`/`order` 显式拒绝为
  `invalid_args`（M0 的视图 SQL 自己定序，不让调用方改语义、也不做下推）。

## 权限与留痕（C3）

- `context.right` 默认 `reader`；`min_right` 高于当前权限 ⇒ 不执行、返回
  `miss.reason='filtered_by_permission'`（hint 写明需要的权限），并调 `sink.record(miss)`。
- `MissSink` 默认 no-op；测试注入收集器。真正写 `query_miss` 事件属 M1（D-012）——本卡只把
  miss 交给调用方，不造半条 hash 链。
- **只做视图级裁剪，列级裁剪 M0–M2 不做**（D-016）：`docs/05` §6 要求 agent 视图不含
  `human_only` 列，但（a）`view_catalog.columns` 没有可见性标记载体，（b）查询层不知道 actor 是
  人还是 agent（`rights` 只有 reader/reviewer/decider/signer，actor 身份在 M3）。两项都不是本卡
  能自己定的，留 M3 的 actor 模型落地后补。

## 预算与游标（C4/C5）

- 行预算 `cap = min(row_budget, 500)`；默认 limit=cap，显式 limit 大于 cap ⇒ `invalid_args`。
- 字节预算按**整包**算（docs/05 §4/§7「单次工具返回 ≤8KB」）：`bytes` 是
  `JSON.stringify(QueryResult)` 的 UTF-8 字节数，含 `rows`、`next_cursor`、`as_of`、`view`、
  `truncated` 与 `bytes` 自身。`bytes` 字段与整包互为引用，实现用定点迭代求一致值。
- 裁剪循环把游标长度计入：`truncated=true` 必须带游标。游标存的是**行摘要**
  `last_row_hash = sha256(JSON.stringify(row))` 的前 32 个十六进制字符（定长，不随行宽增长，
  见第 54 轮 P1）——「行 + 游标 + envelope」一起量，从整页往下试，取第一个整包 ≤ 8KB 的保留行数。
- 超预算必先尝试截断给游标；只有当**单行 + 必须携带的游标 + envelope** 仍超 8KB 时，才返回
  `miss.reason='result_too_large'`（不返回半行、不给假游标；预算的硬后果，不是数据缺失）。
  本版边界约 7.9KB/行（游标 154B 时）：8000 字符行在**单行视图**可读（整包 8093B），但同样行 ×N
  在**多行视图**首屏就需要游标（行 8027B + 游标 154B + envelope ≈ 8262B > 8192），因此给
  `result_too_large`。这是本版游标编码的硬边界（D-018 记了设计口径缺口）。
- 游标冻结 `(view, select, limit)`、`as_of`、`offset` 与**最后一行的摘要**：
  - 续查时若当前 frontier 已变（有新事件）⇒ `stale_as_of`；
  - 续查前**只核对边界行**（`offset-1` 处）的摘要是否仍等于 `last_row_hash`：能发现边界行被改写/
    删除造成的 offset 漂移，但发现不了非边界行的增删（那些靠 frontier 变化兜底）；
  - 边界核对会重跑一次视图子查询（`EXPLAIN` 与 page 查询同计划，只取 1 行），M0 数据量可接受；
    大表在 M1 用 keyset/索引优化，不改变这里「只认边界一行」的语义；
  - 多页读取要求 frontier 稳定：M0 没有快照隔离，活库上长篇分页可能随时 `stale_as_of`，
    调用方应从第一页重来（M1 用写网关让表与 frontier 同事务）；
  - 两页拼接与一次性全量逐行相等（`test/query/pagination.test.ts`）。
  - `last_row_hash` 依赖 `JSON.stringify` 的行表示：同驱动/同 Node 大版本内稳定；换驱动或
    BLOB/数值表示变化时摘要不匹配，表现为 `stale_as_of` 后从第一页重查（fail-closed，不会重/漏）。

## as_of（C6）

- `as_of` 是 `EventId[]` 因果闭包（docs/02 §13）：取事件表的头集（没有被任何 `prev` 引用的
  事件）按 id 升序。库为空时为 `[]`。
- **`as_of` 是输入一致性令牌，不是历史快照读**：M0 不支持按旧 `as_of` 读历史；传入且不等于
  当前 frontier ⇒ `stale_as_of`（显式认旧，不悄悄换新）。M1 用写网关/快照保证「读到的表」与
  「返回的 frontier」同事务，历史读再随快照能力开放。
- 同一 `(view,args,as_of)` 两次查询逐字节相同（`bytes` 与行序都稳定）。

## 结构化 miss（C7）

一律返回 `QueryResult.miss`，不抛裸异常：`view_not_found` / `column_not_found` /
`invalid_args` / `filtered_by_permission` / `stale_as_of` / `unsafe_view_sql` /
`result_too_large`。
`query_miss` 的 payload 形状见 docs/05 §5（`{view,reason,hint,task,actor}`）。

## 测试读数

```
node --test lib/test/query/     # M0-4：C1–C8 全绿
```

写清每个判据的读数在 `plan/cards/M0-4.md` 的「证据」段。
