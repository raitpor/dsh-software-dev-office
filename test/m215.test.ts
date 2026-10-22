/**
 * **`M215`（`TASK-175` / `REQ-063` 批 1③ / `AC-288`）：`C-72` 缺口清单与实际集合恰好相等。**
 *
 * 规格 `docs/plan/2026-10-22-规格-0.1.7批1-版本作用域.md` §3.2 只有四句话，这一格逐一钉住它们：
 *   · 清单点到的 id 集合 = 当前 release 的 `nonScope` 集合 ⇒ **绿**；
 *   · 多写（清单有、集合没有）⇒ **红**并点名**粉饰项**；
 *   · 少写（集合有、清单没有）⇒ **红**并点名**隐瞒项**；
 *   · 两边都空 ⇒ **绿**（此时小节可以不存在）。
 *
 * 反例按规格 §4 的编号取材：`R3`（写了顺延登记却没写进清单 ⇒ 红）、`R4`（写全 ⇒ 绿）、
 * `R5`（清单里多写一条集合没有的 `DEF-999` ⇒ 红）。
 *
 * 三件不许放宽的事（都是"看起来绿"的入口）：
 *   ① **对账面只有一个**：id 集合取自 release 的 `nonScope`，与 `C-71` 读同一份派生（`deferredIdsOf`）；
 *      脚本自己再抄一份解析 ⇒ 两份口径迟早分叉，所以 `M215-03` 拿盘上的 release 现算一遍与脚本对照。
 *   ② **理由文字里提一句不算点名**：清单条目必须行首写成 `` - `<id>` —— … ``；只认行首的 id，
 *      否则一条理由顺手带上别的号，就能把"漏写"洗成"写过"。
 *   ③ **清单块认版本**：块标记写着这份清单属于哪一份 release；台账里查无此版 ⇒ 红并点名两侧 ——
 *      于是"删掉 release 文件让判据无话可说"这条后路也堵死。
 *
 * 生成那一半（`scripts/gen-changelog.mjs`）由 `M215-06`/`M215-07` 守：幂等、`--check` 不改盘、只读台账。
 *
 * 写作约定（与 `test/m213.test.ts` 同规）：夹具里的字符串一律用英文（取值会被断言比较），
 * 中文只出现在用例名、注释与**断言消息**里 —— `test/m189.test.ts` 的散文站点棘轮按行抽取，
 * 断言取值里出现中文字面量就要按身份登记（本文件刻意保持站点数为 0）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SdoStore } from '../src/infra/store.js'
import { stringifyYaml } from '../src/infra/yaml.js'
import { currentRelease, deferredIdsOf, listReleases } from '../src/domain/release.js'
import type { Release, ReleaseNote } from '../src/types.js'
import { hasRealLedger } from './support/real-ledger.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 被守的脚本本体（跑进程的那几格要用它；纯函数面走 import）。 */
const SCRIPT = fileURLToPath(new URL('../../scripts/gen-changelog.mjs', import.meta.url))

interface GapEntry {
  id: string
  reason: string
  deferCount: number
  approvedBy: string
  deferredTo: string
}
interface GapBlock {
  present: boolean
  malformed: boolean
  release: string
  ids: string[]
  unparsable: string[]
}
interface GapVerdict {
  ok: boolean
  status: string
  padding: string[]
  hidden: string[]
  unparsable: string[]
  markerMismatch: boolean
  message: string
}
interface GapLedger {
  releaseId: string | null
  packageVersion: string
  entries: GapEntry[]
  ids: string[]
}
interface GenModule {
  NO_RELEASE: string
  GAP_END_MARK: string
  readLedger: (root: string) => GapLedger
  renderGapBlock: (input: { releaseId: string | null; packageVersion?: string; entries?: GapEntry[] }) => string
  parseGapBlock: (text: string) => GapBlock
  checkGapParity: (input: { changelogText: string; releaseId: string | null; declaredIds?: string[] }) => GapVerdict
  applyGapBlock: (text: string, block: string) => string
}

/** 动态 import（不写成字面量：`scripts/` 不在 `tsconfig.json` 的 `include` 里，字面量会让 tsc 去找类型）。 */
const gen = (await import(new URL('../../scripts/gen-changelog.mjs', import.meta.url).href)) as unknown as GenModule

/**
 * `M215-08` 的缺账判定（与 `test/support/real-ledger.ts` 同一条口径：缺账 ⇒ 明确 skip 并打印理由）。
 * 干净检出（CI）里 `.sdo/` 不入库，而现盘小节点名的 release 只存在于开发者本机台账 ⇒ 无对账面可断言；
 * 本地有真账时**照常执行**（不是永久跳过）。三态：有真账 ⇒ 跑；无真账且小节要认的版本是 none ⇒ 跑；否则 skip。
 */
