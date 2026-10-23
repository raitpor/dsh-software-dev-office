/**
 * **增量 222：发布计划工具面（`sdo_release`）**（`REQ-063` / `TASK-183`）。
 *
 * 这张卡把"落盘 `r-0.1.7` 只能由驾驶舱跑一段 `node` 脚本直调域函数"这条路径包成**工具**：
 * `show` / `propose` / `sign` / `write` / `change`。本文件钉的是**行为**，逐条对着卡上的 DoD：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | `M222-01` | 注册面：五个动作、描述来自语言包 `sdo.release`、**参数面里没有 `frozenAtSeq`** |
 * | `M222-02` | 空台账的 `show`：0 份 ⇒ 三条判据**都不判**（"没说红"不许被读成绿） |
 * | `M222-03` | `propose` **绝不写盘**（盘面逐字节不变）+ 现算集合 + 两条判据预演 |
 * | `M222-04` | 无签名直写**必红**；冻结前 `change` 必红（没有可变更的对象） |
 * | `M222-05` | 伪造 `frozenAtSeq` 必红：参数面直接拒 + 手写 YAML 的签字在真源里核不到（`freeze-unwitnessed`） |
 * | `M222-06` | 完整链 `propose → sign → write`：落盘读数、journal 的 human 出处、`C-75` 绿、签字被消费 |
 * | `M222-07` | `change` 的参数面与**那一次人签**：签字与 add/remove/reason 对不上 ⇒ 拒 |
 * | `M222-08` | 完整链 `change → show`：`release/changed` 的前后计数与差集、三条判据读数全绿 |
 * | `M222-09` | `change` 反例格①：改了集合却没有 change 事件 ⇒ 红（核心判据同判） |
 * | `M222-10` | `change` 反例格③：事件说改 A、实际改 B ⇒ 红（差集对不上） |
 * | `M222-11` | i18n：`sdo.release` 在两份语言包里都有，`en` 侧不残留中文 |
 *
 * **读散文棘轮的口径**（`test/m189.test.ts` 的 `KNOWN_PROSE_GAP`）：本文件**不登记** —— 所有断言的
 * **取值/模式实参**都是 ASCII（id / 事件名 / 机器面 `kind` / 计数），中文只出现在**第三个实参之后**的
 * 断言消息里（`extractProseSites` 明确把"第三个及以后实参"当消息，不算取值）。这也是本文件断言
 * 一律写成 `assert.equal(x, y, '…')` / `assert.match(s, /re/u, '…')` 而不用两个实参的 `assert.ok(x, '…')`
 * 的原因：两个实参时消息会被当成取值，于是凭空多出一个"读散文"站点。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { t } from '../src/domain/i18n.js'
import { currentRelease, freezeTraceFindings, listReleases, readRelease } from '../src/domain/release.js'
import {
  RELEASE_ACTIONS,
  RELEASE_CHANGED_EVENT,
  RELEASE_SIGNED_EVENT,
  changeTraceFindings,
  createReleaseTool,
  releaseChange,
  releasePropose,
  releaseShow,
  releaseSign,
  releaseWrite,
  setsDigest,
  signatureReadout,
} from '../src/domain/releaseTool.js'
import type { ReleaseLedger } from '../src/domain/releaseTool.js'
import { loadPackagedYaml } from '../src/infra/data.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m222/', import.meta.url))
const CJK = /[\u4e00-\u9fff]/u

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 一份**新台账**（每个用例一份：`REV-076` 的"夹具一律走工厂函数"同一条纪律）。 */
function freshLedger(name: string): ReleaseLedger {
  const store = new SdoStore(join(BASE, name, '.sdo'))
  store.ensureLayout()
  return { store, journal: new Journal(store) }
}

/** 需求夹具（`propose` 只读 `id` / `status` / `priority`，其余字段按真实形状补齐）。 */
function seedRequirement(ledger: ReleaseLedger, id: string, priority: string, status = 'baselined'): void {
  ledger.store.writeYaml(['requirements', `${id}.yml`], {
    requirement: {
      id,
      title: id,
      kind: 'functional',
      statement: 's',
      rationale: 'r',
      source: {},
      priority,
      ambiguity: { score: 0, dimensions: {}, open: [] },
      acceptance: [],
      status,
      version: 1,
      baseline: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    },
  })
}

