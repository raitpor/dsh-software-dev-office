// 共享签字判定：签文件正文只认行首 `- 范围：<卡号>`（卡号后允许说明文字）。
// 供 sign.mjs（batch 选卡）与 check.mjs（变异基线签字引用）共用，避免两份口径漂移。
import fs from "node:fs";
import path from "node:path";

export const SIGN_FILE_RE = /^S\d+(?:-[A-Z])?\.md$/;

export function gateSignInfo(signDir) {
  const out = new Map();
  if (!signDir || !fs.existsSync(signDir)) return out;
  for (const f of fs.readdirSync(signDir).filter((x) => SIGN_FILE_RE.test(x))) {
    const lines = fs.readFileSync(path.join(signDir, f), "utf8").split(/\r?\n/);
    const num = /^S(\d+)/.exec(f);
    for (const line of lines) {
      const m = /^-\s*范围[:：]\s*M(\d+)\s*里程碑门/.exec(line);
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
    for (const line of lines) {
      const scope = line.match(/^-\s*范围[:：]\s*(.+)$/);
      if (!scope) continue;
      const first = scope[1].match(/^M\d+-(?:\d+|G)(?![\w-])/);
      if (first) out.add(first[0]);
      const gate = /^M(\d+)\s*里程碑门/.exec(scope[1].trim());
      if (gate) out.add(`M${gate[1]}-G`);
    }
  }
  return out;
}
