/**
 * 系统提示注入：每轮的 SDO 状态块（设计 §9.3）。
 *
 * 约束：
 *   · 字符数硬上限（配置 `statusChars`，默认 1500），超出即截断并标注；
 *   · **只在偏离默认时**出现条件行（红队被停用、journal 损坏、未初始化），
 *     不把默认状态写成噪声；
 *   · 不泄漏绝对路径（NFR-009）：数据目录只写相对名（如 `.sdo`）。
 *   · **所有文案来自 `src/data/lang/zh-CN.yml` 的 `status` 段**（用户要求：面向用户的表述一律走 lang）。
 */
import type { StatusSnapshot } from '../office.js'
import { fmt, gateLabel, label, phaseText, t } from '../domain/i18n.js'

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
    // **G-07**：工作区**未知**时不得断言"当前目录尚未初始化" ——
    // 实测该断言与事实相反（同一时刻 `sdo_status` 报的却是 PRJ-001 / 阶段 delivery / G0–G7 全过），
    // 因为注入路径拿到的工作区为空，代码却把"拿不到"渲染成了"没有账本"，直接误导接手者。
    lines.push(
      status.workspaceUnknown === true
        ? `${t('status.title')}${t('status.unknownWorkspace')}`
        : `${t('status.title')}${t('status.uninitSuffix')}`,
    )
    lines.push(fmt('status.noDir', { dir: dataDirName }))
    lines.push(t('status.background'))
    lines.push(t('status.initHint'))
    return clampBlock(lines, limit)
  }

  const project = status.project
  lines.push(t('status.title'))
  lines.push(fmt('status.projectLine', {
    id: project.id,
    name: project.name,
    process: t(`process.${project.process}`),
    scale: label('scale', project.tailoring?.scale ?? status.config.scale),
    phase: phaseText(project.phase),
  }))
  const pending = status.pendingGate === undefined ? t('status.noGate') : gateLabel(status.pendingGate)
  lines.push(fmt('status.gateLine', {
    gate: pending,
    gates: status.counts.gates,
    requirements: status.counts.requirements,
    questions: status.counts.questions,
  }))

  // 只在偏离默认时出现的条件行
  const redTeamDefaultOn = redTeamDefault(status.config)
  const redTeamNow = project.redTeam?.enabled ?? redTeamDefaultOn
  if (project.redTeam !== undefined && redTeamNow !== redTeamDefaultOn) {
    const reason = project.redTeam.reason === undefined ? '' : `，${project.redTeam.reason}`
    lines.push(fmt('status.redTeamLine', {
      state: redTeamNow ? t('status.enabled') : t('status.disabled'),
      reason,
    }))
  }
  if (status.truncated) {
    lines.push(fmt('status.truncated', { line: status.badLine ?? '?' }))
  }
  if (status.configSource === 'default') {
    lines.push(fmt('status.configDefault', {
      dir: dataDirName,
      process: status.config.process,
      scale: status.config.scale,
    }))
  }

  lines.push(fmt('status.dataDir', { dir: dataDirName }))
  lines.push(t('status.backgroundShort'))
  lines.push(t('status.commands'))

  return clampBlock(lines, limit)
}

/** 按字符上限截断（保留头部，尾部给出明确标注）。 */
function clampBlock(lines: string[], limit: number): string {
  const text = lines.join('\n')
  if (text.length <= limit) return text
  const marker = `\n${t('status.clampMarker')}`
  const keep = Math.max(0, limit - marker.length)
  return `${text.slice(0, keep)}${marker}`
}
