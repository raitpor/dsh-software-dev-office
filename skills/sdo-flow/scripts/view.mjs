#!/usr/bin/env node
// sdo-flow 快捷视图：从 .sdo/ 的 Markdown 拼出 agent 可读的视图（Node 18+，零依赖）
// 用法（项目内任意目录）：node <skill>/scripts/view.mjs <command> [--json]
//   state   一屏总览（里程碑/卡/台账/签字/读数）
//   board   卡板（id/status/owner/依赖/最近评审）
//   queue   待办队列（open 卡、未修 defect、缺失签字项）
//   ledger  偏差台账（--open 只看未修）
//   signs   签字索引
//   plan    计划摘要（判死读数 + 卡表）
//   next    现在能开工什么（可开工/被依赖卡住/待签收/待签文件/未修台账）
import fs from "node:fs";
import path from "node:path";

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
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) || "state";
const asJson = argv.includes("--json");
const onlyOpen = argv.includes("--open");
const mi = argv.indexOf("--milestone");
const milestoneArg = mi >= 0 ? argv[mi + 1] : "M4";
if (mi >= 0 && (!milestoneArg || milestoneArg.startsWith("--") || !/^M\d+$/.test(milestoneArg))) { console.error("--milestone 需要一个里程碑号（如 M4）"); process.exit(2); }
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const lines = (p) => read(p).split(/\r?\n/);

function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = []; let cur = "", esc = false, code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "`") {
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

const warnRagged = [];
/** 抽出文件里的表（列数不齐的行补齐并在末尾提示，不再整表丢弃） */
function tables(p) {
  const ls = lines(p); const out = [];
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].trim().startsWith("|") || isSep(ls[i]) || !isSep(ls[i + 1])) continue;
    const header = cells(ls[i]); const rows = [];
    let j = i + 2;
    for (; j < ls.length && ls[j].trim().startsWith("|"); j++) {
      if (isSep(ls[j])) continue;
      rows.push(cells(ls[j]));
    }
    if (rows.length) {
      const ragged = rows.filter((r) => r.length !== header.length).length;
      if (ragged) warnRagged.push(`${p}:${i + 1}: ${ragged} 行列数 ≠ 表头 ${header.length}`);
      rows.forEach((r) => { while (r.length < header.length) r.push(""); });
      out.push({ header, rows, at: i + 1 });
    }
    i = j;
  }
  return out;
}
const findTable = (p, key) => (exists(p) ? tables(p).find((t) => t.header.some((h) => h.includes(key))) : undefined);

function cards() {
  if (!exists(".sdo/cards")) return [];
  return fs.readdirSync(path.join(ROOT, ".sdo/cards")).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const p = `.sdo/cards/${f}`; const text = read(p);
    const st = text.match(/^status:\s*([A-Za-z_-]+)/m);
    const owner = text.match(/^owner:\s*(.+)$/m);
    const deps = text.match(/^\s*(?:[-*]\s*)?依赖[:：]\s*(.+)$/m);
    // 最近评审：优先取「## 评审」段里最后一句判词；没有段/判词就留空（board 显示 —）
    const secParts = text.split(/^##\s+/m).find((x) => x.startsWith("评审"));
    const sec = secParts ? secParts.split(/\n/).slice(1).join("\n") : "";
    const verdicts = [...sec.matchAll(/[^\n]*(可收卡|可提交|改完再审|拒绝)[^\n]*/g)].map((m) => m[0].trim());
    const lastVerdict = verdicts.length ? verdicts[verdicts.length - 1].replace(/^[-*]\s*/, "").slice(0, 60) : "";
    const R = lastVerdict ? [null, lastVerdict] : null;
    const rel = text.match(/^\s*[-*]?\s*评审者[:：][ \t]*([^\n|]*)/m);
    const accepted = /可收卡|可提交/.test(text);
    return { id: f.replace(/\.md$/, ""), status: st ? st[1] : "?", owner: owner ? owner[1].trim() : "", deps: deps ? deps[1].trim() : "",
      review: R ? R[1].trim() : "", reviewer: rel ? rel[1].trim() : "", accepted };
  });
}

