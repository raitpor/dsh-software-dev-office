# incremental（增量）

用途：需求/设计先做一次，实现与验证分批走。

## 阶段与出口

| stage | kinds | 出口 gate | 出口判据 |
|---|---|---|---|
| `req_design` | requirement, design | `G_req_design` | 需求完整 + 设计可追溯 + core 三条 |
| `build` | implement | `G_build_exit` | 任务完成、假设处置、授权复验、core 三条 |
| `verify` | review | `G_verify_exit` | 评审轮次绑树、该评审的卡已评审、core 三条 |
| `integrate` | deliver | `G_integrate` | 集成清单、代码与设计一致、授权复验、core 三条 |

## 并行在哪

**不在 policy 里**。多条线的并行是“同一 stage 下多张卡同时开工”，属于派发层：
- 每张卡写 `owner` 与 `write_scope`；写域相交的两张卡**不许同时开工**（无锁环境，靠人守）。
- 阶段性同步点：`req_design` 出口、每次 `integrate`。

## 无插件执行要点

- 每批（lane）结束时写一节 `## integrate <批号>`：集成清单 + 回归命令 + 结论。
- 回归失败 ⇒ 本批不 integrate；修完重跑，不许“先合后修”。

## 等价 policy

```yaml
policy:
  id: my-incremental
  preset: incremental
  stages:
    - { id: req_design, kinds: [requirement, design], after: [] }
    - { id: build,      kinds: [implement],          after: [req_design] }
    - { id: verify,     kinds: [review],             after: [build] }
    - { id: integrate,  kinds: [deliver],            after: [verify] }
  gates:
    req_design: [G_req_design]; build: [G_build_exit]
    verify: [G_verify_exit]; integrate: [G_integrate]
```
