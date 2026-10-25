/**
 * **增量 237（`TASK-221` / `DEF-205`）：观测面从「宣告面」升级为「宣告面 + 调用流水」。**
 *
 * 修前真读数（本卡复现时现算，算式写在下面）：台账 `.sdo/evidence/child-tools.jsonl` 里
 * **每条**的字段只有 `at` / `childSessionId` / `tools` / `violations`；`tools` 是**公告面**
 * （宿主公告给它哪些工具），`violations` 是**越界名单**（掩码外的调用）——
 * **没有一处记"它真的调用了什么"**。于是两个问句在台账上不可回答：
 * 「子代理多频繁地用 `bash` 读台账状态」与「给它补只读工具之后 `bash` 是否真的降下来」。
 *
 * 本文件守的是**修完之后**的稳定事实（每条两态：正例过、反例必红）：
 *   · `M237-01`（阈值 ① + 守卫 ①）一次调用 ⇒ 流水**恰好多一条**且字段齐全（含 `ms` / `exitCode`）；
 *   · `M237-02`（阈值 ② + 守卫 ②）同一会话 250 次调用 ⇒ 新增字节 < 250×300，
 *     且超出上限的部分折成计数行、**总和守恒**（明细 + Σ计数 == 250）；
 *   · `M237-03`（阈值 ③）合成的大账上 `view=tools` 回执 **< 2000 字符**（且真的发生了折叠）；
 *   · `M237-04`（阈值 ④）流水行与宣告面条目**同住一个文件**，而 `childFaceLines` 的前 3 行逐字不变；
 *   · `M237-05`（守卫 ④）**参数内容不进台账**：哨兵串塞进参数，流水行里不得出现它；
 *   · `M237-06`（守卫 ③ + 落点三）旧格式条目（无流水）读时不报错、**不伪造**，如实说「该会话无流水」；
 *   · `M237-07`（体积阈值）病态输入（超长路径/命令）也写不出 ≥ 300 字节的一条。
 *
 * ⚠️ **本文件能证明到哪、不能证明到哪**（如实写，别让读者以为覆盖面更大）：
 * 它证明的是**写入器 / 读取器 / 渲染器**的三条硬约束与两态。**"宿主真的把每次调用送进来了"**
 * 那一步的接线在 `src/index.ts`（本卡写范围不含它）—— 缺那一处，流水**不会被真实调用写出来**，
 * `M237-01` 的"恰好多一条"只是对写入器的证明，不是端到端证明。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import {
  CALLS_PER_SESSION_CAP,
  CALL_LINE_MAX_BYTES,
  commandShape,
  readChildFaces,
  readChildToolCalls,
  toolUsageOf,
  writeChildToolCall,
} from '../src/domain/dispatchFace.js'
import { childFaceLines, describeToolUsageView, TOOL_VIEW_MAX_CHARS } from '../src/interface/describe.js'
import { maskFingerprint } from '../src/domain/roles.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { ChildFaceEntry } from '../src/domain/dispatchFace.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m237/', import.meta.url))

interface Fixture {
  office: SoftwareDevOffice
  call: OfficeCall
  workspace: string
  faceFile: string
}

function fixture(name: string): Fixture {
  const workspace = join(BASE, name)
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const sessionId = `s-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M237 ${name}`, scale: 'normal', stakeholders: ['业务方'] })
  return { office, call, workspace, faceFile: join(workspace, '.sdo', 'evidence', 'child-tools.jsonl') }
}

/** 台账原件的字节数（文件不存在 ⇒ 0）。 */
function bytesOf(path: string): number {
  try {
    return readFileSync(path).length
  } catch {
    return 0
  }
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M237-01 阈值① + 守卫①（两态）：一次调用 ⇒ 流水**恰好多一条**且字段齐全；不写则一条都不多', () => {
  const f = fixture('one-call')
  const store = f.office.storeFor(f.workspace)
  // 前态：一条流水都没有（守卫①的反例格：**不写**流水时后面的断言必须红）
  assert.equal(readChildToolCalls(store).calls.length, 0, '夹具前提：起始没有流水')

  f.office.noteChildToolCall(f.call, {
    childSessionId: 'child-m237',
    role: 'developer',
    task: 'TASK-900',
    tool: 'bash',
    command: 'grep -rn "child-tools" src/',
    exitCode: 0,
    ms: 42,
    ok: true,
  })

  const after = readChildToolCalls(store)
  assert.equal(after.calls.length, 1, '一次调用必须**恰好**多一条（多了少了都是错）')
  assert.equal(after.badLines, 0, '自己写的流水行不许被读成坏行')
  const call = after.calls[0]
  assert.ok(call !== undefined, '流水必须能读回')
  // 字段齐全：`at` / `childSessionId` / `role` / `task` / `tool` / `exitCode` / `ms` / `ok`
  assert.match(call.at, /^\d{4}-\d{2}-\d{2}T/u, '`at` 必须是 ISO 时刻')
  assert.equal(call.childSessionId, 'child-m237')
  assert.equal(call.role, 'developer')
  assert.equal(call.task, 'TASK-900')
  assert.equal(call.tool, 'bash', "守卫①：调用的是 bash ⇒ 流水里 `tool` 必须是 'bash'")
  assert.equal(call.exitCode, 0, '退出码必须记下来（"补工具 ⇒ bash 下降"要能分辨成功/失败）')
  assert.equal(call.ms, 42, '耗时必须记下来')
  assert.equal(call.ok, true)
  assert.equal(call.shape, 'grep', '命令形态按首词归一')

  // 反例（同一格的两态）：**不再调用** ⇒ 条数不变（上面的"恰好多一条"不是恒真判据）
  assert.equal(readChildToolCalls(store).calls.length, 1, '没有新调用就不许凭空多出一条')
})

