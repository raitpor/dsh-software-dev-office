/**
 * 测试支撑：为某个方法包写一份**合法的人审文档**（`docs/METHOD-<包>.md`）。
 *
 * 口径与实现一致（`src/domain/methodDocs.ts`）：文档头 `<!-- method-doc: package=<包>; basis=<指纹> -->`
 * 里的指纹必须等于按**当前台账**现算的值，正文必须覆盖该包每个条目 id。
 * 用例可以用 `basis` 参数故意写错（测"过期"分支）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SdoStore } from '../../src/infra/store.js'
import {
  methodDocFingerprint,
  methodDocHeader,
  methodDocRelativePath,
  packageEntryIds,
  PACKAGE_ARTIFACT_KINDS,
} from '../../src/domain/methodDocs.js'
import type { MethodChoice } from '../../src/types.js'

export function writeMethodDoc(
  workspace: string,
  store: SdoStore,
  pkg: Exclude<MethodChoice, 'none'>,
  options: { basis?: string | undefined; omitIds?: string[] | undefined; body?: string | undefined } = {},
): string {
  const path = join(workspace, methodDocRelativePath(pkg))
  mkdirSync(dirname(path), { recursive: true })
  const basis = options.basis ?? methodDocFingerprint(store, pkg)
  const omit = new Set(options.omitIds ?? [])
  const ids = packageEntryIds(store, pkg).filter((id) => !omit.has(id))
  const lines = [
    methodDocHeader(pkg, basis),
    '',
    `# ${pkg} 方法产物（人审文档）`,
    '',
    `本文件覆盖的产物种类：${PACKAGE_ARTIFACT_KINDS[pkg].join(' / ')}。`,
    '',
    ...ids.map((id) => `- ${id}：条目说明（人工审核用）。`),
    '',
    options.body ?? '',
    '',
  ]
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}
