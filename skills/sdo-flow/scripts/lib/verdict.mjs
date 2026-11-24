// 判定行的唯一解析：sign.mjs 的“是否已人签”与 check.mjs 的“是否草案”共用。
export function parseVerdict(lines) {
  let verdict = "";
  for (const raw of lines ?? []) {
    const m = /^\s*-\s*判定\s*[:：]\s*(.*)$/.exec(String(raw).trim());
    if (m) verdict = m[1].trim();
  }
  return verdict;
}

// 未签 = 空串或前缀「待填/待签/未判」（保留 M11-7 的 `待填（草稿）` 宽松）；
// 其余（接受/拒绝/partial/任意其它串）一律按已签处理，是保守边界。
export function isUnsignedVerdict(value) {
  const v = String(value ?? "").trim();
  return v === "" || /^(待填|待签|未判)/.test(v);
}
