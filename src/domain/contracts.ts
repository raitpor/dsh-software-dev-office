/**
 * 接口契约（Schema-first，设计 §6.4）。
 *
 * 纪律：
 *   · 每个**跨组件交互**都要有契约——G4 的 `design.contracts` 准则按组件视图的依赖边逐条核对；
 *   · 契约必须写清**失败语义**（超时 / 重试 / 幂等），否则"对接好了"只是乐观假设。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import { droppedFlag, pushShapeNote, scalarText, textListOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { Contract } from '../types.js'
import { componentEdges, listElements } from './architecture.js'
import { fmt, t } from './i18n.js'

export function listContractIds(store: SdoStore): string[] {
  return store
    .listNames('contracts')
    .filter((name) => /^CT-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/** `failureSemantics` 的字段（顺序即渲染顺序）。 */
const SEMANTICS_FIELDS = ['timeout', 'retry', 'idempotency'] as const

/**
 * 契约里一个**用户可编辑 YAML 字段**的类型提示（F-20）。
 *
 * 为什么要有它：契约是手改的真源，`retry: 2` 会被 YAML 解析成 number。此时
 *   · **不崩**：覆盖判定按字符串化结果 `2` 处理，不抛 `trim is not a function`；
 *   · **不假红**：值本身语义正确，只是类型不同 → 不因此判红；
 *   · **不静默**：把"哪个契约、哪个字段、当前什么类型、建议写成什么"摆到回执与门禁详情里。
 *
 * 无法字符串化（对象/数组）时 `usable: false`：该字段按空缺处理（覆盖判定据此判红），
 * 提示行同时给出修正办法 —— 是可读的失败，不是崩溃。
 */
export interface ContractFieldNote {
  /** 哪个契约 */
  contractId: string
  /** 哪个字段（点号分层，如 `failureSemantics.retry`；整份文件不可读时是 `contract`） */
  field: string
  /** 字段路径最后一段 = 可直接写进 YAML 的键名 */
  key: string
  /** YAML 里的实际类型：number / boolean / object / array / null … */
  actualType: string
  /** 可字符串化时的结果（用于给出建议写法）；不可字符串化时为空 */
  text: string
  /** 能否按字符串化结果使用 */
  usable: boolean
}

interface ContractRead {
  /** 规范化后的契约；连主体都不是映射时为 undefined */
  contract: Contract | undefined
  notes: ContractFieldNote[]
  /** F-21 的容器 / 开关形状提示（与 F-20 的标量提示分开，渲染口径不同） */
  shapeNotes: FieldShapeNote[]
}

function pushNote(
  notes: ContractFieldNote[],
  contractId: string,
  field: string,
  scalar: { actualType: string; text: string; usable: boolean },
): void {
  notes.push({
    contractId,
    field,
    key: field.split('.').pop() ?? field,
    actualType: scalar.actualType,
    text: scalar.text,
    usable: scalar.usable,
  })
}

/**
 * 读契约并**做类型归一化**：所有字符串字段按 `scalarText()` 的口径落地，
 * 类型不是 string 的字段同时产出一条类型提示。
 *
 * 这样下游（覆盖判定 / 回执 / 指纹）拿到的契约里 `name`、`producer`、`consumer`、
 * `schema`、`failureSemantics.*` 一定是字符串，不再有"读到 number 就抛异常"的路径。
 */
