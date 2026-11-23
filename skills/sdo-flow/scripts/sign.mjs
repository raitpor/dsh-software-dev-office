#!/usr/bin/env node
// sign.mjs — 签字材料 draft（M4-2）。只出事实、只写 stdout、不写任何文件。
//
// 用法：node <skill>/scripts/sign.mjs draft --milestone M4
//
// 退出码：0 正常（含读数缺失、无 git）；1 工作树脏或被签文件与 HEAD 不一致；2 用法/环境错。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseVerdict, isUnsignedVerdict } from "./lib/verdict.mjs";
import { spawnSync } from "node:child_process";
import { signedCardIds } from "./lib/signed-cards.mjs";
import { frozenHashRaw } from "./lib/frozen.mjs";

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

// C3：项目根必须是 git 仓库根本身；不向上借外层仓库的 HEAD/工作树。
function projectGitRoot(root) {
  const top = gitText(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return false;
  try {
    return fs.realpathSync(root) === fs.realpathSync(top);
  } catch {
    return false;
  }
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

const BATCH_MAX = 3;
const BATCH_BLACKLIST = new Set(["无", "没有", "不适用", "不需要", "无所谓", "待补充", "略", "同上", "见上"]);
const MILESTONE_DIR = ".sdo/milestones";

function milestoneCards(root, milestone) {
  const file = path.join(root, MILESTONE_DIR, `${milestone}.md`);
  if (!fs.existsSync(file)) die(`找不到 ${MILESTONE_DIR}/${milestone}.md`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let header = null, at = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const h = cells(lines[i]);
    if (h.some((x) => x.includes("卡"))) { header = h; at = i; break; }
  }
  if (!header) die(`${MILESTONE_DIR}/${milestone}.md 缺卡表`);
  const col = header.findIndex((h) => h.includes("卡"));
  const ids = [];
  for (let i = at + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
    const id = (cells(lines[i])[col] || "").replace(/`/g, "").trim();
    if (/^M\d+-(?:\d+|G)$/.test(id)) ids.push(id);
  }
  return ids;
}
function cardStatus(root, id) {
  const file = path.join(root, ".sdo/cards", `${id}.md`);
  if (!fs.existsSync(file)) return null;
  const m = /^status:\s*(\S+)/m.exec(fs.readFileSync(file, "utf8"));
  return m ? m[1] : null;
}
function cells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out = []; let cur = "", code = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "`") { code = !code; cur += ch; continue; }
    if (ch === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
function meaningfulLen(s) {
  return String(s).replace(/[，。！？、；：,.!?;:\s"'“”‘’（）()《》<>【】\[\]-]/g, "").length;
}
function extractVerdict(root, cardId) {
  const file = path.join(root, ".sdo/cards", `${cardId}.md`);
  if (!fs.existsSync(file)) return "待人工复核（卡面评审段无判词）";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const a = lines.findIndex((l) => /^##\s*评审(?:\s|$)/.test(l.trim()));
  if (a < 0) return "待人工复核（卡面评审段无判词）";
  let b = lines.findIndex((l, i) => i > a && /^##\s/.test(l.trim()));
  if (b < 0) b = lines.length;
  let verdict = null;
  for (const line of lines.slice(a + 1, b)) {
    const m = /^-\s*判定[:：]\s*\*{0,2}(可收卡|可提交|改完再审|拒绝)\*{0,2}\s*(?:（[^）]*）|\([^)]*\))?\s*$/.exec(line);
    if (m) verdict = m[1];
  }
  return verdict ?? "待人工复核（卡面评审段无判词）";
}
function buildDraft(index, cardId, commit, verdict) {
  const target = commit ? `commit ${commit}` : "无 git（无法锚定 commit）";
  const boundary = "本次仅为签字草案；证据与读数由人复核，草案不落盘。";
  return [
    `### 草案 ${index} · ${cardId}`,
    `- 范围：${cardId}`,
    `- 被签对象：${target}`,
    `- 判定：${verdict}`,
    `- 已知边界：${boundary}`,
  ].join("\n");
}
function validateDraft(text, index, cardId) {
  const bad = (msg) => die(`第 ${index} 份草案不合法：${msg}`);
  const lines = text.split(/\r?\n/);
  if (lines.length > 8) bad(`行数 ${lines.length} > 8`);
  const fields = {
    范围: lines.find((l) => l.startsWith("- 范围：")),
    被签对象: lines.find((l) => l.startsWith("- 被签对象：")),
    判定: lines.find((l) => l.startsWith("- 判定：")),
    已知边界: lines.find((l) => l.startsWith("- 已知边界：")),
  };
  for (const [k, v] of Object.entries(fields)) if (!v) bad(`缺「${k}」`);
  if (!fields.范围.includes(cardId)) bad("范围未含卡号");
  const target = fields.被签对象.slice("- 被签对象：".length).trim();
  if (!/无 git/.test(target) && !/[0-9a-f]{7,40}/i.test(target)) bad("被签对象缺 commit（7–40 位）");
  const verdict = fields.判定.slice("- 判定：".length).trim();
  if (!verdict) bad("判定为空");
  if (/^待填写/.test(verdict)) bad(`判定不能是「待填写」：${verdict}`);
  const boundary = fields.已知边界.slice("- 已知边界：".length).trim();
  if (meaningfulLen(boundary) < 8 || BATCH_BLACKLIST.has(boundary)) bad(`已知边界过短或为套话：${boundary}`);
}
function batch(root, milestone, cardsArg) {
  const ids = milestoneCards(root, milestone);
  let selected;
  if (cardsArg !== null) {
    selected = cardsArg.split(",").map((x) => x.trim()).filter(Boolean);
    if (selected.length > BATCH_MAX) die(`一次最多 ${BATCH_MAX} 张卡；收到 ${selected.length} 张，请拆批`);
    for (const id of selected) {
      if (!/^M\d+-(?:\d+|G)$/.test(id)) die(`--cards 含非法卡号：${id}`);
      if (cardStatus(root, id) === null) die(`--cards 含不存在的卡：${id}`);
      if (!ids.includes(id)) die(`--cards 含不属于里程碑 ${milestone} 的卡：${id}`);
    }
  } else {
    const signed = signedCardIds(path.join(root, ".sdo/sign"));
    selected = ids.filter((id) => cardStatus(root, id) === "done" && !signed.has(id)).slice(0, BATCH_MAX);
  }
  if (selected.length === 0) {
    console.log(`本批无可签卡（done 且未签收，里程碑 ${milestone}）`);
    return;
  }
  const hasGit = projectGitRoot(root);
  const head = hasGit ? gitText(root, ["rev-parse", "HEAD"]) : null;
  const commit = head && /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
  const drafts = selected.map((id, i) => {
    const text = buildDraft(i + 1, id, commit, extractVerdict(root, id));
    validateDraft(text, i + 1, id);
    return text;
  });
  console.log(drafts.join("\n\n"));
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) die("用法：sign.mjs draft --milestone M4 | sign.mjs batch M6 [--cards M6-0,M6-1]");
  if (cmd === "draft") {
    let milestone = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--milestone" && i + 1 < rest.length) milestone = rest[++i];
      else if (rest[i].startsWith("--")) die(`未知参数：${rest[i]}`);
      else die(`多余参数：${rest[i]}`);
    }
    if (!/^M\d+$/.test(milestone)) die("缺少或非法 --milestone（应为 M4）");
    return { cmd, milestone, cards: null };
  }
  if (cmd === "new") {
    const flags = {};
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--force") flags.force = true;
      else if (["--kind", "--milestone", "--scope"].includes(a) && i + 1 < rest.length) flags[a.slice(2)] = rest[++i];
      else die(`未知参数：${a}`);
    }
    const milestone = flags.milestone || "";
    if (!/^M\d+$/.test(milestone)) die("缺少或非法 --milestone（应为 M11）");
    if (!flags.scope) die("缺少 --scope（这份签覆盖到哪）");
    return { cmd, milestone, kind: flags.kind || "计划", scope: flags.scope, force: flags.force === true };
  }
  if (cmd === "batch") {
    const milestone = rest[0];
    if (!milestone || !/^M\d+$/.test(milestone)) die("用法：sign.mjs batch <M> [--cards M6-0,M6-1]");
    let cards = null;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--cards" && i + 1 < rest.length) cards = rest[++i];
      else die(`未知参数：${rest[i]}`);
    }
    return { cmd, milestone, cards };
  }
  die(`未知命令：${cmd}（只允许 draft/batch/new）`);
}

function signNumber(root) {
  const dir = path.join(root, ".sdo/sign");
  let max = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const m = /^S(\d+)(?:-[A-Z])?\.md$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function signNew(root, milestone, kind, scope, force = false) {
  const signDir = path.join(root, ".sdo/sign");
  const absMilestone = path.join(root, `.sdo/milestones/${milestone}.md`);
  if (!fs.existsSync(absMilestone)) die(`找不到 .sdo/milestones/${milestone}.md`);
  // 同一里程碑+同一 kind 已有签文件则跳过（幂等）
  let existing = null;
  if (fs.existsSync(signDir)) for (const f of fs.readdirSync(signDir)) {
    if (!/^S\d+(?:-[A-Z])?\.md$/.test(f)) continue;
    const p = path.join(signDir, f);
    const text = fs.readFileSync(p, "utf8");
    const title = text.split(/\r?\n/)[0];
    const titleOk = new RegExp(`(?:^|\\s|·)\\s*${milestone}\\s+${kind}(?:\\s|$)`).test(title);
    if (text.includes("generated-by: sign.mjs new") && text.includes(`- 范围：${scope}`) && titleOk) {
      existing = { p, text, f };
      break;
    }
  }
  if (existing && !force) {
    console.log(`已存在同范围生成的${kind}签，跳过：.sdo/sign/${existing.f}`);
    process.exit(0);
  }
  if (existing && force) {
    const verdict = parseVerdict(existing.text.split(/\r?\n/));
    if (verdict && !isUnsignedVerdict(verdict)) {
      console.error(`sign_already_signed：.sdo/sign/${existing.f} 已有判定「${verdict}」，拒绝覆盖`);
      process.exit(2);
    }
    console.log(`将覆盖：.sdo/sign/${existing.f}（未人签草案）`);
  }
  const check = path.join(path.dirname(fileURLToPath(import.meta.url)), "check.mjs");
  const hr = spawnSync(process.execPath, [check, "--plan", "--milestone", milestone, "--print-frozen-hash"], { cwd: root, encoding: "utf8" });
  if (hr.status !== 0) die(`无法取得冻结段 hash（check --print-frozen-hash exit ${hr.status}）：${(hr.stderr || hr.stdout || "").trim()}`);
  const hash = (hr.stdout || "").trim().split(/\r?\n/)[0];
  if (!/^[0-9a-f]{64}$/.test(hash)) die(`--print-frozen-hash 输出不是 64 位 hex：${hash}`);
  const head = projectGitRoot(root) ? gitText(root, ["rev-parse", "HEAD"]) : null;
  if (!head) die("项目根不是独立 git 仓库或没有 HEAD（项目根必须等于 git 根，不借用外层仓库）：sign new 需要被签对象 commit（下一步：git init && git add -A && git commit -m init）");
  const n = signNumber(root);
  const title = kind === "计划" ? `# S${n} · ${milestone} 计划` : `# S${n} · ${milestone} ${kind}`;
  const text = [title, "", `- 时间：${new Date().toISOString()}`, `- 被签对象：commit \`${head}\``, `- 冻结段 hash：${hash}`, "- 判定：待填", "- 已知边界：待填", "- 签署者：待填", `- 范围：${scope}`, "- 选项：签：复述准确｜改：复述不准（请指出）｜不签：先不做", "- 方式：本人", "- 检查方式：本人", "", "<!-- generated-by: sign.mjs new -->", ""].join("\n");
  fs.mkdirSync(signDir, { recursive: true });
  const rel = existing ? `.sdo/sign/${existing.f}` : `.sdo/sign/S${n}.md`;
  if (!existing) console.log(`将写：${rel}`);
  fs.writeFileSync(path.join(root, rel), text);
  console.log(`下一步：人填判定/边界/签署者后，node <skill>/scripts/check.mjs --plan --milestone ${milestone}`);
  process.exit(0);
}

function draft(root, milestone) {
  const planPath = path.join(root, `.sdo/milestones/${milestone}.md`);
  if (!fs.existsSync(planPath)) die(`找不到 .sdo/milestones/${milestone}.md`);
  const section = { text: fs.readFileSync(planPath, "utf8"), start: 0 };

  const hasGit = projectGitRoot(root);
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
  emitSelf(`冻结段 hash：${frozenHashRaw(section.text)}`);
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

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(`用法：
  node <skill>/scripts/sign.mjs draft --milestone <M>
  node <skill>/scripts/sign.mjs batch <M> [--cards <卡号,卡号>]
  node <skill>/scripts/sign.mjs new --kind 计划 --milestone <M> --scope <文本>
示例：node <skill>/scripts/sign.mjs draft --milestone M10`);
  process.exit(0);
}
const parsed = parseArgs(process.argv.slice(2));
const root = findRoot(process.cwd());
if (!root) die("找不到 .sdo/：请在本项目内运行");
if (parsed.cmd === "draft") draft(root, parsed.milestone);
else if (parsed.cmd === "batch") batch(root, parsed.milestone, parsed.cards);
else signNew(root, parsed.milestone, parsed.kind, parsed.scope, parsed.force);
