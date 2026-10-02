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

  const degraded = status.truthError !== undefined && status.truthError !== ''
  if (status.project === undefined) {
    // **G-07 / §5.1（评审员）**：工作区**未知**时不得断言"当前目录尚未初始化" ——
    // 实测该断言与事实相反（同一时刻 `sdo_status` 报的却是 PRJ-001 / 阶段 delivery / G0–G7 全过），
    // 因为注入路径拿到的工作区为空，代码却把"拿不到"渲染成了"没有账本"，直接误导接手者。
    //
    // **§5.1**：同一条纪律还有第二个入口 —— `project` 读不出（例如 `.sdo/project.json` 坏 JSON，
    // 而它是**可重建的派生投影**）。旧实现把"读不出"渲染成「尚未初始化」+「当前工作目录下没有 `.sdo/`」，
    // 还与告警**顺序颠倒**（早返回在告警之前），于是注入块对模型**说了一句假话**。
    // 现在：读不出就说读不出（含相对路径），并把"无法确认是否初始化"写清，绝不退化成"没有"。
    if (degraded) {
      lines.push(
        status.workspaceUnknown === true
          ? `${t('status.title')}${t('status.unknownWorkspace')}`
          : `${t('status.title')}${t('status.unverifiedSuffix')}`,
      )
      lines.push(fmt('status.truthError', { p1: status.truthError }))
      lines.push(t('status.truthErrorHint'))
      lines.push(fmt('status.noDirUnverified', { dir: dataDirName }))
      lines.push(t('status.background'))
      return clampBlock(lines, limit)
    }
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
  // **R-7 可见性（评审员 §4.1）**：`truthError` 此前只是 API 上的字段 —— 注入块（模型每轮真正读到的东西）
  // 一个字都不显示，于是"读不出真源"在模型看来与正常状态无异（甚至更像"没有账本"）。
  // 现在把它摆在最前面：下面的计数/门禁状态都**不可信**，并给出可操作的下一步。
  if (status.truthError !== undefined && status.truthError !== '') {
    lines.push(fmt('status.truthError', { p1: status.truthError }))
    lines.push(t('status.truthErrorHint'))
  }
  // **§6.4（评审员）**：`journal` 截断也是"真源不可信"，属于同一类告警 —— 放在计数**之前**，
  // 与 `truthError` 并排，读者才会知道"下面的数字可能不完整"。
  if (status.truncated) {
    lines.push(fmt('status.truncated', { line: status.badLine ?? '?' }))
  }
  // **§4.5（评审员）**：投影不可用时会被 `append → rebuild` 顺手重建，于是上一条 `truthError`
  // 会"毫无解释地消失"。这一行给出解释（诊断时不会误以为问题自己好了）。
  if (status.rebuilt) lines.push(t('status.rebuiltLine'))
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

  // **增量 1 / §1.3 第 2 条**：进入架构（设计）阶段就主动提示设计问题，让模型无法静默推进。
  // 这是"未与我交流"的根因所在 —— 状态块里不再只报数字，而是直接给出下一步动作。
  if (status.designPhase === true) {
    const open = status.openDesignQuestions ?? 0
    lines.push(open > 0 ? fmt('status.designOpen', { n: open }) : t('status.designNone'))
  }
  // **§7.1「不得静默」（注入块那一处）**：设计适用性声明必须每轮出现在状态块里 ——
  // 用户要在模型动手之前就看到"哪些视图做、哪些不做及理由"，以及"还差用户签字"。
  // 只在**设计语境**（已进架构阶段或已起草声明）出现，避免在需求早期变成噪声。
  const applicability = status.applicabilityLines
  if (applicability !== undefined && (status.designPhase === true || status.applicabilityConfirmed === true)) {
    lines.push(t('status.applicabilityHeader'))
    for (const line of applicability) lines.push(`- ${line}`)
    if (status.applicabilityConfirmed !== true) lines.push(t('status.applicabilityUnsigned'))
    if (status.designPhase === true && status.gateSigned !== true) lines.push(t('status.gateUnsigned'))
  }

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
