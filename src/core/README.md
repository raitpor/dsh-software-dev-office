# src/core/ · 事件与 fold

职责：事件模型、fold（事件 → 投影的纯函数）、verify、库路径策略、P15 静态校验、门禁判定。

- 写域：`core` 泳道（impl-core）。其他泳道只读调用，不改这里的文件。
- 填充卡：M0-2（`fold`）、M0-6（`paths`/`verify`，沙箱与可发现性）；M1 接 P15；M2 接门禁判定。
- 纪律：投影函数优先纯函数；重放两次必须逐字节相同（M0-2 判据）。

## fold（M0-2 交付）

入口：`src/core/fold/index.ts`

```ts
fold(prev: FoldState | undefined, events: readonly Event[]): FoldState
```

- 纯函数：不读时钟 / `fs` / `process.env` / 随机；同一事件序列 + 同一 `prev` ⇒ 同一输出（`test/core/fold.purity.test.ts` 静态扫源码 + 运行时校验）。
- 确定性：行对象按固定字段顺序构造；序列化用键序稳定的写法比较，不靠对象键序碰巧（`fold.determinism.test.ts`）；跨进程用原始 `JSON.stringify` 对照（`fold.crossprocess.test.ts`）。
- 幂等：事件幂等键是**事件 id**；inputs 失效的幂等键是 `(spec_id, input_id, 旧 hash)`（`fold.idempotency.test.ts`、`fold.invalidation.test.ts`）。
- fail-closed：未知 `kind`、坏信封、缺字段、坏 payload、缺前置行一律抛 `FoldError`，消息带事件 `id` 与 `kind`（`fold.failclosed.test.ts`）。
- 授权与状态守卫：`decision` 是两事件状态机（`decision.valid` 建行、`decision.signed` 补签名，只增不改）；**授权只认已签名 decision**（消费处 `requireSignedDecision`，只 valid 不 signed 一律拒，valid 事件本身仍留在 fold 里）；`release.superseded` 必须凭有效 `decision(kind='rollback')` 且产物 `artifact_sha256` 与交付态匹配；`task.dropped` 只许 ready→dropped（`never_done`）或 done→dropped（`delivered_deferred` + `credential`）；baseline 链只沿当前 head 前进；goal 行与 plan 载荷树逐字段对账（叶节点验收判据留 M1，D-017）。
- 规则表：`src/core/fold/RULES.md` 逐 kind 列出目标表与约束（56 个受投影 + 35 个 ack = 91 个 kind；`intent.proposed` 是 ack，intent 行只由 `intent.signed` 写）；没物化的事件在 `ack.ts` 显式列出理由。
- 输入失效：`assumption.recorded` 落 `inputs[]` 边；每个事件后 `propagate.ts` 比较边目标行的 `rowHash`，变化即回 `open` 并记幂等键（不按事件类型枚举）。
- 输出是浅只读：`freezeState` 只做只读视图，不深冻结行对象；调用方不要改写。
- 输出形状：`tables` 按 34 张物化表分组（`id → row`），行字段跟 `docs/03`/支撑表一致；聚合命名（design/02 的 `Task`/`Spec` 等）留给 M0-3 的视图层翻译（卡 P6 仍待确认）。

## paths / verify（M0-6 交付）

