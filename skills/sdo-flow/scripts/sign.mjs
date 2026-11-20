#!/usr/bin/env node
// sign.mjs — 签字材料 draft（M4-2）。只出事实、只写 stdout、不写任何文件。
//
// 用法：node <skill>/scripts/sign.mjs draft --milestone M4
//
// 退出码：0 正常（含读数缺失、无 git）；1 工作树脏或被签文件与 HEAD 不一致；2 用法/环境错。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const SIGN_FORBIDDEN = /建议签|可以签|可签|推荐签|我认为|判定[:：]|选项[:：]签|签署者[:：]|✅|⚠️/;

function die(message) {
  console.error(message);
  process.exit(2);
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".sdo"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function git(root, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: opts.buffer ? undefined : "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function gitText(root, args) {
  const out = git(root, args);
  return typeof out === "string" ? out.trim() : null;
}

function readPlanSection(plan, milestone) {
  const lines = plan.split(/\r?\n/);
  const re = new RegExp(`^##\\s+${milestone}(?:\\s|·|$)`);
  const start = lines.findIndex((l) => re.test(l.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { end = i; break; }
  }
  return { start, end, lines, text: lines.slice(start, end).join("\n") };
}

function readOverall(root, milestone) {
  const file = path.join(root, ".sdo/readings", `${milestone}.md`);
  if (!fs.existsSync(file)) return { missing: true, quotes: [], invalid: false };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heading = /^\s*##\s*overall[：:]?\s*(.*)$/.exec(lines[i]);
    if (heading) {
      const inline = heading[1].trim();
      if (inline !== "") {
        return { missing: false, quotes: [{ text: lines[i].trim(), lineNo: i + 1 }], invalid: false };
      }
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && !/^\s*#/.test(lines[j]) && !/^\s*[-*]?\s*overall[：:]/.test(lines[j])) {
        return {
          missing: false,
          quotes: [
            { text: lines[i].trim(), lineNo: i + 1 },
            { text: lines[j].trim(), lineNo: j + 1 },
          ],
          invalid: false,
        };
      }
      return { missing: false, quotes: [{ text: lines[i].trim(), lineNo: i + 1 }], invalid: true };
    }
    const bullet = /^\s*[-*]?\s*overall[：:]\s*(.*)$/.exec(lines[i]);
    if (bullet) {
      if (bullet[1].trim() === "") {
        return { missing: false, quotes: [{ text: lines[i].trim(), lineNo: i + 1 }], invalid: true };
      }
      return { missing: false, quotes: [{ text: lines[i].trim(), lineNo: i + 1 }], invalid: false };
    }
  }
  return { missing: false, quotes: [], invalid: false };
}

function lastLedgerRow(root) {
  const file = path.join(root, ".sdo/台账.md");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\|\s*D-\d+\s*\|/.test(lines[i])) return { line: lines[i].trim(), lineNo: i + 1 };
  }
  return null;
}

function milestoneAnchor(sectionText) {
  const m = /被签对象[：:][^\n]*?`([0-9a-fA-F]{7,40})`/.exec(sectionText);
  return m ? m[1] : null;
}

