/**
 * **增量 155：门禁失效接进派发面（DEF-040 第二刀：接线 / §3E 族 6）**。
 *
 * 第一刀（`test/m154`）落了**判据逻辑**：`readyTasks(tasks, limit, staleGate)` 与
 * `classifyNonDispatchable(tasks, staleGate)` 能表达"当前阶段入口门禁失效 ⇒ 不派"。
 * 本刀把 `office.ts` 的**三处派发调用点**接上：`readyForDispatch` / `dispatchPlan` / `poolSnapshot`
 * 都改为传 `this.staleEntryGate(call)`（由流程数据 `phases[].entry` + `signatureState` 组装）。
 *
 * **口径（本用例钉住的正是这一条）**：只拦 `status === 'stale'`；`missing`（从来没签过）**放行** ——
 * 否则所有还没走到该门禁签字的正常流程会一律停摆。
 *
 * ⚠️ **判据的唯一出口是 `src/domain/entryGate.ts` 的 `staleEntryGateOf`**（第三刀把 `claim` 也接到
 * 同一个函数上，两处各写一遍必然漂移）⇒ `office.ts` 这里只做**装配**，M155-02 的判据断言因此扫的是
 * `entryGate.ts`（行为两态、`missing` 放行、换一份流程数据，见 `test/m156`）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { createTask } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoStore } from '../src/infra/store.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m155/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M155 门禁失效不派', scale: 'normal', stakeholders: ['业务方'] })
  store = office.storeFor(WORKSPACE)
  journal = new Journal(store)
  services = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  services['tools'] = { register: () => () => {} }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M155-01 反例（口径底线）：入口门禁**从没签过**（missing）⇒ 照常可派，不许停摆', () => {
  const id = createTask(store, journal, { title: '夹具卡', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/a/'] } as never).id
  const ready = office.readyForDispatch(call, 4).map((task) => task.id)
  assert.deepEqual(ready, [id], `missing 必须放行（否则所有还没走到该门禁签字的正常流程会停摆）：${JSON.stringify(office.readyForDispatch(call, 4))}`)
})

test('M155-02 结构：三处派发调用点都接了门禁状态，且判据收敛到唯一出口（domain/entryGate.ts）', () => {
  const officeSource = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  const wired = officeSource.split('this.staleEntryGate(call)').length - 1
  assert.equal(
    wired,
    4,
    `四处消费点都要接线（readyForDispatch / dispatchPlan / poolSnapshot 三处派发 + nonDispatchable 一处回执），实际 ${wired} 处`,
  )
  // 派发面**只装配**：判据委托唯一出口（认领面调的是同一个函数，见 test/m156 的 M156-05）
  assert.equal(
    officeSource.includes('return staleEntryGateOf(store, journal, project)'),
    true,
    '派发面必须委托唯一出口 staleEntryGateOf，不得自己重算签字',
  )

  const source = readFileSync(join(ROOT, 'src', 'domain', 'entryGate.ts'), 'utf8')
  assert.equal(source.includes('entryGates(process, project.phase)'), true, '门禁 id 必须取自流程数据的 phases[].entry')
  assert.equal(source.includes("state.status === 'stale'"), true, '判别位必须是 stale（不是 !== valid，也不是 missing）')
  // 反向：不许出现写死的门禁 id 参与这条判据
  // 只扫**代码行**：注释里正当地举了"各流程各阶段入口不同（G3 / G4 / GP）"的反例，扫注释会造出假阳性（本用例第一版就踩了）
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
  assert.equal(/['"]G[0-9]['"]/u.test(codeOnly), false, '这条判据的代码里不许出现写死的门禁 id（如 G3）')
})
