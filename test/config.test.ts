import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig, Settings } from '../src/config.js'

/**
 * schemastery 在**运行时**补默认值，但类型上 `Config` 要求完整输入。
 * 测试里需要一个宽松入口来验证"部分配置 + 默认值"。
 */
const cfg = (input: Record<string, unknown>): Settings => resolveSettings(Config(input as unknown as SdoConfig))

test('配置 schema：空对象即得到完整默认值（挂载前就能验证）', () => {
  const settings = cfg({})
  assert.equal(settings.projectDirName, '.sdo')
  assert.equal(settings.promptOrder, 240)
  assert.equal(settings.injectStatus, true)
  assert.equal(settings.statusChars, 1500)
  assert.equal(settings.gateLevel, 'enforce')
  assert.deepEqual(settings.disciplineTools, ['write', 'edit', 'bash'])
  assert.deepEqual(settings.disciplineAllowPaths, ['.sdo/', 'docs/', 'test/'])
  assert.equal(settings.registerTools, true)
  assert.equal(settings.registerCommands, true)
  assert.equal(settings.orchestrator, 'subagent')
  assert.equal(settings.maxParallelDispatch, 4)
  assert.equal(settings.captureWorkspaceChanges, true)
  assert.deepEqual(settings.board, { text: true, panel: false })
  assert.deepEqual(settings.cost, { enabled: true, warnOnBudget: true })
})

test('配置 schema：拒绝非法取值（提前暴露拼错的 preset）', () => {
  assert.throws(() => cfg({ gateLevel: 'L2' }), /gateLevel|suggest|enforce|strict/u)
  assert.throws(() => cfg({ maxParallelDispatch: 0 }), /maxParallelDispatch|minimum|range/u)
  assert.throws(() => cfg({ orchestrator: 'native_team' }), /orchestrator|subagent|inline/u)
})

test('配置归一化：projectDir 去噪，空值回落 .sdo', () => {
  assert.equal(cfg({ projectDir: './sdo-data/' }).projectDirName, 'sdo-data')
  assert.equal(cfg({ projectDir: '   ' }).projectDirName, '.sdo')
  assert.equal(cfg({ projectDir: 'custom' }).projectDirName, 'custom')
})

test('配置：部分覆盖只替换给定字段（preset 行的整体替换是另一回事）', () => {
  const settings = cfg({ board: { text: false }, cost: { enabled: false } })
  assert.deepEqual(settings.board, { text: false, panel: false })
  assert.deepEqual(settings.cost, { enabled: false, warnOnBudget: true })
})
