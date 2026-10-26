/**
 * **增量 270：`DEF-244`（`TASK-270`）—— `drop` 必须声明「这是哪一档」，`done` 可以给落地指针。**
 *
 * 病根（现盘读数由 `.sdo/evidence/def243/status-vs-commits.mjs` 现算，不抄任务书）：
 * `dropped` 卡在台账里只剩一个状态词 —— 「从没做过」「做了但没在这张卡上收口」「在等评审」
 * 「被别人取代」四种事实**长得一模一样**。于是驾驶舱只能拿 `git status` 反推，而「工作树干净」
 * 被反读成「没落地」（`DEF-243`）。
 *
 * 本文件的五格（DoD 落点五）+ 两格补充，口径是**可分辨**、不是**更严**：
 *   ① 无 `disposition` 的 drop ⇒ 拒收并点名四档（**不默认 `never-done`**）；
 *   ② `delivered-deferred` 给一个**不在 HEAD 历史上**的哈希 ⇒ 拒收（反例格：防「随便填个 commit 就过」）；
 *   ③ `awaiting-review` 指向不存在的 `REV-9999` ⇒ 拒收；
 *   ④ 四档齐备且凭据合法 ⇒ 放行（四张卡各走一档，并回读卡面声明）；
 *   ⑤ **反向格**：同一形状、只有祖先关系不同 ⇒ HEAD 提交放行、侧支提交拒收
 *      （把合法的 `delivered-deferred` 拦住同样红：这一格就是那条断言的落点）；
 *   ⑥ 落点四：`list` 的分档视图逐档现算，且没有 `dropped` 卡时一个字都不加（反例）；
 *   ⑦ 落点三：`done` 给坏指针 ⇒ 拒收零写盘；不给 ⇒ 放行 + 警告行；给 HEAD 提交 ⇒ 放行 + 写进卡面。
 *
 * ⚠️ **两条当天纪律**：① 断言只用**卡号 / 档名 / 哈希 / 语言包键**做锚，**不用行号**（`DEF-233`：
 * 行号锚点三次逼实现迁就布局）；② 措辞断言一律经 `fmt('uiIndex.*')` 从语言包现算 —— 不把中文
 * 写死在测试里（`m249` 棘轮：措辞会变，**事实**不会）。
 *
 * 夹具是一个**真的 git 仓库**（`git init` + 三条提交）：祖先关系是这一卡的判据本体，
 * 用假判定器测等于没测。`node_modules/.sdo-test/` 在仓库工作树之内，运行器用
 * `GIT_CEILING_DIRECTORIES` 把夹具的 git 关在夹具里（`TASK-227` / `DEF-219`）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { fmt, t } from '../src/domain/i18n.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm270')
const WORKSPACE = join(BASE, 'proj')

/** 夹具里的 git（与 `test/m186` 同一套写法：`cwd=WORKSPACE`，身份靠 `-c` 现给）。 */
const git = (args: string[]): string => execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' }).trim()
const commit = (): string => {
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'])
  return git(['rev-parse', 'HEAD'])
}

interface ToolDefinition { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function harness(): ToolDefinition[] {
  const list: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { list.push(tool); return () => {} } }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return list
}

const card = (id: string, status: TaskCard['status'] = 'ready'): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
  status, requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

let office: SoftwareDevOffice
let exec: { agent: { id: string; session: { header: { id: string; cwd: string; delegationDepth: number } } } }
let task: ToolDefinition
/** 主线上的两条提交（第一条是基线、第二条是 HEAD）与一条**不在 HEAD 历史上**的侧支提交。 */
let baseHash = ''
let headHash = ''
let sideHash = ''

const drop = async (args: Record<string, unknown>): Promise<string> =>
  String(await task.execute({ action: 'drop', reason: '夹具', ...args }, exec))
