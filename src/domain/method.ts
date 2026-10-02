/**
 * 设计方法论**方法包**（增量 2）：结构化 / 面向对象 / 敏捷-演进式。
 *
 * 三个立场（规格 §1 / §2 / §4）：
 *   ① **选择**复用既有的 `design:method` 问题账本（`METHOD_TARGET`），不另造一套问答；
 *      答案必须能**机械解析**成 `structured|oo|evolutionary|none`（可多选），
 *      解析不出来就是失败 —— 不允许"不选方法就全 N/A 蒙过去"。
 *   ② **最小必产项**卡门禁，其余产物只是建议；未选中的包一律 **N/A + 理由**（三态口径）。
 *   ③ 检查器**机械**：只读真源（账本 + 产物文件 + 需求 + 设计元素），
 *      不采信模型自述、不"查不到就算过" —— 产物缺了就失败。
 *
 * 落盘形态照 `architecture.ts` 的先例：**一个种类一个文件**（`.sdo/design/method-<kind>.yml`），
 * 内容是 `{ artifact: MethodArtifact }`；选择快照落在 `.sdo/design/method.yml`（`{ method: … }`）。
 * 门禁**现算**：每次都从问题账本重新解析，快照只供查询与渲染。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { nextId } from '../infra/ids.js'
import { boolField, pushShapeNote, recordListOf, recordOf, textListOf, textMapOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { DIFF_BASELINE_SOURCES, METHOD_ARTIFACT_KINDS, METHOD_CHOICES, METHOD_IDS } from '../types.js'
import type {
  DataDictionaryItem,
  DebtItem,
  DesignElement,
  DesignIncrement,
  DfdFlow,
  DfdLevel,
  DfdProcess,
  ErdEntity,
  ErdRelation,
  GrillQuestion,
  InvariantItem,
  LayerRules,
  MappingAlternative,
  MappingEntry,
  MethodArtifact,
  MethodArtifactKind,
  MethodChoice,
  MethodId,
  MethodSnapshot,
  OoType,
  Requirement,
  RequirementKind,
  ReversibilityItem,
  SequenceMessage,
  SequenceSpec,
} from '../types.js'
import { listElements } from './architecture.js'
import { readQuestion } from './grill.js'
import { isEffectivelyOpen } from './dor.js'
import { fmt, t } from './i18n.js'

/** 方法论选择题的目标标记（复用增量 1 已有的问题，不另造）。 */
export const METHOD_TARGET = 'design:method'

// —————————————————————— 选择：账本 → 机械解析 ——————————————————————

/**
 * 方法答案里的关键词别名（**走语言包**，不硬编码文案）。
 *
 * 为什么要别名：用户/模型用自然语言回答（"结构化 + 面向对象"）必须能解析；
 * 而 `oo` 这种两位标识符只能**整词**匹配，否则 `look` 里的 `oo` 会被误判。
 */
function methodAliases(): { id: MethodChoice; words: string[] }[] {
  const split = (value: string): string[] =>
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== '')
  return [
    { id: 'structured', words: ['structured', ...split(t('uiMethod.aliasStructured'))] },
    { id: 'oo', words: ['oo', ...split(t('uiMethod.aliasOo'))] },
    { id: 'evolutionary', words: ['evolutionary', ...split(t('uiMethod.aliasEvolutionary'))] },
    // `porting`：移植 / 迁移 —— 核心是映射 + 不变量 + 差分（§7.3）
    { id: 'porting', words: ['porting', ...split(t('uiMethod.aliasPorting'))] },
    // `none` 只在**显式**选择"不做方法产物"时合法（规格 §2 第 3 条）
    { id: 'none', words: ['none', ...split(t('uiMethod.aliasNone'))] },
  ]
}

/**
 * 解析方法答案：返回规范化取值列表；**解析不出来返回 `undefined`**。
 *
 * 规则：
 *   · `none` 与其他包同时出现 = 自相矛盾 → `undefined`（非法，判失败）；
 *   · 空答案 → `undefined`；
 *   · 英文别名 ≥5 字符按子串匹配（`object-oriented`），≤4 字符按整词匹配（`oo` / `none`）。
 */
export function parseMethodChoice(raw: string | null | undefined): MethodChoice[] | undefined {
  const text = (raw ?? '').trim().toLowerCase()
  if (text === '') return undefined
  const tokens = text.split(/[^a-z0-9]+/u)
  const found = new Set<MethodChoice>()
  for (const alias of methodAliases()) {
    for (const word of alias.words) {
      if (word === '') continue
      const wholeWord = /^[a-z0-9]+$/u.test(word) && word.length <= 4
      if (wholeWord ? tokens.includes(word) : text.includes(word)) found.add(alias.id)
    }
  }
  if (found.size === 0) return undefined
  if (found.has('none') && found.size > 1) return undefined
  return METHOD_CHOICES.filter((choice) => found.has(choice))
}

/**
 * 一个设计问题是否"未决"。
 *
 * **R-5**：这里曾手抄第三份实现（注释自称"与 design.ts 同一口径"，但没有任何机制保证）——
 * 而 N-1/P-6 的成因正是"同一概念多份手抄"。现在直接复用 `dor.isEffectivelyOpen`
 * （它只依赖 `types.ts` 与 `infra/scalar.ts`，**不构成循环依赖**，这也正是当初手抄的理由）。
 */
function isOpen(question: GrillQuestion): boolean {
  return isEffectivelyOpen(question)
}

/** 全部设计/需求问题（只读账本；不 import `design.ts`，避免循环依赖）。 */
function designQuestions(store: SdoStore): GrillQuestion[] {
  const out: GrillQuestion[] = []
  for (const name of store.listNames('questions')) {
    if (!/^Q-\d+\.yml$/u.test(name)) continue
    const question = readQuestion(store, name.replace(/\.yml$/u, ''))
    if (question === undefined) continue
    // **2026-09-30 时机迁移（§7.2 第 3 条）**：方法论选择题从设计阶段移到**需求阶段**，
    // 问题的 `origin` 随之变成 `requirements`。判定只看 `targets`，**不看 origin** ——
    // 否则迁移后门禁会读不到答案，判据形同虚设。
    if (question.origin === 'design' || question.origin === 'requirements') out.push(question)
  }
  return out
}

/** 方法论选择题（`design.method-selected` 判据用）。 */
export function methodQuestion(store: SdoStore): GrillQuestion | undefined {
  return designQuestions(store).find((question) => question.targets.includes(METHOD_TARGET))
}

/** 选择结果的机械解析（`missing` 未回答 / `invalid` 无法解析 / `none` 显式不做 / `chosen` 已选）。 */
export interface MethodSelection {
  questionId?: string | undefined
  /** 账本上的答案原文 */
  raw: string
  status: 'missing' | 'invalid' | 'none' | 'chosen'
  methods: MethodId[]
  /** 人读理由（回执与文档都用它） */
  reason: string
}

/** 现算：从问题账本读出「本项目启用了哪些方法包」。 */
export function methodSelection(store: SdoStore): MethodSelection {
  const question = methodQuestion(store)
  if (question === undefined) {
    return { raw: '', status: 'missing', methods: [], reason: t('uiMethod.selectionMissing') }
  }
  const raw = textOf(question.answer).trim()
  if (isOpen(question)) {
    return {
      questionId: question.id,
      raw,
      status: 'missing',
      methods: [],
      reason: fmt('uiMethod.selectionUnanswered', { p1: question.id }),
    }
  }
  const parsed = parseMethodChoice(raw)
  if (parsed === undefined) {
    return {
      questionId: question.id,
      raw,
      status: 'invalid',
      methods: [],
      reason: fmt('uiMethod.selectionInvalid', { p1: raw === '' ? t('uiMethod.selectionEmpty') : raw }),
    }
  }
  if (parsed.length === 1 && parsed[0] === 'none') {
    return { questionId: question.id, raw, status: 'none', methods: [], reason: t('uiMethod.selectionNone') }
  }
  const methods = METHOD_IDS.filter((id) => parsed.includes(id))
  return {
    questionId: question.id,
    raw,
    status: 'chosen',
    methods,
    reason: fmt('uiMethod.selectionChosen', { p1: methods.join(' + ') }),
  }
}

// —————————————————————— 选择快照（可查；门禁仍现算） ——————————————————————

/**
 * 按账本刷新「本项目启用了哪些方法」快照并留 journal 事件。
 *
 * **返回 undefined = 答案缺失/非法**：这时快照保持旧值不动（门禁从账本现算，不受快照影响）。
 */
export function refreshMethodSnapshot(store: SdoStore, journal: Journal): MethodSnapshot | undefined {
  const selection = methodSelection(store)
  if (selection.status === 'missing' || selection.status === 'invalid') return undefined
  const snapshot: MethodSnapshot = {
    question: selection.questionId ?? '',
    answer: selection.raw,
    status: selection.status === 'none' ? 'none' : 'chosen',
    methods: selection.methods,
    updatedAt: new Date().toISOString(),
  }
  store.writeYaml(['design', 'method.yml'], { method: snapshot })
  journal.append('design/method-selected', {
    question: snapshot.question,
    answer: snapshot.answer,
    methods: snapshot.methods,
    status: snapshot.status,
  })
  return snapshot
}

// —————————————————————— 方法产物：一个种类一个文件 ——————————————————————

export function isMethodArtifactKind(value: string): value is MethodArtifactKind {
  return (METHOD_ARTIFACT_KINDS as readonly string[]).includes(value)
}

