#!/usr/bin/env node
// sdo-flow 台账脚本（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目内任意目录）：
//   node <skill>/scripts/ledger.mjs add --kind <gap|defect|explain> --where <位置> --what <现象> --impact <影响> --fix <处置> [--status <状态>]
//   node <skill>/scripts/ledger.mjs close <D-n> --fix <处置>
//   node <skill>/scripts/ledger.mjs list [--open]
//   node <skill>/scripts/ledger.mjs rotate --to .sdo/ledger/vol-1.md
//   node <skill>/scripts/ledger.mjs reindex
// 活跃卷 .sdo/台账.md；归档卷 .sdo/ledger/vol-<n>.md；索引 .sdo/.index/ledger.json。
// 正文是唯一真源；索引可 reindex 重建。append-only：只追加/文件级轮转，不改旧行。
// 退出码：0 成功；1 读写失败/索引漂移；2 用法/环境/表头/参数错误（不改文件）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LEDGER = ".sdo/台账.md";
const ARCHIVE_DIR = ".sdo/ledger";
const INDEX = ".sdo/.index/ledger.json";
const KINDS = new Set(["gap", "defect", "explain", "closed"]);
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
const META_RE = /^<!-- sdo-ledger-vol rows=(\d+) first=(D-\d+|-) last=(D-\d+|-) sha256=([0-9a-f]{64}) -->$/;
const CLOSE_RE = /^关闭\s+(D-\d+)/;

const EMPTY_BODY = [
  "# 偏差台账",
  "",
  "> 用途：偏差台账：gap / defect / explain / closed 四类记录，7 列（closed = 关闭记录）。",
  "> 用法：`node <skill>/scripts/ledger.mjs add|close|list|rotate|reindex`；add/close 只追加 7 列行，旧行不改（append-only）。",
  "> 时间戳固定放「现象」列前缀（本表 7 列，不另设 at 列）。",
  "",
  "| id | kind | 位置 | 现象 | 影响 | 处置 | 状态 |",
  "|---|---|---|---|---|---|---|",
  "",
].join("\n");

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
function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
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

const USAGE = "用法：ledger.mjs add|close|list|rotate|reindex [参数]（详见文件头；--help 看用法）";
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
  if (!cmd) die(USAGE);
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

