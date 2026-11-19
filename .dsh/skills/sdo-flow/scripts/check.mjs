#!/usr/bin/env node
// sdo-flow 文本检查器（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目根）：node .dsh/skills/sdo-flow/scripts/check.mjs [--presets]
// 退出码：0 全过；1 有错误；2 不是 sdo 项目根。只读，不改文件。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const ERR = [], WARN = [];
const KINDS = new Set(["gap", "defect", "explain"]);
const STATUS = new Set(["open", "accepted", "fixed", "closed"]);
const err = (p, l, m) => ERR.push(`${p}:${l}: ${m}`);
const warn = (p, l, m) => WARN.push(`${p}:${l}: ${m}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").split(/\r?\n/);

function mdFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "lib") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".md")) out.push(rel);
    }
  })("");
  return out;
}

function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const out = [];
  let cur = "", esc = false, code = false;
  for (const ch of s) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "`") { code = !code; cur += ch; continue; }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
const isSep = (l) => l !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(l);

function checkTables(p, lines) {
  let tbl = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim(), ln = i + 1;
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
  if (!fs.existsSync(path.join(ROOT, p))) return err(p, 0, "缺文件");
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
  const seen = [];
  for (let i = hdrAt + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const c = cells(lines[i].trim());
    if (c.length !== 7) continue;
    const id = c[cols.id].replace(/`/g, "").trim();
    if (!/^D-\d+$/.test(id)) { err(p, i + 1, `id 不合法：${id}（应为 D-<数字>）`); continue; }
    if (seen.includes(id)) err(p, i + 1, `id 重复：${id}`);
    if (seen.length && +id.slice(2) <= +seen.at(-1).slice(2)) err(p, i + 1, `id 未递增：${id} 在 ${seen.at(-1)} 之后`);
    seen.push(id);
    if (!KINDS.has(c[cols.kind])) err(p, i + 1, `kind 不合法：${c[cols.kind]}`);
    if (!STATUS.has(c[cols.status])) err(p, i + 1, `状态不合法：${c[cols.status]}`);
    if (c[cols.kind] === "defect" && c[cols.status] === "open") warn(p, i + 1, `${id} 是未修 defect`);
    if (!c[cols.where]) err(p, i + 1, "位置为空");
  }
}

function checkSigns() {
  const d = "sdo/sign";
  if (!fs.existsSync(path.join(ROOT, d))) return err(d, 0, "缺签字目录");
  const files = fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) err(d, 0, "没有签字文件");
  for (const f of files) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    for (const k of ["时间", "选项", "被签对象"]) {
      if (!new RegExp(`^\\s*-?\\s*${k}[:：]\\s*\\S`, "m").test(text)) err(p, 0, `缺字段或值为空：${k}（应写成「- ${k}：…」）`);
    }
    if (!/选项[:：].*(签|改|不签)/.test(text)) err(p, 0, "选项不是三选一（签/改/不签）");
  }
}

function checkCards() {
  const d = "sdo/cards";
  if (!fs.existsSync(path.join(ROOT, d))) return warn(d, 0, "还没有卡（里程碑早期可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    for (const s of ["## 判据", "## 证据"]) if (!text.includes(s)) err(p, 0, `缺段落：${s}`);
    if (!/^status:\s*(open|done)/m.test(text)) err(p, 0, "缺 status: open|done");
    if (!text.includes("判定")) err(p, 0, "缺「判定」段");
  }
}

function checkReadings() {
  const d = "sdo/readings";
  if (!fs.existsSync(path.join(ROOT, d))) return warn(d, 0, "还没有读数（里程碑门前可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    if (!/overall/i.test(text)) err(p, 0, "缺 overall 判定");
    if (!/\b(pass|partial|fail)\b/i.test(text)) err(p, 0, "缺逐条 verdict（pass/partial/fail）");
  }
}

function checkPresets() {
  let doc;
  try {
    doc = execFileSync("git", ["show", "main:docs/08-方法论与策略.md"], { cwd: ROOT, encoding: "utf8" });
  } catch { return warn("presets", 0, "取不到 main:docs/08，跳过与设计的比对"); }
  const gates = (text) => {
    const out = {};
    for (const m of text.matchAll(/(G_[a-z_]+):\s*\{([\s\S]*?)\}/g)) {
      const cm = m[2].match(/criteria:\s*\[([\s\S]*?)\]/);
      if (cm) out[m[1]] = [...cm[1].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]);
    }
    return out;
  };
  const want = gates(doc);
  for (const f of ["waterfall.md", "prototype.md", "incremental.md"]) {
    const p = `.dsh/skills/sdo-flow/presets/${f}`;
    const text = read(p).join("\n");
    for (const m of text.matchAll(/id:\s*(G_[a-z_]+)[^}]*?criteria:\s*\[([^\]]*)\]/g)) {
      const got = [...m[2].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]);
      if (!want[m[1]]) { warn(p, 0, `${m[1]} 在 docs/08 里找不到`); continue; }
      if (got.join() !== want[m[1]].join()) err(p, 0, `${m[1]} 的 criteria 与 docs/08 不一致（本文件 ${got.length} 条，设计 ${want[m[1]].length} 条）`);
    }
  }
}

if (!fs.existsSync(path.join(ROOT, "sdo"))) {
  console.error("sdo/ 不存在：这不是一个按 sdo-flow 初始化的项目"); process.exit(2);
}
for (const p of ["sdo/00-意图.md", "sdo/01-计划.md", "sdo/台账.md"]) {
  if (!fs.existsSync(path.join(ROOT, p))) err(p, 0, "缺必需文件");
}
const files = mdFiles();
for (const p of files) checkTables(p, read(p));
checkLedger("sdo/台账.md"); checkSigns(); checkCards(); checkReadings();
if (process.argv.includes("--presets")) checkPresets();
for (const w of WARN) console.log(`WARN  ${w}`);
for (const e of ERR) console.log(`ERROR ${e}`);
console.log(`\n检查完成：${files.length} 个 Markdown，${ERR.length} 个错误，${WARN.length} 个警告`);
process.exit(ERR.length ? 1 : 0);