function collectSignedFiles(root, milestone, sectionText) {
  const files = new Set();
  const normalize = (raw) => raw.trim().replace(/^`|`$/g, "").replace(/^<skill>\//, "skills/sdo-flow/");
  const addFromText = (raw) => {
    const p = normalize(raw);
    if (!p.includes("/") || !/\.(mjs|md|json|ts)$/.test(p)) return;
    if (p.includes("*") || p.includes(" ") || p.includes("..")) return;
    if (!fs.existsSync(path.join(root, p))) return;
    files.add(p);
  };
  const addFromScope = (raw) => {
    const p = normalize(raw);
    if (!/\.(mjs|md|json|ts)$/.test(p)) return;
    if (p.includes("*") || p.includes(" ") || p.includes("..")) return;
    files.add(p);
  };
  for (const m of sectionText.matchAll(/`([^`\n]+)`/g)) addFromText(m[1]);
  const cardDir = path.join(root, ".sdo/cards");
  if (fs.existsSync(cardDir)) {
    for (const name of fs.readdirSync(cardDir).filter((f) => f.endsWith(".md") && f.startsWith(`${milestone}-`))) {
      const text = fs.readFileSync(path.join(cardDir, name), "utf8");
      const fm = /^write_scope:\s*\[(.*?)\]\s*$/m.exec(text);
      if (!fm) continue;
      for (const item of fm[1].split(",")) addFromScope(item.trim());
    }
  }
  if (fs.existsSync(path.join(root, ".sdo/计划.md"))) files.add(".sdo/计划.md");
  if (fs.existsSync(path.join(root, `.sdo/milestones/${milestone}.md`))) files.add(`.sdo/milestones/${milestone}.md`);
  return [...files].filter((p) => !p.endsWith("/")).sort();
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) die("用法：sign.mjs draft --milestone M4");
  if (cmd !== "draft") die(`未知命令：${cmd}（只允许 draft）`);
  let milestone = "";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--milestone" && i + 1 < rest.length) milestone = rest[++i];
    else if (rest[i].startsWith("--")) die(`未知参数：${rest[i]}`);
    else die(`多余参数：${rest[i]}`);
  }
  if (!/^M\d+$/.test(milestone)) die("缺少或非法 --milestone（应为 M4）");
  return milestone;
}

function draft(root, milestone) {
  const planPath = path.join(root, `.sdo/milestones/${milestone}.md`);
  if (!fs.existsSync(planPath)) die(`找不到 .sdo/milestones/${milestone}.md`);
  const section = { text: fs.readFileSync(planPath, "utf8"), start: 0 };

  const hasGit = gitText(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const head = hasGit ? gitText(root, ["rev-parse", "HEAD"]) : null;
  if (hasGit && !head) die("git 仓库没有 HEAD（先提交，或补 .git）");
  const porcelain = hasGit ? (gitText(root, ["status", "--porcelain"]) ?? "") : "";
  const dirty = porcelain.split(/\r?\n/).filter(Boolean).length > 0;
  const anchorRaw = milestoneAnchor(section.text);
  let anchor = null;
  if (hasGit && anchorRaw) {
    const resolved = gitText(root, ["rev-parse", "--verify", `${anchorRaw}^{commit}`]);
    if (resolved) anchor = resolved;
  }
  let relation = "NO_ANCHOR";
  if (hasGit && anchor && head) {
    const ahead = Number(gitText(root, ["rev-list", "--count", `${anchor}..${head}`]) ?? "0");
    const behind = Number(gitText(root, ["rev-list", "--count", `${head}..${anchor}`]) ?? "0");
    relation = ahead === 0 && behind === 0 ? "SAME" : ahead > 0 ? `AHEAD ${ahead}` : `BEHIND ${behind}`;
  }

  const signed = collectSignedFiles(root, milestone, section.text);
  const fileFacts = signed.map((p) => {
    const abs = path.join(root, p);
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    const current = exists ? sha256(fs.readFileSync(abs)) : null;
    let headHash = null;
    if (hasGit) {
      const blob = git(root, ["show", `HEAD:${p}`], { buffer: true });
      if (blob) headHash = sha256(blob);
    }
    const mismatch = hasGit ? (exists && headHash !== null ? current !== headHash : true) : false;
    return { path: p, exists, current, headHash, mismatch };
  });
  const mismatched = fileFacts.filter((f) => f.mismatch).map((f) => f.path);

  const out = [];
  const selfLines = [];
  const emitSelf = (line) => { out.push(line); selfLines.push(line); };
  emitSelf(dirty || mismatched.length ? "DIRTY" : "CLEAN");
  emitSelf(`里程碑：${milestone}（.sdo/milestones/${milestone}.md）`);
  const reading = readOverall(root, milestone);
  const readingPath = `.sdo/readings/${milestone}.md`;
  if (reading.missing) {
    const everTracked = hasGit && (gitText(root, ["log", "--all", "--format=%H", "--", readingPath]) ?? "") !== "";
    if (!everTracked) emitSelf(`读数：缺（${milestone} 未跑）`);
    else emitSelf(`读数：缺（该文件曾入库，按删除/脏树处理）`);
  } else if (reading.invalid) {
    for (const q of reading.quotes) out.push(`读数（原文）：${q.text} @ ${readingPath}:${q.lineNo}`);
    emitSelf(`读数：overall 无取值 @ ${readingPath}:${reading.quotes[0]?.lineNo ?? 1}`);
  } else if (reading.quotes.length > 0) {
    for (const q of reading.quotes) out.push(`读数（原文）：${q.text} @ ${readingPath}:${q.lineNo}`);
  } else {
    emitSelf(`读数：存在但无 overall 行 @ ${readingPath}`);
  }
  const ledger = lastLedgerRow(root);
  if (ledger) out.push(`台账（原文）：${ledger.line} @ .sdo/台账.md:${ledger.lineNo}`);
  else emitSelf("台账：无");
  if (!hasGit) {
    out.push("NO_GIT");
    out.push("版本：无法核对版本（当前目录不是 git 工作树）");
  } else {
    out.push(`HEAD：${head}`);
    out.push(`锚点：${anchorRaw ?? "无"}`);
    out.push(`锚点对照：${relation}`);
    out.push(`工作树：${dirty ? "DIRTY" : "干净"}`);
    if (dirty) out.push(...porcelain.split(/\r?\n/).filter(Boolean).map((l) => `  ${l}`));
    const base = anchor ?? head;
    const stat = gitText(root, ["diff", "--stat", `${base}..HEAD`]) || "";
    const commits = gitText(root, ["log", "--oneline", `${base}..HEAD`]) || "";
    out.push(`改动范围（${anchor ? `${anchor}..HEAD` : "HEAD"}）：`);
    out.push(stat || "无");
    if (commits) out.push("提交范围：", ...commits.split(/\r?\n/).map((l) => `  ${l}`));
    else out.push("提交范围：无");
  }
  out.push("被签文件 sha256：");
  for (const f of fileFacts) {
    const cur = f.exists ? f.current : "缺失";
    const headPart = hasGit ? (f.headHash ?? "HEAD 缺失") : "无 git";
    out.push(`- ${f.path}  sha256=${cur}  HEAD=${headPart}`);
  }
  if (mismatched.length) {
    out.push("TREE_MISMATCH");
    out.push(...mismatched.map((p) => `  ${p}`));
  }
  const text = out.join("\n");
  const badSelf = selfLines.find((line) => SIGN_FORBIDDEN.test(line));
  if (badSelf !== undefined) die("内部错误：脚本自产句子包含判定词（不应发生）");
  console.log(text);
  process.exit(dirty || mismatched.length || reading.invalid ? 1 : 0);
}

const milestone = parseArgs(process.argv.slice(2));
const root = findRoot(process.cwd());
if (!root) die("找不到 .sdo/：请在本项目内运行");
draft(root, milestone);
