/**
 * **派生人读文档**：`docs/DECISIONS.md` 与 `docs/QUALITY.md`。
 *
 * 为什么有它（DEF-004 / DEF-005，2026-10-12 狗粮台账）：
 *   · DEF-005：质量场景与 ATAM 只以 `.sdo/quality/*.yml` 真源形式存在，**没有任何人读文档承载** ——
 *     性能/可靠性/安全性/易用性/可维护性的刺激-响应-度量、ATAM 的风险与敏感点，只能靠人翻 YAML；
 *   · DEF-004：架构阶段声明的建议产物（`SDD.md` / `DECISIONS.md`）**没有任何渲染器**，
 *     于是审核单的「本门相关产物」表长期显示永远补不上的"缺失"。
 *
 * 口径与 `docs/SRS.md` / `docs/DESIGN.md` **完全一致**（不另造一套）：
 *   ① 真源永远在 `.sdo/`：文档只是**渲染快照**，绝不反向写台账；
 *   ② 头里绑定**渲染序号**（`<!-- source: … @ journal seq N -->`），判据据此证明"由当前真源渲染"；
 *   ③ 语言与阶段写在**元信息头行**（正文之外），避免切语言/推进阶段造成假红；
 *   ④ 覆盖前若盘上那份**不是我们写的**（有人手改）⇒ 先留副本再覆盖。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HASH_PREFIX } from './hash.js'
import { fmt, locale, t } from './i18n.js'
import { isMeasurable } from './quality.js'
import { renderHeader, renderMeta } from '../infra/render.js'
import { SdoStore } from '../infra/store.js'
import type { Adr, QualityAssessment, QualityScenario, SdoProject } from '../types.js'

/** 本模块负责的两份派生文档。 */
export type DerivedDocKind = 'decisions' | 'quality'

/** 相对工作区的路径（判据与渲染共用同一份映射，避免两处口径分叉）。 */
export function derivedDocRelativePath(kind: DerivedDocKind): string {
  return kind === 'decisions' ? 'docs/DECISIONS.md' : 'docs/QUALITY.md'
}

/** 真源位置（写进渲染头；判据据此知道这份文档从哪来）。 */
export function derivedDocSource(kind: DerivedDocKind): string {
  return kind === 'decisions' ? '.sdo/decisions' : '.sdo/quality'
}

/**
 * **固定章节**（判据按它校验；语言相关，所以存 i18n 键）。
 *
 * `DECISIONS.md`：① 决策清单 ② 决策详情 ③ 未决与后继
 * `QUALITY.md`：① 质量属性概览 ② 质量场景 ③ ATAM 分析 ④ 缺口
 */
export function derivedDocSections(kind: DerivedDocKind): readonly string[] {
  return kind === 'decisions'
    ? ['uiDerivedDoc.decS1', 'uiDerivedDoc.decS2', 'uiDerivedDoc.decS3']
    : ['uiDerivedDoc.quaS1', 'uiDerivedDoc.quaS2', 'uiDerivedDoc.quaS3', 'uiDerivedDoc.quaS4']
}

