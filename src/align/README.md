# 对齐（M1-2）：复述 / 例子 / 回指

本模块把 `docs/13-阶段作业单.md:40-52`、`docs/03-链条-意图到声明.md:44-45`、`docs/01:442`
的对齐三件套落成可判定、可复跑的最小实现：

1. **复述**：agent 独立复述（不参考条款），落 `restatement.recorded`；
2. **回指**：人对每条复述差异给 `accept` / `reject`（`defer` 不算处置），落 `restatement.diff_dispositioned`；
3. **例子**：每条 `requirement` 条款要有 2 正 1 反，读 `criterion_fixture`（**provisional**，见下）。

门 `alignmentGate()` 把三者合成一个结构化结果；M1-G 读数与 M2 门禁直接复用这个形状。

> **C5 是 provisional**：`criterion_fixture` 没有事件载体（台账 D-032），生产路径目前写不进去，
> 夹具只能由测试直插。门即使 `ok:true` 也带 `provisional_reasons:['fixture_no_event_carrier']`，
> 意思是“夹具存在时成立”，**不能据此宣称生产可用**；等 M1-1 定下夹具写入路径再摘掉这条说明。

## 文件

| 文件 | 职责 |
| --- | --- |
| `gate.ts` | 公开类型、`readAlignmentState()`、`buildEvent()`、`alignmentGate()`、读取/列表 API、时间解析 |
| `restatement.ts` | `proposeRestatement()`（C1/C2）、`invalidateRestatement()`（C6） |
| `diff.ts` | `disposeDiff()`（C3/C4） |
| `index.ts` | 公开入口 re-export |

所有写动作只经 `src/db/write.ts` 的 `append()`；本目录不拼 SQL、不碰 reducer
（三个 `restatement.*` reducer 在 `src/core/fold/reducers/spec.ts`）。

## 公开 API

```ts
import {
  alignmentGate, proposeRestatement, disposeDiff, invalidateRestatement,
  readAlignmentState, listRestatements, listDiffs,
} from '../src/align/index.js';
```

四种结果都用同一套 reason 码（无裸异常）：

- `alignmentGate(db, { restatementId? })`：
  `{ ok, reason_code?, pending[], specIds[], staleReason?, provisional_reasons[] }`；
  不指定则取 `at` 最新的一条复述；指定了但不存在 ⇒ `restatement_not_found`。
- `proposeRestatement(db, { intentId, draftSpecs, inputs, actor, at?, by?, acceptedSpecIds?, ... })`：
  - C1：`inputs` 必须恰好一条 `{kind:'intent', id:intentId, hash:当前 intent.content_hash}`；
    hash 过期 ⇒ `stale_restatement`，**不写事件**，回执 `staleReason` 带旧/新 hash；
  - C2：`at` 用真实时刻比较（`Date.parse`），必须早于该 intent 下最早一条 `spec.at`，
    否则 `restatement_too_late`；`at` 必须是带时区的 ISO-8601，无时区/不可解析 ⇒ `invalid_args`；
  - `acceptedSpecIds` 必须是 `draftSpecs` 条目或已存在 spec 的 id，否则 `invalid_args`。
- `disposeDiff(db, { restatementId, targetRef, kind, disposition, actor, actorKind, ... })`：
  - `kind ∈ agree/missing/extra/conflict`，`disposition ∈ accept/reject/defer`；
  - C4：`actorKind !== 'human'` ⇒ `not_human`，不写事件；
  - `targetRef` 必须属于该复述的 `draft_specs`，否则 `invalid_args`；
  - 差异行 id 一律由 `restatementId + targetRef` 派生，**不接受调用方自定义 id**；
    同一 `targetRef` 重复处置 ⇒ `diff_already_disposed`。
- `invalidateRestatement(db, { restatementId, reason, actor, ... })`：落 `restatement.invalidated`；
  重复作废返回 `restatement_invalidated`，不写事件。

## 门判定顺序

1. 读状态：事件链坏（哈希/链断）⇒ `stale_reason`（结构化失败，不抛异常）；
2. 选复述：没复述 ⇒ `restatement_missing`；显式指定但不存在 ⇒ `restatement_not_found`；
3. 状态/版本：intent 不存在 ⇒ `intent_not_found`；`invalid_reason` 非空 / `inputs` 不是单条 intent 边 /
   hash 与当前 `intent.content_hash` 不符 ⇒ `restatement_invalidated`（`staleReason` 说明原因）；
4. 时限：`restatement.at >= 最早 spec.at` ⇒ `restatement_too_late`；时间不可解析 ⇒ `invalid_args`；
5. 差异：`target_ref` 不在草案条目里 ⇒ `invalid_args`；同一 `targetRef` 多条处置 ⇒ `diff_conflict`
   （`pending` 列目标、`staleReason` 带条数，不再静默取最早一条）；
   草案条目里有没处置的 ⇒ `diff_unprocessed`；有 `defer` 的 ⇒ `diff_deferred`（视为未处置）；
