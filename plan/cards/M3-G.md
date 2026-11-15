---
id: M3-G
seq: 35
milestone: M3
owner: impl-core
write_scope: [scripts/, test/readings/, package.json, plan/milestone/, plan/cards/M3-G.md]
status: open
created_at: 2026-11-15
---

# M3-G · M3 里程碑读数门（§16.4 三条判死 + M2 遗留）

## 意图

不写功能，只把 `docs/09` §16.4 三条判死读数与 M2 遗留项做成**可复跑证据**（`npm run readings:m3`），报告交人签。M2 遗留：R5 人类样本（M3 影子期采集）、`gate` 表命名（M2-2 已落 `stage_run`，若 M3 建表须复跑 R7）。

## 对齐

**复述**：读数必须是测量不是断言：每条给命令、原始输出与数据来源（哪条事件/哪次真实调用），并配变异红证（改注入点 ⇒ 该条变红）。样本不够就报 partial，不许凑数。三条判死读数：①两人并发改同一字段 ⇒ 一成一败（409），`conflicts` 可见双方主张；②版本冻结独立性不成立 ⇒ 门禁红；③撤销权限后待审项消失且显示申请入口。

**人确认**：pending

**正例 2**
1. R1 并发写：两独立进程同时改同一字段 ⇒ `{ok:1, conflict:1}`，`conflicts` 1 行且双方主张可见。
2. R3 撤权：撤销 `decide@release` 后待审项 1→0 且 `apply_entry` 可见（页面渲染断言）。

**反例 1**
- 任一条只写“已验证”而无原始输出 ⇒ 该条不算取证。

## 判据

| # | 判据 | 怎么验 |
|---|---|---|
| C1 | 三条判死读数各一条，带 `{id,question,command,raw,verdict,caveat}` | 生成物结构断言 |
| C2 | 每条能指出数据来源（事件 id / 调用路径） | 脚本字段 + 人工可核 |
| C3 | 变异红证：至少 R1/R2/R3 各一条（改注入点 ⇒ 该条变红） | 变异记录进卡 |
| C4 | 两遍除时钟字段外逐键一致 | 脚本断言 |
| C5 | 不写生产库、不写仓库：树快照前后一致（含 `~/.local/state/sdo`） | 断言 |
| C6 | M2 遗留：R5 人类样本若 M3 内采集 ⇒ 重出读数，否则仍 partial 并写明 | 卡记录 |
| C7 | 树冻结后单次取证，时点写进卡 | 卡 E 行 |
| C8 | 冻结区零改动 | `git diff f37f4dc -- docs design probe` 为空 |

## 假设

| # | 假设 | 状态 | 依据 |
|---|---|---|---|
| A1 | 三条判死读数口径以 `docs/09` §16.4 为准，不自定义 | confirmed | 文档原文 |
| A2 | R1 用两个独立进程（真并发），不用同进程模拟 | confirmed | 与 M2-G 的“真进程”口径一致 |
| A3 | R5 人类样本只能在影子期采集，M3 内不造假 | confirmed | D-082 |
| A4 | 复用 M1-G/M2-G 的 `verdict/caveat` 结构与脚本骨架 | confirmed | `scripts/readings/` |

## 预览

新增 `scripts/m3-readings.mjs`、`scripts/readings/m3/*.mjs`、`test/readings/m3.test.ts`、`package.json` 的 `readings:m3`、`plan/milestone/M3-读数.{json,md}`；不改 `src/`。

## 准入

- [ ] 前置卡 M3-0…M3-6 全部收卡（至少 R1/R3 的实现在）
- [ ] 写域在团队分工之内
- [ ] 已读冻结区：`docs/09` §16.4、§14 验收读数、S10/S19 的遗留条

## 证据

| # | 时点 | 命令 / 动作 | 读数 |
|---|---|---|---|
| E1 | — | `npm run readings:m3` | 待填 |
| E2 | — | `make all` | 待填 |
| E3 | — | `git diff f37f4dc -- docs design probe` | 待填（应为 0 行） |

## 判定

**手工判定（M2 之前不绑 baseline）**：待填

## 评审

| 轮 | 判决 | 要点 |
|---|---|---|
| 第 1 轮 | — | 待评审 |

## 收口

- [ ] 判据全绿（裁判权在 reviewer）
- [ ] 证据行填实测读数
- [ ] 偏差进 `plan/03-偏差台账.md`
- [ ] 复述经签署者确认（`plan/sign/`）

## 待确认

- [x] **已定（2026-11-15）**：三条判死读数不依赖 M3-6，但 R1 依赖 M3-2、R3 依赖 M3-5，故读数门仍排在最后取证。
