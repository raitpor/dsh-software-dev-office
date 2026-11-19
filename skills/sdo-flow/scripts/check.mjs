#!/usr/bin/env node
// sdo-flow 文本检查器（Node 18+，零依赖，Windows/Linux 通用）
// 用法（项目内任意目录）：node <skill>/scripts/check.mjs [--presets [判据源文件]] [--all]
// 退出码：0 全过；1 有错误；2 找不到 .sdo/。只读，不改文件。
// 扫描范围：默认只查 .sdo/ 与本项目里带 SKILL.md 的 skill 目录（避让他人文档）；--all 才扫整个仓库。
// --presets 不带参数：校验四份 preset 与发布快照（stage 集合、gate 集合、criteria 逐条名称）
// --presets <文件>：与外部判据源逐条比对（可用设计稿 §1.1 原文）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const SELF = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // <skill> 目录（脚本可在项目外）
const SELF_REL = path.relative(ROOT, SELF).split(path.sep).join("/");
const ARGV = process.argv.slice(2);
const ERR = [], WARN = [];
const KINDS = new Set(["gap", "defect", "explain"]);
const STATUS = new Set(["open", "accepted", "fixed", "closed", "superseded"]);
const err = (p, l, m) => ERR.push(`${p}:${l}: ${m}`);
const warn = (p, l, m) => WARN.push(`${p}:${l}: ${m}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").split(/\r?\n/);
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// 找到项目内所有“带 SKILL.md 的 skill 目录”（最多下探 3 层）
function skillDirs() {
  const out = [];
  (function walk(dir, depth) {
    const abs = path.join(ROOT, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) { out.push(dir); return; }
    if (depth >= 3) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (["node_modules", ".git", "lib", "dist"].includes(e.name)) continue;
      walk(dir ? `${dir}/${e.name}` : e.name, depth + 1);
    }
  })("", 0);
  if (SELF_REL && !SELF_REL.startsWith("..") && !out.includes(SELF_REL)) out.push(SELF_REL);
  return out;
}

function mdFiles() {
  const out = [];
  const roots = ARGV.includes("--all") ? [""] : [".sdo", ...skillDirs()];
  for (const root of roots) {
    if (root && !exists(root)) continue;
    (function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "lib" || e.name === "dist") continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".md")) out.push(rel);
      }
    })(root);
  }
  return [...new Set(out)];
}

function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = [];
  let cur = "", esc = false, code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "`") {
      // 反引号连写（``` / ``）整体算一个定界符，避免奇数个反引号把后续 | 吞掉
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

function checkTables(p, lines) {
  let tbl = null, fence = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim(), ln = i + 1;
    if (/^(```|~~~)/.test(s)) { fence = !fence; tbl = null; continue; }
    if (fence) continue;
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
  if (!exists(p)) return err(p, 0, "缺文件");
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
  const doneCard0 = exists(".sdo/cards") && fs.readdirSync(path.join(ROOT, ".sdo/cards")).filter((f) => f.endsWith(".md"))
    .some((f) => /^status:\s*(done|in_progress)\b/m.test(fs.readFileSync(path.join(ROOT, ".sdo/cards", f), "utf8")));
  const hasReadings0 = exists(".sdo/readings") && fs.readdirSync(path.join(ROOT, ".sdo/readings")).some((f) => f.endsWith(".md"));
  if (!exists(d)) return (doneCard0 || hasReadings0) ? err(d, 0, "缺签字目录") : warn(d, 0, "缺 .sdo/sign/（初始化期可接受：签 S1 前建）");
  const files = fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) {
    const doneCard = exists(".sdo/cards") && fs.readdirSync(path.join(ROOT, ".sdo/cards")).filter((f) => f.endsWith(".md"))
      .some((f) => /^status:\s*done/m.test(fs.readFileSync(path.join(ROOT, ".sdo/cards", f), "utf8")));
    const hasReadings = exists(".sdo/readings") && fs.readdirSync(path.join(ROOT, ".sdo/readings")).some((f) => f.endsWith(".md"));
    if (doneCard || hasReadings) err(d, 0, "没有签字文件（已有 done 卡/读数，不能没有生效签字）");
    else warn(d, 0, "还没有签字文件（初始化期可接受：写完意图后请人签 S1，再写计划）");
  }
  let effective = 0;
  for (const f of files) {
    const p = `${d}/${f}`, text = read(p).join("\n");
    for (const k of ["时间", "选项", "被签对象"]) {
      if (!new RegExp(`^\\s*-?\\s*${k}[:：]\\s*\\S`, "m").test(text)) err(p, 0, `缺字段或值为空：${k}（应写成「- ${k}：…」）`);
    }
    const tm = text.match(/^\s*-?\s*时间[:：]\s*([^\n]*)$/m);
    const bm = text.match(/^\s*-?\s*被签对象[:：]\s*([^\n]*)$/m);
    if (tm && /[<>]/.test(tm[1])) err(p, 0, "时间还是模板占位（<…>）：必须填真实时刻（ISO8601 带时区）");
    if (bm && /[<>]/.test(bm[1])) err(p, 0, "被签对象还是模板占位（<…>）：必须填真实 commit / 文件哈希");
    const om = text.match(/选项[:：]\s*([^\n]*)/);
    const opt = om ? om[1] : "";
    if (/[<>]/.test(opt)) err(p, 0, "选项还是模板占位（<…>）：必须填真人回答的三选一");
    else if (!/^\s*(?:[-*]\s*)?[*_`]*\s*(签|改|不签)[：:]/.test(opt)) err(p, 0, "选项必须以「签：/改：/不签：」开头（不允许“未签/待签/代签”）");
    if (/^\s*(?:[-*]\s*)?[*_`]*\s*不签[：:]/.test(opt)) continue; // 「不签」不是生效签字，不计入
    effective++;
    if (!/^\s*-?\s*方式[^：:\n]{0,24}[:：]\s*\S/m.test(text)) warn(p, 0, "建议写明方式（本人 / 代笔（须写确认方式））");
  }
  if (files.length && effective === 0) err(d, 0, "没有生效签字（只有「不签」或占位）");
}

function checkCards() {
  const d = ".sdo/cards";
  if (!exists(d)) return warn(d, 0, "还没有卡（里程碑早期可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, lines = read(p), text = lines.join("\n");
    for (const s of ["判据", "证据", "判定", "评审"]) if (!new RegExp("^##\\s*" + s + "(?:\\s|$)", "m").test(text)) err(p, 0, `缺段落：## ${s}`);
    const sm = text.match(/^status:\s*(open|in_progress|done)/m);
    if (!sm) err(p, 0, "缺 status: open|in_progress|done");
    if (sm && sm[1] === "done") {
      // 证据表至少一行数据（表头 + 分隔行之后）
      const at = lines.findIndex((l) => /^##\s*证据(?:\s|$)/.test(l.trim()));
      let rows = 0;
      if (at >= 0) {
        let inTbl = false;
        for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
          const s = lines[i].trim();
          if (s.startsWith("|")) { if (inTbl && !isSep(s)) rows++; else inTbl = true; }
          else if (s) inTbl = false;
        }
      }
      if (!rows) warn(p, 0, "status: done 但证据表没有数据行");
      // done 卡：判据段点名的每条 Cx，都要在证据表里有一行非空命令/文件:行
      const critSec = (() => {
        const a = lines.findIndex((l) => /^##\s*判据(?:\s|$)/.test(l.trim()));
        if (a < 0) return "";
        const b = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
        return lines.slice(a + 1, b < 0 ? undefined : b).join("\n");
      })();
      const critIds = [];
      for (const m of critSec.matchAll(/\b(C\d+)\s*[–—~-]\s*C?(\d+)\b/g)) {
        for (let n = +m[1].slice(1); n <= +m[2]; n++) critIds.push(`C${n}`);
      }
      for (const m of critSec.matchAll(/\bC(\d+)\b/g)) critIds.push(`C${m[1]}`);
      const critSet = [...new Set(critIds)];
      if (critIds.length) {
        const at2 = lines.findIndex((l) => /^##\s*证据(?:\s|$)/.test(l.trim()));
        const evRows = [];
        if (at2 >= 0) for (let i = at2 + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
          const s2 = lines[i].trim();
          if (s2.startsWith("|") && !isSep(s2)) evRows.push(cells(s2));
        }
        const filled = new Set();
        for (const r of evRows) {
          const rawId = (r[0] || "").replace(/`/g, "").trim();
          const id = /^\d+$/.test(rawId) ? (r[1] || "").replace(/`/g, "").trim() : rawId;
          const rest = r.slice(1).map((x) => x.trim()).filter(Boolean).join(" ");
          // 证据行首格可写「C1」「C1–C3」「C1、C2」
          const rowIds = new Set();
          for (const m of id.matchAll(/C(\d+)\s*[–—~-]\s*C?(\d+)/g)) for (let n = +m[1]; n <= +m[2]; n++) rowIds.add(`C${n}`);
          for (const m of id.matchAll(/C(\d+)/g)) rowIds.add(`C${m[1]}`);
          if (rest && !/^[—–-]$/.test(rest)) for (const x of rowIds) if (critSet.includes(x)) filled.add(x);
        }
        const missing = critSet.filter((id) => !filled.has(id));
        if (missing.length) err(p, 0, `status: done 但判据没有可复跑证据：${missing.join("、")}（证据表每行须写命令或 文件:行）`);
      }
      const rel = lines.findIndex((l) => /^##\s*评审(?:\s|$)/.test(l.trim()));
      const relText = rel >= 0 ? lines.slice(rel, rel + 20).join("\n") : "";
      if (!/评审者[:：]/.test(relText)) warn(p, 0, "评审段缺「评审者」（须写明独立性；无第二席位时写「自审（非独立）」）");
    }
  }
}

const VERDICT = /\b(pass|partial|fail)\b/i;
function checkReadings() {
  const d = ".sdo/readings";
  if (!exists(d)) return warn(d, 0, "还没有读数（里程碑门前可接受）");
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".md")).sort()) {
    const p = `${d}/${f}`, lines = read(p);
    // overall 必须是独立的一行（标题/列表项），不能是表格某格里的字样
    const HEAD = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?[*_`]*overall\b/i;
    const idx = lines.findIndex((l) => HEAD.test(l));
    if (idx < 0) { err(p, 0, "缺 overall 判定（应为独立一行，如「## overall：pass」）"); continue; }
    const V = /\b(pass|partial|fail)\b/i;
    let v = null;
    const m1 = lines[idx].match(/overall\b[^A-Za-z\n]*(pass|partial|fail)\b/i);
    if (m1) v = m1[1];
    else {
      // 允许中间夹空行（最多 2 行）
      for (let k = 1; k <= 2 && !v; k++) {
        const m2 = (lines[idx + k] || "").match(/^\s*[*_`\s:：|—–-]*(pass|partial|fail)\b/i);
        if (m2) v = m2[1];
      }
    }
    if (!v) err(p, idx + 1, "overall 的取值必须是 pass/partial/fail（可同行，或写在紧接的下一行）");
    const body = lines.filter((l) => !l.trimStart().startsWith(">")).join("\n");
    if (/<[^>\n]*>/.test(body)) err(p, 0, "还有模板占位（<…>）：读数必须写实测值与命令，不留占位");
    if (/\bTODO\b/.test(lines.join("\n"))) err(p, 0, "还有 TODO：读数必须给结论（未做就写 partial 并说明）");
    // 逐条读数：每个 `## R…` 段内必须有 verdict（overall 行不算）
    let cur = null; const secs = [];
    for (const l of lines) {
      const m = l.match(/^##\s+(.*)$/);
      if (m) { cur = { title: m[1].trim(), body: [] }; secs.push(cur); }
      else if (cur) cur.body.push(l);
    }
    const items = secs.filter((x) => /^R\d+/i.test(x.title));
    // 两种写法都接受：①每个 `## R…` 段内写 verdict；②表格行 `| R1 | … | pass |`
    const tableRows = [...lines.join("\n").matchAll(/^\|\s*(R\d+)\s*\|[^\n]*$/gim)].map((m) => m[0]);
    const rowVerdict = (row) => {
      const cs = cells(row);
      const last = (cs[cs.length - 1] || "").match(/\b(pass|partial|fail)\b/i);
      return last ? last[1].toLowerCase() : ((row.match(/\b(pass|partial|fail)\b/i) || [])[1] || "").toLowerCase();
    };
    if (!items.length && !tableRows.length) err(p, 0, "缺逐条读数（每条形如「## R1 …」段内写 verdict，或表格行「| R1 | … | pass |」）");
    for (const it of items) if (!V.test(it.body.join("\n"))) err(p, 0, `读数段「${it.title}」内缺 verdict（pass/partial/fail）`);
    for (const row of tableRows) if (!V.test(row)) err(p, 0, `读数表格行缺 verdict：${row.slice(0, 40)}`);
    // overall 必须由逐条推出来：任一条 fail ⇒ overall=fail；否则任一条 partial ⇒ overall=partial
    if (v) {
      const per = [...items.map((it) => {
        const m = it.body.join("\n").match(/verdict[:：]\s*\W*(pass|partial|fail)\b/i) || it.body.join("\n").match(/\b(pass|partial|fail)\b/i);
        return m ? m[1].toLowerCase() : "";
      }), ...tableRows.map(rowVerdict)].filter(Boolean);
      if (per.includes("fail") && v.toLowerCase() !== "fail") err(p, idx + 1, `overall=${v} 与逐条不一致：有读数判 fail ⇒ overall 必须是 fail`);
      else if (!per.includes("fail") && per.includes("partial") && v.toLowerCase() === "pass") err(p, idx + 1, `overall=pass 与逐条不一致：有读数判 partial ⇒ overall 必须是 partial`);
    }
  }
}

