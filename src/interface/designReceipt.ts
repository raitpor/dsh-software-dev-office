/**
 * `sdo_design` 的交互动作回执（grill / answer / confirm / issues / render）。
 *
 * 为什么单独成模块：**模型工具**（`sdo_design`）与**斜杠命令**（`/sdo-design-*`）必须是
 * 同一条处理路径 —— 两处各写一份渲染/校验，迟早出现「命令与工具说法不一致」。
 * 这里只依赖 {@link SoftwareDevOffice} 与语言包，因此两条入口都能直接复用，
 * 也便于端到端测试（同一份实现喂给工具与命令，逐字比对）。
 *
 * 纪律：这五个动作**都在门禁（designPrecondition）之前**被调用 —— 它们正是用来把
 * 门禁缺的东西问出来、确认掉的；被门禁拦住的话「未与我交流」就永远无解（规格 §1.3）。
 * 顺序由 `src/index.ts` 的 `deps.design` 保证（本模块不感知门禁）。
 */
import { confirmGapLines, orphanConfirmationLines, parseUiViewInput, shortConfirmationHash } from '../domain/design.js'
import type { ContractDirectionAnomaly } from '../domain/contracts.js'
import {
  artifactEntryCount,
  artifactKindLabel,
  isMethodArtifactKind,
  methodArtifactFieldReport,
  methodLabel,
} from '../domain/method.js'
import type { MethodArtifactInput } from '../domain/method.js'
import { METHOD_ARTIFACT_KINDS } from '../types.js'
import type { MethodArtifactKind } from '../types.js'
import { shapeNoteBlock } from '../domain/shapeNotes.js'
import { fmt, t } from '../domain/i18n.js'
import type { OfficeCall, SoftwareDevOffice } from '../office.js'
import type { DesignArgs } from './tools.js'
import type { GrillQuestion } from '../types.js'
import { methodDocHeader } from '../domain/methodDocs.js'

/** 回执分段拼接：空段不产生多余空行（`joinReceiptParts(['a','','b']) === 'a\n\nb'`）。 */
export function joinReceiptParts(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('\n\n')
}

/** 设计草案（`grill` 返回体的第 ① 段）：按视图组织，标注来源需求与置信度。 */
export function renderDesignDraft(office: SoftwareDevOffice, call: OfficeCall): string {
  const draft = office.designDraft(call)
  const lines: string[] = [t('uiDesign.uiDraftHeader')]
  for (const view of draft.views) {
    lines.push(`### ${view.kind}`)
    if (view.elements.length === 0) {
      lines.push(`- ${t('uiDesign.uiDraftEmptyView')}`)
      continue
    }
    for (const element of view.elements) {
      const source = element.requires.length === 0 ? t('uiDesign.uiDraftNoSource') : element.requires.join(' ')
      lines.push(`- ${element.id}｜${element.name}（${element.kind}）｜${t('uiDesign.docRequires')}：${source}｜${t('uiDesign.docConfidence')}：${element.confidence}`)
    }
  }
  if (draft.views.length === 0) lines.push(`- ${t('uiDesign.uiDraftEmptyView')}`)
  // 第 6 个视图：判真写真内容，判假写 N/A + 理由（§2.1 / §3 第 5 章同源做法）
  lines.push('### ui')
  if (!draft.uiDecision.hasUi) lines.push(`- ${t('uiDesign.uiDraftUiNa')}：${draft.uiDecision.reason}`)
  else if (draft.ui === undefined) lines.push(`- ${t('uiDesign.uiDraftUiMissing')}`)
  else {
    lines.push(`- ${draft.ui.id}｜${t('uiDesign.docUiStyle')}：${draft.ui.style.source}｜${t('uiDesign.docUiScreens')}：${draft.ui.screens.length}`)
    const check = office.uiView(call).check
    lines.push(`- ${t('uiDesign.docUiConfirm')}：${check.ok ? t('uiDesign.uiViewConfirmed') : `${t('uiDesign.uiViewUnconfirmed')}（${[...check.missing, ...check.unconfirmed].join(' ')}）`}`)
  }
  return lines.join('\n')
}

