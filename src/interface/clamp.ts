/**
 * 工具输出统一上限（防上下文膨胀）。
 *
 * 实测教训：SDO 会话曾把 58 张任务卡 / 26 份契约 / 47 项校验结果原样回吐，配合"没有装配压缩"
 * 的 preset，几百次工具调用后就把上下文顶到 1M 上限。这里给出**确定性的**截断口，
 * 并明确告诉调用方怎么取完整内容（真源在 `.sdo/`，或用更具体的筛选参数重取）。
 */
import { fmt } from '../domain/i18n.js'

/** 单次工具回执的字符上限（粗略对应 1 字符 ≈ 0.6~1 token）。 */
export const TOOL_RESULT_CHARS = 8000

export function clampToolResult(text: string, limit: number = TOOL_RESULT_CHARS): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n${fmt('uiClamp.truncated', { p1: text.length, p2: limit })}`
}