/** 缺陷夹具（`nonScope` 承接时用它的 `status` 判"已终结"）。 */
function seedDefect(ledger: ReleaseLedger, id: string, status: string): void {
  ledger.store.writeYaml(['defects', `${id}.yml`], {
    defect: { id, title: id, severity: 'major', status, at: '2026-10-23T00:00:00.000Z' },
  })
}

/** 台账逐文件 sha256 清单（"一个字节都没写"的判据：逐文件、逐字节，不是"条数没变"）。 */
function sdoDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      out[full.slice(root.length)] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return out
}

/**
 * 追加一条事件（测试里"伪造"用）。
 *
 * 为什么不能直接 `journal.append(RELEASE_CHANGED_EVENT, …)`：`SdoEventType` 是**闭合联合**，
 * `release/changed` 还没登记进去（登记点在 `src/types.ts`，不在本卡写范围）。写侧因此走**最小结构化接口**
 * —— 与 `src/domain/releaseTool.ts` 的 `ReleaseEventSink` 同一处置（`Journal` 结构上满足它）。
 */
function appendEvent(ledger: ReleaseLedger, type: string, data: Record<string, unknown>): void {
  const sink: { append(eventType: string, payload: Record<string, unknown>): unknown } = ledger.journal
  sink.append(type, data)
}

/** 真源里的某类事件（按 `type` 字符面筛）。 */
function eventsOf(ledger: ReleaseLedger, type: string): { seq: number; data: Record<string, unknown> }[] {
  return ledger.journal.read().events
    .filter((event) => String(event.type) === type)
    .map((event) => ({ seq: event.seq, data: event.data as Record<string, unknown> }))
}

/* —————————————————————————————————————— M222-01 —————————————————————————————————————— */

test('M222-01 注册面：五个动作、描述来自语言包、参数面里没有 frozenAtSeq', () => {
  const tool = createReleaseTool({
    workspace: () => '',
    store: (root) => new SdoStore(root),
    journal: (root) => new Journal(new SdoStore(root)),
  })
  assert.equal(tool.name, 'sdo_release', '工具名就是卡上那个名')
  assert.deepEqual([...RELEASE_ACTIONS], ['show', 'propose', 'sign', 'write', 'change'], '五个动作，一个不多一个不少')
  assert.equal(tool.description, t('sdo.release'), '描述必须来自语言包的 sdo.release 段（不是硬编码文案）')
  assert.equal(tool.description.length > 40, true, '描述不能是兜底的空壳（取不到键时 t() 只回键名）')

  const schema = tool.parameters as unknown as { required?: string[]; properties?: Record<string, unknown> }
  assert.deepEqual(schema.required, ['action'], '只有 action 必填')
  const names = Object.keys(schema.properties ?? {})
  // 卡上的硬规则：`frozenAtSeq` **不许调用方填** —— 参数面里根本没有这个键，
  // 连"误传"都得靠宿主松口径才进得来（那种情况行为层仍会拒，见 M222-05）
  assert.equal(names.includes('frozenAtSeq'), false, 'frozenAtSeq 不是参数：那一刻由工具在落盘时取真实序号')
  assert.equal(names.includes('frozenBy'), false, 'frozenBy 同理（只认 human，不给调用方机会）')
  for (const key of ['id', 'add', 'remove', 'reason', 'approvedBy', 'requirements', 'acceptance', 'nonScope']) {
    assert.equal(names.includes(key), true, `参数面缺 ${key}`)
  }
})

/* —————————————————————————————————————— M222-02 —————————————————————————————————————— */

test('M222-02 空台账的 show：0 份 ⇒ 三条判据都不判（不说红 ≠ 绿）', () => {
  const ledger = freshLedger('show-empty')
  const shown = releaseShow(ledger)
  assert.equal(shown.ok, true, 'show 在空台账上不许报错（"还没有规划"是合法读数）')
  if (!shown.ok) return
  assert.equal(shown.releases, 0, '一份 release 都没有')
  assert.equal(shown.current, undefined, '没有当前版')
  assert.equal(shown.frozen, false, '没冻')
  assert.deepEqual(shown.findings, { freeze: [], defer: [], change: [] }, '三条判据一条都不判')
  assert.equal(shown.text.includes(t('uiRelease.kReleaseShowNoJudgement')), true, '回执必须说清"这一轮不判"（不许让沉默读成绿）')
})

/* —————————————————————————————————————— M222-03 —————————————————————————————————————— */