/** 问题清单（`grill` / `issues` 的第 ② 段）：带建议与代价。 */
export function renderDesignQuestions(questions: GrillQuestion[]): string {
  const lines: string[] = []
  if (questions.length === 0) {
    lines.push(t('uiDesign.uiNoQuestions'))
    return lines.join('\n')
  }
  for (const question of questions) {
    lines.push(`- ${question.id}｜${question.text}`)
    // F-5：已有 ADR 定案的题**先**标出来，用户才知道这是一道"仅确认"而不是新决策。
    if ((question.decidedBy ?? '') !== '') {
      lines.push(`  - ${fmt('uiDesign.qAlreadyDecided', { p1: question.decidedBy ?? '' })}`)
    }
    lines.push(`  - ${t('uiDesign.docQuestionWhy')}：${question.why}`)
    lines.push(`  - ${t('uiDesign.docQuestionCost')}：${question.consequenceIfUnasked}`)
    lines.push(`  - ${t('uiDesign.docQuestionSuggest')}：${question.defaultRecommendation}`)
    lines.push(`  - ${t('uiDesign.docQuestionOptions')}：${question.options.map((option) => `${option.label}（${option.cost}）`).join('；')}`)
  }
  return lines.join('\n')
}

/**
 * 「必须确认但尚未确认」的 target 清单（issues 动作与 DESIGN.md §7 共用）。
 *
 * 这是真实 UX 缺口的补丁：`confirm` 要求 `target`，但此前没有任何入口告诉用户/模型
 * **到底有哪些 target 必须确认**。清单只来自 `designConfirmGaps`（真源推导），
 * **没有任何关键条目时整段为空**（绝不凭空造 target）。`state=all` 也不改变它 —— 确认戳
 * 只有"已确认"一种状态，未确认的就是未确认。
 */
export function renderConfirmGaps(office: SoftwareDevOffice, call: OfficeCall): string {
  const lines = confirmGapLines(office.designConfirmGaps(call))
  if (lines.length === 0) return ''
  return [t('uiDesign.confirmGapsHeader'), ...lines].join('\n')
}

/**
 * 「名字与 producer/consumer 矛盾」的契约清单（F-16 的**存量残留诊断**）。
 *
 * 检测，不自动纠正：报告 §6.6.1 逐条语义核对后是「9 条字段反了 + 17 条名字是旧口径」——
 * 形式矛盾只能证明"两者之一错了"，**推不出是哪一边**。所以这里只把人叫过来核对，
 * 不替用户对调（对调会改错一半记录）。
 */
export function renderContractDirectionAnomalies(anomalies: ContractDirectionAnomaly[]): string {
  if (anomalies.length === 0) return ''
  const lines: string[] = [t('uiDesign.contractDirectionHeader')]
  for (const item of anomalies.slice(0, 10)) {
    lines.push(`- ${fmt('uiDesign.contractDirectionLine', {
      p1: item.id,
      p2: item.name,
      p3: item.producer,
      p4: item.consumer,
      p5: item.expectedName,
    })}`)
  }
  if (anomalies.length > 10) lines.push(`- ${fmt('uiDesign.contractDirectionMore', { p1: anomalies.length - 10 })}`)
  lines.push(`- ${t('uiDesign.contractDirectionHint')}`)
  return lines.join('\n')
}

/**
 * **已找不到对应条目**的旧确认戳清单（**Y-7**）。
 *
 * 这类戳既不在"必须确认"清单里（目标已不在真源），也不在"失效"清单里（解析不出内容 →
 * `staleConfirmations` 直接跳过），于是**完全静默**：用户以为确认过，门禁也不再提它。
 * 这里单独列出、**不判红**（条目下线本身可能是合法的），但必须让人看见。
 */
export function renderOrphanConfirmations(office: SoftwareDevOffice, call: OfficeCall): string {
  const lines = orphanConfirmationLines(office.designConfirmGaps(call))
  if (lines.length === 0) return ''
  return [t('uiDesign.uiOrphanConfirmationsHeader'), ...lines].join('\n')
}

/**
 * **因内容变更而失效**的确认戳清单（F-19）。
 *
 * 修的是什么：确认戳此前只按 `target` 记账，**改了内容旧戳仍算"已确认"** ——
 * 用户确认的是 A 版本、门禁背书的是 B 版本。现在确认戳绑定内容指纹，写入动作
 * 必须能说清「这次改动让哪条确认失效了」，否则"自动失效"只是判据变红，用户不知道原因。
 *
 * `sinceTargets`：改动**前**的失效集合（写入动作先取一次再传进来）。
 * 给了它 → 只报「本次改动新失效」的条目；没给 → 报当前全部失效条目。
 */
