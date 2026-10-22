#!/usr/bin/env node
/**
 * **`C-72` 缺口对账 ＋ `CHANGELOG` 本版「已知缺口」从台账集合生成**（`REQ-063` / `AC-288` / 规格 §3.2）。
 *
 * 病根：0.1.6 的「已知缺口」清单是**手写**的。`ADR-021` 说"清单必须与台账一致"，但当时台账里
 * **没有集合可对**，于是那句话不可机械核对 —— 多写就是粉饰，少写就是隐瞒，两种都没有判据。
 * `REQ-063` 把版本表达成 release 文件里的一份集合之后，这件事才第一次可以机械判定。
 *
 * 这个脚本做两件事（对应 `C-72` 的两半）：
 *   ① **判**：`CHANGELOG.md` 本版「已知缺口」点到的 id 集合，必须**恰好等于**当前 release 的
 *      `nonScope` 集合（对账面由 `lib/src/domain/release.js` 的 `deferredIdsOf` 算出，不另抄一份口径）；
 *   ② **生成**：该小节整段由台账集合渲染（`renderGapBlock`），不再手写。
 *
 *   ① `node scripts/gen-changelog.mjs --check` ⇒ 只检查、**不改盘**：小节与台账不同步 ⇒ exit 1 并打印差集；
 *      `C-72` 判红同样 exit 1（多写点名粉饰项、少写点名隐瞒项）。
 *   ② `node scripts/gen-changelog.mjs`         ⇒ 重生成该小节（幂等：同一条台账跑两次，字节不变）。
 *
 * ## 三条口径（不许放宽）
 *
 * · **对账面只有一个**：id 集合取自 release 的 `nonScope`（`deferredIdsOf`）。脚本**不读**实体上的
 *   `deferredTo` / `targetVersion` —— 那是派生字段（`AC-287`），拿派生去对派生等于自己给自己作证。
 * · **点名到 id**：清单条目必须写成 `` - `<id>` —— … ``（id 在反引号里、行首）。理由文字里出现的
 *   任何 id **不算**清单项 —— 否则一条理由顺手提一句就能把"漏写"洗成"写过"。
 *   行首是列表项却点不出 id 的条目（"若干老缺陷""见上"这类）一律判红：那正是隐瞒的形状。
 * · **清单块认版本**：小节用一对标记包住，标记里写着这份清单属于**哪一份 release**：台账里查无此版
 *   （或已换成新的一版）⇒ 判红并点名两侧 —— 于是"删掉 release 文件让判据无话可说"这条后路堵死。
 *
 * 依赖已编译的 `lib/src/domain/release.js`（与判据同一份派生实现 —— 不许另写一套 release 解析）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SdoStore } from '../lib/src/infra/store.js'
import { currentRelease, deferredIdsOf, deriveFor, listReleases, packageVersionOf } from '../lib/src/domain/release.js'

/** 清单块的起始标记前缀；完整形态：`<!-- sdo:gap:begin release=r-0.1.7 -->`。 */
export const GAP_BEGIN_PREFIX = '<!-- sdo:gap:begin release='
/** 清单块的结束标记。 */
export const GAP_END_MARK = '<!-- sdo:gap:end -->'
/** 台账里**没有任何** release 时标记里写的值（不是版本号，因此不可能与真 release 撞名）。 */
export const NO_RELEASE = 'none'

/** 清单条目的 id 形态：`` - `<id>` `` —— id 必须在行首的反引号里（`ITEM_ID` 只认这一种写法）。 */
const ITEM_ID = /^[-*]\s+`([A-Za-z][A-Za-z0-9]*-\d+)`/u
/** 任何列表项（用来抓"行首是条目、却点不出 id"的隐瞒形状）。 */
const LIST_ITEM = /^[-*]\s+/u

/** 去重并保序（集合语义：同一 id 写两遍不改变"点没点名"这个事实）。 */
function uniq(values) {
  const out = []
  for (const value of values) if (!out.includes(value)) out.push(value)
  return out
}