/** 正文的 sha256（`sha256:` 前缀，与全仓口径一致；用于判定"盘上这份是不是我们写的"）。 */
export function docHash(text: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** 渲染头（与 DESIGN.md / SRS.md 同款格式）。 */
function header(kind: DerivedDocKind, seq: number, phase: string): string[] {
  return [renderHeader(derivedDocSource(kind), seq), renderMeta(locale(), phase), '']
}

function bullets(labelKey: string, values: readonly string[]): string[] {
  const lines = [`**${t(labelKey)}**：`]
  if (values.length === 0) {
    lines.push(`- ${t('uiDerivedDoc.none')}`)
    return lines
  }
  for (const value of values) lines.push(`- ${value}`)
  return lines
}

/** 决策日志（ADR）：`docs/DECISIONS.md`。 */
export function renderDecisionsDoc(input: {
  project: SdoProject | undefined
  adrs: readonly Adr[]
  seq: number
  /** 元信息行里要写的阶段（判据按**头里声明的阶段**重渲染，避免 advance/rollback 造成假红）。 */
  phase?: string | undefined
}): string {
  const { project, adrs, seq } = input
  const phase = input.phase ?? project?.phase ?? ''
  const lines: string[] = []

  lines.push(...header('decisions', seq, phase))
  lines.push(`# ${t('uiDerivedDoc.decTitle')}`)
  lines.push('')
  lines.push(t('uiDerivedDoc.derivedNote'))
  lines.push('')
  lines.push(`- ${t('uiDerivedDoc.project')}：${project === undefined ? t('uiDerivedDoc.noProject') : `${project.id} ${project.name}`}`)
  lines.push(`- ${t('uiDerivedDoc.process')}：${project?.process ?? t('uiDerivedDoc.noProject')}`)
  lines.push(`- ${t('uiDerivedDoc.count')}：${adrs.length}`)
  lines.push(`- ${t('uiDerivedDoc.renderSeq')}：${seq}`)
  lines.push('')

  // ① 决策清单（先给全景，再逐条展开）
  lines.push(`## 1. ${t('uiDerivedDoc.decS1')}`)
  lines.push('')
  if (adrs.length === 0) {
    lines.push(t('uiDerivedDoc.none'))
  } else {
    lines.push(`| ${t('uiDerivedDoc.colId')} | ${t('uiDerivedDoc.colTitle')} | ${t('uiDerivedDoc.colStatus')} | ${t('uiDerivedDoc.colAlt')} |`)
    lines.push('| --- | --- | --- | --- |')
    for (const adr of adrs) {
      const alternatives = adr.alternatives.length === 0 ? t('uiDerivedDoc.none') : String(adr.alternatives.length)
      lines.push(
        `| ${adr.id} | ${adr.title} | ${t(`uiSignValue.${adr.status}`, adr.status)} | ${alternatives} |`,
      )
    }
  }
  lines.push('')

  // ② 决策详情
  lines.push(`## 2. ${t('uiDerivedDoc.decS2')}`)
  lines.push('')
  if (adrs.length === 0) {
    lines.push(t('uiDerivedDoc.none'))
    lines.push('')
  }
  for (const adr of adrs) {
    lines.push(`### ${adr.id}　${adr.title}`)
    lines.push('')
    lines.push(`- ${t('uiDerivedDoc.colStatus')} **${t(`uiSignValue.${adr.status}`, adr.status)}**`)
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.adrContext')}**：${adr.context}`)
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.adrDecision')}**：${adr.decision}`)
    lines.push('')
    // `alternatives` 是结构体数组（option/pros/cons），`consequences` 是（item/mitigation）——
    // 直接 `join` 会把 [object Object] 打进审核文档，必须按真实形状展开
    lines.push(`**${t('uiDerivedDoc.adrAlternatives')}**：`)
    if (adr.alternatives.length === 0) {
      lines.push(`- ${t('uiDerivedDoc.none')}`)
    }
    for (const alternative of adr.alternatives) {
      lines.push(`- **${alternative.option}**`)
      if (alternative.pros !== '') lines.push(`  - ${t('uiDerivedDoc.adrPros')}：${alternative.pros}`)
      if (alternative.cons !== '') lines.push(`  - ${t('uiDerivedDoc.adrCons')}：${alternative.cons}`)
    }
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.adrConsequences')}**：`)
    if (adr.consequences.length === 0) {
      lines.push(`- ${t('uiDerivedDoc.none')}`)
    }
    for (const consequence of adr.consequences) {
      lines.push(
        consequence.mitigation === undefined || consequence.mitigation === ''
          ? `- ${consequence.item}`
          : `- ${consequence.item}（${t('uiDerivedDoc.adrMitigation')}：${consequence.mitigation}）`,
      )
    }
    lines.push('')
    if (adr.supersededBy !== '') {
      lines.push(`- ${t('uiDerivedDoc.adrSupersededBy')}：${adr.supersededBy}`)
      lines.push('')
    }
  }

  // ③ 未决与后继（非 accepted 的决策 = 还需要人看的东西）
  lines.push(`## 3. ${t('uiDerivedDoc.decS3')}`)
  lines.push('')
  const pending = adrs.filter((adr) => adr.status !== 'accepted')
  if (pending.length === 0) {
    lines.push(`- ${t('uiDerivedDoc.decAllAccepted')}`)
  } else {
    for (const adr of pending) {
      lines.push(`- ${adr.id}「${adr.title}」${t('uiDerivedDoc.decPending')}${t(`uiSignValue.${adr.status}`, adr.status)}`)
    }
  }
  lines.push('')
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n+$/u, '')}\n`
}

/**
 * 质量属性与场景：`docs/QUALITY.md`。
 *
 * 这一份是 DEF-006 的落点：质量需求从此**既在人读文档里，也受门禁约束**
 * （判据 `quality.doc` 查"文档存在 + 新鲜 + 每条场景可度量 + 不在场要有理由"）。
 */
export function renderQualityDoc(input: {
  project: SdoProject | undefined
  scenarios: readonly QualityScenario[]
  assessment: QualityAssessment | undefined
  seq: number
  /** 同上：阶段是说明性元数据，判据按头里的声明重渲染。 */
  phase?: string | undefined
}): string {
  const { project, scenarios, assessment, seq } = input
  const phase = input.phase ?? project?.phase ?? ''
  const lines: string[] = []

  lines.push(...header('quality', seq, phase))
  lines.push(`# ${t('uiDerivedDoc.quaTitle')}`)
  lines.push('')
  lines.push(t('uiDerivedDoc.derivedNote'))
  lines.push('')
  lines.push(`- ${t('uiDerivedDoc.project')}：${project === undefined ? t('uiDerivedDoc.noProject') : `${project.id} ${project.name}`}`)
  lines.push(`- ${t('uiDerivedDoc.process')}：${project?.process ?? t('uiDerivedDoc.noProject')}`)
  lines.push(`- ${t('uiDerivedDoc.count')}：${scenarios.length}`)
  lines.push(`- ${t('uiDerivedDoc.renderSeq')}：${seq}`)
  lines.push('')

  // ① 质量属性概览：按属性聚合（ATAM 的第一步就是让属性与场景对上）
  const byAttribute = new Map<string, QualityScenario[]>()
  for (const scenario of scenarios) {
    const list = byAttribute.get(scenario.attribute) ?? []
    list.push(scenario)
    byAttribute.set(scenario.attribute, list)
  }
  lines.push(`## 1. ${t('uiDerivedDoc.quaS1')}`)
  lines.push('')
  if (scenarios.length === 0) {
    lines.push(t('uiDerivedDoc.none'))
  } else {
    lines.push(`| ${t('uiDerivedDoc.colAttribute')} | ${t('uiDerivedDoc.colScenarioCount')} | ${t('uiDerivedDoc.colMeasurable')} |`)
    lines.push('| --- | --- | --- |')
    for (const [attribute, list] of [...byAttribute.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const measurable = list.filter((scenario) => isMeasurable(scenario)).length
      lines.push(`| ${t(`uiSignQuality.${attribute}`, attribute)} | ${list.length} | ${measurable}/${list.length} |`)
    }
  }
  lines.push('')

  // ② 逐条场景（刺激 / 响应 / 度量 —— 三件必须齐，否则"需求"无法验收）
  lines.push(`## 2. ${t('uiDerivedDoc.quaS2')}`)
  lines.push('')
  if (scenarios.length === 0) {
    lines.push(t('uiDerivedDoc.none'))
    lines.push('')
  }
  for (const scenario of scenarios) {
    lines.push(`### ${scenario.id}　${t(`uiSignQuality.${scenario.attribute}`, scenario.attribute)}`)
    lines.push('')
    lines.push(
      `- ${t('uiDerivedDoc.colPriority')} **${t(`uiSignValue.${scenario.priority}`, scenario.priority)}**` +
        ` ｜ ${t('uiDerivedDoc.colMeasurable')} **${isMeasurable(scenario) ? t('uiDerivedDoc.yes') : t('uiDerivedDoc.no')}**`,
    )
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.quaStimulus')}**：${scenario.stimulus}`)
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.quaResponse')}**：${scenario.response}`)
    lines.push('')
    lines.push(`**${t('uiDerivedDoc.quaMeasure')}**：${scenario.measure}`)
    lines.push('')
    lines.push(
      scenario.targets.length === 0
        ? `- ${t('uiDerivedDoc.quaNoTargets')}`
        : `- ${t('uiDerivedDoc.quaTargets')}：${scenario.targets.join(' ')}`,
    )
    lines.push('')
  }

  // ③ ATAM：风险 / 敏感点 / 权衡点
  lines.push(`## 3. ${t('uiDerivedDoc.quaS3')}`)
  lines.push('')
  if (assessment === undefined) {
    lines.push(`- ${t('uiDerivedDoc.quaNoAssessment')}`)
  } else {
    lines.push(`- ${t('uiDerivedDoc.quaAssessor')}：${assessment.by}`)
    lines.push('')
    lines.push(...bullets('uiDerivedDoc.quaRisks', assessment.risks))
    lines.push('')
    lines.push(...bullets('uiDerivedDoc.quaSensitivities', assessment.sensitivities))
    lines.push('')
    lines.push(...bullets('uiDerivedDoc.quaTradeoffs', assessment.tradeoffs))
  }
  lines.push('')

  // ④ 缺口：不可度量的场景 + 没挂元素的场景 + 没做 ATAM
  lines.push(`## 4. ${t('uiDerivedDoc.quaS4')}`)
  lines.push('')
  const unmeasurable = scenarios.filter((scenario) => !isMeasurable(scenario))
  const orphans = scenarios.filter((scenario) => scenario.targets.length === 0)
  if (unmeasurable.length === 0 && orphans.length === 0 && assessment !== undefined) {
    lines.push(`- ${t('uiDerivedDoc.quaNoGap')}`)
  } else {
    for (const scenario of unmeasurable) {
      lines.push(`- ${fmt('uiDerivedDoc.quaGapUnmeasurable', { p1: scenario.id })}`)
    }
    for (const scenario of orphans) {
      lines.push(`- ${fmt('uiDerivedDoc.quaGapOrphan', { p1: scenario.id })}`)
    }
    if (assessment === undefined) lines.push(`- ${t('uiDerivedDoc.quaGapNoAssessment')}`)
  }
  lines.push('')
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n+$/u, '')}\n`
}

/**
 * 写派生文档（**覆盖式**，与 DESIGN.md 同款）。
 *
 * 返回：盘上前一份是否**不是我们写的**（有人手改过）以及留副本的相对路径。
 */
export function writeDerivedDoc(
  workspace: string,
  kind: DerivedDocKind,
  text: string,
): { path: string; bytes: number; handEdited: boolean; hash: string; snapshot?: string } {
  const relative = derivedDocRelativePath(kind)
  const store = new SdoStore(workspace)
  const [dir, file] = relative.split('/') as [string, string]
  const body = text.endsWith('\n') ? text : `${text}\n`
  const previous = existsSync(join(workspace, dir, file)) ? readFileSync(join(workspace, dir, file), 'utf8') : undefined
  // 上次渲染若记了 sha256，就能判定"盘上这份是不是我们写的"；对不上 ⇒ 手改，先留副本（§2.5b 同款）
  const recorded = lastRecordedHash(store, relative)
  let snapshot: string | undefined
  if (previous !== undefined && recorded !== undefined && docHash(previous) !== recorded) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const copyPath = ['evidence', 'hand-edits', `${file}.${stamp}.bak`] as const
    new SdoStore(workspace).writeText([...copyPath], previous)
    snapshot = copyPath.join('/')
  }
  store.writeText([dir, file], body)
  return {
    path: relative,
    bytes: Buffer.byteLength(body, 'utf8'),
    handEdited: snapshot !== undefined,
    // hash 由**刚写下的字节**给出：journal 与后续判据据此判定"盘上这份是不是我们写的"
    hash: docHash(body),
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/** 从 journal 里取上一份派生文档的 sha256（读不到就 `undefined`：此时不判手改，也不留副本）。 */
function lastRecordedHash(store: SdoStore, relative: string): string | undefined {
  try {
    const journalPath = join(store.root, 'journal.jsonl')
    if (!existsSync(journalPath)) return undefined
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line === undefined || line.trim() === '') continue
      try {
        const event = JSON.parse(line) as { type?: string; data?: { doc?: unknown; path?: unknown; sha256?: unknown } }
        if (event.type !== 'doc/rendered') continue
        const doc = String(event.data?.doc ?? event.data?.path ?? '')
        if (doc === relative && typeof event.data?.sha256 === 'string') return event.data.sha256
      } catch {
        /* 半写行忽略：真源的可信性由 journal 读取路径负责 */
      }
    }
  } catch {
    /* 读不到 journal 就不判手改 */
  }
  return undefined
}
