# dsh-software-dev-office（SDO）

> **一个 agent software dev office**：把「可行性 → 需求 → 架构 → 拆分 → 实现 → 测试 → 交付」做成**门禁驱动、证据可查**的流程，跑在同一个会话里。
> 不涉及发布与运维（非目标）；只在 **dsh `0.2.0`** 上开发。

## 1. 入口：装配级，显式选择才接管（C-07 / D-01）

SDO **不是**默认加载的插件。它随包提供**一个 preset**，只有显式选择它的会话才被接管；未选择的会话完全不加载，也**无法中途接管**已开始的会话。

```yaml
# 你自己的 profile 补丁（示例）：按 id 定向补丁，不要重复 insert
- insert:
    - id: sdo-office            # ← 覆盖既有行时用同一个 id（不是再 insert 一次）
      name: 'dsh-software-dev-office'
      config:
        projectDir: .sdo
        gateLevel: enforce      # suggest | enforce | strict
        cost:
          prices: { deepseek-official/deepseek-chat: 2 }   # 每 100 万 token 的价格（不填就只显示 token）
```

- **仅 Web profile 有 preset 消费方**：`dsh-web-app` 提供 `agent-preset-registry`；headless/ACP 没有 preset 消费方，因此 SDO 只在 Web/CLI 会话里可用。
- 本包自带 `presets/sdo-office.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它）。
- **切换 preset 需要新建空白会话**（已有会话不重新装配）。

## 2. 三个入口面

| 面 | 内容 |
|---|---|
| 工具 | `sdo_init` `sdo_project` `sdo_feasibility` `sdo_requirement` `sdo_redteam` `sdo_design` `sdo_adr` `sdo_quality` `sdo_trace` `sdo_gate` `sdo_plan` `sdo_task` `sdo_test` `sdo_review` `sdo_cost` `sdo_risk` `sdo_render` `sdo_deliver` `sdo_status`（19 个，与设计 §9.1 一一对应） |
| 命令 | `/sdo-status` `/sdo-board` `/sdo-list` `/sdo-grill` `/sdo-answer` `/sdo-gate` `/sdo-next` `/sdo-redteam` `/sdo-budget` `/sdo-render` |
| 自动注入 | 每轮状态块（阶段/门禁/需求/风险/议题/成本），只在"与常态不同"时出现；不写绝对路径 |

> 命令面只在**交互式**适配器（Web/CLI）可达；headless/ACP 环境只能用工具（这会消耗模型消息）。

## 3. 流程与门禁

- 流程是**数据**（`src/data/processes/*.yml`）：`waterfall` / `prototype` / `agile` / `spiral`，各有阶段与专属门禁（`GP` 原型验收、`GI` 迭代 DoD、`GR` 风险象限）。
- 门禁链：`G0` 立项 → `G1` 可行性 → `G2` 需求基线 → `G3` 架构 → `G4` 详细设计与计划 → `G5` 开发完成 → `G6` 验证 → `G7` 交付。
- **未实现的检查器一律判失败**（绝不允许"查不到就算过"）；当前所有流程的所有准则都已有实现，并有正向不变量测试守着。
- 推进不了时 `sdo_gate action=check gate=…` 会逐条给出缺口与补救；确有正当理由时 `sdo_gate action=waive` **显式豁免并留痕**。

## 4. 角色（8 张卡 + 硬掩码）

单会话原则（C-09）：全部流程在**同一会话**（驾驶舱）推进；角色**不是会话**，而是**一次派发运行**。

- 提示层：`skills/role-<code>.md`（SKILL.md 风格，含 目标/输入契约/输出契约/DoD/禁止事项/提问模板）
- **硬约束**：`src/data/roles.yml` 的 `allow`/`deny`，派发时作为 `toolFilter` 施加（角色**看不到**越界工具）
- 三个典型禁令：`analyst` 不得自跑红队、`developer` 不可见评审（不得自评）、`tester` 无编辑类工具（不得改被测实现）

## 5. 成本与预算（只监视，不硬停 — C-08）

- dsh 只提供 **token 计量**，没有货币能力：单价表**由你手填**；没填就**只显示 token，不猜金额**；金额一律标注「估算」。
- `budget.total` 可选：不填就只报已消耗（**不显示剩余/百分比、不触发阈值**）；填了则按档位（默认 50/80/100%）**每档只问一次**。
- 超支时三选一：**追加预算 / 继续并记豁免 / 收敛范围** → `budget/decision` 留痕，**开发继续**。

## 6. 已知边界（诚实清单）

| 边界 | 说明 |
|---|---|
| 派发宿主调用未接线 | `sdo_plan action=next` 会**选后端**（subagent/native-team/inline）、生成带 CAS 版本的派发请求并留痕；宿主 `SubagentRuntime.start` 的**真实调用尚未接线**（起一次模型运行需要凭据）。当前请由流程官用 `send_message` 转交，或按 inline 就地执行 |
| 子代理用量未归集 | `sdo_cost` 目前只统计驾驶舱会话；子代理会话的 session 对象未暴露给插件，回执里会**明确说明**而不是编数 |
| 面板未做 | 文本看板（`/sdo-board`，支持 `--expand/--all/--write`，输出幂等）已可用；**Web 面板**（client 插件，`dsh.client = {inject, platform:'web'}`）尚未实现。面板类改动**晚启用需要刷新页面** |
| L3 纪律守卫 | 策略与钩子已就位（fail-open，只在 `gateLevel: strict` 拦）；deny 分支在本环境**未做实测** |
| 发布/运维 | 明确非目标：SDO 到"交付包 + 验收矩阵 + 回滚点"为止 |

## 7. 目录

```
src/domain/      流程、门禁、需求、评分、审讯、DoR、风险、可行性、议题、变更、架构、ADR、质量、契约、追溯、计划、协同、角色、纪律、记录
src/integration/ 派发适配层（三后端 + 降级）、成本与预算
src/interface/   19 个工具、10 个命令、状态注入与回执
src/infra/       YAML 子集编解码、沙箱原子存储、journal（真源 + 派生投影）、id、渲染
src/data/        流程 4 份、审讯题库、评分卡、角色掩码表
skills/          8 张角色卡（SKILL.md 风格）
presets/         sdo-office.patch.yml（唯一入口）
```

真源是 `.sdo/journal.jsonl`（追加式），`.sdo/` 下其余文件都是**派生投影**（可重建：`sdo_status action=…` 会按需重建）。
