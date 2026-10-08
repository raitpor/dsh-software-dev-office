/**
 * **D7（整仓评审 major）**：`waterfall.yml` 的 C-31 写「任务卡齐备（DoD/依赖/**写范围**）」，但旧实现不校验
 * "写范围非空"，而空写范围在互斥判断里不冲突、在 `auditWriteScopes` 里"写哪儿都不算越界"
 * （实测 `auditWriteScopes(['outside/x.ts'], [])` = ok）⇒ 卡可以既不占位也不受审计。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validatePlan } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

function card(id: string, writeScopes: string[]): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1, status: 'ready',
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
}

test('D7：空写范围必须成为计划问题（C-31 才名副其实）', () => {
  const empty = validatePlan([card('TASK-001', [])])
  assert.ok(empty.some((issue) => issue.code === 'write-scope-empty'), `应报 write-scope-empty：${JSON.stringify(empty)}`)

  const filled = validatePlan([card('TASK-002', ['src/booking/'])])
  assert.equal(filled.filter((issue) => issue.code === 'write-scope-empty').length, 0, '有写范围时不得误报')

  // 只有空白字符也算"没写范围"（`[' ']` 不能糊过去）
  assert.ok(validatePlan([card('TASK-003', ['   '])]).some((issue) => issue.code === 'write-scope-empty'))

  // 评审复现的 leaf 行为（`auditWriteScopes(['outside/x.ts'], [])` 返回 ok）在 `collab.ts` 内部、未导出，
  // 这里只钉住"必须在**计划层**拦"这一半：空/纯空白写范围 ⇒ `write-scope-empty`（上两条）。
  assert.equal(validatePlan([card('TASK-004', ['src/a/', ''])])
    .filter((issue) => issue.code === 'write-scope-empty').length, 0, '只要有一个有效范围就不报')
})
