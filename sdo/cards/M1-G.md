# M1-G · 读数门（R1–R7）

status: open ｜ owner: lead
write_scope: [sdo/readings/, sdo/sign/]

## 意图
用一个可复跑的门，回答“这个 skill 现在能不能用”，而不是“我们写了多少文件”。

## 风险标记

risk_flags：`release_touching`（这是里程碑门）

## 对齐
- 该做：七条读数逐条给命令 + 输出摘要 + verdict；树冻结后取证；partial 照实写。
- 不该做：不把“文件存在”当读数；不用旧读数给新树签门；不写“全部 pass”而不给命令。

## 判据
C1 R1–R7 每条都有命令、输出摘要、verdict 三列。
  正例：`sdo/readings/M1.md` 7 行齐全。
  反例：少一条 ⇒ 门不成立。
C2 每条 verdict ∈ {pass, partial, fail}，partial 必须写缺口。
  正例：7/7。
  反例：写“基本可用” ⇒ 检查器报缺 verdict。
C3 取证时点写死（`- 取证时间：`），且在此之后无代码/文件改动（`git status --porcelain` 为空）。
  正例：时间 + 空状态。
  反例：取证后又改 skill ⇒ 判 fail。
C4 门签走人签三选项，签字文件写清被签对象（commit/sha256）与已知边界。
  正例：`sdo/sign/S-M1.md` 三字段齐全。
  反例：只写“内部确认” ⇒ 判 fail。

## 假设
A1：R1 的另一会话复验做不到 ⇒ 记 caveat（本会话 catalog 出现 + 加载可读）。
A2：R2 的“实跑”以本仓库自身走过七步为证据，不是另起一个项目。

## 预览
预计改：新增 `sdo/readings/M1.md`、`sdo/sign/S-M1.md`；验：R1–R7 + 检查器。

## 准入
依赖：M1-0、M1-1、M1-2（三条产物卡）

## 证据
| 判据 | 命令 | 输出摘要 | 改回去会怎样 |
|---|---|---|---|
| C1 | `grep -c '^| R[1-7] ' sdo/readings/M1.md` | 7 | 少一条 ⇒ 门不成立 |
| C2 | `node .dsh/skills/sdo-flow/scripts/check.mjs` | exit 0，readings 有 overall + verdict | 写“基本可用” ⇒ 检查器红 |
| C3 | `git status --porcelain` | 空 | 取证后改动 ⇒ 读数作废 |
| C4 | `grep -c '时间：\\|选项：\\|被签对象：' sdo/sign/S-M1.md` | 3 | 缺字段 ⇒ 检查器红 |

## 判定
待判定（跑完 R1–R7 后填）

## 评审
- 第 1 轮：待评
- 第 2 轮：待评
