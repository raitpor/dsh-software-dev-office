-- 014_view_column_flags.sql · M3-6 列级裁剪（收口 D-016）
--
-- `view_catalog.columns` 的每个列对象补 `human_only`（默认 false）。查询层对 agent 会话
-- 隐藏 human_only 列（列不出现，不是置 null）；human/service 会话照旧。
--
-- 当前唯一 true：team.rights（label「已签决策类型」= 该 actor 签过哪些 decision_kind，
-- 对应 docs/05 §6 的"别人的签章状态"）。docs/05 没有逐列清单 ⇒ 这是最小口径，
-- 代码侧清单在 src/views/catalog.ts 的 HUMAN_ONLY_COLUMNS，两处由测试对账；
-- 真源缺失与 team.kind 的同一泄露面都记在 plan/03-偏差台账.md（D-103）。
--
-- 幂等：重复执行只是把每列的 human_only 重写为同一值。

UPDATE view_catalog
SET columns = (
  SELECT json_group_array(
    json_set(
      je.value,
      '$.human_only',
      json(
        CASE
          WHEN view_catalog.name = 'team' AND json_extract(je.value, '$.name') = 'rights' THEN 'true'
          ELSE 'false'
        END
      )
    )
  )
  FROM json_each(view_catalog.columns) AS je
);

PRAGMA user_version = 14;
