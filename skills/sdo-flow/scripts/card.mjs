#!/usr/bin/env node
// card.mjs — 卡骨架与证据行（M4-1）。零依赖 Node ESM；只改 .sdo/cards/。
//
// 用法：
//   node <skill>/scripts/card.mjs new <M>-<n> --owner <席位> --intent <意图> --criteria "C1:结构:文字;C2:语义:文字" [--write-scope "a,b"] [--depends "M11-0、M11-1"] [--scope "a,b"]
//     --criteria 多项用分号（; 或 ；）分隔；每项是 编号:类型:文字，类型只 结构/语义/边界；禁止半角逗号。
//   node <skill>/scripts/card.mjs evidence <卡号|卡文件> --criterion C1 --cmd "<命令>" [--run [命令]]
//   node <skill>/scripts/card.mjs mutation --card <卡号> --criterion C1 --mutate "<改坏命令>" --expect "<应红命令>"
//
// 纪律：同判据只允许一行；重复 evidence 原地更新；不传 --run 摘要写「未跑待复跑」；
// 结果只能来自真跑（--run），脚本不接受手填 pass；所有失败 exit 2 且零写入。
// mutation 只在临时副本里跑：改坏 → 应红 → 恢复 → 应绿；工作树与 .sdo 卡/签字不碰。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CARDS = ".sdo/cards";
const EVIDENCE_HEADER = ["判据", "命令与输出", "判定"];
const HEADER_ALIAS = {
  判据: "criterion",
  命令: "command",
  输出摘要: "summary",
  改回去会怎样: "revert",
  命令与输出: "merged",
  判定: "verdict",
};
const TIMEOUT_MS = 30000;
const SUMMARY_LIMIT = 200;

function die(message) {
  console.error(message);
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(1);
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

function writeAtomic(file, text) {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) die("用法：card.mjs new|evidence|mutation [参数]（详见文件头）");
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "run") {
        // --run 之后原样交给子进程（支持 `--` 终止符）；子进程参数不再由本脚本解析。
        let tail = rest.slice(i + 1);
        if (tail[0] === "--") tail = tail.slice(1);
        flags.run = tail.length === 0 ? true
          : tail.length === 1 ? tail[0]
            : tail.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
        i = rest.length;
        break;
      }
      if (i + 1 >= rest.length) die(`参数 --${key} 缺值`);
      if (key in flags) die(`参数 --${key} 重复`);
      flags[key] = rest[++i];
    } else {
      positional.push(a);
    }
  }
  if ("result" in flags) die("不接受 --result：结果只能来自 --run 的真实退出码");
  return { cmd, flags, positional };
}

function parseCriteria(raw) {
  if (typeof raw !== "string" || raw.trim() === "") die("new 缺必填参数 --criteria（如 \"C1:结构:文字;C2:语义:文字\"）");
  if (raw.includes(",")) die("--criteria 禁止半角逗号（,）；多项请用分号（; 或 ；）分隔");
  const items = raw.split(/[;；]/).map((x) => x.trim()).filter(Boolean);
  if (!items.length) die("--criteria 为空");
  const seen = new Set();
  const list = [];
  for (const item of items) {
    const m = /^(C\d+)\s*[:：]\s*(?:(结构|语义|边界)\s*[:：]\s*)?(.+)$/.exec(item);
    if (!m) die(`判据格式不合法：${item}（应为 C1:结构:文字）`);
    if (seen.has(m[1])) die(`判据重复：${m[1]}`);
    seen.add(m[1]);
    list.push({ id: m[1], type: m[2] || "结构", text: m[3].trim() });
  }
  return list;
}

function cardPath(root, arg) {
  const base = path.resolve(root, CARDS);
  const looksLikePath = arg.endsWith(".md") || arg.includes("/") || arg.includes("\\") || path.isAbsolute(arg);
  const candidate = looksLikePath ? path.resolve(process.cwd(), arg) : path.join(base, `${arg}.md`);
  const rel = path.relative(base, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    die(`卡路径必须位于 ${CARDS}/ 内：${arg}（拒绝外部/绝对/.. 路径）`);
  }
  return candidate;
}

function readCard(file) {
  if (!fs.existsSync(file)) die(`卡不存在：${path.relative(process.cwd(), file)}`);
  return fs.readFileSync(file, "utf8");
}