test('M222-03 propose：绝不写盘（盘面逐字节不变），现算集合 + 两条判据预演', () => {
  const ledger = freshLedger('propose')
  seedRequirement(ledger, 'REQ-001', 'must')
  seedRequirement(ledger, 'REQ-002', 'should')
  seedRequirement(ledger, 'REQ-003', 'must', 'draft')
  seedRequirement(ledger, 'REQ-004', 'wont')
  ledger.journal.append('project/created', {})
  const before = sdoDigest(ledger.store.root)

  const proposed = releasePropose(ledger, { id: 'r-0.1.8' })
  assert.equal(proposed.ok, true, 'propose 在任何台账上都不该失败')
  if (!proposed.ok) return
  assert.deepEqual(proposed.sets.requirements, ['REQ-001', 'REQ-002'], '只收 baselined 且不是 wont 的需求（草稿与 wont 都不进本版）')
  assert.deepEqual(proposed.sets.acceptance, [], '提案不擅自把 AC 塞进集合（与 r-0.1.7 的读数同口径）')
  assert.deepEqual(proposed.sets.nonScope, [], '还没有上一版，没有可承接的顺延')
  // 预演：提案还没签字 ⇒ 冻结面必红（这正是"落盘前就知道会红在哪"）
  assert.equal(proposed.preview.freeze.some((item) => item.kind === 'collections-unsigned'), true, '提案未签 ⇒ 冻结面预演点名 collections-unsigned')

  const after = sdoDigest(ledger.store.root)
  assert.deepEqual(after, before, 'propose 后 .sdo/ 逐文件 sha256 逐字不变（不是"条数没变"）')
})

/* —————————————————————————————————————— M222-03b —————————————————————————————————————— */

test('M222-03b propose 承接顺延：未终结的顺延项 deferCount +1，已终结的不再出现', () => {
  const ledger = freshLedger('propose-carry')
  seedRequirement(ledger, 'REQ-001', 'must')
  seedDefect(ledger, 'DEF-001', 'open')
  seedDefect(ledger, 'DEF-002', 'fixed')
  // 上一版（已冻结）：scope 收 REQ-001，两条缺陷都被明确顺延出去
  ledger.store.writeYaml(['releases', 'r-0.1.7.yml'], {
    release: {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-001'], acceptance: [] },
      nonScope: [
        { id: 'DEF-001', reason: 'not in this version', deferCount: 1, approvedBy: 'human' },
        { id: 'DEF-002', reason: 'not in this version', deferCount: 0, approvedBy: 'human' },
      ],
      frozenAtSeq: 2,
      frozenBy: 'human',
    },
  })
  appendEvent(ledger, 'release/written', {
    id: 'r-0.1.7',
    packageVersion: '0.1.7',
    requirements: 1,
    acceptance: 0,
    nonScope: 2,
    frozen: true,
  })

  const proposed = releasePropose(ledger, { id: 'r-0.1.8' })
  assert.equal(proposed.ok, true, '承接顺延的提案也要算得出来')
  if (!proposed.ok) return
  assert.deepEqual(proposed.carried, ['DEF-001'], '已终结（fixed）的顺延项不再承接，仍在飞的照旧')
  assert.deepEqual(proposed.sets.nonScope, ['DEF-001'], '顺延名单跟着承接走')
  assert.deepEqual(proposed.proposal.nonScope?.map((note) => note.deferCount), [2], 'deferCount 承接时 +1（它又被顺延了一版）')
  assert.deepEqual(proposed.proposal.nonScope?.map((note) => note.approvedBy), ['human'], '批准人只认 human（承接不改签字人）')
  assert.deepEqual(proposed.delivered, ['REQ-001'], '已在冻结版本 scope 里的需求 = 已交付，不再进本版')
  assert.deepEqual(proposed.sets.requirements, [], '已交付的需求不进提案（历史不重写，也不重做）')
})

/* —————————————————————————————————————— M222-04 —————————————————————————————————————— */

