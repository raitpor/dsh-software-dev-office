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
 * `TASK-181` 按 `REV-076` 把派生契约里的两处**双义**拆开（规格 §2.2 第 3/4 条、§3.1）：
 *   · findingIndex **第 2 条**：`deferredTo` 只在目标版本**在册**时才有值；目标未在册 ⇒ 留空 +
 *     `deferredTargetKnown: false`（不再用 `deferredTo === deferredFrom` 暗示"未知"）；
 *   · findingIndex **第 3 条**：`failClosed` 只表「**从没规划过**」；只在旧版 `nonScope` 里、且顺延
 *     目标已到账的另一类给独立标识 `landedFrom`（＝登记那次顺延的那一版的包版本），两者**互斥**。
 * 于是"顺延到下一版"这条断言只出现在**有下一版**的夹具上（`release018` 在册那一格），
 * "无下一版"那一格断言的是"留空 + 目标未在册"。
 *
 * `TASK-182` 按 `REV-076` 补**守卫**（不改派生口径，只让"改坏了会红"真的成立）：
 *   · findingIndex **第 12 条 / M1**：「紧后」下一版 —— `M213-07`（0.1.8 与 0.1.9 并存 ⇒ 目标必须是 0.1.8）；
 *   · findingIndex **第 8 条(b) / M2**：草案世界里的 fail-closed —— `M213-08`（0.1.7 已冻结 + 0.1.8 起草中
 *     ⇒ 未规划实体的目标必须是**当前版** 0.1.7，而不是版本最高的 0.1.8）；
 *   · findingIndex **第 7 条 / M5**：`writeRelease` 的 journal 字段面 —— `M213-09`；
 *   · findingIndex **第 6 条**：弱断言收紧 —— `M213-06` 第三条改成点名**文件 + 字段**（`/release/` 这个
 *     正则本模块每条报错都命中，等于什么都没断言）；
 *   · findingIndex **第 9 条**：`DoD` 第 6 条「只做形状、不做判据」的可机械核面 —— `M213-10`；
 *   · findingIndex **第 8 条(a)/(c)**：覆盖缺口（重复项 / 顶层 `release` 键 / 稀疏往返）—— `M213-11..13`；
 *   · findingIndex **第 10 条**：导出面顺序＝文件名序，不是版本序 —— `M213-14`；
 *   · findingIndex **第 11 条**：夹具纪律（工厂函数 + 入参只读）—— `M213-15`。
 *
 * 为什么先写这一格：`C-71`（作用域闭合）与 `C-72`（缺口清单对账）读的是**同一份派生结果** ——
 * 派生口径错一次，后面两条判据会一起错，而且错得"看起来绿"。本文件只守形状与派生，**不判**那两条
 * （它们是后续卡的事）。
 *
 * 写作约定：夹具里的字符串一律用英文（`reason` 之类会被断言比较），中文只出现在用例名与**断言消息**里 ——
 * 理由与 `test/m189.test.ts` 的散文站点棘轮有关（断言的**取值**里出现中文字面量就算"读散文"，
 * 要按身份登记才不红；本文件的散文站点数是 0，新增中文一律只进消息、不进取值）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  listReleaseIdsByName,
  listReleases,
  packageVersionOf,
  readRelease,
  releaseShapeProblems,
  writeRelease,
} from '../src/domain/release.js'
import type { DerivedVersionDetail, Release, ReleaseNote } from '../src/types.js'

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

/** 跑一段断言并**取回报错文案**：要断言"点名了哪个文件/哪个字段"，只断言"抛了个错"是假绿。 */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

/** 仓库根（`lib/test` → 包根）；静态面断言要读**源码**，不是编译产物。 */
const sourceOf = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/**
 * 剥掉注释后的"代码面"。静态守卫要区分「判据字面量活在**注释**里」（合法：本模块的注释就是在说
 * "这些判据不归我管"）与「判据字面量进了**代码**」（非法：等于把判据塞进派生层）。
 */
function codeFace(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/u, '$1'))
    .join('\n')
}

