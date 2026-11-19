#!/usr/bin/env node
// sdo-flow 文本检查器（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目内任意目录）：node <skill>/scripts/check.mjs [--presets [判据源文件]]
// 退出码：0 全过；1 有错误；2 找不到 .sdo/。只读，不改文件。
// --presets 不带参数：校验三份 preset 自洽（stage/gate 唯一、kinds 合法、criteria 非空、条数与发布快照一致）
// --presets <文件>：与外部判据源逐条比对（可用设计稿的 §1.1 原文）
import fs from "node:fs";
import path from "node:path";
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
if (!ROOT) { console.error("找不到 .sdo/：请在本项目内运行，或先按 sdo-flow 初始化"); process.exit(2); }
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
  const d = ".sdo/sign";
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
  const d = ".sdo/cards";
  if (!fs.existsSync(path.join(ROOT, d))) return warn(d, 0, "还没有卡（里程碑早期可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    for (const s of ["判据", "证据", "判定", "评审"]) if (!new RegExp("^##\\s*" + s + "(?:\\s|$)", "m").test(text)) err(p, 0, `缺段落：## ${s}`);
    if (!/^status:\s*(open|done)/m.test(text)) err(p, 0, "缺 status: open|done");
  }
}

function checkReadings() {
  const d = ".sdo/readings";
  if (!fs.existsSync(path.join(ROOT, d))) return warn(d, 0, "还没有读数（里程碑门前可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    if (!/overall/i.test(text)) err(p, 0, "缺 overall 判定");
    if (!/\b(pass|partial|fail)\b/i.test(text)) err(p, 0, "缺逐条 verdict（pass/partial/fail）");
  }
}

const PRESET_FILES = ["waterfall.md", "prototype.md", "incremental.md"];
const KNOWN_KINDS = new Set(["requirement", "design", "implement", "review", "deliver", "verify", "vet", "docs"]);
// 发布快照：与 skill 一起冻结的 gate 条数（改它要一次人签，不允许悄悄放宽）
const SNAPSHOT = { G_req_exit: 9, G_design_exit: 8, G_build_exit: 6, G_verify_exit: 5, G_deliver_exit: 6, G_explore_exit: 4, G_harden_exit: 19, G_req_design: 14, G_integrate: 6 };

function checkPresets() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--presets");
  const ext = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  let doc = null;
  if (ext) {
    if (!fs.existsSync(path.resolve(ROOT, ext))) return err("presets", 0, `判据源不存在：${ext}`);
    doc = fs.readFileSync(path.resolve(ROOT, ext), "utf8");
  }
  const docStages = {};
  if (doc) for (const m of doc.matchAll(/^\|\s*`(waterfall|prototype|incremental)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)) {
    docStages[m[1]] = {};
    for (const s of m[2].matchAll(/([a-z_]+)\[([^\]]*)\]/g)) docStages[m[1]][s[1]] = s[2].split(",").map((x) => x.trim()).filter(Boolean);
  }
  const docGates = {};
  if (doc) for (const m of doc.matchAll(/(G_[a-z_]+):\s*\{([\s\S]*?)\}/g)) {
    const cm = m[2].match(/criteria:\s*\[([\s\S]*?)\]/);
    if (cm) docGates[m[1]] = [...cm[1].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]);
  }

  for (const f of PRESET_FILES) {
    const key = f.replace(".md", "");
    const p = `skills/sdo-flow/presets/${f}`;
    const text = read(p).join("\n");

    const gotStages = {};
    for (const m of text.matchAll(/^###\s*`([a-z_]+)\[([^\]]*)\]`/gm)) {
      const sid = m[1], kinds = m[2].split(",").map((x) => x.trim()).filter(Boolean);
      if (gotStages[sid]) err(p, 0, `stage id 重复：${sid}`);
      gotStages[sid] = kinds;
      for (const k of kinds) if (!KNOWN_KINDS.has(k)) err(p, 0, `stage ${sid} 用了未知 kind：${k}`);
      if (!kinds.length) err(p, 0, `stage ${sid} 没有 kinds`);
    }
    if (!Object.keys(gotStages).length) err(p, 0, "没有任何 ### `sid[kinds]` 形式的 stage");

    const gates = [...text.matchAll(/id:\s*(G_[a-z_]+)([^}]*)criteria:\s*\[([^\]]*)\]/g)];
    const seen = new Set();
    for (const [, gid, , body] of gates) {
      if (seen.has(gid)) err(p, 0, `gate id 重复：${gid}`);
      seen.add(gid);
      const got = [...body.matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]);
      if (!got.length) err(p, 0, `${gid} 的 criteria 是空的（至少要有 core 三条）`);
      if (!got.includes("spec_set.signed")) err(p, 0, `${gid} 的 criteria 缺 core 判据 spec_set.signed`);
      const want = SNAPSHOT[gid];
      if (want === undefined) err(p, 0, `gate ${gid} 不在发布快照里（新 gate 要随 skill 版本一起人签）`);
      else if (got.length !== want) err(p, 0, `${gid} 的 criteria 有 ${got.length} 条，发布快照是 ${want} 条`);
      if (docGates[gid] && docGates[gid].join() !== got.join()) err(p, 0, `${gid} 的 criteria 与外部判据源不一致（本文件 ${got.length} 条，源 ${docGates[gid].length} 条）`);
    }
    for (const gid of Object.keys(docGates)) if (!text.includes(`id: ${gid}`)) err(p, 0, `缺 gate：${gid}（判据源有，本文件没有）`);

    if (doc) {
      const wantStages = docStages[key] || {};
      for (const [sid, kinds] of Object.entries(wantStages)) {
        if (!gotStages[sid]) err(p, 0, `缺 stage：${sid}（判据源有，本文件没有）`);
        else if (gotStages[sid].join() !== kinds.join()) err(p, 0, `stage ${sid} 的 kinds 与判据源不一致`);
      }
      for (const sid of Object.keys(gotStages)) if (!wantStages[sid]) err(p, 0, `多出判据源里没有的 stage：${sid}`);
      for (const [, gid] of gates) if (!docGates[gid]) err(p, 0, `多出判据源里没有的 gate：${gid}`);
    }
  }
  if (!ext) console.log("（preset 校验：自洽 + 发布快照；要与外部设计稿逐条比对请传 --presets <文件>）");
}

const files = mdFiles();
for (const p of files) checkTables(p, read(p));
checkLedger(".sdo/台账.md"); checkSigns(); checkCards(); checkReadings();
if (process.argv.includes("--presets")) checkPresets();
for (const w of WARN) console.log(`WARN  ${w}`);
for (const e of ERR) console.log(`ERROR ${e}`);
console.log(`\n检查完成：${files.length} 个 Markdown，${ERR.length} 个错误，${WARN.length} 个警告`);
process.exit(ERR.length ? 1 : 0);
