# prototype（快速原型）

用途：先用最小代价把东西跑起来，再决定要不要产品化。

## 阶段与出口

| stage | kinds | 出口 gate | 出口判据 |
|---|---|---|---|
| `explore` | implement | `G_explore_exit` | **只判“可观察”**：任务完成 + core 三条 |
| `harden` | requirement, design, implement, review | `G_harden_exit` | **全量**：需求/设计/实现/评审+core 三条 |
| `deliver` | deliver | `G_deliver_exit` | 代码与设计一致、集成清单、授权复验、core 三条 |

## 边界（不是漏洞）

`explore` 的 gate 里没有 `review.required`。所以**高风险卡、实现类设计条款、与发布相关的卡、被抽样命中的卡，都不许停在 explore**，必须在 `harden` 收口。
判法（无插件版）：开卡时在卡面写 `risk_flags`；只要非空，卡的出口节点就是 `harden`。

## 无插件执行要点

- `explore` 允许“丑但能跑”，但**必须留下可复跑的观察证据**（命令 + 输出），否则 `task.complete` 不算 pass。
- 进 `harden` 时，`explore` 的产物当草稿：需求与设计要补到“能追溯到意图”，代码要补测试与边界。
- 决定不做产品化 ⇒ 显式关里程碑（写读数），不许“放着不管”。

## 等价 policy

```yaml
policy:
  id: my-prototype
  preset: prototype
  stages:
    - { id: explore, kinds: [implement], after: [] }
    - { id: harden,  kinds: [requirement, design, implement, review], after: [explore] }
    - { id: deliver, kinds: [deliver], after: [harden] }
  gates:
    explore: [G_explore_exit]; harden: [G_harden_exit]; deliver: [G_deliver_exit]
```
