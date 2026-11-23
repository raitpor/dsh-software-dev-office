#!/usr/bin/env node
// sdo-flow 文本检查器（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目内任意目录）：node <skill>/scripts/check.mjs [--presets [判据源文件]] [--all]
// 退出码：0 全过；1 有错误；2 找不到 .sdo/。只读，不改文件。
// 扫描范围：默认只查 .sdo/ 与本项目里带 SKILL.md 的 skill 目录（避让他人文档）；--all 才扫整个仓库。
// --presets 不带参数：校验四份 preset 与发布快照（stage 集合、gate 集合、criteria 逐条名称）
// --presets <文件>：与外部判据源逐条比对（可用设计稿 §1.1 原文）
import fs from "node:fs";
import { frozenHashRaw } from "./lib/frozen.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { signedCardIds, gateSignInfo, SIGN_FILE_RE } from "./lib/signed-cards.mjs";
import { sortSigns } from "./lib/signs.mjs";
import { analyzeTrace, planIndexStatus } from "./lib/trace.mjs";
import { baselineHash, BASELINE_FILES } from "./lib/hash.mjs";
import { readArchiveIndex as archiveRows, archiveEntry, assertArchivedIntegrity, orphanArchiveDirs, ARCHIVE_STATUSES } from "./lib/archive.mjs";
import { currentMilestone, activeMilestonesUsing } from "./lib/preset.mjs";
import { parseVerdict, isUnsignedVerdict } from "./lib/verdict.mjs";
import { resolvePaths, skillPath } from "./lib/paths.mjs";

const USAGE = `用法：node <skill>/scripts/check.mjs [--plan] [--milestone M<n>] [--trace] [--presets [判据源]] [--deep] [--js] [--all]

  --plan              检查计划段（里程碑/preset/冻结 hash/阶段顺序等）
  --print-frozen-hash 须与 --plan --milestone <M> 同用：只打印完整 64 位冻结段 hash 并 exit 0（只读）；单独使用无意义（会走默认检查路径）
  --milestone M<n>    配合 --plan 指定里程碑
  --trace             追溯链检查：需求←→卡←→判据←→测试（默认只判 done 卡）
  --presets [文件]    校验 preset 与发布快照，或与外部判据源比对
  --deep              台账卷全量审计（逐行扫所有卷；默认仅扫 openRows>0 的卷）
  --js                机器可读输出：--trace 时 {ok,counts,issues[]}，否则 {ok,errors,warnings}
  --all               扫描整个仓库（默认只扫 .sdo/ 与技能目录）
  --help, -h          显示本用法
退出码：0 全过；1 有错误；2 参数/环境错误。
注意：--trace 与 --plan 互斥；--trace 与 --deep 互斥（--deep 只作用于台账卷校验）。`;
if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const PATHS = resolvePaths(process.cwd());
const ROOT = PATHS.projectRoot;
if (!ROOT) { console.error("找不到 .sdo/：请在项目内运行；下一步：按 README 建 .sdo/ 与 意图.md/台账.md"); process.exit(2); }
const SKILL_ROOT = PATHS.skillRoot;
const SKILL_REL = (() => { const r = path.relative(ROOT, SKILL_ROOT).split(path.sep).join("/"); return r && !r.startsWith("..") ? r : SKILL_ROOT; })();
const SKILL_ABS = SKILL_ROOT; // 下一步命令一律用绝对路径：在项目子目录里跑也成立
const ARGV = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--plan", "--milestone", "--trace", "--deep", "--presets", "--all", "--js", "--print-frozen-hash"]);
for (const a of ARGV) {
  if (a.startsWith("--") && !KNOWN_FLAGS.has(a)) {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}
if (ARGV.includes("--trace") && ARGV.includes("--plan")) {
  console.error("--trace 与 --plan 不能同时使用");
  process.exit(2);
}
// CLI 局部错误码：SDO_E_MISSING_* 只用于“缺文件”这一类启动前错误，不进码表；
// M10-4 references 同步时登记到 references/08 的错误码清单（本卡不建码表）。
const preflightMissing = (rel, next, code) => {
  if (fs.existsSync(path.join(ROOT, rel))) return;
  console.error(`缺少 ${rel}；下一步：${next}（或按 README 手建）`);
  console.error(`错误码：${code}`);
  process.exit(2);
};
preflightMissing(".sdo/意图.md", `cp ${SKILL_ABS}/templates/意图.md ${path.join(ROOT, ".sdo/意图.md")}`, "SDO_E_MISSING_INTENT");
preflightMissing(".sdo/台账.md", `cp ${SKILL_ABS}/templates/台账.md ${path.join(ROOT, ".sdo/台账.md")}`, "SDO_E_MISSING_LEDGER");
for (const f of BASELINE_FILES) preflightMissing(`.sdo/baseline/${f}`, `cp ${SKILL_ABS}/templates/baseline.md ${path.join(ROOT, ".sdo/baseline/" + f)} 并填齐`, "SDO_E_MISSING_BASELINE");

if (ARGV.includes("--trace") && ARGV.includes("--deep")) {
  console.error("--trace 与 --deep 不能同时使用（--deep 只作用于台账卷校验）");
  process.exit(2);
}
const ERR = [], WARN = [];
const KINDS = new Set(["gap", "defect", "explain", "closed"]);
const STATUS = new Set(["open", "accepted", "fixed", "closed", "superseded"]);
const err = (p, l, m) => ERR.push(`${p}:${l}: ${m}`);
const warn = (p, l, m) => WARN.push(`${p}:${l}: ${m}`);
const SKILL_PREFIX = "skills/sdo-flow/";
function readPath(p) {
  const local = path.join(ROOT, p);
  if (p.startsWith(SKILL_PREFIX)) {
    const bundled = path.join(SKILL_ROOT, p.slice(SKILL_PREFIX.length));
    if (fs.existsSync(bundled)) return bundled;
  }
  return local;
}
const read = (p) => fs.readFileSync(readPath(p), "utf8").split(/\r?\n/);
const exists = (p) => fs.existsSync(readPath(p));

// 找到项目内所有“带 SKILL.md 的 skill 目录”（最多下探 3 层）
function skillDirs() {
  const out = [];
  (function walk(dir, depth) {
    const abs = path.join(ROOT, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) { out.push(dir); return; }
    if (depth >= 3) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (["node_modules", ".git", "lib", "dist", ".tmp", ".work"].includes(e.name)) continue;
      walk(dir ? `${dir}/${e.name}` : e.name, depth + 1);
    }
  })("", 0);
  if (SKILL_REL && !SKILL_REL.startsWith("..") && !out.includes(SKILL_REL)) out.push(SKILL_REL);
  return out;
}

function mdFiles() {
  const out = [];
  const roots = ARGV.includes("--all") ? [""] : [".sdo", ...skillDirs()];
  for (const root of roots) {
    if (root && !exists(root)) continue;
    (function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "lib" || e.name === "dist" || e.name === ".tmp" || e.name === ".work") continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (rel === ".sdo/archive" || rel.startsWith(".sdo/archive/")) continue;
        if (rel === ".sdo/ledger" || rel.startsWith(".sdo/ledger/")) continue;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".md")) out.push(rel);
      }
    })(root);
  }
  return [...new Set(out)];
}

function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = [];
  let cur = "", esc = false, code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "`") {
      // 反引号连写（``` / ``）整体算一个定界符，避免奇数个反引号把后续 | 吞掉
      let j = i;
      while (t[j + 1] === "`") j++;
      cur += t.slice(i, j + 1);
      if (j - i + 1 < 3) code = !code; // 三个及以上是围栏标记，不算行内代码
      i = j;
      continue;
    }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
const isSep = (l) => l !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(l);

function checkTables(p, lines) {
  let tbl = null, fence = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim(), ln = i + 1;
    if (/^(```|~~~)/.test(s)) { fence = !fence; tbl = null; continue; }
    if (fence) continue;
    if (s.startsWith("|")) {
      const n = cells(s).length;
      if (tbl === null) {
        if (!isSep(lines[i + 1])) err(p, ln, "表头下一行不是分隔行（| --- |）");
        tbl = { n, at: ln };
      } else if (n !== tbl.n) {
        err(p, ln, `列数 ${n} ≠ 表头 ${tbl.n}（表从第 ${tbl.at} 行开始）`);
      }
    } else tbl = null;
  }
}

const alias = { id: "id", ID: "id", kind: "kind", 类型: "kind", 位置: "where", 现象: "what", 影响: "why", 处置: "how", 状态: "status", status: "status" };

function checkLedger(p) {
  if (!exists(p)) return err(p, 0, "缺文件");
  const lines = read(p);
  let hdrAt = -1; const cols = {};
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("|") && /id/i.test(s)) {
      const hdr = cells(s);
      if (hdr.length !== 7) return err(p, i + 1, `表头 ${hdr.length} 列，应为 7 列（id/kind/位置/现象/影响/处置/状态）`);
      hdr.forEach((h, idx) => { if (alias[h]) cols[alias[h]] = idx; });
      if (!["id", "kind", "where", "what", "how", "status"].every((k) => k in cols)) {
        return err(p, i + 1, "表头缺列");
      }
      hdrAt = i; break;
    }
  }
  if (hdrAt < 0) return err(p, 0, "找不到台账表头（含 id 的表）");
  const seen = new Set();
  const rows = [];
  const closedBy = new Set();
  let lastId = "";
  for (let i = hdrAt + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const c = cells(lines[i].trim());
    if (c.length !== 7) continue;
    const id = c[cols.id].replace(/`/g, "").trim();
    if (!/^D-\d+$/.test(id)) { err(p, i + 1, `id 不合法：${id}（应为 D-<数字>）`); continue; }
    if (seen.has(id)) err(p, i + 1, `id 重复：${id}`);
    if (lastId && +id.slice(2) <= +lastId.slice(2)) err(p, i + 1, `id 未递增：${id} 在 ${lastId} 之后`);
    lastId = id;
    seen.add(id);
    if (!KINDS.has(c[cols.kind])) err(p, i + 1, `kind 不合法：${c[cols.kind]}`);
    if (!STATUS.has(c[cols.status])) err(p, i + 1, `状态不合法：${c[cols.status]}`);
    const fixText = (c[cols.how] || "").trim();
    const mClose = /^关闭\s+(D-\d+)/.exec(fixText);
    if (mClose || c[cols.kind] === "closed") closedBy.add(mClose ? mClose[1] : c[cols.id]);
    rows.push({ id, kind: c[cols.kind], status: c[cols.status], line: i + 1 });
    if (!c[cols.where]) err(p, i + 1, "位置为空");
  }
  const defectWarns = rows.filter((r) => r.kind === "defect" && r.status === "open" && !closedBy.has(r.id));
  for (const r of defectWarns.slice(0, 10)) warn(p, r.line, `${r.id} 是未修 defect`);
  if (defectWarns.length > 10) warn(p, 0, `另有 ${defectWarns.length - 10} 条未修 defect 警告已折叠（共 ${defectWarns.length} 条）`);
}

function sha256Body(text) {
  const lines = text.split(/\r?\n/);
  const body = /^<!-- sdo-ledger-vol /.test(lines[0] || "") ? lines.slice(1).join("\n") : text;
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}
function volMeta(text) {
  const m = /^<!-- sdo-ledger-vol rows=(\d+) first=(D-\d+|-) last=(D-\d+|-) sha256=([0-9a-f]{64}) -->$/.exec((text.split(/\r?\n/)[0] || "").trim());
  return m ? { rows: Number(m[1]), first: m[2], last: m[3], sha256: m[4] } : null;
}
function volIds(text) {
  const ls = text.split(/\r?\n/);
  const ids = [];
  for (const l of ls) {
    if (!l.trim().startsWith("|")) continue;
    const c = cells(l);
    if (c.length !== 7) continue;
    const id = c[0].replace(/`/g, "").trim();
    if (/^D-\d+$/.test(id)) ids.push(id);
  }
  return ids;
}
function scanVolumeRows(text, file) {
  const ls = text.split("\n");
  let rows = 0, first = "-", last = "-";
  const byId = new Map(), byLine = new Map();
  for (let i = 0; i < ls.length; i++) {
    const c = cells(ls[i]);
    if (c.length !== 7) continue;
    const id = c[0].replace(/`/g, "").trim();
    if (!/^D-\d+$/.test(id)) continue;
    rows++;
    if (first === "-") first = id;
    last = id;
    const hit = { id, kind: c[1], status: c[6], how: c[5], file, line: i + 1 };
    byId.set(id, hit);
    byLine.set(i + 1, hit);
  }
  return { rows, first, last, byId, byLine };
}