/**
 * 把一条记录里的字符串字段与列表字段归一化（F-21 ① 的嵌套层）。
 *
 * 为什么需要：方法产物的条目里也有列表（`collaborators` / `requires` / `participants` …），
 * 它们同样可能被手写成标量 —— 例如 `collaborators: repo` 会让
 * `checkTypes` 的 `type.collaborators.includes(...)` 抛 `includes is not a function`。
 * 列表位置的口径与顶层一致（标量→单元素 + 提示；映射→空 + 提示）。
 */
function normalizeRow<T extends Record<string, unknown>>(
  row: T,
  holder: string,
  index: number,
  listFields: readonly string[],
  notes: FieldShapeNote[],
  artifactId: string,
): T {
  const out: Record<string, unknown> = { ...row }
  for (const key of listFields) {
    const value = row[key]
    if (value === undefined || value === null) continue
    const read = textListOf(value)
    pushShapeNote(notes, 'methodArtifact', artifactId, `${holder}[${index}].${key}`, read.issue)
    out[key] = read.value
  }
  if (out['id'] !== undefined) out['id'] = textOf(out['id'])
  return out as T
}

/** 归一化一条记录列表字段（顶层）。 */
function normalizeRowList<T>(
  record: Record<string, unknown>,
  field: string,
  fromScalar: (text: string) => T,
  notes: FieldShapeNote[],
  artifactId: string,
): T[] | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  const read = recordListOf<T>(value, fromScalar)
  pushShapeNote(notes, 'methodArtifact', artifactId, field, read.issue)
  return read.value
}

/** 归一化可选的字符串列表字段（顶层）。 */
function normalizeStringList(
  record: Record<string, unknown>,
  field: string,
  notes: FieldShapeNote[],
  artifactId: string,
): string[] | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  const read = textListOf(value)
  pushShapeNote(notes, 'methodArtifact', artifactId, field, read.issue)
  return read.value
}

/**
 * 一份方法产物的**读取边界归一化**（F-21 ①）。
 *
 * `.sdo/design/method-*.yml` 是手可编辑真源，产物正文里有大量列表位置
 * （`dictionary` / `levels` / `entities` / `relations` / `types` / `sequences` /
 * `debts` / `decisions` / `increments` / `mappings` / `invariants`，以及条目里的
 * `collaborators` / `requires` / `participants` / `messages` / `layers` / `allowed` …）
 * 与两个映射位置（`rules` / `diffVerify`）。旧实现直接 `.map` / `.flatMap` / `.some`，
 * 手写漏一对 `[]` 就抛异常。这里逐字段收敛形状，并把每个形状问题收成提示。
 */
function normalizeMethodArtifact(
  raw: unknown,
  kind: MethodArtifactKind,
  fallbackId: string,
  notes: FieldShapeNote[],
): MethodArtifact | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'methodArtifact', fallbackId, 'artifact', {
        position: 'map',
        actualType: typeNameOf(raw),
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return undefined
  }
  const record = raw as Record<string, unknown>
  const declaredId = textOf(record.id)
  const id = declaredId.trim() === '' ? fallbackId : declaredId
  const artifact: MethodArtifact = {
    ...(record as unknown as MethodArtifact),
    id,
    kind,
    summary: textOf(record.summary),
    updatedAt: textOf(record.updatedAt),
  }
  // 所有容器位置先**清掉**：正文里写成标量/映射时，不能让原值从 spread 里漏过去
  // （例如 `rules: none` 会让 `artifact.rules.allowed` 抛异常）。
  // 用 `delete` 而不是赋 `undefined`：YAML 写入器不支持值为 undefined 的键。
  for (const field of [
    'requires',
    'dictionary',
    'levels',
    'entities',
    'relations',
    'types',
    'sequences',
    'rules',
    'debts',
    'decisions',
    'increments',
    'mappings',
    'invariants',
    'diffVerify',
  ] as const) {
    delete artifact[field]
  }
  const requires = normalizeStringList(record, 'requires', notes, id)
  if (requires !== undefined) artifact.requires = requires

  const dictionary = normalizeRowList<DataDictionaryItem>(
    record,
    'dictionary',
    (text) => ({ name: text, type: '', source: '', sink: '', validation: '' }),
    notes,
    id,
  )
  if (dictionary !== undefined) {
    artifact.dictionary = dictionary.map((item, index) =>
      normalizeRow({ ...item, name: textOf(item.name), type: textOf(item.type), source: textOf(item.source), sink: textOf(item.sink), validation: textOf(item.validation) }, 'dictionary', index, ['requires'], notes, id),
    )
  }

  const levels = normalizeRowList<DfdLevel>(
    record,
    'levels',
    (text) => ({ level: 0, name: text, flows: [], processes: [] }),
    notes,
    id,
  )
  if (levels !== undefined) {
    artifact.levels = levels.map((level, index) => {
      const normalized = normalizeRow({ ...level, name: textOf(level.name) }, 'levels', index, [], notes, id)
      const flows = level.flows === undefined ? undefined : (() => {
        const read = recordListOf<DfdFlow>(level.flows, (text) => ({ name: text, from: '', to: '' }))
        pushShapeNote(notes, 'methodArtifact', id, `levels[${index}].flows`, read.issue)
        return read.value.map((flow) => ({ name: textOf(flow.name), from: textOf(flow.from), to: textOf(flow.to) }))
      })()
      const internalFlows = level.internalFlows === undefined ? undefined : (() => {
        const read = recordListOf<DfdFlow>(level.internalFlows, (text) => ({ name: text, from: '', to: '' }))
        pushShapeNote(notes, 'methodArtifact', id, `levels[${index}].internalFlows`, read.issue)
        return read.value.map((flow) => ({ name: textOf(flow.name), from: textOf(flow.from), to: textOf(flow.to) }))
      })()
      const processes = (() => {
        const value = level.processes
        const read = recordListOf<DfdProcess>(value, (text) => ({ name: text, inputs: [], outputs: [] }))
        pushShapeNote(notes, 'methodArtifact', id, `levels[${index}].processes`, read.issue)
        return read.value.map((process, processIndex) =>
          normalizeRow({ ...process, name: textOf(process.name) }, `levels[${index}].processes`, processIndex, ['inputs', 'outputs', 'requires'], notes, id),
        )
      })()
      return { ...normalized, flows: flows ?? [], processes, ...(internalFlows === undefined ? {} : { internalFlows }) }
    })
  }

  const entities = normalizeRowList<ErdEntity>(record, 'entities', (text) => ({ name: text, identifier: '' }), notes, id)
  if (entities !== undefined) {
    artifact.entities = entities.map((entity, index) =>
      normalizeRow({ ...entity, name: textOf(entity.name), identifier: textOf(entity.identifier) }, 'entities', index, ['attributes', 'requires'], notes, id),
    )
  }

  const relations = normalizeRowList<ErdRelation>(
    record,
    'relations',
    (text) => ({ name: text, from: '', to: '', cardinality: '' }),
    notes,
    id,
  )
  if (relations !== undefined) {
    artifact.relations = relations.map((relation) => ({
      ...relation,
      name: textOf(relation.name),
      from: textOf(relation.from),
      to: textOf(relation.to),
      cardinality: textOf(relation.cardinality),
    }))
  }

  const types = normalizeRowList<OoType>(
    record,
    'types',
    (text) => ({ name: text, kind: 'class', layer: '', responsibility: '', collaborators: [] }),
    notes,
    id,
  )
  if (types !== undefined) {
    artifact.types = types.map((type, index) => {
      const row = normalizeRow(
        { ...type, name: textOf(type.name), layer: textOf(type.layer), responsibility: textOf(type.responsibility) },
        'types',
        index,
        ['collaborators', 'data', 'requires'],
        notes,
        id,
      ) as OoType & Record<string, unknown>
      // F-14 的 `leaf` 是布尔位置：只有 `true` 才算"显式声明为叶子"（`leaf: yes` 不得静默豁免）；
      // 非布尔 → 按未声明处理 + 提示（该类型照旧要求协作方，判据不放松）
      const leaf = boolField(type.leaf)
      pushShapeNote(notes, 'methodArtifact', id, `types[${index}].leaf`, leaf.issue)
      if (leaf.value === true) row.leaf = true
      else delete row.leaf
      return row
    })
  }

  const sequences = normalizeRowList<SequenceSpec>(
    record,
    'sequences',
    (text) => ({ name: text, participants: [], messages: [] }),
    notes,
    id,
  )
  if (sequences !== undefined) {
    artifact.sequences = sequences.map((sequence, index) => {
      const normalized = normalizeRow(
        { ...sequence, name: textOf(sequence.name), requirement: sequence.requirement === undefined ? undefined : textOf(sequence.requirement) },
        'sequences',
        index,
        ['participants', 'requires'],
        notes,
        id,
      )
      const read = recordListOf<SequenceMessage>(sequence.messages, (text) => ({ name: text, from: '', to: '', trigger: '' }))
      pushShapeNote(notes, 'methodArtifact', id, `sequences[${index}].messages`, read.issue)
      const messages = read.value.map((message) => ({
        name: textOf(message.name),
        from: textOf(message.from),
        to: textOf(message.to),
        trigger: textOf(message.trigger),
      }))
      return { ...normalized, messages }
    })
  }

  const rulesRaw = record.rules
  if (rulesRaw !== undefined && rulesRaw !== null) {
    const rules = recordOf(rulesRaw)
    pushShapeNote(notes, 'methodArtifact', id, 'rules', rules.issue)
    if (rules.issue === undefined) {
      const layers = textListOf(rules.value['layers'])
      pushShapeNote(notes, 'methodArtifact', id, 'rules.layers', layers.issue)
      const assignments = textMapOf(rules.value['assignments'])
      pushShapeNote(notes, 'methodArtifact', id, 'rules.assignments', assignments.issue)
      const allowedRead = recordListOf<{ from: string; to: string }>(rules.value['allowed'], (text) => ({ from: text, to: '' }))
      pushShapeNote(notes, 'methodArtifact', id, 'rules.allowed', allowedRead.issue)
      const rulesRequires = normalizeStringList(rules.value, 'requires', notes, id)
      artifact.rules = {
        layers: layers.value,
        assignments: assignments.value,
        allowed: allowedRead.value.map((rule) => ({ from: textOf(rule.from), to: textOf(rule.to) })),
        ...(rulesRequires === undefined ? {} : { requires: rulesRequires }),
      }
    }
  }

  const debts = normalizeRowList<DebtItem>(
    record,
    'debts',
    (text) => ({ title: text, type: 'design', impact: '', trigger: '', plan: '' }),
    notes,
    id,
  )
  if (debts !== undefined) {
    artifact.debts = debts.map((debt, index) =>
      normalizeRow(
        { ...debt, title: textOf(debt.title), impact: textOf(debt.impact), trigger: textOf(debt.trigger), plan: textOf(debt.plan) },
        'debts',
        index,
        ['requires'],
        notes,
        id,
      ),
    )
  }

  const decisions = normalizeRowList<ReversibilityItem>(
    record,
    'decisions',
    (text) => ({ decision: text, grade: 'reversible' }),
    notes,
    id,
  )
  if (decisions !== undefined) {
    artifact.decisions = decisions.map((decision, index) =>
      normalizeRow(
        { ...decision, decision: textOf(decision.decision), whyNow: decision.whyNow === undefined ? undefined : textOf(decision.whyNow) },
        'decisions',
        index,
        ['requires'],
        notes,
        id,
      ),
    )
  }

  const increments = normalizeRowList<DesignIncrement>(
    record,
    'increments',
    (text) => ({ iteration: text, elements: [], note: '' }),
    notes,
    id,
  )
  if (increments !== undefined) {
    artifact.increments = increments.map((increment, index) =>
      normalizeRow(
        { ...increment, iteration: textOf(increment.iteration), note: textOf(increment.note) },
        'increments',
        index,
        ['elements', 'requires'],
        notes,
        id,
      ),
    )
  }

  const mappings = normalizeRowList<MappingEntry>(record, 'mappings', (text) => ({ from: text, to: '', rewrite: '' }), notes, id)
  if (mappings !== undefined) {
    artifact.mappings = mappings.map((entry, index) => {
      const normalized = normalizeRow(
        { ...entry, from: textOf(entry.from), to: textOf(entry.to), rewrite: textOf(entry.rewrite) },
        'mappings',
        index,
        ['requires'],
        notes,
        id,
      )
      if (entry.alternatives === undefined) return normalized
      const read = recordListOf<MappingAlternative>(entry.alternatives, (text) => ({ option: text, rejectedBecause: '' }))
      pushShapeNote(notes, 'methodArtifact', id, `mappings[${index}].alternatives`, read.issue)
      return {
        ...normalized,
        alternatives: read.value.map((alternative) => ({
          option: textOf(alternative.option),
          rejectedBecause: textOf(alternative.rejectedBecause),
        })),
      }
    })
  }

  const invariants = normalizeRowList<InvariantItem>(
    record,
    'invariants',
    (text) => ({ statement: text, category: 'behaviour', verify: '' }),
    notes,
    id,
  )
  if (invariants !== undefined) {
    artifact.invariants = invariants.map((item, index) =>
      normalizeRow({ ...item, statement: textOf(item.statement), verify: textOf(item.verify) }, 'invariants', index, ['requires'], notes, id),
    )
  }

  const diffRaw = record.diffVerify
  if (diffRaw !== undefined && diffRaw !== null) {
    const diff = recordOf(diffRaw)
    pushShapeNote(notes, 'methodArtifact', id, 'diffVerify', diff.issue)
    if (diff.issue === undefined) {
      artifact.diffVerify = {
        sameInputSameOutput: textOf(diff.value['sameInputSameOutput']),
        baselineSource: textOf(diff.value['baselineSource']),
        baselineRef: textOf(diff.value['baselineRef']),
        ...(diff.value['controlRepo'] === undefined ? {} : { controlRepo: textOf(diff.value['controlRepo']) }),
      }
    }
  }

  return artifact
}

