#!/usr/bin/env node
// sdo-flow 初始化：在空项目建出 .sdo/ 的 18 项骨架（幂等）。
// 用法：node <skill>/scripts/init.mjs [--root <dir>] [--dry-run] [--force]
import fs from "node:fs";
import path from "node:path";
import { resolveSkillRoot } from "./lib/paths.mjs";
import { assertNotInsideSkill } from "./lib/guard.mjs";

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(`用法：node <skill>/scripts/init.mjs [--root <dir>] [--dry-run] [--force]`);
  process.exit(0);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const rootArg = args.includes("--root") ? args[args.indexOf("--root") + 1] : ".";
const ROOT = path.resolve(process.cwd(), rootArg || ".");
const SKILL = resolveSkillRoot(ROOT).root;
assertNotInsideSkill(ROOT, SKILL, "init.mjs");
const DRY = has("--dry-run");
const FORCE = has("--force");
const name = path.basename(ROOT) || "project";
const date = new Date().toISOString().slice(0, 10);

const files = {
  "意图.md": `# 意图（intent）：${name}

状态：**待签** ｜ 提出：${date}
版本：intent-001

## 1. 一句话
用一句话写清：这件事做完，什么会成立。

## 2. 为什么
不做的代价；现在为什么必须做。

## 3. 三条保证怎么落地

| 保证 | 本项目的载体 | 挡不住什么 |
|---|---|---|
| 对齐 | 意图/复述 + 人签问答 | 无密码学签名 |
| 可审计 | 追加式账本 + 日期出处 | 账本可改 |
| 防漂移 | 判据清单 + 可复跑命令 | 无机器门禁 |

## 4. 做什么（范围）
1. 写第一条可执行的范围。

## 5. 不做什么（非目标）
- 写清本里程碑明确不做的事。

## 6. 验收判据（人签前写死）

| # | 判据 | 怎么验（正例 / 反例） |
|---|---|---|
| A1 | 写一条可判死的判据 | 正例一条命令；反例一个会红的输入 |

## 7. 假设
- A1：写一条假设；若不成立 ⇒ 写清怎么停下来。

## 8. 待确认（请签署者裁决）
1. 写清需要人决定的事。

## 9. 需求
- R-01：在 .sdo/baseline/requirement.md 里写三条真实需求。

## 12. 判据依据索引（供新判据引用）

> 新判据写 \`（依据：§12.<n>）\` 时，\`<n>\` 必须是本节真实存在的小节号；否则 \`check\` 报 \`basis_section_missing\`。

### 12.1 流程状态可读

状态、判定与证据只出现在文本里，不靠口头记忆。

### 12.2 门禁与读数可复跑

每条门禁/读数都能用仓库内命令复跑，并给出反例红证。
`,
  "计划.md": `# 计划：项目级

状态：**进行中** ｜ 最近改动：${date}

## 1. 里程碑索引

| 里程碑 | 主题 | preset | 计划签 | 门签 | 里程碑文件 | 状态 |
|---|---|---|---|---|---|---|

## 2. 签字约定
- 一卡两笔：代码一笔、卡与台账一笔。
- 卡签：\`- 范围：<卡号>\`；门签：\`- 范围：M<n> 里程碑门\`（同时算 \`M<n>-G\` 收口签）。
- 追加签：\`S<n>-<A..Z>.md\`。历史签字只追加。

## 3. 阶段与 preset 选择
- 冻结段写 \`- 门禁：\`/\`- 判据：\`/\`- 门禁判据：\` 三行声明；\`preset\` 只是可抄写的参考，**真源不写 \`preset\` 字段**（出现即 \`preset_field_removed\`）。
- 套话黑名单（共用）：无、没有、不适用、不需要、无所谓、待补充、略、同上。

## 4. 共享写域总则
- 每张卡写 \`write_scope: [...]\`；共享文件在对应里程碑文件的「共享写域补充」表登记。

## 5. 文件布局
\`\`\`
.sdo/
  意图.md  计划.md  台账.md  看板.md
  milestones/M<n>.md
  cards/ sign/ review/ readings/ gates/ notes/ ledger/ archive/ .index/
\`\`\`
`,
  "台账.md": `# 偏差台账

> 用途：gap / defect / explain 三类记录，7 列；append-only。
> 用法：\`node <skill>/scripts/ledger.mjs add|close|list|rotate|reindex\`。

| id | kind | 位置 | 现象 | 影响 | 处置 | 状态 |
|---|---|---|---|---|---|---|
`,
  "看板.md": `# 看板（${date}）

| 里程碑 | 卡 | owner | 状态 | 依赖 | 备注 |
|---|---|---|---|---|---|
`,
  "baseline/requirement.md": `# 需求基线

### R-01 建立可复跑的门禁
- 验收：在空项目执行 \`node <skill>/scripts/check.mjs\` 返回 0 错。

### R-02 流程状态全部落文本
- 验收：\`grep -R "status:" .sdo/cards\` 能列出每张卡状态。

### R-03 签字由人发起且可追溯
- 验收：每个 \`.sdo/sign/S*.md\` 有标题、被签对象、选项三项，且 \`check\` 校验通过。
`,
  "baseline/architecture.md": `# 架构基线

## ADR-01：项目状态使用文本文件
- 决策：所有流程状态写入 \`.sdo/\` 下的 Markdown，不使用数据库。
- 备选：用数据库存状态；未选因为不可直接审阅、合并冲突难处理。
- 后果：可直接 diff/评审；需要检查器保证格式。
`,
  "baseline/test-strategy.md": `# 测试策略

| 变更类型 | 测试技术 |
|---|---|
| 脚本/规则 | 单测 + /tmp 副本夹具 + 变异红证 |
| 模板/文档 | 结构检查 + 反例 |
| 基线/计划 | hash 重算 + 漂移反例 |
`,
  "baseline/quality-risk.md": `# 质量与风险

## 质量属性
- 可审阅：状态以纯文本保存，可直接 diff。

## 风险登记
| 风险 | 影响 | 处置 |
|---|---|---|
| 文本可手改 | 历史可能被改写 | 以 git 追加历史为准，检查器只验格式 |
`,
};

