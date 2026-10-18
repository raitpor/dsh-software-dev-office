/**
 * 未修清单里剩下的 9 条（SDO-08 / 10 / 14(3) / 15(3) / 34 / 35 / 36 / 40 / 46 / 48②）的回归。
 *
 * 这一批的共同点是「机制该拦住却静默放过」：身份靠自报、台账写入与卡写范围打架、blocked 卡静默占范围、
 * 方法选择"出现即选中"、卡没有受约束的修改入口、确认戳分不清本人/代盖、台账不记版本。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { claim, report, updateTask } from '../src/domain/collab.js'
import { parseMethodChoice } from '../src/domain/method.js'
import { validatePlan } from '../src/domain/plan.js'
import { recordWorkspaceChanges } from '../src/domain/workspaceChanges.js'
import type { TaskCard } from '../src/types.js'
import { renderSignReviewDoc, renderTestReportSignable } from '../src/domain/reviewDoc.js'
import type { SignReviewDoc } from '../src/domain/reviewDoc.js'
import {
  diffPayloadIndex,
  payloadIndex,
  readReviewPayload,
  renderedDocReviewItem,
  reviewFingerprint,
} from '../src/domain/reviewPayload.js'
import { currentJournalSeq, writeTestingSource } from '../src/domain/testingStore.js'
import { writeTestingDoc } from '../src/domain/testingRender.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm45')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  journal.append('project/created', { id: 'PRJ-001', name: 'm45', process: 'waterfall' })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...overrides,
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
  return task
}

test('SDO-10：方法选择只认**显式**写法 —— 选项原文/别名/显式引导词可以，散文里提到别名不算', () => {
  assert.deepEqual(parseMethodChoice('structured'), ['structured'])
  assert.deepEqual(parseMethodChoice('structured, oo'), ['structured', 'oo'])
  assert.deepEqual(parseMethodChoice('结构化 structured（数据字典 + 分层 DFD + ERD）（代价：慢）｜备注：测试选择'), ['structured'], '选项原文形态（真机就是这种答复）')
  assert.deepEqual(parseMethodChoice('选择：oo'), ['oo'], '显式引导词')
  assert.deepEqual(parseMethodChoice('none'), ['none'])
  // **反向（缺陷本身）**：备注里提到被否决的方案 ⇒ 不算选中
  assert.equal(parseMethodChoice('备注：我们否决了 structured 与 oo，先用别的'), undefined, '散文里出现别名不得算选中')
  assert.equal(parseMethodChoice('不要 structured'), undefined)
  assert.equal(parseMethodChoice('随便挑一个吧'), undefined)
})

test('SDO-14(3) / SDO-15(3)：`sdo_task action=update` 能改卡，但历史不重写、别人在做时不得改写范围', () => {
  const task = card('TASK-001')
  // ① 正常改：字段生效、revision 前进、留痕
  const ok = updateTask(store, journal, { taskId: 'TASK-001', by: 'cockpit', size: 'medium', dod: ['a', 'b'] })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok ? ok.task.size : '', 'medium')
  assert.equal(ok.ok ? ok.task.revision : 0, task.revision + 1)
  assert.deepEqual(ok.ok ? ok.changed.sort() : [], ['dod', 'size'])
  assert.equal(journal.read().events.filter((event) => event.type === 'task/updated').length, 1, '改卡要留痕')

  // ② CAS：版本对不上即拒
  const stale = updateTask(store, journal, { taskId: 'TASK-001', by: 'cockpit', expectedRevision: 1, size: 'large' })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok ? '' : stale.code, 'revision-mismatch')

  // ③ 已完成/已作废的卡不改（历史不重写）
  card('TASK-002', { status: 'done' })
  const done = updateTask(store, journal, { taskId: 'TASK-002', by: 'cockpit', size: 'small' })
  assert.equal(done.ok, false)
  assert.equal(done.ok ? '' : done.code, 'not-updatable')

  // ④ 有人在做时不得改 `writeScopes`（会造出两个写者）
  card('TASK-003')
  claim(store, journal, { taskId: 'TASK-003', owner: 'dev-a', expectedRevision: 1 })
  const locked = updateTask(store, journal, { taskId: 'TASK-003', by: 'cockpit', writeScopes: ['src/other/'] })
  assert.equal(locked.ok, false)
  assert.equal(locked.ok ? '' : locked.code, 'scope-locked')
  // 反向：owner 自己改可以；与范围无关的字段谁都能改
  assert.equal(updateTask(store, journal, { taskId: 'TASK-003', by: 'dev-a', writeScopes: ['src/other/'] }).ok, true)
  assert.equal(updateTask(store, journal, { taskId: 'TASK-003', by: 'cockpit', title: 't2' }).ok, true)
})

test('SDO-34：`.sdo/` 下的台账写入**不占卡的写范围**（要求如实闭合缺陷的卡不再两难）', () => {
  card('TASK-010', { writeScopes: ['src/TASK-010/'], evidenceRequired: ['command'] })
  const claimed = claim(store, journal, { taskId: 'TASK-010', owner: 'dev-a', sessionId: 's1', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  const claimSeq = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  // 工具类写入（`sdo_test action=record|defect` 走 `.sdo/`）落在卡的写范围之外
  recordWorkspaceChanges({
    store, sessionId: 's1', seq: claimSeq + 1, journalSeq: claimSeq + 1,
    summary: { files: [{ path: '.sdo/defects/DEF-001.yml' }, { path: 'src/TASK-010/ok.ts' }] },
    enabled: true, hasProject: true,
  })
  const done = report(store, journal, {
    taskId: 'TASK-010', owner: 'dev-a', status: 'done',
    evidence: [{ kind: 'command', detail: 'exit 0', at: 'x' }],
  })
  assert.equal(done.ok, true, `台账写入不得判成越界：${done.ok ? '' : done.detail}`)

  // 反向：**产品文件**越界仍然判红（口径没有被放宽）
  card('TASK-011', { writeScopes: ['src/TASK-011/'], evidenceRequired: ['command'] })
  claim(store, journal, { taskId: 'TASK-011', owner: 'dev-b', sessionId: 's2', expectedRevision: 1 })
  const seq2 = journal.read().events.filter((event) => event.type === 'task/claimed').map((event) => event.seq).pop() as number
  recordWorkspaceChanges({
    store, sessionId: 's2', seq: seq2 + 1, journalSeq: seq2 + 1,
    summary: { files: [{ path: '.sdo/tests/TC-001.yml' }, { path: 'src/other/escape.ts' }] },
    enabled: true, hasProject: true,
  })
  const violated = report(store, journal, {
    taskId: 'TASK-011', owner: 'dev-b', status: 'done',
    evidence: [{ kind: 'command', detail: 'exit 0', at: 'x' }],
  })
  assert.equal(violated.ok, false)
  assert.equal(violated.ok ? '' : violated.code, 'write-scope-violation')
  assert.match(violated.ok ? '' : violated.detail, /src\/other\/escape\.ts/u, '要点名真正的越界文件')
})

test('SDO-46：blocked 卡**仍占**写范围（有意口径），但冲突要**说清持有者状态与解除动作**', () => {
  const blocked = card('TASK-020', { status: 'blocked', writeScopes: ['tools/checks/'] })
  const fresh = card('TASK-021', { writeScopes: ['tools/checks/'] })
  const issues = validatePlan([blocked, fresh]).filter((issue) => issue.code === 'write-scope-disjoint')
  assert.equal(issues.length > 0, true, 'blocked 仍排他（D6-1 的口径保持不变）')
  assert.match(issues[0]?.detail ?? '', /blocked/u, '要点明挡住的卡处于 blocked')
  assert.match(issues[0]?.remedy ?? '', /action=release|drop/u, '要给出解除动作')
})

test('SDO-35 / SDO-36 / SDO-48②：三条"静默放过"都在实现里关掉了（源码级守卫 + 类型契约）', () => {
  const gates = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.match(gates, /task\.role !== 'reviewer'/u, 'SDO-35：C-42 必须排除评审卡（否则自我递归）')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.claimSession\(call, args\.taskId\)/u, 'SDO-36：自评护栏要按**会话身份**判')
  assert.match(index, /call\.sessionId === claimSession/u, 'SDO-36：判据必须是「调用方会话 == 认领会话」（只查不判等于没拦）')
  assert.match(index, /kSelfReviewSameSession/u, '并给出可读拒绝')
  const design = readFileSync(join(ROOT, 'src', 'domain', 'design.ts'), 'utf8')
  assert.match(design, /basisSource,/u, 'SDO-48②：确认事件要带 basisSource（user/proxy）')
  assert.match(design, /basisSource: 'user' \| 'proxy' = 'user'/u, '默认 user，代盖要显式 proxy')
})

// —————————————————————— TASK-007：测试报告进签字审核单（REQ-051） ——————————————————————
//
// 本卡补的那条缝：报告的**渲染**早就有了（TASK-001），签字面却**看不见它** ——
// `office.ts` 从未调用 `renderTestReportSignable`，验证阶段签字时用户签的是判据与别的集合，
// 报告正文不在审核单里。三处落点：受审段构造（`renderedDocReviewItem`）、渲染稿内联
// （`reviewDoc` 的字符串分支）、G6 装配（`office.signReviewDoc`）。
//
// 两条跨卡纪律（卡上点名）：
//   · **不另造页/截断**：分页属客户端读取路径（PAGE_LINES/MAX_PAGES），侧边栏走全文落盘 ⇒ payload 里不造页概念；
//   · 本文件/本轮改的模块**不得直接引用后续卡才有的字段**（`task001-red-baseline` 会把冻结的修正前
//     `testingStore.ts` 与当前 src/ 合成一棵树编译）—— 故下面读 `unregistered` 一类新字段时一律宽松取值。

const M45_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm45-report')

/** 一棵"验证阶段 + 已登记测试报告"的最小树。 */
function reportFixture(threshold = '80%'): { store: SdoStore; journal: Journal; seq: number } {
  rmSync(M45_BASE, { recursive: true, force: true })
  mkdirSync(join(M45_BASE, '.sdo', 'testing'), { recursive: true })
  const fixtureStore = new SdoStore(join(M45_BASE, '.sdo'))
  const fixtureJournal = new Journal(fixtureStore)
  writeTestingSource(fixtureStore, 'report', 'report', {
    exitCriteria: [{
      id: 'C-53', criterion: '语句覆盖', metric: 'statement',
      threshold, scope: 'src/domain', verdict: 'pass',
    }],
    mutationKillRate: '0.9',
  }, fixtureJournal)
  const seq = currentJournalSeq(fixtureStore, fixtureJournal)
  writeTestingDoc(fixtureStore, 'report', { seq }, fixtureJournal)
  return { store: fixtureStore, journal: fixtureJournal, seq }
}

