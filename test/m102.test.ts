/**
 * **增量 102：写范围守卫的两处可绕过（DEF-047）** —— 用户 2026-10-13 裁定「优先修影响台账的缺陷」。
 *
 * 守卫（`src/domain/writeScope.ts` + `src/index.ts` 的 `tools/pre-execute` 钩子）是**保护所有真源**的
 * 那道机械闸，但实测有两处可绕过（本文件把两处都钉成用例）：
 *
 * | # | 绕过 | 现状 | 修后 |
 * |---|---|---|---|
 * | ① | 会话工作目录是**子目录**时，范围内的**绝对路径**被判越界 | 误拒（逼执行者改用 bash 绕） | 与相对路径同等放行 |
 * | ② | **命令类**调用（`bash`）完全不经过守卫 | `>` / `tee` / `sed -i` / `cp`/`mv`/`rm` 可写任何路径 | 至少覆盖已知写入形态 |
 *
 * **TASK-090 前半（2026-10-14）**：同一道闸门的**三处假阳性**（方向与上表相反：**误拒**）——
 * `/dev` 设备路径、引号内切词、命令文本里的字面量（引号内 / heredoc 体内）。三处都有实现会话的
 * **一手现场**（它本人被 `2>/dev/null` 与探针文本各拦过一次），守卫见本文件 §⑥–§⑨。
 * 口径：**先钉红再改** —— 四条新用例在修前逐条红（m102：11 tests / 7 pass / 4 fail），修后 11/11 绿。
 *
 * 断言要点名**被拒的路径**与**命中的形态**（只看 `kind === 'deny'` 的断言是空转的：
 * 拦错了路径也照样"绿"）。
 *
 * ## 落点零：守卫的真实实现位置（先定位、后动手；不照抄卡的猜测）
 *   · 判定引擎：`src/domain/writeScope.ts:88` `evaluateWriteScope`（+ `:57` `normalizeWorkspacePath`）；
 *   · 唯一调用点：`src/index.ts:2955` 的 `tools/pre-execute` 钩子（`scopeDecision` 在 `:3036-3057`）；
 *   · 路径基准：`workspace: call.cwd`，而 `call.cwd` 来自 `injectionCall(agent)` →
 *     `resolveScopeCall` → `src/interface/scope.ts:31` `cwdOfAgentLike` 读 **`agent.session.header.cwd`**
 *     —— 即**会话工作目录**（不是仓库根）。`bash` 无路径参数 ⇒ `evaluateWriteScope` 早退
 *     `allow(false)`（`writeScope.ts:96`），这正是绕过 ②。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { apply, detectCommandWrites } from '../src/index.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm102')
/**
 * **夹具根 = 会话工作目录 = 工作区根**，`.sdo/` 就建在它底下。
 *
 * 为什么（DEF-047 落点一，实测踩过两次，别改回去）：
 *   · 工作区根由 `findProjectRoot(cwd, projectDirName)` 从会话 cwd **向上找最近的 `.sdo/`** 得出
 *     （既有发现口径）。夹具若把 `.sdo` 放在**夹具根的上层**，上溯会**越过会话 cwd**、先撞见
 *     **本仓库自己的 `.sdo/`** ⇒ 卡的查找落到本仓真源上 ⇒ 用例会把"夹具位置不对"误报成"守卫坏了"；
 *   · 反之，真机契约是"**不向上爬、不猜别的项目**"（`office.workspaceFor`）：会话 cwd 里没有 `.sdo/`
 *     就是**未初始化**。所以夹具必须让"会话 cwd"与"`.sdo` 所在处"**同一个目录**"——
 *     否则测的就不是守卫，而是"夹具没初始化"。
 * 子目录会话（cwd 落在 `src/` 之下）由 **M102-01b** 显式模拟：那条用例钉的是"绝对路径自足 ⇒ 放行"，
 * 以及"工作区归属不到时相对路径 **fail-closed 拒**"。
 */
const SESSION_CWD = BASE
/** 夹具卡的版本号（`claim` 是 CAS：认领要带读到的版本）。 */
const CARD_REVISION = 3

