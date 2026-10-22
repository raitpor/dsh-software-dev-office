/**
 * `M213`（`TASK-170` / `REQ-063` 批 1①）：**发布计划层（release）的实体、存取与派生**。
 *
 * 这一格守的是 `REQ-063` 的三条硬口径（都已基线）：
 *   · `AC-278`：台账里一律用 release 标识（`r-0.1.7` 形态），**不得**把包版本号当主键；
 *     两者同形时必须显式写 `packageVersion` 映射（`M213-04` 就是它的反例 R10）；
 *   · `AC-287`：`targetVersion` / `deferredTo` 是**派生**，权威是 release 文件里的集合；
 *   · fail-closed（规格 R8/R9）：既不在 scope、也不在当前版的 `nonScope` 里 ⇒ 归入**当前** release，
 *     不许靠"没规划过"逃出判定。
 *
 * 为什么先写这一格：`C-71`（作用域闭合）与 `C-72`（缺口清单对账）读的是**同一份派生结果** ——
 * 派生口径错一次，后面两条判据会一起错，而且错得"看起来绿"。本文件只守形状与派生，**不判**那两条
 * （它们是后续卡的事）。
 *
 * 写作约定：夹具里的字符串一律用英文（`reason` 之类会被断言比较），中文只出现在用例名与断言消息里 ——
 * 理由与 `test/m189.test.ts` 的散文站点棘轮有关（断言**取值**里出现中文字面量就算"读散文"，
 * 要按身份登记才不红；本文件不制造那种站点）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import {
  RELEASE_DIR,
  currentRelease,
  deferredIdsOf,
  deriveFor,
  listReleaseIds,
  listReleases,
  packageVersionOf,
  readRelease,
  releaseShapeProblems,
  writeRelease,
} from '../src/domain/release.js'
import type { Release } from '../src/types.js'

/** 每格一个临时 `.sdo`（不碰真账；`store` 与 `journal` 绑同一个根）。 */
function withStore<T>(run: (store: SdoStore, journal: Journal) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m213-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    return run(store, new Journal(store))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 一份已冻结的旧版（`nonScope` 里有一条"顺延到下一版"）。 */
const RELEASE_016: Release = {
  id: 'r-0.1.6',
  packageVersion: '0.1.6',
  scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: ['AC-001'] },
  nonScope: [{ id: 'DEF-777', reason: 'deferred-at-0.1.6-to-0.1.7', deferCount: 1, approvedBy: 'human' }],
  frozenAtSeq: 100,
  frozenBy: 'human',
}

/** 当前版：`nonScope` 里有一条"本版不做"（`DEF-999`）。 */
const RELEASE_017: Release = {
  id: 'r-0.1.7',
  packageVersion: '0.1.7',
  scope: { requirements: ['REQ-063'], acceptance: ['AC-278', 'AC-287'] },
  nonScope: [{ id: 'DEF-999', reason: 'out-of-0.1.7-scope', deferCount: 1, approvedBy: 'human' }],
  frozenAtSeq: 200,
  frozenBy: 'human',
}

/** 下一版（还没冻结，映射从 id 的 `x.y.z` 段取）。 */
const RELEASE_018: Release = {
  id: 'r-0.1.8',
  scope: { requirements: ['REQ-063'], acceptance: [] },
}

test('M213-01 正常读写：写进去的 release 原样读回，形状不合法整次拒绝（不落半成品）', () => {
  withStore((store, journal) => {
    assert.equal(readRelease(store, 'r-0.1.6'), undefined, '盘上还没有那份 release ⇒ 读到 undefined，不许凭空造一份')
    assert.deepEqual(listReleaseIds(store), [], '空目录不该列出任何 release')

    writeRelease(store, journal, RELEASE_016)
    const read = readRelease(store, 'r-0.1.6')
    assert.notStrictEqual(read, undefined, '刚写进去的 release 必须读得到')
    assert.deepEqual(read, RELEASE_016, '写进去什么、读回来就该是什么（往返一致，可选字段不许长出空壳）')
    assert.deepEqual(listReleaseIds(store), ['r-0.1.6'], '目录里应当只有这一份')
    assert.equal(listReleases(store).length, 1)

    // 写盘要在真源里留痕：冻结与否得能从 journal 里数出来
    const events = journal.read().events
    assert.deepEqual(events.map((event) => event.type), ['release/written'], '写一份 release 落一条 release/written')

    // 形状不合法 ⇒ **整次拒绝**：不许写出一份半成品让别人读到
    const broken = { id: 'r-0.2.0', packageVersion: '0.2.0', scope: { requirements: 'REQ-001' } } as unknown as Release
    assert.throws(() => writeRelease(store, journal, broken), /scope/u, 'scope 不是集合时必须拒绝并点名该字段')
    assert.equal(readRelease(store, 'r-0.2.0'), undefined, '被拒的那次不许留下任何文件')
  })
})

