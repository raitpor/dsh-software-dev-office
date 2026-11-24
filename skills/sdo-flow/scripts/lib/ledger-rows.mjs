/**
 * 台账行解析的唯一入口（M12-2）。
 *
 * 历史台账行里存在未转义的 `|`（自由文本），朴素 split 会把一行拆成
 * 多于表头的列。本模块把多出来的片段**并入「处置」列、状态永远取最后一段**，
 * 不修改任何正文；列数少于表头的行进入 malformed，由调用方报出。
 * view / check 共用；ledger.mjs add/close/reindex 另有自己的 cells()（不在本卡范围）。
 */

function splitCells(line) {
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
    if (ch === "\\") { cur += ch; esc = true; continue; }
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

const isSep = (line) => line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line);
const norm = (s) => String(s ?? "").replace(/`/g, "").trim();

/**
 * @param {string} text
 * @returns {{header: string[], rows: Array<{line:number,id:string,kind:string,cells:string[],extraTail:string|null}>, malformed: Array<{line:number,id:string,cells:string[]}>}}
 */
export function parseLedgerRows(text) {
  const lines = String(text).split(/\r?\n/);
  let header = null;
  let hdrAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s.startsWith("|") || isSep(lines[i]) || !isSep(lines[i + 1])) continue;
    const h = splitCells(lines[i]);
    if (h.some((x) => norm(x).toLowerCase() === "id")) { header = h; hdrAt = i; break; }
  }
  if (!header) return { header: [], rows: [], malformed: [] };
  const rows = [];
  const malformed = [];
  for (let i = hdrAt + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) break;
    if (isSep(lines[i])) continue;
    const raw = splitCells(lines[i]);
    let cells = raw;
    let extra = 0;
    let extraTail = null;
    if (raw.length > header.length) {
      extra = raw.length - header.length;
      const howIdx = header.findIndex((h) => norm(h) === "处置");
      const hIdx = howIdx >= 0 ? howIdx : header.length - 2;
      const before = raw.slice(0, hIdx);
      const middle = raw.slice(hIdx, raw.length - 1);
      const status = raw[raw.length - 1];
      extraTail = middle.slice(1).join(" | ");
      cells = [...before, middle.join(" | "), status];
    }
    const idx = Object.fromEntries(header.map((h, j) => [norm(h), j]));
    const id = norm(cells[idx.id] ?? "");
    if (cells.length < header.length) {
      malformed.push({ line: i + 1, id, cells });
      continue;
    }
    rows.push({ line: i + 1, id, kind: cells[idx.kind] ?? "", cells, extra, extraTail });
  }
  return { header, rows, malformed };
}

/** 诊断输出：id: 归一后列数（有裸竖线并入时附 extra N）。view/check 共用。 */
export function formatColumnDiagnostics(text) {
  const t = parseLedgerRows(text);
  const lines = [];
  for (const r of t.rows) lines.push(`${r.id}: ${r.cells.length}${r.extra > 0 ? ` (extra ${r.extra})` : ""}`);
  for (const m of t.malformed) lines.push(`${m.id || "（无 id）"}: ${m.cells.length}`);
  return lines.join("\n");
}