test('M222-04 无签名直写必红；冻结前 change 必红（没有可变更的对象）', () => {
  const ledger = freshLedger('unsigned')
  seedRequirement(ledger, 'REQ-001', 'must')
  const written = releaseWrite(ledger, { id: 'r-0.1.7', requirements: ['REQ-001'], acceptance: [] })
  assert.equal(written.ok, false, '一次人签都没有 ⇒ 落盘必须被拒')
  if (written.ok) return
  assert.equal(written.code, 'signature-missing', '拒绝原因必须是"没有可用人签"（机器面）')
  assert.equal(readRelease(ledger.store, 'r-0.1.7'), undefined, '被拒的落盘不许留下半成品文件')
  assert.equal(eventsOf(ledger, 'release/written').length, 0, '被拒的落盘不许留下 release/written 事件')

  const changed = releaseChange(ledger, { id: 'r-0.1.7', add: ['REQ-001'], reason: 'r', approvedBy: 'human' })
  assert.equal(changed.ok, false, '没有 release 就变更 ⇒ 拒')
  if (changed.ok) return
  assert.equal(changed.code, 'no-release', '机器面先说清"台账里没有这一份"')


  // 冻结前不许 change：文件在盘上但没签字 ⇒ 没有可变更的对象
  ledger.store.writeYaml(['releases', 'r-0.1.7.yml'], {
    release: { id: 'r-0.1.7', packageVersion: '0.1.7', scope: { requirements: ['REQ-001'], acceptance: [] } },
  })
  const draft = releaseChange(ledger, { id: 'r-0.1.7', add: ['REQ-002'], reason: 'r', approvedBy: 'human' })
  assert.equal(draft.ok, false, '草稿不是可变更的对象')
  if (draft.ok) return
  assert.equal(draft.code, 'not-frozen', '机器面必须是 not-frozen')
})

/* —————————————————————————————————————— M222-05 —————————————————————————————————————— */

