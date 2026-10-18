/**
 * **增量 196：立卡时的角色能力对账（第十二批 §3.8 `S1`）。**
 *
 * 病根：`roles.ts` 早就知道每个角色的工具面，但**建卡时不看它** ⇒ 出现"reviewer 卡的 DoD 要 `bash`"
 * "tester 卡的 DoD 要 `sdo_hash`"这类卡：立卡时就注定做不完，而当时没有任何一处会说出来。
 * 修法：`dodToolGaps(dod, role)` 现算（**只认工具名**，不读措辞），立卡回执逐卡告警并给改法。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { dodToolGaps, toolAllowList } from '../src/domain/roles.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('M196-01 §3.8（`S1`）DoD 点名了角色面里没有的工具 ⇒ 告警并点名工具与角色（两例各命中一次）', () => {
  // ① reviewer 卡的 DoD 要 `bash`（reviewer 掩码里没有 bash）
  assert.equal(toolAllowList('reviewer').includes('bash'), false, '前置：reviewer 面里确实没有 bash')
  const reviewer = dodToolGaps(['用 bash 跑一遍复现并贴输出'], 'reviewer')
  assert.deepEqual(reviewer, [{ role: 'reviewer', tool: 'bash', sdo: false }], '必须点名 bash 与 reviewer')
  // ② tester 卡的 DoD 要 `sdo_hash`（不在 tester 的流程面里，也不是任何角色的工具）
  const tester = dodToolGaps(['用 sdo_hash 算产物哈希并把结果写进证据'], 'tester')
  assert.deepEqual(tester, [{ role: 'tester', tool: 'sdo_hash', sdo: true }], '必须点名 sdo_hash 与 tester')
  // ③ 反例：developer 的 DoD 要 `bash` ⇒ 它面里有 ⇒ 不告警
  assert.deepEqual(dodToolGaps(['用 bash 跑测试'], 'developer'), [], '角色面里有的工具不许告警')
  // ④ 反例：纯中文散文（不点名工具）⇒ 不告警
  assert.deepEqual(dodToolGaps(['逐条复核并给出读数；确认门禁全部转绿'], 'reviewer'), [], '不点名工具就不许告警（不读措辞）')
  // ⑤ 反例：非角色码 ⇒ 不判（不猜）
  assert.deepEqual(dodToolGaps(['用 bash 跑测试'], 'not-a-role'), [], '认不出角色就不判')
  // ⑥ 同一条工具只报一次（重复出现不刷屏）
  assert.equal(dodToolGaps(['用 bash 跑', '再用 bash 跑', 'bash 很好用'], 'reviewer').length, 1, '同一个工具只报一次')
})

test('M196-02 §3.8（`S1`）立卡回执真的会带这条告警：回执路径用 `dodToolGaps`，语言包两处都有关键文案', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.ok(index.includes('dodToolGaps(task.dod, task.role)'), '立卡回执必须逐卡现算（`result.tasks` × `dodToolGaps`）')
  assert.ok(index.includes("fmt('uiIndex.kDodToolGap'"), '回执必须用语言键渲染（模板带卡 id / 角色 / 工具）')
  for (const [file, needle] of [
    ['zh-CN.yml', 'kDodToolGap:'],
    ['en.yml', 'kDodToolGap:'],
  ] as const) {
    const pack = readFileSync(join(ROOT, 'src', 'data', 'lang', file), 'utf8')
    assert.ok(pack.includes(needle), `${file} 必须有 kDodToolGap（两种语言都要有文案）`)
  }
  // 告警文案必须给得出**改法**（不是只报错）：模板里要有"改法"这类可执行指引的半句
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const line = zh.split('\n').find((item) => item.includes('kDodToolGap:')) ?? ''
  assert.match(line, /改法/u, '中文告警必须给改法')
  assert.match(line, /模式|角色面|工具/u, '告警要点名"本角色面里没有这个工具"')
})