test('M213-02 派生正确：scope 里的实体派生 targetVersion，nonScope 里的派生 deferredTo（带理由与批准人）', () => {
  const releases = [RELEASE_016, RELEASE_017]

  const inScope = deriveFor(releases, 'REQ-063')
  assert.equal(inScope.targetVersion, '0.1.7', '在 r-0.1.7 的 scope 里 ⇒ targetVersion 派生为它的包版本')
  assert.equal(inScope.deferredTo, undefined, '在 scope 里就不该同时有 deferredTo')
  assert.equal(inScope.failClosed, undefined, '它被集合点名过，不是缺省归入')

  assert.equal(deriveFor(releases, 'REQ-001').targetVersion, '0.1.6', '只属旧版 scope 的实体派生旧版')
  assert.equal(deriveFor(releases, 'AC-287').targetVersion, '0.1.7', 'acceptance 集合与 requirements 同权')

  const deferred = deriveFor(releases, 'DEF-999')
  assert.equal(deferred.targetVersion, undefined, '在 nonScope 里不该派生 targetVersion')
  assert.equal(deferred.deferredTo, '0.1.7', '集合里还没有下一版 ⇒ 落到登记它的那一版（不许凭空造出版本号）')
  assert.equal(deferred.deferredFrom, '0.1.7', 'deferredFrom 点名登记这次顺延的那一版')
  assert.equal(deferred.deferReason, 'out-of-0.1.7-scope', '理由必须一路派生出来（C-72 对账要用）')
  assert.equal(deferred.deferApprovedBy, 'human', '批准人也必须派生')
  assert.deepEqual(deferredIdsOf(RELEASE_017), ['DEF-999'], 'C-72 的对账面＝当前版 nonScope 的 id 集合')

  // 下一版在册 ⇒ 顺延到的是**紧接着的下一版**（不是登记它的那一版）
  const withNext = deriveFor([...releases, RELEASE_018], 'DEF-999')
  assert.equal(withNext.deferredTo, '0.1.8', '顺延到下一版')
  assert.equal(withNext.deferredFrom, '0.1.7')
  assert.equal(
    deriveFor([...releases, RELEASE_018], 'REQ-063').targetVersion,
    '0.1.8',
    '同一实体被带进更新的 scope ⇒ 目标是那一版（最新集合说了算）',
  )

  // 当前 release＝**最新已冻结**的那一版：没签字的下一版只是一份草稿，不许改写在飞版本的判定
  assert.equal(currentRelease(releases)?.id, 'r-0.1.7')
  assert.equal(currentRelease([...releases, RELEASE_018])?.id, 'r-0.1.7', '还没冻结的下一版不算当前版（AC-276）')
  assert.equal(currentRelease([RELEASE_018])?.id, 'r-0.1.8', '一份都没冻结 ⇒ 退回版本最高的那一版')

  // 当前 release 取**版本号语义序**：字典序会把 0.1.10 排在 0.1.9 前面
  const later: Release = {
    id: 'r-0.1.10',
    packageVersion: '0.1.10',
    scope: { requirements: [], acceptance: [] },
    frozenAtSeq: 300,
    frozenBy: 'human',
  }
  assert.equal(currentRelease([...releases, later])?.id, 'r-0.1.10', '0.1.10 比 0.1.9 新')
  assert.equal(packageVersionOf(later), '0.1.10')

  // 派生的是**集合**不是入参顺序：同一组 release 换个顺序来，结果必须一样
  assert.deepEqual(deriveFor([RELEASE_017, RELEASE_016], 'REQ-063'), deriveFor(releases, 'REQ-063'))
  assert.deepEqual(deriveFor([RELEASE_018, RELEASE_017, RELEASE_016], 'DEF-999'), withNext)
})