/**
 * 读台账：当前 release 与它的顺延集合。
 *
 * 返回 `releaseId: null` = 台账里一份 release 都没有（此时 `ids` 必然为空数组）。
 * 条目里带 `deferredTo`（由 `deriveFor` 派生：目标版本没在册时是空串 —— 不许凭空造版本号）。
 */
export function readLedger(root) {
  const store = new SdoStore(join(root, '.sdo'))
  const releases = listReleases(store)
  const current = currentRelease(releases)
  if (current === undefined) return { releaseId: null, packageVersion: '', entries: [], ids: [] }
  const entries = (current.nonScope ?? []).map((note) => ({
    id: note.id,
    reason: note.reason,
    deferCount: note.deferCount,
    approvedBy: note.approvedBy,
    deferredTo: deriveFor(releases, note.id).deferredTo ?? '',
  }))
  return { releaseId: current.id, packageVersion: packageVersionOf(current), entries, ids: deferredIdsOf(current) }
}

/** 一个条目渲染成一行。理由里的换行折成空格 —— 一个小节条目占一行，解析器才钉得住"行首 id"。 */
function renderEntry(entry) {
  const reason = String(entry.reason ?? '').replace(/\s*\n\s*/gu, ' ').trim()
  const tail = [
    entry.deferredTo === '' ? '下一版尚未在册' : `顺延到 ${entry.deferredTo}`,
    `已顺延 ${entry.deferCount} 次`,
    `批准：${entry.approvedBy}`,
  ]
  return `- \`${entry.id}\` —— ${reason}（${tail.join('；')}）`
}

/**
 * 渲染整个清单块（**唯一**的生成入口：`CHANGELOG` 的这一节不再手写）。
 *
 * 标记里写的是**当前 release 的 id**；台账里一份都没有时写 `none` —— 此时正文必须说清
 * 「本版缺口集合尚未存在」，不许让读者把"没有集合"读成"没有缺口"。
 */
export function renderGapBlock({ releaseId, packageVersion = '', entries = [] }) {
  const target = releaseId === null || releaseId === undefined || releaseId === '' ? NO_RELEASE : releaseId
  const lines = [
    `${GAP_BEGIN_PREFIX}${target} -->`,
    `### 已知缺口（由台账集合生成，共 ${entries.length} 项）`,
    '',
    '> 本节由 `scripts/gen-changelog.mjs` 从 `.sdo/releases/` 的 `nonScope` 集合生成'
      + '（`C-72`：多写＝粉饰、少写＝隐瞒；`node scripts/gen-changelog.mjs --check` 会对账）。',
    '',
  ]
  if (entries.length === 0) {
    lines.push(target === NO_RELEASE
      ? '（台账里还没有任何 release 文件：本版缺口集合尚未存在 —— 这不等于「没有缺口」。'
        + '冻结 `r-<包版本>` 之后重跑本脚本，这一节会从集合重生成。）'
      : '（当前 release 的 `nonScope` 为空：本版没有登记顺延项。）')
  } else {
    for (const entry of entries) lines.push(renderEntry(entry))
  }
  lines.push(GAP_END_MARK)
  return lines.join('\n')
}

/**
 * 从 `CHANGELOG` 文本里读出清单块。
 *
 * 返回 `present`（有没有块）/ `malformed`（标记不配对）/ `release`（标记里写的版本）/
 * `ids`（点到的 id 集合）/ `unparsable`（行首是列表项却点不出 id 的行）。
 */
export function parseGapBlock(text) {
  const source = text ?? ''
  const beginAt = source.indexOf(GAP_BEGIN_PREFIX)
  if (beginAt === -1) return { present: false, malformed: false, release: '', ids: [], unparsable: [] }
  const lineEnd = source.indexOf('\n', beginAt)
  const headEnd = lineEnd === -1 ? source.length : lineEnd
  const head = source.slice(beginAt, headEnd)
  const closeAt = head.indexOf(' -->')
  const release = (closeAt === -1 ? head.slice(GAP_BEGIN_PREFIX.length) : head.slice(GAP_BEGIN_PREFIX.length, closeAt)).trim()
  const endAt = source.indexOf(GAP_END_MARK, headEnd)
  const malformed = closeAt === -1 || endAt === -1
  const body = endAt === -1 ? source.slice(headEnd) : source.slice(headEnd, endAt)
  const ids = []
  const unparsable = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const matched = ITEM_ID.exec(line)
    if (matched !== null) { ids.push(matched[1]); continue }
    if (LIST_ITEM.test(line)) unparsable.push(line)
  }
  return { present: true, malformed, release, ids: uniq(ids), unparsable }
}