test('M237-02 阈值② + 守卫②：同一会话 250 次调用 ⇒ 新增字节 < 250×300，超出部分折成计数行且**总数守恒**', () => {
  const f = fixture('fold')
  const store = f.office.storeFor(f.workspace)
  const before = bytesOf(f.faceFile)
  for (let i = 0; i < 250; i += 1) {
    f.office.noteChildToolCall(f.call, {
      childSessionId: 'child-fold',
      role: 'developer',
      task: 'TASK-901',
      tool: i % 2 === 0 ? 'bash' : 'read',
      command: 'cat .sdo/journal.jsonl',
      exitCode: 0,
      ms: 5,
      ok: true,
      targetPath: 'src/office.ts',
    })
  }
  const added = bytesOf(f.faceFile) - before
  const budget = 250 * CALL_LINE_MAX_BYTES
  assert.ok(added < budget, `250 次调用的新增字节必须 < 250×300=${String(budget)}（实际 ${String(added)}）`)
  const read = readChildToolCalls(store)
  assert.equal(read.detailedRows, CALLS_PER_SESSION_CAP, `明细行必须恰好停在每会话上限 ${String(CALLS_PER_SESSION_CAP)} 条`)
  assert.ok(read.folds.length > 0, '超出上限的部分必须留下计数行（不许静默丢）')
  // **总和守恒**：明细条数 + 计数之和 == 实际调用数
  assert.equal(
    read.detailedRows + read.foldedTotal,
    250,
    `总数必须守恒：明细 ${String(read.detailedRows)} + 折叠计数 ${String(read.foldedTotal)} == 250`,
  )
  // 计数行是 `{ tool, n }` 形态：两种工具都要在（`bash` 与 `read` 各半）
  const foldedTools = new Set(read.folds.map((row) => row.tool))
  assert.deepEqual([...foldedTools].sort(), ['bash', 'read'], '计数行按工具名折叠，两种工具都得在')
  // 回执点名折叠了多少（不静默）
  const usage = toolUsageOf(store)
  const text = describeToolUsageView(usage)
  assert.match(text, /count rows \d+/u, '回执必须点名计数行条数')
  assert.equal(usage.calls, 250, `统计口径：次数 = 明细 + 折叠计数（实际 ${String(usage.calls)}）`)
})