/** 夹具里的顺延登记（四个必填字段齐备）。 */
const noteOf = (id: string): ReleaseNote => ({ id, reason: 'later', deferCount: 1, approvedBy: 'human' })

/**
 * 夹具一律走**工厂函数**：每次给一份新对象（`REV-076` findingIndex 第 11 条）。
 * 模块级常量对象被多格直传虽然当前安全（派生只读入参），但任何一处在入参上 `push` 就会跨格污染 ——
 * 那是"依赖执行顺序"的经典来源。`M213-15` 把这条钉住。
 */

/** 一份已冻结的旧版（`nonScope` 里有一条"顺延到下一版"）。 */
function release016(): Release {
  return {
    id: 'r-0.1.6',
    packageVersion: '0.1.6',
    scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: ['AC-001'] },
    nonScope: [{ id: 'DEF-777', reason: 'deferred-at-0.1.6-to-0.1.7', deferCount: 1, approvedBy: 'human' }],
    frozenAtSeq: 100,
    frozenBy: 'human',
  }
}

/** 当前版：`nonScope` 里有一条"本版不做"（`DEF-999`）。 */
function release017(): Release {
  return {
    id: 'r-0.1.7',
    packageVersion: '0.1.7',
    scope: { requirements: ['REQ-063'], acceptance: ['AC-278', 'AC-287'] },
    nonScope: [{ id: 'DEF-999', reason: 'out-of-0.1.7-scope', deferCount: 1, approvedBy: 'human' }],
    frozenAtSeq: 200,
    frozenBy: 'human',
  }
}

/** 下一版（还没冻结，映射从 id 的 `x.y.z` 段取）。 */
function release018(): Release {
  return { id: 'r-0.1.8', scope: { requirements: ['REQ-063'], acceptance: [] } }
}

/** 再下一版（同样没冻结）—— 用来区分「紧后」与「最远」（`M213-07`）。 */
function release019(): Release {
  return { id: 'r-0.1.9', scope: { requirements: [], acceptance: [] } }
}

