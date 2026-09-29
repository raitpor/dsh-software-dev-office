/**
 * 系统提示注入：每轮的 SDO 状态块（设计 §9.3）。
 *
 * 约束：
 *   · 字符数硬上限（配置 `statusChars`，默认 1500），超出即截断并标注；
 *   · **只在偏离默认时**出现条件行（红队被停用、journal 损坏、未初始化），
 *     不把默认状态写成噪声；
 *   · 不泄漏绝对路径（NFR-009）：数据目录只写相对名（如 `.sdo`）。
 */
import type { StatusSnapshot } from '../office.js'

const TITLE = '## SDO 研发办公室'

/** 计算红队是否按默认启用（未留痕时按规模档推断）。 */
export function redTeamDefault(config: StatusSnapshot['config']): boolean {
  if (config.redTeam === 'on') return true
  if (config.redTeam === 'off') return false
  return config.scale !== 'trivial'
}

/** 渲染状态块；未初始化时给出最小提示。 */
export function renderStatusBlock(status: StatusSnapshot, dataDirName: string, limit: number): string {
  const lines: string[] = []

  if (status.project === undefined) {
    lines.push(`${TITLE}（尚未初始化）`)
    lines.push(`- 当前工作目录下没有 \`${dataDirName}/\`。`)
    lines.push('- 要开始研发流程：调用 `sdo_init`（项目名/流程/规模），随后按阶段推进。')
    return clampBlock(lines, limit)
  }

  const project = status.project
  lines.push(TITLE)
  lines.push(
    `- 项目：${project.id} ${project.name} ｜ 流程 ${project.process} ｜ 规模 ${project.tailoring?.scale ?? status.config.scale}`
    + ` ｜ 阶段 ${project.phase}`,
  )
  const pending = status.pendingGate ?? '（无）'
  lines.push(
    `- 门禁：待判定 ${pending} ｜ 门禁记录 ${status.counts.gates} 条 ｜ 需求 ${status.counts.requirements} 条`
    + ` ｜ 问题账本 ${status.counts.questions} 条`,
  )

  // 只在偏离默认时出现的条件行
  const redTeamDefaultOn = redTeamDefault(status.config)
  const redTeamNow = project.redTeam?.enabled ?? redTeamDefaultOn
  if (project.redTeam !== undefined && redTeamNow !== redTeamDefaultOn) {
    const reason = project.redTeam.reason === undefined ? '' : `，${project.redTeam.reason}`
    lines.push(`- 红队：${redTeamNow ? '启用' : '停用'}（本会话${reason}）`)
  }
  if (status.truncated) {
    lines.push(`- ⚠️ 真源尾部损坏（journal.jsonl 第 ${status.badLine ?? '?'} 行），已截断到最后一致前缀；请人工检查。`)
  }
  if (status.configSource === 'default') {
    lines.push(`- 提示：\`${dataDirName}/config.yml\` 缺失或不可读，当前用默认项目配置（流程 ${status.config.process} ｜ 规模 ${status.config.scale}）。`)
  }

  lines.push(`- 数据目录：\`${dataDirName}/\`（真源 \`journal.jsonl\`；\`project.json\` 是派生视图，可重建）`)
  lines.push('- 命令：`/sdo-status` 看状态 ｜ `/sdo-board` 看看板（命令面只在交互式会话可用）')

  return clampBlock(lines, limit)
}

/** 按字符上限截断（保留头部，尾部给出明确标注）。 */
function clampBlock(lines: string[], limit: number): string {
  const text = lines.join('\n')
  if (text.length <= limit) return text
  const marker = '\n- …（状态块已达上限，完整信息请用 `sdo_status` 或 `/sdo-status`）'
  const keep = Math.max(0, limit - marker.length)
  return `${text.slice(0, keep)}${marker}`
}
