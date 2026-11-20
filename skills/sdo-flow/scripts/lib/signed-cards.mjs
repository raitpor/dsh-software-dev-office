// 共享签字判定：签文件正文只认行首 `- 范围：<卡号>`（卡号后允许说明文字）。
// 供 sign.mjs（batch 选卡）、check.mjs（变异基线/门签收口）与 view.mjs（next 待签收）共用。
import fs from "node:fs";
import path from "node:path";

export const SIGN_FILE_RE = /^S\d+(?:-[A-Z])?\.md$/;

// 去掉 Markdown 清单符、反引号、加粗后，取「范围」后的正文。
export function normalizeScope(line) {
  let t = String(line).replace(/^\s*[-*+]\s*/, "");
  t = t.replace(/\*\*/g, "").replace(/`/g, "").trim();
  const m = /^范围[:：]\s*(.*)$/.exec(t);
  return (m ? m[1] : t).trim();
}

function addCard(out, milestone, n, maybeG) {
  out.add(maybeG ? `M${milestone}-G` : `M${milestone}-${n}`);
}

// 列举展开只在范围行含「收卡」或「门签」时生效：计划签里列举卡号不算卡签收。
export function parseSignedScopes(line) {
  const out = new Set();
  const text = normalizeScope(line);
  if (!text) return out;
  // 计划签（`M9 计划…`）一律不产生卡签/门签：即使正文写了「收卡」或「M9 里程碑门」。
  if (/^M\d+\s*计划/.test(text)) return out;
  const gate = /^M(\d+)\s*里程碑门/.exec(text);
  if (gate) out.add(`M${gate[1]}-G`);
  const semantic = /收卡|门签/.test(text);
  if (!semantic) {
    const first = /^M(\d+)-(?:(\d+)|G)(?![\w-])/.exec(text);
    if (first) addCard(out, first[1], first[2], first[2] === undefined);
    return out;
  }
  const lead = /^M(\d+)-(?:(\d+)|G)(?![\w-])/.exec(text);
  if (lead) addCard(out, lead[1], lead[2], lead[2] === undefined);
  for (const m of text.matchAll(/M(\d+)-(\d+)\s*(?:…|\.\.\.|—|~|至)\s*M\1-(\d+)/g)) {
    const a = Number(m[2]), b = Number(m[3]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(`M${m[1]}-${i}`);
  }
  return out;
}

export function gateSignInfo(signDir) {
  const out = new Map();
  if (!signDir || !fs.existsSync(signDir)) return out;
  for (const f of fs.readdirSync(signDir).filter((x) => SIGN_FILE_RE.test(x))) {
    const lines = fs.readFileSync(path.join(signDir, f), "utf8").split(/\r?\n/);
    const num = /^S(\d+)/.exec(f);
    for (const line of lines) {
      const text = normalizeScope(line);
      const m = /^M(\d+)\s*里程碑门/.exec(text);
      if (!m) continue;
      const id = `M${m[1]}-G`;
      if (!out.has(id)) out.set(id, { milestone: `M${m[1]}`, sign: `S${num ? num[1] : "?"}`, file: f });
    }
  }
  return out;
}

export function signedCardIds(signDir) {
  const out = new Set();
  if (!signDir || !fs.existsSync(signDir)) return out;
  for (const f of fs.readdirSync(signDir).filter((x) => SIGN_FILE_RE.test(x))) {
    const lines = fs.readFileSync(path.join(signDir, f), "utf8").split(/\r?\n/);
    // 卡签的标题含「收卡/卡签」时，范围行也允许用卡文件路径指名（`.sdo/cards/M7-0.md`）；
    // 计划签标题不含该词，因此不会借此替卡签兜底。
    const title = lines[0] || "";
    const viaPath = /收卡|卡签/.test(title);
    for (const line of lines) {
      if (!/^\s*[-*+]\s*范围[:：]/.test(line)) continue;
      const direct = parseSignedScopes(line);
      for (const id of direct) out.add(id);
      if (!viaPath) continue;
      // 路径式卡签只认“本签文件的目标卡”：目标卡号取自标题与范围里的直接卡号；
      // 提取不到目标卡、或路径卡号与目标卡不一致时一律忽略（防止借路径替别卡兜底）。
      const targets = new Set([...title.matchAll(/(M\d+-(?:\d+|G))/g)].map((m) => m[1]));
      for (const id of direct) targets.add(id);
      if (targets.size === 0) continue;
      for (const m of normalizeScope(line).matchAll(/\.sdo\/cards\/(M\d+-(?:\d+|G))\.md/g)) {
        if (targets.has(m[1])) out.add(m[1]);
      }
    }
  }
  return out;
}
