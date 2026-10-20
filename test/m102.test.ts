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
 * **TASK-109 后半（REV-039 返工后半）**：两个方向相反的缺口各补一组 ——
 *   · **漏拦**（M102-10…13）：前缀包装（`sudo`/`env`/`nice`/`time`/`xargs`/`nohup`）里的写入命令，
 *     以及 `git worktree add/remove`、`git -C <dir> <写入子命令>` 这两类工作树写入；
 *   · **不退化**（M102-14）：新拦截**不得**把 `/dev/*`、引号内文本、heredoc 体重新卷回判定。
 * 同样**先钉红再改**（修前 m102：17 tests / 12 pass / 5 fail），修后全绿。
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
 *   · **DEF-054（第三批 §3.17）起定位已不再向上爬**：钩子走 `office.workspaceRootFor` ——
 *     ① 本次 cwd 本身含 `.sdo/`；② 本会话**登记的** cwd 含 `.sdo/`；③ 凭**认领台账**证明
 *     （在某个已登记会话的工作区里认领过卡）。三者都不含 ⇒ **fail-closed**。夹具因此必须
 *     **登记驾驶舱会话**（`liveCard` 里已做），否则测的是"夹具没登记"而不是定位；
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
  /** 模拟宿主的 `session/created`（登记会话工作目录）—— DEF-054 起是钩子定位的合法来源之一 */
  registerSession: (sessionId: string, cwd: string) => void
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
  // **DEF-054（第三批 §3.17）**：真机上每个会话都由宿主的 `session/created` 登记工作目录；
  // 钩子侧定位（`office.workspaceRootFor`）的第三步要靠它 —— 夹具必须同样登记，否则测的不是定位而是"夹具没登记"。
  const sessionCreated = listeners.get('session/created')
  assert.ok(sessionCreated !== undefined, '真实装配必须注册 session/created 监听器')

  return {
    registerSession(sessionId: string, cwd: string): void {
      sessionCreated({ id: sessionId, header: { cwd } }, async () => undefined)
    },
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
  // 真机上驾驶舱会话就在工作区根活动（宿主的 `session/created` 会登记它）——夹具补上这一步
  h.registerSession('cockpit', SESSION_CWD)
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

// ═══════════ TASK-109 后半：两类**漏拦**形态（前缀包装 / git 工作树） ═══════════
//
// 背景（REV-039 发现三，实现按源码逐条核过）：`detectCommandWrites` 拿 `words[0]` 当命令头**逐个
// 字面量比较**（`head === 'tee'` / `'cp'` / `'sed'`…），于是
//   · **前缀包装**（`sudo tee x`、`env A=1 rm x`、`nice -n 5 cp a b`、`time sed -i …`、`xargs rm x`）
//     里的写入命令一律不命中 —— 一行 `sudo`/`env` 就把闸门绕过去了；
//   · `git` 整条命令都没有形态：`git worktree add <path>` 与 `git -C <dir> restore <file>` 改的正是
//     工作树里的文件，却完全不经过判定。
// 两类现盘都是**漏拦**（TASK-090 已把它们如实登记进 `COMMAND_WRITE_RISKS`），本卡补拦截并把登记收窄。
//
// 口径与 TASK-090 一致：**先钉红再改**；断言**点名路径与形态**；"拦住"与"放行"成对出现 ——
// 新增拦截最容易顺手把只读命令与 in-scope 写入一起拦掉（那是 TASK-090 刚修掉的那类假阳性）。
// 落点三（不退化）单独一条：`/dev/*`、引号内文本、heredoc 体不得被新拦截重新卷回判定。

test('M102-10 前缀包装下的真实写入必须被拦（env/sudo/nice/time/xargs/nohup；点名路径与形态）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])
  const outside = join(BASE, 'src/other.ts')
  const inside = join(BASE, 'src/index.ts')

  const cases: { cmd: string; path: string; shape: RegExp }[] = [
    { cmd: `env FOO=1 tee ${outside}`, path: 'src/other.ts', shape: /tee/u },
    { cmd: `sudo -u root rm ${outside}`, path: 'src/other.ts', shape: /rm/u },
    { cmd: `nice -n 5 cp ${inside} ${outside}`, path: 'src/other.ts', shape: /cp/u },
    { cmd: `time sed -i 's/a/b/' ${outside}`, path: 'src/other.ts', shape: /sed -i/u },
    { cmd: `xargs rm ${outside}`, path: 'src/other.ts', shape: /rm/u },
    { cmd: `nohup tee ${outside}`, path: 'src/other.ts', shape: /tee/u },
  ]
  for (const item of cases) {
    const decision = await h.drive('bash', { command: item.cmd })
    assert.equal(decision.kind, 'deny', `前缀包装里的写入形态必须被拦：${item.cmd}（现状：${decision.kind}）`)
    const reason = reasonOf(decision)
    assert.match(
      reason,
      new RegExp(item.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `拒绝理由要点名被写路径：${item.cmd} → ${reason}`,
    )
    assert.match(reason, item.shape, `拒绝理由要点名命中的形态：${item.cmd} → ${reason}`)
  }

  // 反例（不许把闸拦错）：包装只把命令挪到后面，不改变"这条命令要不要写" —— in-scope 的写入必须放行。
  for (const cmd of [
    `env A=1 tee ${inside}`,
    `sudo -u root tee ${inside}`,
    `time sed -i 's/a/b/' ${inside}`,
    `xargs rm ${inside}`,
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(decision.kind, 'allow', `包装下的 in-scope 写入必须放行：${cmd}（被拒理由：${reasonOf(decision)}）`)
  }
})

test('M102-11 `git worktree add/remove` 是工作树写入，必须被拦（点名 worktree 路径与形态）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  for (const cmd of ['git worktree add src/wt', 'git worktree remove src/wt']) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(decision.kind, 'deny', `git worktree 的写入形态必须被拦：${cmd}（现状：${decision.kind}）`)
    const reason = reasonOf(decision)
    assert.match(reason, /src\/wt/u, `拒绝理由要点名 worktree 路径：${cmd} → ${reason}`)
    assert.match(reason, /worktree/u, `拒绝理由要点名形态（worktree）：${cmd} → ${reason}`)
  }

  // 反例：`git worktree list` 是只读，不得被卷进判定。
  const list = await h.drive('bash', { command: 'git worktree list' })
  assert.equal(list.kind, 'allow', `git worktree list 是只读命令，必须放行（被拒理由：${reasonOf(list)}）`)

  // 包装 + git 组合：`sudo` 不是"整条命令无害"的免死金牌。
  const wrapped = await h.drive('bash', { command: 'sudo git worktree add src/wt' })
  assert.equal(wrapped.kind, 'deny', `包装下的 git worktree 仍必须拦（现状：${wrapped.kind}）`)
  assert.match(reasonOf(wrapped), /src\/wt/u, `拒绝理由要点名 worktree 路径：${reasonOf(wrapped)}`)
})