test('M222-05 伪造 frozenAtSeq 必红：参数面拒 + 手写 YAML 的签字核不到', () => {
  const ledger = freshLedger('forged')
  seedRequirement(ledger, 'REQ-001', 'must')
  const signed = releaseSign(ledger, {
    id: 'r-0.1.7',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  assert.equal(signed.ok, true, '先有一份真人签（这里直接走域层落账半）')
  const forged = releaseWrite(ledger, { id: 'r-0.1.7', requirements: ['REQ-001'], acceptance: [], frozenAtSeq: 42 })
  assert.equal(forged.ok, false, '调用方自带 frozenAtSeq ⇒ 必须拒（那一刻由工具取）')
  if (forged.ok) return
  assert.equal(forged.code, 'frozen-at-seq-forbidden', '机器面必须是 frozen-at-seq-forbidden')

  // 手写一份"已冻结"的 YAML：frozenBy/frozenAtSeq 齐备、形状合法，但真源里那条序号不是一次人签
  ledger.store.writeYaml(['releases', 'r-0.1.9.yml'], {
    release: {
      id: 'r-0.1.9',
      packageVersion: '0.1.9',
      scope: { requirements: ['REQ-001'], acceptance: [] },
      frozenAtSeq: 1,
      frozenBy: 'human',
    },
  })
  const events = ledger.journal.read().events
  const findings = freezeTraceFindings({ releases: listReleases(ledger.store), events })
  assert.equal(findings.some((item) => item.kind === 'freeze-unwitnessed' && item.subjectId === 'r-0.1.9'), true, '手写的 frozenAtSeq 在真源里核不到人签 ⇒ freeze-unwitnessed 点名这一份')
})

/* —————————————————————————————————————— M222-06 —————————————————————————————————————— */

test('M222-06 完整链 propose → sign → write：落盘读数 + journal 的 human 出处 + C-75 绿', () => {
  const ledger = freshLedger('chain-freeze')
  seedRequirement(ledger, 'REQ-001', 'must')
  seedRequirement(ledger, 'REQ-002', 'must')

  // ① propose：只回显
  const proposed = releasePropose(ledger, { id: 'r-0.1.8' })
  assert.equal(proposed.ok, true, '提案要能算出来')
  if (!proposed.ok) return
  const sets = proposed.sets

  // ② sign：用户签字（域层落账半；问答通道在工具层，见 M222-01 的参数面）
  const signed = releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: sets.requirements,
    acceptance: sets.acceptance,
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  assert.equal(signed.ok, true, '签字要落得下来')
  if (!signed.ok) return
  const signEvents = eventsOf(ledger, RELEASE_SIGNED_EVENT)
  assert.equal(signEvents.length, 1, '真源里必须有一条 release/signed')
  assert.equal(signEvents[0]?.data['by'], 'human', '签字人必须是 human（驾驶舱与模型不得代签）')
  assert.equal(signEvents[0]?.data['channel'], 'question', '来源通道必须是问答通道')
  assert.equal(signEvents[0]?.data['answeredAt'], '2026-10-23T00:00:00.000Z', '作答时刻随签字进台账')
  assert.equal(signatureReadout(ledger.journal.read().events, 'r-0.1.8').pending?.seq, signed.seq, '签完立刻是"待用"状态')

  // ③ write：落盘
  const written = releaseWrite(ledger, {
    id: 'r-0.1.8',
    requirements: sets.requirements,
    acceptance: sets.acceptance,
  })
  assert.equal(written.ok, true, '有人签 ⇒ 落盘要过')
  if (!written.ok) return
  const disk = readRelease(ledger.store, 'r-0.1.8')
  assert.equal(disk?.frozenBy, 'human', '文件里的签字人只认 human')
  assert.equal(typeof disk?.frozenAtSeq, 'number', 'frozenAtSeq 由工具取真实序号写进文件')
  assert.equal(disk?.frozenAtSeq, written.frozenSeq, 'frozenAtSeq 指向**带签字**的那次落盘（真源里核得到人签的那一条）')
  assert.equal(written.frozenSeq > written.anchorSeq, true, '两段写：先不冻结落一次（拿真实序号），再冻结落一次（钉住那一刻）')
  assert.equal(signatureReadout(ledger.journal.read().events, 'r-0.1.8').pending, undefined, '落完盘这条签字就消费掉了（同一份签字不能无限次落盘）')

  // C-75 核心判据（门禁读的那一份）：绿
  const releases = listReleases(ledger.store)
  const findings = freezeTraceFindings({ releases, events: ledger.journal.read().events })
  assert.deepEqual(findings.map((item) => `${item.kind}:${item.subjectId}`), [], '冻结面必须全绿（人签 + 序号可核 + 条数一致）')
  assert.equal(currentRelease(releases)?.id, 'r-0.1.8', '落盘并冻结之后它就是当前版')

  // 落盘之后：再写一次没有新签字 ⇒ 拒（消费语义的正面证据）
  const again = releaseWrite(ledger, { id: 'r-0.1.8', requirements: sets.requirements, acceptance: sets.acceptance })
  assert.equal(again.ok, false, '一次签字只能用一次')
  if (again.ok) return
  assert.equal(again.code, 'signature-missing', '机器面必须是 signature-missing')
})

/* —————————————————————————————————————— M222-07 —————————————————————————————————————— */

test('M222-07 change 的参数面与那一次人签：对不上就拒', () => {
  const ledger = freshLedger('change-guards')
  seedRequirement(ledger, 'REQ-001', 'must')
  seedRequirement(ledger, 'REQ-002', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  const written = releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  assert.equal(written.ok, true, '前置：先有一份冻结的集合')

  const noReason = releaseChange(ledger, { id: 'r-0.1.8', add: ['REQ-002'], reason: '', approvedBy: 'human' })
  assert.equal(noReason.ok, false, '没有理由的变更 ⇒ 拒')
  if (noReason.ok) return
  assert.equal(noReason.code, 'reason-missing', '机器面必须是 reason-missing')

  const badApprover = releaseChange(ledger, { id: 'r-0.1.8', add: ['REQ-002'], reason: 'r', approvedBy: 'cockpit' })
  assert.equal(badApprover.ok, false, '批准人不是 human ⇒ 拒')
  if (badApprover.ok) return
  assert.equal(badApprover.code, 'approver-not-human', '机器面必须是 approver-not-human')

  const noIds = releaseChange(ledger, { id: 'r-0.1.8', reason: 'r', approvedBy: 'human' })
  assert.equal(noIds.ok, false, '一个 id 都不点 ⇒ 拒')
  if (noIds.ok) return
  assert.equal(noIds.code, 'ids-empty', '机器面必须是 ids-empty')

  const noSignature = releaseChange(ledger, { id: 'r-0.1.8', add: ['REQ-002'], reason: 'r', approvedBy: 'human' })
  assert.equal(noSignature.ok, false, '这一次变更没有对应的人签 ⇒ 拒')
  if (noSignature.ok) return
  assert.equal(noSignature.code, 'signature-missing', '机器面必须是 signature-missing')

  // 签了 A、实际改 B：那一次人签对不上这一次变更 ⇒ 拒（`freeze-unwitnessed` 同口径）
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'change',
    add: ['REQ-002'],
    remove: [],
    reason: 'r',
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  const mismatched = releaseChange(ledger, { id: 'r-0.1.8', add: ['REQ-002'], remove: ['REQ-001'], reason: 'r', approvedBy: 'human' })
  assert.equal(mismatched.ok, false, '签字里的改动与这一次的改动不是同一个东西 ⇒ 拒')
  if (mismatched.ok) return
  assert.equal(mismatched.code, 'change-unsigned', '机器面必须是 change-unsigned')
  assert.equal(eventsOf(ledger, RELEASE_CHANGED_EVENT).length, 0, '被拒的变更不许留下 release/changed 事件')
})

/* —————————————————————————————————————— M222-08 —————————————————————————————————————— */

test('M222-08 完整链 change → show：事件的前后计数与差集、三条判据读数全绿', () => {
  const ledger = freshLedger('chain-change')
  seedRequirement(ledger, 'REQ-001', 'must')
  seedRequirement(ledger, 'REQ-002', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })

  // 用户对"把 REQ-002 加进来"这一次变更签字
  const signedChange = releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'change',
    add: ['REQ-002'],
    remove: [],
    reason: 'scope 加一条',
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  assert.equal(signedChange.ok, true, '变更的签字要落得下来')
  const changed = releaseChange(ledger, {
    id: 'r-0.1.8',
    add: ['REQ-002'],
    remove: [],
    reason: 'scope 加一条',
    approvedBy: 'human',
  })
  assert.equal(changed.ok, true, '签了的那一次变更要能落盘')
  if (!changed.ok) return
  assert.deepEqual(changed.before.requirements, ['REQ-001'], '变更前：一条需求')
  assert.deepEqual(changed.after.requirements, ['REQ-001', 'REQ-002'], '变更后：两条需求')
  assert.deepEqual(changed.added, ['REQ-002'], '差集点名被加进来的 id')
  assert.deepEqual(changed.removed, [], '这次没有移出的 id')

  const changeEvents = eventsOf(ledger, RELEASE_CHANGED_EVENT)
  assert.equal(changeEvents.length, 1, '真源里必须有一条 release/changed')
  const data = changeEvents[0]?.data ?? {}
  assert.deepEqual(data['beforeCounts'], { requirements: 1, acceptance: 0, nonScope: 0 }, '事件带变更前计数')
  assert.deepEqual(data['afterCounts'], { requirements: 2, acceptance: 0, nonScope: 0 }, '事件带变更后计数')
  assert.deepEqual(data['added'], ['REQ-002'], '事件带 id 差集（加了谁）')
  assert.deepEqual(data['removed'], [], '事件带 id 差集（移了谁）')
  assert.equal(data['approvedBy'], 'human', '批准人必须是 human')
  assert.equal(data['signedAtSeq'], signedChange.ok ? signedChange.seq : -1, '事件点名这一次变动对应的人签序号')

  // 三条判据读数：全绿
  const releases = listReleases(ledger.store)
  const events = ledger.journal.read().events
  assert.deepEqual(freezeTraceFindings({ releases, events }), [], '冻结面：重新落盘 + 人签序号前移 ⇒ 不判红')
  assert.deepEqual(changeTraceFindings({ releases, events }), [], '变更面：有 change 事件且差集一致 ⇒ 绿')
  const shown = releaseShow(ledger)
  assert.equal(shown.ok, true, 'show 要读得出来')
  if (!shown.ok) return
  assert.deepEqual(shown.sets?.requirements, ['REQ-001', 'REQ-002'], 'show 的 scope 读数跟着变更走')
  assert.deepEqual(shown.findings, { freeze: [], defer: [], change: [] }, 'show 的三条面全绿')
  assert.equal(shown.frozen, true, '变更之后它仍然是冻结的（重新落了带签字的盘）')
})

/* —————————————————————————————————————— M222-09 —————————————————————————————————————— */

test('M222-09 change 反例格①：改了集合却没有 change 事件 ⇒ 红（核心判据同判）', () => {
  const ledger = freshLedger('cell-1')
  seedRequirement(ledger, 'REQ-001', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })

  // 手改：直接往已冻结的文件里加一条，**不走** change 控制、不落任何事件
  const disk = readRelease(ledger.store, 'r-0.1.8')
  assert.equal(disk !== undefined, true, '前置：先有落盘的文件')
  if (disk === undefined) return
  ledger.store.writeYaml(['releases', 'r-0.1.8.yml'], {
    release: { ...disk, scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: [] } },
  })

  const releases = listReleases(ledger.store)
  const events = ledger.journal.read().events
  const changeFindings = changeTraceFindings({ releases, events })
  assert.deepEqual(changeFindings.map((item) => item.kind), ['changed-without-event'], '变更面必须点名"改了却没有事件"')
  assert.equal(changeFindings[0]?.subjectId, 'r-0.1.8', '点名到那一份 release')
  const freezeFindings = freezeTraceFindings({ releases, events })
  assert.deepEqual(freezeFindings.map((item) => item.kind), ['collections-rewritten-after-freeze'], '核心判据（门禁读的那份）必须同判（合法路径之外就是红）')
})

