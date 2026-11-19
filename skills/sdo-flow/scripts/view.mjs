#!/usr/bin/env node
// sdo-flow 快捷视图：从 .sdo/ 的 Markdown 拼出 agent 可读的视图（Node 18+，零依赖）
// 用法（项目内任意目录）：node <skill>/scripts/view.mjs <command> [--json]
//   state   一屏总览（里程碑/卡/台账/签字/读数）
//   board   卡板（id/status/owner/依赖/最近评审）
//   queue   待办队列（open 卡、未修 defect、缺失签字项）
//   ledger  偏差台账（--open 只看未修）
//   signs   签字索引
//   plan    计划摘要（判死读数 + 卡表）
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
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const lines = (p) => read(p).split(/\r?\n/);

function cells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const out = []; let cur = "", esc = false, code = false;
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
    const st = text.match(/^status:\s*(open|done)/m);
    const owner = text.match(/^owner:\s*(.+)$/m);
    const deps = text.match(/依赖[:：]\s*(.+)$/m);
    const R = text.match(/评审[:：]?\s*([^\n]*)$/m);
    const rel = text.match(/评审者[:：]\s*([^\n|]*)/);
    const accepted = /可收卡|可提交/.test(text);
    return { id: f.replace(/\.md$/, ""), status: st ? st[1] : "?", owner: owner ? owner[1].trim() : "", deps: deps ? deps[1].trim() : "",
      review: R ? R[1].trim() : "", reviewer: rel ? rel[1].trim() : "", accepted };
  });
}

function ledger() {
  const t = findTable(".sdo/台账.md", "id");
  if (!t) return [];
  const idx = Object.fromEntries(t.header.map((h, i) => [h.replace(/`/g, ""), i]));
  return t.rows.map((r) => ({
    id: (r[idx.id] || "").replace(/`/g, ""),
    kind: r[idx.kind] || "", where: r[idx["位置"]] || "", what: r[idx["现象"]] || "",
    why: r[idx["影响"]] || "", how: r[idx["处置"]] || "", status: r[idx["状态"]] || "",
  })).filter((r) => r.id);
}

function signs() {
  if (!exists(".sdo/sign")) return [];
  return fs.readdirSync(path.join(ROOT, ".sdo/sign")).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const text = read(`.sdo/sign/${f}`);
    const time = text.match(/^-\s*时间[:：]\s*(.+)$/m);
    const opt = text.match(/^-\s*选项[:：]\s*(.+)$/m);
    const obj = text.match(/^-\s*被签对象[:：]\s*(.+)$/m);
    return { file: `.sdo/sign/${f}`, time: time ? time[1].trim() : "", option: opt ? opt[1].trim() : "", object: obj ? obj[1].trim() : "" };
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

function milestone() {
  const plan = ".sdo/01-计划.md";
  if (!exists(plan)) return {};
  const m = read(plan).match(/^#\s*计划[:：]\s*(.+)$/m);
  const rd = findTable(plan, "读数");
  return { name: m ? m[1].trim() : "", readings: rd ? rd.rows.map((r) => ({ id: r[0], question: r[1], how: r[2] })) : [] };
}

const CS = cards(), LG = ledger(), SG = signs(), RD = readings(), MS = milestone();
const openCards = CS.filter((c) => c.status !== "done");
const openLedger = LG.filter((r) => r.status === "open" || (r.kind === "defect" && r.status !== "fixed"));

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
    const rows = onlyOpen ? openLedger : LG;
    return [`# 台账（${rows.length}${onlyOpen ? " · 只看未修" : ""}）`, "", "| id | kind | 状态 | 位置 | 现象 | 处置 |", "|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.status} | ${r.where} | ${r.what} | ${r.how} |`)].join("\n");
  },
  signs() {
    return [`# 签字（${SG.length}）`, "", "| 文件 | 时间 | 选项 | 被签对象 |", "|---|---|---|---|",
      ...SG.map((s) => `| ${s.file} | ${s.time} | ${s.option} | ${s.object} |`)].join("\n");
  },
  plan() {
    const t = MS.readings || [];
    return [`# 计划摘要：${MS.name || "(未命名)"}`, "", "| 读数 | 问题 | 怎么量 |", "|---|---|---|",
      ...t.map((r) => `| ${r.id} | ${r.question} | ${r.how} |`), "",
      `卡：${CS.length} 张（open ${openCards.length}）。完整卡表见 ${exists(".sdo/01-计划.md") ? ".sdo/01-计划.md" : "—"}。`].join("\n");
  },
}[cmd];

if (!out) {
  console.error(`未知视图：${cmd}。可用：state / board / queue / ledger / signs / plan`);
  process.exit(2);
}
const data = out();
if (warnRagged.length && !asJson) console.error(`WARN  表列数不齐（已按表头补齐，跑 check.mjs 修）：\n  ${warnRagged.join("\n  ")}`);
if (asJson) {
  const obj = { command: cmd, milestone: MS.name, cards: CS, ledger: LG, signs: SG, readings: RD };
  console.log(JSON.stringify(obj, null, 2));
} else console.log(data);