- `src/core/paths.ts`：`resolveDbPath()` 默认给 `~/.local/state/sdo/<project>.db`（工作区外）；`SDO_DB` 是唯一覆盖，落进工作区只 warning 不阻止；`ensureDbDirectory()` 递归建 0700 目录，建不出/不可写一律抛 `SdoPathError` 并带 `fail-closed: no workspace fallback`——绝不回退工作区。
- `src/core/verify.ts`：`verify(db)` 按 `event` 行序（`rowid`）重算链，逐条验 `hash = sha256(规范化(事件去 hash) + prev)` 与 `prev` 连续，再 `fold` 重算并与库内 `task`/`spec`/`release` 行逐列对账；差异报 `runtime_inconsistent`/`projection_missing`/`projection_unexpected` 等并带对象 id。只发现、不归因；M0 的对账清单是显式常量 `VERIFIED_TABLES = ['task','spec','release']`（`src/core/verify.ts`）——这三张是 M0 视图/查询的主要读数面、字段最密、最容易被直改；其余投影在 M2 接 `verify_run` 时按 `view_catalog` 通用对账补齐，本卡不扩表。
- `verify` 只收最小接口 `{ prepare(sql).all() }`，不 import `src/db/`（core→db 反向依赖禁止）。
- hash 口径（写死，M1 不得另解）：`body = canonicalJson({id,at,actor,kind,subject,payload,caused_by,request_id,prev})`——对象键递归排序、数组保序，**body 已含 `prev`**；`hash = 'sha256:' + sha256(body + prev)`。golden vector 在 `test/core/verify.test.ts` 写死期望值：`e-golden-1` ⇒ `sha256:2a6359fd2f31b388cc1a301cf6baefba777d2c6904085e856c09478327cc78e1`。
- 对账方向是单向的：只比对 fold 行里**有值的列**；DB 有而 fold 没有的列、以及 fold 多出的列（如 `task.reserved_by`/`reserved_until`，001 DDL 无落点，见 `plan/03` D-021）不报——M0 的目标是“发现被改过的已知读数”，不是 schema 双向校验。

- 判据框架（M1-1）：`src/core/criteria/` 三件纯函数件——`catalog.ts` 是 `docs/04` §4/§4.1 的 24 条目录快照（`guarantee`/`applies_to` 是 code 的目录属性，不落 `criterion` 表列，D-026；`applies_to=[]` 的表约束型判据永远生效、不绑 gate）；`register.ts` 是注册门槛（remedy、目录 code 与 guarantee、≥1 正例 + ≥1 负例、逐夹具中位数取 max 后 <200ms，全拒且自身零写入）；`binding.ts` 按五条件算有效绑定，缺一给具体原因码，某 stage 有交集却无合格 gate 时报 `stage_gap`；core 三条额外有结构性前置 `policyHasRequirementKind`（policy 缺 `requirement` kind ⇒ 三条 `missing_required_kind`，M1-3 P15 复用）；畸形 policy 返回 `invalid_policy` 而不是抛异常。`criterion.registered` 事件新建判据时 `fixtures[]` 必填（≥1 正 + ≥1 负，reducer 同事务写 `criterion` + `criterion_fixture`，D-032 裁定 ①），写网关物化集因此是 8 张表；`legacy: true` 是唯一例外，只给 M1-6 的 v1 导入用，且 `verify()` 以 `legacy_criterion_registrations` 计数暴露，M1-G 读数不使用 legacy 注册取证。

## 目录

- `fold/types.ts`：事件信封、`FoldState`、34 张表名、`inputs` 边与 `invalidatedKeys`。
- `fold/state.ts`：空状态 / 克隆 / 收拢（只读视图，非深冻结）。
- `fold/guards.ts`：`FoldError`、payload 收窄、行读写。
- `fold/decisions.ts`：有效 decision 判定（存在/valid/kind）。
- `fold/canonical.ts`：键序稳定序列化与 `rowHash`。
- `fold/propagate.ts`：inputs 边 hash 变化 ⇒ 假设失效。
- `fold/reducers/*.ts`：按域分文件（intent/spec/assumption/goal/task/flow/verify/review/decision/release/baseline/release-items/workunit/ops/content）；`decision.ts` 是只增不改的两事件状态机。
- `fold/registry.ts`：kind → reducer 查重合并。
- `fold/ack.ts`：已知但不改变 34 张表的事件及理由。
- `criteria/catalog.ts`：`docs/04` §4/§4.1 的 24 条目录快照（code→guarantee/applies_to）+ 纯查询 API。
- `criteria/register.ts`：注册五门槛（实跑夹具 + 中位预算），只在内存判定、不写库。
- `criteria/binding.ts`：有效绑定五条件 + `stage_gap` + core 计数；M1-3/M1-4 的唯一消费入口。
- `paths.ts`：库路径解析与目录守卫（M0-6）。
- `verify.ts` / `verify-events.ts` / `verify-projection.ts` / `verify-types.ts`：链路复算与投影对账（M0-6）。
