/**
 * **增量 165：第三批残留 R6（§3.19）+ R7（§3.20）** —— 两条"口径/类型面"残留。
 *
 * **R6：`StructuralSkipReason` 类型面说谎**。修前现盘：`types.ts` 的联合只有
 * `already-covered | no-card-needed | scope-too-broad`，而 `plan.ts` 会产出 `'no-basis'`
 * （靠 `as unknown as StructuralSkip` 强塞）、`describe.ts` 只好就地加宽
 *（`StructuralSkipReasonWithBasis = StructuralSkipReason | 'no-basis'`）⇒ **运行期正确、类型面说谎**。
 * 修法：`'no-basis'` 收进正式联合，删掉强转与局部加宽。
 *
 * **R7：G2 失效事件表与自身注释自相矛盾**。修前现盘：`G2_SIGNATURE_INVALIDATING_EVENTS` 里**含**
 * `project/environment`，而紧邻注释写它"元数据，不作废签字" —— 表是判据、注释是谎。
 * 取向（与 G3 侧的 DEF-039 ② 同向）：**环境登记是纯元数据**（不参与任何 G2 判据；`environment` 在
 * `design.ts`/`derivedDocs.ts` 零命中）⇒ **从表里去掉**，并机械钉住"环境登记不使 G2 签字失效"。
 * ⚠️ G3 侧仍会被环境登记作废（`isSignatureInvalidatingEvent('G3', …)` 走黑名单）—— 那是 **DEF-039 ②**
 * 的范围，本文件只如实记录现值，不越界改。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { describeStructuralPlan } from '../src/interface/describe.js'
import { t } from '../src/domain/i18n.js'
import { G2_SIGNATURE_INVALIDATING_EVENTS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { StructuralPlan, StructuralSkip } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 只扫**代码行**：注释里正当地引用了被删掉的旧名字（记录缺陷现场）⇒ 扫注释会造出假阳性。 */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
}

test('M165-01（R6）`no-basis` 是**正式**取值：域层不再强转、渲染层不再就地加宽，且真的渲染得出来', () => {
  // ① 类型面（源码）：唯一来源含 `no-basis`，两处"绕开类型"的写法在**代码行**里绝迹
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  assert.match(types, /export type StructuralSkipReason = 'already-covered' \| 'no-card-needed' \| 'scope-too-broad' \| 'no-basis'/u, '联合类型必须含 no-basis')
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  const describe = readFileSync(join(ROOT, 'src', 'interface', 'describe.ts'), 'utf8')
  assert.equal(/as unknown as StructuralSkip/u.test(codeOnly(plan)), false, '域层不得再强转')
  assert.equal(/StructuralSkipReasonWithBasis/u.test(codeOnly(describe)), false, '渲染层不得再就地加宽')

  // ② 编译期锚点（本用例能编过本身就是证据）：整条 `StructuralSkip` 只用正式联合里的取值
  const skipped: StructuralSkip[] = [
    { designId: 'DES-001', name: '无依据元素', reason: 'no-basis' },
    { designId: 'DES-002', name: '写范围超限元素', reason: 'scope-too-broad', scopes: ['src/x/'] },
  ]
  const rendered: StructuralPlan = { created: [], skipped }
  const text = describeStructuralPlan(rendered)
  assert.match(text, /无依据元素/u, 'no-basis 那一条必须被渲染出来（点名元素名）')
  assert.match(text, /写范围超限元素/u, '其余原因照旧渲染（窄化没有被丢掉）')
  // 反例：把 `no-basis` 的文案与其它原因混同 ⇒ 收窄这条断言（不同原因必须印不同的话）
  const onlyBasis = describeStructuralPlan({ created: [], skipped: [skipped[0] as StructuralSkip] })
  const onlyScope = describeStructuralPlan({ created: [], skipped: [skipped[1] as StructuralSkip] })
  assert.notEqual(onlyBasis, onlyScope, '不同 reason 必须印出不同的话（不许退化成一个笼统标签）')
  // ⚠️ 断言落在**文案键本身**上，而不是猜某个中文词：`reason` 那一段必须来自各自的键
  assert.equal(onlyBasis.includes(t('uiIndex.kStructuralReasonNoBasis')), true, 'no-basis 那一段必须用它的专属文案')
  assert.equal(onlyBasis.includes(t('uiIndex.kStructuralReasonScopeTooBroad')), false, 'no-basis 那条不得混进写范围超限的文案')
  assert.equal(onlyScope.includes(t('uiIndex.kStructuralReasonScopeTooBroad')), true, 'scope-too-broad 那一段必须用它自己的文案')
})

test('M165-02（R7）环境登记**不作废 G2 签字**；真源变更照旧作废（没放宽）', () => {
  // ① 表里不再含它；真源事件仍在（逐条钉住，不用"数量"当判据）
  assert.equal((G2_SIGNATURE_INVALIDATING_EVENTS as readonly string[]).includes('project/environment'), false, 'G2 表不得含 project/environment')
  for (const type of ['project/created', 'project/updated', 'tailoring/updated', 'requirement/captured', 'requirement/updated', 'question/asked', 'question/answered', 'risk/logged', 'redteam/attack', 'issue/closed']) {
    assert.equal((G2_SIGNATURE_INVALIDATING_EVENTS as readonly string[]).includes(type), true, `G2 表必须仍含 ${type}`)
    assert.equal(isSignatureInvalidatingEvent('G2', type), true, `${type} 必须仍让 G2 签字失效`)
  }
  // ② 行为：环境登记不作废；未列事件也不作废
  assert.equal(isSignatureInvalidatingEvent('G2', 'project/environment'), false, '环境登记是元数据 ⇒ 不作废 G2 签字')
  assert.equal(isSignatureInvalidatingEvent('G2', 'gate/signed'), false, '门禁留痕同样不作废（既有口径不变）')
  // ③ 结构：注释里写明了理由（表与注释不许再打架）
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  const tableStart = types.indexOf('export const G2_SIGNATURE_INVALIDATING_EVENTS')
  const doc = types.slice(0, tableStart)
  assert.equal(doc.includes('R7'), true, '注释必须写明 R7 的处置与理由')
  assert.match(doc, /纯元数据|元数据/u, '理由要落在"它是元数据"上')
  // ④ **DEF-039 ② 随后已交付**（第三批同一批内）：G3 侧同样不作废 —— 环境登记是纯元数据 ⇒ 两侧同口径。
  // （本断言随该条一起从 true 改成 false；`test/m167` 用**真实路径**再钉一遍：签 G3 → 登记环境 ⇒ 仍 valid。）
  assert.equal(isSignatureInvalidatingEvent('G3', 'project/environment'), false, 'G3 侧同样不作废（DEF-039 ② 已修）')
})
