// 追溯链解析单点：需求、卡面 references:、里程碑认领需求、卡证据表、探索结论。
// view.mjs trace 与 check.mjs --trace 都从这里取数据，禁止各自再写正则。
import fs from "node:fs";
import path from "node:path";

export const TEST_BASELINE_TITLE = "测试引用基线段";
export const MEANINGLESS_REASONS = new Set([
  "无", "没有", "不适用", "不需要", "无所谓", "待补充", "略", "同上", "见上", "后续再看",
]);

function lines(text) { return text.split(/\r?\n/); }
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
      if (j - i + 1 < 3) code = !code;
      i = j;
      continue;
    }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isSep(line) { return line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line); }

function tableAt(ls, start) {
  while (start < ls.length && !ls[start].trim()) start++;
  if (!ls[start] || !ls[start].trim().startsWith("|") || !isSep(ls[start + 1])) return null;
  const header = cells(ls[start]);
  const rows = [];
  let i = start + 2;
  for (; i < ls.length && ls[i].trim().startsWith("|"); i++) {
    if (isSep(ls[i])) continue;
    rows.push({ cells: cells(ls[i]), line: i + 1 });
  }
  return { header, rows, end: i };
}

export function readRequirements(root) {
  const rel = ".sdo/baseline/requirement.md";
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { file: rel, items: [] };
  const ls = lines(fs.readFileSync(abs, "utf8"));
  const items = [];
  for (let i = 0; i < ls.length; i++) {
    const m = /^###\s+(R-\d+)\s+(.+?)\s*$/.exec(ls[i]);
    if (!m) continue;
    let acceptance = "", guarantee = "";
    for (let j = i + 1; j < ls.length && !/^###\s/.test(ls[j]) && !/^##\s/.test(ls[j]); j++) {
      if (/^- 验收口径[:：]/.test(ls[j])) acceptance = ls[j];
      if (/^- 不保证[:：]/.test(ls[j])) guarantee = ls[j];
    }
    items.push({ id: m[1], title: m[2], line: i + 1, acceptance, guarantee });
  }
  return { file: rel, items };
}