let store: SdoStore

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(SESSION_CWD, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(SESSION_CWD, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 一张活卡：写范围是**相对的**（与真机一致）。 */
function card(id: string, scopes: string[]): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: scopes, role: 'developer', size: 'small', revision: CARD_REVISION,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
}

interface ToolDefinition { name: string; parameters: unknown; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

/**
 * 真装配 + 真实 `tools/pre-execute` 钩子。
 *
 * `cwd` 可指定**会话工作目录**（绕过的关键变量：子目录场景）。
 */
function hookHarness(): {
  drive: (tool: string, args: Record<string, unknown>, opts?: { sessionId?: string; cwd?: string; depth?: number }) => Promise<{ kind: string; reason?: string }>
  claim: (sessionId: string, taskId: string) => Promise<string>
} {
  const registered: ToolDefinition[] = []
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
    sessions: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const listener = listeners.get('tools/pre-execute')
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute 监听器')

  return {
    async drive(tool, args, opts = {}) {
      const sessionId = opts.sessionId ?? 'child-dev'
      const cwd = opts.cwd ?? SESSION_CWD
      const depth = opts.depth ?? 1
      const exec = {
        name: tool,
        arguments: args,
        agent: { id: sessionId, session: { header: { id: sessionId, cwd, delegationDepth: depth, ...(depth === 0 ? {} : { parentSession: 'cockpit' }) } } },
      }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as { kind: string; reason?: string }
    },
    async claim(sessionId, taskId) {
      const tool = registered.find((item) => item.name === 'sdo_task')
      assert.ok(tool !== undefined, '工具面缺少 sdo_task')
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd: SESSION_CWD, delegationDepth: 1, parentSession: 'cockpit' } } } }
      return String(await tool.execute({ action: 'claim', id: taskId, owner: sessionId, expectedRevision: CARD_REVISION }, exec))
    },
  }
}

/** 建卡 + 用**生产路径**认领（否则钩子的归属缓存不刷新，角色推不出来）。 */
async function liveCard(h: ReturnType<typeof hookHarness>, sessionId: string, scopes: string[]): Promise<void> {
  const task = card('TASK-901', scopes)
  store.writeYaml(['tasks', 'TASK-901.yml'], { task })
  const receipt = await h.claim(sessionId, 'TASK-901')
  assert.match(receipt, /TASK-901/u, `认领必须成功（否则后面测的是"没认领"而不是写范围）：${receipt.slice(0, 300)}`)
}

/** 被拒时取"点名"字段：拒绝理由里必须出现被拒路径与命中形态。 */
function reasonOf(decision: { kind: string; reason?: string }): string {
  return decision.kind === 'deny' ? (decision.reason ?? '') : ''
}

// ————————————————————————— ① in-scope 绝对路径（会话 cwd = 工作区根） —————————————————————————

test('M102-01 in-scope 的**绝对路径**与相对路径同等放行（现状：绝对路径被误拒）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  const absolute = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') })
  const relative = await h.drive('edit', { file_path: 'src/index.ts' })
  assert.equal(relative.kind, 'allow', `相对路径在写范围内必须放行：${relative.reason ?? ''}`)
  assert.equal(
    absolute.kind,
    'allow',
    `同一次调用里 in-scope 的绝对路径必须与相对路径同等放行（被拒理由：${reasonOf(absolute)}）`,
  )
})

// ———————————————————— ①b 会话工作目录是**子目录**（DEF-047 的原始现场） ————————————————————