const REAL_SYNC_SKIP = ((): { skip: string } | undefined => {
  if (hasRealLedger()) return undefined
  if (gen.parseGapBlock(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).release === gen.NO_RELEASE) return undefined
  return { skip: '干净检出（CI）里没有真账：现盘缺口小节点名的 release 不在本 checkout，无对账面可断言' }
})()

/** 夹具 CHANGELOG 的骨架（纯 ASCII：解析器认的是标记，不是标题字样）。 */
const CHANGELOG_HEAD = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '(next version in progress)',
  '',
  '## [0.1.6] - 2026-10-21',
  '',
  '### Fixed',
  '- history entry.',
  '',
].join('\n')

/** 一条顺延登记（四个必填字段齐备，取值全英文）。 */
const noteOf = (id: string): ReleaseNote => ({ id, reason: 'out-of-scope', deferCount: 1, approvedBy: 'human' })

/** 渲染用的条目（`deferredTo` 留空＝目标版本尚未在册）。 */
const entryOf = (id: string): GapEntry => ({ ...noteOf(id), deferredTo: '' })

/** 一份已冻结的 release（形状过关：`scope` 两个集合 + `nonScope` + 人签）。 */
function releaseOf(id: string, notes: ReleaseNote[]): Release {
  return {
    id,
    scope: { requirements: [], acceptance: [] },
    nonScope: notes,
    frozenAtSeq: 200,
    frozenBy: 'human',
  }
}

