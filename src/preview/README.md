# preview · `rework_units`（M1-5）

一次变更（事件批）在**落库前**回答两件事，且同一次调用一起返回（`docs/11` §7.5）：

- `willChange`：哪些对象会变（逐表行差 + 被作废的 `work_unit` 路径）；
- `reworkUnits`：因本次变更**作废的已完成 `work_unit` 数**（整数 ≥ 0），并附逐行证据
  `{task_id, criterion_id, spec_id}`（不落库）。

## 数据来源与口径

- 事件语义**全部来自 `src/core/fold`**：`previewChange(db, events)` 用
  `readEvents(db)` 读当前事件链、`fold` 出变更前状态，再把事件批“假如追加”重放，得到
  变更后状态。本模块没有 `switch (event.kind)`，也不 import 任何 reducer。
- `work_unit` 在 fold 里只增不删（`src/core/fold/reducers/workunit.ts` 只有 upsert），
  所以“作废”不是集合里找删除，而是**有效集合差**——**变更前存在的单位，变更后其行本身
  或其引用的 `task` / `criterion` / `evidence` / `spec` 任一行内容 hash 变了**即为作废
  （`docs/11` §2“内容变（hash 变）⇒ 失效但不删除”）。字面“集合差”在现有 fold 下恒为
  空集（`work_unit` 没有失效/删除载体，台账 D-037 由 Lead 记），M1 用有效集合差近似。
- 一条单位只计 1（同一单位因 task 与 spec 同时变不会重复计数），证据里的
  `changed_refs[]` 列出触发的行（`work_unit:<id>` / `task:<id>` / …）。
- **“hash 变”的口径**：用 `src/core/fold/canonical.ts` 的 `rowHash(row)` =
  `sha256Hex(canonicalJson(row))`（64 位十六进制、无前缀；与 `computeEventHash` 共用
  canonical JSON 家族）。这是**实现约定**，不是设计条款：`docs/11` 只说“节点 hash 变”，
  没有规定行粒度摘要算法；选行规范化 JSON 摘要是因为 fold 不保存 per-row 版本号，且
  它对键序稳定、与 fold 的规范化序列化同源。
- `work_unit` 未物化（M1-0 只物化 7 张表），**不读 `work_unit` 表**；口径一旦改成
  物化表，数字必须不变（C7）。
- `will_change` 的 `changed`/`added`/`removed` 是 fold 内存态前后行差，不是 `docs/11` §3
  的完整复位动作；完整传播属于 M2 的 `change` 链。

## 变更批的接受规则（与 `append()` 同一组规则，P2）

`previewChange` 的 `events` 与 `append(events)` 使用**同一组接受规则**（镜像 `src/db/write.ts`
的跳过/顺序/重复检查，卡 A2“形状相同”指的是这组规则而不是一句承诺）：

1. 已持久化且 `hash` 相同的事件 = **重放**，跳过；同一持久化事件重复出现也按幂等跳过
   （append 同样 `skipped`）；
2. 重放事件必须排在新事件之前（否则拒）；
3. 已持久化但 `hash` 不同 ⇒ 拒（与 `append` 的 `event_hash_mismatch` 同口径）；
4. **新事件（fresh id）在批内重复** ⇒ 拒（不等到 `append` 的 INSERT UNIQUE）；
5. 新事件必须接在当前链头（`prev` 匹配），且 `hash === computeEventHash(event)`。

**信封校验对所有事件（含重放）都做**：复用 `src/db/write-envelope.ts` 的 `checkEnvelope`，
与 append 的 `invalid_field` / `unknown_event_kind` 同口径。`checkEnvelope` 是纯函数（不写库、
不开事务），preview 调它不破坏只读（C5）。唯一例外是 M1-0 的物化范围收窄
（`unsupported_scope`）：M1-7 后 `task.*`/`evidence.*` 已可真写；仍非物化的 `claim.*`/`scenario.*` 等在 fold 里合法、只是不进物化面（D-031；D-038 已 closed），preview 是
fold 层试算，不在这一步拒。

“同形状”指两边**都接受/都拒绝**，不是错误码可对拍——两边码不同是预期的：

| 情况 | `previewChange` | `append()` | 原因 |
|---|---|---|---|
| fresh 批内重复 id | `invalid_args` | `append_conflict` | preview 在 fold 前做结构检查；append 撞 INSERT UNIQUE |
| 重放排在新事件后 | `invalid_args` | `event_chain_broken` | 结构检查 vs 链校验 |
| 同 id 不同 hash | `invalid_args` | `event_hash_mismatch` | 同上 |
| 重放缺字段/非法信封 | `invalid_args` | `invalid_field` | 两边都验信封，码不同 |
| kind 未物化（如 `task.*`） | 接受（fold 层） | `unsupported_scope` | M1-0 收窄，D-031；M1-7 后对齐 |

由此“先 preview、再 `append` 同一批、再 preview 同一批”两边都接受；**重放批幂等：
两边都接受，但 preview 只报告“新增”作废（重放时 fresh 为空 ⇒ 必然 0）**——首投批的
`reworkUnits` 才是它的读数，与 `append` 的 `written:0 / skipped:N` 对应。

## 纯函数边界（C5）

不写库、不发事件、不落 `preview` 行（D-033，M2 的两段式 `confirm` 链）。调用前后
`event` 行数与 hash 链不变；唯一副作用是读。

## 手填不算（C4）

`rework_units` / `reworkUnits` 只能由 fold 状态差算出。第三参（接口位）**出现这两个
键名即拒**（`in` 检查，原型链上的同名键也算；`PreviewError code='invalid_args'`），
不会“调用方给数字就返回”。只拒这两个键名，不把第三参扩大成白名单。

## API

```ts
previewChange(db, events, options?)
// → { willChange: {kind,id,change}[], reworkUnits: number,
//     payloadHash: string, invalidatedWorkUnits: {task_id,criterion_id,spec_id}[] }
```

`payloadHash = sha256(canonicalJson(events))`，用于把预览与随后真正 `append` 的同一批
事件对上（C6）。**空批的 hash 只覆盖事件集合、不绑定库状态**（没有事件可锚）——它只表示
“没有变更”；非空批靠事件的 `prev`/`hash` 锚链。不要把变更前状态塞进 hash：那会破坏
“预览的批 == 落库的批”的对账口径。

## 测试

`node --test lib/test/preview/`（先 `npm run build`）。C3 静态扫描对 `src/preview/*.ts` **整个目录**
禁用 `event.kind`、`switch (`、`case '…'`（启发式回归守卫，不是源码级证明）。注意它不会区分
“事件语义”和普通分支：如需 `switch (change.kind)` 这类合法写法，请改用类型守卫函数或 `if` 链，
免得被误红。

对账（M1-7 全表物化后，非零样本也走真 `append`；D-038 已 closed）：

- **零样本真落库**：预览 `spec.revised` 得 0，`append` 后重放差额也是 0。
- **非零样本真落库**：真 `append` 铺 3 条 `work_unit`（`task.created`/`task.claimed`/
  `evidence.attached`），预览 `spec.revised` = 3；同批事件真 `append` 后从落库事件链重新
  `fold`，`invalidatedWorkUnits` 与预览逐条 `deepEqual`。同一用例内另有“同批事件在变更前
  状态 fold 重放”一段，只用于证明 preview 与 append 的 fold 语义一致，**不是替代路径**。
  覆盖命令：`node --test --test-name-pattern="C6 对账" lib/test/preview/`。
