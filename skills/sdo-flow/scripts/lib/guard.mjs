// 拒绝在技能目录内部创建/操作项目 .sdo/：init 与 baseline 共用的唯一实现。
import fs from "node:fs";
import path from "node:path";

function realish(target) {
  let p = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(p), ...tail);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return path.resolve(target);
      tail.unshift(path.basename(p));
      p = parent;
    }
  }
}

export function nestedRefusal(candidate, skillRoot, tool) {
  const c = realish(candidate);
  const s = realish(skillRoot);
  if (c === s || c.startsWith(s + path.sep)) {
    return `nested_sdo_refused：不要在技能目录内部创建/操作 .sdo/（技能目录是只读资产；请在项目根运行 ${tool}）`;
  }
  return null;
}

export function assertNotInsideSkill(candidate, skillRoot, tool) {
  const msg = nestedRefusal(candidate, skillRoot, tool);
  if (msg) { console.error(msg); process.exit(2); }
}
