/**
 * 设计**适用性声明**（规格 §7.1）——需求阶段产出，设计阶段受它约束。
 *
 * 三条立场（§7.1 / §7.4 / §7.5，**逐条对应规格，不做别的事**）：
 *   ① **模型起草、用户签字绑定**：`focus` / `viewsPresent` / `viewsAbsent` / `artifacts`
 *      由模型写；`confirmed` 由**用户**签（`by` + `at` + `basis` 或所选选项原文）。
 *   ② **不做"性质 → 判据"的机械枚举映射** ✗：门禁只按声明逐视图 / 逐工件判真：
 *      `viewsPresent` 里的视图必须**非空**；`viewsAbsent` 里的视图判 **N/A + 该条理由**；
 *      未列入 `present` **也未说明** `absent` 的视图 → **判红**（必须显式二选一，§7.4）。
 *      未列入 `artifacts` 的工件**不要求**。
 *   ③ **不得静默**：声明要在注入块 + `sdo_design action=issues` + `docs/DESIGN.md`
 *      三处列出「哪些视图做、哪些不做及理由」——`applicabilityLines()` 是这三处共用的
 *      唯一渲染入口（避免三份各写各的）。
 *
 * 存量项目没有这份声明 → 本模块的 `applicabilityState()` 返回 `missing`，
 * 门禁判据据此判红并提示「未声明适用性」（§7.5，强制重新声明）。
 */
import type { Journal } from '../infra/journal.js'
import { pushShapeNote, recordListOf, recordOf, textListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import { APPLICABILITY_ARTIFACTS, APPLICABILITY_VIEW_KINDS, VIEW_KINDS } from '../types.js'
import type {
  ApplicabilityAbsentArtifact,
  ApplicabilityAbsentView,
  ApplicabilityArtifact,
  ApplicabilityConfirmation,
  ApplicabilityViewKind,
  DesignApplicability,
  ViewKind,
} from '../types.js'
import { fmt, t } from './i18n.js'
import { listMethodArtifacts } from './method.js'

/** 声明文件（`.sdo/design/applicability.yml`）。 */
export const APPLICABILITY_FILE = 'applicability.yml'

/** 视图的展示名（**走语言包**，不硬编码文案）。含第 6 个视图 `ui`。 */
export function viewLabel(kind: ApplicabilityViewKind): string {
  return t(`view.${kind}`)
}

/** 工件种类的展示名（**走语言包**）。 */
export function artifactLabel(kind: string): string {
  return t(`applicabilityArtifact.${kind}`)
}

/**
 * 读取声明原文并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/design/applicability.yml` 同样是手可编辑真源，声明里有**四个列表位置**
 * （`viewsPresent` / `viewsAbsent` / `artifacts` / `artifactsAbsent`，外加归一化时填入的
 * `ignoredViews` / `ignoredArtifacts`）：
 * 旧实现 `app.viewsPresent.includes` / `app.viewsAbsent.some` / `app.artifacts.includes`
 * 在手写成 `viewsPresent: component` 时抛 `… is not a function`。口径：
 *   · 标量写在列表位置 → **单元素列表**（意图明确）+ 提示；
 *   · 映射（少写了 `-`）→ **不猜**，按空 + 提示；
 *   · `viewsAbsent` / `artifactsAbsent` 的标量项 → `{kind: 文本, why: ''}`，`why` 为空会被既有判据判红
 *     （可读的失败，不是崩溃）。
 */
export function readApplicabilityChecked(
  store: SdoStore,
): { applicability: DesignApplicability | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ applicability: unknown }>('design', APPLICABILITY_FILE)?.applicability
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'applicability', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { applicability: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const present = textListOf(record.viewsPresent)
  pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'viewsPresent', present.issue)
  const absent = recordListOf<ApplicabilityAbsentView>(record.viewsAbsent, (text) => ({ kind: text as ApplicabilityViewKind, why: '' }))
  pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'viewsAbsent', absent.issue)
  const artifacts = textListOf(record.artifacts)
  pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'artifacts', artifacts.issue)
  // D5：`artifactsAbsent` 与 `viewsAbsent` **同形状**（`[{kind, why}]`）。
  // 标量项 → `{kind: 文本, why: ''}`：`why` 为空会被既有判据判红（可读的失败，不是崩溃）。
  const artifactsAbsent = recordListOf<ApplicabilityAbsentArtifact>(record.artifactsAbsent, (text) => ({
    kind: text as ApplicabilityArtifact,
    why: '',
  }))
  pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'artifactsAbsent', artifactsAbsent.issue)
  const ignored = record.ignoredViews === undefined ? undefined : textListOf(record.ignoredViews)
  if (ignored !== undefined) pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'ignoredViews', ignored.issue)
  const ignoredArtifacts = record.ignoredArtifacts === undefined ? undefined : textListOf(record.ignoredArtifacts)
  if (ignoredArtifacts !== undefined) {
    pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'ignoredArtifacts', ignoredArtifacts.issue)
  }
  const confirmedRaw = record.confirmed
  const confirmedMap = confirmedRaw === undefined || confirmedRaw === null ? undefined : recordOf(confirmedRaw)
  if (confirmedMap !== undefined) {
    pushShapeNote(notes, 'applicability', APPLICABILITY_FILE, 'confirmed', confirmedMap.issue)
  }
  const confirmation: ApplicabilityConfirmation | undefined = confirmedMap === undefined || confirmedMap.issue !== undefined
    ? undefined
    : {
        by: textOf(confirmedMap.value.by),
        at: textOf(confirmedMap.value.at),
        basis: textOf(confirmedMap.value.basis),
      }
  const applicability: DesignApplicability = {
    ...(record as unknown as DesignApplicability),
    focus: textOf(record.focus),
    viewsPresent: present.value as ApplicabilityViewKind[],
    viewsAbsent: absent.value.map((item) => ({ kind: textOf(item.kind) as ApplicabilityViewKind, why: textOf(item.why) })),
    artifacts: artifacts.value,
    artifactsAbsent: artifactsAbsent.value.map((item) => ({
      kind: textOf(item.kind) as ApplicabilityArtifact,
      why: textOf(item.why),
    })),
    draftedAt: textOf(record.draftedAt),
    updatedAt: textOf(record.updatedAt),
  }
  // 形状不对的 `ignoredViews` / `ignoredArtifacts` / `confirmed` 必须**清掉**
  // （不能让它以标量原样留在对象里）。
  // 用 `delete` 而不是赋 `undefined`：YAML 写入器不支持值为 undefined 的键。
  if (ignored === undefined) delete applicability.ignoredViews
  else applicability.ignoredViews = ignored.value
  if (ignoredArtifacts === undefined) delete applicability.ignoredArtifacts
  else applicability.ignoredArtifacts = ignoredArtifacts.value
  if (confirmation === undefined) delete applicability.confirmed
  else applicability.confirmed = confirmation
  return { applicability, notes }
}

