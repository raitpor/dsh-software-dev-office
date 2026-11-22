// 归档事实的唯一读取/完整性判定（M8-3）。
// INDEX.md 是归档事实的唯一登记处；check/view/archive 共用本模块。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ARCHIVE_INDEX = ".sdo/archive/INDEX.md";
export const ARCHIVE_STATUSES = ["已归档", "已恢复"];
const HEADER = ["里程碑", "门签号", "被签树", "文件数", "文件 sha256", "状态"];
const ALIAS = { 里程碑: "milestone", 门签号: "gate", 被签树: "tree", 文件数: "count", "文件 sha256": "manifest", 状态: "status" };

function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((x) => x.trim());
}
function esc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n/g, " "); }
function isSep(l) { return l !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(l); }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

export function readArchiveIndex(root) {
  const p = path.join(root, ARCHIVE_INDEX);
  if (!fs.existsSync(p)) return [];
  const ls = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const h = ls.findIndex((l) => l.trim().startsWith("|") && l.includes("里程碑"));
  if (h < 0) return [];
  const header = cells(ls[h]).map((x) => x.replace(/`/g, "").trim());
  const ix = (n) => header.findIndex((x) => x === n);
  const rows = [];
  for (let i = h + 1; i < ls.length; i++) {
    const raw = ls[i].trim();
    if (!raw.startsWith("|")) break;
    if (isSep(raw)) continue;
    const c = cells(raw);
    const milestone = (c[ix("里程碑")] || "").trim();
    if (!/^M\d+$/.test(milestone)) continue;
    let manifest = {};
    try { manifest = JSON.parse((c[ix("文件 sha256")] || "{}").replace(/`/g, "")); } catch { manifest = {}; }
    rows.push({
      milestone,
      gate: c[ix("门签号")] || "-",
      tree: c[ix("被签树")] || "-",
      count: Number(c[ix("文件数")] || 0),
      manifest,
      status: (c[ix("状态")] || "").trim(),
    });
  }
  return rows;
}

export function writeArchiveIndex(root, rows) {
  const out = ["# 归档索引", "", `| ${HEADER.join(" | ")} |`, `|${HEADER.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.milestone} | ${r.gate} | ${r.tree} | ${r.count} | ${esc(JSON.stringify(r.manifest))} | ${r.status} |`);
  fs.mkdirSync(path.join(root, ".sdo/archive"), { recursive: true });
  fs.writeFileSync(path.join(root, ARCHIVE_INDEX), `${out.join("\n")}\n`);
}

export function archiveEntry(root, m) {
  return readArchiveIndex(root).find((r) => r.milestone === m && r.status === "已归档") || null;
}

export function archiveIndexInvalid(root) {
  return readArchiveIndex(root).filter((r) => !ARCHIVE_STATUSES.includes(r.status));
}

export function isArchived(root, m) {
  return archiveEntry(root, m) !== null;
}

function countFiles(dir) {
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

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

export function orphanArchiveDirs(root) {
  const index = readArchiveIndex(root);
  // INDEX 有行（含非法状态）就不算“孤儿目录”；非法状态由 archive_index_invalid 单独报。
  const known = new Set(index.map((r) => r.milestone));
  const base = path.join(root, ".sdo/archive");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^M\d+$/.test(e.name) && !known.has(e.name))
    .filter((e) => countFiles(path.join(base, e.name)) > 0)
    .map((e) => e.name)
    .sort();
}

// 返回 [{path, line, msg}]；check 逐条转成 ERROR。
// 报错顺序：先判两侧文件是否存在，再判文件数/逐文件哈希（P3）。
export function assertArchivedIntegrity(root) {
  const issues = [];
  for (const r of archiveIndexInvalid(root)) {
    issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_index_invalid：${r.milestone} 的 INDEX 状态非法（${r.status}；只认 已归档/已恢复）` });
  }
  for (const m of orphanArchiveDirs(root)) {
    issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_orphan_directory：${m} 归档目录有文件但 INDEX 无对应行（先补 INDEX 或 restore）` });
  }
  for (const r of readArchiveIndex(root)) {
    const dir = path.join(root, `.sdo/archive/${r.milestone}`);
    const actualFiles = countFiles(dir);
    if (r.status === "已恢复") {
      if (actualFiles > 0) issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `归档状态与实际不符：${r.milestone}（已恢复但归档目录仍有 ${actualFiles} 个文件）` });
      continue;
    }
    if (r.status !== "已归档") continue;
    const entries = Object.entries(r.manifest);
    const archivedMs = path.join(dir, "milestone.md");
    const sourceMs = path.join(root, `.sdo/milestones/${r.milestone}.md`);
    const hasArchived = fs.existsSync(archivedMs);
    const hasSource = fs.existsSync(sourceMs);
    // 1) 先固定报“两侧存在性”（整目录删除时首条必须是 not_moved）
    if (!hasArchived && !hasSource) {
      issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_milestone_not_moved：${r.milestone} 的里程碑文件既不在 .sdo/milestones/ 也不在归档里` });
      continue;
    }
    if (!hasArchived) {
      issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_milestone_not_moved：${r.milestone} 未搬入归档（INDEX 已登记但 .sdo/archive/${r.milestone}/milestone.md 不存在）` });
      continue;
    }
    if (hasSource) {
      issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_milestone_not_moved：${r.milestone} 的原文件 .sdo/milestones/${r.milestone}.md 又出现了（优先读原文件会让归档正文被旧副本遮住，请删原文件或 restore）` });
      continue;
    }
    if (!r.manifest["milestone.md"]) {
      issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_milestone_not_moved：${r.milestone} 的 INDEX 未登记 milestone.md` });
      continue;
    }
    // 2) 再判里程碑哈希
    if (sha256(archivedMs) !== r.manifest["milestone.md"]) {
      issues.push({ path: ARCHIVE_INDEX, line: 0, msg: `archive_milestone_not_moved：${r.milestone} 的 milestone.md sha256 不符` });
      continue;
    }
    // 3) 再判双向文件集合/条数：先点名多/缺文件
    const actualList = listFiles(dir);
    const manifestKeys = Object.keys(r.manifest).sort();
    const missing = manifestKeys.filter((k) => !actualList.includes(k));
    const extra = actualList.filter((k) => !manifestKeys.includes(k));
    if (missing.length || extra.length || actualList.length !== manifestKeys.length || r.count !== manifestKeys.length) {
      const bits = [];
      if (missing.length) bits.push(`缺 ${missing.join("、")}`);
      if (extra.length) bits.push(`多 ${extra.join("、")}`);
      if (!bits.length) bits.push(`文件数 索引 ${r.count} / manifest ${manifestKeys.length} / 磁盘 ${actualList.length}`);
      issues.push({ path: `.sdo/archive/${r.milestone}`, line: 0, msg: `archive_integrity_mismatch：${r.milestone} 文件集合不符（${bits.join("；")}）` });
    }
    for (const [key, hash] of entries) {
      if (key === "milestone.md") continue;
      const p = path.join(dir, key);
      if (!fs.existsSync(p)) { if (!missing.includes(key)) issues.push({ path: `.sdo/archive/${r.milestone}/${key}`, line: 0, msg: `archive_integrity_mismatch：${r.milestone} 缺文件 ${key}` }); continue; }
      if (sha256(p) !== hash) issues.push({ path: `.sdo/archive/${r.milestone}/${key}`, line: 0, msg: `归档文件哈希不符：${key}` });
    }
  }
  return issues;
}
