#!/usr/bin/env node
// milestone.mjs — 里程碑骨架与冻结 hash 行（M11-0）。零依赖 Node ESM。
//
// 用法：
//   node <skill>/scripts/milestone.mjs new <M> --topic <主题>
//   node <skill>/scripts/milestone.mjs declare <M> --gates G_a,G_b --criteria c1,c2 [--map "G_a=c1,c2;G_b=c3"]
//   node <skill>/scripts/milestone.mjs freeze <M>
//
// new 硬编码六段骨架；不读模板、不接 --preset、不写 preset： 字段。
// freeze 就地写/替换 hash:<64hex> 行（口径与 lib/frozen.mjs 一致），二次执行不变。
// 缺参 exit 2 且零写入；写前打印「将写：」。

import fs from "node:fs";
import path from "node:path";
import { resolvePaths, skillPath } from "./lib/paths.mjs";
import { frozenHashRaw } from "./lib/frozen.mjs";
import { baselineHash } from "./lib/hash.mjs";

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
  console.log(`用法：
  node <skill>/scripts/milestone.mjs new <M> --topic <主题>
  node <skill>/scripts/milestone.mjs declare <M> --gates G_a,G_b --criteria c1,c2 [--map "G_a=c1,c2;G_b=c3"]
  node <skill>/scripts/milestone.mjs declare --list
  node <skill>/scripts/milestone.mjs freeze <M>

new 生成 .sdo/milestones/<M>.md 六段骨架（冻结段含「门禁：」「判据：」占位），并尝试追加计划索引行。
declare 只重写冻结段的门禁/判据/门禁判据；不写 hash（freeze 单独跑）；--dry-run 只打印将写内容。
declare --list 只读打印合法门名与判据池（可直接抄进 declare）。
freeze 就地写/替换 hash:<64hex> 行；二次执行不变。`);
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--list") out.list = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--topic" || a === "--gates" || a === "--criteria" || a === "--map") {
      const v = argv[++i];
      if (v === undefined) die(`${a} 缺值`);
      out[a.slice(2)] = v;
    } else if (a.startsWith("--")) die(`未知参数：${a}（用 --help 看用法）`);
    else out._.push(a);
  }
  return out;
}

function skeleton(milestone, topic, baseHash) {
  return `## ${milestone} · ${topic}

状态：待签

### ${milestone}.0 认领需求

需求：无（本里程碑尚未认领需求，待计划评审时填写）

### ${milestone}.1 里程碑与判死读数

探底：
- 探底 R<n>：<在 /tmp 的预跑问题>

| 读数 | 问题 | 怎么量 | 达标线 |
|---|---|---|---|
| R<n> | <问题> | <可复跑命令> | <可判标准> |

### ${milestone}.2 卡表

| 卡 | 内容 | 依赖 | 写域 |
|---|---|---|---|
| <${milestone}-0> | <卡内容> | — | <写域> |

### ${milestone}.3 共享写域

| 文件/目录 | 允许改的卡 | 说明 |
|---|---|---|
| <路径> | <卡号> | <说明> |

### ${milestone}.4 阶段

阶段序列：\`req_design\`→\`build\`→\`verify\`→\`integrate\`

### ${milestone}.5 冻结段

- 被签对象：<待签时填 commit>
- 冻结判据：\`check --plan --milestone ${milestone}\` 0 漂移
- 门禁：<G_req_design → G_build_exit → G_verify_exit → G_integrate>
- 判据：<声明判据列表>
<!-- 有门表时必须写映射：- 门禁判据：G_req_design = c1, c2（一行一门；不写会用全局并集灌满每个门） -->
- 基线 hash：${baseHash}
`;
}


function planCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
}

function appendPlanIndex(root, milestone, topic, rel) {
  const planRel = ".sdo/计划.md";
  const file = path.join(root, planRel);
  if (!fs.existsSync(file)) {
    console.log(`计划文件不存在：${planRel}（不创建）；下一步：先建计划，再在里程碑表加一行索引`);
    return;
  }
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const h = lines.findIndex((l) => /^\|\s*里程碑\s*\|/.test(l) && l.includes("主题") && l.includes("状态"));
  if (h < 0) { console.log(`计划文件里找不到里程碑索引表：${planRel}（跳过自动索引）`); return; }
  const header = planCells(lines[h]);
  if (!header.includes("里程碑") || !header.includes("状态")) return;
  let last = h + 1;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith("|")) last++;
  const exists = lines.slice(h + 2, last + 1).some((l) => planCells(l)[header.indexOf("里程碑")] === milestone);
  if (exists) { console.log(`计划索引已有 ${milestone}，跳过`); return; }
  const values = {
    里程碑: milestone,
    主题: topic,
    preset: "—",
    计划签: "—",
    门签: "—",
    里程碑文件: rel,
    状态: "待签",
  };
  const row = `| ${header.map((c) => values[c] ?? "—").join(" | ")} |`;
  lines.splice(last + 1, 0, row);
  writeAtomic(file, lines.join("\n") + "\n");
  console.log(`将写：${planRel} 索引行（${milestone}）`);
}

