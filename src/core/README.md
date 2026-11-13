# src/core/ · 事件与 fold

职责：事件模型、fold（事件 → 投影的纯函数）、verify、P15 静态校验、门禁判定。

- 写域：`core` 泳道（impl-core）。其他泳道只读调用，不改这里的文件。
- 第一张填充卡：M0-2（`fold`）；M1 接 P15；M2 接门禁判定。
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
