/**
 * **增量 145：测试里的"因前置不满足就跳过"必须**显式且可观测**，不许静默 `return`（DEF-060，§3E 族 7）**。
 *
 * 缺陷原文（C 组 re-verify）：`test/m100.test.ts` 的 M100-07 分支逐字是
 *   `assert.ok(['tdd-result-untraceable', …, 'no-evidence', …].includes(result.code)); return`
 * ⇒ 探针给出同款入参但**去掉 `evidence`** 时 `code='no-evidence'` **正在白名单里** ⇒ 该用例**报绿**
 * 而其下 **8 条断言一条不跑**（"放行白名单把断言空转"）。
 *
 * 修法：① `no-evidence` 不再可跳过（夹具给足了证据，报它就是行为变更 ⇒ 必须红）；
 *       ② 其余确实不属断言面的拒绝走 `t.skip(...)` —— 测试汇总的 `skipped` 计数里看得见。
 * 本用例守这两点：源码形态（机械可核）+ 行为前提（夹具与断言面自洽，今天确实不返回 `no-evidence`）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = (): string => readFileSync(fileURLToPath(new URL('../../test/m100.test.ts', import.meta.url)), 'utf8')

test('M145-01 源码守卫：M100-07 的跳过必须显式（`t.skip`），且 `no-evidence` 不在其白名单里', () => {
  const text = source()
  const start = text.indexOf("test('M100-07")
  assert.notEqual(start, -1, '夹具前提：M100-07 必须还在')
  const branch = text.indexOf('if (!result.ok) {', start)
  assert.ok(branch > start, '夹具前提：M100-07 里应有 `if (!result.ok)` 分支')
  const block = text.slice(branch, branch + 900)
  assert.match(block, /t\.skip\(/u, '跳过必须走显式 `t.skip(...)`（可观测；静默 `return` = 断言空转）')
  assert.match(block, /assert\.notEqual\(\s*result\.code,\s*'no-evidence'/u, '`no-evidence` 必须被显式判红')
  const whitelist = block.match(/\[([^\]]*)\]\.includes\(result\.code\)/u)
  assert.ok(whitelist !== null, '夹具前提：仍应有白名单形态的断言')
  assert.doesNotMatch(whitelist?.[1] ?? '', /no-evidence/u, '`no-evidence` 不得留在白名单里（那正是本缺陷的洞）')
})

test('M145-02 行为前提：夹具形状（给了 workspace-changes 证据）下，产物**不得**被判 `no-evidence`', async () => {
  // 用与 M100-07 同款的域层出口：要求"给了证据就不许报缺证据"，否则 M100-07 会走跳过分支
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { SdoStore } = await import('../src/infra/store.js')
  const { Journal } = await import('../src/infra/journal.js')
  const { createTask } = await import('../src/domain/plan.js')
  const base = mkdtempSync(join(tmpdir(), 'm145-'))
  mkdirSync(join(base, '.sdo'), { recursive: true })
  const store = new SdoStore(join(base, '.sdo'))
  const journal = new Journal(store)
  const card = createTask(store, journal, {
    title: '夹具', goal: '夹具', inputs: [], outputs: [], dod: ['夹具'], role: 'developer', size: 'small',
    status: 'in-progress', owner: 'm145-owner', evidenceRequired: [], writeScopes: ['src/x.ts'],
  } as never)
  const { report } = await import('../src/domain/collab.js')
  const result = report(store, journal, {
    taskId: card.id, owner: 'm145-owner', status: 'done',
    evidence: [{ kind: 'workspace-changes', detail: 'm145', at: '2026-10-13T00:00:00.000Z' }],
  })
  assert.notEqual(result.ok ? 'ok' : result.code, 'no-evidence', `给了证据却被判缺证据：${result.ok ? '' : result.detail}`)
})