export function renderInvalidatedConfirmations(
  office: SoftwareDevOffice,
  call: OfficeCall,
  sinceTargets?: readonly string[],
): string {
  const since = sinceTargets === undefined ? undefined : new Set(sinceTargets)
  const stale = office.staleConfirmations(call).filter((item) => since === undefined || !since.has(item.target))
  if (stale.length === 0) return ''
  const lines: string[] = [t('uiDesign.uiConfirmInvalidatedHeader')]
  for (const item of stale) {
    lines.push(`- ${fmt('uiDesign.uiConfirmInvalidatedLine', {
      p1: item.target,
      p2: item.by,
      p3: item.at,
      // 短前缀足够人眼对比"变没变"，也避免把 64 位哈希塞满回执
      p4: item.confirmedHash === '' ? t('uiDesign.uiConfirmUnbound') : shortConfirmationHash(item.confirmedHash),
      p5: shortConfirmationHash(item.currentHash),
    })}`)
  }
  lines.push(`- ${t('uiDesign.uiConfirmInvalidatedHint')}`)
  return lines.join('\n')
}

/**
 * 「本项目启用了哪些方法包」+「各包最小必产项」的只读回执（增量 2）。
 *
 * 逐包显示：已选包列缺什么 / 未选包写 N/A + 理由 —— 与门禁回执同一口径（`methodProducts`）。
 */
export function renderMethodStatus(office: SoftwareDevOffice, call: OfficeCall): string {
  const selection = office.methodSelection(call)
  const products = office.methodProducts(call)
  const lines: string[] = [t('uiMethod.viewHeader')]
  if (selection.status === 'chosen') {
    lines.push(`- ${t('uiMethod.viewSelected')}：${selection.methods.map((id) => methodLabel(id)).join(' + ')}`)
  } else if (selection.status === 'none') {
    lines.push(`- ${t('uiMethod.viewNone')}`)
  } else {
    lines.push(`- ${fmt('uiMethod.viewMissing', { p1: selection.reason })}`)
  }
  lines.push(`- ${t('uiMethod.viewProducts')}`)
  for (const check of products.packages) lines.push(`  - ${check.detail}`)
  // 方法包**人审文档**（用户要求）：逐包给出状态与**当前指纹** —— 模型据此写文档头
  const docs = office.methodDocStatuses(call)
  if (docs.length > 0) {
    lines.push(`- ${t('uiMethod.viewDocs')}`)
    for (const doc of docs) {
      const label = methodLabel(doc.pkg)
      if (!doc.exists) {
        lines.push(`  - ${fmt('uiMethod.viewDocMissing', { p1: label, p2: doc.path, p3: methodDocHeader(doc.pkg, doc.expectedBasis) })}`)
      } else if (doc.stale) {
        lines.push(`  - ${fmt('uiMethod.viewDocStale', { p1: label, p2: doc.path, p3: doc.declaredBasis ?? t('uiGates.kMethodDocNoHeader'), p4: doc.expectedBasis })}`)
      } else if (doc.missingIds.length > 0) {
        lines.push(`  - ${fmt('uiMethod.viewDocIncomplete', { p1: label, p2: doc.path, p3: doc.missingIds.join(' ') })}`)
      } else {
        lines.push(`  - ${fmt('uiMethod.viewDocOk', { p1: label, p2: doc.path })}`)
      }
    }
  }
  // F-13 / F-14：豁免必须能在只读回执里看到（不是只在门禁那一行里一闪而过）
  if (products.exemptions.length > 0) {
    lines.push(`- ${fmt('uiMethod.pkgExempt', { p1: products.exemptions.join('；') })}`)
  }
  // F-21：方法产物 / 快照的手写形状提示同样要在**只读视图**里可见
  lines.push(...shapeNoteBlock(office.shapeNotes(call)))
  return lines.join('\n')
}

