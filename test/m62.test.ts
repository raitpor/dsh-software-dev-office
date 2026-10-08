/**
 * 第二轮整体评审 §3.2（HIGH）：**`ui` 声明的两个方向口径不一致** ——
 *
 *   · 声明 `viewsPresent:[ui]` 而没有界面真源 ⇒ C-20 判**红**（Y-4 已修，方向 ①）；
 *   · 声明 `viewsAbsent:[{kind:ui}]` 而项目**确有界面**（`surfaces:[web]`）⇒ C-20 却 **N/A/绿**
 *     ⇒ 用户签字绑定的声明与项目自己的表面声明互相矛盾，门禁一个字都不说（§3.2 的洞，方向 ②）。
 *
 * 判据口径（修后只有一份）：**声明里的 `ui` 必须与 `uiDecision`（需求 kind=ui 或项目 `surfaces`）方向一致** ——
 * `present ⟺ hasUi`。方向上"说不做、实际有"和"说要、实际没有"都是矛盾，都要判红并给出可执行补救；
 * 方向一致时（说要 + 有界面）C-20 只判"声明齐备"，界面确认另由 C-27（`ui.confirmed`）负责，**不重复判**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { CHECKERS } from '../src/domain/gates.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { VIEW_KINDS } from '../src/types.js'
import type { GateContext } from '../src/domain/gates.js'
import type { DesignApplicability } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm62')
let store: SdoStore
let journal: Journal

function context(surfaces: string[]): GateContext {
  return {
    workspace: BASE,
    store,
    journal,
    requirements: [],
    project: { surfaces },
  } as unknown as GateContext
}

function declaration(viewsAbsent: { kind: string; why: string }[], viewsPresent: string[] = [...VIEW_KINDS]): void {
  const app: DesignApplicability = {
    focus: '对账系统重构',
    viewsPresent: viewsPresent as DesignApplicability['viewsPresent'],
    viewsAbsent: viewsAbsent as DesignApplicability['viewsAbsent'],
    artifacts: [],
    artifactsAbsent: [],
    draftedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  store.writeYaml(['design', 'applicability.yml'], { applicability: app })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  // 五视图齐备且非空 —— 让 C-20 的**唯一**变量只剩 `ui` 那两个方向。
  for (const kind of VIEW_KINDS) {
    store.writeYaml(['design', `${kind}.yml`], {
      view: {
        kind,
        summary: `${kind} 视图`,
        elements: [
          { id: `DES-${kind}`, name: `${kind} 元素`, kind: 'service', responsibility: 'r', dependsOn: [], requires: [], confidence: 'medium' },
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
  }
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M62-01 §3.2：声明"不做界面视图"而项目有 web 表面 ⇒ C-20 必须判红（不许静默 N/A）', () => {
  declaration([{ kind: 'ui', why: '界面由既有系统承担' }])
  const result = CHECKERS['design.views']?.(context(['web']))
  assert.equal(result?.ok, false, `声明与 surfaces 矛盾时必须判红：${JSON.stringify(result)}`)
  assert.equal(result?.na, undefined, '这不是"不适用"，是自相矛盾（N/A 会看起来像门禁没意见）')
  assert.match(result?.detail ?? '', /web/u, '要点名是哪个表面在跟声明打架')
  assert.match(result?.remedy ?? '', /surfaces|viewsAbsent|viewsPresent/u, '补救要给出可执行动作（改真源或改声明）')
})

test('M62-02 §3.2 反向（不许拦错）：声明"不做界面视图"且项目确实没有界面 ⇒ **不许判红**', () => {
  declaration([{ kind: 'ui', why: '界面由既有系统承担' }])
  const result = CHECKERS['design.views']?.(context([]))
  assert.equal(result?.ok, true, `方向一致（说不做 + 真源确实没有界面）时不许判红：${JSON.stringify(result)}`)
  assert.equal(result?.na, undefined, 'C-20 的 N/A 只表示"五视图没全要求"，`ui` 的适用性由 C-27 现算，这里不借它表达')
  assert.match(result?.detail ?? '', /五视图/u, '本条只声称五视图齐备，不许声称"界面视图也齐备"')
})

test('M62-03 §3.2 另一方向仍在（Y-4 不许被这次修改放松）：声明"要做界面视图"但无任何界面真源 ⇒ 判红', () => {
  declaration([], [...VIEW_KINDS, 'ui'])
  const result = CHECKERS['design.views']?.(context([]))
  assert.equal(result?.ok, false, `声明要做 ui 却无界面真源必须判红：${JSON.stringify(result)}`)
  assert.match(result?.detail ?? '', /ui|界面/u)
})

test('M62-04 §3.2 正向不误伤：声明"要做界面视图"且项目有 web 表面 ⇒ C-20 通过（界面确认归 C-27，不在本条重复判）', () => {
  declaration([], [...VIEW_KINDS, 'ui'])
  const result = CHECKERS['design.views']?.(context(['web']))
  assert.equal(result?.ok, true, `方向一致时 C-20 只判声明齐备：${JSON.stringify(result)}`)
})
