// 判据/门禁池的唯一来源：--list 与 check 都 import 这里，禁止各自扫文档。
// 真源口径：presets/*.md 的停用/阶段/出口表；references/04 §1 只用于人工说明。
import fs from "node:fs";
import path from "node:path";

export const CORE_CRITERIA = ["spec_set.signed", "assumption_set.signed", "provenance.present"];
export const EXTRA_CRITERIA = ["gate.signed", "readings.recorded", "review.independent"];
const FILE_LIKE = /\.(?:mjs|js|cjs|ts|md|json|sh|yml|yaml)$/;

export function loadCriteriaPool(skillRoot) {
  const gates = new Set();
  const criteria = new Set();
  const dir = path.join(skillRoot, "presets");
  if (!fs.existsSync(dir)) return { gates: [], criteria: [] };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    let fenced = false;
    for (let line of fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      if (line.includes("<!--")) line = line.slice(0, line.indexOf("<!--"));
      for (const m of line.matchAll(/\bG_[a-z0-9_]+\b/g)) {
        const g = m[0];
        if (/^G_(?:id|x|a|b)$/.test(g) || /^G_xxx/.test(g)) continue;
        gates.add(g);
      }
      for (const m of line.matchAll(/[a-z_]+\.[a-z_]+/g)) {
        const c = m[0];
        if (FILE_LIKE.test(c)) continue;
        if (c.length < 3) continue;
        criteria.add(c);
      }
    }
  }
  for (const c of [...CORE_CRITERIA, ...EXTRA_CRITERIA]) criteria.add(c);
  return {
    gates: [...gates].sort(),
    criteria: [...criteria].sort(),
  };
}
