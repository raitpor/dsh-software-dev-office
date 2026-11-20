#!/usr/bin/env node
// 里程碑归档：把已收口里程碑的卡/评审/读数/出口表搬进 .sdo/archive/<M>/。
// 用法（项目内任意目录）：node <skill>/scripts/archive.mjs archive M3 | restore M3
// 归档索引：.sdo/archive/INDEX.md（每行一个里程碑，含门签号、被签树、文件数与逐文件 sha256）
// 纪律：只搬 .sdo/cards/M<M>-*、.sdo/review/<M>-*、.sdo/readings/<M>.md、.sdo/gates/<M>.md；
//       不搬 sign/ 与 台账.md；一律 git mv（索引显示 rename）；不删内容、不改历史。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function findRoot(start) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, ".sdo"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
const ROOT = findRoot(process.cwd());
if (!ROOT) { console.error("找不到 .sdo/：请在本项目内运行"); process.exit(2); }
const INDEX = ".sdo/archive/INDEX.md";
const HEADER = ["里程碑", "门签号", "被签树", "文件数", "文件 sha256", "状态"];
const INDEX_ALIAS = { 里程碑: "milestone", 门签号: "gate", 被签树: "tree", 文件数: "count", "文件 sha256": "manifest", 状态: "status" };

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, p))).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((x) => x.trim());
}
function escCell(s) { return String(s).replace(/\|/g, "\\|").replace(/\n/g, " "); }
function isSep(l) { return l !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(l); }

function parseIndex() {
  if (!exists(INDEX)) return [];
  const ls = read(INDEX).split(/\r?\n/);
  const h = ls.findIndex((l) => l.trim().startsWith("|") && l.includes("里程碑"));
  if (h < 0) return [];
  const header = cells(ls[h]).map((x) => x.replace(/`/g, "").trim());
  const map = Object.fromEntries(header.map((x, i) => [INDEX_ALIAS[x] || x, i]));
  const rows = [];
  for (let i = h + 1; i < ls.length; i++) {
    const raw = ls[i].trim();
    if (!raw.startsWith("|")) break;
    if (isSep(raw)) continue;
    const c = cells(raw);
    if (!c[map.milestone]) continue;
    let manifest = {};
    try { manifest = JSON.parse((c[map.manifest] || "{}").replace(/`/g, "")); } catch { manifest = {}; }
    rows.push({ milestone: c[map.milestone], gate: c[map.gate] || "-", tree: c[map.tree] || "-", count: c[map.count] || "", manifest, status: c[map.status] || "" });
  }
  return rows;
}

function writeIndex(rows) {
  const out = ["# 归档索引", "", `| ${HEADER.join(" | ")} |`, `|${HEADER.map(() => "---").join("|")}|`];
  for (const r of rows) {
    out.push(`| ${r.milestone} | ${r.gate} | ${r.tree} | ${r.count} | ${escCell(JSON.stringify(r.manifest))} | ${r.status} |`);
  }
  fs.mkdirSync(path.join(ROOT, ".sdo/archive"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, INDEX), `${out.join("\n")}\n`);
}

function sourceFiles(m) {
  const out = [];
  const add = (p) => { if (exists(p) && fs.statSync(path.join(ROOT, p)).isFile()) out.push(p); };
  if (exists(".sdo/cards")) {
    for (const f of fs.readdirSync(path.join(ROOT, ".sdo/cards"))) {
      if (new RegExp(`^${m}-(?:\\d+|G)\\.md$`).test(f)) add(`.sdo/cards/${f}`);
    }
  }
  if (exists(".sdo/review")) {
    for (const f of fs.readdirSync(path.join(ROOT, ".sdo/review"))) {
      if (f.startsWith(`${m}-`) && f.endsWith(".md")) add(`.sdo/review/${f}`);
    }
  }
  add(`.sdo/readings/${m}.md`);
  add(`.sdo/gates/${m}.md`);
  return out.sort();
}

