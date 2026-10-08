/**
 * 真机报告（2026-10-05 23:00 追加）新增三条的回归。
 *
 *   · **SDO-30b**：派发排序读不出「必须最后跑」的语义 —— 最终全量构建卡（TASK-132）与写卡同时就绪时被
 *     **并发**派出，跑出的 jar 必然过期（少了同批写卡的改动）。`blockedBy` 只能表达"排在某几张卡之后"，
 *     表达不了"排在**所有**卡之后"。修法：支持 **`blockedBy: ['*']`**（通配依赖），并保证：
 *     ① 依赖存在性校验不把 `*` 当"不存在的卡"；② 依赖环遍历跳过它；③ 其它卡没做完前它不 ready；
 *     ④ 「等 `*`」的卡在"为什么还不能派"里如实显示。
 *   · **SDO-32 / SDO-31** 是**纪律类**发现（空集合假绿 / 评审清单当可执行清单），落在角色卡上：
 *     这类知识只有在执行者真会读到的位置才有用，所以用例钉的是"角色卡里确实写了这几条"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { loadPackagedYaml } from '../src/infra/data.js'
import { blockedTasks, readyTasks, validatePlan } from '../src/domain/plan.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm42')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...overrides,
  }
}

test('SDO-30b：`blockedBy: [\'*\']` 的卡必须等到**其它所有卡**都完成才 ready（独占窗口）', () => {
  const finale = card('TASK-132', { blockedBy: ['*'] })
  const writer = card('TASK-133')
  const done = card('TASK-130', { status: 'done' })

  // ① 还有别的卡没完成 ⇒ 最终卡不 ready（write 卡照常 ready）
  const early = readyTasks([finale, writer, done], 8).map((task) => task.id)
  assert.deepEqual(early, ['TASK-133'], `最终卡不许与写卡并发派出：${early.join(' ')}`)
  const waiting = blockedTasks([finale, writer, done]).find((item) => item.task.id === 'TASK-132')
  assert.deepEqual(waiting?.waitingOn, ['*'], '要如实说明它在等"所有其它卡"')

  // ② 其它卡全部完成 ⇒ 最终卡 ready
  const late = readyTasks([finale, { ...writer, status: 'done' }, done], 8).map((task) => task.id)
  assert.deepEqual(late, ['TASK-132'], '所有卡完成后最终卡才放行')

  // ③ 作废（dropped）的卡不该把它永久挡住
  const dropped = card('TASK-136', { status: 'dropped' })
  const withDropped = readyTasks([finale, { ...writer, status: 'done' }, dropped], 8).map((task) => task.id)
  assert.deepEqual(withDropped, ['TASK-132'], 'dropped 不算"还没做完"')

  // ④ 计划校验不许把 `*` 当成"引用了不存在的卡"，也不许判成环
  const issues = validatePlan([finale, writer])
  assert.deepEqual(issues.map((item) => item.code), [], `\`*\` 是通配依赖：${JSON.stringify(issues)}`)
})

test('SDO-32 / SDO-31：纪律落在角色卡上（空集合假绿 / 评审清单是假设）——执行者真会读到的位置', () => {
  const tester = readFileSync(join(ROOT, 'skills', 'role-tester.md'), 'utf8')
  assert.match(tester, /空集合断言/u, '测试角色卡要写"空集合断言"这一形态')
  assert.match(tester, /先断言集合非空|先证集合非空/u, '要给出可执行的动作（先证非空）')
  assert.match(tester, /负向对照/u, '负向对照要先证"修复前触发过"')
  assert.match(tester, /变异自证|把被测逻辑改坏/u, '恒真断言要用变异自证抓')

  const reviewer = readFileSync(join(ROOT, 'skills', 'role-reviewer.md'), 'utf8')
  assert.match(reviewer, /已核实 \/ 待核实/u, 'finding 必须自标"已核实/待核实"')
  assert.match(reviewer, /不是动作项|不得被当成 DoD 的动作清单/u, '要写明"待核实项不是动作项"')

  const developer = readFileSync(join(ROOT, 'skills', 'role-developer.md'), 'utf8')
  assert.match(developer, /待核对的假设，不是可执行清单/u, '承接评审清单前先逐条机械复核')
  assert.match(developer, /验证.*而不是采信|默认动作是\*\*验证\*\*/u, '默认动作是验证而非采信')
})

test('语言包守卫补强：两个包必须**解析成功**（YAML 打坏时 `t()` 会静默回退成键名，M11/DoR 那批用例才会红）', () => {
  // 真机 2026-10-05（本轮自曝）：往双引号 YAML 值里写 ASCII 双引号把整包打坏，
  // `t()` 于是回退成键名（`pkgMissing；pkgNotSelected；…`），而**语言包守卫本身没红** ——
  // 是 M11/DoR 那批"正文对不上"的用例替它报的警。这里补一条直球守卫：解析必须成功。
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const tables = loadPackagedYaml(`src/data/lang/${file}`) as Record<string, Record<string, string>>
    // 各区段抽查一个键：值不能等于键名（等于键名 = 该区段整段没解析出来）
    for (const [section, key] of [['uiMethod', 'pkgMissing'], ['uiDesign', 'docElementResp'], ['param', 'suggestions'], ['uiIndex', 'kFreshChild']] as const) {
      const value = tables[section]?.[key]
      assert.notEqual(value, undefined, `${file} 缺 ${section}.${key}`)
      assert.notEqual(value, key, `${file} 的 ${section}.${key} 回退成了键名（多半是 YAML 没解析出来）`)
    }
  }
})
