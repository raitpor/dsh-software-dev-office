/**
 * **真账拷贝的事故防线（`DEF-261`，`TASK-289` 落地、`TASK-291` 推广）。**
 *
 * 事故（2026-10-26，真实数据损坏）：`cpSync` **默认不解引用**符号链接（`dereference:false`）。
 * 在源目录本身是指向真账的符号链接的沙箱/副本树里，拷进来的**还是那条链接**；紧接着夹具的
 * `rmSync(<fixture>/.sdo/tasks)` 顺着它删掉了**真账的整个 `tasks/`**。
 *
 * 三条防线（**都不许 `dereference: true`**：真账 `.sdo/evidence` 里有二十多条指向 `node_modules`
 * 的软链，解引用会连成环 —— 实测 ELOOP，每格 ~60s 后失败）：
 *   ① **拷前核源**：`lstat(source)` 不许是符号链接（是就当场抛，别等删除动作才显形）；
 *   ② **拷后核目的地**：`lstat(dest)` 非软链 + `realpath(dest)` 落在 `realpath(workspace)` 内、
 *      且不回到真账；
 *   ③ 调用方在**任何删除动作之前**再调一次 {@link assertLedgerCopyIsIsolated}。
 *
 * 为什么抽到这里：同一段三连断言已经在 `test/m232.test.ts` 内联过一份，`test/m243.test.ts` 与
 * `test/task001-red-baseline.test.ts` 是同形暴露面 —— 同一概念两处判据必然分叉（`DEF-044`）。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目的地 `.sdo` 是否**物理隔离**在 `workspace` 内（拷后 / 删除动作前各调一次）。 */
export function assertLedgerCopyIsIsolated(workspace: string, realLedgerDir: string): void {
  const target = join(workspace, '.sdo')
  assert.equal(
    lstatSync(target).isSymbolicLink(),
    false,
    `fixture: the ledger copy must be a real directory, not a symlink (a symlink here deletes the REAL .sdo/tasks on the next rmSync): ${target}`,
  )
  const self = realpathSync(workspace)
  const resolved = realpathSync(target)
  assert.notEqual(resolved, realpathSync(realLedgerDir), `fixture: the copy must not resolve back to the real ledger: ${resolved}`)
  assert.ok(resolved.startsWith(self), `fixture: the ledger copy must resolve inside the fixture workspace: ${resolved} vs ${self}`)
}

/**
 * 真账 → 夹具工作区（**按值**拷到 `<workspace>/.sdo`）。
 *
 * 返回目的地路径。源目录必须是真目录（软链就抛）；**不解引用**，因此真账内部的软链照抄不跟。
 */
export function copyLedgerIntoWorkspace(workspace: string, realLedgerDir: string): string {
  assert.equal(
    lstatSync(realLedgerDir).isSymbolicLink(),
    false,
    `fixture: the real ledger dir itself must be a real directory -- if it is a symlink the copy keeps the link and the next rmSync deletes the REAL ledger: ${realLedgerDir}`,
  )
  const target = join(workspace, '.sdo')
  cpSync(realLedgerDir, target, { recursive: true })
  assertLedgerCopyIsIsolated(workspace, realLedgerDir)
  assert.ok(existsSync(join(target, 'journal.jsonl')), 'fixture: the real ledger must be copied (journal.jsonl missing)')
  return target
}

/** `dir` 的文件数 + 总字节（守卫用：证明"没被删"/"拷得一致"）。只对 `tasks/` 这类小目录用。 */
export function dirFingerprint(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    files += 1
    bytes += statSync(join(dir, entry.name)).size
  }
  return { files, bytes }
}