function readContractChecked(store: SdoStore, id: string): ContractRead {
  const file = store.readYaml<{ contract?: unknown }>('contracts', `${id}.yml`)
  // 文件不存在：不是"内容有问题"，静静返回
  if (file === undefined) return { contract: undefined, notes: [], shapeNotes: [] }
  const body = (file as { contract?: unknown } | null | undefined)?.contract
  const notes: ContractFieldNote[] = []
  const shapeNotes: FieldShapeNote[] = []
  // 连主体都不是映射（如 `contract: 123`）：**可读的失败** —— 报出来并跳过，不崩
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    notes.push({ contractId: id, field: 'contract', key: 'contract', actualType: typeNameOf(body), text: '', usable: false })
    return { contract: undefined, notes, shapeNotes }
  }
  const record = body as Record<string, unknown>
  const readField = (field: string): string => {
    const scalar = scalarText(record[field])
    if (scalar.typed) pushNote(notes, id, field, scalar)
    return scalar.text
  }
  const idText = readField('id')
  const name = readField('name')
  const producer = readField('producer')
  const consumer = readField('consumer')
  const schema = readField('schema')

  const semantics: Contract['failureSemantics'] = { timeout: '', retry: '', idempotency: '' }
  const semanticsRaw = record.failureSemantics
  if (semanticsRaw !== null && typeof semanticsRaw === 'object' && !Array.isArray(semanticsRaw)) {
    const map = semanticsRaw as Record<string, unknown>
    for (const field of SEMANTICS_FIELDS) {
      const scalar = scalarText(map[field])
      if (scalar.typed) pushNote(notes, id, `failureSemantics.${field}`, scalar)
      semantics[field] = scalar.text
    }
  } else if (semanticsRaw !== undefined) {
    // `failureSemantics` 被写成了标量/数组（如 `failureSemantics: none`）：整块按空缺处理并报出
    pushNote(notes, id, 'failureSemantics', scalarText(semanticsRaw))
  }

  // F-21 ②：`dropped` 只有**布尔**才算数（`yes` / `'true'` / `1` 都不当放弃），
  // 但非布尔值必须**大声报出**（点名实体、字段、实际类型、建议写法）。
  const dropped = droppedFlag(record.dropped)
  pushShapeNote(shapeNotes, 'contract', id, 'dropped', dropped.issue)

  // F-21 ①：`requires` 是列表位置（手写 `requires: REQ-001` 会让 `.includes` 抛异常）
  const requiresRaw = record.requires
  const requires = requiresRaw === undefined || requiresRaw === null ? undefined : textListOf(requiresRaw)
  if (requires !== undefined) pushShapeNote(shapeNotes, 'contract', id, 'requires', requires.issue)

  // `kind` 是枚举，不能一律字符串化（未知字符串要原样保留，交给人核对）；
  // 缺省（undefined/null）保留原值，避免改变既有确认戳指纹。
  const kindRaw = record.kind
  const kindScalar = scalarText(kindRaw)
  if (kindScalar.typed) pushNote(notes, id, 'kind', kindScalar)
  const kind =
    kindRaw === undefined || kindRaw === null
      ? (kindRaw as unknown as Contract['kind'])
      : ((kindScalar.usable ? kindScalar.text : 'schema') as Contract['kind'])

  const contract: Contract = {
    ...(record as unknown as Contract),
    // 字段缺失/为空时用**文件名里的 id** 兜底：文件名才是真源键，读到 undefined 会让下游静默失配
    id: idText === '' ? id : idText,
    name,
    kind,
    producer,
    consumer,
    schema,
    failureSemantics: semantics,
    requires: requires?.value ?? [],
    // F-21 ②：`dropped` 一律落成**布尔**——非布尔值（`yes` / `1` / `'true'`）按"未放弃"处理，
    // 但绝不允许它继续以原样字符串留在对象里（否则 `=== true` 之外的消费者会看到假形状）
    dropped: dropped.dropped,
  }
  return { contract, notes, shapeNotes }
}

export function readContract(store: SdoStore, id: string): Contract | undefined {
  return readContractChecked(store, id).contract
}

/**
 * 全部契约里的**字段类型提示**（F-20）：`action=view`、契约写入回执、C-30 门禁详情共用。
 *
 * 已作废的契约不参与（与覆盖判定同一口径），整份文件不可读的仍报出（否则它就静默了）。
 */
export function contractFieldNotes(store: SdoStore): ContractFieldNote[] {
  const notes: ContractFieldNote[] = []
  for (const id of listContractIds(store)) {
    const read = readContractChecked(store, id)
    if (read.contract?.dropped === true) continue
    notes.push(...read.notes)
  }
  return notes
}

/**
 * 全部契约上的**形状提示**（F-21 ① / ②）：`dropped` 不是布尔、`requires` 不是列表。
 *
 * 与 F-20 的 `contractFieldNotes`（标量类型）分开返回，渲染口径不同；
 * 已作废的契约不参与（与覆盖判定同一口径），整份文件不可读的仍报出（否则它就静默了）。
 */