/** 读一份方法产物 + 它的形状提示（F-21）。 */
export function readMethodArtifactChecked(
  store: SdoStore,
  kind: MethodArtifactKind,
): { artifact: MethodArtifact | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ artifact: unknown }>('design', `method-${kind}.yml`)?.artifact
  return { artifact: normalizeMethodArtifact(raw, kind, `method-${kind}`, notes), notes }
}

export function readMethodArtifact(store: SdoStore, kind: MethodArtifactKind): MethodArtifact | undefined {
  return readMethodArtifactChecked(store, kind).artifact
}

/**
 * 读方法快照并**做形状归一化**：`methods` 是列表位置（`selection.methods.includes` 会用到）。
 */
export function readMethodSnapshotChecked(
  store: SdoStore,
): { snapshot: MethodSnapshot | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ method: unknown }>('design', 'method.yml')?.method
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'method', 'method', 'method', {
        position: 'map',
        actualType: typeNameOf(raw),
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { snapshot: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const methods = textListOf(record.methods)
  pushShapeNote(notes, 'method', 'method', 'methods', methods.issue)
  const snapshot: MethodSnapshot = {
    ...(record as unknown as MethodSnapshot),
    question: textOf(record.question),
    answer: textOf(record.answer),
    status: textOf(record.status) as MethodSnapshot['status'],
    methods: methods.value as MethodId[],
    updatedAt: textOf(record.updatedAt),
  }
  return { snapshot, notes }
}

/** 方法快照（形状已归一化）。 */
export function readMethodSnapshot(store: SdoStore): MethodSnapshot | undefined {
  return readMethodSnapshotChecked(store).snapshot
}

/** 全部方法产物 + 快照上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function methodShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const kind of METHOD_ARTIFACT_KINDS) notes.push(...readMethodArtifactChecked(store, kind).notes)
  notes.push(...readMethodSnapshotChecked(store).notes)
  return notes
}

/** 已存在的全部方法产物（按种类固定顺序）。 */
export function listMethodArtifacts(store: SdoStore): MethodArtifact[] {
  const out: MethodArtifact[] = []
  for (const kind of METHOD_ARTIFACT_KINDS) {
    const artifact = readMethodArtifact(store, kind)
    if (artifact !== undefined) out.push(artifact)
  }
  return out
}

/** 一份产物里有多少条条目（回执与文档的行数）。 */
export function artifactEntryCount(artifact: MethodArtifact): number {
  return (
    (artifact.dictionary?.length ?? 0)
    + (artifact.levels?.reduce((sum, level) => sum + level.processes.length, 0) ?? 0)
    + (artifact.entities?.length ?? 0)
    + (artifact.relations?.length ?? 0)
    + (artifact.types?.length ?? 0)
    + (artifact.sequences?.length ?? 0)
    + (artifact.rules === undefined ? 0 : artifact.rules.allowed.length)
    + (artifact.debts?.length ?? 0)
    + (artifact.decisions?.length ?? 0)
    + (artifact.increments?.length ?? 0)
    + (artifact.mappings?.length ?? 0)
    + (artifact.invariants?.length ?? 0)
    + (artifact.diffVerify === undefined ? 0 : 1)
  )
}

/** 全部方法产物条目 id（自动编号时保证全局唯一）。 */
function usedEntryIds(store: SdoStore): string[] {
  const ids: string[] = []
  for (const artifact of listMethodArtifacts(store)) {
    for (const id of entryIds(artifact)) if (id !== undefined) ids.push(id)
  }
  return ids
}

function entryIds(artifact: MethodArtifact): (string | undefined)[] {
  return [
    ...(artifact.dictionary ?? []).map((item) => item.id),
    ...(artifact.levels ?? []).flatMap((level) => level.processes.map((process) => process.id)),
    ...(artifact.entities ?? []).map((entity) => entity.id),
    ...(artifact.relations ?? []).map((relation) => relation.id),
    ...(artifact.types ?? []).map((type) => type.id),
    ...(artifact.sequences ?? []).map((sequence) => sequence.id),
    ...(artifact.debts ?? []).map((debt) => debt.id),
    ...(artifact.decisions ?? []).map((decision) => decision.id),
    ...(artifact.increments ?? []).map((increment) => increment.id),
    ...(artifact.mappings ?? []).map((entry) => entry.id),
    ...(artifact.invariants ?? []).map((item) => item.id),
  ]
}

/** 写入一份产物时允许给出的字段（id/kind/updatedAt 由本模块分配）。 */
export type MethodArtifactInput = Partial<Omit<MethodArtifact, 'id' | 'kind' | 'updatedAt'>>

function assignIds<T extends { id?: string | undefined; name?: string | undefined }>(
  items: T[] | undefined,
  prefix: string,
  used: string[],
  /** **F-6**：该 kind 盘上已有条目的 `name → id`（未声明 id 时按 name 复用，避免重写即漂移） */
  known: Map<string, string> = new Map(),
): (T & { id: string })[] | undefined {
  if (items === undefined) return undefined
  return items.map((item) => {
    const declared = textOf(item.id).trim()
    if (declared !== '') {
      used.push(declared)
      return { ...item, id: declared }
    }
    // **F-6（sdo-test 回归报告，minor）**：旧实现只按 `usedEntryIds` 往后发号 ——
    // 同一份产物**重写一次就换一批 id**（PROC-001…→PROC-007…），于是此前建的追溯边全部悬空。
    // 现在：没声明 id 时**先按 name 复用盘上已有条目的 id**，复用不到才发新号。
    const name = textOf((item as { name?: unknown }).name).trim()
    const reused = name === '' ? undefined : known.get(name)
    const id = reused ?? nextId(prefix, used)
    used.push(id)
    return { ...item, id }
  })
}

/** 从盘上已有产物里建某类条目的 `name → id` 索引（F-6 复用用）。 */
function knownIdsByName(current: object | undefined, field: string): Map<string, string> {
  const out = new Map<string, string>()
  const list = (current as Record<string, unknown> | undefined)?.[field]
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { id?: unknown; name?: string | undefined }
    const name = textOf(record.name).trim()
    const id = textOf(record.id).trim()
    if (name !== '' && id !== '' && !out.has(name)) out.set(name, id)
  }
  return out
}