function listDeclarations(skillRoot) {
  const gates = new Set();
  const criteria = new Set();
  const CORE = ["spec_set.signed", "assumption_set.signed", "provenance.present"];
  const addText = (text) => {
    let fenced = false;
    for (const raw of text.split(/\r?\n/)) {
      let line = raw;
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      if (line.includes("<!--")) line = line.slice(0, line.indexOf("<!--"));
      if (!line.trim()) continue;
      for (const m of line.matchAll(/G_[a-z0-9_]+/g)) {
        const g = m[0];
        if (/^G_(id|x|a|b)$/.test(g) || /^G_xxx/.test(g)) continue;
        gates.add(g);
      }
      for (const m of line.matchAll(/`([a-z_]+\.[a-z_]+)`/g)) criteria.add(m[1]);
    }
  };
  const dirs = [path.join(skillRoot, "presets"), path.join(skillRoot, "references")];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      if (dir.endsWith("references") && f !== "02-判据与门禁.md") continue;
      addText(fs.readFileSync(path.join(dir, f), "utf8"));
    }
  }
  const core = CORE.filter((c) => criteria.has(c));
  const pool = [...criteria].filter((c) => !core.includes(c)).sort();
  const gs = [...gates].sort();
  console.log(`合法门（${gs.length}，来自 presets 出口 / references/02）：`);
  for (const g of gs) console.log(`  ${g}`);
  console.log("");
  console.log(`core 三条强制判据（${core.length}；declare 会把它们自动并入 --criteria 的「判据：」与每个映射门，不必手写）：`);
  for (const c of core) console.log(`  ${c}`);
  console.log("");
  console.log(`启发式判据池（${pool.length}，来自 presets 判据列 / references/02）：`);
  for (const c of pool) console.log(`  ${c}`);
  console.log("");
  console.log("可直接抄（示例）：");
  console.log(`  node <skill>/scripts/milestone.mjs declare <M> --gates ${gs.slice(0, 4).join(",")} --criteria ${CORE.join(",")}`);
  console.log(`  （按门映射：--map "G_a=c1,c2;G_b=c3"）`);
}

function cmdDeclare(root, args) {
  const milestone = args._[0];
  if (!milestone) die("缺里程碑号（如 M11）");
  if (!/^M\d+$/.test(milestone)) die(`里程碑号不合法：${milestone}`);
  const gates = (args.gates ?? "").trim();
  const CORE = ["spec_set.signed", "assumption_set.signed", "provenance.present"];
  const criteriaRaw = (args.criteria ?? "").trim();
  const criteria = [...CORE, ...criteriaRaw.split(",").map((x) => x.trim()).filter((c) => c && !CORE.includes(c))].join(",");
  if (!gates) die("declare 缺必填参数 --gates");
  if (!criteriaRaw && !(args.map ?? "").trim()) die("declare 缺必填参数 --criteria（或 --map）");
  const rel = `.sdo/milestones/${milestone}.md`;
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) die(`里程碑文件不存在：${rel}`);
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s+.*冻结段/.test(l));
  if (start < 0) die(`找不到「## 冻结段」：${rel}`);
  let end = lines.findIndex((l, i) => i > start && /^#{2,3}\s+/.test(l));
  if (end < 0) end = lines.length;
  const decl = [
    `- 门禁：${gates.split(",").map((x) => x.trim()).filter(Boolean).join(" → ")}`,
    `- 判据：${[...CORE, ...criteriaRaw.split(",").map((x) => x.trim()).filter((c) => c && !CORE.includes(c))].join("、")}`,
  ];
  const map = (args.map ?? "").trim();
  if (map) {
    for (const item of map.split(";").map((x) => x.trim()).filter(Boolean)) {
      const eq = item.indexOf("=");
      if (eq < 0) die(`--map 格式错：${item}（应为 G_a=c1,c2;G_b=c3）`);
      const gid = item.slice(0, eq).trim();
      if (!gates.split(",").map((x) => x.trim()).includes(gid)) die(`--map 的门 ${gid} 不在 --gates：${gates}`);
      const own = item.slice(eq + 1).split(",").map((x) => x.trim()).filter(Boolean);
      const cs = [...CORE, ...own.filter((c) => !CORE.includes(c))].join(", ");
      decl.push(`- 门禁判据：${gid} = ${cs}`);
    }
  }
  const kept = [];
  for (let i = start + 1; i < end; i++) {
    if (/^-\s*(门禁|判据|门禁判据)[:：]/.test(lines[i])) continue;
    kept.push(lines[i]);
  }
  const next = [...lines.slice(0, start + 1), ...decl, ...kept, ...lines.slice(end)].join("\n");
  console.log(`将写：${rel}（冻结段门禁/判据/门禁判据；core 三条自动并入 --criteria 与每个映射门；不写 hash）`);
  for (const line of decl) console.log(`  ${line}`);
  if (args.dryRun) {
    console.log(`下一步：node <skill>/scripts/milestone.mjs freeze ${milestone}`);
    return;
  }
  writeAtomic(file, next);
  console.log(`下一步：node <skill>/scripts/milestone.mjs freeze ${milestone}`);
}