test('M102-01b 会话 cwd 是**子目录**时：范围内的**绝对路径**放行、无法归属的相对写法与越界路径拒（fail-closed）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])
  const sub = join(BASE, 'src')

  // 绝对路径**自足**（不依赖 cwd）：归一后落在卡写范围内 ⇒ 必须放行。
  // 这条正是 DEF-047 的原始现场（真机实测：in-scope 文件用绝对路径 `edit` 被误拒、相对路径通过）。
  const absolute = await h.drive('edit', { file_path: join(sub, 'index.ts') }, { cwd: sub })
  assert.equal(
    absolute.kind,
    'allow',
    `子目录会话写"范围内的绝对路径"必须放行（被拒理由：${reasonOf(absolute)}）`,
  )
  // **fail-closed 的那一半（如实钉住，别放宽成"都放行"）**：相对路径的基准是**会话 cwd**，
  // 而"这次要写的文件该归属哪张卡"的坐标系是**工作区根**（卡的 `writeScopes` 就是相对它声明的）。
  // 会话 cwd 落在 `src/` 里时，相对写法 `index.ts` 只能解析成 `BASE/src/index.ts`，**无法**表达
  // "工作区根下的 `src/index.ts`" ⇒ 归属不到写范围 ⇒ **拒**（会话若想写范围内的文件，用绝对路径，
  // 或把会话 cwd 设在工作区根 —— 这正是"绝对路径必须放行"这一条存在的理由）。
  const relative = await h.drive('edit', { file_path: 'index.ts' }, { cwd: sub })
  assert.equal(
    relative.kind,
    'deny',
    '子目录会话里的相对写法无法归属到工作区根的写范围 ⇒ 必须 fail-closed 拒（不得放水）',
  )
  const outside = await h.drive('edit', { file_path: join(sub, 'other.ts') }, { cwd: sub })
  assert.equal(outside.kind, 'deny', '子目录会话写范围外的文件仍必须拒')
  assert.match(reasonOf(outside), /other\.ts/u, `拒绝理由要点名被拒路径：${reasonOf(outside)}`)
})

// ————————————————————————— ② 越界绝对路径 ⇒ 拒 —————————————————————————

test('M102-02 越界绝对路径 ⇒ 拒，且点名被拒路径与卡的写范围', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  const outside = await h.drive('edit', { file_path: join(BASE, 'src/other.ts') })
  assert.equal(outside.kind, 'deny', '写范围外的绝对路径必须拒')
  const reason = reasonOf(outside)
  assert.match(reason, /src\/other\.ts/u, `拒绝理由必须点名被拒路径：${reason}`)
  assert.match(reason, /src\/index\.ts/u, `拒绝理由必须给出卡的写范围（可执行修法）：${reason}`)
})

// ————————————————————————— ②b `..` 逃逸 ⇒ 拒 —————————————————————————

test('M102-02b `..` 逃逸与子目录内的 `..` 逃逸一律拒（点名逃逸后的路径）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])
  const sub = join(BASE, 'src')

  const escape = await h.drive('edit', { file_path: join(BASE, 'src/../lib/x.ts') })
  assert.equal(escape.kind, 'deny', '`src/../lib/x.ts` 逃出写范围 ⇒ 必须拒')
  assert.match(reasonOf(escape), /lib\/x\.ts/u, `拒绝理由要点名**归一后**的逃逸路径：${reasonOf(escape)}`)

  // 会话 cwd 在子目录：绝对路径 `../src/index.ts`（即 BASE/src/index.ts）归一后仍 in-scope ⇒ 放行；
  // 再往上逃出（BASE/elsewhere/x.ts）⇒ 拒。
  const inside = await h.drive('edit', { file_path: join(sub, '../src/index.ts') }, { cwd: sub })
  assert.equal(inside.kind, 'allow', `子目录里 \`../src/index.ts\` 归一后仍 in-scope ⇒ 放行：${inside.reason ?? ''}`)
  const outside = await h.drive('edit', { file_path: join(sub, '../../elsewhere/x.ts') }, { cwd: sub })
  assert.equal(outside.kind, 'deny', '子目录里 `../../elsewhere/x.ts` 逃出写范围 ⇒ 必须拒')
  assert.match(reasonOf(outside), /elsewhere\/x\.ts/u, `拒绝理由要点名逃逸路径：${reasonOf(outside)}`)
})

// ————————————————————————— ③ 命令类：bash 重定向写到越界路径 ⇒ 拒 —————————————————————————

