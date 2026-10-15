/**
 * **受审载荷**（签字审核单要内联的真源正文）。
 *
 * 用户裁定（2026-10-12）：签字人要能逐条判断"**模型理解得对不对、和他的想法有什么出入**"，
 * 所以审核单必须内联正文 —— 只列判据与"文件在不在"就是盲签。
 *
 * 三条纪律：
 *   ① **真源仍是 `.sdo`**：本模块只读、原样解析，**不做字段映射**（结构上不可能漏字段）；
 *      审核单是渲染快照，不是第二真源；
 *   ② **逐条指纹**：每条按 `contentHash`（规范化 JSON，见 `./hash.js`）算指纹 ——
 *      绑内容不绑 mtime，换行/键序变化不改指纹；
 *   ③ **顺序稳定**：集合按声明序、条目按文件名字典序 ⇒ 同内容两次生成指纹相同。
 */
import { contentHash } from './hash.js'
import { fmt } from './i18n.js'
import type { SdoStore } from '../infra/store.js'

/** 受审载荷里的一条（逐条正文 + 指纹）。 */
export interface ReviewPayloadItem {
  collection: string
  id: string
  /** 相对工作区的源文件路径（审计可追）。 */
  path: string
  /** 该条内容的指纹（`sha256:<hex>`）。 */
  hash: string
  /** 从真源原样解析出来的内容。 */
  content: unknown
}

/** 受审载荷的一个集合段。 */
export interface ReviewPayloadSection {
  collection: string
  items: ReviewPayloadItem[]
}

/**
 * 审核单的**机器可校验记录**（`.sdo/evidence/sign-reviews/<门禁>.json`）。
 *
 * 签字前会重算真源指纹与本记录比对：`hash` 不一致 ⇒ **拒签**，并用 `items` 逐条点名差异。
 */
export interface SignReviewRecord {
  gate: string
  at: string
  /** 生成时的 journal 序号。 */
  seq: number
  /** 整篇指纹（`sha256:<hex>`）。 */
  hash: string
  /** 生成时覆盖的受审集合（比对时按同一批集合重算，声明变了也算失效）。 */
  collections: string[]
  /** 生成时的逐条索引（比对基准）。 */
  items: ReviewPayloadIndexEntry[]
}

/** 逐条索引（指纹比对时用来"点名哪条变了"，不含正文）。 */
export interface ReviewPayloadIndexEntry {
  collection: string
  id: string
  path: string
  hash: string
}

const YAML_NAME = /\.ya?ml$/u

/**
 * 条目 id：台账文件的外层通常是 `{ requirement: { id: 'REQ-001', … } }` 这种**包装**。
 * 依次尝试 ①顶层 `id` ②任一顶层对象里的 `id` ③文件名去扩展名 —— 都不猜、不解析失败即降级为文件名。
 */
function idOf(content: unknown, fileName: string): string {
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>
    if (typeof record['id'] === 'string' && record['id'] !== '') return record['id']
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const inner = (value as Record<string, unknown>)['id']
        if (typeof inner === 'string' && inner !== '') return inner
      }
    }
  }
  return fileName.replace(YAML_NAME, '')
}

/** 读一个集合的受审载荷（按文件名字典序，顺序稳定）。 */
export function readReviewCollection(store: SdoStore, collection: string): ReviewPayloadSection {
  const items: ReviewPayloadItem[] = []
  for (const name of store.listNames(collection).sort()) {
    if (!YAML_NAME.test(name)) continue
    const content = store.readYaml(collection, name)
    // 读不出来的条目**不静默跳过**：按"空内容"入列并让指纹把它算进去 ——
    // 否则"文件坏掉"会表现为"少了一条"，而签字人看不到任何异常。
    items.push({
      collection,
      id: idOf(content, name),
      path: `${collection}/${name}`,
      hash: contentHash(content ?? null),
      content: content ?? null,
    })
  }
  return { collection, items }
}