function normalizeLevels(levels: DfdLevel[] | undefined, used: string[], known: Map<string, string> = new Map()): DfdLevel[] | undefined {
  if (levels === undefined) return undefined
  return levels.map((level) => ({
    ...level,
    flows: level.flows ?? [],
    internalFlows: level.internalFlows ?? [],
    processes: (level.processes ?? []).map((process: DfdProcess) => {
      const declared = textOf(process.id).trim()
      if (declared !== '') {
        used.push(declared)
        return { ...process, id: declared, inputs: process.inputs ?? [], outputs: process.outputs ?? [] }
      }
      // **F-6**：DFD 的 `PROC-*` 走的是这里（不是 `assignIds`）——同样按 name 复用既有 id
      const name = textOf(process.name).trim()
      const id = (name === '' ? undefined : known.get(name)) ?? nextId('PROC', used)
      used.push(id)
      return { ...process, id, inputs: process.inputs ?? [], outputs: process.outputs ?? [] }
    }),
  }))
}

/** 盘上已有产物里 DFD 加工的 `name → id`（F-6）。 */
function knownProcessIds(current: MethodArtifact | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const level of current?.levels ?? []) {
    for (const process of level.processes) {
      const name = textOf(process.name).trim()
      const id = textOf(process.id).trim()
      if (name !== '' && id !== '' && !out.has(name)) out.set(name, id)
    }
  }
  return out
}

/** 盘上已有产物里时序的 `name → id`（F-6）。 */
function knownSequenceIds(current: MethodArtifact | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const sequence of current?.sequences ?? []) {
    const name = textOf(sequence.name).trim()
    const id = textOf(sequence.id).trim()
    if (name !== '' && id !== '' && !out.has(name)) out.set(name, id)
  }
  return out
}

/**
 * 一条时序覆盖的需求 id 集合（F-11：**两套字段都认**）。
 *
 * `requirement`（单数）与 `requires`（复数）历史上并存，而追溯图只读 `requires` →
 * 只写 `requirement` 的条目被判成孤儿（实测 9 个假孤儿）。读取侧统一走这里取**并集**，
 * 因此老数据、手改过的盘上文件、以及模型只写其中一个字段的情况都能正确追溯。
 * 顺序稳定：先 `requires`（数组顺序），再补 `requirement`（单数），去重后返回。
 */
export function sequenceRequirementIds(sequence: Pick<SequenceSpec, 'requirement' | 'requires'>): string[] {
  const out: string[] = []
  const push = (raw: string | undefined): void => {
    const value = (raw ?? '').trim()
    if (value === '' || out.includes(value)) return
    out.push(value)
  }
  for (const raw of sequence.requires ?? []) push(raw)
  push(sequence.requirement)
  return out
}

/**
 * 写入时把两套需求字段**归一**（F-11）：两者都接受，落盘后互相一致。
 *
 * `requires` = 并集（去重），`requirement` = 并集的第一个（没有就写空串）——
 * 于是「只写 requirement」与「只写 requires」两种情况落盘形态相同，追溯结果必然相同。
 */
function normalizeSequences(sequences: SequenceSpec[] | undefined, used: string[], known: Map<string, string> = new Map()): SequenceSpec[] | undefined {
  const assigned = assignIds(sequences, 'SEQ', used, known)
  if (assigned === undefined) return undefined
  return assigned.map((sequence) => {
    const ids = sequenceRequirementIds(sequence)
    return { ...sequence, requirement: ids[0] ?? '', requires: ids }
  })
}

function normalizeRules(rules: LayerRules | undefined): LayerRules | undefined {
  if (rules === undefined) return undefined
  return {
    layers: rules.layers ?? [],
    assignments: rules.assignments ?? {},
    allowed: rules.allowed ?? [],
    ...(rules.requires === undefined ? {} : { requires: rules.requires }),
  }
}

/**
 * 每个种类的**正文字段**（F-10：形状必须有据可查，并用于"未知字段必须报出来"）。
 *
 * 为什么需要它：`artifactData` 的字段名此前只能靠读源码（layers 要嵌在 `rules` 下、
 * classes 用 `types`、debt 用 `debts`…）。模型按直觉把 `layers/assignments/allowed`
 * 写在顶层时，回执只说「0 条」，**不提示哪些字段被忽略** —— 与 F-8 同族。
 */
export const METHOD_ARTIFACT_PAYLOAD_FIELDS: Record<MethodArtifactKind, string[]> = {
  dictionary: ['dictionary'],
  dfd: ['levels'],
  erd: ['entities', 'relations'],
  classes: ['types'],
  sequences: ['sequences'],
  layers: ['rules'],
  debt: ['debts'],
  reversibility: ['decisions'],
  increments: ['increments'],
  mapping: ['mappings'],
  invariants: ['invariants'],
  diffVerify: ['diffVerify'],
}

/** 每个种类都接受的**公共**字段（与正文形状无关的元信息）。 */
export const METHOD_ARTIFACT_COMMON_FIELDS: readonly string[] = ['summary', 'requires']

/**
 * **对象型正文**里字段固定的那几个（F-10 的第二层：嵌错了也要报出来）。
 *
 * 只有 `rules` 与 `diffVerify` 是单对象正文；其余正文是条目数组，条目里允许自由扩展，
 * 因此不做数组元素级的未知字段检查（会误报合法扩展）。
 */
const METHOD_ARTIFACT_NESTED_FIELDS: Partial<Record<MethodArtifactKind, Record<string, string[]>>> = {
  layers: { rules: ['layers', 'assignments', 'allowed', 'requires'] },
  diffVerify: { diffVerify: ['sameInputSameOutput', 'baselineSource', 'baselineRef', 'controlRepo'] },
}

export interface MethodArtifactFieldReport {
  /** 本 kind 的正文（期望）字段 */
  expected: string[]
  /** 本 kind 也接受的公共字段 */
  common: string[]
  /** 这次调用真正给出了的正文（期望）字段 */
  present: string[]
  /** 既不是正文、也不是公共字段 → **必须显式报出**（不许静默忽略） */
  ignored: string[]
  /** 对象型正文里不认识的下级字段（形如 `rules.foo`），同样必须报出 */
  ignoredNested: string[]
}

/**
 * 把一次 `artifactData` 提交的字段对照本 kind 的期望形状分类（F-10）。
 *
 * 纯函数、只读入参：调用方（回执层）据此决定"报出被忽略的字段"还是"拒绝落半成品"。
 */
export function methodArtifactFieldReport(kind: MethodArtifactKind, body: Record<string, unknown>): MethodArtifactFieldReport {
  const expected = [...METHOD_ARTIFACT_PAYLOAD_FIELDS[kind]]
  const common = [...METHOD_ARTIFACT_COMMON_FIELDS]
  const keys = Object.keys(body)
  const ignoredNested: string[] = []
  for (const [field, allowed] of Object.entries(METHOD_ARTIFACT_NESTED_FIELDS[kind] ?? {})) {
    const value = body[field]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    for (const sub of Object.keys(value as Record<string, unknown>)) {
      if (!allowed.includes(sub)) ignoredNested.push(`${field}.${sub}`)
    }
  }
  return {
    expected,
    common,
    present: expected.filter((field) => body[field] !== undefined),
    ignored: keys.filter((key) => !expected.includes(key) && !common.includes(key)),
    ignoredNested,
  }
}

/**
 * 写入（或合并更新）一份方法产物。
 *
 * 合并语义与 `upsertElement` 一致：给出哪个字段就覆盖哪个字段，其余保持原值。
 * 条目**没有 id 时自动编号**（`DD-001` / `TYPE-001` …），保证追溯与"引用真实存在"检查可用。
 */
