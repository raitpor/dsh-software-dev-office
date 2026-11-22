// “当前里程碑”的唯一实现：编号最大、未归档、未门签（M8-3 C8）。
import fs from "node:fs";
import path from "node:path";
import { isArchived } from "./archive.mjs";

function gateSigned(root, m) {
  const dir = path.join(root, ".sdo/sign");
  if (!fs.existsSync(dir)) return false;
  const num = m.replace(/^M/, "");
  const patterns = [
    new RegExp(`^S[\\d-]+\\s*·\\s*M${num}\\s*门`),
    new RegExp(`^S[\\d-]+\\s*M${num}\\s*门签`),
    new RegExp(`^(?:签字\\s*)?S[\\d-]+\\s*[（(]\\s*M${num}\\s*门`),
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

// M8-4：某 preset 当前仍“活跃”（未归档）的里程碑。
// 数据源 = 计划索引 ∪ .sdo/milestones/；preset 优先取里程碑文件，回退计划索引表。
export function activeMilestonesUsing(root, preset) {
  const ids = new Set();
  const plan = path.join(root, ".sdo/计划.md");
  if (fs.existsSync(plan)) {
    for (const l of fs.readFileSync(plan, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\|\s*(M\d+)\s*\|[^|]*\|\s*`?([a-z-]+)`?/);
      if (m && m[2] === preset) ids.add(m[1]);
    }
  }
  const dir = path.join(root, ".sdo/milestones");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => /^M\d+\.md$/.test(x))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const m = text.match(/^preset[:：]\s*`?([a-z-]+)`?\s*$/m);
      if (m && m[1] === preset) ids.add(f.replace(/\.md$/, ""));
    }
  }
  return [...ids].filter((id) => !isArchived(root, id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