function cmdNew(root, args) {
  const milestone = args._[0];
  if (!milestone) die("缺里程碑号（如 M11）");
  if (!/^M\d+$/.test(milestone)) die(`里程碑号不合法：${milestone}（应为 M<数字>）`);
  const topic = (args.topic ?? "").trim();
  if (!topic) die("缺必填参数 --topic（如 --topic \"写路径工具化\"）");
  const rel = `.sdo/milestones/${milestone}.md`;
  const file = path.join(root, rel);
  if (fs.existsSync(file)) die(`里程碑文件已存在：${rel}（不覆盖；如需改内容请手工编辑）`);
  console.log(`将写：${rel}`);
  const base = skeleton(milestone, topic, baselineHash(root));
  const hash = frozenHashRaw(base);
  writeAtomic(file, `${base}hash:${hash}\n`);
  console.log(`已生成 ${rel}（hash:${hash.slice(0, 8)}…）`);
  appendPlanIndex(root, milestone, topic, rel);
  console.log(`下一步：node <skill>/scripts/check.mjs --plan --milestone ${milestone}；需要核对 hash 时加 --print-frozen-hash`);
}

function cmdFreeze(root, args) {
  const milestone = args._[0];
  if (!milestone) die("缺里程碑号（如 M11）");
  if (!/^M\d+$/.test(milestone)) die(`里程碑号不合法：${milestone}`);
  const rel = `.sdo/milestones/${milestone}.md`;
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) die(`里程碑文件不存在：${rel}`);
  const raw = fs.readFileSync(file, "utf8");
  const hash = frozenHashRaw(raw);
  let next;
  if (/^hash:.*$/m.test(raw)) next = raw.replace(/^hash:.*$/m, `hash:${hash}`);
  else next = `${raw.replace(/\n?$/, "\n")}hash:${hash}\n`;
  console.log(`将写：${rel}`);
  writeAtomic(file, next);
  console.log(`已更新 ${rel} 的 hash:${hash.slice(0, 8)}…`);
  console.log(`下一步：node <skill>/scripts/check.mjs --plan --milestone ${milestone}；需要复核时用 --print-frozen-hash`);
}

function main() {
  const args = parse(process.argv.slice(2));
  if (args.help || args._.length === 0) { usage(); if (args.help) process.exit(0); die("缺子命令"); }
  const [cmd, ...rest] = args._;
  args._ = rest;
  const { projectRoot, skillRoot } = resolvePaths();
  if (cmd === "declare" && args.list) { listDeclarations(skillRoot); process.exit(0); }
  if (!projectRoot) die("找不到 .sdo/（请从项目根或子目录运行；先跑 init.mjs）");
  if (cmd === "new") cmdNew(projectRoot, args);
  else if (cmd === "declare") cmdDeclare(projectRoot, args);
  else if (cmd === "freeze") cmdFreeze(projectRoot, args);
  else die(`未知子命令：${cmd}（只支持 new / declare / freeze）`);
}

main();
