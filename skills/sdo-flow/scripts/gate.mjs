#!/usr/bin/env node
// 门禁检查：把某张出口勾选表（.sdo/gates/<M>.md）与计划里的 preset 逐条对账。
//
// 用法（项目内任意目录）：
//   node <skill>/scripts/gate.mjs                 # 列出计划里引用的 gate 与现有勾选表状态
//   node <skill>/scripts/gate.mjs G_frame_exit    # 检查指定 gate（按 gate id 找到对应文件/段落）
//   node <skill>/scripts/gate.mjs --file .sdo/gates/M1.md
//   node <skill>/scripts/gate.mjs G_frame_exit --json
//
// 退出码：0 = 全 pass（或 partial 已被本表人签接受）；1 = 有 fail / 缺项 / 证据为空 / 缺签；2 = 用法或环境错误。
// 它只做“对账与格式”，不判断证据真假——但会拒绝“空证据”“占位判定”“只写看过”这三种最常见的假绿。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes("--json");
const die = (msg) => { console.error(`ERROR ${msg}`); process.exit(2); };

function findRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, ".sdo"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
const ROOT = findRoot();
if (!ROOT) die("找不到 .sdo/（请在项目内运行，或先建 .sdo/）");
const SELF = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ---------- 小工具：按行内代码切表 ----------
function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = []; let cur = "", code = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "`") { let j = i; while (t[j + 1] === "`") j++; cur += t.slice(i, j + 1); if (j - i + 1 < 3) code = !code; i = j; continue; }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l || "");

// ---------- 计划：preset 与 gate 清单 ----------
function planInfo() {
  const p = ".sdo/01-计划.md";
  if (!fs.existsSync(path.join(ROOT, p))) return null;
  const text = read(p);
  const preset = (text.match(/preset[:：]\s*`?([a-z-]+)`?/i) || [])[1] || null;
  const gates = [...new Set([...text.matchAll(/\b(G_[a-z_]+)\b/g)].map((m) => m[1]))];
  return { preset, gates };
}

function presetCriteria(preset) {
  if (!preset) return null;
  const f = path.join(SELF, "presets", `${preset}.md`);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, "utf8");
  const out = {};
  for (const m of text.matchAll(/id:\s*(G_[a-z_]+)([^}]*?)criteria:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[3].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]);
  }
  return Object.keys(out).length ? out : null;
}

// ---------- 勾选表文件 ----------
function gateFiles() {
  const d = path.join(ROOT, ".sdo/gates");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort().map((f) => rel(path.join(d, f)));
}

