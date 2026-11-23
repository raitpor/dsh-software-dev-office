#!/usr/bin/env node
// milestone.mjs — 里程碑骨架与冻结 hash 行（M11-0）。零依赖 Node ESM。
//
// 用法：
//   node <skill>/scripts/milestone.mjs new <M> --topic <主题>
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
  node <skill>/scripts/milestone.mjs freeze <M>

new 生成 .sdo/milestones/<M>.md 六段骨架（冻结段含「门禁：」「判据：」占位）。
freeze 就地写/替换 hash:<64hex> 行；二次执行不变。`);
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--topic") {
      const v = argv[++i];
      if (v === undefined) die("--topic 缺值");
      out.topic = v;
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
<!-- 可选：- 门禁判据：G_req_design = c1, c2（按门映射；不写则按全局判据并集） -->
- 基线 hash：${baseHash}
`;
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
  console.log(`下一步：在 .sdo/计划.md 的里程碑表里加一行索引（见 templates/计划.md）；然后 node <skill>/scripts/check.mjs --plan --milestone ${milestone}；需要核对 hash 时加 --print-frozen-hash`);
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
  const { projectRoot } = resolvePaths();
  if (!projectRoot) die("找不到 .sdo/（请从项目根或子目录运行；先跑 init.mjs）");
  if (cmd === "new") cmdNew(projectRoot, args);
  else if (cmd === "freeze") cmdFreeze(projectRoot, args);
  else die(`未知子命令：${cmd}（只支持 new / freeze）`);
}

main();