const PRESET_FILES = ["waterfall.md", "prototype.md", "incremental.md", "agent-driven.md"];
const KNOWN_KINDS = new Set(["requirement", "design", "implement", "review", "deliver", "verify", "vet", "docs"]);
// 发布快照：与 skill 一起冻结（改它要一次人签，不允许悄悄放宽/换名）
const SNAPSHOT_STAGES = {
  waterfall: "req[requirement] design[design] build[implement] verify[review] deliver[deliver]",
  prototype: "explore[implement] harden[requirement,design,implement,review] deliver[deliver]",
  incremental: "req_design[requirement,design] build[implement] verify[review] integrate[deliver]",
  "agent-driven": "frame[requirement,design] build[implement] verify[verify] review[review] sign[vet] deliver[deliver]",
};
const SNAPSHOT_CRITERIA = {
  G_req_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed provenance.present assumption_set.signed",
  G_design_exit: "stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound spec_set.signed provenance.present assumption_set.signed",
  G_build_exit: "task.complete assumption.disposed mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_verify_exit: "review.round_bound review.required spec_set.signed provenance.present assumption_set.signed",
  G_deliver_exit: "design.code_matches node.integration_listed mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_explore_exit: "task.complete spec_set.signed provenance.present assumption_set.signed",
  G_harden_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound task.complete assumption.disposed mandate.revalidated review.round_bound review.required provenance.present",
  G_req_design: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed provenance.present stage.design_traceable design.covers_spec design.no_spec_creep design.alternatives_declared node.acceptance_bound",
  G_integrate: "node.integration_listed design.code_matches mandate.revalidated spec_set.signed provenance.present assumption_set.signed",
  G_frame_exit: "stage.requirement_complete intent.restated_consistent alignment.examples_present spec_set.signed scope.present intent.explicit_for_risk redteam.disposed assumption_set.signed provenance.present stage.design_traceable design.covers_spec design.no_spec_creep node.acceptance_bound agent.plan_reviewed agent.write_scope_disjoint agent.cards_have_negative_cases",
  G_agent_build_exit: "task.complete assumption.disposed mandate.revalidated spec_set.signed provenance.present assumption_set.signed agent.evidence_runnable agent.no_self_sign",
  G_agent_verify_exit: "agent.checker_green agent.mutation_red agent.unverified_listed spec_set.signed provenance.present",
  G_agent_review_exit: "review.round_bound review.required agent.reviewer_not_author agent.findings_disposed spec_set.signed provenance.present",
  G_agent_sign_exit: "agent.human_signed agent.known_limits spec_set.signed assumption_set.signed provenance.present",
  G_agent_deliver_exit: "design.code_matches node.integration_listed mandate.revalidated agent.readings_frozen spec_set.signed provenance.present",
};