function splitMeta(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.length && META_RE.test(lines[0])) {
    const rest = lines.slice(1).join(nl);
    return { meta: lines[0], body: rest, nl };
  }
  return { meta: null, body: text, nl };
}
function tableOf(body, lineOffset = 0) {
  const lines = body.split(/\r?\n/);
  let hdrAt = -1;
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s.startsWith("|")) continue;
    const c = cells(s);
    const map = {};
    c.forEach((h, idx) => { const k = HEADER_ALIAS[h]; if (k) map[k] = idx; });
    if (c.length === 7 && REQUIRED.every((k) => k in map)) { hdrAt = i; cols = map; break; }
  }
  if (hdrAt < 0) return { lines, hdrAt: -1, cols: null, rows: [], lastRow: -1 };
  let lastRow = hdrAt + 1;
  const rows = [];
  for (let i = hdrAt + 2; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("|")) {
      lastRow = i;
      const c = cells(s);
      if (c.length !== 7) continue;
      rows.push({
        line: i + 1 + lineOffset,
        cells: c,
        id: c[cols.id].replace(/`/g, "").trim(),
        kind: c[cols.kind].trim(),
        where: c[cols.where].trim(),
        status: c[cols.status].trim(),
        how: c[cols.how].trim(),
      });
    } else if (s !== "") break;
  }
  return { lines, hdrAt, cols, rows, lastRow };
}
function statsFromTable(t, body) {
  const ids = t.rows.map((r) => r.id).filter((x) => /^D-\d+$/.test(x));
  return {
    rows: t.rows.length,
    first: ids.length ? ids[0] : "-",
    last: ids.length ? ids[ids.length - 1] : "-",
    sha256: sha256(body),
  };
}
function statsFor(body) {
  return statsFromTable(tableOf(body), body);
}
function metaLine(stats) {
  return `<!-- sdo-ledger-vol rows=${stats.rows} first=${stats.first} last=${stats.last} sha256=${stats.sha256} -->`;
}
function readVolume(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const { meta, body, nl } = splitMeta(text);
  const table = tableOf(body, meta ? 1 : 0);
  return { rel, file, text, meta, body, nl, table, stats: statsFor(body) };
}
function writeAtomic(file, text) {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}
function writeVolume(vol) {
  writeAtomic(vol.file, `${metaLine(vol.stats)}${vol.nl}${vol.body}`);
}

function readIndex(root) {
  const file = path.join(root, INDEX);
  if (!fs.existsSync(file)) return null;
  try {
    const idx = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!idx || !Array.isArray(idx.volumes) || !Array.isArray(idx.open)) return null;
    return idx;
  } catch {
    return null;
  }
}
function saveIndex(root, idx) {
  writeAtomic(path.join(root, INDEX), `${JSON.stringify(idx, null, 2)}\n`);
}
function volumeFiles(root) {
  const out = [];
  if (fs.existsSync(path.join(root, LEDGER))) out.push(LEDGER);
  const dir = path.join(root, ARCHIVE_DIR);
  if (fs.existsSync(dir)) {
    const names = fs.readdirSync(dir).filter((n) => /^vol-\d+\.md$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    for (const n of names) out.push(`${ARCHIVE_DIR}/${n}`);
  }
  return out;
}
const TERMINAL_STATUSES = new Set(["fixed", "closed", "superseded"]);
// 未修口径（与 view.mjs 的 isOpenLedgerRow 一致）：
// status=open 的任何 kind（含 explain 的“待处置说明”）+ gap/defect（accepted 也算未决）。
function isUnresolvedRow(row, closed = new Set()) {
  if (!row || TERMINAL_STATUSES.has(row.status)) return false;
  if (closed.has(row.id)) return false;
  return row.status === "open" || row.kind === "defect" || row.kind === "gap";
}
function closedIdsOf(rows) {
  const closed = new Set();
  for (const row of rows) {
    const m = CLOSE_RE.exec(row.how);
    if (m) closed.add(m[1]);
  }
  return closed;
}

function buildIndex(root) {
  const vols = [];
  const all = [];
  for (const rel of volumeFiles(root)) {
    const vol = readVolume(root, rel);
    if (!vol) continue;
    vols.push({ path: rel, rows: vol.stats.rows, first: vol.stats.first, last: vol.stats.last, sha256: vol.stats.sha256 });
    for (const row of vol.table.rows) all.push({ ...row, file: rel });
  }
  const closed = closedIdsOf(all);
  const open = all
    .filter((r) => isUnresolvedRow(r, closed))
    .map((r) => ({ id: r.id, kind: r.kind, file: r.file, line: r.line }));
  const idx = { volumes: vols, open, updated_at: null };
  syncOpenRows(idx);
  idx.updated_at = updatedAt(root);
  return idx;
}
function updatedAt(root) {
  let max = 0;
  for (const rel of volumeFiles(root)) {
    try { max = Math.max(max, fs.statSync(path.join(root, rel)).mtimeMs); } catch { /* ignore */ }
  }
  return max ? new Date(max).toISOString() : null;
}
function syncOpenRows(idx) {
  const count = new Map();
  for (const o of idx.open) count.set(o.file, (count.get(o.file) || 0) + 1);
  for (const v of idx.volumes) v.openRows = count.get(v.path) || 0;
}
function ensureIndex(root) {
  let idx = readIndex(root);
  if (idx) return idx;
  idx = buildIndex(root);
  saveIndex(root, idx);
  return idx;
}
function activeVolume(root) {
  const vol = readVolume(root, LEDGER);
  if (!vol) die(`找不到 ${LEDGER}（先按模板创建）`);
  if (vol.table.hdrAt < 0) die(`找不到台账表头（需要含 id 的 7 列：id|kind|位置|现象|影响|处置|状态）`);
  if (vol.table.cols === null) die("表头列数 ≠ 7 或列名不合法；不猜列，先修表头");
  return vol;
}
function activeEntry(idx) {
  return idx.volumes.find((v) => v.path === LEDGER);
}
function checkIndexFresh(vol, entry) {
  if (!entry) fail(`index_stale：索引缺活跃卷 ${LEDGER}（跑 ledger.mjs reindex）`);
  const actual = statsFromTable(vol.table, vol.body);
  if (entry.sha256 !== actual.sha256) fail(`index_stale：${LEDGER} 正文字节与索引不符（跑 ledger.mjs reindex）`);
  return actual;
}
function nextId(idx) {
  let max = 0;
  for (const v of idx.volumes) {
    const m = /^D-(\d+)$/.exec(v.last || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `D-${max + 1}`;
}
function refreshActive(root, vol, idx) {
  vol.table = tableOf(vol.body, vol.meta ? 1 : 0);
  vol.stats = statsFromTable(vol.table, vol.body);
  writeVolume(vol);
  const at = idx.volumes.findIndex((v) => v.path === LEDGER);
  const entry = { path: LEDGER, rows: vol.stats.rows, first: vol.stats.first, last: vol.stats.last, sha256: vol.stats.sha256, openRows: 0 };
  if (at >= 0) idx.volumes[at] = entry;
  else idx.volumes.push(entry);
}

function buildRow(cols, values) {
  const out = Array(7).fill("");
  for (const [key, value] of Object.entries(values)) {
    if (!(key in cols)) continue;
    out[cols[key]] = cell(value);
  }
  return `| ${out.join(" | ")} |`;
}
function appendRow(vol, rowLine) {
  const next = [...vol.body.split(/\r?\n/)];
  next.splice(vol.table.lastRow + 1, 0, rowLine);
  vol.body = next.join(vol.nl);
}

function cmdAdd(root, flags) {
  if (!KINDS.has(flags.kind)) die(`未知/缺失 --kind：${flags.kind ?? ""}（只允许 gap|defect|explain|closed）`);
  // explain 是“说明”不是待修项：未显式给 --status 时默认 closed；显式 --status open 仍允许。
  const status = flags.status ?? (flags.kind === "explain" ? "closed" : "open");
  if (!STATUSES.has(status)) die(`未知 --status：${status}（只允许 ${[...STATUSES].join("|")}）`);
  for (const key of ["where", "what", "impact", "fix"]) {
    if (typeof flags[key] !== "string" || flags[key].trim() === "") die(`add 缺必填参数 --${key}`);
  }
  const idx = ensureIndex(root);
  const vol = activeVolume(root);
  checkIndexFresh(vol, activeEntry(idx));
  const id = nextId(idx);
  const rowLine = buildRow(vol.table.cols, {
    id,
    kind: flags.kind,
    where: flags.where,
    what: `${localStamp()} — ${flags.what}`,
    why: flags.impact,
    how: flags.fix,
    status,
  });
  appendRow(vol, rowLine);
  refreshActive(root, vol, idx);
  if (isUnresolvedRow({ kind: flags.kind, status })) {
    const newRow = vol.table.rows[vol.table.rows.length - 1];
    idx.open.push({ id, kind: flags.kind, file: LEDGER, line: newRow ? newRow.line : null });
  }
  syncOpenRows(idx);
  idx.updated_at = updatedAt(root);
  saveIndex(root, idx);
  console.log(`已追加 ${id}`);
}

function findOpenRow(root, idx, id) {
  const target = idx.open.find((o) => o.id === id);
  if (!target) return null;
  const vol = readVolume(root, target.file);
  if (!vol) return null;
  const row = vol.table.rows.find((r) => r.id === id);
  if (!row) return null;
  return { file: target.file, line: row.line, row, vol };
}

function cmdClose(root, positional, flags) {
  if (positional.length !== 1) die("用法：ledger.mjs close <D-n> --fix <处置>");
  const id = positional[0];
  if (!/^D-\d+$/.test(id)) die(`id 不合法：${id}（应为 D-<数字>）`);
  if (typeof flags.fix !== "string" || flags.fix.trim() === "") die("close 缺必填参数 --fix");
  const idx = ensureIndex(root);
  const active = activeVolume(root);
  checkIndexFresh(active, activeEntry(idx));
  const found = findOpenRow(root, idx, id);
  if (!found) die(`找不到未关闭的台账行 ${id}（不写文件；已关闭的项无需再 close）`);
  const closeId = nextId(idx);
  const rowLine = buildRow(active.table.cols, {
    id: closeId,
    kind: "closed",
    where: `${found.file}:${found.line}`,
    what: `${localStamp()} — 关闭 ${id}`,
    why: "关闭记录（append-only，旧行不改）",
    how: `关闭 ${id}：${flags.fix}`,
    status: "fixed",
  });
  appendRow(active, rowLine);
  refreshActive(root, active, idx);
  idx.open = idx.open.filter((o) => o.id !== id);
  syncOpenRows(idx);
  idx.updated_at = updatedAt(root);
  saveIndex(root, idx);
  console.log(`已追加 ${closeId}（关闭 ${id}）`);
}

function cmdList(root, flags) {
  const vols = volumeFiles(root);
  const all = [];
  for (const rel of vols) {
    const vol = readVolume(root, rel);
    if (!vol) continue;
    for (const row of vol.table.rows) all.push({ ...row, file: rel });
  }
  let limit = Number.POSITIVE_INFINITY;
  if (flags.limit !== undefined) {
    if (!/^\d+$/.test(String(flags.limit)) || Number(flags.limit) <= 0) die("--limit 需要一个正整数（如 --limit 5；0 与 abc 都不合法）");
    limit = Number(flags.limit);
  }
  const rows = flags.open
    ? (() => { const closed = closedIdsOf(all); return all.filter((row) => isUnresolvedRow(row, closed)); })()
    : all;
  // 直接以正文为准过滤：explain 的 open 行（如 D-164）也要出现，
  // 不依赖旧索引里只收 gap/defect 的缓存。
  for (const row of Number.isFinite(limit) ? rows.slice(0, limit) : rows) {
    console.log(`| ${row.cells.map(cell).join(" | ")} |`);
  }
}

function cmdRotate(root, flags) {
  if (typeof flags.to !== "string" || flags.to.trim() === "") die("rotate 缺必填参数 --to（如 .sdo/ledger/vol-1.md）");
  const to = flags.to.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^\.sdo\/ledger\/vol-\d+\.md$/.test(to)) die(`--to 必须是 .sdo/ledger/vol-<n>.md：${to}`);
  const target = path.join(root, to);
  if (fs.existsSync(target)) die(`归档卷已存在：${to}（不覆盖）`);
  const idx = ensureIndex(root);
  const active = activeVolume(root);
  const stats = checkIndexFresh(active, activeEntry(idx));
  if (stats.rows === 0) die("活跃卷为空，无需 rotate");
  active.stats = stats;
  writeVolume(active);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(root, LEDGER), target);
  const at = idx.volumes.findIndex((v) => v.path === LEDGER);
  if (at >= 0) idx.volumes[at] = { path: to, rows: stats.rows, first: stats.first, last: stats.last, sha256: stats.sha256 };
  for (const o of idx.open) if (o.file === LEDGER) o.file = to;
  const empty = { rel: LEDGER, file: path.join(root, LEDGER), nl: "\n", body: EMPTY_BODY, stats: statsFor(EMPTY_BODY), table: tableOf(EMPTY_BODY) };
  writeVolume(empty);
  idx.volumes.push({ path: LEDGER, rows: 0, first: "-", last: "-", sha256: empty.stats.sha256 });
  syncOpenRows(idx);
  idx.updated_at = updatedAt(root);
  saveIndex(root, idx);
  console.log(`已轮转：${LEDGER} → ${to}（新活跃卷 0 行）`);
}

function cmdReindex(root) {
  const idx = buildIndex(root);
  for (const rel of volumeFiles(root)) {
    const vol = readVolume(root, rel);
    if (!vol) continue;
    const st = statsFor(vol.body);
    const want = `${metaLine(st)}${vol.nl}${vol.body}`;
    if (vol.text !== want) writeAtomic(vol.file, want);
  }
  idx.updated_at = updatedAt(root);
  saveIndex(root, idx);
  console.log(`已重建索引：${idx.volumes.length} 卷 / ${idx.open.length} 未决`);
}

const ALLOWED_FLAGS = {
  add: new Set(["kind", "where", "what", "impact", "fix", "status"]),
  close: new Set(["fix"]),
  list: new Set(["open", "limit"]),
  rotate: new Set(["to"]),
  reindex: new Set(),
};
if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(`用法：
  node <skill>/scripts/ledger.mjs add --kind <gap|defect|explain> --where <位置> --what <现象> --impact <影响> --fix <处置> [--status <状态>]
  node <skill>/scripts/ledger.mjs close <D-n> --fix <处置>
  node <skill>/scripts/ledger.mjs list [--open]
  node <skill>/scripts/ledger.mjs rotate --to .sdo/ledger/vol-1.md
  node <skill>/scripts/ledger.mjs reindex`);
  process.exit(0);
}
const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
try {
  if (ALLOWED_FLAGS[cmd]) {
    for (const key of Object.keys(flags)) {
      if (key === "open") continue; // 布尔开关，独立解析
      if (!ALLOWED_FLAGS[cmd].has(key)) die(`未知参数 --${key}（${cmd} 只接受 ${[...ALLOWED_FLAGS[cmd]].map((k) => "--" + k).join(" ") || "无参数"}）`);
    }
  }
  const root = findRoot(process.cwd());
  if (!root) die("找不到 .sdo/：请在本项目内运行（台账脚本只读写 .sdo/）");
  if (cmd === "add") cmdAdd(root, flags);
  else if (cmd === "close") cmdClose(root, positional, flags);
  else if (cmd === "list") {
    if (positional.length) die("list 不接受位置参数（只读）");
    cmdList(root, flags);
  } else if (cmd === "rotate") {
    if (positional.length) die("rotate 不接受位置参数；用 --to <file>");
    cmdRotate(root, flags);
  } else if (cmd === "reindex") {
    if (positional.length) die("reindex 不接受位置参数");
    cmdReindex(root);
  } else die(`未知命令：${cmd}（只允许 add|close|list|rotate|reindex）`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