export function writeMethodArtifact(
  store: SdoStore,
  journal: Journal,
  kind: MethodArtifactKind,
  patch: MethodArtifactInput,
): MethodArtifact {
  const existing = readMethodArtifact(store, kind)
  const used = usedEntryIds(store)
  const base: MethodArtifact = existing ?? {
    id: nextId('MA', listMethodArtifacts(store).map((artifact) => artifact.id)),
    kind,
    summary: '',
    updatedAt: '',
  }
  const merged: MethodArtifact = {
    ...base,
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.requires === undefined ? {} : { requires: patch.requires }),
    ...(patch.dictionary === undefined ? {} : { dictionary: assignIds(patch.dictionary, 'DD', used, knownIdsByName(base, 'dictionary')) }),
    ...(patch.levels === undefined ? {} : { levels: normalizeLevels(patch.levels, used, knownProcessIds(base)) }),
    ...(patch.entities === undefined ? {} : { entities: assignIds(patch.entities, 'ENT', used, knownIdsByName(base, 'entities')) }),
    ...(patch.relations === undefined ? {} : { relations: assignIds(patch.relations, 'REL', used, knownIdsByName(base, 'relations')) }),
    ...(patch.types === undefined ? {} : { types: assignIds(patch.types, 'TYPE', used, knownIdsByName(base, 'types')) }),
    // F-11：时序的两套需求字段（requirement / requires）**写入时归一**，落盘后互相一致
    ...(patch.sequences === undefined ? {} : { sequences: normalizeSequences(patch.sequences, used, knownSequenceIds(base)) }),
    ...(patch.rules === undefined ? {} : { rules: normalizeRules(patch.rules) }),
    ...(patch.debts === undefined ? {} : { debts: assignIds(patch.debts, 'DEBT', used, knownIdsByName(base, 'debts')) }),
    ...(patch.decisions === undefined ? {} : { decisions: assignIds(patch.decisions, 'REV', used, knownIdsByName(base, 'decisions')) }),
    ...(patch.increments === undefined ? {} : { increments: assignIds(patch.increments, 'INC', used, knownIdsByName(base, 'increments')) }),
    // `porting` 三类：映射 / 不变量 有 id 自动编号；差分验证策略是单对象，直接覆盖
    ...(patch.mappings === undefined ? {} : { mappings: assignIds(patch.mappings, 'MAP', used, knownIdsByName(base, 'mappings')) }),
    ...(patch.invariants === undefined ? {} : { invariants: assignIds(patch.invariants, 'INV', used, knownIdsByName(base, 'invariants')) }),
    ...(patch.diffVerify === undefined ? {} : { diffVerify: patch.diffVerify }),
    updatedAt: new Date().toISOString(),
  }
  store.writeYaml(['design', `method-${kind}.yml`], { artifact: merged })
  journal.append('design/artifact-updated', { kind, id: merged.id, entries: artifactEntryCount(merged) })
  return merged
}

// —————————————————————— 追溯：方法产物条目也进既有 trace.orphans ——————————————————————

export interface MethodTraceable {
  id: string
  requires: string[]
  kind: MethodArtifactKind
}

/**
 * 可以被既有 `trace.orphans` 抓的产物条目（无需求来源即孤儿）。
 *
 * **不新造判据**：只把产物条目交给既有孤儿检查；条目要能写 `requires: [REQ-xxx]`。
 */
export function methodTraceables(store: SdoStore): MethodTraceable[] {
  const out: MethodTraceable[] = []
  const push = (id: string | undefined, requires: string[] | undefined, kind: MethodArtifactKind): void => {
    if (id === undefined) return
    out.push({ id, requires: requires ?? [], kind })
  }
  for (const artifact of listMethodArtifacts(store)) {
    for (const item of artifact.dictionary ?? []) push(item.id, item.requires, 'dictionary')
    for (const level of artifact.levels ?? []) for (const process of level.processes) push(process.id, process.requires, 'dfd')
    for (const entity of artifact.entities ?? []) push(entity.id, entity.requires, 'erd')
    for (const type of artifact.types ?? []) push(type.id, type.requires, 'classes')
    // F-11：读取侧**两套字段都认**（并集）—— 老数据只写 `requirement` 时不再误判孤儿
    for (const sequence of artifact.sequences ?? []) push(sequence.id, sequenceRequirementIds(sequence), 'sequences')
    for (const debt of artifact.debts ?? []) push(debt.id, debt.requires, 'debt')
    for (const decision of artifact.decisions ?? []) push(decision.id, decision.requires, 'reversibility')
    for (const increment of artifact.increments ?? []) push(increment.id, increment.requires, 'increments')
    // `porting`：映射与不变量条目也进既有孤儿检查（未挂需求即孤儿）
    for (const entry of artifact.mappings ?? []) push(entry.id, entry.requires, 'mapping')
    for (const item of artifact.invariants ?? []) push(item.id, item.requires, 'invariants')
  }
  return out
}

// —————————————————————— 最小必产项（逐包机械检查） ——————————————————————

export interface MethodPackageCheck {
  id: MethodId
  label: string
  selected: boolean
  /** 与门禁三态同口径：`ok` 通过 / `!ok && !na` 失败 / `na` 不适用 */
  ok: boolean
  na: boolean
  naReason?: string | undefined
  /** 缺哪些必产项（人读名字） */
  missing: string[]
  /**
   * 因**规则本身的适用范围**而不作为缺陷的条目（F-13 / F-14），必须显式说明：
   *   · 哪条 `must` 需求因为什么 `kind` 被豁免「必须有时序」；
   *   · 哪个类型因为显式声明 `leaf: true` 被当作叶子、不要求协作方。
   * 这些**不是**"静默放行"——它们会进 `detail`、门禁回执与 `action=method` 回执。
   */
  exemptions: string[]
  /** 逐条说明（回执逐包显示用） */
  detail: string
}

export interface MethodProductsResult {
  selection: MethodSelection
  packages: MethodPackageCheck[]
  ok: boolean
  na: boolean
  naReason?: string | undefined
  missing: string[]
  /** 全部选中包的豁免说明（扁平汇总，供回执顶部一处列出） */
  exemptions: string[]
  detail: string
}

const PACKAGE_LABEL_KEY: Record<MethodId, string> = {
  structured: 'uiMethod.pkgStructured',
  oo: 'uiMethod.pkgOo',
  evolutionary: 'uiMethod.pkgEvolutionary',
  porting: 'uiMethod.pkgPorting',
}

const PRODUCT_LABEL: Record<string, string> = {
  dictionary: 'uiMethod.prodDictionary',
  dfd: 'uiMethod.prodDfd',
  erd: 'uiMethod.prodErd',
  classes: 'uiMethod.prodClasses',
  sequences: 'uiMethod.prodSequences',
  layers: 'uiMethod.prodLayers',
  debt: 'uiMethod.prodDebt',
  reversibility: 'uiMethod.prodReversibility',
  increments: 'uiMethod.prodIncrements',
  mapping: 'uiMethod.prodMapping',
  invariants: 'uiMethod.prodInvariants',
  diffVerify: 'uiMethod.prodDiffVerify',
}

function productLabel(kind: MethodArtifactKind): string {
  return t(PRODUCT_LABEL[kind] ?? 'uiMethod.prodDictionary')
}

function nonEmpty(value: string | undefined): boolean {
  // 产物文件是手改得到的地方（`retry: 2` 同理）：不是字符串就按空串判定，绝不抛 `.trim is not a function`
  return textOf(value).trim() !== ''
}

/**
 * 不要求「关键用例时序」的 must 需求种类（F-13）。
 *
 * 为什么：`constraint` / `quality` 类需求**没有"流程"可画**（例如「单机可运行」「合规与范围约束」），
 * 强制它们各有一条时序会**逼人造假**（实测 C-29 点名「必须级需求 REQ-009 没有对应时序」）。
 * 口径从严：只豁免这两种；`functional` 与 `ui` 仍然要求时序。
 */
export const SEQUENCE_EXEMPT_KINDS: readonly RequirementKind[] = ['constraint', 'quality']

/** 一个包的最小必产项检查结果：缺什么 + **显式豁免**了什么（豁免绝不是"静默放行"）。 */
interface ProductCheckOutcome {
  missing: string[]
  exemptions: string[]
}