/**
 * `C-72` 判定：清单点到的 id 集合与台账 `nonScope` 集合**恰好相等**。
 *
 * 四态（规格 §3.2）：两边都空 ⇒ 绿；恰好相等 ⇒ 绿；少写 ⇒ 红并点名**隐瞒项**；多写 ⇒ 红并点名**粉饰项**。
 * 另有两个必红面（都属于"对不上"而不是"风格问题"）：清单块属于**别的版本**、条目点不出 id。
 */
export function checkGapParity({ changelogText, releaseId, declaredIds = [] }) {
  const target = releaseId === null || releaseId === undefined || releaseId === '' ? NO_RELEASE : releaseId
  const declared = uniq((declaredIds ?? []).map((id) => String(id).trim()).filter((id) => id !== ''))
  const block = parseGapBlock(changelogText ?? '')
  const base = { padding: [], hidden: [], unparsable: [], markerMismatch: false, release: target, declared }

  if (!block.present) {
    // 小节可以不存在 —— 但只在**两边都空**时才可以（规格 §3.2）
    if (declared.length === 0) {
      return { ...base, ok: true, status: 'green', message: '✓ C-72 绿：台账没有顺延项、CHANGELOG 也没有缺口小节（两边都空）' }
    }
    return {
      ...base,
      ok: false,
      status: 'red',
      hidden: declared,
      message: `✗ C-72 红：CHANGELOG 没有本版「已知缺口」小节 —— 已登记的顺延项一个都没点名（隐瞒项：${declared.join('、')}）`,
    }
  }

  const listed = block.ids
  const padding = listed.filter((id) => !declared.includes(id))
  const hidden = declared.filter((id) => !listed.includes(id))
  const markerMismatch = block.release !== target
  const problems = []

  if (block.malformed) {
    problems.push(`清单块的标记不配对（\`${GAP_BEGIN_PREFIX}…\` 或 \`${GAP_END_MARK}\` 缺一个）：块的范围说不清，等于对不了账`)
  }
  if (markerMismatch) {
    problems.push(`清单块属于「${block.release === '' ? '未标注' : block.release}」，当前 release 是「${target}」——`
      + '上一版的清单没跟着换，或台账里这一版已不存在')
  }
  if (padding.length > 0) {
    problems.push(`清单里有集合没有的 id（粉饰项）：${padding.join('、')} —— 台账的 nonScope 里没有这些条目，写进清单就是把没交代的东西说成有交代`)
  }
  if (hidden.length > 0) {
    problems.push(`集合里有清单没写的 id（隐瞒项）：${hidden.join('、')} —— 已登记的顺延必须在清单里点名`)
  }
  if (block.unparsable.length > 0) {
    problems.push(`清单里有条目点不出 id（隐瞒的形状）：${block.unparsable.map((line) => `「${line}」`).join('、')} ——`
      + '每条缺口必须写成 `- `<id>` —— 理由`，散话不算点名')
  }

  if (problems.length === 0) {
    return {
      ...base,
      ok: true,
      status: 'green',
      message: declared.length === 0
        ? `✓ C-72 绿：清单与「${target}」的 nonScope 恰好相等（两边都空）`
        : `✓ C-72 绿：清单与「${target}」的 nonScope 恰好相等（${declared.length} 项：${declared.join('、')}）`,
    }
  }
  return {
    ...base,
    ok: false,
    status: 'red',
    padding,
    hidden,
    unparsable: block.unparsable,
    markerMismatch,
    message: `✗ C-72 红：\n  - ${problems.join('\n  - ')}`,
  }
}