export function contractShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listContractIds(store)) {
    const read = readContractChecked(store, id)
    if (read.contract?.dropped === true) continue
    notes.push(...read.shapeNotes)
  }
  return notes
}

/** 类型提示的**每行文案**（不含项目符号；空数组表示没有提示）。 */
export function contractFieldNoteLines(notes: ContractFieldNote[]): string[] {
  return notes.map((note) =>
    note.usable
      ? fmt('uiDescribe.contractFieldNoteTyped', {
          p1: note.contractId,
          p2: note.field,
          p3: note.key,
          p4: note.actualType,
          p5: note.text,
        })
      : note.field === 'contract'
        ? fmt('uiDescribe.contractFieldNoteBody', { p1: note.contractId, p2: note.actualType })
        : fmt('uiDescribe.contractFieldNoteUnusable', {
            p1: note.contractId,
            p2: note.field,
            p3: note.key,
            p4: note.actualType,
          }),
  )
}

/** 类型提示块的标题（有提示时由调用方加在行首）。 */
export function contractFieldNoteHeader(): string {
  return t('uiDescribe.contractFieldNoteHeader')
}

export function listContracts(store: SdoStore): Contract[] {
  const out: Contract[] = []
  for (const id of listContractIds(store)) {
    const contract = readContract(store, id)
    if (contract !== undefined) out.push(contract)
  }
  return out
}

export function writeContract(store: SdoStore, contract: Contract): void {
  store.writeYaml(['contracts', `${contract.id}.yml`], { contract })
}

export interface RecordContractInput {
  name: string
  kind?: Contract['kind'] | undefined
  /** 给了 id 则原地更新（D4-3） */
  id?: string | undefined
  producer: string
  consumer: string
  schema: string
  failureSemantics?: Partial<Contract['failureSemantics']> | undefined
}

/** 记录一份契约。 */
/** 作废一份契约（**回收路径**）：加 `dropped` 标记并留痕，不删除记录（追加式真源）。 */
export function dropContract(store: SdoStore, journal: Journal, contractId: string, reason: string): Contract | undefined {
  const existing = listContracts(store).find((item) => item.id === contractId)
  if (existing === undefined) return undefined
  const dropped: Contract = { ...existing, dropped: true, droppedReason: reason }
  writeContract(store, dropped)
  journal.append('contract/dropped', { id: contractId, reason })
  return dropped
}

export function recordContract(store: SdoStore, journal: Journal, input: RecordContractInput): Contract {
  // D4-3：给了 id 就**原地更新**（否则错记录会永久留存：传 id=CT-001 却新建 CT-010）
  const existing = input.id === undefined ? undefined : listContracts(store).find((item) => item.id === input.id)
  const contract: Contract = {
    id: existing?.id ?? nextId('CT', listContractIds(store)),
    name: input.name,
    kind: input.kind ?? 'schema',
    producer: input.producer,
    consumer: input.consumer,
    schema: input.schema,
    failureSemantics: {
      timeout: input.failureSemantics?.timeout ?? '',
      retry: input.failureSemantics?.retry ?? '',
      idempotency: input.failureSemantics?.idempotency ?? '',
    },
    at: new Date().toISOString(),
  }
  writeContract(store, contract)
  journal.append(existing === undefined ? 'contract/recorded' : 'contract/updated', {
    id: contract.id,
    name: contract.name,
    producer: contract.producer,
    consumer: contract.consumer,
  })
  return contract
}

/**
 * 契约完整性：组件视图的每条依赖边都要有对应契约（producer/consumer 对得上）。
 *
 * **Y-3（本报告）**：旧实现在等值比较之外还有一条 `contract.name.includes(edge.producer)`
 * 的**子串匹配**，它制造假绿 —— 实测：依赖边 `结算服务 → 订单服务` 配一份
 * `producer: 另一个东西` 的契约，只要它的**名字**里含"订单服务"就判"已覆盖"。
 * 另外依赖边的 consumer 用 `element.name`（名字），而 `dependsOn` 里存的可能是元素 id，
 * 于是改名/同名都会静默失真。
 *
 * 现在的口径：两侧都先**归一成稳定标识**（能解析成设计元素就取元素 id，否则取去空白的原文），
 * 再做**等值**比较；子串匹配彻底删除。
 */
