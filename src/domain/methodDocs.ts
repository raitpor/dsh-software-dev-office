/**
 * **方法包的人审文档**（`docs/METHOD-<包>.md`）。
 *
 * 背景（用户要求）：设计阶段各方法包的结果不能只有 `.sdo/design/method-*.yml` 台账 ——
 * 人工审核要看**文档**（OO 要能看类图/时序图，结构化要能看 DFD/ERD，迁移要有映射表）。
 * 文档**内容由模型撰写**（散文 + 图都行），插件负责三件机械的事：
 *
 *   ① **必须存在**：选中某包却没有该包文档 → G3 判红（"该做没做"）；
 *   ② **绑定台账**：文档头必须写
 *      `<!-- method-doc: package=<包> basis=<指纹> -->`
 *      指纹由插件按该包产物的**台账内容**现算（见 {@link methodDocFingerprint}）。
 *      台账一改指纹就变 → 旧文档判红并要求重新生成（与 `docs/DESIGN.md` 的"文档即证据"同口径）；
 *   ③ **覆盖可查**：文档正文必须**提到该包每个条目的 id** —— 否则"文档"可能只写了一段感想，
 *      人审时看不到任何具体产物。缺哪个 id 会在判据里逐个点名。
 *
 * 关键点：**指纹只覆盖该包自己的产物**（换包不会互相失效），且空产物（没有该 kind 文件）
 * 不参与指纹 —— 否则"还没写产物"会与"产物没变"混为一谈。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SdoStore } from '../infra/store.js'
import { methodTraceables } from './method.js'
import type { MethodArtifactKind, MethodChoice } from '../types.js'

/** 每个方法包要求人审的产物种类（与 `design.method-products` 的最小必产项一一对应）。 */
export const PACKAGE_ARTIFACT_KINDS: Record<Exclude<MethodChoice, 'none'>, MethodArtifactKind[]> = {
  structured: ['dictionary', 'dfd', 'erd'],
  oo: ['classes', 'sequences', 'layers'],
  evolutionary: ['debt', 'reversibility', 'increments'],
  porting: ['mapping', 'invariants', 'diffVerify'],
}

/** 人审文档的落点（工作区相对路径，`docs/` 下与其它派生产物并列）。 */
export function methodDocRelativePath(pkg: Exclude<MethodChoice, 'none'>): string {
  return `docs/METHOD-${pkg}.md`
}

/** 文档头：`<!-- method-doc: package=oo basis=ab12cd34ef56 -->`。 */
const HEADER = /<!--\s*method-doc:\s*package=([a-z]+)\s*;\s*basis=([0-9a-f]+)\s*-->/u

/** 供回执/文档头使用的规范写法。 */
export function methodDocHeader(pkg: string, basis: string): string {
  return `<!-- method-doc: package=${pkg}; basis=${basis} -->`
}

/**
 * 该包产物的**内容指纹**（12 位十六进制）。
 *
 * 口径：把该包涉及的 `method-<kind>.yml` 文件内容按 kind 名排序后拼接再哈希 ——
 * 任何一次产物写入都会改变指纹，于是"台账变了文档没重生成"可以被机械发现。
 * 台账为空时返回 `-`（调用方据此说明"还没有产物可审"）。
 */
export function methodDocFingerprint(store: SdoStore, pkg: Exclude<MethodChoice, 'none'>): string {
  const parts: string[] = []
  for (const kind of [...PACKAGE_ARTIFACT_KINDS[pkg]].sort()) {
    const text = store.readText('design', `method-${kind}.yml`)
    if (text !== undefined && text.trim() !== '') parts.push(`${kind}\n${text}`)
  }
  if (parts.length === 0) return '-'
  return createHash('sha256').update(parts.join('\n---\n'), 'utf8').digest('hex').slice(0, 12)
}

/** 该包产物里所有条目的 id（复用既有的 `methodTraceables`，不新造遍历逻辑）。 */
export function packageEntryIds(store: SdoStore, pkg: Exclude<MethodChoice, 'none'>): string[] {
  const kinds = new Set<string>(PACKAGE_ARTIFACT_KINDS[pkg])
  return methodTraceables(store)
    .filter((entry) => kinds.has(entry.kind))
    .map((entry) => entry.id)
    .sort()
}

export interface MethodDocStatus {
  pkg: Exclude<MethodChoice, 'none'>
  /** 工作区相对路径 */
  path: string
  exists: boolean
  /** 文档头里声明的指纹（缺失/格式不对时为 `undefined`） */
  declaredBasis?: string | undefined
  /** 插件按台账现算的指纹（台账为空时为 `-`） */
  expectedBasis: string
  /** 台账已变（文档头指纹与现算不一致，或头缺失/不可解析） */
  stale: boolean
  /** 文档里**没有提到**的条目 id */
  missingIds: string[]
}

/**
 * 读文档 + 核对头部与覆盖度。**只读**，不改任何东西。
 *
 * `workspace` 是会话工作区（文档在 `<workspace>/docs/…`）；读不到文件不算错误，
 * 而是 `exists: false`，由调用方（判据/回执）给出可读结论。
 */
export function methodDocStatus(
  store: SdoStore,
  workspace: string,
  pkg: Exclude<MethodChoice, 'none'>,
): MethodDocStatus {
  const path = methodDocRelativePath(pkg)
  const expectedBasis = methodDocFingerprint(store, pkg)
  const ids = packageEntryIds(store, pkg)
  let text: string | undefined
  try {
    text = readFileSync(join(workspace, path), 'utf8')
  } catch {
    text = undefined
  }
  if (text === undefined) {
    return { pkg, path, exists: false, expectedBasis, stale: false, missingIds: ids }
  }
  const matched = HEADER.exec(text)
  const declared = matched?.[2]
  // 文档头里的包名也必须对得上：把 OO 的文档拷成 structured 的（只改文件名）要能发现
  const declaredPkg = matched?.[1]
  const stale = declared === undefined || declaredPkg !== pkg || declared !== expectedBasis
  const missingIds = ids.filter((id) => !text.includes(id))
  return {
    pkg,
    path,
    exists: true,
    ...(declared === undefined ? {} : { declaredBasis: declared }),
    expectedBasis,
    stale,
    missingIds,
  }
}
