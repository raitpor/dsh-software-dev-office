# src/review —— M2-4 晚到条款链（准入）

| 文件 | 职责 |
| --- | --- |
| `clause.ts` | C4 准入拦截：按条款**当前版本**检查 pre-work 读数（修订/读数时刻**比较与排序**都按 `Date.parse` 真实时刻，带 `±hh:mm` 偏移不按字符串序），晚到 ⇒ `clause_unjudged`（details 区分 `no_reading` / `reading_before_revision`）。只查 `alignment.examples_present` / `redteam.disposed` / `stage.requirement_complete` / `design.covers_spec` 四个 pre-work 判据。**`na` 也是读数**：它是“被判定过、结论不适用”（M2 门禁对 non-core 统一判 `na`），不是“没判”；`no_reading` 只指 `stage_run.criteria` 里根本没有该条款的 pre-work 条目。C6 用同一判定给出“引用该条款且读数已陈旧”的卡（不新造第二套 stale 规则）；**排除 `kind='review'` 的评审卡**（卡面“恰好 3 张”口径）。 |
| `readings.ts` | C5 `spec_set` 载荷渲染：`clause_readings[]`（docs/06 §5 六字段）与 `readings_hash` 工具算，`content_hash` 覆盖 `readings_hash`；调用方不得自带这三个字段；`spec_ids` 必须恰好是当前全部 requirement；`verifySpecSetPayload` 复算两处哈希（手改一项 ⇒ 失败）。 |

读数来源统一为 `gate.judged` 折叠进 `stage_run.criteria` 的判据三态（读数时刻 = `stage_run.judged_at`），不读物化表。

## 测试夹具边界（D-084）

C4/C5 的 `stage_run.criteria` 读数夹具是**手写 fold 状态**（`test/review/state-helpers.ts`）：手写 fold 状态**只出现在测试夹具里，产品路径只有 `judgeStage()`**（裸 `gate.judged` 被写网关 fail-closed，M2-2 D-080 无测试缝）。读数的真写路径证据由 M2-2 用例承担：`test/db/gate-judged.test.ts` 的「C1: 门禁流程写 stage_run 判定字段，verify 绿」「C5: 重判写新事件、不覆盖旧事件；行更新且 verify 绿」。
