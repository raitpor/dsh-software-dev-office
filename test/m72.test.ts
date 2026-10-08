/**
 * **F-5（minor，sdo-test 2026-10-08 报告，承接 10-05 报告 §6）**：`sdo_design action=artifact` 的列表字段
 * 是**整类覆盖写**，而描述与回执都不说 —— 真机上「只想补 2 条时序」把既有 **7 条**一起覆盖掉
 * （journal 只记 `entries: 7 → 2`，正文不在台账里，只能在渲染出来的 `docs/METHOD-oo.md` 里逐条找回）。
 *
 * 修法（**不改行为**，改的是"不再静默"）：
 *   ① `designArtifactData` 的描述写明「列表字段是整列覆盖」；
 *   ② 覆盖前**先留一份快照**（复用 `.sdo/evidence/file-history/` 那一套，名字带同毫秒序号 + 每来源上限）；
 *   ③ 回执点名「整列覆盖：dictionary 7 → 2」与副本落点。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { writeMethodArtifactReceipt } from '../src/interface/designReceipt.js'
import type { SdoConfig } from '../src/config.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm72')

let office: SoftwareDevOffice
const call = { sessionId: 's1', cwd: BASE }

const entry = (name: string): Record<string, string> => ({
  name, type: 'record', source: '上游系统', sink: '对账系统', validation: '非空',
})

function write(names: string[]): string {
  return writeMethodArtifactReceipt(office, call as never, {
    action: 'artifact',
    artifactKind: 'dictionary',
    artifactData: JSON.stringify({ summary: '对账差异数据字典', dictionary: names.map((name) => entry(name)) }),
  } as never)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', BASE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M72-01 F-5：整列覆盖必须当场点名（含覆盖前后条数）+ 覆盖前留副本（能恢复出被覆盖的正文）', () => {
  const first = write(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'])
  assert.match(first, /已写入|数据字典/u, `前置：首次写入要成功：${first}`)
  assert.doesNotMatch(first, /整列覆盖/u, '首次写入（盘上没有同名产物）不该报覆盖')

  // 只提交 2 条 ⇒ 覆盖掉 5 条
  const second = write(['F1', 'F2'])
  assert.match(second, /整列覆盖/u, `必须点名整列覆盖：${second}`)
  assert.match(second, /dictionary 7 → 2/u, `要说清前后条数：${second}`)

  // 副本必须真的在，且**含被覆盖掉的正文**
  const history = join(BASE, '.sdo', 'evidence', 'file-history')
  assert.equal(existsSync(history), true, '覆盖前必须留副本（否则正文永久丢失）')
  const snaps = readdirSync(history).filter((name) => name.includes('method-dictionary'))
  assert.equal(snaps.length, 1, `应恰好一份快照：${readdirSync(history).join(' | ')}`)
  const text = readFileSync(join(history, snaps[0] ?? ''), 'utf8')
  for (const name of ['F3', 'F4', 'F5', 'F6', 'F7']) {
    assert.match(text, new RegExp(name, 'u'), `副本里要有被覆盖的 ${name}：${text.slice(0, 200)}`)
  }
  assert.match(second, /file-history/u, `回执要给出副本落点：${second}`)
})

test('M72-02 F-5 反向：只改 summary（不动列表字段）⇒ 不报覆盖、也不留多余快照', () => {
  write(['F1', 'F2'])
  const historyNames = (): string[] => {
    const dir = join(BASE, '.sdo', 'evidence', 'file-history')
    return existsSync(dir) ? readdirSync(dir) : []
  }
  const before = historyNames().length
  const onlySummary = writeMethodArtifactReceipt(office, call as never, {
    action: 'artifact',
    artifactKind: 'dictionary',
    artifactData: JSON.stringify({ summary: '只改摘要' }),
  } as never)
  assert.doesNotMatch(onlySummary, /整列覆盖/u, `没提交列表字段就不该报覆盖：${onlySummary}`)
  assert.equal(historyNames().length, before, '不该因为改摘要就多留副本')
})

test('M72-03 F-5 文案：工具描述必须写明「列表字段是整列覆盖」（描述与行为同源）', () => {
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(BASE, '..', '..', '..', 'src', 'data', 'lang', file), 'utf8')
    const key = text.split('\n').find((line) => line.startsWith('  designArtifactData:')) ?? ''
    assert.match(key, /整列覆盖|whole-list overwrite/u, `${file} 的 artifact 参数说明必须写明整列覆盖：${key.slice(0, 80)}`)
  }
})