test('TASK-007 落点一/三：报告投影成受审段 —— 正文是渲染稿（带渲染头与指纹），不是字段树', () => {
  const { store: fixtureStore } = reportFixture()
  const signable = renderTestReportSignable({ store: fixtureStore })
  assert.equal(signable.payload.collection, 'testing/report.yml', '受审集合名要指向报告真源')
  const item = signable.payload.items[0]
  assert.ok(item !== undefined, '报告必须成为一条受审条目')
  assert.equal(typeof item.content, 'string', '正文是**渲染稿文本**（走 reviewDoc 的字符串分支内联）')

  // 经 `renderedDocReviewItem` 归一后，指纹口径与既有条目一致（contentHash 绑内容）
  const built = renderedDocReviewItem({
    collection: item.collection, id: item.id, path: item.path, text: String(item.content),
  })
  assert.match(built.hash, /^sha256:[0-9a-f]{64}$/u, '逐条指纹按既有 contentHash 口径给出')
  assert.equal(built.path, 'docs/TESTREPORT.md', '源路径要能追到用户看的那份报告')

  // 正文与盘上那份逐字节一致，且带 `# ` 标题与渲染头（既有文档口径）
  const onDisk = readFileSync(join(M45_BASE, 'docs', 'TESTREPORT.md'), 'utf8')
  assert.equal(built.content, onDisk, '审核单里内联的必须是盘上那份报告')
  assert.match(onDisk, /^<!-- generated by /u, '渲染头第一行自证生成器')
  assert.match(onDisk, /source: \.sdo\/testing\/report\.yml/u, '渲染头要写真源落点')
  assert.match(onDisk, /@ journal seq \d+/u, '渲染头要写 journal 序号')
  assert.match(onDisk, /^# /mu, '报告要有 `# ` 标题（审核单首行标题口径）')
})

test('TASK-007 守卫·可观察形式：验证阶段的签字审核单正文里**确实出现测试报告内容**', () => {
  const { store: fixtureStore } = reportFixture()
  const signable = renderTestReportSignable({ store: fixtureStore })
  // 复刻 office.signReviewDoc 的装配：流程数据声明的集合 + 报告受审段
  const payload = [
    ...readReviewPayload(fixtureStore, []),
    {
      collection: signable.payload.collection,
      items: signable.payload.items.map((item) => renderedDocReviewItem({
        collection: item.collection, id: item.id, path: item.path, text: String(item.content),
      })),
    },
  ]
  const doc: SignReviewDoc = {
    gate: 'G6',
    gateText: '验证门禁',
    phaseText: '验证',
    statusText: '通过',
    at: '2026-10-13T00:00:00.000Z',
    criteria: [],
    artifacts: [],
    unjudged: false,
    payload,
    fingerprint: reviewFingerprint('G6', payload),
    seq: 0,
  }
  const text = renderSignReviewDoc(doc)
  // **这条断言才是本卡要补的缝**：不是"有这一段"，而是正文里能读到报告的真内容。
  assert.match(text, /C-53/u, '审核单里要能读到报告的逐条结论（准出准则 C-53）')
  assert.match(text, /语句覆盖/u, '还要读到准则名 —— 只印集合名等于没内联')
  assert.match(text, /docs\/TESTREPORT\.md/u, '正文要标出源路径，用户知道点的是哪份')
  assert.match(text, /sha256:[0-9a-f]{8}/u, '正文要带内容指纹（可核对是不是这一版）')
  // 反向：报告正文没进 payload ⇒ 上面那些内容就不该出现（证明断言不是恒真）
  const bare = renderSignReviewDoc({ ...doc, payload: [], fingerprint: reviewFingerprint('G6', []) })
  assert.doesNotMatch(bare, /C-53/u, '没有受审段时不该凭空出现报告内容')
})

test('TASK-007 守卫·两态：指纹一致可签 / 报告真源变更后拒签并点名', () => {
  const { store: fixtureStore } = reportFixture()
  // ① 指纹一致 ⇒ 机械核对放行
  const before = renderTestReportSignable({ store: fixtureStore })
  const payloadBefore = [{
    collection: before.payload.collection,
    items: before.payload.items.map((item) => renderedDocReviewItem({
      collection: item.collection, id: item.id, path: item.path, text: String(item.content),
    })),
  }]
  const recorded = payloadIndex(payloadBefore) // 签字时记下的逐条索引
  const same = reviewFingerprint('G6', payloadBefore)
  assert.equal(same, reviewFingerprint('G6', payloadBefore), '同内容两次指纹一致（幂等）')
  assert.deepEqual(diffPayloadIndex(recorded, payloadIndex(payloadBefore)), [], '指纹一致 ⇒ 无差异 ⇒ 可签')

  // ② 真源变更（阈值 80% → 95%，且**不重渲染**）⇒ 拒签并点名差异
  writeTestingSource(fixtureStore, 'report', 'report', {
    exitCriteria: [{
      id: 'C-53', criterion: '语句覆盖', metric: 'statement',
      threshold: '95%', scope: 'src/domain', verdict: 'pass',
    }],
    mutationKillRate: '0.9',
  })
  const after = renderTestReportSignable({ store: fixtureStore })
  assert.equal(after.sourceChanged, true, '真源变了 ⇒ sourceChanged（报告与真源已脱钩）')
  assert.equal(after.stale, true, '脱钩的报告不许签')
  const payloadAfter = [{
    collection: after.payload.collection,
    items: after.payload.items.map((item) => renderedDocReviewItem({
      collection: item.collection, id: item.id, path: item.path, text: String(item.content),
    })),
  }]
  assert.notEqual(reviewFingerprint('G6', payloadAfter), same, '真源一变整篇指纹就得变（否则签字绑不住内容）')
  const diff = diffPayloadIndex(recorded, payloadIndex(payloadAfter))
  assert.ok(diff.length > 0, '指纹不符要**点名差异**（AC-204），不能只说"不一致"')
  assert.ok(diff.join(' ').includes('docs/TESTREPORT.md'), `差异要点到报告这一条：${diff.join(' ')}`)
})