test('M102-03 bash 重定向写到**越界**路径 ⇒ 拒（现状：完全不经过守卫）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  const cases: { cmd: string; shape: RegExp; path: string }[] = [
    { cmd: `echo x > ${join(BASE, 'src/other.ts')}`, shape: /重定向|>/u, path: 'src/other.ts' },
    { cmd: `echo x >> ${join(BASE, 'src/other.ts')}`, shape: /重定向|>>/u, path: 'src/other.ts' },
    { cmd: `echo x | tee ${join(BASE, 'src/other.ts')}`, shape: /tee/u, path: 'src/other.ts' },
    { cmd: `sed -i 's/a/b/' ${join(BASE, 'src/other.ts')}`, shape: /sed/u, path: 'src/other.ts' },
    { cmd: `cp ${join(BASE, 'src/index.ts')} ${join(BASE, 'src/other.ts')}`, shape: /cp/u, path: 'src/other.ts' },
    { cmd: `mv ${join(BASE, 'src/index.ts')} ${join(BASE, 'src/other.ts')}`, shape: /mv/u, path: 'src/other.ts' },
    { cmd: `rm ${join(BASE, 'src/other.ts')}`, shape: /rm/u, path: 'src/other.ts' },
    { cmd: `truncate -s 0 ${join(BASE, 'src/other.ts')}`, shape: /truncate/u, path: 'src/other.ts' },
  ]
  for (const item of cases) {
    const decision = await h.drive('bash', { command: item.cmd })
    assert.equal(decision.kind, 'deny', `命令类写入形态必须被拦：${item.cmd}（现状：${decision.kind}）`)
    const reason = reasonOf(decision)
    assert.match(reason, new RegExp(item.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `拒绝理由要点名被写路径：${item.cmd} → ${reason}`)
    assert.match(reason, item.shape, `拒绝理由要点名命中的形态：${item.cmd} → ${reason}`)
  }
})

// ————————————————————————— ④ 命令类：bash 写 in-scope 路径 ⇒ 放行 —————————————————————————

test('M102-04 bash 写 **in-scope** 路径（含公共面）⇒ 放行（不许把闸拦错）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  for (const cmd of [
    `echo x > ${join(BASE, 'src/index.ts')}`,
    `sed -i 's/a/b/' ${join(BASE, 'src/index.ts')}`,
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(decision.kind, 'allow', `写范围内的命令必须放行：${cmd}（被拒理由：${reasonOf(decision)}）`)
  }
  // 公共面（`.sdo/` 台账）由 SDO 工具与守卫共同维护 ⇒ 不受卡写范围约束
  const ledger = await h.drive('bash', { command: `echo x > ${join(BASE, '.sdo/tasks/TASK-901.yml')}` })
  assert.equal(ledger.kind, 'allow', `公共面（.sdo/）不得因命令类拦截而被拒：${reasonOf(ledger)}`)

  // **口径变更（2026-10-14，ADR-009 + REQ-060「语言无关」）**：侧车路径 `f.bak` 不再因
  // "以卡内文件开头"而放行 —— 那条前缀判据正是 DEF-057 要修的假阳性，而**语言无关**意味着
  // 不允许按扩展名/命名约定给 `.bak` 开例外（它与 `.tsx` 在无格式知识下无法区分）。
  // 正当出路：卡里声明**目录**（`src/`），或把这个侧车路径也写进 `writeScopes`（下一条用例证明可行）。
  const backup = await h.drive('bash', {
    command: `cp ${join(BASE, 'src/index.ts')} ${join(BASE, 'src/index.ts.bak')} && rm ${join(BASE, 'src/index.ts.bak')}`,
  })
  assert.equal(backup.kind, 'deny', `未声明的侧车路径必须拒（现状：${backup.kind}）`)
  assert.match(reasonOf(backup), /src\/index\.ts\.bak/u, `拒绝理由要点名被写路径：${reasonOf(backup)}`)
})

test('M102-04b 声明**目录**时，其下文件与侧车都放行（语言无关的"不误拒"保证）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/'])
  for (const cmd of [
    `echo x > ${join(BASE, 'src/index.ts')}`,
    `cp ${join(BASE, 'src/index.ts')} ${join(BASE, 'src/index.ts.bak')}`,
    `echo x > ${join(BASE, 'src/nested/deep/file.anything')}`,
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(decision.kind, 'allow', `目录范围内的写入必须放行：${cmd}（被拒理由：${reasonOf(decision)}）`)
  }
})

// ————————————————————————— ⑤ python -c 内 open(...,'w') ⇒ 拒 —————————————————————————

