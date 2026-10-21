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

test('M145-03 TC-140：**运行器读数**里 `skipped` 与逐条理由可见（"没跑断言"不许隐身）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  // ① 造一份**只有两格跳过**的夹具测试，用真运行器（`node --test`）跑它 —— 读的是运行器自己印的东西。
  //    两个必须踩过的坑：ⓐ 夹具**不能放在 `node_modules/` 下**（运行器默认不扫那里，显式给路径也会报
  //    "Could not find"）；ⓑ 从测试进程里再起 `node --test` 会被"递归调用"防呆拦下 ⇒ 子进程要丢掉
  //    `NODE_TEST_CONTEXT`。
  const dir = mkdtempSync(join(tmpdir(), 'm145-runner-'))
  const fixture = join(dir, 'skip.fixture.test.mjs')
  writeFileSync(fixture, [
    "import { test } from 'node:test'",
    "test('会跑的格', () => {})",
    "test('跳过甲', { skip: '本断言面不覆盖这一态' }, () => {})",
    "test('跳过乙', { skip: '缺上游夹具：要求先有一张 in-progress 卡' }, () => {})",
    '',
  ].join('\n'), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['NODE_TEST_CONTEXT']
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', env })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert.equal(run.status, 0, `夹具测试必须跑通（status=${String(run.status)}）：${output.slice(0, 300)}`)
  // **理由逐条可见**（不是只给一个数字）
  assert.match(output, /本断言面不覆盖这一态/u, `第一条跳过的理由必须出现在读数里：${output.slice(0, 400)}`)
  assert.match(output, /缺上游夹具：要求先有一张 in-progress 卡/u, '第二条跳过的理由同样必须可见')
  assert.match(output, /#\s*skipped\s+2/u, `汇总行必须给跳过计数（skipped 2）：${output.slice(-400)}`)
  const skipLines = output.split('\n').filter((line) => /#\s*SKIP/iu.test(line))
  assert.ok(skipLines.length >= 2, `读数里必须能**数出**跳过条数（实际 ${skipLines.length} 行 # SKIP）`)

  // ② 本仓运行器**不吞**这一档：`scripts/run-tests.mjs` 把子进程输出原样透传（不自己拼"全绿"）
  const runner = readFileSync(fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url)), 'utf8')
  assert.match(runner, /stdio:\s*'inherit'/u, `运行器必须把子进程的 stdio **继承**下来（跳过与理由才看得见）：${runner.split('\n').find((line) => line.includes('spawnSync')) ?? ''}`)
  assert.equal(/skipped\s*[:=]\s*0/u.test(runner), false, '运行器不许把跳过数写死成 0')
  rmSync(dir, { recursive: true, force: true })
})