/**
 * 写入一份方法产物（`action=artifact`）。返回可读回执；JSON 非法或种类未知时给可读错误。
 *
 * F-10（与 F-8 同族的"静默"）：`artifactData` 的字段名此前只能靠读源码 —— 模型把
 * `layers/assignments/allowed` 写在**顶层**（正确形状是 `rules:{…}`）时，回执只说「0 条」，
 * **不提示哪些字段被忽略**。现在两件事都做：
 *   ① 形状文档化（工具参数描述 `param.designArtifactData` 里逐 kind 列出）；
 *   ② 未知/被忽略字段**一律显式报出**；若这次提交**一个期望字段都没有**且盘上还没有该产物，
 *      直接**拒绝写入**（不落半成品）。
 */
export function writeMethodArtifactReceipt(office: SoftwareDevOffice, call: OfficeCall, args: DesignArgs): string {
  const kind = (args.artifactKind ?? '').trim()
  if (!isMethodArtifactKind(kind)) {
    return fmt('uiMethod.artifactKindUnknown', { p1: kind === '' ? t('uiMethod.artifactKindEmpty') : kind, p2: METHOD_ARTIFACT_KINDS.join(' / ') })
  }
  let body: MethodArtifactInput
  try {
    body = JSON.parse(args.artifactData ?? '') as MethodArtifactInput
  } catch (error) {
    return fmt('uiMethod.artifactDataInvalid', { p1: error instanceof Error ? error.message : String(error) })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return t('uiMethod.artifactDataNotObject')
  }
  const label = artifactKindLabel(kind)
  const fields = methodArtifactFieldReport(kind as MethodArtifactKind, body as Record<string, unknown>)
  // 顶层放错的字段 + 对象型正文里嵌错的下级字段，一起报出来（绝不许静默）
  const ignored = [...fields.ignored, ...fields.ignoredNested]
  const hasExisting = office.methodArtifacts(call).some((artifact) => artifact.kind === kind)
  // **Y-5（本报告）**：旧实现的条件是 `present.length === 0 && !hasExisting` ——
  // 当产物**已在盘上**时，把 `layers/assignments/allowed` 写在顶层（而非 `rules:` 内）
  // 会**走到写入**，而 merge 只认 `patch.rules`：产物内容一点没变，却记了 `updatedAt`、
  // append 了 `design/artifact-updated`（它又在签字失效白名单里 → 顺带作废 G3 签字）。
  // 现在：**只要这次提交的字段全被忽略**（`ignored.length > 0` 且没有任何期望字段生效）
  // 一律拒绝并保留盘上原值；只有"至少一个期望字段生效"或"只改 summary/requires 这类公共字段"
  // （`ignored.length === 0`）才允许写。
  if (fields.present.length === 0 && (ignored.length > 0 || !hasExisting)) {
    const suffix = ignored.length === 0
      ? ''
      : ` ${fmt('uiMethod.artifactIgnoredSuffix', {
          p1: ignored.join(' '),
          p2: label,
          p3: fields.expected.join(' '),
        })}`
    return `${fmt('uiMethod.artifactNoPayload', { p1: label, p2: fields.expected.join(' ') })}${suffix}`
  }
  const staleBefore = office.staleConfirmations(call).map((item) => item.target)
  const artifact = office.writeMethodArtifact(call, kind as MethodArtifactKind, body)
  const base = fmt('uiMethod.artifactOk', { p1: artifactKindLabel(kind), p2: String(artifactEntryCount(artifact)) })
  // F-19：写入动作不该默默略过失效状态 —— 这次提交前后新失效的确认戳一并点名
  //（方法产物本身不在关键条目清单里，所以这里通常是空段；空段不产生多余空行）
  const invalidated = renderInvalidatedConfirmations(office, call, staleBefore)
  const withInvalidated = invalidated === '' ? base : `${base}\n\n${invalidated}`
  // F-21：方法产物的形状提示（`collaborators: repo` 这类手写）必须在写入回执里点名
  const shape = shapeNoteBlock(office.shapeNotes(call))
  const withShape = shape.length === 0 ? withInvalidated : `${withInvalidated}\n${shape.join('\n')}`
  if (ignored.length === 0) return withShape
  return `${withShape} ${fmt('uiMethod.artifactIgnoredSuffix', {
    p1: ignored.join(' '),
    p2: label,
    p3: fields.expected.join(' '),
  })}`
}

/**
 * 写入界面视图（`action=create kind=ui`，F-9）。
 *
 * 修的是什么：`ui` 此前是**死参数** —— schema 暴露了它、`writeUiView` 也有实现，
 * 但没有任何入口把它们接起来，而 `action=view` 只是**只读**渲染。于是含界面的项目
 * C-27 永远红、G3 永久不可通过。这里把「解析 JSON → 写视图 → 给出确认清单」
 * 收成一条真实可用的调用路径（`action=view kind=ui` 仍然只读）。
 */
