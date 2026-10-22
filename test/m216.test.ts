/**
 * `M216`（`TASK-176` / `REQ-063` 批 1④）：**顺延留痕与次数上限 + 冻结人签**。
 *
 * 规格 `docs/plan/2026-10-22-规格-0.1.7批1-版本作用域.md`：§3.3（`C-73` 顺延留痕与次数上限）、
 * §3.5（冻结＝人签、冻结后改集合只能走 `change`）+ §4 反例表。四个守卫态一一对应那四句：
 *
 * | 守卫态 | 构造 | 期望 | 反例 |
 * |---|---|---|---|
 * | ① 超上限 | 当前版 `nonScope` 里 `deferCount: 3`（上限 2） | **红**，且**要求用户裁决**（`needsUserDecision`） | `R7` |
 * | ② 静默顺延 | 只在旧版（已冻结）`scope` 里、当前版一个字都没提、无顺延记录 | **红**并点名实体 | `AC-277` 反例 |
 * | ③ 模型自写集合 | 当前版有集合、没有 `frozenBy: human` + `frozenAtSeq` | **红**（人签之前集合没有权威） | `R12` |
 * | ④ 冻结后改集合 | 冻结时 2 条、现盘 3 条，且之后没有已决策的变更 | **红**（绕过 `change`） | `R13` / `C-75` |
 *
 * 每个守卫态都配了**反向对照**（同一份夹具改一处就转绿），因为"恒红"的守卫与"恒绿"的守卫一样没用：
 * 恰好到上限不红、走完 `change` 不红、老版里的历史次数不重判、草稿不是当前版所以不红。
 *
 * 判定核心在 `src/domain/release.ts`（`deferTraceFindings` / `freezeTraceFindings`）：它们读的是
 * **派生结果 + 真源事件**，而这两样都属于派生层。门禁判据的**挂载**（判据 id / `check` 键 /
 * 写进流程数据）不在本卡范围 —— 那是 `TASK-171` 的活，本文件不假设它已接线。
 *
 * 已知边界（写下来，免得下一个人以为是漏判）：`release/written` 事件只带**条数**不带 id 集合
 * （字段面被 `M213-09` 钉死）⇒ "删一条、加一条、条数不变"这种改法 `M216-05` 核不到；
 * 要收紧得先扩事件字段面。这一条在 `M216-05` 里也有一条断言，确保它不是口头承诺。
 *
 * 写作约定（与 `test/m213.test.ts` 同规）：夹具里的字符串一律用英文（取值会被断言比较），
 * 中文只出现在用例名与**断言消息**里 —— `test/m189.test.ts` 的散文站点棘轮按身份登记，
 * 本文件的读散文站点数是 0，新增中文一律只进消息、不进取值。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_DEFER_LIMIT,
  RELEASE_DIR,
  deferLimitOf,
  deferTraceFindings,
  freezeTraceFindings,
  listReleases,
  writeRelease,
} from '../src/domain/release.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { Release, ReleaseNote } from '../src/types.js'

/** 每格一个临时 `.sdo`（不碰真账；`store` 与 `journal` 绑同一个根）。 */
function withStore<T>(run: (store: SdoStore, journal: Journal) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m216-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    return run(store, new Journal(store))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 下一件事会拿到的 journal 序号（冻结序号要与"落盘那一刻"对齐，`frozenAtSeq` 才核得动）。 */
function nextSeq(journal: Journal): number {
  return journal.read().events.length + 1
}

/** 一条顺延登记（四个必填字段齐备）。 */
function noteOf(id: string, deferCount = 1): ReleaseNote {
  return { id, reason: 'later', deferCount, approvedBy: 'human' }
}

/**
 * 一份**已冻结**的 release。
 *
 * 这一格里的 `frozenAtSeq` 只是形状（`M216-01`/`M216-02` 判的是留痕与次数，不核冻结真伪）；
 * "冻结序号能不能核到那一刻人签"由 `M216-04` 用真 journal 序号去守。
 */
function frozenRelease(
  id: string,
  version: string,
  requirements: string[],
  acceptance: string[] = [],
  nonScope: ReleaseNote[] = [],
): Release {
  return {
    id,
    packageVersion: version,
    scope: { requirements, acceptance },
    nonScope,
    frozenAtSeq: version === '0.1.6' ? 100 : 200,
    frozenBy: 'human',
  }
}

/** 取读数的 `kind` 清单（机器面；`detail` 是人读面，不拿它当判据）。 */
const kindsOf = (findings: readonly { kind: string }[]): string[] => findings.map((finding) => finding.kind)

test('M216-01 C-73 次数上限：上限内绿 / 恰好到顶不红 / 超上限红并要求用户裁决 / 项目可声明上限', () => {
  const base = frozenRelease('r-0.1.7', '0.1.7', ['REQ-063'])

  // ① 上限内 ⇒ 绿
  assert.deepEqual(
    deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-1', 1)] }] }),
    [],
    '顺延 1 次（上限 2）⇒ 不红',
  )
  // ② 恰好到上限 ⇒ 仍然绿（上限是"最多还能忍 N 次"，不是"第 N 次就红"）
  assert.deepEqual(
    deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-1', 2)] }] }),
    [],
    '顺延 2 次 = 恰好到上限 ⇒ 不红（否则上限就成了 1 次）',
  )
  // ③ 超上限 ⇒ 红，且**必须由用户裁决**
  const over = deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-1', 3)] }] })
  assert.deepEqual(kindsOf(over), ['defer-count-over-limit'], '顺延 3 次（上限 2）⇒ 红，且只报一条读数')
  assert.equal(over[0]?.subjectId, 'DEF-1', '判红要点名是哪个实体被反复顺延')
  assert.equal(over[0]?.deferCount, 3, '读数要带实际次数（回执里才对得上）')
  assert.equal(over[0]?.limit, 2, '读数要带判定用的上限（换上限后回执能看出按哪个判的）')
  assert.equal(over[0]?.needsUserDecision, true, '超上限必须交人裁决：模型不得自己放宽次数或改上限')
  assert.equal(over[0]?.detail.includes('3'), true, '人读面要点到次数')
  assert.equal(over[0]?.detail.includes('2'), true, '人读面要点到上限')

  // ④ 上限是**声明出来的**：显式给 3 ⇒ 同一个 3 次不红；显式给 0 ⇒ 连 1 次都算超
  assert.deepEqual(
    deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-1', 3)] }], limit: 3 }),
    [],
    '上限声明为 3 ⇒ 顺延 3 次不红（阈值不是写死在代码里的 2）',
  )
  const strict = deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-2', 0)] }], limit: 0 })
  assert.deepEqual(strict, [], '上限 0 且次数 0 ⇒ 不红（别把边界判成"一次都不许记"）')
  assert.deepEqual(
    kindsOf(deferTraceFindings({ releases: [{ ...base, nonScope: [noteOf('DEF-2', 1)] }], limit: 0 })),
    ['defer-count-over-limit'],
    '上限 0 ⇒ 顺延 1 次即红（阈值真的生效）',
  )

  // ⑤ 历史不重写：老版里的那次 5 次是既成事实，只判**当前版**
  const old = frozenRelease('r-0.1.6', '0.1.6', [], [], [noteOf('DEF-OLD', 5)])
  assert.deepEqual(
    deferTraceFindings({ releases: [old, frozenRelease('r-0.1.7', '0.1.7', ['REQ-063'])] }),
    [],
    '老版 nonScope 里的历史次数不重判（重判它只会让台账永久红，历史不重写）',
  )

  // ⑥ 一份 release 都没有 ⇒ 不判（发布层还没被采纳；不是"空集所以绿"）
  assert.deepEqual(deferTraceFindings({ releases: [] }), [], '没有 release 文件 ⇒ 这条判据无话可说')
})

test('M216-02 C-73 静默顺延：只从旧版 scope 消失即红；三路豁免与反向对照各自可观察', () => {
  const old = frozenRelease('r-0.1.6', '0.1.6', ['REQ-001', 'REQ-002', 'AC-001'])
  const current = frozenRelease('r-0.1.7', '0.1.7', ['REQ-063'], ['AC-278'])

  // ① 反例必红：old 承诺过三条，current 一个字都没提
  const silent = deferTraceFindings({ releases: [old, current] })
  assert.deepEqual(kindsOf(silent), ['defer-silent', 'defer-silent', 'defer-silent'], '三条承诺全从当前版消失 ⇒ 三条读数')
  assert.deepEqual(silent.map((finding) => finding.subjectId), ['AC-001', 'REQ-001', 'REQ-002'], '点名到每一条（排序稳定）')
  assert.equal(silent[1]?.fromVersion, '0.1.6', '读数要点名它是从哪一版消失的')
  assert.equal(silent[1]?.detail.includes('REQ-001'), true, '人读面要点到实体 id（否则用户不知道去找谁）')
  assert.equal(silent[1]?.detail.includes('r-0.1.7'), true, '人读面还要点到当前版（该登记到哪一份里）')

  // ② 豁免一：写进当前版的 `nonScope`（＝留痕登记） ⇒ 绿
  const registered = frozenRelease('r-0.1.7', '0.1.7', ['REQ-063'], ['AC-278'], [
    noteOf('REQ-001'),
    noteOf('REQ-002'),
    noteOf('AC-001'),
  ])
  assert.deepEqual(deferTraceFindings({ releases: [old, registered] }), [], '三条都显式登记进当前版 nonScope ⇒ 不红')

  // ③ 豁免二：真源里有点名的顺延记录（`release/deferred` 一类事件）
  assert.deepEqual(
    kindsOf(deferTraceFindings({ releases: [old, current], deferredRecords: ['REQ-001'] })),
    ['defer-silent', 'defer-silent'],
    '有记录的少点名一条：豁免按实体逐条生效（不是"有一个记录就全放行"）',
  )
  assert.deepEqual(
    deferTraceFindings({ releases: [old, current], deferredRecords: ['AC-001', 'REQ-001', 'REQ-002'] }),
    [],
    '三条都有真源留痕 ⇒ 不红',
  )

  // ④ 豁免三：已终结（做完了，不是顺延）
  assert.deepEqual(
    kindsOf(deferTraceFindings({ releases: [old, current], settled: ['AC-001', 'REQ-001', 'REQ-002'] })),
    [],
    '已终结的实体从范围里消失是"做完了" ⇒ 不许当成静默顺延',
  )

  // ⑤ 反向对照：还在当前版 scope 里的不许报（这条判据不是"凡旧版 scope 一律红"）
  const stillInScope = frozenRelease('r-0.1.7', '0.1.7', ['REQ-001', 'REQ-002', 'AC-001', 'REQ-063'], ['AC-278'])
  assert.deepEqual(deferTraceFindings({ releases: [old, stillInScope] }), [], '三条都还在当前版 scope 里 ⇒ 不红')

  // ⑥ 反向对照：被**更新一版**显式带进 scope 的，是写在台账里的顺延，不是静默
  const draft = { id: 'r-0.1.8', packageVersion: '0.1.8', scope: { requirements: ['REQ-001', 'REQ-002', 'AC-001'], acceptance: [] } } as Release
  assert.deepEqual(
    deferTraceFindings({ releases: [old, current, draft] }),
    [],
    '被 0.1.8 的 scope 显式点名的实体 ⇒ 台账里有它的去处，不算"没写在任何地方"',
  )

  // ⑦ 反向对照：只有一份 release（没有旧版承诺过）⇒ 不许凭空报静默顺延
  assert.deepEqual(deferTraceFindings({ releases: [current] }), [], '没有更早的冻结版 ⇒ 没有"承诺"可消失')
})

test('M216-03 R12 冻结必须是人签：模型自写的集合红、已签的绿、草稿不算当前版', () => {
  const unsigned: Release = { id: 'r-0.1.7', packageVersion: '0.1.7', scope: { requirements: ['REQ-063'], acceptance: [] } }

  // ① 模型自行写集合（没有 frozenBy / frozenAtSeq）⇒ 红
  const bare = freezeTraceFindings({ releases: [unsigned] })
  assert.deepEqual(kindsOf(bare), ['collections-unsigned'], '当前版没有任何人签 ⇒ 红，且只报这一条')
  assert.equal(bare[0]?.subjectId, 'r-0.1.7', '点名是哪一份 release 的集合没有权威')
  assert.equal((bare[0]?.detail ?? '').length > 20, true, '人读面要给出可操作的出路（走问答签字 / 别让草稿当当前版）')

  // ② 有人签但不是 human ⇒ 两条读数（签字人不合格 + 当前版等于没签）
  const cockpitSigned: Release = { ...unsigned, frozenBy: 'cockpit', frozenAtSeq: 1 }
  const bad = kindsOf(freezeTraceFindings({ releases: [cockpitSigned] }))
  assert.equal(bad.includes('signature-not-human'), true, '签字人不是 human ⇒ 必须单独点名（驾驶舱不得代批）')
  assert.equal(bad.includes('collections-unsigned'), true, '非 human 的签字不算签：当前版仍然没有权威')
  assert.equal(bad.length, 2, '这一支只该有这两条读数（别的面不该陪跑）')

  // ③ 正常路径：`writeRelease` 落盘、冻结序号指向那一刻 ⇒ 绿
  withStore((store, journal) => {
    const seq = nextSeq(journal)
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063'], acceptance: ['AC-278'] },
      nonScope: [noteOf('DEF-1')],
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    const events = journal.read().events
    assert.equal(events[0]?.seq, seq, '自证：冻结序号与落盘那一刻对齐（这一格不靠猜号）')
    assert.equal(events[0]?.data.frozen, true, '自证：那一刻的落盘确实是带签字的')
    const releases = listReleases(store)
    assert.deepEqual(freezeTraceFindings({ releases, events }), [], '人签 + 序号可核 + 没动过 ⇒ 绿')

    // ④ 反向对照：同一份已冻版 + 一份未冻的**下一版草稿** ⇒ 仍然绿（草稿不是当前版，AC-275 的场景）
    writeRelease(store, journal, { id: 'r-0.1.8', scope: { requirements: ['REQ-063'], acceptance: [] } })
    const withDraft = listReleases(store)
    assert.deepEqual(
      freezeTraceFindings({ releases: withDraft, events: journal.read().events }),
      [],
      '旧版已冻、新版起草中 ⇒ 不红（把它判红等于取消"先起草再签字"这条路）',
    )
  })

  // ⑤ 反向对照：一份 release 都没有 ⇒ 不判（这套机制还没被采纳，不是"空集合所以绿"）
  assert.deepEqual(freezeTraceFindings({ releases: [] }), [], '没有 release 文件 ⇒ 这条判据无话可说')
})

test('M216-04 冻结序号是一句可核对的声明：手填签字核不到那一刻 ⇒ 红', () => {
  // ① 手写文件（真源里从没有"带签字的落盘"）⇒ 红
  withStore((store, journal) => {
    store.writeYaml([RELEASE_DIR, 'r-0.2.0.yml'], {
      release: {
        id: 'r-0.2.0',
        packageVersion: '0.2.0',
        scope: { requirements: ['REQ-063'], acceptance: [] },
        frozenAtSeq: 7,
        frozenBy: 'human',
      },
    })
    const handWritten = kindsOf(freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }))
    assert.deepEqual(handWritten, ['freeze-unwitnessed'], '文件里写着 frozenBy: human、真源里却没有那一次落盘 ⇒ 红')
  })

  // ② 用工具落盘，但冻结序号指着一个**不存在**的时刻 ⇒ 红（序号不是装饰）
  withStore((store, journal) => {
    const seq = nextSeq(journal)
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063'], acceptance: [] },
      frozenAtSeq: seq + 5,
      frozenBy: 'human',
    })
    const findings = freezeTraceFindings({ releases: listReleases(store), events: journal.read().events })
    assert.deepEqual(kindsOf(findings), ['freeze-unwitnessed'], 'frozenAtSeq 指着真源里不存在的那一刻 ⇒ 红')
    assert.equal(findings[0]?.detail.includes(String(seq + 5)), true, '人读面要点名它指的是哪个序号')
  })

  // ③ 反向对照：同一份夹具把序号改回真实那一刻 ⇒ 绿（红不是来自别处）
  withStore((store, journal) => {
    const seq = nextSeq(journal)
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '序号指向真实那一刻 ⇒ 不红（与上一格同输入、只差序号）',
    )
  })

  // ④ 签字走问答通道同样认：`question/answered` 且 by: human 的那一刻可以当冻结序号
  withStore((store, journal) => {
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063'], acceptance: [] },
    })
    const answered = journal.append('question/answered', { id: 'Q-0001', status: 'answered', by: 'human', targets: ['REQ-063'] })
    store.writeYaml([RELEASE_DIR, 'r-0.1.7.yml'], {
      release: {
        id: 'r-0.1.7',
        packageVersion: '0.1.7',
        scope: { requirements: ['REQ-063'], acceptance: [] },
        frozenAtSeq: answered.seq,
        frozenBy: 'human',
      },
    })
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '冻结那一刻是用户答的那道签字题 ⇒ 认（AC-276 的问答通道形态）',
    )
  })
})