test('M102-05 `python -c` 里的 open(..., w) 写到越界路径 ⇒ 拒（点名形态与路径）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  const decision = await h.drive('bash', { command: `python3 -c "open('${join(BASE, 'src/other.ts')}','w').write('x')"` })
  assert.equal(decision.kind, 'deny', `python -c 的写文件形态必须被拦（现状：${decision.kind}）`)
  assert.match(reasonOf(decision), /src\/other\.ts/u, `拒绝理由要点名被写路径：${reasonOf(decision)}`)
})

// ═══════════════════════ TASK-090 前半：三处**假阳性**（方向是误拒，不是漏拦） ═══════════════════════
//
// 现场（实现会话一手）：它本人被闸门拦过两次 —— 一次是 `… 2>/dev/null`（被读成"要写 dev/null"），
// 一次是命令文本里的**探针字面量**（`echo x > …` 出现在引号里/heredoc 体内，被当成真实写入）。
// 两次都是**误拒**：闸门把"命令文本里出现的路径样字符串"当成了"这次真的要写的文件"。
//
// 三处假阳性与方向：
//   ① `/dev` 下的路径经前缀剥离变成**相对路径**（`/dev/null` → `dev/null`）⇒ 判成越界；
//   ② 引号内**切词**（`sed -i 's/a b/c d/'` 切出 `b/c`、`d/` 两个幽灵目标）⇒ 误拒；
//   ③ 命令文本里的**字面量**（引号内 / heredoc 体内）参与判定 ⇒ 连"给守卫写用例"这件事都被挡住。
//
// 断言口径：**点名路径与形态**（只看 `kind === 'deny'` 是空转的），且"放行"与"仍拦截"成对出现 ——
// 修假阳性最容易顺手把真写入也放过去，所以每条都配一条"同命令里的真越界仍必须拦 + 不得点名幽灵路径"。

test('M102-06 `/dev` 下的一切路径不得当作工作区相对路径（放行；同命令里的真越界仍拦且只点名真路径）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  // 现场复现：`cat … 2>/dev/null` 曾被判成"要写 dev/null"而整条命令被拒。
  for (const cmd of [
    'echo x > /dev/null',
    'node scripts/run-tests.mjs 2>/dev/null',
    'echo x > /dev/fd/3',
    'echo x > /dev/stdout',
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(
      decision.kind,
      'allow',
      `/dev 是设备节点、不是工作区文件，必须放行：${cmd}（被拒理由：${reasonOf(decision)}）`,
    )
  }

  // 非 bash 的工具面走同一条闸门：`file_path` 指向设备节点同样必须放行。
  const deviceWrite = await h.drive('write', { file_path: '/dev/null', content: 'x' })
  assert.equal(deviceWrite.kind, 'allow', `设备节点作为 file_path 也必须放行（被拒理由：${reasonOf(deviceWrite)}）`)

  // 真越界**与设备路径同命令**：绝不能因为"里面有个 /dev 路径"就整体放行；
  // 理由必须点名真路径，且不得把设备路径算成被写文件（那正是误拒的来源）。
  const mixed = await h.drive('bash', { command: `echo x > /dev/null && echo y > ${join(BASE, 'src/other.ts')}` })
  assert.equal(mixed.kind, 'deny', '同命令里的真越界仍必须拦（/dev 不是"整条命令无害"的免死金牌）')
  const reason = reasonOf(mixed)
  assert.match(reason, /src\/other\.ts/u, `拒绝理由要点名真越界路径：${reason}`)
  assert.doesNotMatch(reason, /dev\/null/u, `拒绝理由不得把设备路径算成被写文件：${reason}`)
})