/** 读取声明原文（形状已归一化；不存在返回 `undefined`）。 */
export function readApplicability(store: SdoStore): DesignApplicability | undefined {
  return readApplicabilityChecked(store).applicability
}

/** 适用性声明上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function applicabilityShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readApplicabilityChecked(store).notes
}

/**
 * 声明**起草入参**（模型/工具面）：宽松取值，由 `normalizeApplicability` 机械校验后归一。
 *
 * 为什么入参用 `string` 而不是 `ViewKind`：工具面是 JSON（`args.viewsAbsent` 是任意字符串），
 * 在边界上放宽、在归一函数里判真，才能对"写了非法视图名"给出可读回执而不是编译期沉默。
 */
export interface ApplicabilityDraftInput {
  focus: string
  viewsPresent?: string[] | undefined
  viewsAbsent?: { kind: string; why: string }[] | undefined
  artifacts?: string[] | undefined
  /** D5：声明**不做**的非视图工件（逐条必须带 why，与 `viewsAbsent` 同口径） */
  artifactsAbsent?: { kind: string; why: string }[] | undefined
  confirmed?: ApplicabilityConfirmation | undefined
  by?: string | undefined
}

/**
 * 规范化一份**模型起草**的声明：补齐空字段、去掉重复视图、
 * 并把「同一个视图既在 present 又在 absent」这种自相矛盾按**未说明**处理（门禁会判红）。
 *
 * 为什么在这里去掉重复而不是直接报错：声明是模型写的，重复多半是笔误；
 * 去重后仍保留"显式二选一"的硬要求 —— 门禁侧的判据不因此放松。
 *
 * **不认识的视图名一律记进 `ignoredViews`**（F-8）：旧实现直接丢弃，回执/注入块/DESIGN.md
 * 三处都不说 —— 调用方写了 `ui`（第 6 个视图）也以为声明进去了。现在由
 * `applicabilityState()` 把它逐条列成问题，C-2B 判红，静默丢弃的路被堵死。
 */
