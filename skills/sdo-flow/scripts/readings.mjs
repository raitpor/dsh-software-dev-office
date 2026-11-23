#!/usr/bin/env node
// readings.mjs — 里程碑读数骨架（M11-4）。零依赖 Node ESM。
// 用法：node <skill>/scripts/readings.mjs init <M>
// 从 .sdo/milestones/<M>.md 的读数表生成 .sdo/readings/<M>.md；
// 已存在不覆盖；缺参 exit 2；写前打印「将写：」。

import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "./lib/paths.mjs";

const USAGE = `用法：
  node <skill>/scripts/readings.mjs init <M>
从 .sdo/milestones/<M>.md 的读数表生成读数骨架；已存在不覆盖；缺参 exit 2。`;

function die(message) { console.error(message); process.exit(2); }

function parseRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, "|").replace(/`/g, ""));
    if (cells.length < 3 || /^[-: ]+$/.test(cells[0]) || /^读数$/i.test(cells[0])) continue;
    const id = cells[0].match(/^R\d+$/)?.[0];
    if (id) rows.push({ id, question: cells[1] || "", how: cells[2] || "", target: cells[3] || "" });
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === "--help" || a === "-h")) { console.log(USAGE); process.exit(0); }
  if (argv[0] !== "init" || !/^M\d+$/.test(argv[1] || "")) die("用法：readings.mjs init <M>");
  const { projectRoot, skillRoot } = resolvePaths();
  if (!projectRoot) die("找不到 .sdo/（请从项目根或子目录运行；先跑 init.mjs）");
  const mid = argv[1];
  const src = path.join(projectRoot, ".sdo/milestones", `${mid}.md`);
  if (!fs.existsSync(src)) die(`找不到 .sdo/milestones/${mid}.md`);
  const rows = parseRows(fs.readFileSync(src, "utf8"));
  if (!rows.length) die(`里程碑 ${mid} 的读数表没有数据行或 R<n> 行`);
  const out = path.join(projectRoot, ".sdo/readings", `${mid}.md`);
  if (fs.existsSync(out)) { console.log(`已存在，跳过：${path.relative(projectRoot, out)}`); process.exit(0); }
  const text = [`# ${mid} 里程碑读数`, "", `> 生成自 .sdo/milestones/${mid}.md；骨架默认 partial，取证后改判。`, "",
    "- 树冻结：待填；被签树：待填", ""];
  for (const r of rows) {
    text.push(`## ${r.id} ${r.question}`, `- 问题：${r.question}`, "- 命令：待填", "- 输出：待填", "- verdict：partial", `- caveat：骨架（未取证）；达标线：${r.target || "待填"}`, "");
  }
  text.push("## overall：partial", "");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rel = path.relative(projectRoot, out);
  console.log(`将写：${rel}`);
  fs.writeFileSync(out, text.join("\n"));
  console.log(`下一步：填 ${rel} 的逐条 verdict；再跑 node <skill>/scripts/check.mjs`);
  process.exit(0);
}
main();