/** 结构化：数据字典 / 分层 DFD / ERD。 */
function checkStructured(artifacts: Map<MethodArtifactKind, MethodArtifact>): ProductCheckOutcome {
  const missing: string[] = []

  const dictionary = artifacts.get('dictionary')
  const items = dictionary?.dictionary ?? []
  if (dictionary === undefined || items.length === 0) missing.push(productLabel('dictionary'))
  else {
    for (const item of items) {
      const gaps: string[] = []
      if (!nonEmpty(item.name)) gaps.push(t('uiMethod.fieldName'))
      if (!nonEmpty(item.type)) gaps.push(t('uiMethod.fieldType'))
      if (!nonEmpty(item.source)) gaps.push(t('uiMethod.fieldSource'))
      if (!nonEmpty(item.sink)) gaps.push(t('uiMethod.fieldSink'))
      if (!nonEmpty(item.validation)) gaps.push(t('uiMethod.fieldValidation'))
      if (gaps.length > 0) {
        missing.push(fmt('uiMethod.dictItemIncomplete', { p1: item.name ?? item.id ?? '', p2: gaps.join(' ') }))
      }
    }
  }

  const dfd = artifacts.get('dfd')
  const levels = [...(dfd?.levels ?? [])].sort((a, b) => a.level - b.level)
  if (dfd === undefined || levels.length < 2) {
    missing.push(fmt('uiMethod.dfdTooShallow', { p1: String(levels.length) }))
  } else {
    for (const level of levels) {
      for (const process of level.processes) {
        if ((process.inputs ?? []).length === 0) missing.push(fmt('uiMethod.dfdProcessNoInput', { p1: process.name }))
        if ((process.outputs ?? []).length === 0) missing.push(fmt('uiMethod.dfdProcessNoOutput', { p1: process.name }))
      }
    }
    // **父子平衡**：父层边界流集合必须与子层边界流集合相等（无凭空出现的流，也无凭空消失的流）
    for (let i = 0; i + 1 < levels.length; i += 1) {
      const parent = levels[i]
      const child = levels[i + 1]
      if (parent === undefined || child === undefined) continue
      const parentNames = new Set(parent.flows.map((flow) => flow.name))
      const childNames = new Set(child.flows.map((flow) => flow.name))
      const notDecomposed = [...parentNames].filter((name) => !childNames.has(name))
      const invented = [...childNames].filter((name) => !parentNames.has(name))
      if (notDecomposed.length > 0) {
        missing.push(fmt('uiMethod.dfdUnbalancedMissing', {
          p1: String(parent.level),
          p2: String(child.level),
          p3: notDecomposed.join(' '),
        }))
      }
      if (invented.length > 0) {
        missing.push(fmt('uiMethod.dfdUnbalancedExtra', {
          p1: String(parent.level),
          p2: String(child.level),
          p3: invented.join(' '),
        }))
      }
    }
  }

  const erd = artifacts.get('erd')
  const entities = erd?.entities ?? []
  const relations = erd?.relations ?? []
  if (erd === undefined || entities.length === 0) missing.push(productLabel('erd'))
  else {
    for (const entity of entities) {
      if (!nonEmpty(entity.identifier)) missing.push(fmt('uiMethod.erdEntityNoIdentifier', { p1: entity.name }))
    }
    if (relations.length === 0) missing.push(t('uiMethod.erdNoRelation'))
    for (const relation of relations) {
      if (!['1:1', '1:N', 'M:N'].includes(textOf(relation.cardinality).trim())) {
        missing.push(fmt('uiMethod.erdBadCardinality', { p1: relation.name, p2: relation.cardinality ?? '' }))
      }
    }
  }
  return { missing, exemptions: [] }
}

/** 面向对象：类/接口清单 / 关键用例时序 / 分层包依赖规则。 */
function checkOo(artifacts: Map<MethodArtifactKind, MethodArtifact>, must: Requirement[]): ProductCheckOutcome {
  const missing: string[] = []
  const exemptions: string[] = []

  const classes = artifacts.get('classes')
  const types = classes?.types ?? []
  if (classes === undefined || types.length === 0) missing.push(productLabel('classes'))
  else {
    for (const type of types) {
      if (!nonEmpty(type.responsibility)) missing.push(fmt('uiMethod.typeNoResponsibility', { p1: type.name }))
      // F-14：**只有非叶子类型**必须有协作方；叶子身份必须由 `leaf: true` **显式声明**
      // （不按"没协作方/分层在末端"推断 —— 那会让叶子层的恒红被静默放过）。
      if (type.leaf === true) {
        exemptions.push(fmt('uiMethod.typeLeafExempt', { p1: type.name }))
        continue
      }
      if ((type.collaborators ?? []).length === 0) missing.push(fmt('uiMethod.typeNoCollaborator', { p1: type.name }))
    }
  }

  const sequencesArtifact = artifacts.get('sequences')
  const sequences = sequencesArtifact?.sequences ?? []
  if (sequencesArtifact === undefined || sequences.length === 0) missing.push(productLabel('sequences'))
  else {
    for (const sequence of sequences) {
      if ((sequence.participants ?? []).length === 0) missing.push(fmt('uiMethod.sequenceNoParticipant', { p1: sequence.name }))
      if ((sequence.messages ?? []).length === 0) missing.push(fmt('uiMethod.sequenceNoMessage', { p1: sequence.name }))
      for (const message of sequence.messages ?? []) {
        if (!nonEmpty(message.from) || !nonEmpty(message.to) || !nonEmpty(message.trigger)) {
          missing.push(fmt('uiMethod.sequenceMessageIncomplete', { p1: sequence.name, p2: message.name }))
        }
      }
    }
    // 至少覆盖所有 must 需求（规格 §1.2：关键用例的时序要覆盖 must 需求）。
    // F-11：`requirement` 与 `requires` **两者都认**；F-13：约束/质量类需求豁免。
    const covered = new Set(sequences.flatMap((sequence) => sequenceRequirementIds(sequence)))
    for (const requirement of must) {
      if (SEQUENCE_EXEMPT_KINDS.includes(requirement.kind)) {
        exemptions.push(fmt('uiMethod.sequenceKindExempt', { p1: requirement.id, p2: requirement.kind }))
        continue
      }
      if (!covered.has(requirement.id)) missing.push(fmt('uiMethod.sequenceMissingMust', { p1: requirement.id }))
    }
  }

  const layers = artifacts.get('layers')
  const rules = layers?.rules
  if (layers === undefined || rules === undefined) missing.push(productLabel('layers'))
  else {
    if ((rules.layers ?? []).length < 2) missing.push(fmt('uiMethod.layersTooFew', { p1: (rules.layers ?? []).join(' ') }))
    if ((rules.allowed ?? []).length === 0) missing.push(t('uiMethod.layersNoAllowed'))
  }
  return { missing, exemptions }
}

/** 敏捷-演进式：技术债台账 / 可逆性分级 / 迭代设计增量。 */
function checkEvolutionary(artifacts: Map<MethodArtifactKind, MethodArtifact>): ProductCheckOutcome {
  const missing: string[] = []

  const debt = artifacts.get('debt')
  const debts = debt?.debts ?? []
  if (debt === undefined || debts.length === 0) missing.push(productLabel('debt'))
  else {
    for (const item of debts) {
      const gaps: string[] = []
      if (!['design', 'code', 'test', 'docs'].includes(textOf(item.type).trim())) {
        missing.push(fmt('uiMethod.debtBadType', { p1: item.title, p2: String(item.type ?? '') }))
      }
      if (!nonEmpty(item.impact)) gaps.push(t('uiMethod.fieldImpact'))
      if (!nonEmpty(item.trigger)) gaps.push(t('uiMethod.fieldTrigger'))
      if (!nonEmpty(item.plan)) gaps.push(t('uiMethod.fieldPlan'))
      if (gaps.length > 0) missing.push(fmt('uiMethod.debtIncomplete', { p1: item.title, p2: gaps.join(' ') }))
    }
  }

  const reversibility = artifacts.get('reversibility')
  const decisions = reversibility?.decisions ?? []
  if (reversibility === undefined || decisions.length === 0) missing.push(productLabel('reversibility'))
  else {
    for (const decision of decisions) {
      if (!['reversible', 'costly', 'irreversible'].includes(textOf(decision.grade).trim())) {
        missing.push(fmt('uiMethod.revBadGrade', { p1: decision.decision, p2: String(decision.grade ?? '') }))
        continue
      }
      if (decision.grade === 'irreversible' && !nonEmpty(decision.whyNow)) {
        missing.push(fmt('uiMethod.revIrreversibleNoWhy', { p1: decision.decision }))
      }
    }
  }

  const increments = artifacts.get('increments')
  const list = increments?.increments ?? []
  if (increments === undefined || list.length === 0) missing.push(productLabel('increments'))
  else {
    for (const increment of list) {
      if (!nonEmpty(increment.iteration)) missing.push(fmt('uiMethod.incNoIteration', { p1: increment.id ?? increment.note }))
      if ((increment.elements ?? []).length === 0) missing.push(fmt('uiMethod.incNoElements', { p1: increment.iteration }))
    }
  }
  return { missing, exemptions: [] }
}

/**
 * `porting` 包（§7.3）的最小必产项机械检查。
 *
 * 三类必产项**逐条**查：
 *   ① **旧→新映射表**：每条两侧非空、`rewrite` 非空、`to` 引用**真实存在的模块/类型**，
 *      且每条必须含**替代方案与被否决原因**（规格原文点名）；
 *   ② **不变量清单**：每条 `statement` 非空、`category` 合法、**`verify` 非空**（规格点名）；
 *   ③ **差分验证策略**：`sameInputSameOutput` 非空，且 `baselineSource` 落在
 *      `DIFF_BASELINE_SOURCES`（测试 / 黄金样本 / 上游分支）里 —— 必须给出可比对的基线来源。
 */