/**
 * 读全部受审集合（集合按**声明序**）。
 *
 * **DEF-028（第三批 §3.11）**：集合名是**集合** —— 同一个名字读两遍只会产出**两段一模一样的段落**
 * （真机就是这么调进来的：`['tests','tests','decisions']` ⇒ 3 段）。这里按**首次出现顺序去重**。
 *
 * 为什么去重而不是拒绝：调用方给的是"我要受审的集合清单"，重复项**不含任何额外语义**，
 * 拒绝一条意思完全正确的调用比接受它更糟（本仓 TASK-016 的既定口径）。去重也不掩盖任何东西 ——
 * 逐条索引（`payloadIndex`）里本来就出现不了重复的 `collection/id`，而整篇指纹
 *（`reviewFingerprint`）按 `(collection, id, hash)` 算 ⇒ **去重前后指纹一致**（`test/m167` 钉住这一点）。
 */
export function readReviewPayload(store: SdoStore, collections: readonly string[]): ReviewPayloadSection[] {
  const seen = new Set<string>()
  const sections: ReviewPayloadSection[] = []
  for (const collection of collections) {
    const key = collection.trim()
    if (seen.has(key)) continue
    seen.add(key)
    sections.push(readReviewCollection(store, collection))
  }
  return sections
}

/** 逐条索引（比对与落盘用）。 */
export function payloadIndex(sections: readonly ReviewPayloadSection[]): ReviewPayloadIndexEntry[] {
  return sections.flatMap((section) =>
    section.items.map((item) => ({ collection: item.collection, id: item.id, path: item.path, hash: item.hash })),
  )
}

/**
 * **整篇指纹**：绑 `gate` + 逐条 `(collection, id, hash)`（不含正文 ⇒ 同内容同指纹，
 * 也不受正文里换行/键序影响）。
 */
export function reviewFingerprint(gate: string, sections: readonly ReviewPayloadSection[]): string {
  return contentHash({
    gate,
    payload: sections.map((section) => ({
      collection: section.collection,
      items: section.items.map((item) => ({ id: item.id, hash: item.hash })),
    })),
  })
}

/**
 * 两份逐条索引的差异（人读行，用于"审核单为什么失效"）。
 *
 * 这就是"不许只报一句'已失效'"的落点：拒绝签字时必须能点名**哪条变了/新增/删除**。
 * 同一 `collection/id` 在集合内重排不算变化（按 key 比对，不按位置）。
 */
export function diffPayloadIndex(
  before: readonly ReviewPayloadIndexEntry[],
  after: readonly ReviewPayloadIndexEntry[],
): string[] {
  const key = (entry: ReviewPayloadIndexEntry): string => `${entry.collection}/${entry.id}`
  const beforeMap = new Map(before.map((entry) => [key(entry), entry]))
  const afterMap = new Map(after.map((entry) => [key(entry), entry]))
  const lines: string[] = []
  for (const [id, entry] of afterMap) {
    const old = beforeMap.get(id)
    if (old === undefined) lines.push(fmt('uiSignPayload.diffAdded', { p1: id }))
    else if (old.hash !== entry.hash) lines.push(fmt('uiSignPayload.diffChanged', { p1: id }))
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) lines.push(fmt('uiSignPayload.diffRemoved', { p1: id }))
  }
  return lines
}

/**
 * **派生文档类受审段**（TASK-007）：真源是 YAML，但**受审正文是渲染出来的文档**。
 *
 * 为什么单列一个构造器，而不是把 `testing/report.yml` 塞进 `readReviewCollection`：
 * `readReviewCollection` 读的是"**按目录**逐文件原样解析"的 YAML 内容，而签字人要通读的是
 * `docs/TESTREPORT.md` 那份**渲染稿**（带渲染头、逐条结论、指纹）。若走 YAML 原样内联，
 * 用户看到的是字段树而不是报告正文 —— 那正是 REQ-051「整份报告进入审核单」没被满足的形态。
 *
 * 三条与既有口径**对齐**（不另造读取路径）：
 *   · 指纹用 `contentHash`（与 `readReviewCollection` 同口径：绑内容、不绑 mtime）；
 *   · `id` 用工作区相对路径（与既有条目的 `path` 一致，差异点名时可读）；
 *   · `content` 放**Markdown 文本**（`reviewDoc` 按"渲染稿"分支原样内联，不做字段映射）。
 */
export function renderedDocReviewItem(input: {
  collection: string
  id: string
  path: string
  text: string
}): ReviewPayloadItem {
  return {
    collection: input.collection,
    id: input.id,
    path: input.path,
    hash: contentHash(input.text),
    content: input.text,
  }
}