function readLedgerIndex() {
  const p = ".sdo/.index/ledger.json";
  if (!exists(p)) return null;
  try {
    const idx = JSON.parse(read(p));
    if (!idx || !Array.isArray(idx.volumes) || !Array.isArray(idx.open)) return null;
    return idx;
  } catch { return null; }
}
function ledgerRowsFrom(file) {
  const t = findTable(file, "id");
  if (!t) return [];
  const idx = Object.fromEntries(t.header.map((h, i) => [h.replace(/`/g, ""), i]));
  return t.rows.map((r, i) => ({
    id: (r[idx.id] || "").replace(/`/g, ""),
    kind: r[idx.kind] || "", where: r[idx["位置"]] || "", what: r[idx["现象"]] || "",
    why: r[idx["影响"]] || "", how: r[idx["处置"]] || "", status: r[idx["状态"]] || "",
    file, line: t.at + i + 2,
  })).filter((r) => r.id);
}
/** 只按索引 open 读行：每条 open 有 line 时只取该行；缺 line 才回退整卷解析。 */
function openRowsFromIndex() {
  const idx = readLedgerIndex();
  if (!idx || !Array.isArray(idx.open) || !idx.open.length) return null;
  const byFile = new Map();
  for (const o of idx.open) {
    if (!o || typeof o.file !== "string") continue;
    if (!exists(o.file)) { console.error(`索引 open 指向的卷不存在：${o.file}（跑 ledger.mjs reindex）`); process.exit(2); }
    if (!byFile.has(o.file)) byFile.set(o.file, []);
    byFile.get(o.file).push(o);
  }
  const out = [];
  for (const [file, entries] of byFile) {
    const ls = lines(file);
    let header = null, hdrAt = -1;
    for (let i = 0; i < ls.length; i++) {
      if (!ls[i].trim().startsWith("|")) continue;
      const h = cells(ls[i]);
      if (h.some((x) => x.replace(/`/g, "").trim() === "id")) { header = h; hdrAt = i; break; }
    }
    if (!header) { console.error(`台账卷找不到表头：${file}`); process.exit(2); }
    const at = Object.fromEntries(header.map((h, i) => [h.replace(/`/g, ""), i]));
    const parsed = new Map();
    let fallback = null;
    for (const o of entries) {
      let line = Number.isInteger(o.line) ? o.line : null;
      if (!line) { fallback ??= ledgerRowsFrom(file); const hit = fallback.find((r) => r.id === o.id); if (hit) parsed.set(o.id, hit); continue; }
      const raw = ls[line - 1];
      if (!raw || !raw.trim().startsWith("|")) { fallback ??= ledgerRowsFrom(file); const hit = fallback.find((r) => r.id === o.id); if (hit) parsed.set(o.id, hit); continue; }
      const c = cells(raw);
      const gotId = (c[at.id] || "").replace(/`/g, "").trim();
      if (gotId !== o.id) { console.error(`索引 open 行 ${o.id} 位置 ${file}:${line} 实际是 ${gotId || "空行"}（跑 ledger.mjs reindex）`); process.exit(2); }
      const kind = c[at.kind] || "", status = c[at["状态"]] || "";
      if (kind !== o.kind || !["open", "accepted"].includes(status)) { console.error(`索引 open 行 ${o.id} 的 kind/状态与正文不符（跑 ledger.mjs reindex）`); process.exit(2); }
      parsed.set(o.id, {
        id: gotId, kind, where: c[at["位置"]] || "",
        what: c[at["现象"]] || "", why: c[at["影响"]] || "", how: c[at["处置"]] || "",
        status, file, line,
      });
    }
    for (const o of entries) { const r = parsed.get(o.id); if (r) out.push(r); }
  }
  return out;
}
function ledger() {
  const idx = readLedgerIndex();
  const base = ledgerRowsFrom(".sdo/台账.md");
  if (!idx) return base;
  const seen = new Set(base.map((r) => r.id));
  for (const o of idx.open) {
    if (seen.has(o.id)) continue;
    if (!exists(o.file)) { console.error(`索引 open 指向的卷不存在：${o.file}（跑 ledger.mjs reindex）`); process.exit(2); }
    const rows = ledgerRowsFrom(o.file);
    const row = rows.find((r) => r.id === o.id);
    if (row) { base.push(row); seen.add(row.id); }
  }
  return base;
}
function ledgerDetail(id) {
  const rows = ledgerRowsFrom(".sdo/台账.md");
  const close = rows.find((r) => (r.how || "").startsWith(`关闭 ${id}`));
  const idx = readLedgerIndex();
  let original = null;
  if (idx) {
    const o = idx.open.find((x) => x.id === id);
    if (o) {
      if (!exists(o.file)) { console.error(`索引 open 指向的卷不存在：${o.file}（跑 ledger.mjs reindex）`); process.exit(2); }
      const hit = ledgerRowsFrom(o.file).find((r) => r.id === id);
      if (hit) original = { file: o.file, line: hit.line, where: hit.where, what: hit.what, status: hit.status };
    }
  }
  if (!original) {
    const hit = rows.find((r) => r.id === id);
    if (hit) original = { file: ".sdo/台账.md", line: hit.line, where: hit.where, what: hit.what, status: hit.status };
  }
  if (!original && close) {
    const m = /^(.+):(\d+)$/.exec(close.where || "");
    if (m) {
      original = { file: m[1], line: Number(m[2]), where: "", what: "", status: "已关闭" };
      const hit = ledgerRowsFrom(m[1]).find((r) => r.id === id);
      if (hit) { original.where = hit.where; original.what = hit.what; original.status = hit.status; }
    }
  }
  if (!original && !close) { console.error(`台账里没有：${id}`); process.exit(2); }
  const out = [`# 台账行 ${id}`];
  if (original) out.push(`- 原行：${original.file}:${original.line}（${original.status}）`, `- 位置：${original.where}`, `- 现象：${original.what}`);
  if (close) out.push(`- 关闭行：.sdo/台账.md:${close.line}`, `- 处置：${close.how}`);
  return out.join("\n");
}

function signs() {
  if (!exists(".sdo/sign")) return [];
  return fs.readdirSync(path.join(ROOT, ".sdo/sign")).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const text = read(`.sdo/sign/${f}`);
    const time = text.match(/^\s*(?:[-*]\s*)?时间[:：]\s*(.+)$/m);
    const opt = text.match(/^\s*(?:[-*]\s*)?选项[:：]\s*(.+)$/m);
    const obj = text.match(/^\s*(?:[-*]\s*)?被签对象[:：]\s*(.+)$/m);
    const title = text.match(/^#\s*(.+)$/m);
    const scopes = [...text.matchAll(/^\s*(?:[-*]\s*)?范围[:：]\s*(.+)$/gm)].map((m) => m[1].trim());
    return { file: `.sdo/sign/${f}`, time: time ? time[1].trim() : "", option: opt ? opt[1].trim() : "", object: obj ? obj[1].trim() : "",
      title: title ? title[1].trim() : "", scope: scopes.join("；") };
  });
}

function readings() {
  if (!exists(".sdo/readings")) return [];
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, ".sdo/readings")).filter((x) => x.endsWith(".md")).sort()) {
    const text = read(`.sdo/readings/${f}`);
    const ls = text.split(/\r?\n/);
    const HEAD = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?[*_`]*overall\b/i;
    const at = ls.findIndex((l) => HEAD.test(l));
    let v = "";
    if (at >= 0) {
      const m1 = ls[at].match(/overall\b[^A-Za-z\n]*(pass|partial|fail)\b/i);
      const m2 = (ls[at + 1] || "").match(/^\s*[*_`\s:：|—–-]*(pass|partial|fail)\b/i);
      v = (m1 ? m1[1] : m2 ? m2[1] : "").toLowerCase();
    }
    const items = [...text.matchAll(/^\|\s*(R\d+)\s*\|([^\n]*)$/gim)].map((m) => {
      const vm = m[2].match(/\b(pass|partial|fail)\b/i);
      return { id: m[1], verdict: vm ? vm[1].toLowerCase() : "" };
    });
    out.push({ file: `.sdo/readings/${f}`, overall: v, items });
  }
  return out;
}