test('M216-05 C-75 冻结后改集合：绕过 change 即红；走完变更控制 / 原样重写不红', () => {
  /** 冻结一份 0.1.7（scope 两条），返回它那一刻的序号。 */
  const freeze = (store: SdoStore, journal: Journal): number => {
    const seq = nextSeq(journal)
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063', 'REQ-064'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    return seq
  }

  // ① 冻结后没动过 ⇒ 绿
  withStore((store, journal) => {
    const seq = freeze(store, journal)
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '冻结后没动过 ⇒ 不红',
    )

    // ② 工具路径：冻结后又往 scope 加了一条 ⇒ 红
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063', 'REQ-064', 'REQ-065'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    const rewritten = freezeTraceFindings({ releases: listReleases(store), events: journal.read().events })
    assert.deepEqual(kindsOf(rewritten), ['collections-rewritten-after-freeze'], '冻结后加了一条 ⇒ 红，且只报一条')
    assert.equal(rewritten[0]?.subjectId, 'r-0.1.7', '点名是哪一份 release 的集合被改了')
    assert.equal(rewritten[0]?.detail.includes('3'), true, '人读面要点到现盘条数')

    // ③ 反例里的另一半：**原样重写**（条数不变）不算改了集合
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063', 'REQ-064'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '条数改回冻结时的两条 ⇒ 不红（这条守卫不许把幂等重写判成"改集合"）',
    )
  })

  // ④ 走完 change：冻结 → 已决策的变更 → 落盘 ⇒ 绿（这是合法路径，不许判红）
  withStore((store, journal) => {
    const seq = freeze(store, journal)
    journal.append('change/decided', { id: 'CR-001', decision: 'approved', by: 'human' })
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063', 'REQ-064', 'REQ-065'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '冻结后加范围走的是已决策的变更 ⇒ 不红（否则唯一合法的路也被堵死）',
    )
  })

  // ⑤ 手改文件（绕过工具）：条数与真源里最后一次落盘不一致 ⇒ 红
  withStore((store, journal) => {
    const seq = freeze(store, journal)
    const handEdited = listReleases(store)[0] as Release
    store.writeYaml([RELEASE_DIR, 'r-0.1.7.yml'], {
      release: {
        ...handEdited,
        scope: { requirements: ['REQ-063', 'REQ-064', 'REQ-065', 'REQ-066'], acceptance: [] },
        frozenAtSeq: seq,
      },
    })
    assert.deepEqual(
      kindsOf(freezeTraceFindings({ releases: listReleases(store), events: journal.read().events })),
      ['collections-rewritten-after-freeze'],
      '手改 YAML 加了范围、真源里没有任何变更记录 ⇒ 红',
    )
  })

  // ⑥ 已知边界（写成断言，不是口头承诺）：条数不变的"删一条 + 加一条"当前核不到
  withStore((store, journal) => {
    const seq = freeze(store, journal)
    writeRelease(store, journal, {
      id: 'r-0.1.7',
      packageVersion: '0.1.7',
      scope: { requirements: ['REQ-063', 'REQ-099'], acceptance: [] },
      frozenAtSeq: seq,
      frozenBy: 'human',
    })
    assert.deepEqual(
      freezeTraceFindings({ releases: listReleases(store), events: journal.read().events }),
      [],
      '条数相同时核不到（事件字段面只有条数）—— 这一格是**故意**记录边界，收紧要先扩事件字段面',
    )
  })
})

