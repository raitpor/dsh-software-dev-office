/**
 * **§2.1（第二轮评审 HIGH）**：A2 的补记以前**不带 `journalSeq`**，而读者 `changedFilesSince` 要求它
 * （`entry.journalSeq !== undefined && entry.journalSeq > sinceSeq`）⇒ 补记出来的条目**永远不命中**：
 * `unresolvedSeqs` 反复列同一批、越界写永不告警（真机 seq 42）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { changedFilesSince, readWorkspaceChanges, recordWorkspaceChanges } from '../src/domain/workspaceChanges.js'
import type { SdoConfig } from '../src/config.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm57')
let office: SoftwareDevOffice
let store: SdoStore

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', BASE)
  store = new SdoStore(join(BASE, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('§2.1：补记必须带 `journalSeq`（否则对账永远不命中）', () => {
  // 原记录（宿主采集那一刻）带 journalSeq=5，但没有文件清单
  recordWorkspaceChanges({ store, sessionId: 's-dev', seq: 883, journalSeq: 5, summary: undefined, enabled: true, hasProject: true })
  assert.deepEqual(changedFilesSince(store, 's-dev', 4).files, [], '原记录没有文件清单 ⇒ 看不出越界')

  // A2 补记（`done` 那一刻拿到文件清单）
  office.noteResolvedWorkspaceChanges({ sessionId: 's-cockpit', cwd: BASE }, { sessionId: 's-dev', seq: 883, files: ['src/outside/x.ts'] })

  const entries = readWorkspaceChanges(store).entries
  assert.equal(entries.length, 2, '补记是一条新条目')
  assert.equal(entries[1]?.journalSeq, 5, '§2.1：补记必须与原记录**同量纲**（复用它的 journalSeq）')
  const hit = changedFilesSince(store, 's-dev', 4)
  assert.deepEqual(hit.files, ['src/outside/x.ts'], `§2.1：补记之后对账必须能看见这批文件：${JSON.stringify(hit)}`)
  assert.equal(hit.audited, true)
})

test('§2.1：既没有原条目、真源也为空 ⇒ **不写**（宁可"未对账"，不写没有量纲键的条目）', () => {
  office.noteResolvedWorkspaceChanges({ sessionId: 's-cockpit', cwd: BASE }, { sessionId: 's-dev', seq: 900, files: ['src/a.ts'] })
  assert.deepEqual(readWorkspaceChanges(store).entries, [], '§2.1：不得写出没有 journalSeq 的补记')
  assert.equal(changedFilesSync(store, 's-dev'), false)
})

/** 对账是否"看得见"（`audited=false` = 如实未对账）。 */
function changedFilesSync(target: SdoStore, sessionId: string): boolean {
  return changedFilesSince(target, sessionId, 0).audited
}