test('M237-03 阈值③：合成的大账上 `view=tools` 回执 < 2000 字符，且**真的发生了折叠**（判据不是"这份数据刚好够短"）', () => {
  const f = fixture('view-cap')
  const store = f.office.storeFor(f.workspace)
  // 12 个角色 × 40 种工具 × 各若干次调用：远超 2000 字符能装下的行数
  const roles = ['developer', 'reviewer', 'tester', 'analyst', 'architect', 'delivery', 'office', 'red-team', 'editor', 'shipper', 'probe', 'audit']
  const tools = ['bash', ...Array.from({ length: 39 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)]
  const lines: string[] = []
  for (const role of roles) {
    for (const tool of tools) {
      for (let i = 0; i < 4; i += 1) {
        lines.push(JSON.stringify({
          at: '2026-10-25T00:00:00.000Z',
          childSessionId: `child-${role}-${tool}`,
          role,
          task: 'TASK-902',
          tool,
          ok: true,
          ...(tool === 'bash' ? { shape: i % 2 === 0 ? 'grep' : 'cat' } : {}),
        }))
      }
    }
  }
  mkdirSync(join(f.workspace, '.sdo', 'evidence'), { recursive: true })
  writeFileSync(f.faceFile, lines.join('\n') + '\n')

  const usage = toolUsageOf(store)
  assert.equal(usage.roles.length, roles.length, '每个角色都要进统计（折叠只发生在**渲染**层）')
  const text = describeToolUsageView(usage)
  assert.ok(
    text.length < TOOL_VIEW_MAX_CHARS,
    `回执必须 < ${String(TOOL_VIEW_MAX_CHARS)} 字符（实际 ${String(text.length)}）`,
  )
  // 两态：不是"数据刚好够短"——判据必须真的做了折叠，否则这条断言在短账上无法区分
  assert.match(text, /tool rows folded \(cap 2000 chars\)/u, '超预算时必须有"折叠了多少行"的 ASCII 指路')
  // `bash` 单列一行：次数 + 占该角色总调用比例 + 最频繁形态前 3
  assert.match(text, /^ {2}bash \d+ \d+% {2}top shapes: (?:grep \d+ \/ cat \d+|cat \d+ \/ grep \d+)/mu, '`bash` 必须单列且带占比与形态前 3')
  const developer = usage.roles.find((row) => row.role === 'developer')
  assert.equal(developer?.bash?.count, 4, '每个角色 4 次 bash（数据面不受渲染折叠影响）')
  assert.equal(developer?.total, 4 * tools.length, '角色总调用次数按 tool × 次数现算')
})

test('M237-04 阈值④：流水行与宣告面**同住一个文件**，而 `childFaceLines` 的前 3 行逐字不变', () => {
  const f = fixture('face-stable')
  const store = f.office.storeFor(f.workspace)
  const faces: ChildFaceEntry[] = [
    { childSessionId: 'child-a', at: '2026-10-25T00:00:00.000Z', tools: ['bash', 'read'], violations: ['sdo_release'] },
    { childSessionId: 'child-b', at: '2026-10-25T00:00:01.000Z', tools: ['bash'], violations: [] },
    { childSessionId: 'child-c', at: '2026-10-25T00:00:02.000Z', tools: ['read', 'write'], violations: [] },
  ]
  mkdirSync(join(f.workspace, '.sdo', 'evidence'), { recursive: true })
  writeFileSync(f.faceFile, faces.map((face) => JSON.stringify(face)).join('\n') + '\n')
  const beforeLines = childFaceLines(readChildFaces(store).faces)

  // 往同一个文件里写 5 条流水（属于已观测会话之一）
  for (let i = 0; i < 5; i += 1) {
    f.office.noteChildToolCall(f.call, {
      childSessionId: 'child-a',
      role: 'developer',
      task: 'TASK-903',
      tool: 'bash',
      command: 'git status',
      exitCode: 0,
      ms: 3,
      ok: true,
    })
  }
  const read = readChildFaces(store)
  assert.equal(read.badLines, 0, '流水行**不是坏行**（那是本产品自己写的第二种行）')
  assert.equal(read.callLines, 5, '读侧要能把流水行数出来（不与宣告面混为一谈）')
  assert.equal(read.faces.length, 3, '宣告面必须还是 3 个会话')
  const afterLines = childFaceLines(read.faces)
  assert.deepEqual(afterLines.slice(0, 3), beforeLines.slice(0, 3), '`childFaceLines` 的前 3 行必须逐字不变（m230 咬住的那一段）')
  assert.deepEqual(afterLines, beforeLines, '整份观测面读数也不该因为流水行而变化')
})

test('M237-05 守卫④：参数内容**不进台账** —— 哨兵串塞进参数，流水行里不得出现它', () => {
  const f = fixture('sentinel')
  const store = f.office.storeFor(f.workspace)
  const SENTINEL = 'SENTINEL_M237_TOKEN_9f3c'
  f.office.noteChildToolCall(f.call, {
    childSessionId: 'child-sentinel',
    role: 'developer',
    task: 'TASK-904',
    tool: 'write',
    // 宿主的真实参数形态：`file_path` 是路径，`content` 是**正文**（正文绝不许落盘）
    args: { file_path: 'src/domain/dispatchFace.ts', content: `export const leaked = '${SENTINEL}'` },
    exitCode: 0,
    ms: 11,
    ok: true,
  })
  f.office.noteChildToolCall(f.call, {
    childSessionId: 'child-sentinel',
    role: 'developer',
    task: 'TASK-904',
    tool: 'bash',
    args: { command: `grep -rn ${SENTINEL} src/` },
    exitCode: 1,
    ms: 7,
    ok: false,
  })
  const raw = readFileSync(f.faceFile, 'utf8')
  assert.ok(!raw.includes(SENTINEL), '哨兵串（参数正文 / 命令其余部分）不得出现在台账里')
  const read = readChildToolCalls(store)
  assert.equal(read.calls.length, 2)
  const write = read.calls[0]
  assert.equal(write?.tool, 'write')
  assert.equal(write?.targetPath, 'src/domain/dispatchFace.ts', '路径要留（可判据）')
  assert.equal(write?.shape, undefined, '写类工具没有命令形态')
  const bash = read.calls[1]
  assert.equal(bash?.shape, 'grep', '命令只留首词形态')
  assert.equal(bash?.ok, false, '失败也要如实记（`ok=false`）')
  assert.equal(bash?.exitCode, 1)
})

test('M237-06 守卫③ + 落点三：旧格式条目（无流水）读时不报错、**不伪造**，如实说「该会话无流水」', () => {
  const f = fixture('legacy')
  const store = f.office.storeFor(f.workspace)
  mkdirSync(join(f.workspace, '.sdo', 'evidence'), { recursive: true })
  // 旧格式（`DEF-205` 之前）：只有宣告面 + 越界名单，**没有**任何 usage/流水
  writeFileSync(
    f.faceFile,
    [
      JSON.stringify({ childSessionId: 'legacy-1', at: '2026-10-01T00:00:00.000Z', tools: ['bash', 'read'], violations: [] }),
      JSON.stringify({ childSessionId: 'legacy-2', at: '2026-10-01T00:00:01.000Z', tools: ['bash'], violations: ['sdo_release'] }),
    ].join('\n') + '\n',
  )
  const read = readChildToolCalls(store)
  assert.equal(read.badLines, 0, '旧格式条目不是坏行（读侧不许因为"没有新字段"就报错）')
  assert.equal(read.faceLines, 2, '两条都是宣告面条目')
  assert.equal(read.calls.length, 0, '旧条目里没有流水 ⇒ 读出来就是 0 条（不许编造）')

  const usage = toolUsageOf(store)
  assert.equal(usage.calls, 0, '没有流水就是 0 次调用（不是"没用 bash"）')
  assert.deepEqual(usage.withoutFlow.sort(), ['legacy-1', 'legacy-2'], '没有流水的会话必须逐个点名')
  assert.deepEqual(usage.roles, [], '没有任何调用 ⇒ 不许凭空造出「0 次 bash」的角色行')
  const text = describeToolUsageView(usage)
  assert.match(text, /no call flow recorded yet/u, '必须如实说"还没有流水"')
  assert.match(text, /sessions with no flow: 2/u, '必须点名"该会话无流水"的条数')
  assert.match(text, /not fabricated/u, '必须写明"没有伪造"')
  assert.doesNotMatch(text, /^ {2}bash 0 /mu, '不许印「bash 0」——那是伪造')

  // 两态：同一个会话**有**流水之后，「无流水」的名单必须变空（判据不是恒真）
  f.office.noteChildToolCall(f.call, {
    childSessionId: 'legacy-2',
    role: 'developer',
    task: 'TASK-905',
    tool: 'bash',
    command: 'cat .sdo/project.json',
    exitCode: 0,
    ms: 2,
    ok: true,
  })
  assert.deepEqual(toolUsageOf(store).withoutFlow, ['legacy-1'], '有流水之后不再算"无流水"')
})

test('M237-07 体积阈值：病态输入也写不出 ≥ 300 字节的一条（且形态归一不吃内容）', () => {
  const f = fixture('size')
  const store = f.office.storeFor(f.workspace)
  const longPath = `src/${'deep/'.repeat(120)}file.ts`
  const written = writeChildToolCall(store, {
    childSessionId: 'child-size',
    role: 'developer',
    task: 'TASK-906',
    tool: 'bash',
    args: { command: `/usr/bin/git --no-pager log --oneline ${'x'.repeat(400)}`, file_path: longPath },
    exitCode: 0,
    ms: 12,
    ok: true,
  })
  assert.ok(
    Buffer.byteLength(written.line, 'utf8') < CALL_LINE_MAX_BYTES,
    `单条必须 < ${String(CALL_LINE_MAX_BYTES)} 字节（实际 ${String(Buffer.byteLength(written.line, 'utf8'))}）`,
  )
  const call = readChildToolCalls(store).calls[0]
  assert.equal(call?.shape, 'git', '首词归一：目录前缀与非首词参数都丢掉')
  assert.ok((call?.targetPath ?? '').length <= 120, '路径要截到上限内')
  // 形态归一自身的边界（纯函数，两态）：目录前缀去掉、非法字形去掉、定长
  assert.equal(commandShape('/usr/bin/git --no-pager log'), 'git')
  assert.equal(commandShape('  FOO=1 node   -v'), 'FOO1', '只留受限字形（首词是 `FOO=1`，`=` 被丢掉；其余参数不进形态）')
  assert.equal(commandShape('grep\u0000secret'), 'grepsecret', '空字符这类字形直接丢掉')
  assert.ok(commandShape(`a${'b'.repeat(80)}`).length <= 24, '形态定长（不许把命令原文带进来）')
})

/**
 * **`M237-08`：真装配链（阈值① / 守卫① 的**接线**那一半）。**
 *
 * 前七条证明的是"写入器 / 读取器 / 渲染器"，这一条证明**钩子真的把它接上了**：
 * 用 `apply` 起一份真插件、把 `tools/pre-execute` 与 `tools/post-execute` 的监听器**截下来**，
 * 再照宿主的形状投一次 `bash` 调用 —— 断言台账里**恰好多一条**且 `tool='bash'`、字段齐全。
 *
 * **两态**：只跑 pre（调用还没结束）⇒ 一条都不许多；跑完 post ⇒ 恰好一条。
 * 这条同时是"反例会红"的证明：把钩子里那段 `noteChildToolCall` 删掉，本用例必红。
 */
test('M237-08 接线（两态）：真钩子链上一次 bash 调用 ⇒ 台账恰好多一条且 tool=bash、字段齐全、不含参数内容', async () => {
  const workspace = join(BASE, 'hook-seam')
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const parent = 'session-0000m237-0000-4000-8000-00000002370'
  const child = 'ffff2370-4444-4bbb-8ccc-dddddddddd08'
  office.noteSession(parent, workspace)
  const parentCall = { sessionId: parent, cwd: workspace } as unknown as OfficeCall
  office.init(parentCall, { name: 'M237 接线', scale: 'normal', stakeholders: ['业务方'] })
  office.recordDispatchStarted(parentCall, {
    taskId: 'TASK-908',
    provider: 'spawn',
    childSessionId: child,
    parentSessionId: parent,
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: maskFingerprint('developer'),
  })
  const store = office.storeFor(workspace)
  const faceFile = join(workspace, '.sdo', 'evidence', 'child-tools.jsonl')

  // 宿主桩：把两个工具钩子的监听器截下来（`on` 与 m231 的桩同形，只是**留下**监听器）
  const pre: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
  const post: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
  const services: Record<string, unknown> = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: unknown) => {
      if (event === 'tools/pre-execute') pre.push(listener as (typeof pre)[number])
      if (event === 'tools/post-execute') post.push(listener as (typeof post)[number])
      return () => {}
    },
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
  assert.ok(pre.length > 0 && post.length > 0, '装配后必须挂上两个工具钩子（否则这一格证明不了接线）')

  const SENTINEL = 'SENTINEL_M237_HOOK_7a1e'
  const agent = {
    id: child,
    session: { id: child, header: { id: child, cwd: workspace, delegationDepth: 1, parentSession: parent } },
  }
  const exec = {
    callId: 'call-m237-08',
    name: 'bash',
    arguments: { command: `grep -rn ${SENTINEL} src/` },
    agent,
  }
  const next = async (): Promise<unknown> => ({ kind: 'allow' })

  // ① 只有 pre（调用还没结束）⇒ 一条都不许有
  const preListener = pre[pre.length - 1]
  assert.ok(preListener !== undefined)
  await preListener(exec, next)
  assert.equal(readChildToolCalls(store).calls.length, 0, 'pre 阶段还不该落流水（结果还没回来）')

  // ② 跑完 post ⇒ **恰好一条**
  const postListener = post[post.length - 1]
  assert.ok(postListener !== undefined)
  await postListener(exec, { isError: false, value: { exitCode: 0 }, content: [] }, async () => ({ kind: 'accept' }))
  const read = readChildToolCalls(store)
  assert.equal(read.calls.length, 1, '一次 bash 调用必须**恰好**多一条流水')
  const call = read.calls[0]
  assert.equal(call?.tool, 'bash', "守卫①：流水里 `tool` 必须是 'bash'")
  assert.equal(call?.childSessionId, child, '流水要挂在**那个子会话**上')
  assert.equal(call?.role, 'developer', '角色取自派发事实（不是调用方自报）')
  assert.equal(call?.task, 'TASK-908', '卡号取自派发事实')
  assert.equal(call?.exitCode, 0, '宿主给了 `exitCode` ⇒ 必须记下来')
  assert.equal(call?.ms !== undefined, true, '耗时要记（pre 记起点、post 取差）')
  assert.equal(call?.shape, 'grep', '命令形态按首词归一')
  assert.ok(!readFileSync(faceFile, 'utf8').includes(SENTINEL), '参数内容不得进台账（哨兵串不许出现）')

  // ③ 反例的同一格：**再投一次 pre 不投 post** ⇒ 仍然只有一条（不是"每次事件都记"）
  await preListener({ ...exec, callId: 'call-m237-08b' }, next)
  assert.equal(readChildToolCalls(store).calls.length, 1, '只有 post 才落流水（pre 不落）')
})