function criterionIds(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s*判据(?:\s|$)/.test(l.trim()));
  if (at < 0) return [];
  const out = new Set();
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i].trim()); i++) {
    for (const m of lines[i].matchAll(/\bC\d+\b/g)) out.add(m[0]);
  }
  return [...out];
}

function cardStatus(text) {
  return /^status:\s*(\w+)/m.exec(text)?.[1] ?? "";
}

function cmdNew(flags, positional) {
  if (positional.length !== 1) die("用法：card.mjs new <M>-<n> --owner <席位> --intent <意图> --criteria \"C1:…,C2:…\"");
  const id = positional[0];
  if (!/^[A-Za-z][\w-]*-(?:\d+|G)$/.test(id)) die(`卡号不合法：${id}（应为 M-<数字> 或 M<n>-G）`);
  for (const key of ["owner", "intent"]) {
    if (typeof flags[key] !== "string" || flags[key].trim() === "") die(`new 缺必填参数 --${key}`);
  }
  const criteria = parseCriteria(flags.criteria);
  const scopeRaw = typeof flags["write-scope"] === "string" ? flags["write-scope"] : flags.scope;
  const scope = typeof scopeRaw === "string" && scopeRaw.trim() !== ""
    ? `[${scopeRaw.split(",").map((x) => x.trim()).filter(Boolean).join(", ")}]`
    : "[]";
  const depends = typeof flags.depends === "string" ? flags.depends.trim() : "";
  const root = findRoot(process.cwd());
  if (!root) die("找不到 .sdo/：请在本项目内运行");
  const dir = path.join(root, CARDS);
  const file = path.join(dir, `${id}.md`);
  if (fs.existsSync(file)) die(`卡已存在：${path.relative(process.cwd(), file)}（不覆盖）`);
  fs.mkdirSync(dir, { recursive: true });
  const content = `# ${id} · ${flags.intent.trim()}

status: open
owner: ${flags.owner.trim()}
write_scope: ${scope}
- 视角：未声明

## 意图
${flags.intent.trim()}

## 判据

| 编号 | 判据 | 类型 | 反例 |
|---|---|---|---|
${criteria.map((c) => `| ${c.id} | ${c.text} | ${c.type} | 待补反例（用一条命令证明会红） |`).join("\n")}
${depends ? `\n## 准入\n\n依赖：${depends}\n` : ""}
## 证据
| 判据 | 命令与输出 | 判定 |
|---|---|---|

> 证据列只接受脚本生成：card.mjs evidence --run 写 exit=<code> 或「未跑待复跑」；手填 pass/ok/done/已通过/空 会被 check.mjs 拒。判定列由评审填 pass/partial/fail/未判。

## 变异
| 判据 | 变异动作 | 应红命令 | 结果 |
|---|---|---|---|

> 每条判据要么有一行真跑结果（expected=red actual=red），要么「变异动作」写「不可变异：<具体理由>」+「## 评审」写「不可变异确认 <判据>：<理由>」；M5-2 起的 done 卡强制。

## 判定
待证据齐后填 pass / partial / fail。

## 评审
- 评审者：待派（非作者、只读）
`;
  writeAtomic(file, content);
  console.log(`已创建 ${id}（${path.relative(process.cwd(), file)}）`);
}

function locateTable(lines) {
  const sec = lines.findIndex((l) => /^##\s*证据(?:\s|$)/.test(l.trim()));
  if (sec < 0) die("卡缺少「## 证据」段（先补段，不猜列）");
  let end = lines.length;
  for (let i = sec + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) { end = i; break; }
  }
  const table = [];
  for (let i = sec + 1; i < end; i++) if (lines[i].trim().startsWith("|")) table.push(i);
  return { sec, end, table };
}

function isSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

function headerMap(line) {
  const names = cells(line);
  const map = {};
  for (let i = 0; i < names.length; i++) {
    const key = HEADER_ALIAS[names[i]];
    if (key !== undefined) map[key] = i;
  }
  if (!("criterion" in map) || (!("merged" in map) && !("command" in map && "summary" in map))) {
    die(`证据表表头映射失败：${line.trim()}；需要「判据 | 命令与输出 | 判定」或「判据 | 命令 | 输出摘要 | 判定」（不猜列）`);
  }
  return map;
}

function buildRow(map, values) {
  const width = Math.max(...Object.values(map).map((i) => i + 1));
  const out = Array(width).fill("");
  for (const [key, value] of Object.entries(values)) out[map[key]] = cell(value);
  return `| ${out.join(" | ")} |`;
}

function summarize(text) {
  // 只压平换行并按原文截断；Markdown 转义统一交给 cell()（单层转义，避免二次转义）。
  return text.replace(/\r?\n/g, " ").slice(0, SUMMARY_LIMIT);
}

function runCommand(command, root) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    timeout: TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") return { summary: "timeout", code: 1 };
  const code = result.status ?? 1;
  const lastNonEmpty = (s) => {
    if (typeof s !== "string") return "";
    const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "";
  };
  const tail = lastNonEmpty(result.stdout) || lastNonEmpty(result.stderr) || "<no output>";
  const reason = result.error ? ` (${result.error.code ?? result.error.message})` : "";
  return { summary: summarize(`exit=${code}; ${tail}${reason}`), code: code === 0 ? 0 : 1 };
}

function cmdEvidence(flags, positional) {
  // 写域：只写目标卡文件。A3 例外：显式不做 owner 校验（单人/单 agent 场景），但 done 卡仍拒写。
  if (positional.length !== 1) die("用法：card.mjs evidence <卡号|卡文件> --criterion C1 --cmd \"<命令>\" [--run [命令]]");
  const criterion = flags.criterion;
  if (typeof criterion !== "string" || !/^C\d+$/.test(criterion)) die(`--criterion 不合法：${criterion ?? ""}（应为 C1）`);
  const command = typeof flags.cmd === "string" ? flags.cmd.trim() : "";
  if (command === "") die("evidence 缺必填参数 --cmd（--run 不会替代 --cmd）");
  const runCmd = typeof flags.run === "string" ? flags.run : command;
  const root = findRoot(process.cwd());
  if (!root) die("找不到 .sdo/：请在本项目内运行");
  const file = cardPath(root, positional[0]);
  const original = readCard(file);
  if (cardStatus(original) === "done") die(`目标卡已是 done，拒绝事后改证据：${path.relative(process.cwd(), file)}`);
  const ids = criterionIds(original);
  if (!ids.includes(criterion)) die(`未知判据：${criterion}（本卡判据：${ids.join("、") || "无"}）`);

  let summary = "未跑待复跑";
  let scriptExit = 0;
  if (flags.run !== undefined) {
    const ran = runCommand(runCmd, root);
    summary = ran.summary;
    scriptExit = ran.code;
  }

  const lines = original.split(/\r?\n/);
  const { sec, end, table } = locateTable(lines);
  let map;
  let tableLines = table;
  let insertAt;
  if (!table.length) {
    const header = `| ${EVIDENCE_HEADER.join(" | ")} |`;
    const sep = "|---|---|---|";
    lines.splice(sec + 1, 0, header, sep);
    map = { criterion: 0, merged: 1, verdict: 2 };
    tableLines = [sec + 1, sec + 2];
    insertAt = sec + 3;
  } else {
    const headerAt = table[0];
    map = headerMap(lines[headerAt]);
    const dataRows = table.slice(1).filter((i) => !isSeparator(lines[i]));
    const matches = dataRows.filter((i) => {
      const c = cells(lines[i]);
      return (c[map.criterion] ?? "").replace(/`/g, "").trim() === criterion;
    });
    if (matches.length > 1) {
      die(`表内已有 ${matches.length} 条 ${criterion} 行，请先手工合并成一行（不改文件）`);
    }
    if (matches.length === 1) {
      const row = cells(lines[matches[0]]);
      const width = Math.max(...Object.values(map).map((i) => i + 1));
      const out = Array(width).fill("");
      for (let i = 0; i < width; i++) out[i] = row[i] ?? "";
      out[map.criterion] = criterion;
      if (map.merged !== undefined) out[map.merged] = cell(`${summary}；${command}`);
      else { out[map.command] = cell(command); out[map.summary] = cell(summary); }
      lines[matches[0]] = `| ${out.join(" | ")} |`;
      writeAtomic(file, lines.join("\n"));
      console.log(`已更新 ${criterion}（${path.relative(process.cwd(), file)}）`);
      process.exit(scriptExit);
    }
    insertAt = tableLines[tableLines.length - 1] + 1;
  }
  const row = buildRow(map, map.merged !== undefined
    ? { criterion, merged: `${summary}；${command}` }
    : { criterion, command, summary });
  lines.splice(insertAt, 0, row);
  writeAtomic(file, lines.join("\n"));
  console.log(`已记录 ${criterion}（${path.relative(process.cwd(), file)}）`);
  process.exit(scriptExit);
}

