import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { disciplineOrAllow, evaluateDiscipline } from '../src/domain/discipline.js'
import { ROLES } from '../src/domain/plan.js'
import {
  listRoleCards,
  maskAllows,
  maskConflicts,
  roleCardPath,
  rolesConsistent,
  toolAllowList,
} from '../src/domain/roles.js'
import { roleToolFilter } from '../src/integration/orchestrator.js'
import { renderBoard } from '../src/board/render.js'
import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, beforeEach } from 'node:test'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)) // lib/test → 包根（skills/ 在这里）
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m7/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

test('M7-01 八张角色卡齐备，且六段式内容非空', () => {
  const cards = listRoleCards()
  assert.equal(cards.length, 8)
  assert.deepEqual(rolesConsistent(cards), { missing: [], extra: [] }, '角色集必须与流程引擎一致')

  for (const card of cards) {
    const path = join(ROOT, roleCardPath(card.code))
    assert.ok(existsSync(path), `缺角色卡 ${path}`)
    const text = readFileSync(path, 'utf8')
    for (const section of ['## 目标', '## 输入契约', '## 输出契约', '## 完成定义', '## 禁止事项', '## 提问 / 评审模板']) {
      assert.ok(text.includes(section), `${card.code} 的卡缺 ${section}`)
    }
    assert.ok(card.rationale.trim() !== '', `${card.code} 缺掩码理由`)
    assert.ok(card.allow.length > 0, `${card.code} 的白名单不能为空`)
  }
})

test('M7-02 掩码表：白名单语义 + 三条硬性禁令 + 无自相矛盾', () => {
  assert.deepEqual(maskConflicts(), [], 'deny 与 allow 不得同时包含同一工具')

  // 三条硬性禁令（计划 T-M7-02 点名）
  assert.equal(maskAllows('analyst', 'sdo_redteam'), false, 'analyst 不得自跑红队')
  assert.equal(maskAllows('developer', 'sdo_review'), false, 'developer 不可见评审（不得自评）')
  assert.equal(maskAllows('tester', 'edit'), false, 'tester 无编辑类工具（不得改被测实现）')

  // 更一般的越界检查
  for (const role of ['red-team', 'reviewer'] as const) {
    for (const tool of ['write', 'edit', 'bash']) {
      assert.equal(maskAllows(role, tool), false, `${role} 不该有 ${tool}`)
    }
  }
  assert.equal(maskAllows('delivery', 'sdo_review'), false)
  assert.equal(maskAllows('architect', 'sdo_requirement'), false, '架构师不改需求')
  assert.equal(maskAllows('office', 'edit'), false, '流程官不碰实现')

  // 白名单语义：allow 之外一律不可见
  assert.equal(maskAllows('developer', 'some-random-tool'), false)
  assert.equal(maskAllows('developer', 'read'), true)

  // 派发时用的工具面与掩码表一致（不允许两份真相）
  for (const role of ROLES) {
    assert.deepEqual(roleToolFilter(role), toolAllowList(role), `${role} 的派发工具面应与掩码表一致`)
  }
})

test('M7-03 阶段纪律：只在 L3 拦、规则可解释、且 fail-open', () => {
  const base = { gateLevel: 'strict' as const, phase: 'requirements', role: 'developer', tool: 'write', initialized: true }

  // L1/L2 不拦（观察阶段）
  assert.equal(evaluateDiscipline({ ...base, gateLevel: 'enforce' }).kind, 'allow')
  assert.equal(evaluateDiscipline({ ...base, gateLevel: 'suggest' }).kind, 'allow')

  // 未初始化 → 只许 sdo_init
  assert.equal(evaluateDiscipline({ ...base, initialized: false, tool: 'sdo_init' }).kind, 'allow')
  assert.equal(evaluateDiscipline({ ...base, initialized: false }).kind, 'deny')

  // 基线前不许写设计
  assert.equal(evaluateDiscipline({ ...base, phase: 'requirements', tool: 'sdo_design' }).kind, 'deny')
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'sdo_design' }).kind, 'allow')

  // 非实现阶段不许写 src/ 代码；实现阶段放行
  assert.equal(evaluateDiscipline({ ...base, phase: 'architecture', tool: 'write', paths: ['src/x.ts'] }).kind, 'deny')
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'write', paths: ['src/x.ts'] }).kind, 'allow')
  // 文档类写入不受限
  assert.equal(evaluateDiscipline({ ...base, phase: 'requirements', tool: 'write', paths: ['docs/SRS.md'] }).kind, 'allow')

  // 真源不可手改
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'write', paths: ['.sdo/journal.jsonl'] }).kind, 'deny')

  // 驾驶舱不受阶段纪律约束（纪律只约束派发出去的角色）
  assert.equal(evaluateDiscipline({ ...base, role: 'cockpit', tool: 'write', paths: ['src/x.ts'] }).kind, 'allow')

  // fail-open：策略抛错时必须放行
  let reported: unknown
  const decision = disciplineOrAllow(
    {
      ...base,
      get tool(): string {
        throw new Error('boom')
      },
    } as never,
    (error) => {
      reported = error
    },
  )
  assert.equal(decision.kind, 'allow', '钩子异常必须放行（fail-open）')
  assert.equal(decision.reason, 'discipline hook failed open')
  assert.ok(reported instanceof Error)
})

let workspace: string
let office: SoftwareDevOffice
beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M7 测试', scale: 'normal', stakeholders: ['业务方'] })
})
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M6-02 文本看板：幂等（同状态两次逐字节相同）且含任务/迭代/门禁', () => {
  office.updateProject(call(), { scopeIn: ['对账'], scopeOut: ['自动调账'], metricsSuccess: ['识别率 ≥ 99%'], glossary: { 差异: '不一致' } })
  office.startIteration(call(), '最小闭环')
  office.planDecompose(call(), {
    suggestions: [{ title: '实现核心', dod: ['验收标准通过'], role: 'developer', writeScopes: ['src/core/'], size: 'small' }],
  })
  const model = () => {
    const status = office.status(call())
    return {
      project: status.project,
      config: status.config,
      counts: status.counts,
      gates: office.gatesFor(call()),
      requirements: office.boardRequirements(call()),
      process: office.process(call()),
      pendingGate: status.pendingGate,
      tasks: office.tasks(call()),
      iteration: office.iteration(call()),
      dataDirName: '.sdo',
      truncated: status.truncated,
    }
  }
  const first = renderBoard(model())
  const second = renderBoard(model())
  assert.equal(first, second, '看板必须幂等（同状态逐字节相同）')

  const withAll = renderBoard(model(), { all: true })
  assert.ok(withAll.length >= first.length)
  assert.match(first, /立项/u)
  assert.match(first, /门禁/u)
  assert.match(withAll, /任务卡|迭代|可派发/u, '任务/迭代信息应进入看板')
})