export function normalizeApplicability(input: ApplicabilityDraftInput): DesignApplicability {
  const present: ApplicabilityViewKind[] = []
  const ignoredViews: string[] = []
  for (const raw of input.viewsPresent ?? []) {
    if (isApplicabilityViewKind(raw)) {
      if (!present.includes(raw)) present.push(raw)
      continue
    }
    if (!ignoredViews.includes(raw)) ignoredViews.push(raw)
  }
  const absent: ApplicabilityAbsentView[] = []
  for (const item of input.viewsAbsent ?? []) {
    if (!isApplicabilityViewKind(item.kind)) {
      if (!ignoredViews.includes(item.kind)) ignoredViews.push(item.kind)
      continue
    }
    // 既列 present 又列 absent = 自相矛盾 → 两边都不算（门禁按"未说明"判红）
    if (present.includes(item.kind)) continue
    if (absent.some((existing) => existing.kind === item.kind)) continue
    absent.push({ kind: item.kind, why: (item.why ?? '').trim() })
  }
  const artifacts: string[] = []
  const ignoredArtifacts: string[] = []
  for (const raw of input.artifacts ?? []) {
    if (isApplicabilityArtifact(raw)) {
      if (!artifacts.includes(raw)) artifacts.push(raw)
      continue
    }
    if (!ignoredArtifacts.includes(raw)) ignoredArtifacts.push(raw)
  }
  // D5：不做清单与 `viewsAbsent` 完全同口径 —— 逐条给理由；既列"做"又列"不做" = 自相矛盾，两边都不算。
  const artifactsAbsent: ApplicabilityAbsentArtifact[] = []
  for (const item of input.artifactsAbsent ?? []) {
    if (!isApplicabilityArtifact(item.kind)) {
      if (!ignoredArtifacts.includes(item.kind)) ignoredArtifacts.push(item.kind)
      continue
    }
    if (artifacts.includes(item.kind)) continue
    if (artifactsAbsent.some((existing) => existing.kind === item.kind)) continue
    artifactsAbsent.push({ kind: item.kind, why: (item.why ?? '').trim() })
  }
  const now = new Date().toISOString()
  return {
    focus: input.focus.trim(),
    viewsPresent: present,
    viewsAbsent: absent,
    artifacts,
    artifactsAbsent,
    ...(ignoredViews.length === 0 ? {} : { ignoredViews }),
    ...(ignoredArtifacts.length === 0 ? {} : { ignoredArtifacts }),
    ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
    draftedAt: now,
    updatedAt: now,
  }
}

/** 五视图（C-20 / 设计元素落盘）。 */
export function isViewKind(value: string): value is ViewKind {
  return (VIEW_KINDS as readonly string[]).includes(value)
}

/** 适用性声明里的合法视图取值：五视图 + 界面视图 `ui`（第 6 个视图）。 */
export function isApplicabilityViewKind(value: string): value is ApplicabilityViewKind {
  return (APPLICABILITY_VIEW_KINDS as readonly string[]).includes(value)
}

export function isApplicabilityArtifact(value: string): value is ApplicabilityArtifact {
  return (APPLICABILITY_ARTIFACTS as readonly string[]).includes(value)
}

