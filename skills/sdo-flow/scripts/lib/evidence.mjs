// 证据命令块的唯一解析：check.mjs 校验与 trace.mjs 的「见命令块 Cx」共用。
export function parseEvidenceBlocks(lines) {
  const secAt = lines.findIndex((l) => /^##\s*证据(?:\s|$)/.test(l.trim()));
  if (secAt < 0) return [];
  let secEnd = lines.length;
  for (let i = secAt + 1; i < lines.length; i++) if (/^##\s/.test(lines[i].trim())) { secEnd = i; break; }
  const blocks = [];
  for (let i = secAt + 1; i < secEnd; i++) {
    const m = /^```bash\s+命令块\s+(\S+)\s+exit=(\S+)\s*$/.exec(lines[i].trim());
    if (!m) continue;
    const body = [];
    let j = i + 1;
    for (; j < secEnd && lines[j].trim() !== "```"; j++) body.push(lines[j]);
    blocks.push({ id: m[1], exitText: m[2], line: i + 1, body: body.join("\n") });
    i = j;
  }
  return blocks;
}

export function blockForCriterion(blocks, criterion) {
  return blocks.find((b) => b.id === criterion && /^\d+$/.test(String(b.exitText))) || null;
}