function checkPorting(artifacts: Map<MethodArtifactKind, MethodArtifact>, moduleIndex: ModuleIndex | undefined): ProductCheckOutcome {
  const missing: string[] = []

  // ① 旧→新映射表
  const mappingArtifact = artifacts.get('mapping')
  const mappings = mappingArtifact?.mappings ?? []
  if (mappingArtifact === undefined || mappings.length === 0) {
    missing.push(productLabel('mapping'))
  } else {
    for (const entry of mappings) {
      const where = nonEmpty(entry.from) ? entry.from : (entry.id ?? productLabel('mapping'))
      if (!nonEmpty(entry.from)) missing.push(fmt('uiMethod.mapNoFrom', { p1: where }))
      if (!nonEmpty(entry.to)) {
        missing.push(fmt('uiMethod.mapNoTo', { p1: where }))
      } else if (moduleIndex !== undefined && !moduleIndex.resolves(entry.to)) {
        // 「引用真实存在的模块/类型」——**只在能查的时候查**（拿不到工作区时不误报）
        missing.push(fmt('uiMethod.mapGhostTarget', { p1: where, p2: entry.to }))
      }
      if (!nonEmpty(entry.rewrite)) missing.push(fmt('uiMethod.mapNoRewrite', { p1: where }))
      const alternatives = entry.alternatives ?? []
      if (alternatives.length === 0) {
        missing.push(fmt('uiMethod.mapNoAlternative', { p1: where }))
      } else {
        for (const alternative of alternatives) {
          if (!nonEmpty(alternative.option) || !nonEmpty(alternative.rejectedBecause)) {
            missing.push(fmt('uiMethod.mapAlternativeIncomplete', { p1: where }))
          }
        }
      }
    }
  }

  // ② 不变量清单（每条必须带验证方法）
  const invariantArtifact = artifacts.get('invariants')
  const invariants = invariantArtifact?.invariants ?? []
  if (invariantArtifact === undefined || invariants.length === 0) {
    missing.push(productLabel('invariants'))
  } else {
    for (const item of invariants) {
      const where = nonEmpty(item.statement) ? item.statement : (item.id ?? productLabel('invariants'))
      if (!nonEmpty(item.statement)) missing.push(fmt('uiMethod.invNoStatement', { p1: where }))
      if (!INVARIANT_CATEGORIES.includes(item.category)) {
        missing.push(fmt('uiMethod.invBadCategory', { p1: where, p2: String(item.category ?? '') }))
      }
      if (!nonEmpty(item.verify)) missing.push(fmt('uiMethod.invNoVerify', { p1: where }))
    }
  }

  // ③ 差分验证策略（必须给出可比对的基线来源）
  const diffArtifact = artifacts.get('diffVerify')
  const strategy = diffArtifact?.diffVerify
  if (diffArtifact === undefined || strategy === undefined) {
    missing.push(productLabel('diffVerify'))
  } else {
    if (!nonEmpty(strategy.sameInputSameOutput)) missing.push(t('uiMethod.diffNoSameInput'))
    const source = textOf(strategy.baselineSource).trim()
    if (!(DIFF_BASELINE_SOURCES as readonly string[]).includes(source)) {
      missing.push(fmt('uiMethod.diffBadBaselineSource', { p1: source }))
    }
    if (!nonEmpty(strategy.baselineRef)) missing.push(t('uiMethod.diffNoBaselineRef'))
    if (source === 'upstream-branch' && !nonEmpty(strategy.controlRepo)) {
      missing.push(t('uiMethod.diffUpstreamNoRepo'))
    }
  }
  return { missing, exemptions: [] }
}

/** 不变量分类的合法取值（与 `InvariantItem.category` 同步）。 */
const INVARIANT_CATEGORIES = ['behaviour', 'numeric', 'save-format', 'protocol-id']

/**
 * 「引用真实存在的模块/类型」的解析器（§7.3 机械检查）。
 *
 * 可解析的引用集合：
 *   · 已完成的设计元素 id / 名字（`DES-*`）；
 *   · 方法产物里的类/接口（`TYPE-*`）、ERD 实体、DFD 加工；
 *   · 工作区里**真实存在的文件路径**（`src/domain/method.ts` / `src.domain.method` → 命中）。
 *
 * 为什么把"工作区文件"纳进来：移植项目的新侧就是目标仓库里的真实代码，
 * 只比对设计台账会把"代码里真有的模块"误判成幽灵引用。**拿不到工作区时不建索引** →
 * 调用方传 `undefined`，此时跳过该检查（宁可少判，不可误判）。
 */
export interface ModuleIndex {
  refs: Set<string>
  paths: string[]
  resolves: (value: string) => boolean
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.go', '.rs', '.py', '.cs', '.cpp', '.c', '.h', '.gradle', '.json', '.yml', '.yaml']

/** 递归收集工作区里的文件相对路径（跳过 `.git` / `node_modules` / `.sdo`，并设上限）。 */
function collectWorkspaceFiles(workspace: string, limit = 20_000): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (out.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), relative)
      else out.push(relative)
    }
  }
  walk(workspace, '')
  return out
}

