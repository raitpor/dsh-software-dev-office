/**
 * **增量 197：`H` 补核里两条"无守卫"的收口（第十二批 §3.9 的后续）。**
 *
 * `H` 逐条核 `method-invariants` 时，`INV-006`（运行时零第三方依赖）与 `INV-008`（注入块 ≤ 1500 字符）
 * 只有**事实/常量**、没有守卫用例。本文件各补一格：
 *   · `M197-01` = `INV-006`：`package.json` 的**运行时**依赖只有官方包（`dependencies` 为空 + `peerDependencies` 全 `@deepseek-ai/*`）；
 *   · `M197-02` = `INV-008`：信息量最大的状态也**不得超过 1500 字符**，且被截断时**必须带截断标记**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { renderStatusBlock } from '../src/interface/inject.js'
import { t } from '../src/domain/i18n.js'
import type { StatusSnapshot } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('M197-01 §3.9（`INV-006`）运行时零第三方依赖：`dependencies` 为空，`peerDependencies` 全是官方 `@deepseek-ai/*`', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  const official = (name: string): boolean => name.startsWith('@deepseek-ai/')
  // ① 运行时 `dependencies` 必须为空（有依赖就说明离线包不再"零第三方"）
  assert.deepEqual(pkg.dependencies ?? {}, {}, '运行时 `dependencies` 必须为空（INV-006）')
  assert.deepEqual(pkg.optionalDependencies ?? {}, {}, '可选依赖同样会进运行时闭包 ⇒ 必须为空')
  // ② peer 依赖只许官方包
  const peers = Object.keys(pkg.peerDependencies ?? {})
  assert.ok(peers.length > 0, '前置：本插件确实声明了 peer 依赖（宿主面）')
  assert.deepEqual(peers.filter((name) => !official(name)), [], `peer 依赖只许官方包：${peers.filter((name) => !official(name)).join(' / ')}`)
})

test('M197-02 §3.9（`INV-008`）注入块 ≤ 1500 字符：信息量最大时截断且**必须带截断标记**', () => {
  const LIMIT = 1500
  const statusOf = (criteriaCount: number): StatusSnapshot => ({
    dataDir: '/ws/.sdo',
    project: {
      id: 'PRJ-001', name: 'p', phase: 'construction', scale: 'standard', process: 'waterfall',
      createdAt: '', updatedAt: '', iteration: undefined, prototypeDir: 'prototype',
    } as unknown as StatusSnapshot['project'],
    rebuilt: false, truncated: false,
    counts: { requirements: 120, questions: 60, risks: 40, issues: 30, tasks: 90, reviews: 20 } as unknown as StatusSnapshot['counts'],
    config: { process: 'waterfall', scale: 'standard', redTeam: 'on', gateLevel: 'enforce', projectDir: '.sdo' } as unknown as StatusSnapshot['config'],
    configSource: 'file',
    pendingGate: 'G5',
    lastGate: {
      gate: 'G5', phase: 'construction', status: 'failed', at: '', persisted: true, remedy: [],
      criteria: Array.from({ length: criteriaCount }, (_unused, index) => ({
        id: `C-${index}`, ok: index % 3 !== 0, detail: `判据 ${index} 的说明文字（含路径 src/domain/file-${index}.ts 与读数 ⇒ 1 fail）`,
      })),
    } as unknown as StatusSnapshot['lastGate'],
    riskConclusion: undefined,
    risks: { total: 40, open: 12, blockers: 3, high: 9 },
    openIssues: 30, feasibilityVerdict: undefined, changes: 7,
  })
  // ① 上限本身：信息量最大时也必须 ≤ 1500
  const big = renderStatusBlock(statusOf(80), '.sdo', LIMIT)
  assert.ok(big.length <= LIMIT, `注入块必须 ≤ ${LIMIT} 字符（实际 ${big.length}）`)
  // ② 真的发生截断时必须**说出来**（带截断标记）：用一个很小的上限逼出截断路径（确定性）
  const clamped = renderStatusBlock(statusOf(80), '.sdo', 120)
  assert.ok(clamped.length <= 120, `上限 120 时也必须在界内（实际 ${clamped.length}）`)
  assert.ok(clamped.includes(t('status.clampMarker')), '被截断时必须带语言包里的截断标记（不是自造文案）')
  // ③ 平常的状态块远小于上限（说明上界不是靠"本来就不长"蒙过去的，截断路径也确实在别处生效）
  assert.ok(big.length < LIMIT, '常规最大态的块仍在上界之内')
  // ③ 信息量小的状态**不许**被截断（截断是例外，不是常态）
  const small = renderStatusBlock(statusOf(1), '.sdo', LIMIT)
  assert.equal(small.length <= LIMIT, true, '小状态同样 ≤ 上限')
  assert.equal(small.includes(t('status.clampMarker')), false, '小状态不许出现截断标记')
})
