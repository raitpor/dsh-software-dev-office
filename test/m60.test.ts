/**
 * **§3.3（第二轮评审 HIGH）**：同一条 `diffVerify` 判据有**两套实现** —— porting 包查枚举取值 /
 * `baselineRef` / `controlRepo`，设计适用性侧（`missingArtifacts`）只查两个字段非空，而文件头却自称
 * "两条判据…互不放松"。真机复现：`baselineSource: '我的直觉'` + `baselineRef: ''` ⇒ 适用性侧返回 `[]`（放过）。
 * 现在两侧**共用** `diffVerifyGaps`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { SdoStore } from '../src/infra/store.js'
import { missingArtifacts } from '../src/domain/applicability.js'
import { diffVerifyGaps } from '../src/domain/method.js'
import type { DesignApplicability } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm60')
let store: SdoStore

const app = (): DesignApplicability => ({
  artifacts: ['diffVerify'], artifactsAbsent: [], viewsPresent: [], viewsAbsent: [],
} as unknown as DesignApplicability)

const writeStrategy = (fields: Record<string, unknown>): void => {
  // 真源形状：`artifact.diffVerify` 里才是策略字段（`normalizeMethodArtifact` 按这个键读）
  store.writeYaml(['design', 'method-diffVerify.yml'], { artifact: { kind: 'diffVerify', diffVerify: { ...fields } } })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('§3.3：非法基线来源 / 空 baselineRef 必须被适用性侧判为缺失（旧实现放过）', () => {
  writeStrategy({ sameInputSameOutput: '同输入同输出', baselineSource: '我的直觉', baselineRef: '' })
  assert.ok(diffVerifyGaps({ sameInputSameOutput: '同输入同输出', baselineSource: '我的直觉', baselineRef: '' } as never).length > 0, '共享判据本身要能挑出来')
  assert.deepEqual(missingArtifacts(app(), store), ['diffVerify'], '§3.3：适用性侧必须与 porting 侧同一口径')

  // 上游分支但没给对照仓库 ⇒ 也要挑出来
  writeStrategy({ sameInputSameOutput: '同输入同输出', baselineSource: 'upstream-branch', baselineRef: 'v1.2.0', controlRepo: '' })
  assert.deepEqual(missingArtifacts(app(), store), ['diffVerify'])

  // 合法策略 ⇒ 不再列缺失
  writeStrategy({ sameInputSameOutput: '同输入同输出', baselineSource: 'golden-samples', baselineRef: 'samples/v1', controlRepo: '' })
  assert.deepEqual(missingArtifacts(app(), store), [], '合法策略不得误报')
})