const statusOf = (id: string): string =>
  String(office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', `${id}.yml`)?.task?.status ?? '')
const declarationOf = (id: string): Record<string, unknown> | undefined =>
  office.storeFor(WORKSPACE).readYaml<{ task: TaskCard & { dropDeclaration?: Record<string, unknown> } }>('tasks', `${id}.yml`)?.task?.dropDeclaration

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  // ——— 夹具仓库：两条主线提交 + 一条侧支提交 ———
  git(['init', '-q'])
  writeFileSync(join(WORKSPACE, 'a.txt'), '1\n')
  baseHash = commit()
  writeFileSync(join(WORKSPACE, 'b.txt'), '2\n')
  headHash = commit()
  const mainBranch = git(['symbolic-ref', '--short', 'HEAD'])
  git(['checkout', '-q', '-b', 'side'])
  writeFileSync(join(WORKSPACE, 'side.txt'), '3\n')
  sideHash = commit()
  git(['checkout', '-q', mainBranch])
  // 前置（判据读它）：侧支提交**存在**但**不在 HEAD 的历史里** —— 正是 ② 要拦的那个形态
  assert.notEqual(sideHash, headHash, '夹具前提：侧支提交必须与 HEAD 不同')
  assert.equal(
    (() => { try { git(['merge-base', '--is-ancestor', sideHash, 'HEAD']); return true } catch { return false } })(),
    false,
    '夹具前提：侧支提交**不能**可由 HEAD 到达（否则 ② 那一格什么都没测到）',
  )

  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', WORKSPACE)
  const call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.init(call, { name: 'm270', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005', 'TASK-006', 'TASK-007', 'TASK-008', 'TASK-009']) {
    store.writeYaml(['tasks', `${id}.yml`], { task: card(id) })
  }
  // 一条**真实存在**的评审（③ 要证明「指向不存在的评审被拒」不是恒真：同一条路对存在的编号是放行的）
  store.writeYaml(['reviews', 'REV-001.yml'], { review: { id: 'REV-001', card: 'TASK-005', at: new Date().toISOString(), verdict: 'approved' } })
  exec = { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }
  const tasks = harness()
  const tool = tasks.find((item) => item.name === 'sdo_task')
  assert.ok(tool !== undefined, '真实装配必须注册 sdo_task')
  task = tool
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/* —————— ① 缺档拒收（不默认 never-done） —————— */
test('M270-01 没有 `disposition` 的 drop ⇒ 拒收、点名四档、零写盘（不默认 `never-done`）', async () => {
  const refused = await drop({ id: 'TASK-001' })
  for (const tier of ['never-done', 'delivered-deferred', 'awaiting-review', 'superseded']) {
    assert.ok(refused.includes(tier), `拒收必须点名这一档「${tier}」：${refused.slice(0, 400)}`)
  }
  assert.ok(refused.includes(t('uiCollab.kDropDispositionMissing').slice(0, 12)), `拒收要指名缺的是哪一个参数（缺档那一条文案）：${refused.slice(0, 200)}`)
  assert.equal(refused.includes(t('uiCollab.kDropLandingMissing')), false, '缺档时报的是「缺档」，不许混成「缺落地哈希」（那是交付档的问题）')
  // 反例格（防「默认成 never-done」）：卡面必须原样停在 ready，且**没有**任何声明被写进去
  assert.equal(statusOf('TASK-001'), 'ready', '缺档时**零写盘**：卡不许被改成 dropped')
  assert.equal(declarationOf('TASK-001'), undefined, '缺档时不许落任何 `dropDeclaration`（尤其不许默认成 never-done）')
})

/* —————— ② 交付档：哈希不在 HEAD 历史上 ⇒ 拒收 —————— */
test('M270-02 `delivered-deferred` + 不在 HEAD 历史上的哈希 ⇒ 拒收、点名那个哈希、零写盘', async () => {
  const refused = await drop({ id: 'TASK-002', disposition: 'delivered-deferred', landing: sideHash })
  assert.ok(refused.includes(sideHash), `拒收必须**点名那个哈希**：${refused.slice(0, 400)}`)
  assert.ok(/merge-base|HEAD/u.test(refused), `要说清是哪条判据判否（HEAD 祖先关系），而不是一句 invalid：${refused.slice(0, 400)}`)
  assert.equal(statusOf('TASK-002'), 'ready', '被拒时**零写盘**')
  assert.equal(declarationOf('TASK-002'), undefined, '被拒时不许落声明')

  // 反例对照（不是恒拒）：同一张卡换一条**解析不出来**的哈希 ⇒ 也要拒，但理由不同（不许混成一句）
  const ghost = 'f'.repeat(40)
  const ghostRefused = await drop({ id: 'TASK-002', disposition: 'delivered-deferred', landing: ghost })
  assert.ok(ghostRefused.includes(ghost), `解析不出时同样要点名那个哈希：${ghostRefused.slice(0, 300)}`)
  assert.notEqual(ghostRefused, refused, '两种失败（解析不出 / 不在历史里）必须读得出区别')
  assert.equal(statusOf('TASK-002'), 'ready', '两条拒绝路径都零写盘')

  // 反例对照：**主线上的基线提交**（`baseHash`，HEAD 的祖先）⇒ 这一档必须放行
  const admitted = await drop({ id: 'TASK-002', disposition: 'delivered-deferred', landing: baseHash })
  assert.equal(statusOf('TASK-002'), 'dropped', `基线提交可由 HEAD 到达 ⇒ 必须放行：${admitted.slice(0, 300)}`)
})

/* —————— ③ 等评审档：评审不存在 ⇒ 拒收 —————— */
test('M270-03 `awaiting-review` 指向不存在的 `REV-9999` ⇒ 拒收，且存在的评审照旧放行', async () => {
  const refused = await drop({ id: 'TASK-003', disposition: 'awaiting-review', review: 'REV-9999' })
  assert.ok(refused.includes('REV-9999'), `拒收必须点名那条不存在的评审：${refused.slice(0, 300)}`)
  assert.equal(statusOf('TASK-003'), 'ready', '被拒时**零写盘**')
  assert.equal(declarationOf('TASK-003'), undefined, '被拒时不许落声明')

  // 反证（防「awaiting-review 一律拒」的假绿）：台账里存在的 REV-001 ⇒ 放行
  const admitted = await drop({ id: 'TASK-003', disposition: 'awaiting-review', review: 'REV-001' })
  assert.equal(statusOf('TASK-003'), 'dropped', `存在的评审必须放行：${admitted.slice(0, 300)}`)
})

/* —————— ④ 四档齐备 + 凭据合法 ⇒ 全部放行 —————— */
test('M270-04 四档齐备且凭据合法 ⇒ 全部放行，声明落进卡片真源并可回读', async () => {
  const receipts: Record<string, string> = {}
  receipts['never-done'] = await drop({ id: 'TASK-004', disposition: 'never-done' })
  receipts['delivered-deferred'] = await drop({ id: 'TASK-005', disposition: 'delivered-deferred', landing: headHash })
  receipts['awaiting-review'] = await drop({ id: 'TASK-006', disposition: 'awaiting-review', review: 'REV-001' })
  receipts['superseded'] = await drop({ id: 'TASK-007', disposition: 'superseded', supersededBy: 'TASK-008' })
  const expected: [string, string][] = [
    ['TASK-004', 'never-done'],
    ['TASK-005', 'delivered-deferred'],
    ['TASK-006', 'awaiting-review'],
    ['TASK-007', 'superseded'],
  ]
  for (const [id, tier] of expected) {
    assert.equal(statusOf(id), 'dropped', `${id}（${tier}）凭据齐备却没收口：${receipts[tier]?.slice(0, 300)}`)
    const declaration = declarationOf(id)
    assert.equal(declaration?.disposition, tier, `${id} 的分档必须落进卡片真源（回读要读得回来）：${JSON.stringify(declaration)}`)
    assert.ok(String(receipts[tier]).includes(tier), `${id} 的回执要点名分档：${String(receipts[tier]).slice(0, 300)}`)
  }
  // 凭据逐档落位（不只是"有个对象"）：交付档带哈希、评审档带 REV、取代档带卡号
  assert.equal(declarationOf('TASK-005')?.landing, headHash, '交付档的凭据就是那个提交')
  assert.equal(declarationOf('TASK-006')?.review, 'REV-001', '评审档的凭据就是那条评审')
  assert.equal(declarationOf('TASK-007')?.supersededBy, 'TASK-008', '取代档的凭据就是那张卡')
  // 「唯一一档可以不带证据」那句话**只**出现在 never-done 上（措辞由语言包现算，不写死）
  const onlyTier = fmt('uiIndex.kDropTierNeverDone', {})
  assert.ok(receipts['never-done']?.includes(onlyTier), `never-done 的回执必须点明它不需要凭据：${receipts['never-done']?.slice(0, 400)}`)
  for (const tier of ['delivered-deferred', 'awaiting-review', 'superseded']) {
    assert.equal(receipts[tier]?.includes(onlyTier), false, `${tier} 不该印「可以不带证据」那句话（它有凭据）`)
  }
  // 逐档的凭据行同样只在该档出现
  assert.ok(receipts['delivered-deferred']?.includes(fmt('uiIndex.kDropTierLanding', { p1: headHash })), '交付档要印「可由 HEAD 到达」那一行')
  assert.ok(receipts['awaiting-review']?.includes(fmt('uiIndex.kDropTierReview', { p1: 'REV-001' })), '评审档要印那条评审')
  assert.ok(receipts['superseded']?.includes(fmt('uiIndex.kDropTierSuperseded', { p1: 'TASK-008' })), '取代档要印取代它的卡')
})

/* —————— ⑤ 反向格：口径是「可分辨」，不是「更严」 —————— */
test('M270-05 反向格：同一形状只有祖先关系不同 ⇒ HEAD 提交放行、侧支提交拒收（拦住合法的同样红）', async () => {
  // 两张**同形**卡、同一个档、只换一个提交
  const okReceipt = await drop({ id: 'TASK-008', disposition: 'delivered-deferred', landing: headHash })
  const badReceipt = await drop({ id: 'TASK-009', disposition: 'delivered-deferred', landing: sideHash })
  assert.equal(statusOf('TASK-008'), 'dropped', `合法的 delivered-deferred 被拦住了 —— 口径是「可分辨」不是「更严」：${okReceipt.slice(0, 400)}`)
  assert.equal(statusOf('TASK-009'), 'ready', `不在 HEAD 历史上的提交必须被拦住：${badReceipt.slice(0, 300)}`)
  assert.ok(okReceipt.includes(headHash), '放行时回执要点名那个提交（可复核）')
  assert.equal(badReceipt.includes(fmt('uiIndex.kDropTierLanding', { p1: sideHash })), false, '被拒的回执不该印「已核对可由 HEAD 到达」')
  // 反向自证：这一格不是「两张都被拦」的假绿（上面第一行已经钉住），也不是「两张都放行」
  assert.notEqual(statusOf('TASK-008'), statusOf('TASK-009'), '同形不同祖先关系必须**读出区别**')
})

/* —————— ⑥ 落点四：list 的分档只读视图 —————— */
test('M270-06 `list` 的分档视图：四档逐档现算 + 未声明单列；没有 dropped 卡时一个字都不加', async () => {
  const before = String(await task.execute({ action: 'list' }, exec))
  assert.equal(before.includes(fmt('uiIndex.kDropTallyHeader', {})), false, '没有 dropped 卡时不许印这一段（空库回执与修前逐字节相同）')

  await drop({ id: 'TASK-004', disposition: 'never-done' })
  await drop({ id: 'TASK-005', disposition: 'delivered-deferred', landing: headHash })
  const receipt = String(await task.execute({ action: 'list' }, exec))
  assert.ok(receipt.includes(fmt('uiIndex.kDropTallyHeader', {})), `有 dropped 卡就要有分档视图：${receipt.slice(-600)}`)
  for (const tier of ['never-done', 'delivered-deferred', 'awaiting-review', 'superseded']) {
    assert.ok(receipt.includes(tier), `四档必须**全列**（哪怕 0 张）：缺「${tier}」会让「这一档没人用过」读成「没有这一档」`)
  }
  // 逐档现算：never-done 1 张、delivered-deferred 1 张 → 其余 0 张
  assert.ok(receipt.includes(fmt('uiIndex.kDropTallyRow', { p1: 'never-done', p2: '1' })), 'never-done 的计数必须现算成 1')
  assert.ok(receipt.includes(fmt('uiIndex.kDropTallyRow', { p1: 'delivered-deferred', p2: '1' })), 'delivered-deferred 的计数必须现算成 1')
  assert.ok(receipt.includes(fmt('uiIndex.kDropTallyRow', { p1: 'superseded', p2: '0' })), '没人用过的档必须印 0，不是消失')
  // 未声明那一行同样现算（dropped 2 张、其中带声明 2 张 ⇒ 未声明 0）
  assert.ok(
    receipt.includes(fmt('uiIndex.kDropTallyUndeclared', { p1: '0', p2: '2', p3: '2' })),
    `未声明那一行要现算（存量不回填的口径写在那一行）：${receipt.slice(-600)}`,
  )
})

/* —————— ⑦ 落点三：done 的落地指针（给了就验，不给只警告） —————— */
test('M270-07 `done` 的落地指针：坏哈希 ⇒ 拒收零写盘；不给 ⇒ 放行 + 警告行；给 HEAD 提交 ⇒ 写进卡面', async () => {
  const call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  const evidence = JSON.stringify([{ kind: 'command', detail: 'node -e 1 → 0', exitCode: 0 }])
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003']) {
    // `planned` 才可认领（`in-progress` 已被 owner 占着，`claim` 会以 `not-claimable` 拒 —— 正是要走的这条路）
    office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: card(id, 'planned') })
    const claimed = office.claimTask(call, { taskId: id, owner: 'dev-a', expectedRevision: 1 })
    assert.equal(claimed.ok, true, `夹具前提：${id} 必须认领成功（failed: ${JSON.stringify(claimed).slice(0, 200)}）`)
  }
  // ① 坏指针 ⇒ 拒收，卡原样留在 in-progress（**先验后写**，不是写完再报）
  const refused = String(await task.execute({ action: 'done', id: 'TASK-001', owner: 'dev-a', evidence, landing: sideHash }, exec))
  assert.ok(refused.includes(sideHash), `拒收要点名那个哈希：${refused.slice(0, 400)}`)
  assert.equal(statusOf('TASK-001'), 'in-progress', '被拒时**零写盘**（不许先落 done 再报指针无效）')
  // ② 不给 ⇒ 放行 + 只警告不拦（兄弟卡在飞 ⇒ 按 `DEF-033` 声明未冻结，与本卡无关的那条纪律照旧）
  const warned = String(await task.execute({ action: 'done', id: 'TASK-002', owner: 'dev-a', evidence, unfrozen: '["TASK-001","TASK-003"]' }, exec))
  assert.equal(statusOf('TASK-002'), 'done', `不给指针必须**放行**（存量不可追溯，判红只会逼人写豁免）：${warned.slice(0, 400)}`)
  assert.ok(warned.includes(fmt('uiIndex.kDoneLandingNoPointer', {})), `不给指针要给一行警告：${warned.slice(-500)}`)
  // ③ 给 HEAD 提交 ⇒ 放行 + 写进卡面（「已交付」不再只是一句话）
  const pointed = String(await task.execute({ action: 'done', id: 'TASK-003', owner: 'dev-a', evidence, landing: headHash, unfrozen: '["TASK-001"]' }, exec))
  assert.equal(statusOf('TASK-003'), 'done', `合法指针必须放行：${pointed.slice(0, 400)}`)
  assert.ok(pointed.includes(fmt('uiIndex.kDoneLandingPointer', { p1: headHash })), `回执要把这一行单列出来：${pointed.slice(-600)}`)
  const pointer = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard & { landingCommit?: string } }>('tasks', 'TASK-003.yml')?.task?.landingCommit
  assert.equal(pointer, headHash, '落地指针要记进卡面（`landingCommit`），否则「已交付」仍然只是一句话')
})

