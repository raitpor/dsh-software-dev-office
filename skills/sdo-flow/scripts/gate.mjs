#!/usr/bin/env node
// 门禁检查：把某张出口勾选表（.sdo/gates/<M>.md）与计划里的 preset 逐条对账。
//
// 用法（项目内任意目录）：
//   node <skill>/scripts/gate.mjs                 # 默认：判所有勾选表（有 fail/缺项 ⇒ exit 1）
//   node <skill>/scripts/gate.mjs --list          # 只列出计划里引用的 gate 与现有勾选表
//   node <skill>/scripts/gate.mjs G_frame_exit    # 检查指定 gate（按 gate id 找到对应文件/段落）
//   node <skill>/scripts/gate.mjs --file .sdo/gates/M1.md
//   node <skill>/scripts/gate.mjs G_frame_exit --json
//
// 退出码：0 = 全 pass（或 partial 已被本表人签接受）；1 = 有 fail / 缺项 / 证据为空 / 缺签；2 = 用法或环境错误。
// 它只做“对账与格式”，不判断证据真假——但会拒绝“空证据”“占位判定”“只写看过”这三种最常见的假绿。

import fs from "node:fs";
import path from "node:path";
import { resolvePaths, skillPath } from "./lib/paths.mjs";

const ARGV = process.argv.slice(2);
if (ARGV.some((a) => a === "--help" || a === "-h")) {
  console.log("用法：node <skill>/scripts/gate.mjs init <M> | [--list] [G_xxx] [--file <path>] [--json]");
  console.log("  对账 .sdo/gates/ 勾选表与计划 preset：0=全 pass 或 partial 已人签接受；1=有 fail/缺项/缺签；2=用法/环境错误");
  process.exit(0);
}
const JSON_OUT = ARGV.includes("--json");
const die = (msg) => { console.error(`ERROR ${msg}`); process.exit(2); };

const PATHS = resolvePaths(process.cwd());
const ROOT = PATHS.projectRoot;
if (!ROOT) die("找不到 .sdo/（请在项目内运行；下一步：按 README 建 .sdo/ 与 意图.md/台账.md）");
const SKILL_ROOT = PATHS.skillRoot;
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
const MILESTONE_DIR = ".sdo/milestones";
function milestoneFiles() {
  const d = path.join(ROOT, MILESTONE_DIR);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^M\d+\.md$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}
function milestonePreset(m) {
  if (!m) return null;
  const p = `${MILESTONE_DIR}/${m}.md`;
  if (!fs.existsSync(path.join(ROOT, p))) return null;
  return (read(p).match(/preset[:：]\s*`?([a-z-]+)`?/i) || [])[1] || null;
}
function planInfo() {
  const files = milestoneFiles();
  if (!files.length) return null;
  const texts = files.map((f) => read(`${MILESTONE_DIR}/${f}`));
  let preset = null;
  for (const t of texts) { const m = t.match(/preset[:：]\s*`?([a-z-]+)`?/i); if (m) preset = m[1]; }
  const gates = [...new Set(texts.flatMap((t) => [...t.matchAll(/\b(G_[a-z0-9_]+)\b/g)].map((m) => m[1])))];
  return { preset, gates };
}