6. 例子：该 intent 下每条 `spec(kind='requirement')` 需要 ≥2 正例、≥1 反例，
   否则 `examples_missing`（`specIds` 列出条款）；通过也带 `provisional_reasons`；
7. 全过 ⇒ `{ ok: true, pending: [], specIds: [], provisional_reasons: ['fixture_no_event_carrier'] }`。

失败时 `pending` / `specIds` / `staleReason` / `provisional_reasons` 都是给人/给编排看的可读细节，不是异常。

## 读模型（为什么读事件链，不直读表）

`src/db/write-materialize.ts` 的物化清单已含 `restatement` / `restatement_diff`（共 7 张，见台账 D-031），
但本模块**仍以事件链为准**：门要对“指定复述 / 指定状态”做判定，还要能重放与试算，
直读表等于引入第二个事实源，且读到的只是最近一次物化结果。因此：

- 本模块一律用 `readAlignmentState(db)`（读事件链 + `fold`）看复述/差异；
- 需要落库的投影由 `append()` 同事务维护，不要在 align 里再读表做判定。

例子读 `criterion_fixture`（卡 A3）；该表没有事件载体（D-032），测试在事件写完后直接插夹具行。
这是本模块**唯一**直读表的地方（C5 唯一例外）；其余门数据全部来自事件链。

同一 `subject` 的重复 `restatement.diff_dispositioned` 会被 fold 的 `upsert` 静默覆盖（台账 **D-039**，
波及所有 append-only 投影表；`src/core/` 属 impl-core 写域，M1-7 统一收口）。因此门**直接扫事件流**：
按 `(restatement_id, target_ref)` 计数，>1 ⇒ `diff_conflict`，不只信折叠后的行。

## 人身份（M1 的边界）

C4 只认调用方标注 `actorKind: 'human'`。M1 **没有签章链**，这只是“编排里不许 agent 替人点接受”
的标注，不是防伪；真正的签名校验在 M3。README、卡、回报都不能把它写成“已经防住了”。

## 已知边界 / 待确认

- `intent` 没有修订事件：M1 无法用事件复现“intent 变了”。C1 用“提交旧 hash”验，
  C6 用 `restatement.invalidated` 事件 + 门检测验；intent 修订事件属后续里程碑。
- 门在卡面 reason 之外补了 `restatement_missing` / `restatement_not_found` /
  `diff_already_disposed` / `diff_conflict` / `stale_reason` / `invalid_args`，便于编排与 M2 复用。
- `target_ref` 目前只认草案条目 id（M1 门只清草案侧账）；作者侧 spec id 的对应留 M2。
- docs/13 写差异处置是 `accept/reject/block`，而 docs/03 与 fold 的枚举是
  `accept/reject/defer`；本卡按 docs/03 + 卡面（`defer` 算未处置）。
- C5 provisional：夹具无事件写入路径（D-032）；`provisional_reasons` 存在期间，
  对齐门读数只能说明“夹具存在时对齐成立”。**摘除条件**：M1-1 收卡（C10/C11 的 `fixtures[]`
  事件载体）后，C5 必须改走事件写入、删除 `test/align/helpers.ts` 的直插、移除 `provisional_reasons`；
  在此之前，门输出不得被当作生产证据。
- 时间戳校验严格到日历日：`isoTimestampMs` 把解析结果按偏移回读年月日时分秒，
  `2026-02-30T00:00:00Z` 不会被 `Date.parse` 归一化成 3 月 2 日而放行。不可解析的 `at` 排在列表最前，
  永不会被选为 latest。

## 测试

```bash
npm run build
node --test lib/test/align/
```

- `restatement.test.ts`：C1/C2 与时间/`acceptedSpecIds` 校验；
- `diff.test.ts`：C3/C4 与重复处置、targetRef 归属；
- `gate.test.ts`：门各 reason、时区偏移、`diff_conflict`、`stale_reason`、确定性；
- `fixture-carrier.test.ts`：生产代码零 `INSERT INTO criterion_fixture` + 无夹具时门必须红；
- `readonly.test.ts`：C7 静态守卫（`src/align/` 无写 SQL、写只经 `append()`）。

> 静态扫描（`fixture-carrier` / `readonly`）是**回归守卫，不是源码级证明**：正则可被
> `INSERT OR REPLACE INTO`、`main.criterion_fixture`、字符串拼接绕过；唯一事实是代码审查 + `append` 契约。

夹具在 `test/align/helpers.ts`：先铺 `decision.valid → decision.signed → intent.signed`，
再 `proposeRestatement`，然后逐条 `disposeDiff`，最后写条款/判据并插入夹具行
（夹具行没有事件载体，只能直插）。