/* —————————————————————————————————————— M222-10 —————————————————————————————————————— */

test('M222-10 change 反例格③：事件说改 A、实际改 B ⇒ 红', () => {
  const ledger = freshLedger('cell-3')
  seedRequirement(ledger, 'REQ-001', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  // 伪造一条变更事件：它说"加了 REQ-009"，而盘上要加的是 REQ-002（事件与文件各说各的）
  appendEvent(ledger, RELEASE_CHANGED_EVENT, {
    id: 'r-0.1.8',
    reason: 'forged',
    approvedBy: 'human',
    before: { requirements: ['REQ-001'], acceptance: [], nonScope: [] },
    after: { requirements: ['REQ-001', 'REQ-009'], acceptance: [], nonScope: [] },
    added: ['REQ-009'],
    removed: [],
    beforeCounts: { requirements: 1, acceptance: 0, nonScope: 0 },
    afterCounts: { requirements: 2, acceptance: 0, nonScope: 0 },
  })
  const disk = readRelease(ledger.store, 'r-0.1.8')
  if (disk === undefined) return
  ledger.store.writeYaml(['releases', 'r-0.1.8.yml'], {
    release: { ...disk, scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: [] } },
  })
  const findings = changeTraceFindings({ releases: listReleases(ledger.store), events: ledger.journal.read().events })
  assert.deepEqual(findings.map((item) => item.kind), ['changed-mismatch'], '事件说改 A、文件是 B ⇒ 变更面必须判红')
  assert.equal(findings[0]?.detail.includes('REQ-009'), true, '点名事件里那个被"改了"的 id')
  assert.equal(findings[0]?.detail.includes('REQ-002'), true, '点名盘上真正出现的 id（两边都要摆出来）')

  // 反例的反面：同一份真源，把事件改成"与盘一致" ⇒ 必须转绿（证明这一格不是恒红）
  const fixed = freshLedger('cell-3-green')
  seedRequirement(fixed, 'REQ-001', 'must')
  releaseSign(fixed, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  releaseWrite(fixed, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  appendEvent(fixed, RELEASE_CHANGED_EVENT, {
    id: 'r-0.1.8',
    reason: 'ok',
    approvedBy: 'human',
    before: { requirements: ['REQ-001'], acceptance: [], nonScope: [] },
    after: { requirements: ['REQ-001', 'REQ-002'], acceptance: [], nonScope: [] },
    added: ['REQ-002'],
    removed: [],
    beforeCounts: { requirements: 1, acceptance: 0, nonScope: 0 },
    afterCounts: { requirements: 2, acceptance: 0, nonScope: 0 },
  })
  const disk2 = readRelease(fixed.store, 'r-0.1.8')
  if (disk2 === undefined) return
  // 只换集合，冻结的两个字段原样保留（否则会顺手引入 collections-unsigned，把这一格搅浑）
  fixed.store.writeYaml(['releases', 'r-0.1.8.yml'], {
    release: {
      id: disk2.id,
      packageVersion: '0.1.8',
      scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: [] },
      ...(disk2.frozenAtSeq === undefined ? {} : { frozenAtSeq: disk2.frozenAtSeq }),
      frozenBy: 'human',
    },
  })
  assert.deepEqual(
    changeTraceFindings({ releases: listReleases(fixed.store), events: fixed.journal.read().events }),
    [],
    '事件与盘一致 ⇒ 变更面必须绿（这一格不许恒红）',
  )
})

/* —————————————————————————————————————— M222-11 —————————————————————————————————————— */

test('M222-11 i18n：sdo.release 在两份语言包里都有，en 侧不残留中文', () => {
  const zh = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/zh-CN.yml')
  const en = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/en.yml')
  assert.equal(typeof zh['sdo']?.['release'], 'string', 'zh-CN 里必须有 sdo.release（工具描述的落点）')
  assert.equal(typeof en['sdo']?.['release'], 'string', 'en 里同样要有（缺了会回落到中文）')
  assert.equal(CJK.test(en['sdo']?.['release'] ?? ''), false, 'en 的取值不许残留中文')
  // 本卡新增的 uiRelease 键：两份包必须**逐键**对得上（m120 全局守同一件事，这里钉本卡这一段）
  const added = [
    'kReleaseShowNoJudgement', 'kReleaseUnknownAction', 'kReleaseNoWorkspace', 'kReleaseReadFailed',
    'kReleaseShowHeader', 'kReleaseShowRow', 'kReleaseShowCurrent', 'kReleaseShowFindingRow',
    'kProposeHeader', 'kProposeCounts', 'kProposeNoWrite', 'kSignDone',
    'kToolWriteDone', 'kToolChangeDone', 'kRejectFrozenAtSeq', 'kRejectSignatureMissing',
    'kRejectSignatureMismatch', 'kRejectNotFrozen', 'kRejectChangeUnsigned', 'kParamAdd', 'kParamRemove',
  ]
  for (const key of added) {
    assert.equal(typeof zh['uiRelease']?.[key], 'string', `zh-CN 缺 uiRelease.${key}`)
    assert.equal(typeof en['uiRelease']?.[key], 'string', `en 缺 uiRelease.${key}`)
  }
  // 集合摘要的稳定性：同一份集合换个顺序仍是同一个 digest（签名面按内容比，不按写法比）
  assert.equal(
    setsDigest({ requirements: ['REQ-002', 'REQ-001'], acceptance: [], nonScope: [] }),
    setsDigest({ requirements: ['REQ-001', 'REQ-002'], acceptance: [], nonScope: [] }),
    'digest 只认集合内容',
  )
})

/* —————————————————————————————————————— M222-12 —————————————————————————————————————— */

test('M222-12 只读自证：show / propose 前后真源逐字节不变（含 project.json 派生视图）', () => {
  const ledger = freshLedger('read-only')
  seedRequirement(ledger, 'REQ-001', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  const before = sdoDigest(ledger.store.root)
  const journalBefore = readFileSync(join(ledger.store.root, 'journal.jsonl'))
  releaseShow(ledger)
  releasePropose(ledger, { id: 'r-0.1.9' })
  const after = sdoDigest(ledger.store.root)
  assert.deepEqual(after, before, 'show / propose 不得改动 .sdo/ 里的任何文件')
  assert.equal(readFileSync(join(ledger.store.root, 'journal.jsonl')).equals(journalBefore), true, 'journal 逐字节不变（不是条数不变）')
})

/** 一处"写盘"的确定性自证：同样的输入两次落盘，文件字节相同（写盘只经 `SdoStore` 的原子写）。 */
test('M222-13 落盘幂等：同一份集合再签一次再落一次，文件字节相同', () => {
  const ledger = freshLedger('idempotent')
  seedRequirement(ledger, 'REQ-001', 'must')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  const first = releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  assert.equal(first.ok, true, '第一次落盘')
  const diskFirst = readRelease(ledger.store, 'r-0.1.8')
  releaseSign(ledger, {
    id: 'r-0.1.8',
    kind: 'write',
    requirements: ['REQ-001'],
    acceptance: [],
    label: t('uiRelease.kSignOption'),
    answeredAt: '2026-10-23T00:00:00.000Z',
  })
  const second = releaseWrite(ledger, { id: 'r-0.1.8', requirements: ['REQ-001'], acceptance: [] })
  assert.equal(second.ok, true, '第二次落盘（同一份集合，重新签过）')
  const diskSecond = readRelease(ledger.store, 'r-0.1.8')
  assert.deepEqual(diskSecond?.scope, diskFirst?.scope, '同一份集合落两次：集合逐字相同（漂移的只有冻结序号）')
  assert.deepEqual(diskSecond?.nonScope, diskFirst?.nonScope, '顺延名单同样逐字相同')
  assert.equal((second.ok ? second.frozenSeq : 0) > (first.ok ? first.frozenSeq : 0), true, '重签一次 ⇒ 冻结序号前移（基线跟着走）')
})
