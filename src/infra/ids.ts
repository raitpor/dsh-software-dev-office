/**
 * 身份证号分配：`PREFIX-001` 形式，位数可配（设计 §4.5 命名规范）。
 * 问题账本是四位（`Q-0007`），以避免与设计文档的两位评审问题号混淆。
 */
export function formatId(prefix: string, n: number, width = 3): string {
  return `${prefix}-${String(n).padStart(width, '0')}`
}

/** 从既有 ID 列表里推断下一个序号（忽略不符合前缀的数字部分）。 */
export function nextId(prefix: string, existing: Iterable<string>, width = 3): string {
  let max = 0
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  for (const id of existing) {
    const m = re.exec(id)
    if (m === null) continue
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  return formatId(prefix, max + 1, width)
}

/** 校验 ID 是否符合规范，返回原因（不合法时）。 */
export function validateId(id: string, prefix?: string): string | undefined {
  const re = prefix === undefined ? /^[A-Z]{2,8}-\d{2,6}$/ : new RegExp(`^${prefix}-\\d{2,6}$`)
  if (!re.test(id)) return `ID 必须形如 ${prefix ?? 'PREFIX'}-000（大写字母 + 数字）`
  return undefined
}