/** 起草（或覆盖）一份声明：落盘 + 留痕。**不**等于用户已签字。 */
export function draftApplicability(
  store: SdoStore,
  journal: Journal,
  input: ApplicabilityDraftInput,
): DesignApplicability {
  const existing = readApplicability(store)
  const normalized = normalizeApplicability(input)
  // 起草会**改声明内容** → 旧签字自动失效（§7.1「声明变了 → 签字自动失效」）
  const next: DesignApplicability = {
    ...normalized,
    draftedAt: existing?.draftedAt ?? normalized.draftedAt,
  }
  store.writeYaml(['design', APPLICABILITY_FILE], { applicability: next })
  const type = existing === undefined ? 'design/applicability-drafted' : 'design/applicability-updated'
  journal.append(type, {
    focus: next.focus,
    viewsPresent: next.viewsPresent,
    viewsAbsent: next.viewsAbsent.map((item) => item.kind),
    artifacts: next.artifacts,
    artifactsAbsent: next.artifactsAbsent.map((item) => item.kind),
    by: input.by ?? 'sdo',
  })
  return next
}

/**
 * 用户签字绑定这份声明（§7.1）。
 *
 * `basis` 是**用户原话或所选选项原文**：空 → 拒绝（不产生签字）。
 * 签字只覆盖**当前**声明内容；之后任何一次 `draftApplicability` 都会覆盖声明，
 * 于是旧的 `confirmed` 不再随声明落盘 → 签字自动失效（另加 journal 序号失效判定，
 * 见 `signature.ts`，两道保险都保留）。
 */
export function confirmApplicability(
  store: SdoStore,
  journal: Journal,
  basis: string,
  by: string,
): DesignApplicability | undefined {
  const current = readApplicability(store)
  if (current === undefined) return undefined
  const quoted = basis.trim()
  if (quoted === '') return undefined
  const confirmed: ApplicabilityConfirmation = {
    by: by.trim() === '' ? 'human' : by.trim(),
    at: new Date().toISOString(),
    basis: quoted,
  }
  const next: DesignApplicability = { ...current, confirmed, updatedAt: confirmed.at }
  store.writeYaml(['design', APPLICABILITY_FILE], { applicability: next })
  journal.append('design/applicability-confirmed', { by: confirmed.by, basis: confirmed.basis, at: confirmed.at })
  return next
}

/** 判读结果：缺失 / 有结构问题 / 可用。 */
export interface ApplicabilityState {
  status: 'missing' | 'incomplete' | 'ok'
  declaration?: DesignApplicability | undefined
  /** 结构问题（缺 focus、无视图声明的视图、absent 缺理由、artifacts 取值非法） */
  problems: string[]
}

/**
 * 声明的**结构**判读（不含"用户是否签字"——签字是独立判据，见 `signature.ts`）。
 *
 * 结构问题清单（每一条都对应 §7.1 / §7.4 的硬要求）：
 *   · 声明不存在 → `missing`（存量项目走这条，§7.5）；
 *   · `focus` 为空 → 没有说明本项目性质与设计重点；
 *   · 某个视图**既未列入 present 也未说明 absent** → 必须显式二选一；
 *   · `viewsAbsent` 条目 `why` 为空 → 不做的理由必须写出来给用户看。
 */