function copyProject(src, dst) {
  // 副本不含 .git/node_modules：mutation 只验证脚本行为，不依赖版本库。
  const skip = new Set([".git", "node_modules"]);
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (from) => {
      const rel = path.relative(src, from);
      return rel === "" || !skip.has(rel.split(path.sep)[0]);
    },
  });
}

function runShell(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    timeout: 300000,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { code: result.status ?? 1, out };
}

function cmdMutation(flags, positional) {
  if (positional.length !== 0) die("用法：card.mjs mutation --card <卡号> --criterion C1 --mutate \"<改坏命令>\" --expect \"<应红命令>\"");
  const cardId = typeof flags.card === "string" ? flags.card.trim() : "";
  if (!/^M\d+-(?:\d+|G)$/.test(cardId)) die(`--card 不合法：${cardId || "（空）"}（如 M5-2）`);
  const criterion = flags.criterion;
  if (typeof criterion !== "string" || !/^C\d+$/.test(criterion)) die(`--criterion 不合法：${criterion ?? ""}（应为 C1）`);
  const mutate = typeof flags.mutate === "string" ? flags.mutate.trim() : "";
  const expect = typeof flags.expect === "string" ? flags.expect.trim() : "";
  if (!mutate) die("mutation 缺必填参数 --mutate（在副本里改坏实现的命令）");
  if (!expect) die("mutation 缺必填参数 --expect（改坏后应当非零的命令）");
  const root = findRoot(process.cwd());
  if (!root) die("找不到 .sdo/：请在本项目内运行");

  // 绑定卡号只用于输出与判据校验；mutation 不写卡，证据由 evidence --cmd ... --run 记录。
  const cardFile = cardPath(root, cardId);
  if (!criterionIds(readCard(cardFile)).includes(criterion)) die(`卡 ${cardId} 无判据：${criterion}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sdo-mutation-"));
  const work = path.join(temp, "work");
  const backup = path.join(temp, "backup");
  let restored = false;
  try {
    copyProject(root, work);
    copyProject(root, backup);

    const mutated = runShell(mutate, work);
    if (mutated.code !== 0) {
      console.log("expected=red actual=?");
      console.error(`mutation 命令本身失败（exit=${mutated.code}）：${mutated.out.slice(0, 400)}`);
      process.exitCode = 1;
      return;
    }
    const actual = runShell(expect, work);
    const actualRed = actual.code !== 0;

    fs.rmSync(work, { recursive: true, force: true });
    fs.renameSync(backup, work);
    restored = true;

    const green = runShell(expect, work);
    const restoredGreen = green.code === 0;

    console.log(`card=${cardId} criterion=${criterion}`);
    console.log(`expected=red actual=${actualRed ? "red" : "green"}`);
    console.log(`restored=${restoredGreen ? "green" : "red"}`);
    if (!actualRed || !restoredGreen) {
      if (!actualRed) console.error(`变异后命令仍为绿（actual=green）：${actual.out.slice(0, 400)}`);
      if (!restoredGreen) console.error(`恢复后命令仍红（restored=red）：${green.out.slice(0, 400)}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      if (!restored) fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

const ARGV = process.argv.slice(2);
if (ARGV.includes("--help") || ARGV.includes("-h")) {
  console.log(`用法：
  node <skill>/scripts/card.mjs new <M>-<n> --owner <席位> --intent <意图> --criteria "C1:结构:文字;C2:语义:文字" [--write-scope "a,b"] [--depends "M11-0、M11-1"]
    多项用分号（; 或 ；），禁止半角逗号；类型只 结构/语义/边界
  node <skill>/scripts/card.mjs evidence <卡号|卡文件> --criterion C1 --cmd "<命令>" [--run [命令]]
  node <skill>/scripts/card.mjs mutation --card <卡号> --criterion C1 --mutate "<改坏命令>" --expect "<应红命令>"`);
  process.exit(0);
}
const { cmd, flags, positional } = parseArgs(ARGV);
try {
  if (cmd === "new") cmdNew(flags, positional);
  else if (cmd === "evidence") cmdEvidence(flags, positional);
  else if (cmd === "mutation") cmdMutation(flags, positional);
  else die(`未知命令：${cmd}（只允许 new|evidence|mutation）`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
