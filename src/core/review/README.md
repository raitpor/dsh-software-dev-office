# src/core/review —— M2-4 评审抽样与评审要求（纯函数）

只算、只读 fold 记忆态：不写事件、不读 sqlite 物化表、不写判定行。

| 文件 | 职责 |
| --- | --- |
| `sample.ts` | C1/C7 抽样规则：`isSampled(seq, kind, review)`（**入样白名单 `implement`/`design`/`docs`**；`review`/未知 kind/大小写变体一律 false，D-085）（`(seq - sample_seed) mod sample_every === 0`，review 卡恒 false，数学取模）；`reviewPolicyOf` 只读 `policy.review`，非法返回 `undefined`（越界由 P15 的 `review_params_invalid` 负责，本模块不重写）。 |
| `refs.ts` | 卡 → 条款引用的唯一口径（`subject_kind='spec'` / `inputs[]` 的 `spec:`/`requirement:`/`design:`/`contract:`/`criterion:` 反查）。 |
| `required.ts` | C3/C7 `review.required` 三态：触发条件（risk_flags / design|contract / release 相关 / 被抽样）、pass 需 `review_round.verdict='pass'` 且 `signer ≠ subject_producer` 且 round 绑非空 `baseline_hash`/`frontier`；**不与当前 baseline 重比**（不读 baseline 表）。 |

门禁侧在 `src/core/gate` 求值 `review.required` 时调用 `evaluateReviewRequired`，把三态写进 `gate.judged`。
