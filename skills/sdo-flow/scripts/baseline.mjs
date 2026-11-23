#!/usr/bin/env node
// baseline.mjs — 项目基线四份初始化（M11-0）。零依赖 Node ESM。
//
// 用法：
//   node <skill>/scripts/baseline.mjs init
//
// 从 templates/baseline.md 的四节骨架拆出 .sdo/baseline/ 四份：
// requirement.md / architecture.md / test-strategy.md / quality-risk.md。
// 只补齐缺失文件；已存在不覆盖。缺参 exit 2 且零写入。

import fs from "node:fs";
import path from "node:path";
import { resolvePaths, skillPath } from "./lib/paths.mjs";

const FILES = ["requirement.md", "architecture.md", "test-strategy.md", "quality-risk.md"];

function die(message) {
  console.error(message);
  process.exit(2);
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function usage() {
  console.log(`用法：node <skill>/scripts/baseline.mjs init

从 templates/baseline.md 拆出 .sdo/baseline/ 四份最小合法基线；已存在文件跳过。`);
}

function contentFor(name) {
  if (name === "requirement.md") {
    return `# 需求

### R-01 流程状态全部落在文本真源
- 验收：从项目根运行 node skills/sdo-flow/scripts/check.mjs，输出 0 个错误且 .sdo/台账.md 存在。

### R-02 门禁与读数可复跑
- 验收：node skills/sdo-flow/scripts/check.mjs 输出 0 个错误。

### R-03 签字由人发起且可追溯
- 验收：.sdo/sign/ 下存在签文件，且文件内记录的范围/被签对象/判据三字段齐全。
`;
  }
  if (name === "architecture.md") {
    return `# 架构决策

## ADR-01：以文件为唯一真源
- 决策：项目状态保存在 .sdo/ 的 Markdown 文件中，脚本只读写这些文件。
- 备选：集中式数据库；因冷启动与可迁移性不足未选。
- 后果：可审计、可 diff；代价是并发写需要靠追加与锁约定。
`;
  }
  if (name === "test-strategy.md") {
    return `# 测试策略

| 变更类型 | 测试技术 |
|---|---|
| 脚本/规则 | 单元测试 + /tmp 副本夹具 + 变异红证 |
| 模板/文档 | 结构检查 + 反例 |
| 基线/计划 | hash 重算 + 漂移反例 |
`;
  }
  return `# 质量与风险

## 质量属性
- 可审计：每次状态变化都能在 .sdo/ 事件或台账中定位。

## 风险登记
| 风险 | 影响 | 处置 |
|---|---|---|
| 手改绕过脚本 | 状态与索引不一致 | 机检 + 人签复核 |
`;
}


function headingOf(line) {
  const m = /^(#{2,3})\s+(.+)$/.exec(line);
  if (!m) return null;
  return m[2].trim();
}

function normalizeHeading(h) {
  if (/^ADR-/.test(h)) return "ADR-<n>";
  const r = /^R-\d+/.exec(h);
  if (r) return r[0];
  return h.replace(/[：:].*$/, "").trim();
}

function builtinHeadings(name) {
  const out = new Set();
  for (const line of contentFor(name).split("\n")) {
    const h = headingOf(line);
    if (h) out.add(normalizeHeading(h));
  }
  return out;
}

function templateHeadings(tplText, name) {
  const lines = tplText.split("\n");
  const marker = new RegExp(`^##\\s+\\d+\\.\\s+${name.replace(".", "\\.")}`);
  const start = lines.findIndex((l) => marker.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\d+\./.test(lines[i])) break;
    const h = headingOf(lines[i]);
    if (h) out.push(normalizeHeading(h));
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { usage(); return; }
  if (argv.length !== 1 || argv[0] !== "init") die("用法：baseline.mjs init（只支持 init）");
  const { projectRoot, skillRoot } = resolvePaths();
  if (!projectRoot) die("找不到 .sdo/（请从项目根或子目录运行；先跑 init.mjs）");
  const tpl = skillPath(skillRoot, "templates/baseline.md");
  if (!fs.existsSync(tpl)) die(`模板不存在：${tpl}`);
  const tplText = fs.readFileSync(tpl, "utf8");
  for (const name of FILES) {
    const tplHeads = templateHeadings(tplText, name);
    if (tplHeads === null) die(`baseline_template_drift：模板缺「${name}」小节，无法同源校验`);
    const own = builtinHeadings(name);
    for (const h of tplHeads) {
      if (!own.has(h)) die(`baseline_template_drift：模板标题「${h}」在 ${name} 内置骨架中缺失（模板改结构后需同步 baseline.mjs）`);
    }
  }
  const toWrite = [];
  const skipped = [];
  for (const name of FILES) {
    const rel = `.sdo/baseline/${name}`;
    const file = path.join(projectRoot, rel);
    if (fs.existsSync(file)) skipped.push(rel);
    else toWrite.push({ rel, name });
  }
  if (toWrite.length) {
    console.log(`将写：${toWrite.map((x) => x.rel).join("、")}`);
    for (const { rel, name } of toWrite) writeAtomic(path.join(projectRoot, rel), contentFor(name));
  }
  if (skipped.length) console.log(`已存在，跳过：${skipped.join("、")}`);
  if (!toWrite.length) console.log("四份基线均已存在，未改动。");
  console.log(`下一步：先 node <skill>/scripts/check.mjs 看结构；有里程碑文件后加 --plan --milestone <M> 看冻结段。`);
}

main();