function gateInfo(m) {
  if (!exists(".sdo/sign")) return { gate: "-", tree: "-" };
  for (const f of fs.readdirSync(path.join(ROOT, ".sdo/sign")).filter((x) => x.endsWith(".md")).sort().reverse()) {
    const text = read(`.sdo/sign/${f}`);
    const title = (text.match(/^#\s*(.+)$/m) || [])[1] || "";
    if (!new RegExp(`\\b${m}\\s*门`).test(title)) continue;
    const sn = (title.match(/^S[\d-]+/i) || f.match(/^S\d+/i) || [])[0] || f.replace(/\.md$/, "");
    const direct = (text.match(/被签对象[:：]\s*`?([0-9a-f]{7,40})`?/i) || [])[1];
    const fallback = (text.match(/commit\s+`?([0-9a-f]{7,40})`?/i) || [])[1];
    return { gate: sn, tree: direct || fallback || "-（未识别）" };
  }
  return { gate: "-", tree: "-" };
}

function archive(m) {
  if (parseIndex().some((r) => r.milestone === m && r.status === "已归档")) {
    console.error(`里程碑 ${m} 已在归档中；先 restore 再 archive`);
    process.exit(1);
  }
  const files = sourceFiles(m);
  if (!files.length) { console.error(`里程碑 ${m} 没有可归档文件`); process.exit(1); }
  const destDir = `.sdo/archive/${m}`;
  fs.mkdirSync(path.join(ROOT, destDir), { recursive: true });
  const manifest = {};
  for (const src of files) {
    const base = path.basename(src);
    const dst = `${destDir}/${src.slice(".sdo/".length)}`;
    if (exists(dst)) { console.error(`目标已存在：${dst}`); process.exit(1); }
  }
  for (const src of files) {
    const base = path.basename(src);
    const dst = `${destDir}/${src.slice(".sdo/".length)}`;
    fs.mkdirSync(path.dirname(path.join(ROOT, dst)), { recursive: true });
    try { git(["mv", "--", src, dst]); }
    catch (e) { console.error(`git mv 失败：${src}\n${String(e.stderr || e.message).trim()}`); process.exit(1); }
    manifest[src.slice(".sdo/".length)] = sha256(dst);
  }
  const gi = gateInfo(m);
  const rows = parseIndex().filter((r) => r.milestone !== m);
  rows.push({ milestone: m, gate: gi.gate, tree: gi.tree, count: String(files.length), manifest, status: "已归档" });
  rows.sort((a, b) => a.milestone.localeCompare(b.milestone, undefined, { numeric: true }));
  writeIndex(rows);
  console.log(`已归档 ${m}：${files.length} 个文件 → ${destDir}（索引 ${INDEX}）`);
}

function restore(m) {
  const rows = parseIndex();
  const row = rows.find((r) => r.milestone === m);
  if (!row) { console.error(`索引里没有里程碑 ${m}`); process.exit(2); }
  if (row.status === "已恢复") { console.error(`里程碑 ${m} 已恢复`); process.exit(1); }
  const entries = Object.entries(row.manifest);
  if (!entries.length) { console.error(`里程碑 ${m} 的 manifest 为空`); process.exit(1); }
  for (const [key, hash] of entries) {
    const src = `.sdo/archive/${m}/${key}`;
    if (!exists(src)) { console.error(`归档文件缺失：${src}（未搬任何文件，索引未改）`); process.exit(1); }
    const actual = sha256(src);
    if (actual !== hash) { console.error(`归档文件哈希不符：${src}\nmanifest=${hash}\nactual=${actual}（未搬任何文件）`); process.exit(1); }
  }
  for (const [key] of entries) {
    const src = `.sdo/archive/${m}/${key}`;
    const dst = `.sdo/${key}`;
    fs.mkdirSync(path.dirname(path.join(ROOT, dst)), { recursive: true });
    try { git(["mv", "--", src, dst]); }
    catch (e) { console.error(`git mv 失败：${src}\n${String(e.stderr || e.message).trim()}`); process.exit(1); }
  }
  try { fs.rmdirSync(path.join(ROOT, `.sdo/archive/${m}`)); } catch { /* 非空则保留 */ }
  row.status = "已恢复";
  writeIndex(rows);
  console.log(`已恢复 ${m}：${entries.length} 个文件（索引标记已恢复）`);
}

const [cmd, target] = process.argv.slice(2);
if (!/^archive|restore$/.test(cmd || "") || !/^M\d+$/.test(target || "")) {
  console.error("用法：archive.mjs archive <M3> | restore <M3>");
  process.exit(2);
}
try {
  if (cmd === "archive") archive(target);
  else restore(target);
} catch (e) {
  console.error(`归档操作失败：${e.message}`);
  process.exit(1);
}
