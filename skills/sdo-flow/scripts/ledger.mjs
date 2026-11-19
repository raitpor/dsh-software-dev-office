#!/usr/bin/env node
// sdo-flow 台账脚本（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目内任意目录）：
//   node <skill>/scripts/ledger.mjs add --kind <gap|defect|explain> --where <位置> --what <现象> --impact <影响> --fix <处置> [--status <状态>]
//   node <skill>/scripts/ledger.mjs close <D-n> --fix <处置>
//   node <skill>/scripts/ledger.mjs list [--open]
// 只读写 .sdo/台账.md；close 只追加一行，绝不改旧行（append-only）。
// 退出码：0 成功；1 读写失败；2 用法/环境/表头/参数错误（不改文件）。
import fs from "node:fs";
import path from "node:path";

const LEDGER = ".sdo/台账.md";
const KINDS = new Set(["gap", "defect", "explain"]);
const STATUSES = new Set(["open", "accepted", "fixed", "closed", "superseded"]);
const HEADER_ALIAS = {
  id: "id", ID: "id",
  kind: "kind", 类型: "kind",
  位置: "where",
  现象: "what",
  影响: "why",
  处置: "how",
  状态: "status", status: "status",
};
const REQUIRED = ["id", "kind", "where", "what", "why", "how", "status"];

function die(message) {
  console.error(message);
  process.exit(2);
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function findRoot(start) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, ".sdo"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = [];
  let cur = "";
  let esc = false;
  let code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "`") {
      let j = i;
      while (t[j + 1] === "`") j++;
      cur += t.slice(i, j + 1);
      if (j - i + 1 < 3) code = !code;
      i = j;
      continue;
    }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
function cell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}
function localStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) die("用法：ledger.mjs add|close|list [参数]（详见文件头）");
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "open") { flags.open = true; continue; }
      if (i + 1 >= rest.length) die(`参数 --${key} 缺值`);
      if (key in flags && typeof flags[key] === "string") die(`参数 --${key} 重复`);
      flags[key] = rest[++i];
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function loadLedger() {
  const root = findRoot(process.cwd());
  if (!root) die("找不到 .sdo/：请在本项目内运行（台账脚本只读写 .sdo/台账.md）");
  const file = path.join(root, LEDGER);
  if (!fs.existsSync(file)) die(`找不到 ${LEDGER}（先按模板创建）`);
  const text = fs.readFileSync(file, "utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let hdrAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("|") && /(^|\|)\s*id\s*(\||$)/i.test(s)) { hdrAt = i; break; }
  }
  if (hdrAt < 0) die(`找不到台账表头（需要含 id 的 7 列：id|kind|位置|现象|影响|处置|状态）`);
  const header = cells(lines[hdrAt]);
  if (header.length !== 7) die(`表头列数 ≠ 7（实际 ${header.length}）；不猜列，先修表头`);
  const cols = {};
  for (let i = 0; i < header.length; i++) {
    const key = HEADER_ALIAS[header[i]];
    if (key === undefined) die(`表头有未知列「${header[i]}」；需要 7 列：id|kind|位置|现象|影响|处置|状态`);
    cols[key] = i;
  }
  if (!REQUIRED.every((k) => k in cols)) die("表头缺列；需要 7 列：id|kind|位置|现象|影响|处置|状态");
  // 最后一行表格行：表头后连续为 `|` 的行；空行跳过，遇到正文即止
  let lastRow = hdrAt + 1;
  for (let i = hdrAt + 2; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("|")) lastRow = i;
    else if (s !== "") break;
  }
  const rows = [];
  for (let i = hdrAt + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const c = cells(lines[i]);
    if (c.length !== 7) continue;
    rows.push({ line: i + 1, cells: c, id: c[cols.id].replace(/`/g, "").trim() });
  }
  const nums = rows.map((r) => /^D-(\d+)$/.exec(r.id)?.[1]).filter(Boolean).map(Number);
  const nextId = `D-${(nums.length ? Math.max(...nums) : 0) + 1}`;
  return { root, file, text, nl, lines, hdrAt, cols, lastRow, rows, nextId };
}

function buildRow(cols, values) {
  const out = Array(7).fill("");
  for (const [key, value] of Object.entries(values)) {
    if (!(key in cols)) continue;
    out[cols[key]] = cell(value);
  }
  return `| ${out.join(" | ")} |`;
}

function writeAtomic(file, text) {
  const mode = fs.statSync(file).mode & 0o777;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}

function insertRow(ledger, rowLine) {
  const { lines, lastRow, file, nl } = ledger;
  const next = [...lines];
  next.splice(lastRow + 1, 0, rowLine);
  writeAtomic(file, next.join(nl));
}

function cmdAdd(flags) {
  if (!KINDS.has(flags.kind)) die(`未知/缺失 --kind：${flags.kind ?? ""}（只允许 gap|defect|explain）`);
  const status = flags.status ?? "open";
  if (!STATUSES.has(status)) die(`未知 --status：${status}（只允许 ${[...STATUSES].join("|")}）`);
  for (const key of ["where", "what", "impact", "fix"]) {
    if (typeof flags[key] !== "string" || flags[key].trim() === "") die(`add 缺必填参数 --${key}`);
  }
  const ledger = loadLedger();
  const row = buildRow(ledger.cols, {
    id: ledger.nextId,
    kind: flags.kind,
    where: flags.where,
    what: `${localStamp()} — ${flags.what}`,
    why: flags.impact,
    how: flags.fix,
    status,
  });
  insertRow(ledger, row);
  console.log(`已追加 ${ledger.nextId}`);
}

function cmdClose(positional, flags) {
  if (positional.length !== 1) die("用法：ledger.mjs close <D-n> --fix <处置>");
  const id = positional[0];
  if (!/^D-\d+$/.test(id)) die(`id 不合法：${id}（应为 D-<数字>）`);
  if (typeof flags.fix !== "string" || flags.fix.trim() === "") die("close 缺必填参数 --fix");
  const ledger = loadLedger();
  const target = ledger.rows.find((r) => r.id === id);
  if (!target) die(`找不到台账行 ${id}（不写文件）`);
  const where = target.cells[ledger.cols.where];
  const row = buildRow(ledger.cols, {
    id: ledger.nextId,
    kind: "explain",
    where,
    what: `${localStamp()} — 关闭 ${id}`,
    why: "关闭记录（append-only，旧行不改）",
    how: `关闭 ${id}：${flags.fix}`,
    status: "fixed",
  });
  insertRow(ledger, row);
  console.log(`已追加 ${ledger.nextId}（关闭 ${id}）`);
}

function cmdList(flags) {
  const ledger = loadLedger();
  const visible = flags.open
    ? ledger.rows.filter((r) => ["open", "accepted"].includes(r.cells[ledger.cols.status]))
    : ledger.rows;
  for (const row of visible) console.log(`| ${row.cells.map(cell).join(" | ")} |`);
}

const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
try {
  if (cmd === "add") cmdAdd(flags);
  else if (cmd === "close") cmdClose(positional, flags);
  else if (cmd === "list") {
    if (positional.length) die("list 不接受位置参数（只读）");
    cmdList(flags);
  } else die(`未知命令：${cmd}（只允许 add|close|list）`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
