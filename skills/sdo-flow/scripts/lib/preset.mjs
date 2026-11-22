// “当前里程碑”的唯一实现：编号最大、未归档、未门签（M8-3 C8）。
import fs from "node:fs";
import path from "node:path";
import { isArchived } from "./archive.mjs";

function gateSigned(root, m) {
  const dir = path.join(root, ".sdo/sign");
  if (!fs.existsSync(dir)) return false;
  const patterns = [
    new RegExp(`^S[\\d-]+\\s*·\\s*M${m}\\s*门`),
    new RegExp(`^S[\\d-]+\\s*M${m}\\s*门签`),
    new RegExp(`^(?:签字\\s*)?S[\\d-]+\\s*[（(]\\s*M${m}\\s*门`),
  ];
  for (const f of fs.readdirSync(dir).filter((x) => /^S\d+(?:-[A-Z])?\.md$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const title = (text.match(/^#\s*(.+)$/m) || [])[1] || "";
    if (patterns.some((re) => re.test(title.trim()))) return true;
  }
  return false;
}

export function currentMilestone(root) {
  const dir = path.join(root, ".sdo/milestones");
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir)
    .filter((f) => /^M\d+\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ""))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const id of ids) {
    if (isArchived(root, id)) continue;
    if (gateSigned(root, id)) continue;
    return id;
  }
  return null;
}