export function contractCoverage(store: SdoStore): {
  ok: boolean
  totalEdges: number
  covered: number
  missing: { consumer: string; producer: string }[]
  incompleteSemantics: string[]
} {
  // 已作废的契约不参与覆盖判定（否则作废后仍算"已覆盖"，等于没作废）
  const contracts = listContracts(store).filter((contract) => contract.dropped !== true)
  const edges = componentEdges(store)
  const key = (ref: string): string => canonicalElementRef(store, ref)
  const missing = edges.filter(
    (edge) =>
      !contracts.some(
        (contract) =>
          key(contract.consumer) === key(edge.consumer) && key(contract.producer) === key(edge.producer),
      ),
  )
  const incompleteSemantics = contracts.filter((contract) => contract.dropped !== true)
    .filter(
      (contract) =>
        contract.failureSemantics.timeout.trim() === '' ||
        contract.failureSemantics.retry.trim() === '' ||
        contract.failureSemantics.idempotency.trim() === '',
    )
    .map((contract) => contract.id)
  return {
    ok: edges.length > 0 && missing.length === 0 && incompleteSemantics.length === 0,
    totalEdges: edges.length,
    covered: edges.length - missing.length,
    missing,
    incompleteSemantics,
  }
}

/**
 * 把契约/依赖边里写的"组件引用"归一成**稳定标识**（Y-3）。
 *
 * 引用可能写元素 id（`DES-002`）也可能写名字（`订单服务`）；依赖图两边本来就可能混用。
 * 归一规则：能按 id 或名字解析到设计元素 → 取该元素的 **id**（改名不再影响配对）；
 * 解析不到 → 取去空白的原文（可能是外部系统名，原样比较）。
 */
function canonicalElementRef(store: SdoStore, ref: string): string {
  const wanted = ref.trim()
  if (wanted === '') return ''
  const element = listElements(store).find((item) => item.id === wanted || item.name === wanted)
  return element === undefined ? wanted : element.id
}

/** 一条「名字与字段方向矛盾」的契约（F-16 的存量残留诊断）。 */
export interface ContractDirectionAnomaly {
  id: string
  /** 真源里存的名字 */
  name: string
  producer: string
  consumer: string
  /** 按**字段语义**应有的名字（`producer → consumer`） */
  expectedName: string
}

/**
 * `name` 是否与 `producer`/`consumer` 一致（当前构建的写入路径一律生成 `producer → consumer`）。
 *
 * 入参是**契约形状**（可能来自未经 `readContractChecked` 的调用方），因此这里也走
 * `scalarText()` 口径：手写 YAML 把它写成 number 时给出结论（不一致），而不是抛异常。
 */
export function contractNameMatchesFields(contract: Pick<Contract, 'name' | 'producer' | 'consumer'>): boolean {
  const name = scalarText(contract.name).text
  const producer = scalarText(contract.producer).text
  const consumer = scalarText(contract.consumer).text
  return name.trim() === `${producer} → ${consumer}`
}

/**
 * **名字与字段方向矛盾**的契约（F-16）。
 *
 * 为什么只能"报出来"、不能自动纠正：D4-2 之前的构建把 `name` 写成 `consumer → producer`
 * 口径，而**字段方向在两种存量里各有对错** —— 报告 §6.6.1 逐条语义核对后是
 * 甲类 9 条「字段反了、name 是对的」+ 乙类 17 条「字段是对的、name 是旧口径」。
 * 也就是说：**形式矛盾只说明"两者之一错了"，不能推出是哪一边错**。
 * 任何自动对调都会改错一半记录。因此这里只做**检测**：把它摆到回执与门禁详情里，
 * 由人核对方向后用 `sdo_design action=contract id=…` 重写（`name` 会按字段自动重生）。
 */
export function contractDirectionAnomalies(store: SdoStore): ContractDirectionAnomaly[] {
  return listContracts(store)
    .filter((contract) => contract.dropped !== true)
    .filter((contract) => !contractNameMatchesFields(contract))
    .map((contract) => ({
      id: contract.id,
      name: contract.name,
      producer: contract.producer,
      consumer: contract.consumer,
      expectedName: `${contract.producer} → ${contract.consumer}`,
    }))
}
