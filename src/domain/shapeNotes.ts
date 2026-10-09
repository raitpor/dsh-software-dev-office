/**
 * **手写 YAML 的形状提示**（F-21 ①，与 F-20 的契约字段提示同一口径）。
 *
 * 背景：`.sdo/**\/*.yml` 是给人手改的真源，而 YAML 的类型由**写法**决定。F-20 修了
 * "标量位置的类型假设"（`retry: 2`），本模块处理同一家族的**容器位置形状假设**：
 * `dependsOn: api`（列表位置写成标量）、`targets: {a: 1}`（列表位置写成映射）、
 * `failureSemantics: none`（映射位置写成标量）—— 它们在旧实现里要么抛异常、要么被静默丢弃。
 *
 * 三条纪律（与 F-20 一致）：
 *   · **不崩**：归一化在各实体的 `readXxx` 边界完成，消费点不再见到错误形状；
 *   · **不静默**：每个形状问题都产出一条 `FieldShapeNote`，在**回执 / 只读视图 / 相关门禁详情**
 *     三处对用户可见；
 *   · **不猜**：标量写在列表位置 → 单元素列表（意图明确）；映射/对象写在列表位置、或任何东西
 *     写在映射位置 → 按空处理（不猜语义），但必须报出。
 *
 * 本模块只做**收集与渲染**：归一化本身在 `src/infra/scalar.ts`（纯函数）与各实体的读取边界。
 */
import { budgetShapeNotes } from '../integration/cost.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import { adrShapeNotes } from './adr.js'
import { applicabilityShapeNotes } from './applicability.js'
import { viewShapeNotes } from './architecture.js'
import { changeShapeNotes } from './change.js'
import { contractShapeNotes } from './contracts.js'
import { confirmationShapeNotes, uiViewShapeNotes } from './design.js'
import { feasibilityShapeNotes } from './feasibility.js'
import { questionShapeNotes } from './grill.js'
import { fmt, t } from './i18n.js'
import { issueShapeNotes } from './issues.js'
import { methodShapeNotes } from './method.js'
import { taskShapeNotes } from './plan.js'
import { qualityShapeNotes } from './quality.js'
import { manifestShapeNotes, runsShapeNotes } from './records.js'
import { requirementShapeNotes } from './requirements.js'
import { signatureShapeNotes } from './signature.js'

/**
 * 全部 `.sdo/**\/*.yml` 实体上的形状提示（**当前真源整体状态**，
 * 与 F-20 的 `contractFieldNotes` 同口径；顺序即回执里的展示顺序）。
 */
export function collectShapeNotes(store: SdoStore): FieldShapeNote[] {
  return [
    ...viewShapeNotes(store),
    ...uiViewShapeNotes(store),
    ...contractShapeNotes(store),
    ...requirementShapeNotes(store),
    ...questionShapeNotes(store),
    ...taskShapeNotes(store),
    ...applicabilityShapeNotes(store),
    ...methodShapeNotes(store),
    ...manifestShapeNotes(store),
    ...runsShapeNotes(store),
    ...adrShapeNotes(store),
    ...changeShapeNotes(store),
    ...feasibilityShapeNotes(store),
    ...issueShapeNotes(store),
    ...qualityShapeNotes(store),
    ...confirmationShapeNotes(store),
    ...signatureShapeNotes(store),
    ...budgetShapeNotes(store),
  ]
}

/** 形状提示的**每行文案**（不含项目符号；空数组表示没有提示）。 */
export function shapeNoteLines(notes: readonly FieldShapeNote[]): string[] {
  return notes.map((note) => {
    const params = {
      p1: t(`shapeEntity.${note.entity}`, note.entity),
      p2: note.id,
      p3: note.field,
      p4: note.actualType,
      p5: note.text,
      p6: note.key,
    }
    if (note.position === 'bool') return fmt('uiDescribe.shapeNoteBool', params)
    if (note.position === 'map') return fmt('uiDescribe.shapeNoteMapEmpty', params)
    return note.handling === 'single'
      ? fmt('uiDescribe.shapeNoteListSingle', params)
      : fmt('uiDescribe.shapeNoteListEmpty', params)
  })
}

/** 形状提示块的标题（有提示时由调用方加在行首）。 */
export function shapeNoteHeader(): string {
  return t('uiDescribe.shapeNoteHeader')
}

/**
 * 一块**可直接拼进回执**的形状提示（无提示时返回空数组，不留空行）。
 *
 * 回执、只读视图、门禁详情三处共用它，避免"三份各说各话"。
 */
export function shapeNoteBlock(notes: readonly FieldShapeNote[]): string[] {
  const lines = shapeNoteLines(notes)
  if (lines.length === 0) return []
  return [shapeNoteHeader(), ...lines.map((line) => `- ${line}`)]
}

/**
 * 一条门禁判据**该报哪些实体**的形状提示。
 *
 * 按判据的 `check` 键（而不是 C-xx 编号 —— 编号在不同流程里不同）匹配：
 * 例如 `design.contracts` 报契约、`design.views`/`design.artifacts`/`design.method-*`
 * 报视图 + 适用性声明 + 方法产物、`plan.*`/`tasks.*`/`iteration.*` 报任务卡、
 * `questions.*`/`dor.*` 报审讯问题、`delivery.*` 报交付清单。
 */
export function shapeNotesForCheck(check: string, notes: readonly FieldShapeNote[]): FieldShapeNote[] {
  const wanted = entitiesForCheck(check)
  if (wanted.length === 0) return []
  return notes.filter((note) => wanted.includes(note.entity))
}

/** 这条判据是否与形状提示相关（用于**惰性**收集：无关判据不触发读盘）。 */
export function checkWantsShapeNotes(check: string): boolean {
  return entitiesForCheck(check).length > 0
}

function entitiesForCheck(check: string): string[] {
  if (check === 'design.contracts') return ['contract']
  // 「五视图齐备」：视图本身的形状 + 声明（它决定哪些视图被判 present/absent）
  if (check === 'design.views') return ['view', 'applicability']
  // 「适用性声明结构完整」：只关乎声明本身
  if (check === 'design.applicability') return ['applicability']
  // 「声明的必需工件齐备」：工件来自声明、内容来自方法产物
  if (check === 'design.artifacts') return ['applicability', 'methodArtifact', 'method']
  if (check.startsWith('design.method')) return ['methodArtifact', 'method']
  if (check === 'design.adr') return ['adr']
  // 「关键条目均有用户确认戳」：确认戳台账 + 被确认的三类真源（元素 / 契约 / 界面条目）
  if (check === 'design.confirmed') return ['confirmation', 'contract', 'view', 'method']
  // 门禁级签字：只看签字台账
  if (check === 'design.signed' || check === 'human.signoff') return ['signature']
  if (check === 'ui.confirmed') return ['view', 'confirmation']
  if (check.startsWith('plan.') || check.startsWith('tasks.') || check.startsWith('iteration.')) return ['task']
  if (check.startsWith('dor.')) return ['question', 'requirement']
  if (check === 'design.no-open-questions' || check.startsWith('questions.') || check.startsWith('redteam.')) {
    return ['question', 'issue']
  }
  if (check.startsWith('feasibility.')) return ['feasibility']
  if (check.startsWith('trace.')) return ['view', 'task', 'requirement']
  if (check === 'prototype.backfilled') return ['requirement']
  if (check.startsWith('delivery.') || check === 'prototype.excluded') return ['manifest']
  return []
}