/* —————— ⑧ superseded 的凭据同样机械校验（DoD 落点二最后一块没被钉住的） —————— */
/**
 * 落点二对四档的凭据要求是「**机械校验**」，但前七格只钉了 `delivered-deferred`（祖先关系）与
 * `awaiting-review`（评审存在）两档的拒收：`superseded` 只有**放行**那一格（`M270-04`）。
 * 实现里它有两条独立判据（指向的卡必须存在 / 不许指向自己），**没有任何格钉住** ——
 * 谁把这两条删掉，「取代它的卡」就会静默接受一个不存在的编号，而回执仍然写着“已核对台账里存在”。
 * 所以本格把三条拒绝路径（不存在 / 自指 / 缺凭据）+ 一条正向对照补上。
 *
 * 断言消息用英文：`m189` 的读散文棘轮按「文件 + 站点数」**按身份**登记，中文消息会多加未登记站点。
 */
test('M270-08 superseded credentials are machine-checked too: unknown card / self-reference / missing all refused', async () => {
  // ① 指向不存在的卡 ⇒ 拒收，并点名那张卡
  const unknown = await drop({ id: 'TASK-004', disposition: 'superseded', supersededBy: 'TASK-999' })
  assert.ok(unknown.includes('TASK-999'), `the refusal must name the missing card: ${unknown.slice(0, 300)}`)
  assert.equal(statusOf('TASK-004'), 'ready', 'nothing may be written when the credential is refused')
  assert.equal(declarationOf('TASK-004'), undefined, 'no declaration may be stored when the credential is refused')
  // ② 指向自己 ⇒ 拒收，且与 ① 的失败理由读得出区别（两句话，不是一句 invalid）
  const self = await drop({ id: 'TASK-004', disposition: 'superseded', supersededBy: 'TASK-004' })
  assert.equal(self.includes('TASK-004'), true, `a self-reference must name the card itself: ${self.slice(0, 300)}`)
  assert.notEqual(self, unknown, 'self-reference and unknown-card must be distinguishable sentences')
  // ③ 凭据缺省 ⇒ 拒收（这一档不许空着凭据收口）
  const missing = await drop({ id: 'TASK-004', disposition: 'superseded' })
  assert.notEqual(missing, unknown, 'missing credential and wrong credential must be distinguishable sentences')
  assert.equal(statusOf('TASK-004'), 'ready', 'all three refusal paths must leave the card untouched')
  // ④ 正向对照（不是恒拒）：指向一张**真实存在**的卡 ⇒ 这一档必须放行，凭据落位
  const admitted = await drop({ id: 'TASK-004', disposition: 'superseded', supersededBy: 'TASK-001' })
  assert.equal(statusOf('TASK-004'), 'dropped', `an existing card must be admitted (the criterion is "distinguishable", not "stricter"): ${admitted.slice(0, 300)}`)
  assert.equal(declarationOf('TASK-004')?.supersededBy, 'TASK-001', 'the credential must land in the card source')
})
