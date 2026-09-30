/**
 * 立项引导（需求 2026-09-29）：`sdo_init` **缺关键参数时必须先问**，不许拿默认值悄悄建项目。
 *
 * 为什么：项目名/流程/规模/干系人决定了后面所有门禁的判定口径，猜错等于把整个流程架在错误前提上。
 * 这里只产出"该问什么"（可测），真正提问由模型用宿主提问工具完成。
 */
import { t } from './i18n.js'

export interface InitGaps {
  name?: string | undefined
  process?: string | undefined
  scale?: string | undefined
  stakeholders?: string[] | undefined
}

/** 返回缺失项（中文描述）。全齐则返回空数组。 */
export function initGaps(input: InitGaps): string[] {
  const gaps: string[] = []
  if ((input.name ?? '').trim() === '') gaps.push('项目名')
  if ((input.process ?? '').trim() === '') gaps.push('开发流程')
  if ((input.scale ?? '').trim() === '') gaps.push('规模档')
  if ((input.stakeholders ?? []).filter((item) => item.trim() !== '').length === 0) gaps.push('干系人')
  return gaps
}

/** 渲染"请先确认这些信息"的问询单（每题都给选项与默认值，便于用户一句话回答）。 */
export function renderInitQuestions(gaps: string[]): string {
  const lines: string[] = [
    `⚠️ 还不能立项：缺少 ${gaps.join('、')}。**请先向我确认这些信息**（不要用默认值代替用户决定）。`,
    '',
    '建议这样问（每题都给选项，用户可一句话答完）：',
  ]
  if (gaps.includes('项目名')) {
    lines.push(`1. **项目名**：这个项目叫什么？（用于台账与文档标题，例如"局域网即时通讯系统"）`)
  }
  if (gaps.includes('开发流程')) {
    lines.push(
      `2. **开发流程**：${['waterfall', 'prototype', 'agile', 'spiral']
        .map((id) => `${t(`process.${id}`, id)}（${id}）`)
        .join(' / ')}？`
        + `—— 瀑布适合需求稳定；快速原型适合需求说不清、要先做出来看；敏捷适合持续小步交付；螺旋适合高风险、要反复评估。`,
    )
  }
  if (gaps.includes('规模档')) {
    lines.push(`3. **规模档**：小（trivial，个人/试验，红队默认关）／中（normal）／大（critical）？影响门禁强度与红队默认值。`)
  }
  if (gaps.includes('干系人')) {
    lines.push(`4. **干系人**：谁关心这个项目、谁要签字？（逗号分隔，例如"财务部,运维"）`)
  }
  lines.push('')
  lines.push(
    '拿到答复后再调用 `sdo_init`（或 `/sdo-init`）并带上这些参数；'
    + '**在此之前不要创建项目**——门禁口径全部依赖这些前提。',
  )
  return lines.join('\n')
}