test('M102-07 引号内不得切词：带引号的 sed 脚本不得切出幽灵目标（真目标仍拦）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  // in-scope 的 sed 改写：`'s/a b/c d/'` 曾被切成 `b/c` 与 `d/` 两个幽灵目标 ⇒ 整条命令被误拒。
  const ok = await h.drive('bash', { command: `sed -i 's/a b/c d/' ${join(BASE, 'src/index.ts')}` })
  assert.equal(ok.kind, 'allow', `引号内的 sed 脚本不是写目标，必须放行（被拒理由：${reasonOf(ok)}）`)

  // 同一个引号脚本 + 真越界目标：仍拦，点名真路径与形态，且**不得**出现幽灵目标。
  const mixed = await h.drive('bash', {
    command: `sed -i 's/a b/c d/' ${join(BASE, 'src/index.ts')} && echo y > ${join(BASE, 'src/other.ts')}`,
  })
  assert.equal(mixed.kind, 'deny', '真越界的重定向必须拦')
  const reason = reasonOf(mixed)
  assert.match(reason, /src\/other\.ts/u, `拒绝理由要点名真越界路径：${reason}`)
  assert.match(reason, /sed -i|>/u, `拒绝理由要点名形态：${reason}`)
  assert.doesNotMatch(reason, /b\/c|d\//u, `引号内切出的幽灵目标不得进判定：${reason}`)
})

test('M102-08 扫描器：设备路径 / 引号内字面量 / heredoc 体内不进目标，真实形态照样进（点名路径与形态）', () => {
  const device = detectCommandWrites('echo x > /dev/null')
  assert.deepEqual(device.targets, [], `设备路径不得成为写目标：${JSON.stringify(device)}`)

  const heredoc = detectCommandWrites(`cat > test/probe-body.ts <<'EOF'\necho x > lib/ghost.ts\nEOF`)
  assert.deepEqual(heredoc.targets, ['test/probe-body.ts'], `heredoc 体内是数据不是命令（裸写形态）：${JSON.stringify(heredoc)}`)

  // 两种体内形态都要挡：裸命令行（`echo x > …`）与引号里的字面量（`const s = 'echo x > …'`）。
  // 只用引号那种会**漏掉**"体内是裸命令"这一路（修②自己就能挡住它），守卫就成了空转的。
  const heredocQuoted = detectCommandWrites(`cat > test/probe-body.ts <<'EOF'\nconst s = 'echo x > lib/ghost.ts'\nEOF`)
  assert.deepEqual(heredocQuoted.targets, ['test/probe-body.ts'], `heredoc 体内是数据不是命令（引号字面量）：${JSON.stringify(heredocQuoted)}`)

  const probe = detectCommandWrites(`grep -n 'echo x > lib/ghost.ts' test/m102.test.ts`)
  assert.deepEqual(probe.targets, [], `引号内的字面量不是真实写入：${JSON.stringify(probe)}`)

  const sed = detectCommandWrites(`sed -i 's/a b/c d/' src/index.ts`)
  assert.deepEqual(sed.targets, ['src/index.ts'], `引号内不得切词：${JSON.stringify(sed)}`)

  const real = detectCommandWrites(`sed -i 's/a/b/' src/other.ts`)
  assert.deepEqual(real.targets, ['src/other.ts'], `真实形态必须照样进：${JSON.stringify(real)}`)
  assert.deepEqual(real.shapes, ['sed -i'], `形态要点名：${JSON.stringify(real)}`)
})

test('M102-09 命令文本里的字面量不算真实写入（给守卫写用例本身不再被闸门挡住）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  for (const cmd of [
    `grep -n 'echo x > lib/ghost.ts' test/m102.test.ts`,
    `cat > test/probe-body.ts <<'EOF'\necho x > lib/ghost.ts\nEOF`,
    `cat > test/probe-body.ts <<'EOF'\nconst s = 'echo x > lib/ghost.ts'\nEOF`,
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(
      decision.kind,
      'allow',
      `命令文本里的字面量不是写入，必须放行：${JSON.stringify(cmd)}（被拒理由：${reasonOf(decision)}）`,
    )
  }

  const mixed = await h.drive('bash', {
    command: `echo x > ${join(BASE, 'lib/real.ts')} && grep -n 'echo x > lib/ghost.ts' test/m102.test.ts`,
  })
  assert.equal(mixed.kind, 'deny', '同命令里的真写入仍必须拦')
  const reason = reasonOf(mixed)
  assert.match(reason, /lib\/real\.ts/u, `拒绝理由要点名真写入路径：${reason}`)
  assert.doesNotMatch(reason, /ghost/u, `拒绝理由不得点名字面量里的幽灵路径：${reason}`)
})
