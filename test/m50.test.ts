/**
 * **SDO-53 的插件侧一半**：公告清单 ≠ 实际可调。
 *
 * 真机上两个方向都出现过：① **公告多于实际**（子代理自报 10 个工具，同一派发公告 12 个）；
 * ② **掩码外仍可调用**（`sdo_plan`/`sdo_review`/`sdo_gate` 靠 B6 钩子兜底拦下）。
 * 插件不承诺"宿主一定收窄"，但必须把**差集**显式说出来 —— 观测（`evidence/child-tools.jsonl`）本来就在，
 * 缺的只是与「我们声明的面」对账。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { faceDiff, recordChildFace } from '../src/domain/dispatchFace.js'
import { toolAllowList } from '../src/domain/roles.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm50')
let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal

const call = (): { sessionId: string; cwd: string } => ({ sessionId: 's-cockpit', cwd: BASE })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', BASE)
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('faceDiff：声明面与实测面的差集（缺 = 能力静默缺失；多 = 收窄没生效）', () => {
  assert.deepEqual(faceDiff(['read', 'read_image'], ['read']), { missing: ['read_image'], extra: [] })
  assert.deepEqual(faceDiff(['read'], ['read', 'sdo_gate']), { missing: [], extra: ['sdo_gate'] })
  assert.deepEqual(faceDiff(['read'], ['read']), { missing: [], extra: [] })
  assert.deepEqual(faceDiff([], ['x']), { missing: [], extra: ['x'] })
})

test('SDO-53 / R-10：声明的 `sdo_*` 面 vs 实测面 —— 两个方向都要报，但**通用面不算"多"**', () => {
  // 真机形状：developer 被派卡（`dispatch/started` 记了角色），子代理实测面缺 `read_image`、多 `sdo_gate`
  journal.append('dispatch/started', { task: 'TASK-001', childSessionId: 'c1111111', role: 'developer', tools: 9, mode: 'continuable' })
  const declared = toolAllowList('developer')
  recordChildFace(store, {
    childSessionId: 'c1111111',
    tools: declared.filter((name) => name !== 'read_image').concat('sdo_gate'),
    violations: [],
  })
  const rows = office.faceMismatches(call())
  assert.equal(rows.length, 1, `差集必须被报出来：${JSON.stringify(rows)}`)
  assert.deepEqual(rows[0]?.missing, ['read_image'], '声明的**只读检视面**缺了 ⇒ 缺（真机就是这样看不见图的）')
  assert.deepEqual(rows[0]?.extra, ['sdo_gate'], '`sdo_*` 里不在本角色 allow 的 ⇒ 多（收窄没生效，靠钩子兜底）')
  assert.equal(rows[0]?.task, 'TASK-001')

  // **R-10 的核心断言**：通用面（记忆/技巧/子代理控制…）是**有意继承**的，不许再被算成"多"
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  const general = ['memory_search', 'memory_save', 'technique_apply', 'technique_search', 'send_message', 'list_agents', 'interrupt_agent', 'failure_list', 'failure_resolve', 'read_image']
  recordChildFace(store, { childSessionId: 'c1111111', tools: [...declared, ...general], violations: [] })
  assert.deepEqual(office.faceMismatches(call()), [], '通用面继承宿主默认 ⇒ 一个字都不该报（旧口径在这里挂了一整条误导警告）')

  // 反向：真的拿到**被禁止**的工具 ⇒ 照报
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  recordChildFace(store, {
    childSessionId: 'c1111111',
    tools: [...declared, 'sdo_gate', 'subagent', 'exit_plan_mode'],
    violations: [],
  })
  const forbiddenRows = office.faceMismatches(call())
  assert.deepEqual(
    forbiddenRows[0]?.extra,
    ['exit_plan_mode', 'sdo_gate', 'subagent'],
    '被 deny / 执行者禁令挡住的工具出现了就要报（`write` 不在 developer 的 deny 里 ⇒ 不该报）',
  )

  // 老事件没有角色 / 没有观测 ⇒ 不猜（如实返回空）
  journal.append('dispatch/started', { task: 'TASK-002', childSessionId: 'c2222222', tools: 9 })
  rmSync(join(BASE, '.sdo', 'evidence'), { recursive: true, force: true })
  recordChildFace(store, { childSessionId: 'c2222222', tools: ['read'], violations: [] })
  assert.deepEqual(office.faceMismatches(call()), [], '认不出角色的老事件按"不猜"处理')
})

test('SDO-53（接线）：`status` 回执里必须带上差集告警', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(source, /office\.faceMismatches\(call\)/u, 'status 要调比对')
  assert.match(source, /kFaceMismatch/u, '差集要有可读告警')
  assert.match(source, /faceMismatchBlock/u, '并且要真的拼进回执')
})