test('M102-11b 卡声明**目录**时，其下的 worktree 路径放行（只按写范围判，语言无关）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/'])
  const decision = await h.drive('bash', { command: 'git worktree add src/wt' })
  assert.equal(
    decision.kind,
    'allow',
    `worktree 路径落在声明的目录范围内 ⇒ 必须放行（被拒理由：${reasonOf(decision)}）`,
  )
})

test('M102-12 `git -C <dir>` 的写入按**目录基准**合成后判定（越界点名合成路径、范围内放行）', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  const outside = await h.drive('bash', { command: 'git -C src restore other.ts' })
  assert.equal(outside.kind, 'deny', `git -C 下的写入必须被拦（现状：${outside.kind}）`)
  const reason = reasonOf(outside)
  assert.match(reason, /src\/other\.ts/u, `拒绝理由要点名**按目录基准合成后**的路径：${reason}`)
  assert.match(reason, /git -C/u, `拒绝理由要点名形态（git -C）：${reason}`)

  // 合成后落在写范围内 ⇒ 放行。这条正是"合成"本身的价值：不做合成只能把目录 `src` 整个当目标，
  // 范围内的窄写入会被误拒（那是"拦错了路径"的另一面）。
  const inside = await h.drive('bash', { command: 'git -C src restore index.ts' })
  assert.equal(inside.kind, 'allow', `合成后 in-scope 的写入必须放行（被拒理由：${reasonOf(inside)}）`)

  // 没有文件操作数的整树重写（`reset --hard`）改的是整个 `<dir>` ⇒ 点名该目录并拦。
  const tree = await h.drive('bash', { command: 'git -C src reset --hard' })
  assert.equal(tree.kind, 'deny', `git -C 下的整树重写必须被拦（现状：${tree.kind}）`)
  const treeReason = reasonOf(tree)
  assert.match(treeReason, /(^|[^A-Za-z0-9_-])src($|[^A-Za-z0-9_-])/u, `拒绝理由要点名被写的目录：${treeReason}`)
  assert.match(treeReason, /git -C reset/u, `拒绝理由要点名形态：${treeReason}`)

  // 反例：只读子命令不得被卷进判定（`-C` 只是改基准目录，不是"写"）。
  for (const cmd of ['git -C src status', 'git -C src log --oneline -n 1']) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(decision.kind, 'allow', `只读的 git 子命令必须放行：${cmd}（被拒理由：${reasonOf(decision)}）`)
  }

  // `git checkout <ref>` 的操作数是**引用名**（分支/提交），不是路径 —— 合成它只会点名一个
  // 工作区里并不存在的 `src/main`（DEF-074 同族的幽灵路径）⇒ 退回"整棵树"口径（点名 `src`）。
  const ref = await h.drive('bash', { command: 'git -C src checkout main' })
  assert.equal(ref.kind, 'deny', `git -C 下的 checkout 会重写整棵树 ⇒ 必须拦（现状：${ref.kind}）`)
  const refReason = reasonOf(ref)
  assert.doesNotMatch(refReason, /src\/main/u, `引用名不得被当成路径点名：${refReason}`)
  // 而 `--` **之后**的操作数一定是路径 ⇒ 按合成后的真实路径点名。
  const withSep = await h.drive('bash', { command: 'git -C src checkout -- other.ts' })
  assert.equal(withSep.kind, 'deny', '`git checkout -- <path>` 是路径写入 ⇒ 必须拦')
  assert.match(reasonOf(withSep), /src\/other\.ts/u, `\`--\` 之后的路径要点名：${reasonOf(withSep)}`)
})