function checkLedgerVolumes(deep = false) {
  const idxPath = ".sdo/.index/ledger.json";
  if (!exists(idxPath)) {
    let nonEmpty = false;
    if (exists(".sdo/台账.md")) {
      const ls = read(".sdo/台账.md");
      for (const l of ls) {
        if (!l.trim().startsWith("|")) continue;
        const c = cells(l);
        if (c.length === 7 && /^D-\d+$/.test(c[0].replace(/`/g, "").trim())) { nonEmpty = true; break; }
      }
    }
    if (exists(".sdo/ledger")) {
      try { nonEmpty = nonEmpty || fs.readdirSync(path.join(ROOT, ".sdo/ledger")).some((n) => /^vol-\d+\.md$/.test(n)); } catch { /* ignore */ }
    }
    if (nonEmpty) err(idxPath, 0, "index_stale：索引缺失；下一步：node <skill>/scripts/ledger.mjs reindex");
    return;
  }
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(path.join(ROOT, idxPath), "utf8"));
  } catch (e) {
    return err(idxPath, 0, `索引不是合法 JSON：${e instanceof Error ? e.message : String(e)}；下一步：node <skill>/scripts/ledger.mjs reindex`);
  }
  if (!idx || !Array.isArray(idx.volumes) || !Array.isArray(idx.open)) return err(idxPath, 0, "索引结构不合法（需要 volumes/open）");
  const paths = new Set();
  const scans = new Map();
  let activeMeta = null;
  const allRows = new Map();
  const closedIds = new Set();
  for (const v of idx.volumes) {
    if (!v || typeof v.path !== "string" || !/^\.sdo\/(台账|ledger\/vol-\d+)\.md$/.test(v.path)) { err(idxPath, 0, "索引卷路径不合法"); continue; }
    if (!Number.isInteger(v.openRows) || v.openRows < 0) { err(idxPath, 0, `index_stale：卷 ${v.path} 缺 openRows；下一步：node <skill>/scripts/ledger.mjs reindex`); continue; }
    paths.add(v.path);
    if (!exists(v.path)) { err(v.path, 0, "index_stale：索引中的卷文件不存在；下一步：node <skill>/scripts/ledger.mjs reindex"); continue; }
    const text = fs.readFileSync(path.join(ROOT, v.path), "utf8");
    const meta = volMeta(text);
    if (!meta) { err(v.path, 1, "缺卷元数据注释（<!-- sdo-ledger-vol rows=… first=… last=… sha256=… -->）"); continue; }
    if (v.path === ".sdo/台账.md") activeMeta = meta;
    const shouldScan = deep || v.openRows > 0 || v.path === ".sdo/台账.md";
    if (shouldScan) {
      const scan = scanVolumeRows(text, v.path);
      scans.set(v.path, scan);
      for (const id of scan.byId.keys()) allRows.set(id, scan.byId.get(id));
      for (const hit of scan.byId.values()) {
        const m = /^关闭\s+(D-\d+)/.exec(hit.how); if (m) closedIds.add(m[1]);
        if (deep) {
          if (!KINDS.has(hit.kind)) err(hit.file, hit.line, `kind 不合法：${hit.kind}`);
          if (!STATUS.has(hit.status)) err(hit.file, hit.line, `状态不合法：${hit.status}`);
        }
      }
      for (const k of ["rows", "first", "last"]) {
        if (meta[k] !== scan[k]) err(v.path, 0, `index_stale：卷头 ${k}=${meta[k]} 与正文 ${scan[k]} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
        if (v[k] !== meta[k]) err(v.path, 0, `index_stale：索引 ${k}=${v[k]} 与卷头 ${meta[k]} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
      }
    } else {
      for (const k of ["rows", "first", "last"]) {
        if (v[k] !== meta[k]) err(v.path, 0, `index_stale：索引 ${k}=${v[k]} 与卷头 ${meta[k]} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
      }
    }
    const sha = sha256Body(text);
    if (v.sha256 !== meta.sha256) err(v.path, 0, `index_stale：索引 sha256=${v.sha256} 与卷头 ${meta.sha256} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
    if (v.sha256 !== sha) err(v.path, 0, `index_stale：卷头 sha256=${meta.sha256} 与实际 ${sha} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
  }
  if (!paths.has(".sdo/台账.md")) err(idxPath, 0, "index_stale：索引缺活跃卷 .sdo/台账.md；下一步：node <skill>/scripts/ledger.mjs reindex");
  if (activeMeta && activeMeta.rows > 5000) warn(".sdo/台账.md", 0, `活跃卷过大（rows=${activeMeta.rows}），建议 rotate（大卷会让 add/view 变慢）`);
  const sumOpen = idx.volumes.reduce((acc, v) => acc + (Number.isInteger(v.openRows) ? v.openRows : 0), 0);
  if (sumOpen !== idx.open.length) err(idxPath, 0, `index_stale：各卷 openRows 之和=${sumOpen} 与索引 open 条目数=${idx.open.length} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
  const openIds = new Set();
  for (const o of idx.open) {
    if (!o || !/^D-\d+$/.test(o.id) || !["defect", "gap", "explain"].includes(o.kind) || typeof o.file !== "string" || !Number.isInteger(o.line)) { err(idxPath, 0, "索引 open 条目结构不合法"); continue; }
    if (!paths.has(o.file)) { err(idxPath, 0, `index_stale：open 条目 ${o.id} 指向未登记卷 ${o.file}`); continue; }
    if (openIds.has(o.id)) err(idxPath, 0, `索引 open 条目重复：${o.id}`);
    openIds.add(o.id);
    const hit = allRows.get(o.id);
    if (!hit) { err(idxPath, 0, `index_stale：open 条目 ${o.id} 所在卷未标记 openRows 或卷内无此 id；下一步：node <skill>/scripts/ledger.mjs reindex`); continue; }
    if (hit.file !== o.file || hit.line !== o.line) err(idxPath, 0, `index_stale：open 条目 ${o.id} 位置 ${o.file}:${o.line} 与正文 ${hit.file}:${hit.line} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
    if (hit.kind !== o.kind) err(idxPath, 0, `index_stale：open 条目 ${o.id} kind=${o.kind} 与正文 ${hit.kind} 不符；下一步：node <skill>/scripts/ledger.mjs reindex`);
    if (!["open", "accepted"].includes(hit.status) || closedIds.has(o.id)) err(idxPath, 0, `index_stale：open 条目 ${o.id} 正文状态=${hit.status} 不是未修；下一步：node <skill>/scripts/ledger.mjs reindex`);
  }
  for (const hit of allRows.values()) {
    if (["defect", "gap"].includes(hit.kind) && ["open", "accepted"].includes(hit.status) && !closedIds.has(hit.id) && !openIds.has(hit.id)) {
      err(idxPath, 0, `index_stale：正文未修行 ${hit.id} 不在索引 open；下一步：node <skill>/scripts/ledger.mjs reindex`);
    }
  }
}

function checkSigns() {
  const d = ".sdo/sign";
  const doneCard0 = exists(".sdo/cards") && fs.readdirSync(path.join(ROOT, ".sdo/cards")).filter((f) => f.endsWith(".md"))
    .some((f) => /^status:\s*(done|in_progress)\b/m.test(fs.readFileSync(path.join(ROOT, ".sdo/cards", f), "utf8")));
  const hasReadings0 = exists(".sdo/readings") && fs.readdirSync(path.join(ROOT, ".sdo/readings")).some((f) => f.endsWith(".md"));
  if (!exists(d)) return (doneCard0 || hasReadings0) ? err(d, 0, "缺签字目录") : warn(d, 0, "缺 .sdo/sign/（初始化期可接受：签 S1 前建）");
  const files = fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) {
    const doneCard = exists(".sdo/cards") && fs.readdirSync(path.join(ROOT, ".sdo/cards")).filter((f) => f.endsWith(".md"))
      .some((f) => /^status:\s*done/m.test(fs.readFileSync(path.join(ROOT, ".sdo/cards", f), "utf8")));
    const hasReadings = exists(".sdo/readings") && fs.readdirSync(path.join(ROOT, ".sdo/readings")).some((f) => f.endsWith(".md"));
    if (doneCard || hasReadings) err(d, 0, "没有签字文件（已有 done 卡/读数，不能没有生效签字）");
    else warn(d, 0, "还没有签字文件（初始化期可接受：写完意图后请人签 S1，再写计划）");
  }
  let effective = 0;
  for (const f of files) {
    if (!SIGN_FILE_RE.test(f)) err(`${d}/${f}`, 0, "签字文件名必须是 S<编号>.md 或追加签 S<编号>-<A…Z>.md");
    const p = `${d}/${f}`, text = read(p).join("\n");
    for (const k of ["时间", "选项", "被签对象"]) {
      if (!new RegExp(`^\\s*-?\\s*${k}[:：]\\s*\\S`, "m").test(text)) err(p, 0, `缺字段或值为空：${k}（应写成「- ${k}：…」）`);
    }
    const tm = text.match(/^\s*-?\s*时间[:：]\s*([^\n]*)$/m);
    const bm = text.match(/^\s*-?\s*被签对象[:：]\s*([^\n]*)$/m);
    if (tm && /[<>]/.test(tm[1])) err(p, 0, "时间还是模板占位（<…>）：必须填真实时刻（ISO8601 带时区）");
    if (bm && /[<>]/.test(bm[1])) err(p, 0, "被签对象还是模板占位（<…>）：必须填真实 commit / 文件哈希");
    const om = text.match(/选项[:：]\s*([^\n]*)/);
    const opt = om ? om[1] : "";
    if (/[<>]/.test(opt)) err(p, 0, "选项还是模板占位（<…>）：必须填真人回答的三选一");
    else if (!/^\s*(?:[-*]\s*)?[*_`]*\s*(签|改|不签)[：:]/.test(opt)) err(p, 0, "选项必须以「签：/改：/不签：」开头（不允许“未签/待签/代签”）");
    if (/^\s*(?:[-*]\s*)?[*_`]*\s*不签[：:]/.test(opt)) continue; // 「不签」不是生效签字，不计入
    effective++;
    if (!/^\s*-?\s*方式[^：:\n]{0,24}[:：]\s*\S/m.test(text)) warn(p, 0, "建议写明方式（本人 / 代笔（须写确认方式））");
  }
  if (files.length && effective === 0) err(d, 0, "没有生效签字（只有「不签」或占位）");
}

function evidenceTableInfo(lines) {
  const at = lines.findIndex((l) => /^##\s*证据(?:\s|$)/.test(l.trim()));
  if (at < 0) return null;
  let head = -1;
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const s = lines[i].trim();
    if (s.startsWith("|") && !isSep(s)) { head = i; break; }
  }
  if (head < 0) return null;
  const header = cells(lines[head]).map((x) => x.replace(/`/g, "").trim());
  const rows = [];
  for (let i = head + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const s = lines[i].trim();
    if (!s.startsWith("|")) continue;
    if (isSep(s)) continue;
    rows.push({ line: i + 1, raw: s, cells: cells(s) });
  }
  return { line: head + 1, header, rows };
}

function mutationTableInfo(lines) {
  const at = lines.findIndex((l) => /^##\s*变异(?:\s|$)/.test(l.trim()));
  if (at < 0) return null;
  let head = -1;
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const s = lines[i].trim();
    if (s.startsWith("|") && !isSep(s)) { head = i; break; }
  }
  if (head < 0) return { line: at + 1, header: [], rows: [] };
  const header = cells(lines[head]).map((x) => x.replace(/`/g, "").trim());
  const rows = [];
  for (let i = head + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const s = lines[i].trim();
    if (!s.startsWith("|") || isSep(s)) continue;
    rows.push({ line: i + 1, cells: cells(s) });
  }
  return { line: head + 1, header, rows };
}

function mutationEnforced(cardId, planSets) {
  // 只认计划真源与声明：M1–M4 卡表、变异校验基线声明除外；其余（含表外卡、M5+）一律强制。
  if (!planSets.ok) return true;
  if (planSets.legacy.has(cardId) || planSets.m4.has(cardId)) return false;
  if (planSets.mutationBaseline.has(cardId)) return false;
  return true;
}

function substantiveReason(text) {
  const t = text.replace(/[。.，,；;：:、\s]/g, "");
  if (t.length < 8) return false;
  return !/(这个不好|差不多|没必要|不重要|看情况)/.test(t) && !/^(同意|认可|可以|无|行|ok)$/i.test(t);
}

function archivedCardIds() {
  const out = new Set();
  for (const r of archiveRows(ROOT)) {
    if (r.status !== "已归档") continue;
    for (const key of Object.keys(r.manifest)) {
      const m = /^cards\/(M\d+-(?:\d+|G))\.md$/.exec(key);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

function archiveFileCount(milestone) {
  const dir = path.join(ROOT, `.sdo/archive/${milestone}`);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

function checkArchive() {
  for (const i of assertArchivedIntegrity(ROOT)) err(i.path, i.line, i.msg);
}

function planIndexMilestones() {
  const p = ".sdo/计划.md";
  if (!exists(p)) return [];
  const out = [];
  let inTable = false, mCol = -1;
  for (const line of read(p)) {
    const raw = line.trim();
    if (!raw.startsWith("|")) { inTable = false; mCol = -1; continue; }
    const cs = cells(raw);
    if (!inTable) {
      mCol = cs.findIndex((x) => x.replace(/`/g, "").trim() === "里程碑");
      if (mCol >= 0) inTable = true;
      continue;
    }
    if (isSep(raw)) continue;
    const id = (cs[mCol] || "").replace(/`/g, "").trim();
    if (/^M\d+$/.test(id)) out.push(id);
  }
  return out;
}

function planCardSets() {
  const legacy = new Set(), m4 = new Set(), baseline = new Set(), strict = new Set(), all = new Set();
  const mutationBaseline = new Set();
  const mileFiles = fs.existsSync(path.join(ROOT, MILESTONE_DIR))
    ? fs.readdirSync(path.join(ROOT, MILESTONE_DIR)).filter((f) => /^M\d+\.md$/.test(f)).sort()
    : [];
  const planIdx = planIndexMilestones();
  const mileSet = new Set(mileFiles.map((f) => f.replace(/\.md$/, "")));
  for (const id of planIdx) {
    if (!mileSet.has(id) && !archiveEntry(ROOT, id)) {
      err(MILESTONE_DIR, 0, `计划索引有 ${id} 但 .sdo/milestones/${id}.md 不存在（milestone_file_missing）`);
    }
  }
  if (!mileFiles.length) {
    // 索引为空且目录为空：新项目合法空状态；索引有行但文件缺失已在上面报 milestone_file_missing。
    const hasDir = fs.existsSync(path.join(ROOT, MILESTONE_DIR));
    return { legacy, m4, baseline, strict, mutationBaseline, all, ok: hasDir };
  }
  const lines = mileFiles.flatMap((f) => read(`${MILESTONE_DIR}/${f}`));
  let section = 1, col = -1;
  const seen = { 1: false, 2: false, 3: false, 4: false, 5: false };
  const baselineDecl = [], mutationDecl = [];
  let sawAny = false;
  for (const line of lines) {
    const h = line.match(/^##\s*M(\d+)/);
    if (h) { section = Number(h[1]); col = -1; continue; }
    if (section === 5 && line.includes("证据格式基线卡")) {
      const half = line.lastIndexOf(":"), full = line.lastIndexOf("：");
      const at = Math.max(half, full);
      const tail = at >= 0 ? line.slice(at + 1) : "";
      for (const m of tail.matchAll(/M\d+-(?:\d+|G)/g)) baselineDecl.push(m[0]);
    }
    if (section === 5 && line.includes("变异校验基线卡")) {
      const half = line.lastIndexOf(":"), full = line.lastIndexOf("：");
      const at = Math.max(half, full);
      const tail = at >= 0 ? line.slice(at + 1) : "";
      for (const m of tail.matchAll(/M\d+-(?:\d+|G)/g)) mutationDecl.push(m[0]);
    }
    if (section < 1) continue;
    const raw = line.trim();
    if (!raw.startsWith("|")) { col = -1; continue; }
    const cs = cells(raw);
    if (col < 0) {
      col = cs.findIndex((x) => x.replace(/`/g, "").trim() === "卡");
      continue;
    }
    if (isSep(raw)) continue;
    const id = (cs[col] || "").replace(/`/g, "").trim();
    if (!/^M\d+-(?:\d+|G)$/.test(id)) continue;
    all.add(id);
    sawAny = true;
    seen[section] = true;
    if (section <= 3) legacy.add(id);
    else if (section === 4) { baseline.add(id); m4.add(id); }
    else strict.add(id);
  }
  for (const id of baselineDecl) {
    if (!exists(`.sdo/cards/${id}.md`)) { warn(".sdo/milestones", 0, `证据格式基线卡声明无效（无对应卡文件）：${id}`); continue; }
    baseline.add(id); all.add(id);
  }
  for (const id of mutationDecl) {
    const cardRel = `.sdo/cards/${id}.md`;
    if (!exists(cardRel)) { warn(".sdo/milestones", 0, `变异校验基线卡声明无效（无对应卡文件）：${id}`); continue; }
    const cardText = read(cardRel).join("\n");
    if (!/^status:\s*done\b/m.test(cardText)) { warn(".sdo/milestones", 0, `变异校验基线卡声明无效（卡未 done）：${id}`); continue; }
    const signed = signedCardIds(path.join(ROOT, ".sdo/sign")).has(id);
    if (!signed) { warn(".sdo/milestones", 0, `变异校验基线卡声明无效（无签字文件引用该卡）：${id}`); continue; }
    mutationBaseline.add(id); all.add(id);
  }
  return { legacy, m4, baseline, strict, mutationBaseline, all, ok: sawAny };
}


const CRITERION_TYPES = new Set(["结构", "语义", "边界"]);
function semanticBaselineCards() {
  const set = new Set();
  const p = ".sdo/milestones/M6.md";
  if (!exists(p)) return set;
  const lines = read(p);
  const heads = lines.map((l, i) => ({ l, i })).filter((x) => /^#{2,3}\s+.*冻结段/.test(x.l));
  if (heads.length !== 1) {
    err(p, heads.length ? heads[1].i + 1 : 1, `冻结段小节须唯一（标题含“冻结段”，当前 ${heads.length} 处）`);
    return set;
  }
  const sec = sectionOf(lines, /^#{2,3}\s+.*冻结段/);
  if (!sec) return set;
  for (let i = sec.start; i < sec.end; i++) {
    if (!/^- 语义判据基线卡(（[^）]*）)?：/.test(lines[i])) continue;
    const part = lines[i].slice(lines[i].lastIndexOf("：") + 1);
    for (const m of part.matchAll(/M\d+-(?:\d+|G)/g)) set.add(m[0]);
  }
  return set;
}
function criterionTable(lines, p) {
  const a = lines.findIndex((l) => /^##\s*判据(?:\s|$)/.test(l.trim()));
  if (a < 0) return null;
  let b = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
  if (b < 0) b = lines.length;
  const cand = [];
  for (let i = a + 1; i < b; i++) {
    if (!/^\|/.test(lines[i])) continue;
    const first = (cells(lines[i])[0] || "").replace(/`/g, "").trim();
    if (first === "编号") cand.push(i);
  }
  if (cand.length > 1) { err(p, cand[1] + 1, `判据表重复（段内出现 ${cand.length} 个表头，只允许一个）`); return null; }
  const h = cand.length ? cand[0] : -1;
  if (h < 0) return null;
  const header = cells(lines[h]);
  if (header.join("|") !== "编号|判据|类型|反例") {
    err(p, h + 1, `判据表表头须为 | 编号 | 判据 | 类型 | 反例 |（当前：${header.join(" | ")}）`);
    return null;
  }
  if (!/^\|\s*:?-{2,}/.test((lines[h + 1] || "").trim())) { err(p, h + 2, "判据表缺分隔行（| --- |）"); return null; }
  const rows = [];
  for (let i = h + 2; i < b && /^\|/.test(lines[i]); i++) {
    if (cells(lines[i]).length !== header.length) err(p, i + 1, `判据表列数 ${cells(lines[i]).length} ≠ 表头 ${header.length}`);
    rows.push({ line: i + 1, cells: cells(lines[i]) });
  }
  return { line: h + 1, header, rows };
}
function checkCriterionScripts(cardId, p, lines) {
  for (const name of ["判据", "证据"]) {
    const sec = sectionOf(lines, new RegExp(`^##\\s*${name}\\s*$`));
    if (!sec) continue;
    for (let i = sec.start; i < sec.end; i++) {
      for (const span of lines[i].matchAll(/`([^`]+)`/g)) {
        for (const m of span[1].matchAll(/(?:^|[\s"'`])((?:\.{0,2}\/|\/|[A-Za-z0-9_.-]+\/)*scripts\/[A-Za-z0-9_./-]+\.mjs)/g)) {
          const raw = m[1];
          if (/[<>]/.test(raw)) continue; // 模板占位 <skill>/...
          const rel = raw.replace(/^["'`]+|["'`]+$/g, "").replace(/^\.\//, "");
          const abs = path.isAbsolute(rel) ? rel : readPath(rel);
          if (!fs.existsSync(abs)) err(p, i + 1, `判据点名的脚本不存在（卡 ${cardId}）：${rel}`);
        }
      }
    }
  }
}

function checkSemanticCriteria(cardId, p, lines, done, semBase) {
  if (semBase.has(cardId)) return;
  const t = criterionTable(lines, p);
  if (!t) { err(p, 1, "缺判据表（编号/判据/类型/反例）"); return; }
  const ti = t.header.indexOf("类型");
  if (ti < 0) { err(p, t.line, "判据表缺「类型」列（结构/语义/边界）"); return; }
  for (const r of t.rows) {
    const id = (r.cells[0] || "").replace(/`/g, "").trim();
    const v = (r.cells[ti] || "").trim();
    if (!CRITERION_TYPES.has(v)) err(p, r.line, `判据类型非法：${v || "（空）"}（只允许 结构/语义/边界）：${id}`);
  }
  if (!done) return;
  const semantic = t.rows.some((r) => (r.cells[ti] || "").trim() === "语义");
  // 「语义：不适用」只认「判据」或「判定」段内、唯一的行；写在意图/证据注里不算
  const secRange = (name) => {
    const a0 = lines.findIndex((l) => new RegExp("^##\\s*" + name + "(?:\\s|$)").test(l.trim()));
    if (a0 < 0) return null;
    let b0 = lines.findIndex((l, i) => i > a0 && /^##\s/.test(l.trim()));
    if (b0 < 0) b0 = lines.length;
    return [a0, b0];
  };
  const ranges = [secRange("判据"), secRange("判定")].filter(Boolean);
  const naHits = [];
  for (const [a0, b0] of ranges) {
    for (let i = a0; i < b0; i++) if (/^语义：不适用[（(].+[）)]\s*$/.test((lines[i] || "").trim())) naHits.push(i);
  }
  if (naHits.length > 1) err(p, naHits[1] + 1, `「语义：不适用」只能出现一次（当前 ${naHits.length} 次）`);
  const naLine = naHits.length ? naHits[0] : -1;
  if (!semantic && naLine < 0) {
    err(p, 1, `status: done 但没有任何「语义」判据（也没有 语义：不适用（理由））：${cardId}`);
    return;
  }
  if (!semantic && naLine >= 0) {
    const reason = lines[naLine].trim().replace(/^语义：不适用[（(]/, "").replace(/[）)]$/, "").trim();
    if (meaningfulLen(reason) < 8 || PRESET_BLACKLIST.has(reason)) {
      err(p, naLine + 1, `语义不适用理由过短或为套话：${reason || "（空）"}`);
      return;
    }
  }
  if (semantic) {
    const a = lines.findIndex((l) => /^##\s*评审(?:\s|$)/.test(l.trim()));
    let b = lines.length;
    if (a >= 0) { const n = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim())); if (n >= 0) b = n; }
    let inComment = false;
    const hits = [];
    for (let i = a + 1; i < b; i++) {
      let l = (lines[i] || "").trim();
      if (inComment) { if (l.includes("-->")) inComment = false; continue; }
      if (l.startsWith("<!--")) { if (!l.includes("-->")) inComment = true; continue; }
      l = l.replace(/<!--.*?-->/g, "").trim();
      if (/^-\s*语义自检：/.test(l)) hits.push({ i, body: l.replace(/^-\s*语义自检：/, "").trim() });
    }
    if (!hits.length) { err(p, a >= 0 ? a + 1 : 1, `status: done 且有语义判据，但评审段缺「- 语义自检：」：${cardId}`); return; }
    for (const h of hits) {
      if (!/C\d+/.test(h.body)) err(p, h.i + 1, `语义自检须点名被复跑的判据号（C<n>）：${cardId}`);
      else if (meaningfulLen(h.body) < 8 || PRESET_BLACKLIST.has(h.body)) err(p, h.i + 1, `语义自检内容过短或为套话：${cardId}`);
    }
  }
}

// M9-4 C1：活跃卡 open 而所属里程碑已门签/已收口 ⇒ card_state_mismatch。
// 只扫 .sdo/cards/（归档卡已搬走，不回溯——M9 边界 5）；门卡（*-G）由门签本身证明收口，不参与。
// P3 口径（二选一取“卡面写边界”）：所有 *-G 门卡都不要求在 cards/ 里保持 active；M5-G 是历史先例
// （M5 收口时按设计留 open 以免触发变异回溯，随 M5 归档视为关闭，见 D-171），不单独收窄到 M5-G。
function checkCardStateMismatch() {
  const d = ".sdo/cards";
  if (!exists(d)) return;
  const gates = gateSignInfo(path.join(ROOT, ".sdo/sign"));
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const id = f.replace(/\.md$/, "");
    if (/-G$/.test(id)) continue;
    const p = `${d}/${f}`;
    const lines = read(p);
    const text = lines.join("\n");
    const sm = /^status:\s*(\w+)/m.exec(text);
    if (!sm || sm[1] !== "open") continue;
    const mm = /^(M\d+)-/.exec(id);
    if (!mm) continue;
    const mid = mm[1];
    const planStatus = planIndexStatus(ROOT, mid);
    const closed = gates.has(`${mid}-G`) || /已收口|已归档/.test(planStatus);
    if (!closed) continue;
    const line = lines.findIndex((l) => /^status:/.test(l)) + 1;
    err(p, line || 1, `card_state_mismatch：${id} 仍是 status: open，但 ${mid} 已门签/已收口（计划状态=${planStatus || "-"}；归档卡不回溯，见 M9 边界 5）`);
  }
}

function gitKnownCommit(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch { return false; }
}

// 从「被签对象」行提取 commit 声明：裸 hex（S34-A 那种整行只有 hash）或 commit <hex>。
// 文件哈希（sha256 `…`）不算 commit 声明。
function commitClaims(value) {
  const out = new Set();
  const bare = /^`?([0-9a-f]{7,40})`?(?=$|[\s（(])/i.exec(value);
  if (bare) out.add(bare[1]);
  for (const m of value.matchAll(/commit\s*`?([0-9a-f]{7,40})`?/gi)) out.add(m[1]);
  return [...out];
}

// P2-1：无冻结段 hash 的旧式追加签不静默跳过——必须在 M9.md 冻结段的「旧式签白名单」里显式登记；
// 该行是冻结段正文的一部分（参与 frozenHashRaw），增删条目即改 hash、须人签追加签，不能自授权。
function legacySignWhitelist() {
  // 先活跃、后归档：冻结段白名单可能随里程碑正文被归档搬走。
  // 检查器必须跟着走，否则归档会把旧式签变成假红（M10-0，D-192）。
  let p = path.join(ROOT, ".sdo/milestones/M9.md");
  if (!fs.existsSync(p)) p = path.join(ROOT, ".sdo/archive/M9/milestone.md");
  if (!fs.existsSync(p)) return new Set();
  const m = /^-\s*旧式签白名单.*$/m.exec(fs.readFileSync(p, "utf8"));
  return new Set(m ? (m[0].match(/S\d+-[A-Z]/g) || []) : []);
}

// M9-4 C2：追加签双锚点（旧/新 hash 都要对得上）+ 被签对象 commit 必须已知。
function checkAppendSignAnchors() {
  const sd = ".sdo/sign";
  if (!exists(sd)) return;
  for (const f of fs.readdirSync(path.join(ROOT, sd)).filter((x) => /^S\d+-[A-Z]\.md$/.test(x)).sort()) {
    const p = `${sd}/${f}`;
    const ls = read(p);
    const i = ls.findIndex((l) => /^-\s*被签对象[:：]/.test(l));
    if (i < 0) continue;
    const value = ls[i].replace(/^-\s*被签对象[:：]\s*/, "").trim();
    for (const sha of commitClaims(value)) {
      if (!gitKnownCommit(sha)) err(p, i + 1, `signed_tree_unknown：被签对象声明的 commit ${sha} 不是本仓库的已知 commit（无法证明“签的就是当前树”）`);
    }
  }
  // P2-1：枚举缺冻结段 hash 的旧式追加签；未登记白名单 ⇒ 报错（不再静默 continue）。
  const whitelist = legacySignWhitelist();
  for (const f of fs.readdirSync(path.join(ROOT, sd)).filter((x) => /^S\d+-[A-Z]\.md$/.test(x)).sort()) {
    const ls = read(`${sd}/${f}`);
    const text = ls.join("\n");
    const hasHashLine = ls.some((l) => /^-\s*冻结段 hash[:：]/.test(l)) || /冻结段 hash\s*`?[0-9a-f]{64}`?/.test(text);
    if (hasHashLine) continue;
    const id = f.replace(/\.md$/, "");
    if (whitelist.has(id)) continue;
    err(`${sd}/${f}`, 1, `signed_anchor_mismatch：旧式追加签 ${id} 缺冻结段 hash 且未登记白名单（.sdo/milestones/M9.md 冻结段「旧式签白名单」，该行参与 hash，增删须追加签）`);
  }
  const md = path.join(ROOT, ".sdo/milestones");
  if (!fs.existsSync(md)) return;
  for (const f of fs.readdirSync(md).filter((x) => /^M\d+\.md$/.test(x)).sort()) {
    const mid = f.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(md, f), "utf8");
    const actual = frozenHashRaw(raw);
    const planFile = planSignFile(mid);
    let prev = "";
    if (planFile) {
      const hm = read(path.join(sd, planFile)).join("\n").match(/^-\s*冻结段 hash[:：]\s*`?([0-9a-f]{64})`?/m);
      if (hm) prev = hm[1];
    }
    const appendEntries = [];
    for (const [idx, l] of raw.split(/\r?\n/).entries()) {
      const am = /^- 追加签：S(\d+)-([A-Z])\s*$/.exec(l);
      if (am) appendEntries.push({ idx, num: Number(am[1]), letter: am[2], sf: `S${am[1]}-${am[2]}.md` });
    }
    // P2-2：链按签号数值+字母排序（S42-A → S42-B → …），不依赖冻结段里行的书写顺序。
    appendEntries.sort((a, b) => (a.num - b.num) || a.letter.localeCompare(b.letter));
    for (const { idx, sf } of appendEntries) {
      const sp = `${sd}/${sf}`;
      if (!exists(sp)) { err(`.sdo/milestones/${f}`, idx + 1, `追加签文件缺失：${sp}`); continue; }
      const sl = read(sp);
      const ni = sl.findIndex((x) => /^-\s*冻结段 hash[:：]/.test(x));
      const embedded = (sl.find((x) => /^-\s*被签对象[:：]/.test(x)) || "").match(/冻结段 hash\s*`?([0-9a-f]{64})`?/);
      const newHash = (ni >= 0 ? ((/^-\s*冻结段 hash[:：]\s*`?([0-9a-f]{64})`?/.exec(sl[ni]) || [])[1] || "") : (embedded ? embedded[1] : ""));
      if (!newHash) continue; // 旧式追加签（只记被签对象，不记冻结 hash）：保留兼容，不参与双锚点
      const oi = sl.findIndex((x) => /^-\s*(?:上一版|前序) hash[:：]/.test(x));
      const oldHash = oi < 0 ? "" : ((/`?([0-9a-f]{8,64})`?/.exec(sl[oi].replace(/^-\s*(?:上一版|前序) hash[:：]\s*/, "")) || [])[1] || "");
      if (!oldHash) { err(sp, oi < 0 ? 1 : oi + 1, `signed_anchor_mismatch：追加签 ${sf} 只有新 hash，缺「上一版 hash：」（双锚点：旧/新都必须记）`); continue; }
      if (prev && !prev.startsWith(oldHash) && !oldHash.startsWith(prev)) err(sp, oi + 1, `signed_anchor_mismatch：旧 hash ${oldHash.slice(0, 8)} 与链条上一版 ${prev.slice(0, 8)} 不符（${mid}）`);
      prev = newHash;
    }
    if (prev && prev !== actual) err(`.sdo/milestones/${f}`, 0, `signed_anchor_mismatch：最新追加签新 hash=${prev.slice(0, 8)}… 与文件实算=${actual.slice(0, 8)}… 不符（${mid}）`);
  }
}

function checkCards() {
  const d = ".sdo/cards";
  const planSets = planCardSets();
  const semBase = semanticBaselineCards();
  if (!planSets.ok) warn(".sdo/milestones", 0, "计划卡表解析失败，按严格口径检查");
  if (!exists(d)) return warn(d, 0, "还没有卡（里程碑早期可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, lines = read(p), text = lines.join("\n");
    for (const s of ["判据", "证据", "判定", "评审"]) if (!new RegExp("^##\\s*" + s + "(?:\\s|$)", "m").test(text)) err(p, 0, `缺段落：## ${s}`);
    const sm = text.match(/^status:\s*(open|in_progress|done)/m);
    if (!sm) err(p, 0, "缺 status: open|in_progress|done");
    const cardId = f.replace(/\.md$/, "");
    checkSemanticCriteria(cardId, p, lines, !!(sm && sm[1] === "done"), semBase);
    let legacy = false, baseline = false, strictResult = true;
    if (planSets.ok) {
      if (planSets.legacy.has(cardId)) { legacy = true; strictResult = false; }
      else if (planSets.baseline.has(cardId)) { baseline = true; strictResult = false; }
    }
    if (sm && sm[1] === "done") {
      checkCriterionScripts(cardId, p, lines);
      const gateSigned = gateSignInfo(path.join(ROOT, ".sdo/sign")).get(cardId);
      if (/^M\d+-G$/.test(cardId) && !signedCardIds(path.join(ROOT, ".sdo/sign")).has(cardId) && !gateSigned) {
        err(p, 1, `status: done 但未签收（门卡须有 M 门签或卡号签收）：${cardId}`);
      }
      const ev = evidenceTableInfo(lines);
      if (!ev) warn(p, 0, "status: done 但证据表没有数据行");
      if (ev) {
        const hasVerdictCol = ev.header.includes("判定");
        if (strictResult && hasVerdictCol) {
          const resultCol = ev.header.includes("输出摘要") ? ev.header.indexOf("输出摘要")
            : ev.header.includes("命令与输出") ? ev.header.indexOf("命令与输出") : -1;
          if (resultCol >= 0) {
            for (const r of ev.rows) {
              const id = (r.cells[ev.header.indexOf("判据")] || "").replace(/`/g, "").trim();
              if (!id) continue;
              const value = (r.cells[resultCol] || "").trim();
              if (!/^exit=\d+(?:;|$)/.test(value) && !/^未跑待复跑(?:；|$)/.test(value)) {
                err(p, r.line, `证据结果列不是脚本形态（需 exit=<code> 或「未跑待复跑」）：${id}`);
              }
            }
          }
        }
        if (!legacy && !hasVerdictCol) {
          err(p, ev.line, "证据表缺判定列（应为 | 判据 | 命令与输出 | 判定 |）");
        }
        const colCmd = ev.header.findIndex((h) => h.includes("命令"));
        const colVerdict = ev.header.indexOf("判定");
        if (!legacy && hasVerdictCol) {
          for (const r of ev.rows) {
            const rawId = (r.cells[0] || "").trim();
            const id = rawId.replace(/`/g, "");
            const cmd = (r.cells[colCmd] || "").trim();
            const verdict = (r.cells[colVerdict] || "").trim();
            if (!cmd && !verdict) { err(p, r.line, `证据行为空：${id || "（无判据号）"}`); continue; }
            if (!baseline && cmd && /^(?:pass|partial|fail|未判)$/.test(cmd)) err(p, r.line, `证据行只写判定，没有命令与输出：${id}`);
            if (verdict && !/^(?:pass|partial|fail|未判)$/.test(verdict)) err(p, r.line, `判定值非法：${verdict}（只允许 pass/partial/fail/未判）：${id}`);
            else if (!verdict) err(p, r.line, `证据行缺判定（pass/partial/fail/未判）：${id}`);
          }
        }
      }
      // done 卡：判据段点名的每条 Cx，都要在证据表里有一行非空命令/文件:行
      const critSec = (() => {
        const a = lines.findIndex((l) => /^##\s*判据(?:\s|$)/.test(l.trim()));
        if (a < 0) return "";
        const b = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
        return lines.slice(a + 1, b < 0 ? undefined : b).join("\n");
      })();
      const critIds = [];
      for (const m of critSec.matchAll(/\b(C\d+)\s*[–—~-]\s*C?(\d+)\b/g)) {
        for (let n = +m[1].slice(1); n <= +m[2]; n++) critIds.push(`C${n}`);
      }
      for (const m of critSec.matchAll(/\bC(\d+)\b/g)) critIds.push(`C${m[1]}`);
      const critSet = [...new Set(critIds)];
      if (critIds.length && ev) {
        const colCmd = ev.header.findIndex((h) => h.includes("命令"));
        const filled = new Set();
        for (const r of ev.rows) {
          const rawId = (r.cells[0] || "").replace(/`/g, "").trim();
          const id = /^\d+$/.test(rawId) ? (r.cells[1] || "").replace(/`/g, "").trim() : rawId;
          const cmd = colCmd >= 0 ? (r.cells[colCmd] || "").trim() : r.cells.slice(1).map((x) => x.trim()).filter(Boolean).join(" ");
          const rowIds = new Set();
          for (const m of id.matchAll(/C(\d+)\s*[–—~-]\s*C?(\d+)/g)) for (let n = +m[1]; n <= +m[2]; n++) rowIds.add(`C${n}`);
          for (const m of id.matchAll(/C(\d+)/g)) rowIds.add(`C${m[1]}`);
          if (cmd && !/^[—–-]$/.test(cmd)) for (const x of rowIds) if (critSet.includes(x)) filled.add(x);
        }
        const missing = critSet.filter((id) => !filled.has(id));
        if (missing.length) err(p, 0, `status: done 但判据没有可复跑证据：${missing.join("、")}（证据表每行须写命令或 文件:行）`);
      }
      const rel = lines.findIndex((l) => /^##\s*评审(?:\s|$)/.test(l.trim()));
      const relText = rel >= 0 ? lines.slice(rel, rel + 20).join("\n") : "";
      if (!/评审者[:：]/.test(relText)) err(p, 0, "done 卡评审段缺「评审者」（须写明独立性；无第二席位时写「自审（非独立）」）");
      if (mutationEnforced(cardId, planSets) && critSet.length) {
        const mt = mutationTableInfo(lines);
        if (!mt) {
          for (const id of critSet) err(p, 0, `done 卡缺变异证据：${id}（补「## 变异」行，或「不可变异：理由」+评审确认）`);
        } else {
          const need = ["判据", "变异动作", "应红命令", "结果"];
          const lost = need.filter((h) => !mt.header.includes(h));
          if (lost.length) err(p, mt.line, `变异表表头缺字段：${lost.join("、")}（应为 | 判据 | 变异动作 | 应红命令 | 结果 |）`);
          for (const id of critSet) {
            const row = mt.rows.find((r) => (r.cells[0] || "").replace(/`/g, "").trim() === id);
            if (!row) { err(p, 0, `判据缺变异证据：${id}（补 mutation 行，或「不可变异：理由」+评审确认）`); continue; }
            const action = (row.cells[1] || "").trim();
            const expectCmd = (row.cells[2] || "").trim();
            const result = (row.cells[3] || "").trim();
            if (!action) err(p, row.line, `变异行缺「变异动作」：${id}`);
            if (!expectCmd) err(p, row.line, `变异行缺「应红命令」：${id}`);
            if (/^不可变异\s*[：:]/.test(action)) {
              const reason = action.replace(/^不可变异\s*[：:]\s*/, "").trim();
              if (!substantiveReason(reason)) err(p, row.line, `不可变异缺具体理由：${id}`);
              const cm = new RegExp(`不可变异确认\\s*${id}\\s*[：:]\\s*(.+)`).exec(relText);
              if (!cm) err(p, row.line, `不可变异缺评审确认：${id}（评审段须写「不可变异确认 ${id}：理由」）`);
              else if (!substantiveReason(cm[1].split("\n")[0])) err(p, row.line, `不可变异评审确认理由不足：${id}`);
            } else if (!/expected=red/.test(result) || !/actual=red/.test(result)) {
              err(p, row.line, `变异证据不足：${id}（结果列须含 expected=red actual=red）`);
            }
          }
        }
      }
    }
  }
}

const VERDICT = /\b(pass|partial|fail)\b/i;
function checkReadings() {
  const d = ".sdo/readings";
  if (!exists(d)) return warn(d, 0, "还没有读数（里程碑门前可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, lines = read(p);
    // overall 必须是独立的一行（标题/列表项），不能是表格某格里的字样
    const HEAD = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?[*_`]*overall\b/i;
    const idx = lines.findIndex((l) => HEAD.test(l));
    if (idx < 0) { err(p, 0, "缺 overall 判定（应为独立一行，如「## overall：pass」）"); continue; }
    const V = /\b(pass|partial|fail)\b/i;
    let v = null;
    const m1 = lines[idx].match(/overall\b[^A-Za-z\n]*(pass|partial|fail)\b/i);
    if (m1) v = m1[1];
    else {
      // 允许中间夹空行（最多 2 行）
      for (let k = 1; k <= 2 && !v; k++) {
        const m2 = (lines[idx + k] || "").match(/^\s*[*_`\s:：|—–-]*(pass|partial|fail)\b/i);
        if (m2) v = m2[1];
      }
    }
    if (!v) err(p, idx + 1, "overall 的取值必须是 pass/partial/fail（可同行，或写在紧接的下一行）");
    const body = lines.filter((l) => !l.trimStart().startsWith(">")).join("\n");
    if (/<[^>\n]*>/.test(body)) err(p, 0, "还有模板占位（<…>）：读数必须写实测值与命令，不留占位");
    if (/\bTODO\b/.test(lines.join("\n"))) err(p, 0, "还有 TODO：读数必须给结论（未做就写 partial 并说明）");
    // 逐条读数：每个 `## R…` 段内必须有 verdict（overall 行不算）
    let cur = null; const secs = [];
    for (const l of lines) {
      const m = l.match(/^##\s+(.*)$/);
      if (m) { cur = { title: m[1].trim(), body: [] }; secs.push(cur); }
      else if (cur) cur.body.push(l);
    }
    const items = secs.filter((x) => /^R\d+/i.test(x.title));
    // 两种写法都接受：①每个 `## R…` 段内写 verdict；②表格行 `| R1 | … | pass |`
    const tableRows = [...lines.join("\n").matchAll(/^\|\s*(R\d+)\s*\|[^\n]*$/gim)].map((m) => m[0]);
    const rowVerdict = (row) => {
      const cs = cells(row);
      const last = (cs[cs.length - 1] || "").match(/\b(pass|partial|fail)\b/i);
      return last ? last[1].toLowerCase() : ((row.match(/\b(pass|partial|fail)\b/i) || [])[1] || "").toLowerCase();
    };
    if (!items.length && !tableRows.length) err(p, 0, "缺逐条读数（每条形如「## R1 …」段内写 verdict，或表格行「| R1 | … | pass |」）");
    for (const it of items) if (!V.test(it.body.join("\n"))) err(p, 0, `读数段「${it.title}」内缺 verdict（pass/partial/fail）`);
    for (const row of tableRows) if (!V.test(row)) err(p, 0, `读数表格行缺 verdict：${row.slice(0, 40)}`);
    // overall 必须由逐条推出来：任一条 fail ⇒ overall=fail；否则任一条 partial ⇒ overall=partial
    if (v) {
      const per = [...items.map((it) => {
        const m = it.body.join("\n").match(/verdict[:：]\s*\W*(pass|partial|fail)\b/i) || it.body.join("\n").match(/\b(pass|partial|fail)\b/i);
        return m ? m[1].toLowerCase() : "";
      }), ...tableRows.map(rowVerdict)].filter(Boolean);
      if (per.includes("fail") && v.toLowerCase() !== "fail") err(p, idx + 1, `overall=${v} 与逐条不一致：有读数判 fail ⇒ overall 必须是 fail`);
      else if (!per.includes("fail") && per.includes("partial") && v.toLowerCase() === "pass") err(p, idx + 1, `overall=pass 与逐条不一致：有读数判 partial ⇒ overall 必须是 partial`);
    }
  }
}

const PRESET_FILES = ["waterfall.md", "prototype.md", "incremental.md", "agent-driven.md"];
const KNOWN_KINDS = new Set(["requirement", "design", "implement", "review", "deliver", "verify", "vet", "docs"]);
// 发布快照：与 skill 一起冻结（改它要一次人签，不允许悄悄放宽/换名）
const SNAPSHOT_PRESET_SHA = {
  waterfall: "ffa2c322c0e767ce1a139907992fe11fa804945c417cd629bf3e7ab55d91d787",
  prototype: "eb435464abd1795728fee62dfbf45c16d2b906c06adec5f760ac1705fa1c5c1c",
  incremental: "13228780675864ac746a22892add51c961507d8493ba3ac1a85509c9c1307125",
  "agent-driven": "38272083a7a71e43848b4fbbf69578ecdbbedbd0bd00d0ad1775dcba85fa412b",
};
const SNAPSHOT_STAGES = {
  waterfall: "req[requirement] design[design] build[implement] verify[review] deliver[deliver]",
  prototype: "explore[implement] harden[requirement,design,implement,review] deliver[deliver]",
  incremental: "req_design[requirement,design] build[implement] verify[review] integrate[deliver]",
  "agent-driven": "frame[requirement,design] build[implement] verify[verify] review[review] sign[vet] deliver[deliver]",
};
const SNAPSHOT_CRITERIA = {
  G_req_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed provenance.present assumption_set.signed requirement.baseline_present requirement.claimed_or_na",
  G_design_exit: "stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound spec_set.signed provenance.present assumption_set.signed design.artifacts_present trace.card_coverage",
  G_build_exit: "task.complete assumption.disposed mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_verify_exit: "review.round_bound review.required spec_set.signed provenance.present assumption_set.signed trace.test_linked",
  G_deliver_exit: "design.code_matches node.integration_listed mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_explore_exit: "task.complete spec_set.signed provenance.present assumption_set.signed",
  G_harden_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound task.complete assumption.disposed mandate.revalidated review.round_bound review.required provenance.present requirement.baseline_present design.artifacts_present test.design_present trace.requirement_covered trace.test_linked requirement.claimed_or_na trace.card_coverage",
  G_req_design: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed provenance.present stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound requirement.baseline_present design.artifacts_present",
  G_integrate: "node.integration_listed design.code_matches mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_frame_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed provenance.present stage.design_traceable design.covers_spec design.no_spec_creep node.acceptance_bound agent.plan_reviewed agent.write_scope_disjoint agent.cards_have_negative_cases requirement.baseline_present design.artifacts_present requirement.claimed_or_na",
  G_agent_build_exit: "task.complete assumption.disposed mandate.revalidated spec_set.signed provenance.present assumption_set.signed agent.evidence_runnable agent.no_self_sign",
  G_agent_verify_exit: "agent.checker_green agent.mutation_red agent.unverified_listed spec_set.signed provenance.present trace.test_linked trace.card_coverage",
  G_agent_review_exit: "review.round_bound review.required agent.reviewer_not_author agent.findings_disposed spec_set.signed provenance.present",
  G_agent_sign_exit: "agent.human_signed agent.known_limits spec_set.signed assumption_set.signed provenance.present",
  G_agent_deliver_exit: "design.code_matches node.integration_listed mandate.revalidated agent.readings_frozen spec_set.signed provenance.present",
};

function presetChangeGate(changed) {
  const msg = (m) => ERR.push(`presets:0: ${m}`);
  const cur = currentMilestone(ROOT);
  const p = cur ? `.sdo/milestones/${cur}.md` : "";
  const activeOf = () => {
    const out = [];
    for (const preset of changed) for (const id of activeMilestonesUsing(ROOT, preset)) out.push({ preset, id });
    return out;
  };
  const invalid = (why) => msg(`preset_initiator_invalid：${why}`);
  const heads = p && exists(p) ? read(p).map((l, i) => ({ l, i })).filter((x) => /^#{2,3}\s+.*冻结段/.test(x.l)) : [];
  if (p && exists(p) && heads.length !== 1) return invalid("冻结段小节须唯一");
  const lines = p && exists(p) ? read(p) : [];
  const sec = lines.length ? sectionOf(lines, /^#{2,3}\s+.*冻结段/) : null;
  const hits = [];
  if (sec) for (let i = sec.start; i < sec.end; i++) {
    const m = lines[i].match(/^-\s*(?:\*\*)?preset 变更发起里程碑[:：]\s*M(\d+)/);
    if (m) hits.push({ m: `M${m[1]}`, line: i + 1 });
  }
  if (hits.length > 1) return invalid(`「preset 变更发起里程碑」须恰好一行（当前 ${hits.length} 行）`);
  if (hits.length === 0) {
    const act = activeOf().filter((x) => !archiveEntry(ROOT, x.id));
    if (!act.length) return msg("需人签更新发布快照（无活跃里程碑使用旧 preset；未声明发起者，按空集放行）");
    return invalid(`未声明「preset 变更发起里程碑」，但仍有活跃里程碑使用旧 preset：${act.map((x) => x.id).join("、")}`);
  }
  const init = hits[0].m;
  if (archiveEntry(ROOT, init)) return invalid(`发起里程碑 ${init} 已归档`);
  if (cur !== init) return invalid(`发起里程碑 ${init} 不是当前里程碑（${cur || "无"}）`);
  const remaining = activeOf().filter((x) => x.id !== init && !archiveEntry(ROOT, x.id));
  if (remaining.length) {
    const byPreset = new Map();
    for (const x of remaining) { if (!byPreset.has(x.preset)) byPreset.set(x.preset, []); byPreset.get(x.preset).push(x.id); }
    const parts = [...byPreset.entries()].map(([pr, ids]) => `${pr}: ${ids.join("、")}`);
    return msg(`preset_change_requires_archive：${parts.join("；")}（先归档，再更新发布快照；发起者 ${init} 已扣除）`);
  }
  msg("需人签更新发布快照（已无活跃里程碑使用旧 preset；人签后同步 SNAPSHOT 常量）");
}

const NEW_CRITERIA = ["requirement.baseline_present", "design.artifacts_present", "test.design_present", "trace.requirement_covered", "trace.test_linked", "requirement.claimed_or_na", "trace.card_coverage"];
function checkCriterionBasis() {
  const intent = read(".sdo/意图.md");
  const sections = new Set([...intent.join("\n").matchAll(/^###\s+12\.(\d+)\b/gm)].map((m) => m[1]));
  for (const f of PRESET_FILES) {
    const p = `presets/${f}`;
    const lines = read(`skills/sdo-flow/${p}`);
    for (const crit of NEW_CRITERIA) {
      if (!lines.some((l) => l.includes(crit))) continue;
      const hit = lines.map((l, i) => ({ l, i })).find((x) => x.l.includes(crit) && /依据[:：]\s*§12\.\d+/.test(x.l));
      if (!hit) { err(p, 0, `criterion_without_basis：${crit} 缺「依据：§12.<n>」`); continue; }
      const n = (hit.l.match(/依据[:：]\s*§12\.(\d+)/) || [])[1];
      if (!sections.has(n)) err(p, hit.i + 1, `basis_section_missing：${crit} 的依据 §12.${n} 不在 .sdo/意图.md §12 小节里`);
    }
  }
}

function checkPresets() {
  const i = ARGV.indexOf("--presets");
  const ext = ARGV[i + 1] && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : null;
  let doc = null;
  if (ext) {
    if (!fs.existsSync(path.resolve(ROOT, ext))) return err("presets", 0, `判据源不存在：${ext}`);
    doc = fs.readFileSync(path.resolve(ROOT, ext), "utf8");
  }
  const errStart = ERR.length;
  const changed = new Set();
  const docStages = {}, docGates = {};
  if (doc) {
    for (const m of doc.matchAll(/^\|\s*`(waterfall|prototype|incremental)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)) {
      docStages[m[1]] = [...m[2].matchAll(/([a-z_]+)\[([^\]]*)\]/g)].map((s) => `${s[1]}[${s[2].split(",").map((x) => x.trim()).filter(Boolean).join(",")}]`).join(" ");
    }
    for (const m of doc.matchAll(/(G_[a-z_]+):\s*\{([\s\S]*?)\}/g)) {
      const cm = m[2].match(/criteria:\s*\[([\s\S]*?)\]/);
      if (cm) docGates[m[1]] = [...cm[1].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]).join(" ");
    }
  }

  if (doc && !Object.keys(docGates).length && !Object.keys(docStages).length) {
    return err("presets", 0, `判据源格式不支持：${ext} 里找不到「G_x: { criteria: [...] }」或「| waterfall | … |」形态的片段（设计稿需先摘出 §1.1）`);
  }
  for (const f of PRESET_FILES) {
    const key = f.replace(".md", "");
    const p = `presets/${f}`;
    const text = fs.readFileSync(path.join(SKILL_ROOT, "presets", f), "utf8");
    const sha = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    if (sha !== SNAPSHOT_PRESET_SHA[key]) {
      changed.add(key);
      err(p, 0, `preset 内容 hash 与发布快照不一致（${sha.slice(0, 8)}… ≠ ${SNAPSHOT_PRESET_SHA[key].slice(0, 8)}…）：任何文字改动都要人签更新快照`);
    }

    const gotStages = {};
    for (const m of text.matchAll(/^###\s*`([a-z_]+)\[([^\]]*)\]`/gm)) {
      const sid = m[1], kinds = m[2].split(",").map((x) => x.trim()).filter(Boolean);
      if (gotStages[sid]) err(p, 0, `stage id 重复：${sid}`);
      gotStages[sid] = kinds;
      for (const k of kinds) if (!KNOWN_KINDS.has(k)) err(p, 0, `stage ${sid} 用了未知 kind：${k}`);
      if (!kinds.length) err(p, 0, `stage ${sid} 没有 kinds`);
    }
    if (!Object.keys(gotStages).length) err(p, 0, "没有任何 ### `sid[kinds]` 形式的 stage");

    const gotSeq = Object.entries(gotStages).map(([id, ks]) => `${id}[${ks.join(",")}]`).join(" ");
    const wantSeq = SNAPSHOT_STAGES[key];
    if (gotSeq !== wantSeq) changed.add(key);
    if (gotSeq !== wantSeq) err(p, 0, `stage 序列与发布快照不一致（多/少/改名/换 kinds 都要人签）：\n  本文件 ${gotSeq || "（空）"}\n  快照   ${wantSeq}`);

    const gates = [...text.matchAll(/id:\s*(G_[a-z_]+)([^}]*)criteria:\s*\[([^\]]*)\]/g)];
    if (!gates.length) err(p, 0, "没有任何 gate（id/criteria）");
    const gateIds = gates.map(([, gid]) => gid).sort();
    const wantGates = Object.keys(SNAPSHOT_CRITERIA).filter((g) => getPresetGates(key).includes(g)).sort();
    if (gateIds.join() !== wantGates.join()) changed.add(key);
    if (gateIds.join() !== wantGates.join()) err(p, 0, `gate 集合与发布快照不一致：本文件 [${gateIds.join(", ") || "空"}]，快照应为 [${wantGates.join(", ")}]`);

    const flattened = gates.flatMap(([, , , body]) => [...body.matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]));
    const newOnes = flattened.filter((x) => NEW_CRITERIA.includes(x));
    const dup = newOnes.find((x, i) => newOnes.indexOf(x) !== i);
    if (dup) err(p, 0, `同一 preset 内判据重复：${dup}（同一条款每门只该出现一次）`);
    for (const [, gid, , body] of gates) {
      const got = [...body.matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]).join(" ");
      const want = SNAPSHOT_CRITERIA[gid];
      if (want === undefined) err(p, 0, `gate ${gid} 不在发布快照里（新 gate 要随 skill 版本一起人签）`);
      else if (got !== want) { changed.add(key); err(p, 0, `${gid} 的 criteria 与发布快照不一致：\n  本文件 ${got || "（空）"}\n  快照   ${want}`); }
      if (!got.split(" ").includes("spec_set.signed")) err(p, 0, `${gid} 的 criteria 缺 core 判据 spec_set.signed`);
      // 外部判据源：只比对本文件出现的 gate
      if (docGates[gid] && docGates[gid] !== got) err(p, 0, `${gid} 的 criteria 与外部判据源不一致（本文件 ${got.split(" ").filter(Boolean).length} 条，源 ${docGates[gid].split(" ").filter(Boolean).length} 条）`);
    }

    if (doc) {
      const want = docStages[key];
      if (!want) {
        // 本 preset 是 skill 自己的扩展（设计稿里没有），只查发布快照，不比外部源
        console.log(`（${key} 不在判据源里：本 preset 属 skill 扩展，跳过外部比对）`);
      } else {
        if (want !== gotSeq) err(p, 0, `stage 序列与外部判据源不一致：\n  本文件 ${gotSeq}\n  源     ${want}`);
        for (const [, gid] of gates) if (!docGates[gid]) err(p, 0, `多出判据源里没有的 gate：${gid}`);
      }
    }
  }
  if (changed.size) {
    const gateStart = ERR.length;
    presetChangeGate(changed);
    if (ERR.length > gateStart) {
      const gateErrors = ERR.splice(gateStart);
      ERR.splice(errStart, 0, ...gateErrors);
    }
  }
  if (ERR.length > errStart) {
    const raised = ERR.splice(errStart);
    for (const m of raised) {
      // 只有“与发布快照不一致”降级为 WARN；preset 文件自身结构错仍阻断。
      if (/与发布快照不一致/.test(m)) WARN.push(m);
      else ERR.push(m);
    }
  }
  if (!ext) console.log("（preset 校验：快照不一致仅 WARN；结构错仍 ERR；与设计稿比对请传 --presets <文件>）");
}
// 每份 preset 应含哪些 gate（与 skill 文档一致；改这里等于改发布快照）
function getPresetGates(key) {
  return {
    waterfall: ["G_req_exit", "G_design_exit", "G_build_exit", "G_verify_exit", "G_deliver_exit"],
    prototype: ["G_explore_exit", "G_harden_exit", "G_deliver_exit"],
    incremental: ["G_req_design", "G_build_exit", "G_verify_exit", "G_integrate"],
    "agent-driven": ["G_frame_exit", "G_agent_build_exit", "G_agent_verify_exit", "G_agent_review_exit", "G_agent_sign_exit", "G_agent_deliver_exit"],
  }[key] || [];
}

// SKILL.md 的 YAML frontmatter：一个 ": " 就能让严格 YAML 解析失败，整个 skill 会被静默忽略
function checkFrontmatter() {
  const dirs = [SKILL_ROOT, ...skillDirs().map((d) => path.join(ROOT, d))];
  for (const dir of [...new Set(dirs)]) {
    const abs = path.join(dir, "SKILL.md");
    const p = path.relative(ROOT, abs).split(path.sep).join("/") || "SKILL.md";
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    if (lines[0].trim() !== "---") { err(p, 1, "缺少 YAML frontmatter（首行应为 ---）"); continue; }
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end < 0) { err(p, 1, "frontmatter 没有结束的 ---"); continue; }
    for (let i = 1; i < end; i++) {
      const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim();
      if (!v || /^[>|]/.test(v) || /^["'].*["']$/.test(v)) continue;
      if (/:\s/.test(v)) err(p, i + 1, `frontmatter 的 ${m[1]} 值里有「: 」，严格 YAML 会解析成嵌套映射 ⇒ 整个 skill 被忽略；改用 >- 块或加引号`);
      if (/\s#/.test(v)) warn(p, i + 1, `frontmatter 的 ${m[1]} 值里有「 #」，可能是注释起点；建议用 >- 块`);
    }
  }
}

function planExit2(msg) { console.error(msg); process.exit(2); }

function planMilestone() {
  const rest = ARGV.filter((a) => a !== "--plan" && a !== "--print-frozen-hash");
  let m = currentMilestone(ROOT) || "M4";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--milestone") {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) planExit2("--milestone 需要一个值（如 M4）");
      m = rest[++i];
    } else planExit2(`--plan 未知参数：${rest[i]}`);
  }
  if (!/^M\d+$/.test(m)) planExit2(`--milestone 格式应为 M<数字>：${m}`);
  return m;
}

const MILESTONE_DIR = ".sdo/milestones";
function milestonePath(m) { return `${MILESTONE_DIR}/${m}.md`; }
function milestoneLines(m) {
  const p = milestonePath(m);
  if (!exists(p)) planExit2(`里程碑文件不存在：${p}`);
  return { path: p, lines: read(p) };
}
function planSection(milestone) {
  const { path, lines } = milestoneLines(milestone);
  return { path, lines, start: 0, end: lines.length };
}

function stripNotes(s) {
  let t = String(s).replace(/`/g, "");
  for (;;) {
    const n = t.replace(/[（(][^（()）]*[)）]/g, "");
    if (n === t) break;
    t = n;
  }
  return t.trim();
}

const PLAN_ROOTS = [".sdo", "skills", "src", "docs", "design", "probe", "plan", "test", "migrations"];
function normalizePlanPath(raw) {
  let t = stripNotes(raw).replace(/\\/g, "/").trim();
  const dir = /\/$/.test(t) || /\/\*\*?$/.test(t);
  t = t.replace(/\/+$/, "").replace(/\/\*\*?$/, "").replace(/^\.\//, "");
  if (!t) return { p: "", dir: false };
  const top = t.split("/")[0];
  const rootFile = ["README.md", "package.json", "package-lock.json", "SKILL.md", "Makefile", "LICENSE"].includes(t);
  if (!rootFile && !PLAN_ROOTS.includes(top)) t = `skills/sdo-flow/${t}`;
  return { p: t, dir };
}

function splitScope(cell) {
  const out = [];
  for (const part of String(cell).split(/、|,/)) {
    const raw = part.trim();
    if (!raw) continue;
    out.push(raw);
  }
  return out;
}

function planCardTable(milestone) {
  const { path: planPath, lines, start, end } = planSection(milestone);
  let head = -1;
  for (let i = start; i < end; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const h = cells(lines[i]).map((x) => x.replace(/`/g, "").trim());
    if (h.includes("卡") && h.includes("依赖") && h.includes("写域")) { head = i; break; }
  }
  if (head < 0) planExit2(`${planPath} 没有卡表（卡/依赖/写域）`);
  const header = cells(lines[head]).map((x) => x.replace(/`/g, "").trim());
  const rows = [];
  for (let i = head + 1; i < end; i++) {
    const raw = lines[i].trim();
    if (!raw.startsWith("|")) break;
    if (isSep(raw)) continue;
    const c = cells(raw);
    const id = (c[header.indexOf("卡")] || "").trim();
    if (!/^M\d+-(?:\d+|G)$/.test(id)) continue;
    rows.push({ id, deps: c[header.indexOf("依赖")] || "", scope: c[header.indexOf("写域")] || "", line: i + 1 });
  }
  if (!rows.length) planExit2(`${planPath} 的卡表没有数据行`);
  return { lines, rows };
}

function planParseDeps(text) {
  let t = stripNotes(text);
  t = t.replace(/M(\d+)-(\d+)\s*…\s*M\1-(\d+)/g, (_, m, a, b) => {
    const out = [];
    for (let i = Number(a); i <= Number(b); i++) out.push(`M${m}-${i}`);
    return out.join("、");
  });
  return [...new Set([...t.matchAll(/M\d+-(?:\d+|G)/g)].map((m) => m[0]))];
}

function planCardInfo(id) {
  const p = `.sdo/cards/${id}.md`;
  if (!exists(p)) return null;
  const lines = read(p);
  let scopeRaw = "", scopeLine = 0, refsRaw = "", refsLine = 0, depLine = 0, depRaw = "", previewLine = 0;
  let inPreview = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^write_scope:/.test(l)) { scopeRaw = l.replace(/^write_scope:\s*/, ""); scopeLine = i + 1; }
    if (/^read_refs:/.test(l)) { refsRaw = l.replace(/^read_refs:\s*/, ""); refsLine = i + 1; }
    if (/^##\s*预览/.test(l)) { inPreview = true; previewLine = i + 1; continue; }
    if (/^##\s/.test(l) && !/^##\s*预览/.test(l)) inPreview = false;
    if (!inPreview && /^依赖[:：]/.test(l)) { depRaw = l.replace(/^依赖[:：]\s*/, ""); depLine = i + 1; }
  }
  const m = scopeRaw.match(/^\[(.*)\]\s*$/);
  const scopeItems = m ? splitScope(m[1]) : [];
  const rm = refsRaw.match(/^\[(.*)\]\s*$/);
  const readItems = rm ? splitScope(rm[1]) : [];
  return { lines, scopeItems, readItems, scopeLine, refsLine, depLine, depRaw, previewLine };
}

function planSplitPathTokens(span) {
  const out = [];
  for (const raw of String(span).split(/\s+/)) {
    let t = stripNotes(raw).replace(/^[：:，,。;；]+|[：:，,。;；]+$/g, "");
    t = t.replace(/:\d+(?:-\d+)?$/, "");
    if (!t || /[<>…*`]/.test(t)) continue;
    if (/^(?:https?:|node:|npm|git|\.\.|\/)/.test(t)) continue;
    if (/\//.test(t)) out.push(t);
    else if (/^(?:README\.md|package\.json|package-lock\.json|Makefile|LICENSE)$/.test(t)) out.push(t);
  }
  return out;
}

function planBacktickPath(span) {
  let t = String(span).trim().replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/:[0-9]+(?:-[0-9]+)?$/, "").replace(/^[：:，,。;；]+|[：:，,。;；]+$/g, "");
  if (!t || /\s/.test(t)) return "";
  if (/[<>…*`"'（）()：:，,。;；、]/.test(t)) return "";
  if (/^(?:https?:|node:|npm|git|\.\.|\/)/.test(t)) return "";
  if (/\/$/.test(t)) return "";
  if (!/\//.test(t) && !/^(?:README\.md|package\.json|package-lock\.json|Makefile|LICENSE)$/.test(t)) return "";
  return t;
}

function planCovers(pathRaw, scopes) {
  const n = normalizePlanPath(pathRaw);
  if (!n.p) return true;
  return scopes.some((s) => s.p === n.p || (s.dir && n.p.startsWith(`${s.p}/`)));
}


const PRESET_BLACKLIST = new Set(["无", "没有", "不适用", "不需要", "无所谓", "待补充", "略", "同上", "见上"]);

function presetNames() {
  return fs.readdirSync(path.join(SKILL_ROOT, "presets"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
}
function presetStages(name) {
  const p = `skills/sdo-flow/presets/${name}.md`;
  if (!exists(p)) return [];
  return read(p).map((l) => l.match(/^###\s+`([a-z_]+)\[/)).filter(Boolean).map((m) => m[1]);
}
function allPresetStageIds() {
  const ids = new Set();
  for (const name of presetNames()) for (const id of presetStages(name)) ids.add(id);
  return ids;
}

const STRUCT_FIELD_RE = /^\s*(?:[-*]\s*)?(hash|状态|认领需求|门禁|判据|基线\s*hash|探底\s*R\d+)\s*[:：]\s*(.*)$/;
function placeholderValue(v) { return /^<[^<>]+>$/.test(v.trim()); }
function placeholderHint(field, file, mid) {
  if (file.includes("/baseline/")) return `应该用：node ${SKILL_REL}/scripts/baseline.mjs init`;
  if (/基线\s*hash/i.test(field)) return "应该用：见 SKILL.md 步 2（baseline.mjs init 后按 --plan 报错里的“当前基线”填写）";
  if (/^hash$/i.test(field.trim())) return `应该用：node ${SKILL_REL}/scripts/milestone.mjs freeze ${mid}`;
  if (file === ".sdo/计划.md") return "应该用：按 .sdo/计划.md 的里程碑表填写该行（见 SKILL.md 步 3）";
  if (/门禁|判据/.test(field)) return `应该用：按 SKILL.md 步 3 填写，或重跑 milestone.mjs new ${mid} 重建骨架`;
  return "应该用：按 SKILL.md 对应步骤填写该结构性字段";
}

function checkHandwritingSuspicion(target) {
  const stageIds = allPresetStageIds();
  const mdir = path.join(ROOT, ".sdo/milestones");
  let mfiles = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => /^M\d+\.md$/.test(f)).sort() : [];
  if (target) mfiles = mfiles.filter((f) => f === `${target}.md`);
  for (const f of mfiles) {
    const rel = `.sdo/milestones/${f}`;
    const mid = f.replace(/\.md$/, "");
    const lines = read(rel);
    for (let i = 0; i < lines.length; i++) {
      const m = STRUCT_FIELD_RE.exec(lines[i]);
      if (!m || !placeholderValue(m[2])) continue;
      err(rel, i + 1, `structural_placeholder_left：${m[1].replace(/\s+/g, " ")} 仍是「${m[2].trim()}」占位；${placeholderHint(m[1], rel, mid)}`);
    }
    if (originalPlanSigned(mid) && !lines.some((l) => /^hash\s*[:：]/.test(l))) {
      err(rel, 1, `frozen_hash_missing：已签里程碑缺冻结段 hash 行；应该用：node ${SKILL_REL}/scripts/milestone.mjs freeze ${mid}`);
    }
    for (let i = 0; i < lines.length; i++) {
      if (!/^阶段序列\s*[:：]/.test(lines[i])) continue;
      const ids = [...lines[i].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
      for (const id of ids) {
        if (!stageIds.has(id)) err(rel, i + 1, `phase_unknown：阶段序列里的「${id}」不是任何 preset 的阶段 id；应该用：在阶段序列里写 presets/ 里的英文阶段 id（见 SKILL.md §3）`);
      }
    }
  }
  const planRel = ".sdo/计划.md";
  if (exists(planRel)) {
    const lines = read(planRel);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|\s*M\d+\s*\|/.test(lines[i])) continue;
      for (const cell of cells(lines[i])) {
        if (!placeholderValue(cell)) continue;
        err(planRel, i + 1, `structural_placeholder_left：计划索引行仍有「${cell.trim()}」占位；应该用：按 .sdo/计划.md 的里程碑表填写该行（见 SKILL.md 步 2）`);
      }
    }
  }
  const bdir = path.join(ROOT, ".sdo/baseline");
  const bfiles = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith(".md")).sort() : [];
  for (const f of bfiles) {
    const rel = `.sdo/baseline/${f}`;
    const lines = read(rel);
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:[-*]\s*)?(基线\s*hash|hash)\s*[:：]\s*(.*)$/.exec(lines[i]);
      if (!m || !placeholderValue(m[2])) continue;
      err(rel, i + 1, `structural_placeholder_left：${m[1].replace(/\s+/g, " ")} 仍是「${m[2].trim()}」占位；应该用：node ${SKILL_REL}/scripts/baseline.mjs init`);
    }
  }
}
function meaningfulLen(s) {
  return String(s).replace(/[，。！？、；：,.!?;:\s"'“”‘’（）()《》<>【】\[\]-]/g, "").length;
}
// 解析“基线段”声明（如 `- preset 声明基线段（理由…）：M1、M2、M3`）。豁免只认声明，不认编号或文件名。
function baselineSegments(lines, kind, p) {
  const set = new Set();
  const heads = lines.map((l, i) => ({ l, i })).filter((x) => /^#{2,3}\s+.*冻结段/.test(x.l));
  if (heads.length !== 1) {
    err(p, heads.length ? heads[1].i + 1 : 1, `冻结段小节须唯一（标题含“冻结段”，当前 ${heads.length} 处）`);
    return set;
  }
  const sec = sectionOf(lines, /^#{2,3}\s+.*冻结段/);
  const re = kind === "preset" ? /^- preset 声明基线段(（[^）]*）)?：/
    : kind === "baseline" ? /^- 基线版本绑定基线段(（[^）]*）)?：/
    : /^- 探底行基线段(（[^）]*）)?：/;
  for (let i = sec.start; i < sec.end; i++) {
    if (!re.test(lines[i])) continue;
    const part = lines[i].slice(lines[i].lastIndexOf("：") + 1);
    for (const m of part.matchAll(/M(\d+)/g)) set.add(`M${m[1]}`);
  }
  return set;
}
function sectionOf(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
  return { start: start + 1, end };
}
function checkPresetDeclaration(lines, p) {
  const hits = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = lines[i].match(/^preset[:：]\s*(\S+)\s*$/);
    if (m) hits.push({ name: m[1], line: i + 1 });
  }
  if (hits.length > 1) err(p, hits[1].line, `preset： 重复声明（第 ${hits[0].line} 行与第 ${hits[1].line} 行）`);
  const preset = hits.length ? hits[0].name : "";
  let reason = "", reasonLine = 0;
  fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const r = lines[i].match(/^preset 选择理由[:：]\s*(.+)$/);
    if (r) { reason = r[1]; reasonLine = i + 1; }
  }
  if (!preset) err(p, 1, "缺 preset： 声明（里程碑文件须写 preset：<名>）");
  else if (!presetNames().includes(preset)) err(p, hits[0].line, `preset 不在 presets/ 清单（${preset}）`);
  if (!reason) err(p, 1, "缺 preset 选择理由：（≥8 字、非套话）");
  else if (meaningfulLen(reason) < 8 || PRESET_BLACKLIST.has(reason.trim())) {
    err(p, reasonLine, `preset 选择理由过短或为套话：${reason.trim()}`);
  }
  return preset;
}
function checkProbeLines(lines, p) {
  const readings = [];
  const rdHeads = lines.map((l, i) => ({ l, i })).filter((x) => /^#{2,3}\s+.*读数\s*$/.test(x.l));
  if (rdHeads.length !== 1) { err(p, rdHeads.length ? rdHeads[1].i + 1 : 1, `读数小节须唯一（标题以“读数”结尾，当前 ${rdHeads.length} 处）`); return; }
  const rdSec = sectionOf(lines, /^#{2,3}\s+.*读数\s*$/);
  const scan = rdSec ? lines.slice(rdSec.start, rdSec.end) : lines;
  for (const l of scan) {
    const m = l.match(/^\|\s*(R\d+)\s*\|/);
    if (m) readings.push(m[1]);
  }
  const sec = sectionOf(lines, /^探底[：:]\s*$/);
  const inList = new Map();
  if (sec) {
    for (let i = sec.start; i < sec.end; i++) {
      const m = lines[i].match(/^-\s*探底\s*(R\d+)\s*[:：]/);
      if (m) inList.set(m[1], i + 1);
    }
  }
  for (const r of readings) {
    if (!inList.has(r)) {
      err(p, 1, `${r} 没有探底行（须在「探底：」列表内写 - 探底 ${r}：）`);
    }
  }
}

function checkFrozenHash(raw, p, mid) {
  if (raw.startsWith("\uFEFF")) err(p, 1, "文件含 BOM（冻结段 hash 要求 UTF-8 无 BOM、LF）");
  if (raw.includes("\r")) err(p, 1, "文件含 CR（冻结段 hash 要求 LF）");
  const lines = raw.split("\n");
  let expect = "", hashLines = 0;
  const hashCandidates = [];
  for (const l of lines) {
    const m = l.match(/^hash:([0-9a-f]{64})\s*$/);
    if (m) { expect = m[1]; hashLines++; }
    const hm = /^\s*(?:[-*]\s*)?(?:冻结段\s*)?hash\s*[:：]\s*([0-9a-f]{0,64})?\s*$/i.exec(l);
    if (hm) hashCandidates.push(l);
  }
  if (hashLines > 1) err(p, 1, `hash: 行重复（${hashLines} 处，应只有一处）`);
  const actual = frozenHashRaw(raw);
  if (!expect) {
    if (hashCandidates.length === 0) {
      err(p, 1, "冻结段 hash 行缺失（应为独立一行：hash:<64hex>）");
    } else {
      const val = (hashCandidates[0].match(/([0-9a-f]{64})/) || [])[1];
      err(p, 1, `冻结段 hash 不匹配（期望 ${actual.slice(0, 8)}… 实际 ${val ? `${val.slice(0, 8)}…` : "整行格式不符"}）`);
    }
    return;
  }
  // 与签字文件记录的冻结段 hash 交叉比对（记录行：`- 冻结段 hash：<sha256>`）
  const signFile = planSignFile(mid);
  let recorded = "";
  if (signFile) {
    for (const l of read(path.join(".sdo/sign", signFile))) {
      if (!l.startsWith("- 冻结段 hash：")) continue;
      const m = l.match(/([0-9a-f]{64})/);
      if (m) recorded = m[1];
    }
  }
  if (!recorded) {
    if (!signFile) err(p, 1, `本里程碑尚无计划签（S<n> 计划），无法交叉比对冻结段 hash：计划签时须记「- 冻结段 hash：<sha256>」`);
    else err(p, 1, `${signFile} 未记「- 冻结段 hash：」（无法交叉比对；冻结段 hash 必须由本里程碑的计划签记录）`);
  }
  if (expect === actual && (!recorded || recorded === actual)) return;
  const signs = lines.map((l) => l.match(/^- 追加签：S(\d+)-([A-Z])\s*$/)).filter(Boolean);
  for (const m of signs) {
    const sp = `.sdo/sign/S${m[1]}-${m[2]}.md`;
    if (!exists(sp)) continue;
    const spLines = read(sp);
    const anchors = spLines.filter((l) => l.startsWith("- 被签对象：")).join("\n");
    // 追加签正文里也可以直接记新冻结段 hash（`- 冻结段 hash：`）：它同样由人签，且本行引用即绑定
    const hashNotes = spLines.filter((l) => l.startsWith("- 冻结段 hash：")).join("\n");
    if (anchors.includes(actual.slice(0, 8)) || hashNotes.includes(actual.slice(0, 8))) return;
  }
  if (expect !== actual) {
    err(p, 1, `signed_anchor_mismatch：冻结段 hash 不匹配（期望 ${actual.slice(0, 8)}… 实际 ${expect.slice(0, 8)}…；无有效追加签）`);
  } else {
    err(p, 1, `冻结段 hash 不一致：文件=${expect.slice(0, 8)}… 计划签=${(recorded || "-").slice(0, 8)}… 实算=${actual.slice(0, 8)}…（无有效追加签）`);
  }
}
function planSignFile(mid) {
  const dir = ".sdo/sign";
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return "";
  const re = new RegExp(`^S(\\d+)(?:-[A-Z])?\\.md$`);
  const hits = [];
  for (const f of fs.readdirSync(abs).filter((x) => re.test(x))) {
    const lines = read(path.join(dir, f));
    const title = lines[0] || "";
    const scope = lines.find((l) => l.startsWith("- 范围：")) || "";
    const n2 = String(mid).replace(/^M/, "");
    const isPlan = new RegExp(`M${n2}\\s*计划`).test(title) || new RegExp(`M${n2}\\s*计划`).test(scope);
    if (isPlan) hits.push({ f });
  }
  if (!hits.length) return "";
  // 签字号数值序的唯一实现在 lib/signs.mjs（view.mjs 共用），这里不另写比较器。
  const sorted = sortSigns(hits, (h) => h.f);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (read(path.join(dir, sorted[i].f)).some((l) => l.startsWith("- 冻结段 hash："))) return sorted[i].f;
  }
  return sorted[sorted.length - 1].f;
}
// frozen_hash_missing 的“已签”只认原始计划签（S<数字>.md）；追加签 S<n>-A 不冒充。
function originalPlanSigned(mid) {
  const dir = path.join(ROOT, ".sdo/sign");
  if (!fs.existsSync(dir)) return false;
  const n = String(mid).replace(/^M/, "");
  for (const f of fs.readdirSync(dir)) {
    if (!/^S\d+\.md$/.test(f)) continue;
    const lines = read(path.join(".sdo/sign", f));
    const title = lines[0] || "";
    const scope = lines.find((l) => l.startsWith("- 范围：")) || "";
    const points = new RegExp(`M${n}\\s*计划`).test(title) || new RegExp(`M${n}\\s*计划`).test(scope);
    if (!points) continue;
    const verdict = (lines.find((l) => l.startsWith("- 判定：")) || "").replace(/^- 判定：/, "").trim();
    const hasHash = lines.some((l) => /^- 冻结段 hash：\s*[0-9a-f]{64}\s*$/.test(l));
    if (/^(?:接受|签)/.test(verdict) && hasHash) return true;
  }
  return false;
}

function checkStageOrder(lines, p, preset) {
  const heads = lines.map((l, i) => ({ l, i })).filter((x) => /^#{2,3}\s+.*阶段(（[^）]*）)?\s*$/.test(x.l));
  if (heads.length > 1) { err(p, heads[1].i + 1, "阶段段重复（### 阶段 出现多次）"); return; }
  const sec = heads.length ? sectionOf(lines, /^#{2,3}\s+.*阶段(（[^）]*）)?\s*$/) : null;
  if (!sec) { err(p, 1, "缺阶段段（小节标题须以「阶段」结尾）"); return; }
  const cands = lines.slice(sec.start, sec.end).map((l, i) => ({ l, i: sec.start + i })).filter((x) => x.l.includes("→") && /`[a-z]+`/.test(x.l));
  if (!cands.length) { err(p, 1, "阶段段缺序列（`frame`→…）"); return; }
  const expected = presetStages(preset);
  for (const c of cands) {
    const actual = [...c.l.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    if (expected.length && actual.join(">") !== expected.join(">")) {
      err(p, c.i + 1, `阶段顺序与 preset 不一致：文件=[${actual.join("→")}] preset=[${expected.join("→")}]`);
    }
  }
}
function checkCardTemplateDecisions() {
  const p = "skills/sdo-flow/templates/card.md";
  if (!exists(p)) return;
  if (!read(p).some((l) => /^##\s*临时决策\s*$/.test(l))) err(p, 1, "卡模板缺「## 临时决策」段（M8-2 C6）");
}

function ledgerIds() {
  const ids = new Set();
  const files = [".sdo/台账.md"];
  const dir = ".sdo/ledger";
  if (exists(dir) && fs.statSync(path.join(ROOT, dir)).isDirectory()) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (/^vol-\d+\.md$/.test(f)) files.push(`${dir}/${f}`);
    }
  }
  for (const f of files) {
    if (!exists(f)) continue;
    for (const l of read(f)) {
      const m = /^\|\s*(D-\d+)\s*\|/.exec(l.trim());
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

function checkBaselineArtifacts() {
  for (const name of BASELINE_FILES) {
    const p = `.sdo/baseline/${name}`;
    if (!exists(p)) err(p, 1, `基线缺文件：${name}（要求四份：${BASELINE_FILES.join("、")}）`);
  }
  const arch = exists(".sdo/baseline/architecture.md") ? read(".sdo/baseline/architecture.md") : [];
  const adrIdx = arch.map((l, i) => ({ l, i })).filter((x) => /^##\s+ADR-\d+[：:]/.test(x.l));
  if (!adrIdx.length) err(".sdo/baseline/architecture.md", 1, "缺 ADR（须 ## ADR-<n>：<标题>）");
  for (const a of adrIdx) {
    let end = arch.length;
    for (let i = a.i + 1; i < arch.length; i++) if (/^##\s/.test(arch[i])) { end = i; break; }
    const body = arch.slice(a.i + 1, end).join("\n");
    for (const f of ["决策", "备选", "后果"]) {
      if (!new RegExp(`^-\\s*${f}[:：]`, "m").test(body)) err(".sdo/baseline/architecture.md", a.i + 1, `ADR 缺字段：${f}`);
    }
  }
  const ts = exists(".sdo/baseline/test-strategy.md") ? read(".sdo/baseline/test-strategy.md") : [];
  const th = ts.findIndex((l) => /^\|\s*变更类型\s*\|\s*测试技术\s*\|/.test(l.trim()));
  if (th < 0) err(".sdo/baseline/test-strategy.md", 1, "缺测试策略表头（| 变更类型 | 测试技术 |）");
  else {
    let rows = 0;
    for (let i = th + 1; i < ts.length && ts[i].trim().startsWith("|"); i++) {
      if (!/^\|[\s:|-]+\|$/.test(ts[i].trim())) rows++;
    }
    if (rows < 3) err(".sdo/baseline/test-strategy.md", th + 1, `测试策略表少于 3 行（当前 ${rows}）`);
  }
  const qr = exists(".sdo/baseline/quality-risk.md") ? read(".sdo/baseline/quality-risk.md") : [];
  if (!qr.some((l) => /^##\s*质量属性\s*$/.test(l))) err(".sdo/baseline/quality-risk.md", 1, "缺「## 质量属性」");
  if (!qr.some((l) => /^##\s*风险登记\s*$/.test(l))) err(".sdo/baseline/quality-risk.md", 1, "缺「## 风险登记」");
  const req = exists(".sdo/baseline/requirement.md") ? read(".sdo/baseline/requirement.md") : [];
  const rIdx = req.map((l, i) => ({ l, i })).filter((x) => /^###\s+R-\d+\s/.test(x.l.trim()));
  if (rIdx.length < 3) err(".sdo/baseline/requirement.md", 1, `baseline_requirement_malformed：需求条目 ${rIdx.length} < 3（须 ### R-<n> <标题>）`);
  for (const r of rIdx) {
    let end = req.length;
    for (let i = r.i + 1; i < req.length; i++) if (/^#{1,3}\s/.test(req[i])) { end = i; break; }
    if (!req.slice(r.i + 1, end).some((l) => /^-\s*验收[:：]/.test(l.trim()))) {
      err(".sdo/baseline/requirement.md", r.i + 1, `baseline_requirement_malformed：${r.l.trim()} 缺「验收：」`);
    }
  }
}

function checkBaselineTemplate() {
  const tpl = "skills/sdo-flow/templates/baseline.md";
  if (!exists(tpl)) { err(tpl, 1, "baseline_template_malformed：模板缺失"); return; }
  const t = read(tpl).join("\n");
  const bad = [];
  for (const name of BASELINE_FILES) if (!t.includes(name)) bad.push(`缺小节：${name}`);
  if (!/验收[:：]/.test(t)) bad.push("requirement 段缺「验收：」");
  for (const f of ["决策", "备选", "后果"]) if (!new RegExp(`${f}[:：]`).test(t)) bad.push(`架构段缺「${f}：」`);
  if (!t.includes("| 变更类型 | 测试技术 |")) bad.push("测试策略表头");
  if (!/^##\s*质量属性\s*$/m.test(t)) bad.push("质量属性小节");
  if (!/^##\s*风险登记\s*$/m.test(t)) bad.push("风险登记小节");
  if (bad.length) err(tpl, 1, `baseline_template_malformed：${bad.join("；")}`);
}

function checkBaselineBinding(milestone, raw, p) {
  const lines = raw.split("\n");
  const sec = sectionOf(lines, /^#{2,3}\s+.*冻结段/);
  if (!sec) return;
  const scan = lines.slice(sec.start, sec.end);
  const cur = baselineHash(ROOT);
  const hits = scan.map((l, i) => ({ l, i: sec.start + i })).filter((x) => /^-\s*基线 hash[:：]/ .test(x.l));
  if (!hits.length) {
    err(p, sec.start + 1, `baseline_drift：里程碑冻结段缺「基线 hash：(64 hex)」（当前基线 ${cur}；声明写法：- 基线 hash：${cur}）`);
    return;
  }
  if (hits.length > 1) { err(p, hits[1].i + 1, `基线 hash 行重复（${hits.length} 处）`); return; }
  const m = /^-\s*基线 hash[:：]\s*([0-9a-f]{64})\s*$/.exec(hits[0].l.trim());
  if (!m) { err(p, hits[0].i + 1, "基线 hash 格式错（应为 - 基线 hash：<64 位小写 hex>）"); return; }
  const old = m[1];
  if (old === cur) return;
  const ex = scan.map((l, i) => ({ l, i: sec.start + i })).find((x) => /^-\s*基于旧基线[:：]/.test(x.l));
  if (!ex) {
    err(p, hits[0].i + 1, `baseline_drift：旧=${old} 新=${cur}（声明写法：- 基于旧基线：${old.slice(0, 8)}（≥8 字理由））`);
    return;
  }
  const em = /^-\s*基于旧基线[:：]\s*([0-9a-f]{8,64})\s*[（(](.+)[）)]\s*$/.exec(ex.l.trim());
  const 写法 = `- 基于旧基线：${old.slice(0, 8)}（变更请求：D-<n>；理由：<≥8 字>）`;
  if (!em) { err(p, ex.i + 1, `baseline_drift：基于旧基线声明格式错（应为 ${写法}）`); return; }
  const inner = em[2].trim();
  const dm = /变更请求[:：]\s*(D-\d+)/.exec(inner);
  const rm = /理由[:：]\s*(.+)$/.exec(inner);
  if (!dm || !rm) { err(p, ex.i + 1, `baseline_drift：基于旧基线缺「变更请求：D-<n>」或「理由：<≥8 字>」（应为 ${写法}）`); return; }
  if (!ledgerIds().has(dm[1])) { err(p, ex.i + 1, `baseline_drift：变更请求 ${dm[1]} 不在台账`); return; }
  const reason = rm[1].trim();
  if (em[1] !== old.slice(0, 8)) {
    err(p, ex.i + 1, `baseline_drift：基于旧基线前缀 ${em[1]} 与声明 hash 旧值 ${old.slice(0, 8)} 不符`);
    return;
  }
  if (meaningfulLen(reason) < 8 || PRESET_BLACKLIST.has(reason)) {
    err(p, ex.i + 1, `baseline_drift：基于旧基线理由过短或为套话：${reason}`);
    return;
  }
  console.log(`计划：基线漂移由「基于旧基线」放行 ${old.slice(0, 8)}→${cur.slice(0, 8)}（变更请求 ${dm[1]}；${reason}）`);
}

function checkRequirementClaim(lines, planPath) {
  const claim = lines.some((l) => /^认领需求[:：]\s*\S/.test(l.trim()));
  if (claim) return;
  const na = lines.map((l) => l.trim()).find((l) => /^需求[:：]\s*无\s*[（(][^）)]+[）)]/.test(l));
  if (na) {
    const reason = (na.match(/[（(]([^）)]+)[）)]/) || [])[1] || "";
    if (substantiveReason(reason)) return;
    err(planPath, 1, `requirement_missing：需求：无（理由）的理由不够具体（${reason}）`);
    return;
  }
  err(planPath, 1, "requirement_missing：缺「认领需求：」行且无「需求：无（理由）」");
}

// M11-3：冻结段「- 门禁：」「- 判据：」是唯一真源；M12 起强制，M1–M11 已签为历史。
function isNewDeclarationMilestone(mid) {
  return !originalPlanSigned(mid);
}
function allPresetGateIds() {
  const dir = path.join(SKILL_ROOT, "presets");
  const out = new Set();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/\b(G_[a-z_]+)\b/g)) out.add(m[1]);
  }
  return out;
}
function allPresetCriteriaNames() {
  const dir = path.join(SKILL_ROOT, "presets");
  const out = new Set();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/[a-z_]+\.[a-z_]+/g)) out.add(m[0]);
    }
  }
  for (const extra of ["gate.signed", "readings.recorded", "review.independent"]) out.add(extra);
  return out;
}
function freezeSectionLines(lines) {
  const sec = sectionOf(lines, /^#{2,3}\s+.*冻结段/);
  return sec ? { start: sec.start, end: sec.end, lines } : null;
}
function checkDeclarations(lines, p, mid) {
  if (!isNewDeclarationMilestone(mid)) return;
  const sec = freezeSectionLines(lines);
  if (!sec) {
    err(p, 1, "frozen_hash_missing：找不到「## 冻结段」小节，无法读取门禁/判据声明（声明不读，不回退整文件）");
    return;
  }
  let gateLine = -1, critLine = -1, gateVal = "", critVal = "";
  for (let i = sec.start; i < sec.end; i++) {
    const g = lines[i].match(/^-\s*门禁[:：]\s*(.+)$/);
    if (g) { gateLine = i + 1; gateVal = g[1]; }
    const c = lines[i].match(/^-\s*判据[:：]\s*(.+)$/);
    if (c) { critLine = i + 1; critVal = c[1]; }
  }
  if (gateLine < 0 || gateVal.trim() === "") err(p, 1, "gate_criteria_undeclared：冻结段缺「- 门禁：<gate 序列>」声明（不设默认集）");
  if (critLine < 0 || critVal.trim() === "") err(p, 1, "gate_criteria_undeclared：冻结段缺「- 判据：<判据列表>」声明（不设默认集）");
  const gateIds = [...new Set([...gateVal.matchAll(/G_[a-z0-9_]+/g)].map((x) => x[0]))];
  const knownGates = allPresetGateIds();
  for (const id of gateIds) if (!knownGates.has(id)) err(p, gateLine, `gate_unknown：门禁「${id}」不在 presets 的已知门集合（勿自编）`);
  const critNames = [...new Set(critVal.split(/、|,/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean))];
  const knownCrit = allPresetCriteriaNames();
  for (const c of critNames) if (!knownCrit.has(c)) err(p, critLine, `criterion_not_whitelisted：判据「${c}」不在启发式判据池（presets 正文正则扫描，非权威白名单；如确为合法新码需先补 presets 或白名单）`);
  // 可选「按门映射」：- 门禁判据：G_id = c1, c2。无映射时保持全局并集闭合。
  const criteriaSet = new Set(critNames);
  const mappedGates = new Set();
  for (let i = sec.start; i < sec.end; i++) {
    const mm = lines[i].match(/^-\s*门禁判据[:：]\s*(.*)$/);
    if (!mm) continue;
    const body = mm[1].trim();
    const eq = body.indexOf("=");
    const gid = (eq < 0 ? body : body.slice(0, eq)).trim();
    if (!/^G_[a-z0-9_]+$/.test(gid)) {
      err(p, i + 1, `gate_id_invalid：门禁判据行必须以 G_<小写字母数字下划线> = 开头（实际：${gid || "空"}）`);
      continue;
    }
    if (mappedGates.has(gid)) { err(p, i + 1, `gate_criteria_duplicate：门禁判据重复声明 ${gid}`); continue; }
    mappedGates.add(gid);
    if (!gateIds.includes(gid)) err(p, i + 1, `gate_not_declared：门禁判据映射门「${gid}」不在冻结段「- 门禁：」声明序列`);
    const list = eq < 0 ? [] : body.slice(eq + 1).split(/、|,/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean);
    if (list.length === 0) err(p, i + 1, `gate_id_invalid：门禁判据映射「${gid}」的判据列表为空（应写 G_id = c1, c2）`);
    for (const c of list) if (!criteriaSet.has(c)) err(p, i + 1, `declared_criterion_unknown：门禁判据映射里的「${c}」不在全局「- 判据：」集合`);
  }
  for (let i = sec.start; i < sec.end; i++) {
    if (/^preset\s*[:：]/.test(lines[i]) || /^preset\s+选择理由\s*[:：]/.test(lines[i])) {
      err(p, i + 1, `preset_field_removed：新签里程碑真源不得再写 preset 字段（${lines[i].trim()}）；preset 只是参考模板`);
    }
  }
}

function checkPlanRules(milestone, planPath) {
  const raw = fs.readFileSync(path.join(ROOT, planPath), "utf8");
  const lines = raw.split("\n");
  checkRequirementClaim(lines, planPath);
  const presetBase = baselineSegments(lines, "preset", planPath);
  const probeBase = baselineSegments(lines, "探底", planPath);
  // 顺序：先查“内容规则”（preset / 理由 / 探底 / 阶段），最后查冻结段 hash。
  // 理由：改冻结段内容时 hash 必然变，若先报 hash，真正被违反的规则会被噪声盖住（R26 要求首条报错可指认）。
  const baselineVersionBase = baselineSegments(lines, "baseline", planPath);
  let preset = "";
  if (isNewDeclarationMilestone(milestone)) {
    checkDeclarations(lines, planPath, milestone);
  } else {
    if (!presetBase.has(milestone)) preset = checkPresetDeclaration(lines, planPath);
    if (preset) checkStageOrder(lines, planPath, preset);
  }
  if (!probeBase.has(milestone)) checkProbeLines(lines, planPath);
  if (!baselineVersionBase.has(milestone)) checkBaselineBinding(milestone, raw, planPath);
  checkFrozenHash(raw, planPath, milestone);
}
function checkR25Docs() {
  const ref = "skills/sdo-flow/references/03-签字与评审.md";
  if (!read(ref).some((l) => /^#{2,3}\s+.*评审席位失败/.test(l))) err(ref, 1, "缺「评审席位失败」小节标题（R25 C2）");
  const tpl = "skills/sdo-flow/templates/review.md";
  for (const field of ["席位", "失败处置"]) {
    if (!read(tpl).some((l) => new RegExp(`^-\\s*${field}[:：]`).test(l))) err(tpl, 0, `模板缺字段：${field}`);
  }
}

function checkAuthorizationText() {
  const skillPath = "skills/sdo-flow/SKILL.md";
  const skill = read(skillPath);
  const sec = sectionOf(skill, /^##\s*5[.、]/);
  const sec5 = sec ? skill.slice(sec.start, sec.end) : [];
  const isComment = (l) => /^\s*(#|\/\/|<!--)/.test(l);
  const ok5 = sec5.find((l) => !isComment(l) && l.includes("口头授权") && l.includes("流程放行") && (l.includes("≠") || l.includes("不等于")));
  if (!ok5) err(skillPath, sec ? sec.start + 1 : 1, "§5 缺“口头授权≠流程放行”约束（须同一行、含 ≠ 或 不等于）");
  const presetRule = sec5.find((l) => !isComment(l) && l.includes("preset") && l.includes("选择理由"));
  if (!presetRule) err(skillPath, sec ? sec.start + 1 : 1, "§5 缺“每段自选 preset + 选择理由”");
  const refPath = "skills/sdo-flow/references/07-边界与自证.md";
  const ref = read(refPath);
  const ok7 = ref.find((l) => !isComment(l) && l.includes("口头授权") && l.includes("流程放行") && (l.includes("≠") || l.includes("不等于")));
  if (!ok7) err(refPath, 1, "缺“口头授权≠流程放行”边界（须同一行、含 ≠ 或 不等于）");
}


function planSignUnsigned(mid) {
  const dir = path.join(ROOT, ".sdo/sign");
  if (!fs.existsSync(dir)) return null;
  const n2 = String(mid).replace(/^M/, "");
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^S\d+(?:-[A-Z])?\.md$/.test(x))) {
    const lines = read(path.join(".sdo/sign", f));
    const title = lines[0] || "";
    const scope = lines.find((l) => l.startsWith("- 范围：")) || "";
    if (!(new RegExp(`M${n2}\\s*计划`).test(title) || new RegExp(`M${n2}\\s*计划`).test(scope))) continue;
    hits.push({ f });
  }
  if (!hits.length) return null;
  const rank = (f) => {
    const m = /^S(\d+)(?:-([A-Z]))?\.md$/.exec(f);
    return m ? [Number(m[1]), m[2] ? m[2].charCodeAt(0) : 0] : [Infinity, 0];
  };
  hits.sort((a, b) => {
    const ra = rank(a.f), rb = rank(b.f);
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
  const latest = hits[hits.length - 1].f;
  const verdict = parseVerdict(read(path.join(".sdo/sign", latest)));
  return { file: latest, unsigned: isUnsignedVerdict(verdict) };
}

function checkPlan() {
  const milestone = planMilestone();
  if (archiveEntry(ROOT, milestone)) {
    console.log(`${milestone} 已归档，跳过（.sdo/archive/${milestone}/）`);
    process.exit(0);
  }
  const idxRow = archiveRows(ROOT).find((r) => r.milestone === milestone);
  if (idxRow && !ARCHIVE_STATUSES.includes(idxRow.status)) {
    console.log(`ERROR .sdo/archive/INDEX.md:0: archive_index_invalid：${milestone} 的 INDEX 状态非法（${idxRow.status}；只认 已归档/已恢复）`);
    console.log(`\n检查完成（--plan ${milestone}）：1 个漂移`);
    process.exit(1);
  }
  if (orphanArchiveDirs(ROOT).includes(milestone)) {
    console.log(`ERROR .sdo/archive/INDEX.md:0: archive_orphan_directory：${milestone} 归档目录有文件但 INDEX 无对应行（先补 INDEX 或 restore）`);
    console.log(`\n检查完成（--plan ${milestone}）：1 个漂移`);
    process.exit(1);
  }
  if (!exists(milestonePath(milestone))) {
    planExit2(`里程碑文件不存在：${milestonePath(milestone)}`);
  }
  if (ARGV.includes("--print-frozen-hash")) {
    console.log(frozenHashRaw(read(milestonePath(milestone)).join("\n")));
    process.exit(0);
  }
  const table = planCardTable(milestone);
  const archivedIds = archivedCardIds();
  const planPath = milestonePath(milestone);
  const msLines = read(planPath);
  checkPlanRules(milestone, planPath);
  checkHandwritingSuspicion(milestone);
  const liveRows = table.rows.filter((r) => !archivedIds.has(r.id));
  const tableIds = new Set(liveRows.map((r) => r.id));

  // C1 双向一致
  const cardIds = fs.readdirSync(path.join(ROOT, ".sdo/cards"))
    .filter((f) => new RegExp(`^${milestone}-(?:\\d+|G)\\.md$`).test(f))
    .map((f) => f.replace(/\.md$/, ""));
  for (const r of liveRows) if (!exists(`.sdo/cards/${r.id}.md`)) err(planPath, r.line, `卡表有卡无文件：${r.id}`);
  for (const id of cardIds) if (!tableIds.has(id)) err(`.sdo/cards/${id}.md`, 1, `卡不在本里程碑卡表：${id}`);

  const infos = new Map();
  for (const r of liveRows) infos.set(r.id, planCardInfo(r.id));
  for (const id of cardIds) if (!infos.has(id)) infos.set(id, planCardInfo(id));

  // C2 依赖 / C3 路径 / C6 写域
  for (const r of liveRows) {
    const info = infos.get(r.id);
    if (!info) continue;
    const planDeps = planParseDeps(r.deps);
    const cardDeps = planParseDeps(info.depRaw);
    const a = [...planDeps].sort(), b = [...cardDeps].sort();
    if (a.join() !== b.join()) {
      err(`.sdo/cards/${r.id}.md`, info.depLine || 1, `依赖与计划卡表不一致：卡表=[${a.join("、")}] 卡面=[${b.join("、")}]`);
    }
    const myM = Number(r.id.match(/^M(\d+)-/)[1]);
    const myN = /-(\d+)$/.test(r.id) ? Number(r.id.match(/-(\d+)$/)[1]) : Number.POSITIVE_INFINITY;
    for (const d of cardDeps) {
      const dm = d.match(/^M(\d+)-(\d+)$/);
      if (!dm || Number(dm[1]) !== myM) continue;
      if (Number(dm[2]) > myN) err(`.sdo/cards/${r.id}.md`, info.depLine || 1, `前向依赖：${r.id} 依赖 ${d}（在本卡之后）`);
    }

    const scopes = [...info.scopeItems, ...info.readItems].map((s) => normalizePlanPath(s)).filter((s) => s.p);
    let inC3 = false;
    for (let i = 0; i < info.lines.length; i++) {
      const l = info.lines[i];
      if (/^##\s/.test(l)) { inC3 = /^##\s*(?:判据|证据|预览)\s*$/.test(l); continue; }
      if (!inC3) continue;
      if (/反例|示例|例如|对照/.test(l)) continue;
      for (const span of l.matchAll(/`([^`]+)`/g)) {
        const p = planBacktickPath(span[1]);
        if (p && !planCovers(p, scopes)) err(`.sdo/cards/${r.id}.md`, i + 1, `判据点名的路径不在 write_scope/read_refs：${p}`);
      }
    }

    const planScope = splitScope(r.scope)
      .filter((x) => !/运行时/.test(x))
      .map((s) => normalizePlanPath(s)).filter((s) => s.p).map((s) => s.p).sort();
    const cardScope = info.scopeItems
      .filter((x) => !/运行时/.test(x))
      .map((s) => normalizePlanPath(s)).filter((s) => s.p).map((s) => s.p).sort();
    if (planScope.join() !== cardScope.join()) {
      err(`.sdo/cards/${r.id}.md`, info.scopeLine || 1, `write_scope 与计划卡表不一致：计划=[${planScope.join("、")}] 卡面=[${cardScope.join("、")}]`);
    }
  }

  for (const e of ERR) console.log(`ERROR ${e}`);
  const unsigned = planSignUnsigned(milestone);
  if (unsigned && unsigned.unsigned) {
    console.log(`WARN plan_sign_unsigned：计划签仍是草案（${unsigned.file}），0 漂移只证明与草案记录一致，不能作为签前判据`);
  }
  console.log(`\n检查完成（--plan ${milestone}）：${ERR.length} 个漂移`);
  process.exit(ERR.length ? 1 : 0);
}

function checkTrace() {
  const t = analyzeTrace(ROOT);
  const js = ARGV.includes("--js");
  if (js) {
    const rank = { trace_orphan_requirement: 0, trace_dangling_ref: 1, trace_duplicate_claim: 2, trace_orphan_test: 3, trace_test_unverifiable: 4, pending_change_request: 5, explore_conclusion_malformed: 6 };
    const issues = [...t.issues].sort((a, b) => (rank[a.code] ?? 9) - (rank[b.code] ?? 9))
      .map((i) => ({ code: i.code, id: i.id ?? (/^(R-\d+|M\d+-[\w-]+)/.exec(i.message) || [])[1] ?? null, file: i.file }));
    console.log(JSON.stringify({ ok: issues.length === 0, counts: { requirements: t.counts.requirements, covered: t.counts.covered, cardRefs: t.counts.edges, orphanRequirements: t.counts.orphanRequirements, orphanCards: t.counts.orphanCards }, issues }));
    process.exit(issues.length ? 1 : 0);
  }
  console.log(`需求数：${t.counts.requirements}`);
  console.log(`已覆盖数：${t.counts.covered}`);
  console.log(`卡引用数：${t.counts.edges}`);
  console.log(`孤儿需求数：${t.counts.orphanRequirements}`);
  console.log(`孤儿卡数：${t.counts.orphanCards}`);
  const rank = { trace_orphan_requirement: 0, trace_dangling_ref: 1, trace_duplicate_claim: 2, trace_orphan_test: 3, trace_test_unverifiable: 4, pending_change_request: 5, explore_conclusion_malformed: 6 };
  const issues = [...t.issues].sort((a, b) => (rank[a.code] ?? 9) - (rank[b.code] ?? 9));
  for (const i of issues) err(i.file, i.line, `${i.code}：${i.message}`);
  for (const e of ERR) console.log(`ERROR ${e}`);
  console.log(`\n检查完成（--trace）：${issues.length} 个问题`);
  process.exit(issues.length ? 1 : 0);
}

if (ARGV.includes("--plan")) {
  checkPlan();
}
if (ARGV.includes("--trace")) {
  checkTrace();
}
const files = mdFiles();
const ledgerHasIndex = exists(".sdo/.index/ledger.json");
for (const p of files) {
  if (ledgerHasIndex && p === ".sdo/台账.md") continue; // 卷内容由索引 sha256 闭环，不逐行解析
  checkTables(p, read(p));
}
checkFrontmatter();
checkAuthorizationText();
checkR25Docs();
checkBaselineTemplate();
checkBaselineArtifacts();
checkCardTemplateDecisions();
checkLedger(".sdo/台账.md"); // 活跃卷始终做行级校验（关账/kind/status/id）；归档卷在 --deep 下同样校验
checkLedgerVolumes(ARGV.includes("--deep")); checkSigns(); checkCards(); checkCardStateMismatch(); checkAppendSignAnchors(); checkReadings(); checkArchive(); checkHandwritingSuspicion();
checkCriterionBasis();
const activeUnsigned = currentMilestone(ROOT) ? planSignUnsigned(currentMilestone(ROOT)) : null;
if (activeUnsigned && activeUnsigned.unsigned) {
  warn(`.sdo/sign/${activeUnsigned.file}`, 0, `plan_sign_unsigned：计划签仍是草案，0 漂移只证明与草案记录一致，不能作为签前判据`);
}
if (ARGV.includes("--presets")) checkPresets();
if (ARGV.includes("--js")) {
  console.log(JSON.stringify({ ok: ERR.length === 0, errors: ERR, warnings: WARN }));
} else {
  for (const w of WARN) console.log(`WARN  ${w}`);
  for (const e of ERR) console.log(`ERROR ${e}`);
  console.log(`\n检查完成：${files.length} 个 Markdown，${ERR.length} 个错误，${WARN.length} 个警告`);
}
process.exit(ERR.length ? 1 : 0);