// 抽出某个 gate 的勾选表行：优先找含该 gate id 的段落；文件整体只有一张表时直接用
function parseGateFile(file, gateId) {
  const lines = read(file).split(/\r?\n/);
  let start = 0, end = lines.length;
  if (gateId) {
    const hits = lines.map((l, i) => (l.includes(gateId) ? i : -1)).filter((i) => i >= 0);
    // 单 gate 文件允许不写 gate id（模板默认）：整份当作该 gate 的表
    if (!hits.length) { start = 0; end = lines.length; }
    start = Math.min(...hits);
    const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l.trim()) && /\bG_[a-z_]+\b/.test(l));
    end = next < 0 ? lines.length : next;
  }
  const rows = [];
  for (let i = start; i < end; i++) {
    const l = lines[i].trim();
    if (!l.startsWith("|") || isSep(l)) continue;
    const c = cells(l);
    if (!c.length) continue;
    if (/^(#|判据|编号)$/.test(c[0]) || /判据说明/.test(c[1] || "")) continue; // 表头
    rows.push(c);
  }
  return rows;
}

// 判定列：取最后出现 pass/partial/fail 的格；证据列取含命令/文件:行的格
function judgeRow(cellsArr) {
  const norm = (x) => (x || "").toLowerCase();
  let verdict = "";
  for (const c of cellsArr) { const m = norm(c).match(/\b(pass|partial|fail)\b/); if (m) verdict = m[1]; }
  const plain = (x) => (x || "").replace(/`/g, "");
  const crit = plain(cellsArr[0]).match(/[a-z_]+\.[a-z_]+/)?.[0] || plain(cellsArr[1]).match(/[a-z_]+\.[a-z_]+/)?.[0] || "";
  const evidence = cellsArr.find((c) => /`|文件:|:\d+/.test(c) && !/\b(pass|partial|fail)\b/i.test(c)) || "";
  return { crit, verdict, evidence };
}

const CORE = ["spec_set.signed", "assumption_set.signed", "provenance.present"];
const PLACEHOLDERS = /^(|<.*>|—|-|无|略|无证据|todo|tbd|待补|看过了)$/i;

function checkGate(file, gateId, wantCriteria, problems, warnings) {
  const rows = parseGateFile(file, gateId);
  if (!rows) { problems.push(`${file}: 找不到 gate ${gateId} 的勾选表`); return { rows: [], fails: [], partials: [] }; }
  const seen = new Map();
  for (const r of rows) {
    const j = judgeRow(r);
    if (!j.crit) {
      // 允许“说明行”（没有判据名），但判定列必须有值，否则算缺项
      if (!j.verdict) problems.push(`${file}: 有一行既没有判据名也没有判定`);
      continue;
    }
    if (seen.has(j.crit)) warnings.push(`${file}: 判据重复出现 ${j.crit}`);
    seen.set(j.crit, j);
  }
  for (const [crit, j] of seen) {
    if (!j.verdict) problems.push(`${file}: ${crit} 没有判定（pass/partial/fail）`);
    else if (j.verdict === "pass" && (!j.evidence || PLACEHOLDERS.test(j.evidence.trim())))
      problems.push(`${file}: ${crit} 判 pass 但证据为空/占位（证据必须是命令或 文件:行）`);
    else if (j.verdict === "partial" && (!j.evidence || PLACEHOLDERS.test(j.evidence.trim())))
      problems.push(`${file}: ${crit} 判 partial 但没写证据与缺口`);
  }
  if (wantCriteria) {
    for (const c of wantCriteria) if (!seen.has(c)) problems.push(`${file}: 缺判据 ${c}（preset 的 gate 要求）`);
    for (const c of seen.keys()) if (!wantCriteria.includes(c)) warnings.push(`${file}: 多出 preset 没有的判据 ${c}`);
  }
  for (const c of CORE) {
    const j = seen.get(c);
    if (!j) problems.push(`${file}: 缺 core 判据 ${c}`);
    else if (j.verdict && j.verdict !== "pass") problems.push(`${file}: core 判据 ${c} 不是 pass（${j.verdict}）`);
  }
  const fails = [...seen.values()].filter((j) => j.verdict === "fail").map((j) => j.crit);
  const partials = [...seen.values()].filter((j) => j.verdict === "partial").map((j) => j.crit);
  return { rows: [...seen.entries()].map(([crit, j]) => ({ crit, ...j })), fails, partials };
}

// 人签接受 partial：第 3 节存在且选项以“签：”开头
function signatureAcceptsPartial(file, text) {
  const sec = text.split(/^##\s*3\./m)[1] || "";
  return /^\s*[-*]?\s*选项[：:]\s*[*_`]*\s*签[：:]/m.test(sec);
}

// ---------- 主流程 ----------
const plan = planInfo();
const byFile = ARGV.includes("--file") ? ARGV[ARGV.indexOf("--file") + 1] : null;
const wanted = ARGV.find((a) => /^G_[a-z_]+$/.test(a)) || null;

if (ARGV.includes("--list") || (!byFile && !wanted)) {
  const crit = presetCriteria(plan?.preset);
  const files = gateFiles();
  const lines = [];
  lines.push(`preset：${plan?.preset || "（计划里没写 preset）"}`);
  lines.push(`计划提到的 gate：${plan?.gates.length ? plan.gates.join("、") : "（无）"}`);
  lines.push(`勾选表文件：${files.length ? files.join("、") : "（无）"}`);
  if (crit) lines.push(`preset 的 gate：${Object.keys(crit).join("、")}`);
  if (JSON_OUT) console.log(JSON.stringify({ preset: plan?.preset, planGates: plan?.gates, files, presetGates: crit ? Object.keys(crit) : [] }, null, 2));
  else console.log(lines.join("\n"));
  if (!files.length) { console.error("ERROR 没有 .sdo/gates/*.md：阶段门还没有勾选表（模板 templates/gates.md）"); process.exit(1); }
  process.exit(0);
}

const problems = [], warnings = [], results = [];
const targets = byFile ? [byFile] : gateFiles();
if (!targets.length) die("没有 .sdo/gates/*.md");

const critMap = presetCriteria(plan?.preset);
for (const f of targets) {
  if (!fs.existsSync(path.join(ROOT, f))) die(`文件不存在：${f}`);
  const text = read(f);
  const gids = wanted ? [wanted] : [...new Set([...text.matchAll(/\b(G_[a-z_]+)\b/g)].map((m) => m[1]))];
  if (!gids.length) { problems.push(`${f}: 找不到 gate id（应写 G_xxx）`); continue; }
  for (const gid of gids) {
    const want = critMap?.[gid] || null;
    const r = checkGate(f, gid, want, problems, warnings);
    if (r && r.rows.length) {
      if ((r.partials.length || r.fails.length) && !signatureAcceptsPartial(f, text))
        problems.push(`${f}: ${gid} 有 ${r.fails.length ? "fail" : "partial"} 项（${[...r.fails, ...r.partials].join("、")}）但本表第 3 节没有「选项：签：…」接受它`);
      results.push({ file: f, gate: gid, pass: r.rows.filter((x) => x.verdict === "pass").length, partial: r.partials.length, fail: r.fails.length });
    }
  }
}

const ok = problems.length === 0;
if (JSON_OUT) {
  console.log(JSON.stringify({ ok, results, problems, warnings }, null, 2));
} else {
  for (const r of results) console.log(`${r.gate}  (${r.file})  pass ${r.pass} / partial ${r.partial} / fail ${r.fail}`);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const p of problems) console.log(`ERROR ${p}`);
  console.log(ok ? "门禁检查通过（全部 pass，或 partial 已被本表人签接受）" : `门禁未通过：${problems.length} 个问题`);
}
process.exit(ok ? 0 : 1);
