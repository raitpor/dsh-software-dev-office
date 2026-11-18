# waterfall（瀑布）

用途：需求明确、变更昂贵的项目。**做完一段才开下一段**。

## 阶段与出口

| stage | kinds | 出口 gate | 出口判据（勾选表行） |
|---|---|---|---|
| `req` | requirement | `G_req_exit` | 需求完整、意图复述一致、对齐例子齐、清单有范围、风险意图已明示、红队项已处置、core 三条 |
| `design` | design | `G_design_exit` | 设计可追溯、覆盖需求、无需求蔓延、备选方案已声明、节点验收已绑、core 三条 |
| `build` | implement | `G_build_exit` | 任务完成、假设已处置、授权已复验、core 三条 |
| `verify` | review | `G_verify_exit` | 评审轮次绑树、该评审的卡已评审、core 三条 |
| `deliver` | deliver | `G_deliver_exit` | 代码与设计一致、集成清单齐、授权已复验、core 三条 |

## 无插件执行要点

- 每一段结束写一节 `## 出口 G_<stage>_exit`（在卡或读数文件里），逐行勾选 + 证据。
- 上一段没过，**不开下一段的卡**；开了就是违约，记台账。
- 需求变更 ⇒ 回到 `req` 重走，不许在 `build` 里静默改需求（那是需求蔓延）。

## 等价 policy（装回插件时用）

```yaml
policy:
  id: my-waterfall
  preset: waterfall
  stages:
    - { id: req,     kinds: [requirement], after: [] }
    - { id: design,  kinds: [design],      after: [req] }
    - { id: build,   kinds: [implement],   after: [design] }
    - { id: verify,  kinds: [review],      after: [build] }
    - { id: deliver, kinds: [deliver],     after: [verify] }
  gates:
    req: [G_req_exit]; design: [G_design_exit]; build: [G_build_exit]
    verify: [G_verify_exit]; deliver: [G_deliver_exit]
```
