// 共享签字解析：编号、数值排序、里程碑门识别。
// 供 view.mjs（views/signs/next）与 check.mjs（计划签比对）共用，别写第二份。
// 兼容两种历史标题形态：
//   `# 签字 S41 · M8 里程碑门`（新）
//   `# S26（M5 门）`（旧）
export const SIGN_FILE_RE = /^S(\d+)(?:-[A-Z])?\.md$/;

// 从文件名（`S41.md`、`.sdo/sign/S42-A.md`）或标题文本里取签字号。
// 认不出时返回 null（调用方决定怎么排序/展示，不在这里猜）。
export function signNumber(value) {
  const text = String(value ?? "");
  const file = /(?:^|[\\/])(S(\d+)(?:-[A-Z])?)\.md$/.exec(text);
  if (file) return Number(file[2]);
  const m = /\bS(\d+)(?:-[A-Z])?\b/.exec(text);
  return m ? Number(m[1]) : null;
}

// 签字号展示：`S41`（不是数字 41），认不出时 `?`。
export function signLabel(value) {
  const ref = value && typeof value === "object" ? value.file ?? value.title : value;
  const n = signNumber(ref);
  return n === null ? "?" : `S${n}`;
}

// 按数值排序（S9 < S41），认不出的排最后、按文本稳定排序。
// getFile 默认取 `item.file`；也可传 `item => item.f` 之类的选择器。
export function sortSigns(items, getFile = (item) => (item && typeof item === "object" ? item.file : item)) {
  const list = [...(items ?? [])];
  return list.sort((a, b) => {
    const fa = String(getFile(a) ?? "");
    const fb = String(getFile(b) ?? "");
    const na = signNumber(fa);
    const nb = signNumber(fb);
    if (na === null && nb === null) return fa.localeCompare(fb);
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  });
}

function normalize(text) {
  return String(text ?? "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

// 里程碑门签字识别。sign 可以是 { title, scope } 或纯文本；返回门所属里程碑号（number）或 null。
// 只会认「M<n> 门 / M<n> 里程碑门」形态，不把计划签/卡签当门签。
export function milestoneGateNumber(sign) {
  const sources = typeof sign === "string"
    ? [sign]
    : [sign?.title, sign?.scope].filter((x) => typeof x === "string" && x.trim());
  for (const raw of sources) {
    for (const part of String(raw).split(/[；;]/)) {
      const t = normalize(part);
      let m = /^(?:签字\s*)?S\d+(?:-[A-Z])?\s*·\s*M(\d+)\s*里程碑门/.exec(t);
      if (!m) m = /^(?:签字\s*)?S\d+(?:-[A-Z])?\s*[（(]\s*M(\d+)\s*门/.exec(t);
      if (!m) m = /^M(\d+)\s*里程碑门/.exec(t);
      if (!m) m = /^M(\d+)\s*门(?:签)?$/.exec(t);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export function isMilestoneGateSign(sign, milestone) {
  const n = milestoneGateNumber(sign);
  return n !== null && `M${n}` === String(milestone);
}