/**
 * 把清单块写进 `CHANGELOG` 文本：已有块 ⇒ **整段替换**（块边界由标记确定，不靠标题字样）；
 * 没有块 ⇒ 插进 `## [Unreleased]` 段的**末尾**（本版＝在飞的那一版）。
 *
 * 幂等：块存在时替换结果只取决于台账，与原文该节写了什么无关 ⇒ 同一台账跑两次字节不变。
 */
export function applyGapBlock(text, block) {
  const source = text ?? ''
  const beginAt = source.indexOf(GAP_BEGIN_PREFIX)
  if (beginAt !== -1) {
    const lineEnd = source.indexOf('\n', beginAt)
    const headEnd = lineEnd === -1 ? source.length : lineEnd
    const endAt = source.indexOf(GAP_END_MARK, headEnd)
    if (endAt !== -1) return `${source.slice(0, beginAt)}${block}${source.slice(endAt + GAP_END_MARK.length)}`
  }
  const unreleased = source.indexOf('## [Unreleased]')
  if (unreleased === -1) {
    throw new Error('CHANGELOG.md 里找不到 `## [Unreleased]` 段：缺口小节要落在当前在飞版本里')
  }
  const nextHeading = source.indexOf('\n## [', unreleased + 1)
  const at = nextHeading === -1 ? source.length : nextHeading
  const head = source.slice(0, at).replace(/\n+$/u, '')
  return `${head}\n\n${block}\n${source.slice(at)}`
}

/** 差集明细（`+` 生成后有、`-` 生成前有）—— 明细可见，重生成才不是"静默漂移"。 */
function diffLines(before, after) {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const removed = oldLines.filter((line) => line.trim() !== '' && !newLines.includes(line))
  const added = newLines.filter((line) => line.trim() !== '' && !oldLines.includes(line))
  return { removed, added }
}

/** 仓库根（`scripts/` 的上一级）；`--root` 可换（守卫要拿夹具根跑，绝不碰真账与真 CHANGELOG）。 */
function rootOf(argv) {
  const at = argv.indexOf('--root')
  if (at !== -1 && argv[at + 1] !== undefined) return resolve(argv[at + 1])
  return fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/u, '')
}

function main(argv) {
  const check = argv.includes('--check')
  const root = rootOf(argv)
  const changelogPath = join(root, 'CHANGELOG.md')
  const before = readFileSync(changelogPath, 'utf8')
  const ledger = readLedger(root)
  const block = renderGapBlock(ledger)
  const after = applyGapBlock(before, block)
  const inSync = after === before
  const verdict = check
    ? checkGapParity({ changelogText: before, releaseId: ledger.releaseId, declaredIds: ledger.ids })
    : checkGapParity({ changelogText: after, releaseId: ledger.releaseId, declaredIds: ledger.ids })

  console.log(`台账：${ledger.releaseId === null
    ? '没有任何 release 文件（`.sdo/releases/` 为空）'
    : `${ledger.releaseId}（包版本 ${ledger.packageVersion}）`}；nonScope ${ledger.ids.length} 项`)

  if (check) {
    if (!inSync) {
      const { removed, added } = diffLines(before, after)
      console.log('✗ 小节与台账不同步：跑 `node scripts/gen-changelog.mjs` 重生成（只检查，本轮未写盘）')
      if (removed.length > 0) console.log(`  - 应删除：\n    ${removed.join('\n    ')}`)
      if (added.length > 0) console.log(`  + 应新增：\n    ${added.join('\n    ')}`)
    }
    console.log(verdict.message)
    return inSync && verdict.ok ? 0 : 1
  }

  if (inSync) console.log('✓ 缺口小节与台账已同步（无需写盘）')
  else {
    writeFileSync(changelogPath, after, 'utf8')
    console.log('✓ 已按台账集合重写 CHANGELOG.md 的缺口小节')
  }
  console.log(verdict.message)
  return verdict.ok ? 0 : 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
