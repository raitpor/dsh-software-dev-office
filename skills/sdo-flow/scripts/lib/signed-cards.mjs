// 共享签字判定：签文件正文只认行首 `- 范围：<卡号>`（卡号后允许说明文字）。
// 供 sign.mjs（batch 选卡）与 check.mjs（变异基线签字引用）共用，避免两份口径漂移。
import fs from "node:fs";
import path from "node:path";

export const SIGN_FILE_RE = /^S\d+(?:-[A-Z])?\.md$/;

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
    }
  }
  return out;
}
