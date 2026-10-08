/**
 * 评审员 2026-10-05 复审（`.review/2026-10-05-真机缺陷批量修复SDO16-30的评审（评审员）.md` §2）的回归：
 *
 * **新问题（minor）**：`truth/file-written` 把「任何 `.sdo/` 真源写入」都算成「会改 `DESIGN.md` 的真源」，
 * 于是手改一个**构造期**文件（`.sdo/construction/tdd.yml`）也会让 C-25 判 `DESIGN.md` 陈旧 ——
 * 正是 `DESIGN_DOC_SOURCE_EVENTS` 注释里自己警告过的「报警疲劳」（那里特意不列 `phase/*` 就是这个理由）。
 *
 * 修法（采纳评审员的建议①）：**C-25 侧按路径前缀收敛**到设计文档真正渲染的真源；
 * **G3 签字失效那一面保持不变**（任何真源直写都失效 —— 宁可重签，也别静默放过）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { isDesignDocSourceEvent } from '../src/domain/gates.js'
import { isDesignDocTruthPath, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm41')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('SDO-19 复审：`DESIGN.md` 的真源路径口径 —— 设计类算、构造/测试/成本类不算', () => {
  for (const path of [
    '.sdo/design/component.yml',
    '.sdo/contracts/CT-001.yml',
    '.sdo/decisions/ADR-001.yml',
    '.sdo/quality/q.yml',
    '.sdo/requirements/REQ-001.yml',
    '.sdo/questions/Q-001.yml',
    '.sdo/risks/RISK-001.yml',
    '.sdo/project.json',
  ]) {
    assert.equal(isDesignDocTruthPath(path), true, `${path} 会改 DESIGN.md ⇒ 算文档真源`)
  }
  for (const path of [
    '.sdo/construction/tdd.yml',
    '.sdo/tests/TC-001.yml',
    '.sdo/costs/cost.yml',
    '.sdo/tasks/TASK-001.yml',
    '.sdo/gates/G3.json',
    '.sdo/evidence/child-tools.jsonl',
    '.sdo/changes/CR-001.yml',
  ]) {
    assert.equal(isDesignDocTruthPath(path), false, `${path} 不进 DESIGN.md ⇒ 不算（否则报警疲劳）`)
  }
})

test('SDO-19 复审：C-25 的谓词按路径分流；拿不到 `docSource`/`path` 时仍保守算作会改文档', () => {
  // ① 设计类直写 ⇒ 文档判陈旧
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/design/component.yml', docSource: true } }), true)
  // ② 构造期直写 ⇒ **不**判陈旧（本次修的就是这一条）
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/construction/tdd.yml', docSource: false } }), false)
  // ③ 旧事件（没有 docSource）：回退到路径判定
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/design/x.yml' } }), true, '旧事件按路径回退')
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: { path: '.sdo/construction/tdd.yml' } }), false)
  // ④ 路径也读不出 ⇒ 保守算作会改文档（黑名单方向不变）
  assert.equal(isDesignDocSourceEvent({ type: 'truth/file-written', data: {} }), true)
  // ⑤ 既有两条口径不受影响
  assert.equal(isDesignDocSourceEvent({ type: 'trace/linked', data: { kind: 'req-task' } }), false, '施工期覆盖边不进文档（SDO-18）')
  assert.equal(isDesignDocSourceEvent({ type: 'trace/linked', data: { kind: 'req-des' } }), true)
  assert.equal(isDesignDocSourceEvent({ type: 'design/updated' }), true)
  assert.equal(isDesignDocSourceEvent({ type: 'phase/entered', data: { phase: 'construction' } }), false, '阶段流转不判文档陈旧（既有口径）')
  assert.equal(isDesignDocSourceEvent({ type: 'task/claimed', data: { id: 'TASK-001' } }), false)
})

test('SDO-19 复审：写入侧一个事件带两种事实 —— 构造期写入仍**失效 G3 签字**（评审员的取向：宁可重签）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  mkdirSync(join(BASE, '.sdo', 'construction'), { recursive: true })
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store.writeText(['construction', 'tdd.yml'], 'tdd:\n  mutations: 3\n', { mode: 0o600 })
  store.writeText(['design', 'component.yml'], 'view:\n  kind: component\n', { mode: 0o600 })

  const recorded = office.noteTruthFileWrites(call, ['.sdo/construction/tdd.yml', '.sdo/design/component.yml'])
  assert.equal(recorded, 2, '两笔都要入账（构造期写入也要留痕 + 快照）')
  const events = journal.read().events.filter((event) => event.type === 'truth/file-written')
  const byPath = new Map(events.map((event) => [String(event.data.path), event.data]))
  assert.equal(byPath.get('.sdo/construction/tdd.yml')?.docSource, false, '构造期：不算文档真源（C-25 不再误判陈旧）')
  assert.equal(byPath.get('.sdo/design/component.yml')?.docSource, true, '设计期：算文档真源')

  // **两面分开**：文档新鲜度按路径收敛，但"真源被直写"这件事对签字一律作废
  for (const path of ['.sdo/construction/tdd.yml', '.sdo/design/component.yml']) {
    assert.equal(byPath.has(path), true, `${path} 要留痕`)
  }
  assert.equal(isSignatureInvalidatingEvent('G3', 'truth/file-written'), true, '任何真源直写都作废 G3 签字（口径不变）')
})