function checkPresets() {
  const i = ARGV.indexOf("--presets");
  const ext = ARGV[i + 1] && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : null;
  let doc = null;
  if (ext) {
    if (!fs.existsSync(path.resolve(ROOT, ext))) return err("presets", 0, `判据源不存在：${ext}`);
    doc = fs.readFileSync(path.resolve(ROOT, ext), "utf8");
  }
  const docStages = {}, docGates = {};
  if (doc) {
    for (const m of doc.matchAll(/^\|\s*`(waterfall|prototype|incremental)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)) {
      docStages[m[1]] = [...m[2].matchAll(/([a-z_]+)\[([^\]]*)\]/g)].map((s) => `${s[1]}[${s[2].split(",").map((x) => x.trim()).filter(Boolean).join(",")}]`).join(" ");
    }
    for (const m of doc.matchAll(/(G_[a-z_]+):\s*\{([\s\S]*?)\}/g)) {
      const cm = m[2].match(/criteria:\s*\[([\s\S]*?)\]/);
      if (cm) docGates[m[1]] = [...cm[1].matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]).join(" ");
    }
  }

  if (doc && !Object.keys(docGates).length && !Object.keys(docStages).length) {
    return err("presets", 0, `判据源格式不支持：${ext} 里找不到「G_x: { criteria: [...] }」或「| waterfall | … |」形态的片段（设计稿需先摘出 §1.1）`);
  }
  for (const f of PRESET_FILES) {
    const key = f.replace(".md", "");
    const p = `presets/${f}`;
    const text = fs.readFileSync(path.join(SELF, "presets", f), "utf8");

    const gotStages = {};
    for (const m of text.matchAll(/^###\s*`([a-z_]+)\[([^\]]*)\]`/gm)) {
      const sid = m[1], kinds = m[2].split(",").map((x) => x.trim()).filter(Boolean);
      if (gotStages[sid]) err(p, 0, `stage id 重复：${sid}`);
      gotStages[sid] = kinds;
      for (const k of kinds) if (!KNOWN_KINDS.has(k)) err(p, 0, `stage ${sid} 用了未知 kind：${k}`);
      if (!kinds.length) err(p, 0, `stage ${sid} 没有 kinds`);
    }
    if (!Object.keys(gotStages).length) err(p, 0, "没有任何 ### `sid[kinds]` 形式的 stage");

    const gotSeq = Object.entries(gotStages).map(([id, ks]) => `${id}[${ks.join(",")}]`).join(" ");
    const wantSeq = SNAPSHOT_STAGES[key];
    if (gotSeq !== wantSeq) err(p, 0, `stage 序列与发布快照不一致（多/少/改名/换 kinds 都要人签）：\n  本文件 ${gotSeq || "（空）"}\n  快照   ${wantSeq}`);

    const gates = [...text.matchAll(/id:\s*(G_[a-z_]+)([^}]*)criteria:\s*\[([^\]]*)\]/g)];
    if (!gates.length) err(p, 0, "没有任何 gate（id/criteria）");
    const gateIds = gates.map(([, gid]) => gid).sort();
    const wantGates = Object.keys(SNAPSHOT_CRITERIA).filter((g) => getPresetGates(key).includes(g)).sort();
    if (gateIds.join() !== wantGates.join()) err(p, 0, `gate 集合与发布快照不一致：本文件 [${gateIds.join(", ") || "空"}]，快照应为 [${wantGates.join(", ")}]`);

    for (const [, gid, , body] of gates) {
      const got = [...body.matchAll(/[a-z_]+\.[a-z_]+/g)].map((x) => x[0]).join(" ");
      const want = SNAPSHOT_CRITERIA[gid];
      if (want === undefined) err(p, 0, `gate ${gid} 不在发布快照里（新 gate 要随 skill 版本一起人签）`);
      else if (got !== want) err(p, 0, `${gid} 的 criteria 与发布快照不一致：\n  本文件 ${got || "（空）"}\n  快照   ${want}`);
      if (!got.split(" ").includes("spec_set.signed")) err(p, 0, `${gid} 的 criteria 缺 core 判据 spec_set.signed`);
      // 外部判据源：只比对本文件出现的 gate
      if (docGates[gid] && docGates[gid] !== got) err(p, 0, `${gid} 的 criteria 与外部判据源不一致（本文件 ${got.split(" ").filter(Boolean).length} 条，源 ${docGates[gid].split(" ").filter(Boolean).length} 条）`);
    }

    if (doc) {
      const want = docStages[key];
      if (!want) {
        // 本 preset 是 skill 自己的扩展（设计稿里没有），只查发布快照，不比外部源
        console.log(`（${key} 不在判据源里：本 preset 属 skill 扩展，跳过外部比对）`);
      } else {
        if (want !== gotSeq) err(p, 0, `stage 序列与外部判据源不一致：\n  本文件 ${gotSeq}\n  源     ${want}`);
        for (const [, gid] of gates) if (!docGates[gid]) err(p, 0, `多出判据源里没有的 gate：${gid}`);
      }
    }
  }
  if (!ext) console.log("（preset 校验：发布快照（stage 序列 + gate 集合 + criteria 逐条）；与设计稿比对请传 --presets <文件>）");
}
// 每份 preset 应含哪些 gate（与 skill 文档一致；改这里等于改发布快照）
function getPresetGates(key) {
  return {
    waterfall: ["G_req_exit", "G_design_exit", "G_build_exit", "G_verify_exit", "G_deliver_exit"],
    prototype: ["G_explore_exit", "G_harden_exit", "G_deliver_exit"],
    incremental: ["G_req_design", "G_build_exit", "G_verify_exit", "G_integrate"],
    "agent-driven": ["G_frame_exit", "G_agent_build_exit", "G_agent_verify_exit", "G_agent_review_exit", "G_agent_sign_exit", "G_agent_deliver_exit"],
  }[key] || [];
}

// SKILL.md 的 YAML frontmatter：一个 ": " 就能让严格 YAML 解析失败，整个 skill 会被静默忽略
function checkFrontmatter() {
  const dirs = [SELF, ...skillDirs().map((d) => path.join(ROOT, d))];
  for (const dir of [...new Set(dirs)]) {
    const abs = path.join(dir, "SKILL.md");
    const p = path.relative(ROOT, abs).split(path.sep).join("/") || "SKILL.md";
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    if (lines[0].trim() !== "---") { err(p, 1, "缺少 YAML frontmatter（首行应为 ---）"); continue; }
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end < 0) { err(p, 1, "frontmatter 没有结束的 ---"); continue; }
    for (let i = 1; i < end; i++) {
      const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim();
      if (!v || /^[>|]/.test(v) || /^["'].*["']$/.test(v)) continue;
      if (/:\s/.test(v)) err(p, i + 1, `frontmatter 的 ${m[1]} 值里有「: 」，严格 YAML 会解析成嵌套映射 ⇒ 整个 skill 被忽略；改用 >- 块或加引号`);
      if (/\s#/.test(v)) warn(p, i + 1, `frontmatter 的 ${m[1]} 值里有「 #」，可能是注释起点；建议用 >- 块`);
    }
  }
}
const files = mdFiles();
for (const p of files) checkTables(p, read(p));
checkFrontmatter();
checkLedger(".sdo/台账.md"); checkSigns(); checkCards(); checkReadings();
if (ARGV.includes("--presets")) checkPresets();
for (const w of WARN) console.log(`WARN  ${w}`);
for (const e of ERR) console.log(`ERROR ${e}`);
console.log(`\n检查完成：${files.length} 个 Markdown，${ERR.length} 个错误，${WARN.length} 个警告`);
process.exit(ERR.length ? 1 : 0);