export function buildModuleIndex(workspace: string | undefined, store: SdoStore): ModuleIndex | undefined {
  const refs = new Set<string>()
  const add = (value: string | undefined): void => {
    const ref = textOf(value).trim()
    if (ref !== '') refs.add(ref)
  }
  for (const element of listElements(store)) {
    add(element.id)
    add(element.name)
  }
  for (const artifact of listMethodArtifacts(store)) {
    for (const type of artifact.types ?? []) {
      add(type.id)
      add(type.name)
    }
    for (const entity of artifact.entities ?? []) {
      add(entity.id)
      add(entity.name)
    }
    for (const level of artifact.levels ?? []) {
      for (const process of level.processes) {
        add(process.id)
        add(process.name)
      }
    }
  }
  if (workspace === undefined) return undefined
  const paths = collectWorkspaceFiles(workspace)
  const resolves = (value: unknown): boolean => {
    const raw = textOf(value).trim()
    if (raw === '') return false
    if (refs.has(raw)) return true
    const normalized = raw.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\./gu, '/')
    const candidates = [raw.replace(/\\/gu, '/').replace(/^\.\//u, ''), normalized]
    for (const candidate of candidates) {
      if (paths.some((path) => path === candidate)) return true
      if (paths.some((path) => path.endsWith(`/${candidate}`))) return true
      for (const extension of SOURCE_EXTENSIONS) {
        if (paths.some((path) => path === `${candidate}${extension}`)) return true
        if (paths.some((path) => path.endsWith(`/${candidate}${extension}`))) return true
      }
    }
    return false
  }
  return { refs, paths, resolves }
}

function packageCheck(
  id: MethodId,
  selection: MethodSelection,
  artifacts: Map<MethodArtifactKind, MethodArtifact>,
  must: Requirement[],
  moduleIndex: ModuleIndex | undefined,
): MethodPackageCheck {
  const label = t(PACKAGE_LABEL_KEY[id])
  const selected = selection.status === 'chosen' && selection.methods.includes(id)
  if (!selected) {
    // **未选中的包 = N/A + 理由**：既不失败也不通过（三态口径）。
    const naReason = selection.status === 'chosen'
      ? fmt('uiMethod.pkgNotSelected', { p1: label, p2: selection.methods.map((method) => t(PACKAGE_LABEL_KEY[method])).join(' + ') })
      : selection.status === 'none'
        ? fmt('uiMethod.pkgNotSelectedNone', { p1: label })
        : fmt('uiMethod.pkgUndecided', { p1: label, p2: selection.reason })
    return { id, label, selected: false, ok: false, na: true, naReason, missing: [], exemptions: [], detail: naReason }
  }
  const outcome = id === 'structured'
    ? checkStructured(artifacts)
    : id === 'oo'
      ? checkOo(artifacts, must)
      : id === 'porting'
        ? checkPorting(artifacts, moduleIndex)
        : checkEvolutionary(artifacts)
  const { missing, exemptions } = outcome
  // F-13 / F-14：豁免**必须显式出现在回执里**（哪条需求因何豁免、哪个类型被当作叶子），
  // 否则"规则放宽"就变成了静默放行 —— 那正是这份报告反复点名的问题。
  const base = missing.length === 0
    ? fmt('uiMethod.pkgOk', { p1: label, p2: '3' })
    : fmt('uiMethod.pkgMissing', { p1: label, p2: missing.join('；') })
  const detail = exemptions.length === 0 ? base : `${base}；${fmt('uiMethod.pkgExempt', { p1: exemptions.join('；') })}`
  return { id, label, selected: true, ok: missing.length === 0, na: false, missing, exemptions, detail }
}

/**
 * `design.method-products` 的判定核心：对**每个选中的包**逐条检查最小必产项。
 *
 * 三态：
 *   · 显式 `none` → **N/A + 理由**（本项目不做方法产物）；
 *   · 已选但缺任一必产项 → **失败**（列出缺什么）；
 *   · 未选中的包 → 各自的 **N/A + 理由**（`packages[]` 里逐包给出，供回执逐包显示）。
 * 方法未回答/非法时**判失败**（不允许"不选就没要求"蒙过去）。
 */
export function methodProducts(store: SdoStore, requirements: Requirement[], workspace?: string | undefined): MethodProductsResult {
  const selection = methodSelection(store)
  const artifacts = new Map<MethodArtifactKind, MethodArtifact>()
  for (const artifact of listMethodArtifacts(store)) artifacts.set(artifact.kind, artifact)
  const must = requirements.filter((requirement) => requirement.priority === 'must')
  // 「引用真实存在的模块/类型」需要工作区文件清单；只有选了 `porting` 才建索引（避免无谓遍历）
  const needsIndex = selection.status === 'chosen' && selection.methods.includes('porting')
  const moduleIndex = needsIndex ? buildModuleIndex(workspace, store) : undefined
  const packages = METHOD_IDS.map((id) => packageCheck(id, selection, artifacts, must, moduleIndex))
  const detail = packages.map((check) => check.detail).join('；')
  const exemptions = packages.filter((check) => check.selected).flatMap((check) => check.exemptions)

  if (selection.status === 'none') {
    return {
      selection,
      packages,
      ok: false,
      na: true,
      naReason: t('uiMethod.selectionNone'),
      missing: [],
      exemptions: [],
      detail: t('uiMethod.selectionNone'),
    }
  }
  if (selection.status !== 'chosen') {
    return { selection, packages, ok: false, na: false, missing: [selection.reason], exemptions: [], detail: selection.reason }
  }
  const selectedChecks = packages.filter((check) => check.selected)
  const missing = selectedChecks.flatMap((check) => check.missing)
  return { selection, packages, ok: missing.length === 0, na: false, missing, exemptions, detail }
}

// —————————————————————— 跨产物一致性（`design.method-consistency`） ——————————————————————

export interface MethodConsistencyResult {
  ok: boolean
  na: boolean
  naReason?: string | undefined
  problems: string[]
}

function refOf(entry: { id?: string | undefined; name?: string | undefined }): string {
  return (textOf(entry.id) || textOf(entry.name)).trim()
}

/** 一个名字集合：同时收录 id 与 name（引用允许写任一个）。 */
function refSet(entries: { id?: string | undefined; name?: string | undefined }[]): Set<string> {
  const set = new Set<string>()
  for (const entry of entries) {
    const id = textOf(entry.id).trim()
    const name = textOf(entry.name).trim()
    if (id !== '') set.add(id)
    if (name !== '') set.add(name)
  }
  return set
}

function dfdFlowNames(artifact: MethodArtifact | undefined): string[] {
  const names: string[] = []
  for (const level of artifact?.levels ?? []) {
    for (const flow of level.flows ?? []) names.push(flow.name)
    for (const flow of level.internalFlows ?? []) names.push(flow.name)
    for (const process of level.processes ?? []) names.push(...(process.inputs ?? []), ...(process.outputs ?? []))
  }
  return [...new Set(names.filter((name) => textOf(name).trim() !== ''))]
}

/**
 * `design.method-consistency` 的判定核心：选中的包产物之间**不自相矛盾**。
 *
 * 机械规则（规格 §1）：
 *   · 数据字典覆盖 DFD 上出现的**每一个**流名；
 *   · 类清单的协作方 / 时序的参与者必须解析到已登记类型；类清单引用的数据项必须存在；
 *   · ERD 关系两端必须是已声明实体；设计增量引用的元素必须真实存在；
 *   · 分层/包依赖规则做**方向性**检查（含既有设计元素的依赖图）；
 *   · 时序引用的需求必须存在。
 * 方法未回答/非法 → **失败**（查不到不算过）；显式 `none` → **N/A**。
 */
export function methodConsistency(store: SdoStore, requirements: Requirement[]): MethodConsistencyResult {
  const selection = methodSelection(store)
  if (selection.status === 'none') {
    return { ok: false, na: true, naReason: t('uiMethod.cConsistencyNone'), problems: [] }
  }
  if (selection.status !== 'chosen') {
    return { ok: false, na: false, problems: [selection.reason] }
  }
  const artifacts = new Map<MethodArtifactKind, MethodArtifact>()
  for (const artifact of listMethodArtifacts(store)) artifacts.set(artifact.kind, artifact)
  const problems: string[] = []

  const dictionary = artifacts.get('dictionary')
  const dictRefs = refSet((dictionary?.dictionary ?? []).map((item) => ({ id: item.id, name: item.name })))
  const flows = dfdFlowNames(artifacts.get('dfd'))
  if (flows.length > 0 && dictionary === undefined) {
    problems.push(t('uiMethod.cDictMissingForFlows'))
  }
  for (const flow of flows) {
    if (!dictRefs.has(flow)) problems.push(fmt('uiMethod.cFlowNotInDict', { p1: flow }))
  }

  const classes = artifacts.get('classes')
  const types = classes?.types ?? []
  const typeRefs = refSet(types.map((type) => ({ id: type.id, name: type.name })))
  for (const type of types) {
    for (const collaborator of type.collaborators ?? []) {
      const ref = textOf(collaborator).trim()
      if (ref === '') continue
      if (!typeRefs.has(ref)) {
        problems.push(fmt('uiMethod.cGhostCollaborator', { p1: type.name, p2: collaborator }))
      }
    }
    for (const data of type.data ?? []) {
      const ref = textOf(data).trim()
      if (ref === '') continue
      if (!dictRefs.has(ref)) {
        problems.push(fmt('uiMethod.cClassDataMissing', { p1: type.name, p2: data }))
      }
    }
  }

  const requirementIds = new Set(requirements.map((requirement) => requirement.id))
  for (const sequence of artifacts.get('sequences')?.sequences ?? []) {
    for (const participant of sequence.participants ?? []) {
      const ref = textOf(participant).trim()
      if (ref === '') continue
      if (!typeRefs.has(ref)) {
        problems.push(fmt('uiMethod.cSequenceParticipant', { p1: sequence.name, p2: participant }))
      }
    }
    // F-11：悬空需求检查同样**两套字段都认**（并集逐条查）
    for (const cited of sequenceRequirementIds(sequence)) {
      if (!requirementIds.has(cited)) {
        problems.push(fmt('uiMethod.cSequenceRequirement', { p1: sequence.name, p2: cited }))
      }
    }
  }

  const entityRefs = refSet((artifacts.get('erd')?.entities ?? []).map((entity: ErdEntity) => ({ id: entity.id, name: entity.name })))
  for (const relation of artifacts.get('erd')?.relations ?? []) {
    for (const endpoint of [relation.from, relation.to]) {
      const ref = textOf(endpoint).trim()
      if (ref === '') continue
      if (!entityRefs.has(ref)) {
        problems.push(fmt('uiMethod.cErdEndpoint', { p1: relation.name, p2: endpoint }))
      }
    }
  }

  const elements = listElements(store)
  const knownElements = new Set<string>()
  for (const element of elements) {
    knownElements.add(element.id)
    knownElements.add(element.name)
  }
  for (const ref of typeRefs) knownElements.add(ref)
  for (const increment of artifacts.get('increments')?.increments ?? []) {
    for (const element of increment.elements ?? []) {
      const ref = textOf(element).trim()
      if (ref === '') continue
      if (!knownElements.has(ref)) {
        problems.push(fmt('uiMethod.cIncrementElement', { p1: increment.iteration, p2: element }))
      }
    }
  }

  problems.push(...layerProblems(artifacts, elements))

  return { ok: problems.length === 0, na: false, problems }
}

/** 分层/包依赖规则的**方向性**检查（类型协作边 + 既有设计元素依赖图）。 */
function layerProblems(artifacts: Map<MethodArtifactKind, MethodArtifact>, elements: DesignElement[]): string[] {
  const layersArtifact = artifacts.get('layers')
  // 产物缺了不在这里报（`design.method-products` 负责"必产项齐备"），这里只查**已有产物的一致性**。
  if (layersArtifact === undefined) return []
  const rules = layersArtifact.rules
  const problems: string[] = []
  // **Y-6（本报告）**：旧实现 `if (rules === undefined) return []` ——
  // 产物存在但 `rules` 缺失/写歪时（例如半成品空壳），**整段方向检查静默跳过**，
  // `methodConsistency` 照常返回 `ok: true`：与"查不到就算过"同族。现在判失败并说清原因。
  if (rules === undefined) return [t('uiMethod.cLayerRulesMissing')]
  // **Y-6**：`allowed` 为空数组时"违规"永远不成立（零约束即全通过），且空集没有任何检查。
  // 多分层却没有任何允许方向 = 没有约束，判失败并提示（单分层时不存在跨层边，不算问题）。
  const layerNames = (rules.layers ?? []).map((layer) => textOf(layer).trim()).filter((layer) => layer !== '')
  if (layerNames.length > 1 && (rules.allowed ?? []).length === 0) {
    problems.push(t('uiMethod.cLayerAllowedEmpty'))
  }
  const layerOf = new Map<string, string>()
  const assign = (ref: string | undefined, layer: string): void => {
    const refText = textOf(ref).trim()
    const layerText = textOf(layer).trim()
    if (refText === '' || layerText === '') return
    layerOf.set(refText, layerText)
  }
  for (const type of artifacts.get('classes')?.types ?? []) {
    const layer = rules.assignments[type.name] ?? rules.assignments[type.id ?? '']
    assign(type.id, layer ?? '')
    assign(type.name, layer ?? '')
  }
  for (const element of elements) {
    const layer = rules.assignments[element.name] ?? rules.assignments[element.id]
    assign(element.id, layer ?? '')
    assign(element.name, layer ?? '')
  }

  const edges: { from: string; to: string }[] = []
  for (const type of artifacts.get('classes')?.types ?? []) {
    for (const collaborator of type.collaborators ?? []) {
      const ref = textOf(collaborator).trim()
      if (ref !== '') edges.push({ from: refOf(type), to: ref })
    }
  }
  for (const element of elements) {
    for (const dependency of element.dependsOn ?? []) {
      const ref = textOf(dependency).trim()
      if (ref !== '') edges.push({ from: element.name, to: ref })
    }
  }

  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const fromLayer = layerOf.get(edge.from)
    const toLayer = layerOf.get(edge.to)
    if (fromLayer === undefined || toLayer === undefined) {
      const missingRef = fromLayer === undefined ? edge.from : edge.to
      problems.push(fmt('uiMethod.cLayerUnassigned', { p1: edge.from, p2: edge.to, p3: missingRef }))
      continue
    }
    if (fromLayer === toLayer) continue
    const allowed = (rules.allowed ?? []).some((rule) => rule.from === fromLayer && rule.to === toLayer)
    if (!allowed) {
      problems.push(fmt('uiMethod.cLayerViolation', { p1: edge.from, p2: fromLayer, p3: edge.to, p4: toLayer }))
    }
  }
  return problems
}

// —————————————————————— 供渲染/回执用的汇总 ——————————————————————

/** 选中的包的标签（渲染与回执用）。 */
export function methodLabel(id: MethodId): string {
  return t(PACKAGE_LABEL_KEY[id])
}

/** 一个产物的可读种类名（收据/文档用）。 */
export function artifactKindLabel(kind: MethodArtifactKind): string {
  return productLabel(kind)
}