export function applicabilityState(store: SdoStore, app: DesignApplicability | undefined = readApplicability(store)): ApplicabilityState {
  if (app === undefined) return { status: 'missing', problems: [t('uiApplicability.missing')] }
  const problems: string[] = []
  if (textOf(app.focus).trim() === '') problems.push(t('uiApplicability.noFocus'))
  // F-8：不认识的视图名**不得静默丢弃** —— 原样报出来（此前 `ui` 就是这样消失的）。
  for (const raw of app.ignoredViews ?? []) problems.push(fmt('uiApplicability.viewIgnored', { p1: raw }))
  // D5：不认识的**工件名**同样不得静默丢弃（与视图同口径）。
  for (const raw of app.ignoredArtifacts ?? []) problems.push(fmt('uiApplicability.artifactIgnored', { p1: raw }))
  const artifactsAbsent = app.artifactsAbsent ?? []
  // M7：**同一个视图既 present 又 absent** = 声明自相矛盾。
  // 旧实现只查"两处都没写"与"absent 缺 why"，漏了这一条，于是矛盾声明结构判 ok、
  // C-2B 判绿，而 `viewRules` 静默按 present 展开 —— 读声明的人与门禁得到相反的方向。
  const both = VIEW_KINDS.filter(
    (kind) => app.viewsPresent.includes(kind) && app.viewsAbsent.some((item) => item.kind === kind),
  )
  for (const kind of both) problems.push(fmt('uiApplicability.viewBoth', { p1: viewLabel(kind) }))
  // "显式二选一"的硬要求只覆盖**五视图**：`ui` 是否适用由 `uiDecision`（需求真源）与 C-27 现算，
  // 声明里写或不写都不改变那条判据（与 `viewRules` 同一口径）。
  const undeclared = VIEW_KINDS.filter(
    (kind) => !app.viewsPresent.includes(kind) && !app.viewsAbsent.some((item) => item.kind === kind),
  )
  for (const kind of undeclared) problems.push(fmt('uiApplicability.viewUndeclared', { p1: viewLabel(kind) }))
  for (const item of app.viewsAbsent) {
    if (textOf(item.why).trim() === '') problems.push(fmt('uiApplicability.absentNoWhy', { p1: viewLabel(item.kind) }))
  }
  // D5：**非视图工件**的两条同口径检查 ——
  //   ① 既列 `artifacts`（做）又列 `artifactsAbsent`（不做）= 自相矛盾；
  //   ② `artifactsAbsent` 条目 `why` 为空 = "声明为不做却没写理由"（C-2C 也会逐条判红）。
  const artifactsBoth = (app.artifacts ?? []).filter((kind) =>
    artifactsAbsent.some((item) => item.kind === kind),
  )
  for (const kind of artifactsBoth) {
    problems.push(fmt('uiApplicability.artifactBoth', { p1: artifactLabel(kind) }))
  }
  for (const item of artifactsAbsent) {
    if (textOf(item.why).trim() === '') {
      problems.push(fmt('uiApplicability.artifactAbsentNoWhy', { p1: artifactLabel(item.kind) }))
    }
  }
  return { status: problems.length === 0 ? 'ok' : 'incomplete', declaration: app, problems }
}

/** 声明里的每条视图声明，展开成"门禁要判的东西"。 */
export interface ViewRule {
  kind: ViewKind
  /** present 的视图必须有内容；absent 的视图判 N/A + 理由 */
  state: 'present' | 'absent'
  /** absent 的理由（present 时为 ''） */
  why: string
  /** M7：同一份声明里既 present 又 absent（自相矛盾）—— 门禁据此判红，不静默取一个 */
  conflict?: boolean | undefined
}

/**
 * 把声明展开成逐视图规则（顺序按 `VIEW_KINDS`，便于回执稳定输出）。
 *
 * **只展开五视图**：`ui` 在声明里是「界面视图适用」的陈述，它是否齐备由 C-27 现算
 * （`uiDecision` + `uiConfirmation`），不在这里重复判一次（否则 C-20 会去五视图仓库里找 ui）。
 * 但"声明了却无人检查"是另一个洞 —— `design.views` 会另外比对声明里的 `ui` 与
 * `uiDecision`（Y-4），两侧口径因此不再分叉。
 *
 * M7：自相矛盾（既 present 又 absent）的视图**不再静默取 present** ——
 * 返回 `conflict: true`，`design.views` 据此判红（`applicabilityState` 也会报结构问题）。
 */
export function viewRules(app: DesignApplicability): ViewRule[] {
  const rules: ViewRule[] = []
  for (const kind of VIEW_KINDS) {
    const isPresent = app.viewsPresent.includes(kind)
    const absent = app.viewsAbsent.find((item) => item.kind === kind)
    if (isPresent && absent !== undefined) {
      rules.push({ kind, state: 'present', why: '', conflict: true })
      continue
    }
    if (isPresent) {
      rules.push({ kind, state: 'present', why: '' })
      continue
    }
    if (absent !== undefined) rules.push({ kind, state: 'absent', why: absent.why })
  }
  return rules
}

/** 声明的必需工件（去重、按 `APPLICABILITY_ARTIFACTS` 规范序）。 */
export function requiredArtifacts(app: DesignApplicability): string[] {
  return APPLICABILITY_ARTIFACTS.filter((kind) => app.artifacts.includes(kind))
}

/** 声明为**不做**的工件及其理由（D5；按规范序，便于回执稳定输出）。 */
export function absentArtifacts(app: DesignApplicability): ApplicabilityAbsentArtifact[] {
  return APPLICABILITY_ARTIFACTS.flatMap((kind) => {
    const item = (app.artifactsAbsent ?? []).find((candidate) => candidate.kind === kind)
    return item === undefined ? [] : [item]
  })
}

