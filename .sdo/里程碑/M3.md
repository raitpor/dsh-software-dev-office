# 追加里程碑：M3 · 补卡与评审（2026-11-19）

状态：**已签**（S10：2026-11-19T17:02+08:00，复述准确）｜ 本段为追加，不改 M1/M2 冻结段。起因：最近两轮（`agent-driven` preset、`gate.mjs`）先写了东西、后补卡，且 S9 在评审之前就签了——按本流程属程序倒置，记台账 D-36/D-37，用本里程碑补齐“卡 → 两轮评审 → 复认 → 读数 → 门签”。

## M3.1 里程碑与判死读数

| 读数 | 问题 | 怎么量 | 达标线 |
|---|---|---|---|
| R11 | 第四份 preset `agent-driven` 的判据/阶段/门能否被判死、与发布快照一致？ | ①`node skills/sdo-flow/scripts/check.mjs --presets; echo $?`；②在 `/tmp/m3p` 复制 `skills/sdo-flow` 后把 `G_agent_verify_exit` 的 `agent.mutation_red` 改名为 `agent.mutation_red_x`（gate 数不变）再跑 `--presets` | ①0；②exit 1 且输出含 `G_agent_verify_exit 的 criteria 与发布快照不一致` |
| R12 | `gate.mjs` 能否挡住四类假绿且不误红？ | 在 `/tmp/gp` 建夹具：复制 `skills/sdo-flow` 进去（`cp -r skills/sdo-flow /tmp/gp/skills/`，否则脚本按自身目录找不到 preset）；`.sdo/01-计划.md` 写 `preset：agent-driven`；`.sdo/gates/M1.md` 按 `templates/gates.md` 建 16 行全 pass + `## 3. 人签` 带「签：接受」。依次跑 `node /tmp/gp/skills/sdo-flow/scripts/gate.mjs G_frame_exit`：正例；负 1 证据改 `—`；负 2 删 `spec_set.signed` 行；负 3 全改 partial 且签名改「改：」；负 4 全改 fail 且签名改「不签：」 | 正例 exit 0；四负例各 exit 1，首条报错依次含：“证据为空/占位”“缺判据 spec_set.signed”“core 判据 spec_set.signed 不是 pass（partial）”“core 判据 spec_set.signed 不是 pass（fail）”；负 3/负 4 的「没有「选项：签：…」接受它」可能排在其后，不要求首条 |
| R13 | 补卡后是否达到“无 P0、P1 全处置并复认”？ | 两席独立评审（`reviewer`、`reviewer-3`，均非作者）分别对 M3-0/M3-1 给判词 | 无 P0；P1 全处置且有复认记录 |

## M3.2 卡表

| 卡 | 意图（一句话） | 依赖 | 写域 | owner |
|---|---|---|---|---|
| M3-0 | 为已交付的 `agent-driven` preset 补卡并接受两轮评审 | M2-G | `skills/sdo-flow/presets/agent-driven.md`、`skills/sdo-flow/presets/README.md`、`skills/sdo-flow/scripts/check.mjs`、`skills/sdo-flow/templates/01-计划.md`、`.sdo/cards/M3-0.md` | lead |
| M3-1 | 为已交付的 `gate.mjs` 补卡并接受两轮评审 | M2-G | `skills/sdo-flow/scripts/gate.mjs`、`skills/sdo-flow/templates/gates.md`、`skills/sdo-flow/SKILL.md`、`README.md`、`skills/sdo-flow/references/02-判据与门禁.md`、`.sdo/cards/M3-1.md` | lead |
| M3-G | 收 M3 读数门、写评审记录并请人签 | M3-0, M3-1 | `.sdo/readings/`、`.sdo/review/M3-审查.md`、`.sdo/sign/`、`.sdo/台账.md` | lead |

## M3.3 阶段

`incremental` 简化版：补卡（req_design）→ 两轮评审（verify）→ 读数与门（integrate）。

## M3.4 冻结段

- 待签：S10（本段 + 卡表）；被签对象：`f5b97e9` 之后的最终提交（签署时回填）。
- 卡签：S11（M3-0/M3-1 收卡，可两问同批）；门签：S12（M3 门）。
- 评审门：两席判词 + 复认记录进 `.sdo/review/M3-审查.md`。