test('M213-03 fail-closed：既不在 scope 也不在 nonScope 的实体归入当前 release（规格 R8/R9）', () => {
  const releases = [RELEASE_016, RELEASE_017]

  const stray = deriveFor(releases, 'DEF-12345')
  assert.equal(stray.targetVersion, '0.1.7', '没规划过的实体默认属于当前版本')
  assert.equal(stray.deferredTo, undefined, '缺省归入不代表它被顺延了')
  assert.equal(stray.failClosed, true, '缺省归入要**说出来**：下游据此区分"规划过"与"靠缺省被拉进来"')

  // 旧顺延不许长期挡路：上一版把 DEF-777 顺延到本版、本版没再点名 ⇒ 目标就是本版
  const landed = deriveFor(releases, 'DEF-777')
  assert.equal(landed.targetVersion, '0.1.7', '顺延目标已经到账 ⇒ 它属于当前版（旧 nonScope 不再享受豁免）')
  assert.equal(landed.deferredTo, undefined, '它没有被当前版顺延')

  // 一份 release 都没有 ⇒ 显式说"不知道"，别当它属于本版
  const none = deriveFor([], 'DEF-12345')
  assert.equal(none.targetVersion, undefined, '没有集合就没有派生')
  assert.equal(none.deferredTo, undefined)
  assert.equal(none.unknown, true, '必须显式标记 unknown —— 让判据能 fail-closed，而不是当它属于本版')
  assert.equal(currentRelease([]), undefined)
})

test('M213-04 R10 反例（AC-278）：id 直接取包版本号而不写 packageVersion ⇒ 点名该字段', () => {
  const noMapping: Release = {
    id: '0.1.7',
    scope: RELEASE_017.scope,
    nonScope: RELEASE_017.nonScope,
    frozenAtSeq: 200,
    frozenBy: 'human',
  }
  const problems = releaseShapeProblems(noMapping).join(' ')
  assert.match(problems, /packageVersion/u, '包版本号当主键时必须要求显式映射字段')
  assert.match(problems, /AC-278/u, '报错要引口径，别只说"不合法"')

  const mapped: Release = { ...noMapping, packageVersion: '0.1.7' }
  assert.deepEqual(releaseShapeProblems(mapped), [], '写了映射就可以同形')

  // r-x.y.z 形态且没写映射 ⇒ 合法（映射从 id 的 x.y.z 段取）
  const onlyForm: Release = {
    id: 'r-0.1.7',
    scope: RELEASE_017.scope,
    nonScope: RELEASE_017.nonScope,
    frozenAtSeq: 200,
    frozenBy: 'human',
  }
  assert.deepEqual(releaseShapeProblems(onlyForm), [], '规范形态不强制写映射')
  assert.equal(packageVersionOf(onlyForm), '0.1.7', '缺省映射从 id 取')

  // 形态不对 ⇒ 点名该写成什么样
  const badForm: Release = { ...onlyForm, id: 'release-0.1.7' }
  assert.match(releaseShapeProblems(badForm).join(' '), /r-x\.y\.z/u, '报错要点名合法形态')

  // 一对多：一个包版本可以含多个 release（文件名仍是主键，靠后缀区分）
  const hotfix: Release = { ...onlyForm, id: 'r-0.1.7-hotfix' }
  assert.deepEqual(releaseShapeProblems(hotfix), [], '后缀形态合法（否则"一个包版本含多个 release"永远写不出来）')
  assert.equal(packageVersionOf(hotfix), '0.1.7', '同一包版本下的两份 release 映射到同一个包版本')
})