export function readCards(root) {
  const dir = path.join(root, ".sdo/cards");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const id = f.slice(0, -3);
    const rel = `.sdo/cards/${f}`;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const ls = lines(text);
    const st = /^status:\s*([A-Za-z_-]+)/m.exec(text);
    const refsLine = /^references:\s*(.*)$/m.exec(text);
    const refs = refsLine ? [...refsLine[1].matchAll(/R-\d+/g)].map((m) => m[0]) : [];
    let criteria = [], evidence = [];
    for (let i = 0; i < ls.length; i++) {
      if (/^##\s*判据\s*$/.test(ls[i])) {
        const t = tableAt(ls, i + 1);
        if (t) {
          const first = t.header.findIndex((h) => h.includes("编号"));
          criteria = t.rows.map((r) => r.cells[first < 0 ? 0 : first]).filter((x) => /^C\d+$/.test(x));
          i = t.end;
        }
      } else if (/^##\s*证据\s*$/.test(ls[i])) {
        const t = tableAt(ls, i + 1);
        if (t) {
          const ci = t.header.findIndex((h) => h.includes("判据"));
          const oi = t.header.findIndex((h) => h.includes("命令") || h.includes("输出"));
          evidence = t.rows.map((r) => ({
            criterion: (r.cells[ci < 0 ? 0 : ci] || "").replace(/[`*]/g, "").trim(),
            command: oi < 0 ? "" : (r.cells[oi] || "").trim(),
            line: r.line,
          })).filter((e) => e.criterion);
          i = t.end;
        }
      }
    }
    return { id, file: rel, status: st ? st[1] : "?", refs, refsDeclared: Boolean(refsLine), criteria, evidence, lines: ls };
  });
}

export function readClaims(root) {
  const dir = path.join(root, ".sdo/milestones");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^M\d+\.md$/.test(x)).sort()) {
    const rel = `.sdo/milestones/${f}`;
    const ls = lines(fs.readFileSync(path.join(dir, f), "utf8"));
    for (let i = 0; i < ls.length; i++) {
      const m = /^认领需求[:：]\s*(.+)$/.exec(ls[i]);
      if (!m) continue;
      const ids = [...m[1].matchAll(/R-\d+/g)].map((x) => x[0]);
      if (ids.length) out.push({ milestone: f.slice(0, -3), ids, file: rel, line: i + 1 });
    }
  }
  return out;
}

function baselineMilestones(root) {
  const p = path.join(root, ".sdo/milestones/M8.md");
  if (!fs.existsSync(p)) return new Set();
  const ls = lines(fs.readFileSync(p, "utf8"));
  const line = ls.find((l) => l.includes(TEST_BASELINE_TITLE));
  if (!line) return new Set();
  const after = line.slice(Math.max(line.lastIndexOf(":"), line.lastIndexOf("：")) + 1);
  return new Set([...after.matchAll(/M(\d+)/g)].map((m) => `M${m[1]}`));
}

function testRef(command) {
  const c = command.replace(/`/g, "").trim();
  if (!c) return false;
  if (/(?:^|[\s;；`])(?:node\b|test -f\b|grep\b|sha256sum\b|git\b|npm\b)/.test(c)) return true;
  const p = c.match(/(?:^|\s)((?:skills\/sdo-flow\/scripts|test|probe)\/[^\s:;`]+):\d+/);
  return Boolean(p);
}

function meaningful(s) { return s.replace(/[\s\p{P}\p{S}]/gu, "").length >= 8; }

function cardCriteria(root, id) {
  const cards = readCards(root);
  return new Set((cards.find((c) => c.id === id) || { criteria: [] }).criteria);
}

function exploreConclusions(root, card) {
  if (!card || card.status !== "done") return [];
  const ls = card.lines;
  const at = ls.findIndex((l) => /^##\s*探索结论\s*$/.test(l));
  if (at < 0) return [];
  const t = tableAt(ls, at + 1);
  if (!t) return [];
  return t.rows.map((r) => ({
    conclusion: r.cells[0] || "", evidence: r.cells[1] || "", dest: r.cells[2] || "", reason: r.cells[3] || "", line: r.line,
  }));
}

export function analyzeTrace(root) {
  const reqs = readRequirements(root).items;
  const cards = readCards(root);
  const claims = readClaims(root);
  const reqIds = new Set(reqs.map((r) => r.id));
  const byReq = new Map(reqs.map((r) => [r.id, []]));
  const dangling = [];
  let edges = 0;
  for (const c of cards) {
    if (!c.refsDeclared) continue;
    for (const id of c.refs) {
      edges++;
      if (!reqIds.has(id)) { dangling.push({ id, card: c.id, file: c.file }); continue; }
      byReq.get(id).push(c.id);
    }
  }
  const orphanCards = cards.filter((c) => c.refs.length === 0);
  const covered = reqs.filter((r) => (byReq.get(r.id) || []).length > 0).length;
  const orphanReqs = reqs.filter((r) => (byReq.get(r.id) || []).length === 0);
  const issues = [];
  const reqLine = new Map(reqs.map((r) => [r.id, r.line]));
  for (const r of orphanReqs) issues.push({ code: "trace_orphan_requirement", file: ".sdo/baseline/requirement.md", line: r.line, message: `${r.id} 无任何卡引用` });
  for (const d of dangling) issues.push({ code: "trace_dangling_ref", file: d.file, line: 1, message: `${d.id}（${d.card}）不在需求基线` });
  const byMilestone = new Map();
  for (const cl of claims) for (const id of cl.ids) {
    if (!byMilestone.has(id)) byMilestone.set(id, []);
    byMilestone.get(id).push(cl);
  }
  for (const [id, cls] of byMilestone) {
    const ms = [...new Set(cls.map((c) => c.milestone))];
    if (ms.length > 1) issues.push({ code: "trace_duplicate_claim", file: cls[0].file, line: cls[0].line, message: `${id} 被 ${ms.join("、")} 同时认领` });
  }
  const baseline = baselineMilestones(root);
  for (const c of cards) {
    if (c.status !== "done") continue;
    const m = /^(M\d+)-/.exec(c.id);
    if (!m || baseline.has(m[1])) continue;
    const evByCriterion = new Map();
    for (const e of c.evidence) {
      if (!evByCriterion.has(e.criterion)) evByCriterion.set(e.criterion, []);
      evByCriterion.get(e.criterion).push(e);
    }
    for (const cid of c.criteria) {
      const rows = evByCriterion.get(cid) || [];
      if (!rows.length) { issues.push({ code: "trace_orphan_test", file: c.file, line: 1, message: `${c.id} ${cid} 缺证据行` }); continue; }
      const empty = rows.find((r) => !r.command);
      if (empty) { issues.push({ code: "trace_orphan_test", file: c.file, line: empty.line, message: `${c.id} ${cid} 证据命令为空` }); continue; }
      const bad = rows.find((r) => !testRef(r.command));
      if (bad) issues.push({ code: "trace_test_unverifiable", file: c.file, line: bad.line, message: `${c.id} ${cid} 证据不是可复跑命令或脚本:行` });
    }
    const concl = exploreConclusions(root, c);
    if (c.id === "M8-0") {
      if (concl.length < 3) issues.push({ code: "explore_conclusion_malformed", file: c.file, line: 1, message: `探索结论行数 ${concl.length} < 3` });
      const m8_1 = cardCriteria(root, "M8-1");
      const m8_2 = cardCriteria(root, "M8-2");
      for (const r of concl) {
        if (!r.conclusion || !r.evidence || !r.dest) { issues.push({ code: "explore_conclusion_malformed", file: c.file, line: r.line, message: "结论/证据命令/去向不能为空" }); continue; }
        if (r.dest === "不采纳") {
          if (!meaningful(r.reason) || MEANINGLESS_REASONS.has(r.reason.trim())) {
            issues.push({ code: "explore_conclusion_malformed", file: c.file, line: r.line, message: "不采纳理由过短或为套话" });
          }
          continue;
        }
        const dm = /^M8-([12])\s+C(\d+)$/.exec(r.dest);
        if (!dm) { issues.push({ code: "explore_conclusion_malformed", file: c.file, line: r.line, message: `去向无法解析：${r.dest}` }); continue; }
        if (dm[1] === "1" && dm[2] === "8") { issues.push({ code: "explore_conclusion_malformed", file: c.file, line: r.line, message: "不能以待收敛的 M8-1 C8 自证" }); continue; }
        const target = dm[1] === "1" ? m8_1 : m8_2;
        if (!target.has(`C${dm[2]}`)) issues.push({ code: "explore_conclusion_malformed", file: c.file, line: r.line, message: `去向 ${r.dest} 不存在` });
      }
    }
  }
  return {
    requirements: reqs, cards, claims, counts: { requirements: reqs.length, covered, edges, orphanRequirements: orphanReqs.length, orphanCards: orphanCards.length, dangling: dangling.length },
    byReq, orphanCards, orphanReqs, dangling, issues,
  };
}
