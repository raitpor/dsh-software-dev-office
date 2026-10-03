# 上游问题：派发子代理的 `toolFilter` 只收窄了"公告面"，"调用面"没挡住（未公告工具的调用仍被路由进工具层）

- **日期**：2026-10-03
- **性质**：**宿主侧（dsh-subagent / 进程内派发）问题**，不是 SDO 插件缺陷；SDO 已改为「如实回执 + 钩子兜底」
- **发现途径**：sdo-test 真机回归测试（`docs/testdoc/2026-10-03-插件流程回归测试报告（立项到开发完成）.md` §8.4②）+ 本工作区复核宿主源码

## 1. 现象（真机证据）

SDO 用宿主 `subagents.start('spawn', { …, toolFilter: { allow: [9 个工具] } })` 真的派发出一个子代理
（台账 `dispatch/started`：`{"task":"TASK-033","provider":"spawn","childSessionId":"1cdc6946-…","tools":9}`）。

枚举该子会话的 `tool/call` 事件：

```text
skill ×1  read ×10  bash ×47  edit ×9  write ×1  sdo_task ×4   ← 都在掩码内
sdo_plan ×1   sdo_review ×1   sdo_gate ×1                      ← **掩码外，但它仍能发起调用**（公告面里没有这三个）
```

该子会话的 `request/header` **只公告了掩码内的 9 个工具**（掩码外 0 个）⇒ **公告面确实被收窄了**；
但上述三次**调用**仍被宿主路由到工具层，全部由 **SDO 的工具钩子（B6 掩码硬拦）** 拒绝；会话内出现 12～27 处「工具面里没有 …」。

## 2. 宿主侧的链路与本工作区的复核结论

- **能力声明是对的**：`subagent-spawn-in-process`（Provider 名默认 `spawn`）声明
  `capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`
  （`…/dsh-subagent-spawn-in-process/lib/index.js:23-29`）。
  > 注：`…/dsh-subagent/lib/index.js:2518-2530` 的 `toolFilter: false` 是**跨进程后端**的
  > `NO_START_CAPABILITIES`，与 `spawn` 无关；且宿主的处理是**硬拒**（`UNSUPPORTED_CAPABILITY`，:3196），
  > 不存在"静默忽略能力"这回事。
- **链路确实调了 restrict**：
  `…/dsh-subagent-in-process-driver/lib/index.js:173-175` `applyChildComposition(childCtx, parent, { persona, toolFilter })`
  → `…/dsh-subagent/lib/index.js:522` `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter)`。
- **但仍然没生效**。**合理怀疑（未做最小复现）**：`applyChildComposition` 的第一句是
  `childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)` —— 子代理**继承父方 preset**（本例 `sdo-office`），
  **该 preset 在其后注册进来的工具**可能不受先前 `restrict()` 的约束（顺序/作用域问题）。
  建议上游确认：`restrict()` 与"子代理自带/继承 preset 的装配顺序"之间的语义边界。

## 3. SDO 侧的处置（不替宿主打包票）

1. **回执只陈述能证明的两件事**：① 已把 `toolFilter` 下发给宿主（附 provider 与它**声明**的能力值）；
   ② **子代理工具面是否真的收窄，本插件无法自证**（文案里带上本页的真机反例）。
   —— 先前两版文案（「P-3 随之关闭」/「provider 声明 false，宿主静默忽略」）都是错的，已更正。
2. **钩子兜底**：B5 归属 + B6 掩码硬拦是当前**真正起作用**的那一层（真机已被行使、可点名角色/工具/可用面/卡片路径）。
3. **本页留档**：把宿主侧发现写下来，便于上游定位；SDO 不把"未生效"说成"已隐藏"。
