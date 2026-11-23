// 判定行的唯一解析：sign.mjs 的“是否已人签”与 check.mjs 的“是否草案”共用。
export function parseVerdict(lines) {
  let verdict = "";
  for (const raw of lines ?? []) {
    const m = /^\s*-\s*判定\s*[:：]\s*(.*)$/.exec(String(raw).trim());
    if (m) verdict = m[1].trim();
  }
  return verdict;
}

export function isUnsignedVerdict(value) {
  const v = String(value ?? "").trim();
  return v === "" || /^(待填|待签)/.test(v);
}