function archiveRows() {
  const p = ".sdo/archive/INDEX.md";
  if (!exists(p)) return [];
  const ls = lines(p);
  const h = ls.findIndex((l) => l.trim().startsWith("|") && l.includes("里程碑"));
  if (h < 0) return [];
  const header = cells(ls[h]).map((x) => x.replace(/`/g, "").trim());
  const ix = (n) => header.findIndex((x) => x === n);
  const out = [];
  for (let i = h + 1; i < ls.length; i++) {
    const raw = ls[i].trim();
    if (!raw.startsWith("|")) break;
    if (isSep(raw)) continue;
    const c = cells(raw);
    const milestone = (c[ix("里程碑")] || "").trim();
    if (!/^M\d+$/.test(milestone)) continue;
    let manifest = {};
    try { manifest = JSON.parse((c[ix("文件 sha256")] || "{}").replace(/`/g, "")); } catch { manifest = {}; }
    out.push({ milestone, gate: c[ix("门签号")] || "-", tree: c[ix("被签树")] || "-", count: c[ix("文件数")] || "", manifest, status: c[ix("状态")] || "" });
  }
  return out;
}

function milestone() {
  const plan = ".sdo/计划.md";
  if (!exists(plan)) return {};
  const m = read(plan).match(/^#\s*计划[:：]\s*(.+)$/m);
  return { name: m ? m[1].trim() : "", readings: [] };
}
const MILESTONE_DIR = ".sdo/里程碑";
function milestoneFiles() {
  const d = path.join(ROOT, MILESTONE_DIR);
  if (!exists(MILESTONE_DIR) && !fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^M\d+\.md$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

function closedLedgerIds(rows) {
  const closed = new Set();
  for (const r of rows) {
    const m = /^关闭\s+(D-\d+)/.exec(r.how || "");
    if (m) closed.add(m[1]);
  }
  return closed;
}
function isOpenLedgerRow(row, closedIds = new Set()) {
  if (!row) return false;
  if (row.kind !== "defect" && row.kind !== "gap") return false;
  if (["fixed", "closed", "superseded"].includes(row.status)) return false;
  return !closedIds.has(row.id);
}
function dnum(id) { const m = /^D-(\d+)$/.exec(id || ""); return m ? Number(m[1]) : NaN; }

const NEED_ALL_LEDGER = cmd !== "next";
const CS = cards(), LG = NEED_ALL_LEDGER ? ledger() : [], SG = signs(), RD = readings(), MS = milestone();
const openCards = CS.filter((c) => c.status !== "done");
const CLOSED_IDS = closedLedgerIds(LG);
const IDX_OPEN = openRowsFromIndex();
const openLedger = IDX_OPEN ?? LG.filter((r) => isOpenLedgerRow(r, CLOSED_IDS));

// ---- next 的解析辅助 ----
function stripParens(s) {
  let out = s;
  for (;;) { const n = out.replace(/[（(][^）)]*[）)]/g, ""); if (n === out) break; out = n; }
  return out;
}
function parseDeps(cellText) {
  const text = stripParens(String(cellText || "").replace(/`/g, "")).replace(/\b[0-9a-f]{7,}\b/gi, "");
  const ids = [];
  const range = /M(\d+)-(\d+)\s*(?:…|\.\.\.|~|—|至)\s*M?(\d+)-(\d+)/g;
  for (const m of text.matchAll(range)) {
    if (m[1] !== m[3]) continue;
    for (let n = Number(m[2]); n <= Number(m[4]); n++) ids.push(`M${m[1]}-${n}`);
  }
  const rest = text.replace(range, "");
  for (const part of rest.split(/[、,，]/)) {
    const s = part.trim();
    if (!s) continue;
    const one = /^M(\d+)-(\d+)$/.exec(s);
    if (one) { ids.push(`M${one[1]}-${one[2]}`); continue; }
    const gate = /^M(\d+)-G$/.exec(s);
    if (gate) ids.push(`M${gate[1]}-G`);
  }
  return [...new Set(ids)];
}
function milestoneBlocks() {
  return milestoneFiles().map((f) => ({ id: f.replace(/\.md$/, ""), text: read(`${MILESTONE_DIR}/${f}`) }));
}
function playMilestoneLines(milestoneId) {
  const p = `${MILESTONE_DIR}/${milestoneId}.md`;
  if (!exists(p)) return null;
  return lines(p);
}
function planCardDeps(milestoneId) {
  const seg = playMilestoneLines(milestoneId);
  if (!seg) return { deps: new Map(), exists: false };
  let header = null, headerLine = -1;
  for (let i = 0; i < seg.length - 1; i++) {
    if (!seg[i].trim().startsWith("|") || !isSep(seg[i + 1])) continue;
    const h = cells(seg[i]);
    if (h.some((x) => x.includes("卡")) && h.some((x) => x.includes("依赖"))) { header = h; headerLine = i; break; }
  }
  if (!header) return { deps: new Map(), exists: false };
  const cardCol = header.findIndex((h) => h.includes("卡"));
  const depCol = header.findIndex((h) => h.includes("依赖"));
  const deps = new Map();
  for (let i = headerLine + 2; i < seg.length && seg[i].trim().startsWith("|"); i++) {
    if (isSep(seg[i])) continue;
    const r = cells(seg[i]);
    const id = (r[cardCol] || "").replace(/`/g, "").trim();
    if (!/^M\d+-(?:\d+|G)$/.test(id)) continue;
    deps.set(id, parseDeps(r[depCol] || ""));
  }
  return { deps, exists: true };
}
function signMatchesCard(sg, id, word) {
  for (const text of [sg.title, sg.scope]) {
    const re = /M(\d+)-(\d+)(?!\d)/g;
    for (const m of text.matchAll(re)) {
      if (`M${m[1]}-${m[2]}` === id && text.includes(word)) return true;
    }
  }
  return false;
}
function signNumber(sg) {
  const m = /(S\d+)/.exec(`${sg.file} ${sg.title}`);
  return m ? m[1] : "?";
}
function signForMilestone(sg, id, kind) {
  const m = /^M(\d+)$/.exec(id);
  if (!m) return false;
  const n = m[1];
  if (kind === "计划") {
    return new RegExp(`^S[\\d-]+\\s*·\\s*M${n}\\s*计划`).test(sg.title)
      || new RegExp(`^S[\\d-]+\\s*·\\s*计划签字（M${n}）`).test(sg.title);
  }
  if (kind === "门") {
    return new RegExp(`^S[\\d-]+\\s*·\\s*M${n}\\s*门`).test(sg.title)
      || new RegExp(`^S[\\d-]+\\s*M${n}\\s*门签`).test(sg.title);
  }
  return false;
}
let nextExit = 0;
function nextView(milestoneId) {
  const blocks = milestoneBlocks();
  const block = blocks.find((b) => b.id === milestoneId);
  if (!block) { console.error(`找不到里程碑文件：${MILESTONE_DIR}/${milestoneId}.md`); process.exit(2); }
  const { deps: planDepsMap, exists: hasPlanTable } = planCardDeps(milestoneId);
  if (!hasPlanTable) { console.error(`找不到 ${milestoneId} 卡表：${MILESTONE_DIR}/${milestoneId}.md`); process.exit(2); }
  const byId = new Map(CS.map((c) => [c.id, c]));
  const cardFaceDeps = new Map(CS.map((c) => [c.id, parseDeps(c.deps)]));
  if (hasPlanTable) {
    for (const [id, pdeps] of planDepsMap) {
      const cdeps = cardFaceDeps.get(id);
      if (!cdeps) continue;
      const a = [...pdeps].sort().join(","), b = [...cdeps].sort().join(",");
      if (a !== b) console.error(`对照：${id} 卡面「依赖：${cdeps.join("、") || "无"}」≠ 计划表「${pdeps.join("、") || "无"}」，以计划表为准`);
    }
  }
  const depSatisfied = (id) => {
    const c = byId.get(id);
    if (c) return c.status === "done";
    const gate = /^M(\d+)-G$/.exec(id);
    if (gate) return SG.some((s) => signForMilestone(s, `M${gate[1]}`, "门"));
    return false;
  };
  const ready = [], blocked = [], signing = [], filesPending = [], inProgress = [], unknown = [];
  for (const c of CS) {
    if (c.status === "done") {
      if (!SG.some((s) => signMatchesCard(s, c.id, "收卡"))) signing.push(c.id);
    } else if (c.status === "open") {
      const ds = planDepsMap.get(c.id) ?? [];
      const unmet = ds.filter((d) => !depSatisfied(d));
      if (unmet.length) blocked.push(`${c.id} · 缺 ${unmet.join("、")}`);
      else ready.push(c.id);
    } else if (c.status === "in_progress") {
      inProgress.push(c.id);
    } else {
      unknown.push(`${c.id} · status=${c.status}`);
    }
  }
  for (const b of milestoneBlocks()) {
    const st = /^\s*(?:[-*]\s*)?状态[:：]\s*(.+)$/m.exec(b.text);
    if (!st) { unknown.push(`${b.id} · 计划段缺「状态：」行`); continue; }
    const planSign = SG.find((s) => signForMilestone(s, b.id, "计划"));
    const gateSign = SG.find((s) => signForMilestone(s, b.id, "门"));
    filesPending.push(`${b.id} 计划：${planSign ? `已签 ${signNumber(planSign)}` : "待签"}`);
    filesPending.push(`${b.id} 门：${gateSign ? `已签 ${signNumber(gateSign)}` : "待签"}`);
  }
  const ledgerOpen = [...openLedger].sort((a, b) => {
    const x = dnum(a.id), y = dnum(b.id);
    if (Number.isNaN(x) || Number.isNaN(y)) return a.id.localeCompare(b.id);
    return x - y;
  });
  const sections = [
    ["可开工", ready],
    ["被依赖卡住", blocked],
    ["待签收", signing],
    ["待签文件", filesPending],
    ["未修台账", ledgerOpen.map((r) => `${r.id} · ${r.kind}/${r.status} · ${r.what}`)],
  ];
  const extras = [["进行中", inProgress], ["未知状态", unknown]];
  const expected = ["可开工", "被依赖卡住", "待签收", "待签文件", "未修台账"];
  if (sections.length !== 5 || sections.map(([n]) => n).join("|") !== expected.join("|")) {
    console.error("内部错误：next 五节不完整"); process.exit(1);
  }
  nextExit = unknown.length ? 1 : 0;
  const json = { command: "next", 可开工: ready, 被依赖卡住: blocked, 待签收: signing, 待签文件: filesPending,
    未修台账: ledgerOpen.map((r) => r.id), 进行中: inProgress, 未知状态: unknown };
  const human = [`# next（${milestoneId}）`, ""];
  for (const [name, items] of sections) human.push(`## ${name}`, ...(items.length ? items.map((x) => `- ${x}`) : ["无"]), "");
  for (const [name, items] of extras) {
    if (!items.length) continue;
    human.push(`## ${name}`, ...items.map((x) => (name === "进行中" ? `[进行中] ${x}` : `未知状态：${x}`)), "");
  }
  const rendered = human.join("\n");
  let last = -1;
  for (const name of expected) {
    const at = rendered.indexOf(`## ${name}\n`);
    if (at < 0 || at < last) { console.error(`内部错误：next 渲染缺节或顺序错（${name}）`); process.exit(1); }
    last = at;
  }
  return { human: rendered, json };
}

const out = {
  state() {
    const ms = MS.name || "(未命名)";
    return [
      `# 状态总览：${ms}`, "",
      `- 卡：${CS.length} 张（done ${CS.length - openCards.length} / open ${openCards.length}）`,
      `- 台账：${LG.length} 条（未修 ${openLedger.length}）`,
      `- 签字：${SG.length} 份${SG.length ? `（最近 ${SG.at(-1).file}）` : ""}`,
      `- 读数：${RD.length ? RD.map((r) => `${r.file}=${r.overall || "?"}`).join("，") : "还没有读数"}`,
      "",
      ...(openCards.length ? ["## 待开工", ...openCards.map((c) => `- ${c.id} · ${c.status}${c.owner ? ` · ${c.owner}` : ""}`)] : ["## 待开工", "- （无）"]),
      "",
      ...(openLedger.length ? ["## 未修台账", ...openLedger.map((r) => `- ${r.id} [${r.kind}/${r.status}] ${r.what}`)] : ["## 未修台账", "- （无）"]),
    ].join("\n");
  },
  board() {
    return [`# 卡板（${CS.length}）`, "", "| 卡 | status | owner | 依赖 | 最近评审 |", "|---|---|---|---|---|",
      ...CS.map((c) => `| ${c.id} | ${c.status} | ${c.owner || "—"} | ${c.deps || "—"} | ${c.review || "—"} |`)].join("\n");
  },
  queue() {
    const items = [];
    for (const c of openCards) items.push(`- [卡] ${c.id}（${c.status}）${c.owner ? ` · ${c.owner}` : ""}`);
    for (const r of openLedger) items.push(`- [台账] ${r.id} ${r.kind} · ${r.what}`);
    if (!SG.length) items.push("- [签字] 还没有任何签字文件（流程第 1 步就卡住了）");
    for (const c of CS.filter((x) => x.status === "done")) {
      if (!c.accepted) items.push(`- [卡] ${c.id} 是 done 但评审段没有「可收卡/可提交」判词`);
      if (!c.reviewer) items.push(`- [卡] ${c.id} 评审段缺「评审者」（独立性无法核对）`);
      else if (c.owner && c.reviewer.includes(c.owner)) items.push(`- [卡] ${c.id} 的评审者与 owner 相同（自审）`);
    }
    for (const r of RD) {
      if (!r.overall) items.push(`- [读数] ${r.file} 缺 overall（要独立一行：## overall：pass/partial/fail）`);
      else if (r.items.some((i) => !i.verdict)) items.push(`- [读数] ${r.file} 有读数行缺 verdict`);
    }
    return [`# 待办队列（${items.length}）`, "", ...(items.length ? items : ["- （空）"])].join("\n");
  },
  ledger() {
    const positional = argv.filter((a) => !a.startsWith("--"));
    if (positional.length > 1) return ledgerDetail(positional[1]);
    const rows = onlyOpen ? openLedger : LG;
    return [`# 台账（${rows.length}${onlyOpen ? " · 只看未修" : ""}）`, "", "| id | kind | 状态 | 位置 | 现象 | 处置 |", "|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.status} | ${r.where} | ${r.what} | ${r.how} |`)].join("\n");
  },
  signs() {
    return [`# 签字（${SG.length}）`, "", "| 文件 | 时间 | 选项 | 被签对象 |", "|---|---|---|---|",
      ...SG.map((s) => `| ${s.file} | ${s.time} | ${s.option} | ${s.object} |`)].join("\n");
  },
  plan() {
    const p = ".sdo/计划.md";
    if (!exists(p)) return "# 计划：项目级\n\n（没有 .sdo/计划.md）";
    const ls = lines(p);
    const out = ["# 计划：项目级", ""];
    let inTable = false;
    for (const l of ls) {
      if (/^\|\s*里程碑\s*\|/.test(l)) { inTable = true; out.push(l); continue; }
      if (inTable) { if (!l.trim().startsWith("|")) break; out.push(l); }
    }
    out.push("", `卡：${CS.length} 张（open ${openCards.length}）。里程碑文件：${milestoneFiles().join("、") || "—"}；完整卡表见各里程碑文件。`);
    return out.join("\n");
  },
  archive() {
    const rows = archiveRows();
    const want = argv.filter((a) => !a.startsWith("--"))[1];
    if (want) {
      const r = rows.find((x) => x.milestone === want);
      if (!r) { console.error(`归档里没有里程碑：${want}`); process.exit(2); }
      return [`# 归档 ${r.milestone}`, `- 门签号：${r.gate}`, `- 被签树：${r.tree}`, `- 文件数：${r.count}`, `- 状态：${r.status}`, "",
        "| 文件 | sha256 |", "|---|---|",
        ...Object.entries(r.manifest).map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
    }
    return [`# 归档（${rows.length}）`, "", "| 里程碑 | 门签号 | 被签树 | 文件数 | 状态 |", "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.milestone} | ${r.gate} | ${r.tree} | ${r.count} | ${r.status} |`)].join("\n");
  },
  next() { return nextView(milestoneArg).human; },
}[cmd];

if (!out) {
  console.error(`未知视图：${cmd}。可用：state / board / queue / ledger / signs / plan / next / archive`);
  process.exit(2);
}
const nextResult = cmd === "next" ? nextView(milestoneArg) : null;
const data = cmd === "next" ? nextResult.human : out();
if (warnRagged.length && !asJson) console.error(`WARN  表列数不齐（已按表头补齐，跑 check.mjs 修）：\n  ${warnRagged.join("\n  ")}`);
if (asJson) {
  const obj = cmd === "next"
    ? nextResult.json
    : { command: cmd, milestone: MS.name, cards: CS, ledger: LG, signs: SG, readings: RD, ...(cmd === "archive" ? { archive: archiveRows() } : {}) };
  console.log(JSON.stringify(obj, null, 2));
} else console.log(data);
if (cmd === "next" && nextExit !== 0) process.exit(nextExit);