test('M102-13 扫描器：前缀包装与 git 形态进目标并点名形态；只读形态与设备路径不进', () => {
  // 包装：真正的写入命令在包装后面 —— 目标与形态都要点名（形态是被拦的**写入命令**，不是包装词）。
  const wrapped = detectCommandWrites('sudo -u root tee src/other.ts')
  assert.deepEqual(wrapped.targets, ['src/other.ts'], `包装下的写入目标必须进判定：${JSON.stringify(wrapped)}`)
  assert.deepEqual(wrapped.shapes, ['tee'], `形态要点名被拦的写入命令：${JSON.stringify(wrapped)}`)

  const assigned = detectCommandWrites('env FOO=1 rm -f src/other.ts')
  assert.deepEqual(assigned.targets, ['src/other.ts'], `env 的变量赋值不是命令：${JSON.stringify(assigned)}`)
  assert.deepEqual(assigned.shapes, ['rm'], `形态：${JSON.stringify(assigned)}`)

  const nice = detectCommandWrites('nice -n 5 sed -i "s/a/b/" src/index.ts')
  assert.deepEqual(nice.targets, ['src/index.ts'], `nice 的 -n 取值不是目标：${JSON.stringify(nice)}`)
  assert.deepEqual(nice.shapes, ['sed -i'], `形态：${JSON.stringify(nice)}`)

  // 包装 + git 组合：两层都剥掉，落到 worktree add 的路径。
  const combo = detectCommandWrites('sudo git worktree add src/wt')
  assert.deepEqual(combo.targets, ['src/wt'], `包装下的 git worktree 仍要进判定：${JSON.stringify(combo)}`)
  assert.deepEqual(combo.shapes, ['git worktree add'], `形态：${JSON.stringify(combo)}`)

  // `git -C`：写入操作数按**目录基准合成**（`index.ts` 实际指的是 `src/index.ts`）。
  const composed = detectCommandWrites('git -C src restore index.ts')
  assert.deepEqual(composed.targets, ['src/index.ts'], `git -C 的写入按目录基准合成：${JSON.stringify(composed)}`)
  assert.deepEqual(composed.shapes, ['git -C restore'], `形态：${JSON.stringify(composed)}`)

  // 引用名不是路径：`git checkout <ref>` 的目标退回目录基准（不点名幽灵 `src/main`），
  // 而 `git checkout -- <path>` 的路径照样合成（`--` 之后一定是路径）。
  assert.deepEqual(detectCommandWrites('git -C src checkout main').targets, ['src'], '引用名不得被当成路径')
  assert.deepEqual(
    detectCommandWrites('git -C src checkout -- a.ts').targets,
    ['src/a.ts'],
    '`--` 之后的路径必须合成到目录基准下',
  )

  // 只读 / 设备：不进（不许把闸拦错）。
  assert.deepEqual(detectCommandWrites('git -C src status').targets, [], '只读子命令不是写入')
  assert.deepEqual(detectCommandWrites('git worktree list').targets, [], 'worktree list 是只读')
  assert.deepEqual(detectCommandWrites('sudo cat /dev/null').targets, [], '设备路径不得成为写目标')
})

test('M102-14 落点三不退化：新拦截不得把 /dev、引号内文本、heredoc 体重新卷回判定', async () => {
  const h = hookHarness()
  await liveCard(h, 'child-dev', ['src/index.ts'])

  for (const cmd of [
    'sudo tee /dev/null',
    'env A=1 node scripts/run-tests.mjs 2>/dev/null',
    `sudo cat > test/probe-body.ts <<'EOF'\necho x > lib/ghost.ts\nEOF`,
    `xargs grep -n 'echo x > lib/ghost.ts' test/m102.test.ts`,
  ]) {
    const decision = await h.drive('bash', { command: cmd })
    assert.equal(
      decision.kind,
      'allow',
      `新拦截不得把非写入形态卷回来：${JSON.stringify(cmd)}（被拒理由：${reasonOf(decision)}）`,
    )
  }

  // 同命令里的真越界仍必须拦，且**只点名真路径**（设备路径与引号内字面量不得进拒绝理由）。
  const mixed = await h.drive('bash', {
    command: `env A=1 tee /dev/null && sudo rm ${join(BASE, 'lib/real.ts')}`,
  })
  assert.equal(mixed.kind, 'deny', '同命令里的真写入仍必须拦（包装与设备路径都不是免死金牌）')
  const reason = reasonOf(mixed)
  assert.match(reason, /lib\/real\.ts/u, `拒绝理由要点名真写入路径：${reason}`)
  assert.doesNotMatch(reason, /dev\/null|ghost/u, `设备路径与字面量不得进拒绝理由：${reason}`)
})