export function writeUiViewReceipt(office: SoftwareDevOffice, call: OfficeCall, raw: string): string {
  const parsed = parseUiViewInput(raw)
  if ('error' in parsed) return parsed.error
  const staleBefore = office.staleConfirmations(call).map((item) => item.target)
  const view = office.writeUiView(call, parsed.view)
  const base = fmt('uiDesign.uiWriteOk', { p1: view.id, p2: String(view.screens.length) })
  // F-19：整份重写会让"内容变过"的旧确认失效 —— 必须当场点名，不能等门禁变红才让人猜。
  const invalidated = renderInvalidatedConfirmations(office, call, staleBefore)
  // 写完立刻给出"还差哪些确认戳"：否则用户不知道下一步 `action=confirm target=…` 该填什么。
  const gaps = renderConfirmGaps(office, call)
  return joinReceiptParts([base, invalidated, gaps])
}

/** `sdo_design` 的交互动作：grill / answer / confirm / issues / render。 */
export function designInteraction(office: SoftwareDevOffice, call: OfficeCall, action: string, args: DesignArgs): string {
  // 增量 2：方法包的两个动作也必须在**门禁之前** —— 它们正是用来补齐门禁要的方法产物的
  // （放门禁后面的话，"缺方法产物"就永远无解）。
  if (action === 'method') return renderMethodStatus(office, call)
  if (action === 'artifact') return writeMethodArtifactReceipt(office, call, args)
  if (action === 'grill') {
    const result = office.grillDesign(call, {
      recommendation: {
        ...(args.method === undefined ? {} : { method: args.method }),
        ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
      },
      ...(args.round === undefined ? {} : { limit: args.round }),
      ...(args.by === undefined ? {} : { by: args.by }),
    })
    const gaps = office.designConfirmGaps(call)
    const diff: string[] = [t('uiDesign.uiDiffHeader')]
    diff.push(`- ${t('uiDesign.uiDiffAdded')}：${result.added.length === 0 ? t('uiDesign.uiDiffNone') : result.added.join(' ')}`)
    diff.push(`- ${t('uiDesign.uiDiffResolved')}：${result.resolved.length === 0 ? t('uiDesign.uiDiffNone') : result.resolved.join(' ')}`)
    diff.push(`- ${t('uiDesign.uiDiffStillOpen')}：${result.stillOpen.length === 0 ? t('uiDesign.uiDiffNone') : result.stillOpen.join(' ')}`)
    diff.push(`- ${t('uiDesign.uiDiffRecheck')}：${gaps.missing.length === 0 ? t('uiDesign.uiDiffNone') : gaps.missing.join(' ')}`)
    return joinReceiptParts([
      renderDesignDraft(office, call),
      `${t('uiDesign.uiQuestionsHeader')}\n${renderDesignQuestions(result.open)}`,
      diff.join('\n'),
      // F-21：手写 YAML 的形状提示（视图元素 / 契约 / 问题）在交互回执里同样可见
      shapeNoteBlock(office.shapeNotes(call)).join('\n'),
    ])
  }

  if (action === 'issues') {
    const ledger = office.designIssues(call)
    const all = args.state === 'all'
    const shown = all ? [...ledger.open, ...ledger.closed] : ledger.open
    const questions = shown.length === 0
      ? (all ? t('uiDesign.uiIssuesEmpty') : t('uiDesign.uiNoQuestions'))
      : `${t('uiDesign.uiIssuesHeader')}\n${renderDesignQuestions(shown)}`
    // 关键条目的确认缺口**必须**在这里出现：它正是 `confirm` 要的 target 清单。
    // 无论问题账本是否为空都要给（此前没有未决问题时整段被提前 return 吞掉 = UX 缺口）。
    const gaps = renderConfirmGaps(office, call)
    // **§7.1「不得静默」的其中一处**：适用性声明（哪些视图做、哪些不做及理由）必须列在这里，
    // 与注入块、`docs/DESIGN.md` 三处保持一致。
    const applicability = `${t('uiDesign.uiApplicabilityHeader')}\n${office.applicabilityLines(call).map((line) => `- ${line}`).join('\n')}`
    const body = gaps === '' ? questions : `${questions}\n\n${gaps}`
    // Y-7：孤儿确认戳在只读视图里同样必须可见（不得静默）
    const orphans = renderOrphanConfirmations(office, call)
    // F-21：`issues` 是设计阶段的**只读视图**，形状提示必须同样列出（不得静默）
    return joinReceiptParts([applicability, body, orphans, shapeNoteBlock(office.shapeNotes(call)).join('\n')])
  }

  if (action === 'answer') {
    const id = args.questionId ?? args.id ?? ''
    if (id === '') return fmt('uiDesign.uiAnswerNotFound', { p1: '' })
    // `assume=true` = 用户明确说"按你的建议办"：采用默认建议并记为**已授权**假设。
    // 没有这句话就不许自问自答（与需求阶段的纪律一致）。
    if (args.assume === true) {
      const assumed = office.assumeDesign(call, id, args.by ?? 'human')
      return assumed === undefined
        ? fmt('uiDesign.uiAnswerNotFound', { p1: id })
        : fmt('uiDesign.uiAnswerOk', { p1: assumed.id, p2: assumed.answer ?? '' })
    }
    // 空答复不是答复：旧实现会写一条 `answer: ''` 并把问题标记为**已答**（门禁因此误判通过）。
    // 工具与命令都走这里，所以两条入口给出同一句可读错误。
    if ((args.choice ?? '').trim() === '') return t('uiDesign.uiAnswerNeedChoice')
    const answered = office.answerDesign(call, id, args.choice ?? '', args.note, args.by)
    return answered === undefined
      ? fmt('uiDesign.uiAnswerNotFound', { p1: id })
      : fmt('uiDesign.uiAnswerOk', { p1: answered.id, p2: answered.answer ?? '' })
  }

  if (action === 'confirm') {
    const target = (args.target ?? args.id ?? '').trim()
    if (target === '') {
      // 缺 target 时**顺带给出必须确认的清单**：否则用户不知道 `--target` 该填什么。
      const gaps = renderConfirmGaps(office, call)
      return gaps === '' ? t('uiDesign.uiConfirmMissing') : `${t('uiDesign.uiConfirmMissing')}\n\n${gaps}`
    }
    const gaps = office.designConfirmGaps(call)
    // **Y-1（本报告）**：旧实现在白名单里特批了裸 `'ui'`（`… && target !== 'ui'`）——
    // 它既不是 `UI_TARGET`（`design:ui`），也不是任何真实条目，真源里**没有任何消费者**；
    // 执行它会写一条 `contentHash: ''` 的确认戳（永远不被承认），回执却说"确认成功"，
    // 而且 `design/confirmed` 在签字失效白名单里 → 顺手作废 G3 签字。特批删除。
    if (!gaps.required.includes(target)) {
      return fmt('uiDesign.uiConfirmUnknown', { p1: target })
    }
    const basis = args.note ?? args.reason ?? t('uiDesign.uiConfirmDefaultBasis')
    const confirmed = office.confirmDesign(call, target, basis, args.by ?? 'human')
    // Y-1：目标在当前真源里解析不出内容 → **拒绝写入**，如实报告（不再谎报"已确认"）
    if (confirmed === undefined) return fmt('uiDesign.uiConfirmUnresolvable', { p1: target })
    const ok = fmt('uiDesign.uiConfirmOk', { p1: target, p2: basis })
    // F-19：确认一条之后，仍**因内容变更**而失效的条目要接着列出来 ——
    // 只报"这条确认好了"会让用户以为整批都干净了。
    const remaining = renderInvalidatedConfirmations(office, call)
    const orphans = renderOrphanConfirmations(office, call)
    return [ok, remaining, orphans].filter((part) => part !== '').join('\n\n')
  }

  // render：可选 `puml` —— 额外写一份 PlantUML **骨架源码**（本仓库没有渲染器，不出图）
  const rendered = office.renderDesign(call, args.puml === undefined ? undefined : args.puml)
  const base = fmt('uiDesign.uiRenderOk', { p1: rendered.path, p2: rendered.bytes })
  if (rendered.pumlPath === undefined) return base
  return `${base}\n${fmt('uiDesign.uiRenderPuml', { p1: rendered.pumlPath, p2: rendered.pumlBytes ?? 0 })}`
}