function presetCriteria(preset) {
  if (!preset) return null;
  const f = path.join(SKILL_ROOT, "presets", `${preset}.md`);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, "utf8");
  const out = {};
  for (const m of text.matchAll(/id:\s*(G_[a-z0-9_]+)([^}]*?)criteria:\s*\[([^\]]*)\]/g)) {
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
    const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l.trim()) && /\bG_[a-z0-9_]+\b/.test(l));
    end = next < 0 ? lines.length : next;
  }
  const rows = [];
  let idx = { crit: 0, verdict: -1, evidence: -1 };
  for (let i = start; i < end; i++) {
    const l = lines[i].trim();
    if (!l.startsWith("|") || isSep(l)) continue;
    const c = cells(l);
    if (!c.length) continue;
    if (/^(#|判据|编号)$/.test(c[0]) || /判据说明/.test(c[1] || "")) { idx = headerIndex(c); continue; } // 表头
    rows.push({ cells: c, line: i + 1 });
  }
  return { rows, idx };
}

// 列按表头定位：判定列=表头含“判定/结论/状态”，证据列=含“证据/命令/复跑”。取不到就报错，不猜。
function headerIndex(header) {
  const norm = (x) => (x || "").replace(/[\s`*_]/g, "");
  return {
    crit: header.findIndex((h) => /判据|检查项|条目/.test(norm(h))),
    verdict: header.findIndex((h) => /判定|结论|状态/.test(norm(h))),
    evidence: header.findIndex((h) => /证据|命令|复跑|依据/.test(norm(h))),
  };
}
function judgeRow(cellsArr, idx) {
  const verdictCell = idx.verdict >= 0 ? cellsArr[idx.verdict] || "" : "";
  const m = verdictCell.toLowerCase().match(/\b(pass|partial|fail)\b/);
  const plain = (x) => (x || "").replace(/`/g, "");
  const crit = plain(idx.crit >= 0 ? cellsArr[idx.crit] : cellsArr[0]).match(/[a-z_]+\.[a-z_]+/)?.[0] || "";
  const evidence = idx.evidence >= 0 ? (cellsArr[idx.evidence] || "") : "";
  return { crit, verdict: m ? m[1] : "", evidence };
}

const CORE = ["spec_set.signed", "assumption_set.signed", "provenance.present"];
const PLACEHOLDERS = /^(|<.*>|—|-|无|略|无证据|todo|tbd|待补|看过了)$/i;

function checkGate(file, gateId, wantCriteria, problems, warnings) {
  const parsed = parseGateFile(file, gateId);
  if (!parsed) { problems.push(`${file}: 找不到 gate ${gateId} 的勾选表`); return { rows: [], fails: [], partials: [] }; }
  const { rows, idx } = parsed;
  if (idx.verdict < 0) { problems.push(`${file}: ${gateId} 的表头里没有“判定/结论/状态”列（不能从别的列猜）`); return { rows: [], fails: [], partials: [] }; }
  if (idx.evidence < 0) { problems.push(`${file}: ${gateId} 的表头里没有“证据/命令/复跑/依据”列（不能从别的列猜）`); return { rows: [], fails: [], partials: [] }; }
  const seen = new Map();
  for (const r of rows) {
    const j = judgeRow(r.cells, idx);
    if (!j.crit) {
      // 允许“说明行”（没有判据名），但判定列必须有值，否则算缺项
      if (!j.verdict) problems.push(`${file}: 有一行既没有判据名也没有判定`);
      continue;
    }
    if (seen.has(j.crit)) warnings.push(`${file}: 判据重复出现 ${j.crit}`);
    seen.set(j.crit, { ...j, line: r.line });
  }
  for (const [crit, j] of seen) {
    if (!j.verdict) problems.push(`${file}:${j.line}: ${crit} 没有判定；填 pass/partial/fail，证据列必填（命令或 文件:行）`);
    else if (j.verdict === "pass" && (!j.evidence || PLACEHOLDERS.test(j.evidence.trim())))
      problems.push(`${file}: ${crit} 判 pass 但证据为空/占位（证据必须是命令或 文件:行）`);
    else if (j.verdict === "partial" && (!j.evidence || PLACEHOLDERS.test(j.evidence.trim())))
      problems.push(`${file}: ${crit} 判 partial 但没写证据与缺口`);
    else if (j.verdict === "fail") problems.push(`${file}: ${crit} 判 fail`);
  }
  if (wantCriteria) {
    for (const c of wantCriteria) if (!seen.has(c)) problems.push(`${file}: 缺判据 ${c}（preset 的 gate 要求；本表未出现该判据名）`);
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

// 人签接受 partial：第 3 节存在且选项是「签：接受…」（不是“签：不签/签：返工”这类前缀巧合）
function signatureAcceptsPartial(file, text) {
  const sec = text.split(/^##\s*3\./m)[1] || "";
  return /^\s*[-*]?\s*选项[：:]\s*[*_`]*\s*签[：:]\s*[*_`]*\s*接受/m.test(sec);
}


function initGate(mid, force = false) {
  if (!/^M\d+$/.test(mid || "")) { console.error("用法：gate.mjs init <M>"); process.exit(2); }
  const mfile = path.join(ROOT, `.sdo/milestones/${mid}.md`);
  if (!fs.existsSync(mfile)) { console.error(`找不到 .sdo/milestones/${mid}.md`); process.exit(2); }
  const lines = fs.readFileSync(mfile, "utf8").split(/\r?\n/);
  const sec = lines.findIndex((l) => /^#{2,3}\s+.*冻结段/.test(l));
  if (sec < 0) { console.error(`里程碑 ${mid} 找不到「冻结段」小节`); process.exit(2); }
  const end = lines.findIndex((l, i) => i > sec && /^#{2,3}\s+/.test(l));
  const body = lines.slice(sec, end < 0 ? lines.length : end);
  const gl = body.find((l) => /^-\s*门禁[:：]/.test(l));
  const cl = body.find((l) => /^-\s*判据[:：]/.test(l));
  if (!gl || !cl) { console.error(`gate_criteria_undeclared：${mid} 冻结段缺「- 门禁：」或「- 判据：」`); process.exit(1); }
  const declaredGates = gl.replace(/^-\s*门禁[:：]/, "").split(/→|->/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean);
  const criteria = cl.replace(/^-\s*判据[:：]/, "").split(/、|,/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean);
  const maps = declaredMappingsInfo(mid);
  const gates = maps.found ? [...maps.byGate.keys()] : declaredGates;
  if (!gates.length || !criteria.length) { console.error(`gate_criteria_undeclared：${mid} 门禁/判据声明为空`); process.exit(1); }
  const rel = `.sdo/gates/${mid}.md`;
  const out = path.join(ROOT, rel);
  if (fs.existsSync(out) && !force) { console.log(`已存在，跳过：${rel}`); process.exit(0); }
  if (fs.existsSync(out) && force) console.log(`将覆盖：${rel}`);
  const t = [`# 出口勾选表：${mid} 阶段门`, "", `> 由 gate.mjs init 按冻结段声明生成；人填判定与证据后 gate --file。`, ""];
  for (const g of gates) {
    const gc = maps.found ? maps.byGate.get(g) : criteria;
    t.push(`## ${g}`, "", "| # | 判据 | 判据说明 | 证据（命令/文件:行） | 判定 |", "|---|---|---|---|---|");
    gc.forEach((c, i) => t.push(`| ${i + 1} | ${c} | 待填 | 待填 | 待判 |`));
    t.push("");
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log(`将写：${rel}（${gates.length} 门 / ${maps.found ? [...maps.byGate.values()].reduce((n, a) => n + a.length, 0) : criteria.length} 判据${maps.found ? "，按门映射" : ""}）`);
  fs.writeFileSync(out, t.join("\n"));
  console.log(`下一步：填判定/证据后 node <skill>/scripts/gate.mjs --file ${rel}`);
  process.exit(0);
}

function declaredMappingsInfo(mid) {
  const p = `.sdo/milestones/${mid}.md`;
  if (!fs.existsSync(path.join(ROOT, p))) return { found: false, byGate: new Map() };
  const lines = read(p).split(/\r?\n/);
  const sec = lines.findIndex((l) => /^#{2,3}\s+.*冻结段/.test(l));
  if (sec < 0) return { found: false, byGate: new Map() };
  const end = lines.findIndex((l, i) => i > sec && /^#{2,3}\s+/.test(l));
  const byGate = new Map();
  for (const line of lines.slice(sec, end < 0 ? lines.length : end)) {
    const mm = /^-\s*门禁判据[:：]\s*(.*)$/.exec(line);
    if (!mm) continue;
    const body = mm[1].trim();
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const gid = body.slice(0, eq).trim();
    const cs = body.slice(eq + 1).split(/、|,/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean);
    if (/^G_[a-z0-9_]+$/.test(gid) && !byGate.has(gid)) byGate.set(gid, cs);
  }
  return { found: byGate.size > 0, byGate };
}

// ---------- 主流程 ----------
const plan = planInfo();
if (ARGV[0] === "init") initGate(ARGV[1], ARGV.includes("--force"));
const byFile = ARGV.includes("--file") ? ARGV[ARGV.indexOf("--file") + 1] : null;
const wanted = ARGV.find((a) => /^G_[a-z0-9_]+$/.test(a)) || null;

if (ARGV.includes("--list")) {
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

// M11-3：冻结段「- 判据：」是唯一真源；门表必须覆盖声明里的每条判据。
function declaredCriteriaInfo(mid) {
  const p = `.sdo/milestones/${mid}.md`;
  if (!fs.existsSync(path.join(ROOT, p))) return { found: false, criteria: [] };
  const lines = read(p).split(/\r?\n/);
  const sec = lines.findIndex((l) => /^#{2,3}\s+.*冻结段/.test(l));
  if (sec < 0) return { found: false, criteria: [] };
  const end = lines.findIndex((l, i) => i > sec && /^#{2,3}\s+/.test(l));
  const body = lines.slice(sec, end < 0 ? lines.length : end);
  const line = body.find((l) => /^-\s*判据[:：]/.test(l));
  if (!line) return { found: true, criteria: [] };
  return { found: true, criteria: [...new Set(line.replace(/^-\s*判据[:：]/, "").split(/、|,/).map((x) => x.trim().replace(/`/g, "")).filter(Boolean))] };
}

const problems = [], warnings = [], results = [];
const targets = byFile ? [byFile] : gateFiles();
if (!targets.length) die("没有 .sdo/gates/*.md");


for (const f of targets) {
  const fm = /\.sdo\/gates\/(M\d+)\.md$/.exec(f);
  const gatePreset = fm ? milestonePreset(fm[1]) : plan.preset;
  const critMap = presetCriteria(gatePreset);
  if (!fs.existsSync(path.join(ROOT, f))) die(`文件不存在：${f}`);
  const text = read(f);
  const gids = wanted ? [wanted] : [...new Set([...text.matchAll(/^##\s+(G_[a-z0-9_]+)\s*$/gm)].map((m) => m[1]))];
  if (!gids.length) { problems.push(`${f}: 找不到 gate id（应写 G_xxx）`); continue; }
  if (wanted && !new RegExp(`\\b${wanted}\\b`).test(text)) { problems.push(`${f}: 找不到 gate ${wanted}（文件里没有这个 id）`); continue; }
  const decl = fm ? declaredCriteriaInfo(fm[1]) : { found: false, criteria: [] };
  const declared = decl.criteria;
  const maps = fm ? declaredMappingsInfo(fm[1]) : { found: false, byGate: new Map() };
  if (maps.found) {
    for (const gid of maps.byGate.keys()) if (!gids.includes(gid)) problems.push(`${f}: missing_declared_criterion：${gid} 门节缺失（本门映射：${(maps.byGate.get(gid)||[]).join(", ")}）`);
    for (const gid of gids) if (!maps.byGate.has(gid)) problems.push(`${f}: criteria_table_mismatch：${gid} 门不在冻结段映射（映射门：${[...maps.byGate.keys()].join(", ")}）`);
  }
  if (!maps.found) for (const c of declared) {
    if (!new RegExp(`\\b${c.replace(/\./g, "\\.")}\\b`).test(text)) problems.push(`${f}: missing_declared_criterion：缺声明判据 ${c}（milestone 冻结段「判据：」要求）`);
  }
  const hasDeclaration = declared.length > 0;
  if (!hasDeclaration && !gatePreset) problems.push(`${f}: gate_criteria_undeclared：${fm ? fm[1] : "?"} 冻结段没有「- 判据：」声明，且无 preset 可降级（不静默放宽）`);
  const tableCrits = new Map();
  for (const gid of gids) {
    if (maps.found && !maps.byGate.has(gid)) continue;
    const want = maps.found ? null : (hasDeclaration ? null : (critMap?.[gid] || null));
    const r = checkGate(f, gid, want, problems, warnings);
    if (maps.found) {
      const expect = maps.byGate.get(gid);
      if (expect) {
        const seen = new Set((r?.rows || []).map((x) => x.crit));
        for (const c of expect) if (!seen.has(c)) problems.push(`${f}: missing_declared_criterion：${gid} 缺映射判据 ${c}（本门映射：${expect.join(", ")}）`);
        for (const c of seen) if (!expect.includes(c)) problems.push(`${f}: criteria_table_mismatch：${gid} 门表判据不在映射：${c}（本门映射：${expect.join(", ")}）`);
      }
    }
    if (r && r.rows.length) {
      for (const row of r.rows) {
        if (!tableCrits.has(row.crit)) tableCrits.set(row.crit, row.line);
      }
    }
    if (r && r.rows.length) {
      if ((r.partials.length || r.fails.length) && !signatureAcceptsPartial(f, text))
        problems.push(`${f}: ${gid} 有 ${r.fails.length ? "fail" : "partial"} 项（${[...r.fails, ...r.partials].join("、")}）但本表第 3 节没有「选项：签：…」接受它`);
      results.push({ file: f, gate: gid, pass: r.rows.filter((x) => x.verdict === "pass").length, partial: r.partials.length, fail: r.fails.length });
    }
  }
  if (hasDeclaration && !maps.found) {
    const declaredSet = new Set(declared);
    const extra = [...tableCrits.entries()].filter(([crit]) => !declaredSet.has(crit)).map(([crit, line]) => `${crit}（第 ${line} 行）`);
    if (extra.length) problems.push(`${f}: criteria_table_mismatch：门表判据不在冻结段声明：${extra.join("、")}`);
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
