/** M2-1：will_change 结构 → 人读条目（M2-6 签名闸门要求 `string[]`）。 */
export function willChangeLines(will: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  if (will['first'] === true) lines.push('首次冻结');
  const gates = will['gates'] as Record<string, unknown> | undefined;
  const criteria = will['criteria'] as Record<string, unknown> | undefined;
  const na = will['na'] as Record<string, unknown> | undefined;
  const pushList = (label: string, value: unknown): void => {
    if (Array.isArray(value) && value.length > 0) lines.push(`${label}: ${value.map(String).join(', ')}`);
  };
  pushList('gate 新增', gates?.['added']);
  pushList('gate 删除', gates?.['removed']);
  pushList('gate 变更', gates?.['changed']);
  pushList('判据新增', criteria?.['added']);
  pushList('判据删除', criteria?.['removed']);
  pushList('na 新增', na?.['added']);
  pushList('na 移除', na?.['removed']);
  if (will['engine_changed'] === true) lines.push('引擎版本/清单变更');
  return lines.length === 0 ? ['基线内容未变更'] : lines;
}