const dirs = ["cards", "milestones", "gates", "readings", "review", "sign", "notes", "archive", "ledger", ".index"];
const items = [...Object.keys(files).map((f) => `.sdo/${f}`), ...dirs.map((d) => `.sdo/${d}/`)];

const existing = items.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
const missing = items.filter((rel) => !existing.includes(rel));
const wantWrite = FORCE ? items : missing;

if (DRY) {
  for (const rel of missing) console.log(`将创建 ${rel}`);
  for (const rel of existing) console.log(`已存在跳过 ${rel}`);
  console.log(`\n摘要：将创建 ${missing.length} 项，已存在 ${existing.length} 项（dry-run，未写盘）`);
  process.exit(0);
}
if (FORCE) for (const rel of existing) console.log(`将覆盖 ${rel}`);
for (const dir of dirs) fs.mkdirSync(path.join(ROOT, ".sdo", dir), { recursive: true });
const todo = Object.entries(files).filter(([rel]) => FORCE || !fs.existsSync(path.join(ROOT, ".sdo", rel)));
let done = 0;
for (const [rel, body] of todo) {
  const abs = path.join(ROOT, ".sdo", rel);
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, abs);
    done += 1;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    console.log(`覆盖失败：已覆盖 ${done} 个，未覆盖：${todo.slice(done).map(([r]) => `.sdo/${r}`).join("、")}`);
    console.log(`原因：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
console.log(`已初始化 .sdo/（新建 ${wantWrite.length} 项，已有 ${existing.length} 项未动）`);
console.log("\n下一步（可复制）：");
console.log(`1. 编辑意图：${path.join(ROOT, ".sdo/意图.md")}`);
console.log(`2. 填基线：${path.join(ROOT, ".sdo/baseline/")}（四份，先写 requirement.md 三条验收）`);
console.log(`3. 先跑：node ${path.join(SKILL, "scripts/check.mjs")}（--plan --milestone M1 要等 .sdo/milestones/M1.md 建好后再用）`);