/**
 * 声明给用户看的**唯一**渲染入口（注入块 / `sdo_design action=issues` / `docs/DESIGN.md` 三处共用）。
 *
 * 三处必须一致，否则"不得静默"就变成三份各说各话（§7.1）。
 */
export function applicabilityLines(app: DesignApplicability | undefined): string[] {
  if (app === undefined) return [t('uiApplicability.missing')]
  const lines: string[] = [fmt('uiApplicability.focusLine', { p1: app.focus })]
  const present = app.viewsPresent.map((kind) => viewLabel(kind))
  lines.push(present.length === 0
    ? t('uiApplicability.noPresent')
    : fmt('uiApplicability.presentLine', { p1: present.join(t('uiApplicability.listSep')) }))
  for (const item of app.viewsAbsent) {
    lines.push(fmt('uiApplicability.absentLine', { p1: viewLabel(item.kind), p2: item.why }))
  }
  const artifacts = requiredArtifacts(app).map((kind) => artifactLabel(kind))
  lines.push(artifacts.length === 0
    ? t('uiApplicability.noArtifacts')
    : fmt('uiApplicability.artifactsLine', { p1: artifacts.join(t('uiApplicability.listSep')) }))
  // D5：**不做的工件也必须让用户看见理由** —— 与 `viewsAbsent` 同一条纪律（不得静默）。
  for (const item of absentArtifacts(app)) {
    lines.push(fmt('uiApplicability.artifactAbsentLine', { p1: artifactLabel(item.kind), p2: item.why }))
  }
  lines.push(app.confirmed === undefined
    ? t('uiApplicability.notConfirmed')
    : fmt('uiApplicability.confirmedLine', { p1: app.confirmed.by, p2: app.confirmed.basis }))
  return lines
}

/** 声明的确认戳是否**结构完整**（有 by / at / basis 非空）。缺 `basis` 视为未确认。 */
export function confirmationComplete(confirmed: ApplicabilityConfirmation | undefined): boolean {
  if (confirmed === undefined) return false
  return textOf(confirmed.by).trim() !== '' && textOf(confirmed.at).trim() !== '' && textOf(confirmed.basis).trim() !== ''
}

/**
 * 一个声明的非视图工件**是否齐备**（§7.1「`artifacts` 里的工件必须齐备」）。
 *
 * 机械判据（只看真源文件，不采信模型自述）：
 *   · `invariants` → 清单非空，**且每条 `verify` 非空**；
 *   · `mapping`    → 映射非空，且每条 `from` / `to` / `rewrite` 非空；
 *   · `diffVerify` → 策略存在，且 `sameInputSameOutput` 与 `baselineSource` 非空。
 *
 * 返回未齐备的工件种类（空数组 = 齐备）。`porting` 包的**同类**检查更严（还查替代方案、
 * 模块引用真实性、基线来源取值），两条判据各自独立成立、互不放松。
 */
export function missingArtifacts(app: DesignApplicability, store: SdoStore): string[] {
  const missing: string[] = []
  const required = requiredArtifacts(app)
  if (required.length === 0) return missing
  const artifacts = new Map(listMethodArtifacts(store).map((artifact) => [artifact.kind, artifact]))
  for (const kind of required) {
    const artifact = artifacts.get(kind as never)
    if (kind === 'invariants') {
      const items = artifact?.invariants ?? []
      if (items.length === 0 || items.some((item) => textOf(item.verify).trim() === '')) missing.push(kind)
      continue
    }
    if (kind === 'mapping') {
      const entries = artifact?.mappings ?? []
      const incomplete = entries.some(
        (entry) => textOf(entry.from).trim() === '' || textOf(entry.to).trim() === '' || textOf(entry.rewrite).trim() === '',
      )
      if (entries.length === 0 || incomplete) missing.push(kind)
      continue
    }
    if (kind === 'diffVerify') {
      const strategy = artifact?.diffVerify
      if (strategy === undefined || textOf(strategy.sameInputSameOutput).trim() === '' || textOf(strategy.baselineSource).trim() === '') {
        missing.push(kind)
      }
    }
  }
  return missing
}
