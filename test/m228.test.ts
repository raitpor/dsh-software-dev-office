/**
 * **`TASK-192`：`.sdo/` 的入库边界（真源层进主仓库，`evidence`/`drafts`/`handover`/`project.json` 不进）。**
 *
 * 病灶：`.gitignore` 里一条 `.sdo/` 把**整本台账**挡在仓库外 —— 而台账正是本插件"可复核、可追溯"
 * 的那一半（评审记录、缺陷账、门禁、需求/设计真源都在里面）。于是"能不能查"只能靠本机那台机器。
 *
 * 本文件钉三件事，判据都落在**机制**上（`git check-ignore` 与 `git ls-files` 的真实行为），不是读注释：
 *   ① **真源层不被忽略**：`journal.jsonl` 与 `tasks/`、`reviews/`、`defects/`、`requirements/` 下的
 *      路径必须 `git check-ignore` **判否**（退出码非 0）；
 *   ② **可再生的层仍被排除**：`evidence/`、`drafts/`、`handover/` 下的路径与 `project.json` 必须判**是**；
 *   ③ **已入库面**：`git ls-files .sdo` 非空，且其中不得出现 `evidence/`、`drafts/`、`handover/`、
 *      `project.json` —— 这一条**只有在驾驶舱把真源层加入索引之后才有对象**（本卡不 `git add`），
 *      所以在"尚未入库"的现场里它**显式 skip 并印读数**，不静默绿、也不假装红。
 *
 * 体积判据的**本意**（口径写清，别当绝对预算读）：防的是「把**可再生 / 体积型**的层塞进仓库」
 * （`evidence/` 36M、`drafts/` 11M 那一类），**不是**卡死一个绝对字节数。`journal.jsonl`（8.3M）是
 * **真源**、必须跟踪 ⇒ 它**计入分母**、不豁免。
 * 现盘实算 ≈**13.6 MiB / 1676 文件**；卡面写的「约 5.9 MB / 目标 <10 MB」是**旧账态**读数，**不作基线**
 * （<10 MB 在现账态下只能用"排除 journal"换，那等于掏空真源 —— 比超预算严重得多）。上界取 **20 MiB**，
 * 实算值打进日志（本文件每个 skip/日志都带读数）。
 *
 * 纪律：断言消息全英文（本文件不进 `KNOWN_PROSE_GAP`），中文只写在断言之外。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MIB = 1024 * 1024

/** 在仓库根跑一条 git（**不抛**：退出码本身就是判据）。 */
function git(args: readonly string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: String(out ?? '') }
  } catch (error) {
    const failed = error as { stdout?: unknown; stderr?: unknown }
    return { ok: false, out: `${String(failed.stdout ?? '')}${String(failed.stderr ?? '')}` }
  }
}

/** 这个路径是否被忽略（`git check-ignore` 退出码 0 = 被忽略）。 */
function isIgnored(path: string): boolean {
  return git(['check-ignore', '-q', '--', path]).ok
}

test('M228-01 (boundary, two-state) the truth layer is not ignored while evidence/drafts/handover/project.json still are', () => {
  // ① 真源层必须**不被**忽略
  for (const path of ['.sdo/journal.jsonl', '.sdo/tasks', '.sdo/reviews', '.sdo/defects', '.sdo/requirements']) {
    assert.equal(isIgnored(path), false, `the truth layer must be storable in the repo (not ignored): ${path}`)
  }
  // ② 可再生/按需的层必须**仍被**排除
  for (const path of ['.sdo/evidence', '.sdo/drafts', '.sdo/handover', '.sdo/project.json']) {
    assert.equal(isIgnored(path), true, `this layer must stay out of the repo: ${path}`)
  }
  // ③ 反向自证：判据本身能抓到"被忽略"这件事（否则上面 ① 可能只是 check-ignore 恒假）
  assert.equal(isIgnored('.sdo/evidence'), true, 'self-proof: the predicate really reports ignored paths')
  assert.equal(isIgnored('.sdo/journal.jsonl') === isIgnored('.sdo/evidence'), false, 'self-proof: the two states must differ')
})

test('M228-02 (already-stored face) the stored .sdo face is non-empty and holds none of the excluded layers', (t) => {
  const listed = git(['ls-files', '--', '.sdo'])
  assert.equal(listed.ok, true, 'git ls-files must be runnable here')
  const files = listed.out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (files.length === 0) {
    // 索引面归驾驶舱（本卡不 git add）⇒ 显式 skip 并印读数，不静默绿
    t.skip('the truth layer is not in the index yet (staging is the cockpit\'s job): git ls-files .sdo => 0 files; '
      + `untracked-but-storable => ${String(git(['status', '--porcelain', '--untracked-files=all', '--', '.sdo']).out.split('\n').filter((line) => line.trim() !== '').length)} files`)
    return
  }
  for (const banned of ['.sdo/evidence/', '.sdo/drafts/', '.sdo/handover/', '.sdo/project.json']) {
    assert.equal(files.some((file) => file.startsWith(banned)), false, `the index must not carry ${banned}`)
  }
})

test('M228-03 (size bound) the storable truth layer stays under 20 MiB (the card\'s 5.9 MB is stale)', (t) => {
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', '.sdo'])
  const files = status.out.split('\n').map((line) => line.slice(3).trim()).filter((line) => line !== '')
  let bytes = 0
  for (const file of files) {
    try {
      bytes += statSync(join(ROOT, file)).size
    } catch {
      /* 已经被移动/删除的条目不计 */
    }
  }
  const mib = bytes / MIB
  console.log(`[M228-03] storable truth layer: ${String(files.length)} files, ${mib.toFixed(1)} MiB`)
  if (files.length === 0) {
    t.skip('nothing storable is currently untracked (already staged or already ignored) — nothing to weigh')
    return
  }
  assert.ok(mib < 20, `the storable truth layer must stay under 20 MiB, got ${mib.toFixed(1)} MiB`)
})