test('M213-01 正常读写：写进去的 release 原样读回，形状不合法整次拒绝（不落半成品）', () => {
  withStore((store, journal) => {
    assert.equal(readRelease(store, 'r-0.1.6'), undefined, '盘上还没有那份 release ⇒ 读到 undefined，不许凭空造一份')
    assert.deepEqual(listReleaseIdsByName(store), [], '空目录不该列出任何 release')

    writeRelease(store, journal, release016())
    const read = readRelease(store, 'r-0.1.6')
    assert.notStrictEqual(read, undefined, '刚写进去的 release 必须读得到')
    assert.deepEqual(read, release016(), '写进去什么、读回来就该是什么（往返一致，可选字段不许长出空壳）')
    assert.deepEqual(listReleaseIdsByName(store), ['r-0.1.6'], '目录里应当只有这一份')
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
  const releases = [release016(), release017()]

  const inScope = deriveFor(releases, 'REQ-063')
  assert.equal(inScope.targetVersion, '0.1.7', '在 r-0.1.7 的 scope 里 ⇒ targetVersion 派生为它的包版本')
  assert.equal(inScope.deferredTo, undefined, '在 scope 里就不该同时有 deferredTo')
  assert.equal(inScope.failClosed, undefined, '它被集合点名过，不是缺省归入')

  assert.equal(deriveFor(releases, 'REQ-001').targetVersion, '0.1.6', '只属旧版 scope 的实体派生旧版')
  assert.equal(deriveFor(releases, 'AC-287').targetVersion, '0.1.7', 'acceptance 集合与 requirements 同权')

  const deferred = deriveFor(releases, 'DEF-999')
  assert.equal(deferred.targetVersion, undefined, '在 nonScope 里不该派生 targetVersion')
  // `REV-076` findingIndex 第 2 条：集合里还没有下一版 ⇒ `deferredTo` **留空**，
  // 另用 `deferredTargetKnown: false` 说"目标版本尚未在册"。不许再落回登记版（那会让下游分不清
  // "顺延到本版"与"目标未在册"，而前者与 nonScope 的「明确不进本版」直接矛盾）。
  assert.equal(deferred.deferredTo, undefined, '还没有下一版 ⇒ deferredTo 留空（不许用「顺延到本版」冒充「目标未在册」）')
  assert.equal(deferred.deferredTargetKnown, false, '目标版本尚未在册必须**显式**说：deferredTargetKnown=false')
  assert.equal(deferred.deferredFrom, '0.1.7', 'deferredFrom 点名登记这次顺延的那一版')
  assert.notEqual(deferred.deferredTo, deferred.deferredFrom, '目标未在册时不许把两个版本号写成同一个值（双义编码）')
  assert.equal(deferred.deferReason, 'out-of-0.1.7-scope', '理由必须一路派生出来（C-72 对账要用）')
  assert.equal(deferred.deferApprovedBy, 'human', '批准人也必须派生（字段名 deferApprovedBy，规格 §2.2）')
  assert.deepEqual(deferredIdsOf(release017()), ['DEF-999'], 'C-72 的对账面＝当前版 nonScope 的 id 集合')

  // 下一版在册 ⇒ 顺延到的是**紧接着的下一版**（这里才是"顺延到 X"该被断言的地方）
  const withNext = deriveFor([...releases, release018()], 'DEF-999')
  assert.equal(withNext.deferredTo, '0.1.8', '顺延到下一版（目标在册 ⇒ deferredTo 才有值）')
  assert.equal(withNext.deferredTargetKnown, true, '目标在册 ⇒ 显式 true，与"目标未在册"用同一字段分开')
  assert.equal(withNext.deferredFrom, '0.1.7', '登记这次顺延的那一版')
  assert.notEqual(withNext.deferredTo, withNext.deferredFrom, '顺延到下一版时两个版本号必须不同')
  assert.equal(
    deriveFor([...releases, release018()], 'REQ-063').targetVersion,
    '0.1.8',
    '同一实体被带进更新的 scope ⇒ 目标是那一版（最新集合说了算）',
  )

  // 当前 release＝**最新已冻结**的那一版：没签字的下一版只是一份草稿，不许改写在飞版本的判定
  assert.equal(currentRelease(releases)?.id, 'r-0.1.7')
  assert.equal(currentRelease([...releases, release018()])?.id, 'r-0.1.7', '还没冻结的下一版不算当前版（AC-276）')
  assert.equal(currentRelease([release018()])?.id, 'r-0.1.8', '一份都没冻结 ⇒ 退回版本最高的那一版')

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
  assert.deepEqual(deriveFor([release017(), release016()], 'REQ-063'), deriveFor(releases, 'REQ-063'))
  assert.deepEqual(deriveFor([release018(), release017(), release016()], 'DEF-999'), withNext)
})

test('M213-03 fail-closed：既不在 scope 也不在 nonScope 的实体归入当前 release（规格 R8/R9）', () => {
  const releases = [release016(), release017()]

  const stray = deriveFor(releases, 'DEF-12345')
  assert.equal(stray.targetVersion, '0.1.7', '没规划过的实体默认属于当前版本')
  assert.equal(stray.deferredTo, undefined, '缺省归入不代表它被顺延了')
  assert.equal(stray.failClosed, true, '缺省归入要**说出来**：下游据此区分"规划过"与"靠缺省被拉进来"')
  // `REV-076` findingIndex 第 3 条：`failClosed` 只表「从没规划过」这一义，不许兼表"顺延到账"
  assert.equal(stray.landedFrom, undefined, '从没规划过 ⇒ 没有 landedFrom（规划过且到账是另一类）')

  // 旧顺延不许长期挡路：上一版把 DEF-777 顺延到本版、本版没再点名 ⇒ 目标就是本版
  const landed = deriveFor(releases, 'DEF-777')
  assert.equal(landed.targetVersion, '0.1.7', '顺延目标已经到账 ⇒ 它属于当前版（旧 nonScope 不再享受豁免）')
  assert.equal(landed.deferredTo, undefined, '它没有被当前版顺延')
  assert.equal(landed.landedFrom, '0.1.6', '顺延**到账**另给独立标识：landedFrom＝登记那次顺延的那一版')
  assert.equal(landed.failClosed, undefined, '它规划过且已到账 ⇒ 不许再标 failClosed（那正是两义合一）')
  // 两类必须**能分开点名**：同一组 release 上，两类各带各的键，判据回执读一个键就能分
  assert.notDeepEqual(stray, landed, '未规划与顺延到账的派生结果不许同形')
  assert.notEqual(stray.failClosed, landed.failClosed, '两类各占一个标记位：failClosed 只在"从没规划过"上')
  assert.notEqual(stray.landedFrom, landed.landedFrom, 'landedFrom 只在"顺延到账"上')

  // 只在**草稿**（未冻结的更新版）的 nonScope 里：草稿的顺延还没到账 ⇒ 仍按未规划 fail-closed
  const draft: Release = {
    ...release018(),
    nonScope: [{ id: 'DEF-4242', reason: 'deferred-at-0.1.8-draft', deferCount: 1, approvedBy: 'human' }],
  }
  const notYet = deriveFor([...releases, draft], 'DEF-4242')
  assert.equal(notYet.targetVersion, '0.1.7', '草稿的集合不改写当前版判定（AC-276）')
  assert.equal(notYet.failClosed, true, '当前版没点名它、顺延也还没到账 ⇒ 仍是未规划')
  assert.equal(notYet.landedFrom, undefined, '草稿里的顺延没到账 ⇒ 不许标顺延到账')

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
    scope: release017().scope,
    nonScope: release017().nonScope,
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
    scope: release017().scope,
    nonScope: release017().nonScope,
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
  assert.match(releaseShapeProblems(null).join(' '), /release/u, '读到 null 也要可读报错（手写 YAML 会给出 null）')
  assert.notEqual(releaseShapeProblems(null).length, 0, 'null 不许被当成"零问题"放过去')

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
  assert.deepEqual(releaseShapeProblems(release017()), [], '正常的那份必须零问题（这一格不许恒红）')
})

test('M213-06 读侧 fail-closed：手写坏的 release 文件不许被静默跳过（点名文件与字段）', () => {
  // ① 缺必填字段（手写漏了 scope）—— 每一条用**独立的盘**，否则"哪份先被读到"取决于文件名序
  withStore((store) => {
    store.writeYaml([RELEASE_DIR, 'r-0.1.9.yml'], { release: { id: 'r-0.1.9', packageVersion: '0.1.9' } })
    assert.throws(() => readRelease(store, 'r-0.1.9'), /scope/u, '缺 scope 要报错并点名字段')
    assert.throws(() => readRelease(store, 'r-0.1.9'), /releases\/r-0\.1\.9\.yml/u, '报错要点名相对路径（用户得知道去修哪个文件）')

    // ③ 盘上只有这一份坏的 ⇒ 列举也要红，而且必须**点名文件 + 字段**。
    // 旧断言是 `assert.throws(() => listReleases(store), /release/u)` —— 本模块每条报错都以 release 开头、
    // 连目录名都叫 releases ⇒ 它匹配一切，等于什么都没断言（`REV-076` findingIndex 第 6 条）。
    const scopeCase = messageOf(() => listReleases(store))
    assert.equal(scopeCase.includes('releases/r-0.1.9.yml'), true, '列举必须点名坏的那一份文件')
    assert.equal(scopeCase.includes('scope'), true, '还要点名缺的那个字段')
  })

  // ② 文件名就是主键：文件里的 id 对不上 ⇒ 红
  withStore((store) => {
    store.writeYaml([RELEASE_DIR, 'r-0.2.2.yml'], { release: { id: 'r-0.2.1', scope: { requirements: [], acceptance: [] } } })
    assert.throws(() => readRelease(store, 'r-0.2.2'), /id/u, '文件名与 id 不一致必须红（否则主键有两份）')
    const idCase = messageOf(() => listReleases(store))
    assert.equal(idCase.includes('releases/r-0.2.2.yml'), true, '列举必须点名这一份文件')
    assert.equal(idCase.includes('id'), true, '并点名字段 id')
    // 两种坏法要**能分开点名**：这一份不缺 scope，别把它说成缺 scope
    assert.equal(idCase.includes('scope'), false, 'id 与文件名不一致那一份不许被报成 scope 缺失（点名必须指向真的那一处）')
  })
})

test('M213-07 「顺延到下一版」取的是**紧后**那一版：0.1.8 与 0.1.9 并存时目标必须是 0.1.8', () => {
  const both = [release016(), release017(), release018(), release019()]
  assert.equal(currentRelease(both)?.id, 'r-0.1.7', '两版草案都不算当前版：当前版仍是签过字的 0.1.7')

  const nearest = deriveFor(both, 'DEF-999')
  assert.equal(nearest.deferredTo, '0.1.8', '顺延到的是**紧后**那一版（0.1.8），不是最远的那一版（0.1.9）')
  assert.notEqual(nearest.deferredTo, '0.1.9', '反证：取「最远」会写出 0.1.9（M1 变异体正是这么做的）')
  assert.equal(nearest.deferredTargetKnown, true, '目标在册 ⇒ 显式 true')

  // 入参顺序无关：同一组集合换个顺序，紧后仍然是 0.1.8
  assert.equal(deriveFor([release019(), release018(), release017(), release016()], 'DEF-999').deferredTo, '0.1.8', '顺序不参与判定')

  // 同输入对照：把紧后的 0.1.8 拿掉，剩下的 0.1.9 才是紧后 ⇒ 上面那条不是常数断言
  const onlyFar = deriveFor([release016(), release017(), release019()], 'DEF-999')
  assert.equal(onlyFar.deferredTo, '0.1.9', '集合里只剩 0.1.9 时它才是紧后那一版')
  assert.equal(onlyFar.deferredTargetKnown, true, '目标在册 ⇒ true')
})

test('M213-08 草案世界里的 fail-closed：未规划实体的目标必须是**当前版**（0.1.7），不是版本最高', () => {
  const releases = [release016(), release017(), release018()]
  // 先把场景钉死：这一格的全部意义在于 current ≠ 版本最高（`AC-275` 的真机情形）
  assert.equal(currentRelease(releases)?.id, 'r-0.1.7', '当前版＝最新已冻结的那一版')
  assert.equal(currentRelease([release018()])?.id, 'r-0.1.8', '而"版本最高"退回口径下是 0.1.8 —— 两个答案必须不同')

  const stray: DerivedVersionDetail = deriveFor(releases, 'DEF-4242')
  assert.equal(stray.targetVersion, '0.1.7', '未规划实体归入**当前版**（不是版本最高那一版）')
  assert.notEqual(stray.targetVersion, '0.1.8', '反证：取「版本最高」会写出草稿那一版（M2 变异体正是这么做的）')
  assert.equal(stray.failClosed, true, '缺省归入仍要显式标出来')

  // 同输入对照：把草案拿掉，目标同样是 0.1.7 ⇒ 这一格不是靠草稿偶然通过的
  assert.equal(deriveFor([release016(), release017()], 'DEF-4242').targetVersion, '0.1.7', '没有草案时目标仍是 0.1.7')
  // 对照组：一份都没冻结时"当前版"退回版本最高，这一格才该给出 0.1.8
  assert.equal(deriveFor([release018()], 'DEF-4242').targetVersion, '0.1.8', '一份都没冻结 ⇒ 退回版本最高（口径的另一半）')
})

test('M213-09 journal 留痕面：release/written 的字段面（frozen / nonScope 计数 / 六个字段）', () => {
  withStore((store, journal) => {
    writeRelease(store, journal, release016()) // 已冻结：requirements 2 / acceptance 1 / nonScope 1
    writeRelease(store, journal, release018()) // 未冻结：requirements 1 / acceptance 0 / nonScope 0
    const events = journal.read().events.filter((event) => event.type === 'release/written')
    assert.deepEqual(events.map((event) => event.type), ['release/written', 'release/written'], '每写一份各落一条')

    const frozenEvent = events[0]
    const draftEvent = events[1]
    assert.equal(frozenEvent?.data.id, 'r-0.1.6', '事件要点名是哪一份 release')
    assert.equal(frozenEvent?.data.packageVersion, '0.1.6', '还要带包版本（下游不读文件也能对账）')
    assert.equal(frozenEvent?.data.frozen, true, '冻结过的那份必须能从真源里数出来：frozen=true')
    assert.equal(frozenEvent?.data.nonScope, 1, '顺延登记的**条数**要记进事件（C-72 对账要数它）')
    assert.equal(frozenEvent?.data.requirements, 2, 'scope.requirements 的条数')
    assert.equal(frozenEvent?.data.acceptance, 1, 'scope.acceptance 的条数')

    // 反向对照：把 frozen 固定成 false（M5 变异体）就过不了这一对
    assert.equal(draftEvent?.data.frozen, false, '没冻结的那份 frozen=false —— 与上一行成对，写死任一边都会红')
    assert.equal(draftEvent?.data.nonScope, 0, '没有顺延登记 ⇒ 计数是 0（不是漏写）')
    assert.equal(draftEvent?.data.requirements, 1, 'scope.requirements 的条数')
    assert.equal(draftEvent?.data.acceptance, 0, 'scope.acceptance 的条数')

    // 字段面固定：多写少写都算口径变动，下游读事件的人得知道有哪几个键
    assert.deepEqual(
      Object.keys(frozenEvent?.data ?? {}).sort(),
      ['acceptance', 'frozen', 'id', 'nonScope', 'packageVersion', 'requirements'],
      'journal 事件的字段面是这六个（改它就要同步改读它的人）',
    )
  })
})

test('M213-10 静态：派生模块「只做形状、不做判据」，且细分类型与基形状同处 types.ts', () => {
  const source = sourceOf('src/domain/release.ts')
  const code = codeFace(source)

  // ① 依赖面：本模块只许摸 journal / scalar / store / types（混进 gates 就等于把判据塞进派生层）
  const imported = [...source.matchAll(/^import(?: type)? .* from '([^']+)'$/gmu)].map((match) => match[1] as string)
  assert.deepEqual(imported, ['../infra/journal.js', '../infra/scalar.js', '../infra/store.js', '../types.js'], '依赖面清单变了就要在这里登记（新依赖必须先问「它是不是判据」）')
  assert.equal(imported.some((spec) => spec.includes('gates')), false, '不得 import gates')
  assert.equal(imported.some((spec) => spec.includes('criteri')), false, '不得 import 判据注册表')

  // ② 判据字面量只许活在**注释**里：本模块的注释就是在说"这些判据不归我管"，代码面不许碰
  assert.equal(source.includes('C-71'), true, '这个文件确实在注释里点名判据（否则下面的断言是空的）')
  assert.equal(code.includes('C-71'), false, '代码面不许出现判据 id（判据读派生结果，不在这里判定）')
  assert.equal(/\bC-\d{1,3}\b/u.test(code), false, '代码面不许出现任何判据 id 形态')
  assert.equal(/CHECKERS/u.test(code), false, '代码面不许出现检查器注册表（判据属于 gates，不属于派生层）')
  assert.equal(/check:\s/u.test(code), false, '代码面不许出现判据键的形态：check 加冒号就是往流程数据里挂判据')
  assert.equal(/details\.[a-z][a-z-]+/u.test(code), false, '代码面不许出现判据 check 键（形如 details.xxx）')
  assert.equal(code.includes('export function deriveFor'), true, '剥注释后的代码面必须还是真代码（否则这格会因为"剥光了"而恒绿）')

  // ③ 类型基座（`TASK-181` 上报的残留）：细分面必须与基形状放在一起，消费方才看得见新字段
  const types = sourceOf('src/types.ts')
  assert.equal(types.includes('export interface DerivedVersionDetail extends DerivedVersion {'), true, '细分面必须在 types.ts 里紧挨着 DerivedVersion 声明')
  assert.equal(source.includes('export interface DerivedVersionDetail'), false, '细分面不许再挂在派生模块里（按基形状标注的消费方会看不见它）')
  // 过时注释已订正：`deferredFrom` 的说明必须把"目标在不在册"指给 deferredTargetKnown，不再用两值相等暗示
  const anchor = types.indexOf('deferredFrom?: string | undefined')
  const comment = types.slice(types.lastIndexOf('/**', anchor), anchor)
  assert.equal(comment.includes('deferredTargetKnown'), true, 'deferredFrom 的注释必须指向 deferredTargetKnown（旧口径「与 deferredTo 相等即未在册」已不成立）')
})

test('M213-11 形状：scope / nonScope 的重复项各自点名（一个实体在一份 release 里只算一次）', () => {
  const base: Release = { id: 'r-0.4.0', packageVersion: '0.4.0', scope: { requirements: [], acceptance: [] } }

  const dupRequirements = releaseShapeProblems({ ...base, scope: { requirements: ['REQ-001', 'REQ-001'], acceptance: [] } }).join(' ')
  assert.match(dupRequirements, /scope\.requirements/u, 'scope.requirements 的重复项要点名该字段')
  assert.match(dupRequirements, /REQ-001/u, '还要点名重复的那个 id')

  const dupAcceptance = releaseShapeProblems({ ...base, scope: { requirements: [], acceptance: ['AC-001', 'AC-001'] } }).join(' ')
  assert.match(dupAcceptance, /scope\.acceptance/u, 'acceptance 与 requirements 同权，重复项同样要点名')
  assert.match(dupAcceptance, /AC-001/u, '点名重复的那个 id')

  const dupNonScope = releaseShapeProblems({ ...base, nonScope: [noteOf('DEF-1'), noteOf('DEF-1')] }).join(' ')
  assert.match(dupNonScope, /nonScope/u, '同一实体在同一份 release 里只能有一条顺延登记')
  assert.match(dupNonScope, /DEF-1/u, '点名重复的那个 id')

  // 反向对照：不同 id 不算重复（这一格不许恒红）
  assert.deepEqual(
    releaseShapeProblems({ ...base, scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: ['AC-001'] }, nonScope: [noteOf('DEF-1'), noteOf('DEF-2')] }),
    [],
    '不同 id 不是重复项（否则合法台账会被判红）',
  )
  // 跨集合的同名不算 scope 内重复：requirements 与 acceptance 是两个集合
  assert.deepEqual(
    releaseShapeProblems({ ...base, scope: { requirements: ['AC-001'], acceptance: ['AC-001'] } }),
    [],
    '两个集合同名不算重复（口径是"每个集合内部不重复"）',
  )
})

test('M213-12 读侧：顶层 release 键缺失或 null ⇒ 可读报错并点名文件（不许退化成泛泛的形状错误）', () => {
  withStore((store) => {
    store.writeYaml([RELEASE_DIR, 'r-0.3.0.yml'], {}) // 整个顶层键都没有
    const missing = messageOf(() => readRelease(store, 'r-0.3.0'))
    assert.equal(missing.includes('releases/r-0.3.0.yml'), true, '要点名是哪一份文件')
    assert.equal(missing.includes('undefined'), false, '不许退化成"读到 undefined 的形状错误"（那就没说出缺的是顶层键）')

    store.writeYaml([RELEASE_DIR, 'r-0.3.1.yml'], { release: null }) // YAML 里 `release:` 留空就是 null
    const nulled = messageOf(() => readRelease(store, 'r-0.3.1'))
    assert.equal(nulled.includes('releases/r-0.3.1.yml'), true, 'null 也要点名文件')
    assert.equal(nulled.includes('undefined'), false, 'null 与缺失同判，同样不许退化成形状错误')
    assert.equal(nulled, missing.replace('r-0.3.0', 'r-0.3.1'), '两种坏法给出同一条口径（只差文件名）')

    // 反向对照：顶层键在、内容合法 ⇒ 读得到（别把"顶层键"这一层判成恒红）
    store.writeYaml([RELEASE_DIR, 'r-0.3.2.yml'], { release: { id: 'r-0.3.2', scope: { requirements: [], acceptance: [] } } })
    assert.equal(readRelease(store, 'r-0.3.2')?.id, 'r-0.3.2', '正常的那份必须读得到')
  })
})

test('M213-13 稀疏往返：可选字段没写就不许长出空壳（缺省＝没有这个键）', () => {
  withStore((store, journal) => {
    const written = writeRelease(store, journal, release018())
    assert.deepEqual(Object.keys(written).sort(), ['id', 'nonScope', 'scope'], '写出去的稀疏形状不许带 packageVersion / frozen* 的空壳')

    const read = readRelease(store, 'r-0.1.8')
    assert.notStrictEqual(read, undefined, '刚写进去的那份必须读得到')
    const value = read ?? {}
    assert.deepEqual(Object.keys(value).sort(), ['id', 'nonScope', 'scope'], '读回来的键面同样不许有空壳')
    assert.equal('packageVersion' in value, false, 'packageVersion 没写就不许以空串长出来（映射是从 id 取的，空串是另一回事）')
    assert.equal('frozenAtSeq' in value, false, '没冻结就没有 frozenAtSeq 这个键')
    assert.equal('frozenBy' in value, false, '没冻结就没有 frozenBy 这个键')
    assert.deepEqual(value, { id: 'r-0.1.8', scope: { requirements: ['REQ-063'], acceptance: [] }, nonScope: [] }, '稀疏往返：写什么读什么，缺省字段一个都不多')

    // 反向对照：写了可选字段的那份必须带出来（别为了"没有空壳"把真值也吞掉）
    assert.deepEqual(Object.keys(writeRelease(store, journal, release017())).sort(), ['frozenAtSeq', 'frozenBy', 'id', 'nonScope', 'packageVersion', 'scope'], '写全的那份六个键都在')
  })
})

test('M213-14 导出面的顺序＝文件名序，不是版本语义序（下游别拿顺序当版本先后）', () => {
  withStore((store, journal) => {
    writeRelease(store, journal, { id: 'r-0.1.9', packageVersion: '0.1.9', scope: { requirements: [], acceptance: [] }, frozenAtSeq: 300, frozenBy: 'human' })
    writeRelease(store, journal, { id: 'r-0.1.10', packageVersion: '0.1.10', scope: { requirements: [], acceptance: [] }, frozenAtSeq: 400, frozenBy: 'human' })

    assert.deepEqual(listReleaseIdsByName(store), ['r-0.1.10', 'r-0.1.9'], '文件名序（字典序）：0.1.10 排在 0.1.9 前面，而版本上 0.1.10 更**新**')
    assert.deepEqual(listReleases(store).map((release) => release.id), ['r-0.1.10', 'r-0.1.9'], 'listReleases 沿用同一个顺序')
    // 同一组输入、两种口径的对照：数组末位不是最新，最新由版本语义序挑
    assert.equal(listReleaseIdsByName(store).at(-1), 'r-0.1.9', '末位是文件名序的最后一名，不是最新版')
    assert.equal(currentRelease(listReleases(store))?.id, 'r-0.1.10', '最新版由**版本语义序**决定（currentRelease 自己重排，不依赖入参顺序）')
    assert.equal(currentRelease([...listReleases(store)].reverse())?.id, 'r-0.1.10', '把入参反过来，当前版不变（顺序不进判定）')
  })
})

test('M213-15 夹具纪律：每次取一份新对象（派生只读入参，改一份不影响另一格）', () => {
  const snapshot = structuredClone(release017())
  const releases = [release016(), release017()]
  deriveFor(releases, 'DEF-999')
  deriveFor(releases, 'DEF-777')
  deriveFor([...releases, release018()], 'REQ-063')
  assert.deepEqual(releases[1], snapshot, '派生不许改入参（改了就说明跨格污染的路已经打开）')

  const first = release017()
  first.nonScope = []
  first.scope.requirements.push('REQ-999')
  const second = release017()
  assert.notEqual(first, second, '工厂每次给一个新对象（同一个引用会让上一格的改动串到下一格）')
  assert.equal(second.nonScope?.length, 1, '改一份夹具不影响下一次取到的那份')
  assert.deepEqual(second.scope.requirements, ['REQ-063'], '内层数组也得各格自带（浅拷贝共用数组同样会串）')
})