/** 每格一个临时根（`.sdo/releases/` + `CHANGELOG.md`），不碰真账也不碰真 CHANGELOG。 */
function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m215-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 往夹具根落一份 release（走与实现同一份 YAML 写出，不手拼文本）。 */
function writeReleaseFile(root: string, release: Release): void {
  const dir = join(root, '.sdo', 'releases')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${release.id}.yml`), stringifyYaml({ release }), 'utf8')
}

/** 夹具里的 CHANGELOG（写进去的都是 ASCII 骨架 + 生成出来的块）。 */
function writeChangelog(root: string, text: string): void {
  writeFileSync(join(root, 'CHANGELOG.md'), text, 'utf8')
}

/** 目录树指纹（相对路径 + 内容 sha256 有序拼接再 sha256）—— 「台账只读」要的是内容级读数。 */
function treeFingerprint(dir: string): string {
  const walk = (path: string, prefix: string, out: string[]): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, rel, out)
      else out.push(`${rel}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  const lines: string[] = []
  walk(dir, '', lines)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 跑脚本（`cwd` 是仓库根：脚本内部按自身位置解析 `lib/`，不依赖 cwd）。 */
function runScript(args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

test('M215-01 C-72 四态：两边都空 / 恰好相等 ⇒ 绿；少写点名隐瞒项、多写点名粉饰项 ⇒ 红', () => {
  // —— 态① 两边都空（小节存在但没有条目）——
  const emptyBlock = gen.renderGapBlock({ releaseId: null, entries: [] })
  const empty = gen.checkGapParity({ changelogText: emptyBlock, releaseId: null, declaredIds: [] })
  assert.equal(empty.ok, true, '两边都空必须绿')
  assert.deepEqual(empty.padding, [], '两边都空时不该报粉饰项')
  assert.deepEqual(empty.hidden, [], '两边都空时不该报隐瞒项')

  // 小节整节不存在 —— 规格 §3.2 明说"此时清单小节可以不存在"，不许因此判红
  const absent = gen.checkGapParity({ changelogText: CHANGELOG_HEAD, releaseId: null, declaredIds: [] })
  assert.equal(absent.ok, true, '两边都空时小节的缺失不算红（否则每个还没冻结的版本都会红）')

  // —— 态② 恰好相等（顺序无关：比的是集合）——
  const block = gen.renderGapBlock({ releaseId: 'r-0.1.7', entries: [entryOf('DEF-001'), entryOf('DEF-002')] })
  const equal = gen.checkGapParity({ changelogText: block, releaseId: 'r-0.1.7', declaredIds: ['DEF-002', 'DEF-001'] })
  assert.equal(equal.ok, true, '集合相等即绿（与台账里的书写顺序无关）')
  assert.equal(equal.message.includes('DEF-001'), true, '绿的回执也要点名对账的那几个 id（读者能自己核对）')

  // —— 态③ 少写：集合有、清单没有 ⇒ 点名隐瞒项 ——
  const hidden = gen.checkGapParity({
    changelogText: block, releaseId: 'r-0.1.7', declaredIds: ['DEF-001', 'DEF-002', 'DEF-003'],
  })
  assert.equal(hidden.ok, false, '少写必须红')
  assert.deepEqual(hidden.hidden, ['DEF-003'], '少写要点名隐瞒项')
  assert.deepEqual(hidden.padding, [], '判别力：少写这一态不许同时报粉饰项')
  assert.equal(hidden.message.includes('DEF-003'), true, '回执里必须出现那个被隐瞒的 id')

  // —— 态④ 多写：清单有、集合没有 ⇒ 点名粉饰项 ——
  const padding = gen.checkGapParity({ changelogText: block, releaseId: 'r-0.1.7', declaredIds: ['DEF-001'] })
  assert.equal(padding.ok, false, '多写必须红')
  assert.deepEqual(padding.padding, ['DEF-002'], '多写要点名粉饰项')
  assert.deepEqual(padding.hidden, [], '判别力：多写这一态不许同时报隐瞒项')
  assert.equal(padding.message.includes('DEF-002'), true, '回执里必须出现那个多写的 id')
})

test('M215-02 三个必红面：清单块属于别的版本 / 条目点不出 id / 理由里提到别的 id 不算点名', () => {
  const block = gen.renderGapBlock({ releaseId: 'r-0.1.6', entries: [entryOf('DEF-001')] })

  // ① 上一版的清单没跟着换 ⇒ 红并点名两侧（"删掉 release 文件让判据无话可说"也落在这里）
  const stale = gen.checkGapParity({ changelogText: block, releaseId: 'r-0.1.7', declaredIds: ['DEF-001'] })
  assert.equal(stale.ok, false, '清单块属于旧版 ⇒ 必红（哪怕 id 恰好一样）')
  assert.equal(stale.markerMismatch, true, '要标出"错的是版本"这个原因')
  assert.equal(stale.message.includes('r-0.1.6'), true, '回执点名清单里写的版本')
  assert.equal(stale.message.includes('r-0.1.7'), true, '回执点名当前 release')
  assert.deepEqual(stale.hidden, [], '版本不符不是"少写"，两个桶不许混')

  // ② 行首是列表项却点不出 id（"若干老缺陷""见上"）⇒ 红：那正是隐瞒的形状
  const vague = gen.renderGapBlock({ releaseId: 'r-0.1.7', entries: [entryOf('DEF-001')] })
    .replace(gen.GAP_END_MARK, '- several legacy defects are still open\n' + gen.GAP_END_MARK)
  const vagueVerdict = gen.checkGapParity({ changelogText: vague, releaseId: 'r-0.1.7', declaredIds: ['DEF-001'] })
  assert.equal(vagueVerdict.ok, false, '点不出 id 的条目必须红（散话不算点名）')
  assert.equal(vagueVerdict.unparsable.length, 1, '要把那条点不出 id 的行报出来')
  assert.equal(vagueVerdict.unparsable[0]?.includes('legacy defects'), true, '报出的就是那一行原文')

  // ③ 反向：理由文字里提到别的 id **不算**清单项（否则一条理由就能把漏写洗成写过）
  const noisy = gen.renderGapBlock({
    releaseId: 'r-0.1.7', entries: [{ ...entryOf('DEF-001'), reason: 'wait for DEF-777 and REQ-063' }],
  })
  const noisyVerdict = gen.checkGapParity({ changelogText: noisy, releaseId: 'r-0.1.7', declaredIds: ['DEF-001'] })
  assert.equal(noisyVerdict.ok, true, '理由里提到的 id 不参与对账（只认行首的那一个）')
  assert.deepEqual(noisyVerdict.padding, [], '理由里提到 DEF-777 不算粉饰项')
})

test('M215-03 R3 写了顺延登记却没写进清单 ⇒ 红（点名隐瞒项），且对账面与 C-71 同一份派生', () => {
  withFixture((root) => {
    const release = releaseOf('r-0.1.7', [noteOf('DEF-001')])
    writeReleaseFile(root, release)
    writeChangelog(root, CHANGELOG_HEAD)

    // 对账面只有一个：脚本读出来的 id 集合，必须等于拿盘上 release 现算的那一份（`C-71` 读的也是它）
    const ledger = gen.readLedger(root)
    const onDisk = (() => {
      const releases = listReleases(new SdoStore(join(root, '.sdo')))
      const current = currentRelease(releases)
      return current === undefined ? [] : deferredIdsOf(current)
    })()
    assert.equal(ledger.releaseId, 'r-0.1.7', '当前 release 必须由台账算出来（最新已冻结的那一版）')
    assert.deepEqual(ledger.ids, onDisk, '脚本的对账面与域层派生必须逐字相同（不许另抄一套解析）')
    assert.deepEqual(ledger.ids, ['DEF-001'], '夹具里只有一条顺延登记')

    // R3：小节整节没写 ⇒ 红，且把每一条都点名（这就是 0.1.6 那条"手写清单"的洞）
    const missing = gen.checkGapParity({ changelogText: CHANGELOG_HEAD, releaseId: ledger.releaseId, declaredIds: ledger.ids })
    assert.equal(missing.ok, false, 'R3：有登记却连小节都没有 ⇒ 必红')
    assert.deepEqual(missing.hidden, ['DEF-001'], 'R3：要点名隐瞒项 DEF-001')

    // R3 的另一种写法：小节在、但那一条被漏掉（手写时漏一行最典型）
    const stripped = gen.applyGapBlock(CHANGELOG_HEAD, gen.renderGapBlock(ledger))
      .split('\n').filter((line) => !line.startsWith('- `DEF-001`')).join('\n')
    const partial = gen.checkGapParity({ changelogText: stripped, releaseId: ledger.releaseId, declaredIds: ledger.ids })
    assert.equal(partial.ok, false, 'R3：小节在但漏掉那一条 ⇒ 同样红')
    assert.deepEqual(partial.hidden, ['DEF-001'], 'R3：漏掉的那条必须被点名')
  })
})

test('M215-04 R4 写全了 ⇒ 绿（生成出来的块原样放进 CHANGELOG 就是绿）', () => {
  withFixture((root) => {
    writeReleaseFile(root, releaseOf('r-0.1.7', [noteOf('DEF-001')]))
    writeChangelog(root, CHANGELOG_HEAD)
    const ledger = gen.readLedger(root)
    const withBlock = gen.applyGapBlock(CHANGELOG_HEAD, gen.renderGapBlock(ledger))
    writeChangelog(root, withBlock)

    const verdict = gen.checkGapParity({ changelogText: withBlock, releaseId: ledger.releaseId, declaredIds: ledger.ids })
    assert.equal(verdict.ok, true, 'R4：清单与集合恰好相等 ⇒ 绿')
    assert.deepEqual(verdict.padding, [], 'R4：没有粉饰项')
    assert.deepEqual(verdict.hidden, [], 'R4：没有隐瞒项')

    // 小节必须真的落在 `## [Unreleased]` 段内（本版＝在飞的那一版），不是随便插在文首/文末
    const lines = withBlock.split('\n')
    const unreleased = lines.indexOf('## [Unreleased]')
    const marker = lines.findIndex((line) => line.startsWith('<!-- sdo:gap:begin release='))
    const nextVersion = lines.findIndex((line, index) => index > unreleased && line.startsWith('## [0.1.6]'))
    assert.equal(unreleased >= 0, true, '夹具里必须有 Unreleased 段')
    assert.equal(marker > unreleased && marker < nextVersion, true, '缺口小节要落在 Unreleased 段内')
  })
})

test('M215-05 R5 清单里多写一条集合没有的 DEF-999 ⇒ 红（点名粉饰项）', () => {
  withFixture((root) => {
    writeReleaseFile(root, releaseOf('r-0.1.7', [noteOf('DEF-001')]))
    writeChangelog(root, CHANGELOG_HEAD)
    const ledger = gen.readLedger(root)
    const padded = gen.applyGapBlock(CHANGELOG_HEAD, gen.renderGapBlock(ledger))
      .replace(gen.GAP_END_MARK, '- `DEF-999` -- not in the ledger at all\n' + gen.GAP_END_MARK)

    const verdict = gen.checkGapParity({ changelogText: padded, releaseId: ledger.releaseId, declaredIds: ledger.ids })
    assert.equal(verdict.ok, false, 'R5：多写必须红')
    assert.deepEqual(verdict.padding, ['DEF-999'], 'R5：要点名粉饰项 DEF-999')
    assert.deepEqual(verdict.hidden, [], 'R5：这一态不许同时报隐瞒项')
    assert.equal(verdict.message.includes('DEF-999'), true, 'R5：回执里必须出现那个多写的 id')
  })
})

test('M215-06 生成脚本幂等，且 --check 只判不改盘（不同步时报出应增/应删的明细）', () => {
  withFixture((root) => {
    writeReleaseFile(root, releaseOf('r-0.1.7', [noteOf('DEF-001'), noteOf('DEF-002')]))
    writeChangelog(root, CHANGELOG_HEAD)
    const path = join(root, 'CHANGELOG.md')

    const first = runScript(['--root', root])
    assert.equal(first.status, 0, `首跑必须成功：${first.out}`)
    const bytes = readFileSync(path)

    const second = runScript(['--root', root])
    assert.equal(second.status, 0, `再跑一次也必须成功：${second.out}`)
    assert.deepEqual(readFileSync(path), bytes, '幂等：同一条台账跑两次，CHANGELOG 字节必须完全相同')

    // 同步状态下 --check ⇒ exit 0，且不动盘
    const statBefore = statSync(path).mtimeMs
    const synced = runScript(['--check', '--root', root])
    assert.equal(synced.status, 0, `同步时 --check 必须 exit 0：${synced.out}`)
    assert.equal(statSync(path).mtimeMs, statBefore, '--check 连 mtime 都不许动')

    // 人为改坏（漏掉一条）⇒ --check exit 1、打印应新增的明细、且**仍然不改盘**
    const tampered = readFileSync(path, 'utf8').split('\n').filter((line) => !line.startsWith('- `DEF-002`')).join('\n')
    writeChangelog(root, tampered)
    const tamperedStat = statSync(path).mtimeMs
    const broken = runScript(['--check', '--root', root])
    assert.equal(broken.status, 1, '不同步时 --check 必须 exit 1')
    assert.equal(broken.out.includes('DEF-002'), true, '检查模式要把差异明细打出来（不是静默失败）')
    assert.equal(readFileSync(path, 'utf8'), tampered, '--check 不许改盘（连"顺手修好"也不行）')
    assert.equal(statSync(path).mtimeMs, tamperedStat, '--check 不许碰文件时间戳')
    const stored = gen.checkGapParity({
      changelogText: tampered, releaseId: 'r-0.1.7', declaredIds: ['DEF-001', 'DEF-002'],
    })
    assert.deepEqual(stored.hidden, ['DEF-002'], '被漏掉的那条要能被点名（证明上一格的 exit 1 不是别的原因）')
  })
})

test('M215-07 生成脚本只读台账：写模式跑完，夹具 `.sdo` 树逐字节不变', () => {
  withFixture((root) => {
    writeReleaseFile(root, releaseOf('r-0.1.7', [noteOf('DEF-001')]))
    writeChangelog(root, CHANGELOG_HEAD)
    const ledgerDir = join(root, '.sdo')
    const before = treeFingerprint(ledgerDir)

    const run = runScript(['--root', root])
    assert.equal(run.status, 0, `写模式必须成功：${run.out}`)
    assert.equal(treeFingerprint(ledgerDir), before, '台账是只读输入：写模式只许动 CHANGELOG.md')
    assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes('DEF-001'), true, 'CHANGELOG 那边要真的被生成')

    // 判别力：指纹读数对"台账被改"必须敏感（否则上面那句"不变"是空断言）
    const releaseFile = join(ledgerDir, 'releases', 'r-0.1.7.yml')
    writeFileSync(releaseFile, `${readFileSync(releaseFile, 'utf8')}\n`, 'utf8')
    assert.notEqual(treeFingerprint(ledgerDir), before, '往台账里写一个字节，指纹必须变')
  })
})

test('M215-08 现盘 CHANGELOG 的缺口小节与真账同步（`--check` exit 0）', REAL_SYNC_SKIP ?? {}, () => {
  const real = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const block = gen.parseGapBlock(real)
  assert.equal(block.present, true, '现盘 CHANGELOG 必须有由脚本生成的缺口小节（手写清单正是本卡要消灭的形态）')
  assert.equal(block.malformed, false, '清单块的成对标记必须完整')
  assert.deepEqual(block.unparsable, [], '现盘清单里不许有"点不出 id"的条目')

  const check = runScript(['--check'])
  assert.equal(check.status, 0, `现盘小节必须与真账台账同步（不同步就跑 node scripts/gen-changelog.mjs）：\n${check.out}`)
  assert.equal(check.out.includes('C-72'), true, '检查模式必须给出 C-72 的读数（判据名可观测）')

  // 现盘这一节的 id 集合必须等于现算出来的那一份（不是"脚本说同步"就算数）
  const ledger = gen.readLedger(ROOT)
  const verdict = gen.checkGapParity({ changelogText: real, releaseId: ledger.releaseId, declaredIds: ledger.ids })
  assert.equal(verdict.ok, true, `现盘缺口清单与台账必须恰好相等：${verdict.message}`)
})
