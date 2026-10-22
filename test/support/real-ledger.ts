/**
 * 「真账」守卫共用的缺账判定（`DEF-153` / `TC-143` 一族）。
 *
 * **为什么需要它**：本仓 `.sdo/`（项目台账）在 `.gitignore:30` 里**不入库**，而 CI
 * （`.github/workflows/ci.yml`）跑的是干净检出 ⇒ 检出里根本没有真账。有一批守卫断言的是
 * **真账的不变性**（存量 yml 读回不失败、真账三路读数逐字不变、真账评审都带会话 uuid…），
 * 这些断言在「没有真账」时**没有对象可断言**。旧写法直接 `readdirSync(join(ROOT,'.sdo'))`
 * ⇒ 干净检出里抛 `ENOENT`，CI 红 7 格（`DEF-153`，escaped=true）。
 *
 * **口径（只有一条）**：缺账时**明确 skip 并打印理由**。
 *   · **不许**把真账断言换成夹具断言 —— 「存量零迁移」只有在**真账**上才有意义，
 *     换成夹具就是同义反复（`DEF-149` 那族自欺）；
 *   · **不许**删断言；
 *   · **不许**为了让它变绿把 `.sdo/` 塞进仓库（那是整本台账，含 `journal.jsonl` 与真账 yml）。
 *
 * **一处判定**：所有这类守卫都从这里取（`DEF-044` 的教训：同一概念两处判据必然分叉）。
 * 判定材料是 `journal.jsonl`（真源）：它不在 ⇒ 这个 clone 没有本项目的台账。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（`lib/test/support/` 往上三级）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 本项目的真账目录（**不入库**，只存在于开发者本机）。 */
export const REAL_LEDGER_DIR = join(REPO_ROOT, '.sdo')

/** 本机有没有真账（材料是否齐）。 */
export function hasRealLedger(): boolean {
  return existsSync(join(REAL_LEDGER_DIR, 'journal.jsonl'))
}

/**
 * 传给 `node:test` 的选项：缺真账 ⇒ `{ skip: 理由 }`；有真账 ⇒ `{}`（照常执行）。
 *
 * 用法：`test('Mxxx-01 …', realLedgerSkip() ?? {}, () => { … })`
 */
export function realLedgerSkip(): { skip: string } | undefined {
  if (hasRealLedger()) return undefined
  return {
    skip: '本仓 .sdo/ 不入库（.gitignore）⇒ 干净检出（CI）里没有真账；'
      + '本守卫断言的是**真账的不变性**，无对象可断言。本地有 .sdo 时照常执行（不是永久跳过）。',
  }
}