test('M216-06 上限的项目声明：`.sdo/config.yml` 的 `release.deferLimit`，坏值一律退回严格缺省', () => {
  withStore((store) => {
    assert.equal(deferLimitOf(store), DEFAULT_DEFER_LIMIT, '没声明 ⇒ 用缺省上限')
    assert.equal(DEFAULT_DEFER_LIMIT, 2, '缺省上限是 2（规格明写"默认 2"，改它要改规格）')

    store.writeYaml(['config.yml'], { release: { deferLimit: 4 } })
    assert.equal(deferLimitOf(store), 4, '项目声明 4 ⇒ 按 4 判（阈值不是写死在代码里）')

    store.writeYaml(['config.yml'], { release: { deferLimit: 0 } })
    assert.equal(deferLimitOf(store), 0, '0 是合法声明（一次都不许顺延），不许被当成"没声明"')

    // 坏值一律退回**严格**那一侧：放宽是用户的决定，写错一个类型不该悄悄放宽
    for (const bad of ['two', 1.5, -1]) {
      store.writeYaml(['config.yml'], { release: { deferLimit: bad } })
      assert.equal(deferLimitOf(store), DEFAULT_DEFER_LIMIT, `deferLimit=${String(bad)} 不是 ≥0 的整数 ⇒ 退回缺省`)
    }
  })
})