test('M213-05 形状校验：必填缺失 / nonScope 逐字段 / 冻结两字段配对 / scope 自相矛盾 各自点名', () => {
  const base: Release = { id: 'r-0.2.0', packageVersion: '0.2.0', scope: { requirements: [], acceptance: [] } }

  const empty = releaseShapeProblems({}).join(' ')
  assert.match(empty, /id/u, '缺 id 要点名 id')
  assert.match(empty, /scope/u, '缺 scope 要点名 scope')
  assert.match(releaseShapeProblems(null).join(' '), /映射/u, '读到 null 也要可读报错（手写 YAML 会给出 null）')

  // nonScope 四条必填逐字段点名（不许静默顺延）
  const noReason = releaseShapeProblems({ ...base, nonScope: [{ id: 'DEF-1', reason: '', deferCount: 1, approvedBy: 'human' }] }).join(' ')
  assert.match(noReason, /reason/u, '顺延必须留理由')
  const countNaN = releaseShapeProblems({ ...base, nonScope: [{ id: 'DEF-1', reason: 'later', deferCount: Number.NaN, approvedBy: 'human' }] }).join(' ')
  assert.match(countNaN, /deferCount/u, '顺延次数必须是可对账的数字')
  const countFraction = releaseShapeProblems({ ...base, nonScope: [{ id: 'DEF-1', reason: 'later', deferCount: 1.5, approvedBy: 'human' }] }).join(' ')
  assert.match(countFraction, /deferCount/u, '是次数就一定是整数')
  const wrongApprover = releaseShapeProblems({ ...base, nonScope: [{ id: 'DEF-1', reason: 'later', deferCount: 1, approvedBy: 'cockpit' }] }).join(' ')
  assert.match(wrongApprover, /approvedBy/u, '顺延批准人只认 human')
  assert.match(wrongApprover, /human/u, '报错要点名合法取值')
  const noId = releaseShapeProblems({ ...base, nonScope: [{ reason: 'later', deferCount: 1, approvedBy: 'human' }] }).join(' ')
  assert.match(noId, /nonScope\[0\]\.id/u, '缺被顺延的实体 id 要点名位置')

  // 一份 release 里「进本版」和「不进本版」不能同时成立
  const contradict = releaseShapeProblems({
    ...base,
    scope: { requirements: ['REQ-001'], acceptance: [] },
    nonScope: [{ id: 'REQ-001', reason: 'later', deferCount: 1, approvedBy: 'human' }],
  }).join(' ')
  assert.match(contradict, /nonScope/u, '自相矛盾的集合必须红（否则派生结果谁先谁后全靠运气）')

  // 冻结：人签 + 那一刻的 journal 序号，两字段配对
  assert.match(releaseShapeProblems({ ...base, frozenBy: 'human' }).join(' '), /frozenAtSeq/u, '有签字没序号 ⇒ 点名缺的那个')
  assert.match(releaseShapeProblems({ ...base, frozenAtSeq: 200 }).join(' '), /frozenBy/u, '有序号没签字 ⇒ 点名缺的那个')
  assert.match(releaseShapeProblems({ ...base, frozenAtSeq: 200, frozenBy: 'cockpit' }).join(' '), /human/u, '冻结是一次人签')
  assert.match(releaseShapeProblems({ ...base, frozenAtSeq: 0, frozenBy: 'human' }).join(' '), /frozenAtSeq/u, 'journal 序号从 1 开始')
  assert.deepEqual(releaseShapeProblems(RELEASE_017), [], '正常的那份必须零问题（这一格不许恒红）')
})

test('M213-06 读侧 fail-closed：手写坏的 release 文件不许被静默跳过（点名文件与字段）', () => {
  withStore((store) => {
    // ① 缺必填字段（手写漏了 scope）
    store.writeYaml([RELEASE_DIR, 'r-0.1.9.yml'], { release: { id: 'r-0.1.9', packageVersion: '0.1.9' } })
    assert.throws(() => readRelease(store, 'r-0.1.9'), /scope/u, '缺 scope 要报错并点名字段')
    assert.throws(() => readRelease(store, 'r-0.1.9'), /releases\/r-0\.1\.9\.yml/u, '报错要点名相对路径（用户得知道去修哪个文件）')

    // ② 文件名就是主键：文件里的 id 对不上 ⇒ 红
    store.writeYaml([RELEASE_DIR, 'r-0.2.2.yml'], { release: { id: 'r-0.2.1', scope: { requirements: [], acceptance: [] } } })
    assert.throws(() => readRelease(store, 'r-0.2.2'), /id/u, '文件名与 id 不一致必须红（否则主键有两份）')

    // ③ 目录里有一份坏的 ⇒ 列举也要红：静默跳过等于让坏文件永远不参与判定
    assert.throws(() => listReleases(store), /release/u, '列举不许把读不动的那份咽下去')
  })
})
