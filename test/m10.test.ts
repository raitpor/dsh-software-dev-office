/**
 * 命令面参数解析的**兼容性守卫**（DEF：README 的写法与解析实现不一致）。
 *
 * 缺陷现场：README 写 `--decide choice=add-budget`，代码只读 `option(raw,'choice')`（即 `--choice=…`）
 * → 照文档写的命令**取不到值**，落到语言包 `uiCommands.k3`（"需要 `--choice=…`"）的提示。
 * 本文件做**三向**证明（缺一向都不算修好）：
 *   ① 旧写法 `choice=add-budget` 仍生效、并按预期落盘；
 *   ② 规范写法 `--choice=add-budget` / `--choice add-budget` 同样生效，且回执与①**逐字节相同**；
 *   ③ 非法值 `choice=bogus` **仍被拒绝**（不是"缺少参数"提示），且**不落盘**
 *      —— 这条专门守住"放宽解析把非法输入也放行"。
 * 另外守住"放宽解析不得误吞"：前缀相似的 `--xchoice=…`、引号内的 k=v、别人的键都不算 choice。
 *
 * 复用真实实现：命令的 setBudget/decideBudget 用 `src/interface/budgetReceipt.ts` ——
 * 与 `src/index.ts` 装配进命令面的**同一份**（不在测试里重写校验），否则"非法值被拒"根本测不到。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { fmt, t } from '../src/domain/i18n.js'
import { decideBudgetReceipt, setBudgetReceipt } from '../src/interface/budgetReceipt.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { SoftwareDevOffice } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m10/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

/** 每个用例都从**同一初始状态**开始：回执里的"累计决定 N 条"才具备可比性。 */
function fresh(): void {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M10 测试', scale: 'normal', stakeholders: ['业务方'] })
}

beforeEach(() => {
  fresh()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 真机 Agent 形状：工作目录只在 `session.header.cwd`。 */
function agentOf(): unknown {
  return { id: 's1', session: { header: { cwd: workspace } } }
}

function invocationFor(rawInput: string): CommandInvocation {
  return {
    commandId: 'cmd-test',
    agent: agentOf(),
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

/** 命令依赖 = index.ts 里那份回执（同一份实现），价格表留空以免回执依赖环境。 */
function deps(): Partial<OfficeCommandDeps> {
  return {
    setBudget: (call, input) => setBudgetReceipt(office, call, input, {}),
    decideBudget: (call, choice, note) => decideBudgetReceipt(office, call, choice, note),
  }
}

/** 走真实命令处理路径执行 `/sdo-budget`。 */
async function budget(rawInput: string): Promise<string> {
  const found = createOfficeCommands(deps() as unknown as OfficeCommandDeps, false).find((item) => item.name === 'sdo-budget')
  assert.ok(found !== undefined, '命令面缺少 sdo-budget')
  const result = await found.handler(invocationFor(rawInput))
  assert.equal(result.kind, 'success', `sdo-budget 应成功：${result.text}`)
  return result.text ?? ''
}

/** `.sdo/budget.yml` 的原始文本（没写过则为 undefined）。 */
function budgetFile(): string | undefined {
  const path = join(workspace, '.sdo', 'budget.yml')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 最后一条决定的 choice（没有决定则为 undefined）。 */
function lastChoice(): string | undefined {
  const decisions = office.budget(call())?.decisions ?? []
  return decisions[decisions.length - 1]?.choice
}

test('M10-01 `--decide` 三种写法都生效且落盘：旧 `choice=` 与 `--choice=` / `--choice ` 回执逐字节相同', async () => {
  const runs: { raw: string; text: string }[] = []
  for (const raw of ['--decide choice=add-budget', '--decide --choice=add-budget', '--decide --choice add-budget']) {
    fresh()
    const text = await budget(raw)
    runs.push({ raw, text })
    assert.equal(office.budget(call())?.decisions.length, 1, `${raw} 必须恰好落一条决定`)
    assert.equal(lastChoice(), 'add-budget', `${raw} 落盘的 choice 必须是 add-budget`)
    assert.ok((budgetFile() ?? '').includes('add-budget'), `${raw} 的决定必须写进 .sdo/budget.yml`)
  }
  const legacy = runs[0]?.text ?? ''
  assert.notEqual(legacy, t('uiCommands.k3'), '旧写法不得再落进"需要 --choice=…"的提示')
  assert.equal(legacy, fmt('uiIndex.k16', { p1: t('uiIndex.k13'), p2: t('uiCommands.k4'), p3: 1 }), '回执必须是"已记录决定"的正文')
  assert.equal(runs[1]?.text, legacy, '`--choice=add-budget` 的回执必须与旧写法逐字节相同')
  assert.equal(runs[2]?.text, legacy, '`--choice add-budget` 的回执必须与旧写法逐字节相同')
})

test('M10-02 `--set` 旧写法（裸 total=/currency=/tiers=）仍生效，且与规范写法回执逐字节相同', async () => {
  const legacy = await budget('--set total=100 currency=CNY tiers=50,80,100')
  assert.equal(office.budget(call())?.total, 100, '裸 total=100 必须真的设上限值')
  assert.equal(office.budget(call())?.currency, 'CNY', '裸 currency=CNY 必须真的设上币种')
  assert.deepEqual(office.budget(call())?.tiers, [50, 80, 100], '裸 tiers=… 必须真的设上档位')
  assert.ok((budgetFile() ?? '').includes('total: 100'), '预算必须落盘')

  // setBudget 是幂等合并：同一状态上再设一次，回执必须逐字节相同
  assert.equal(await budget('--set --total=100 --currency=CNY --tiers=50,80,100'), legacy, '规范写法回执必须与旧写法逐字节相同')
  assert.equal(await budget('--set --total=100 currency=CNY --tiers=50,80,100'), legacy, '新旧混写也必须得到同一份回执')
})

test('M10-03 非法值 `choice=bogus` / `--choice=bogus` 仍被拒绝，且不得落盘', async () => {
  for (const raw of ['--decide choice=bogus', '--decide --choice=bogus', '--decide --choice bogus']) {
    fresh()
    const text = await budget(raw)
    assert.equal(text, t('uiIndex.k12'), `${raw} 必须给出"未知选择"的拒绝文案`)
    assert.notEqual(text, t('uiCommands.k3'), `${raw} 不是"缺少参数"，必须是明确的拒绝`)
    assert.equal(office.budget(call()), undefined, `${raw} 非法选择不得写进预算`)
    assert.equal(budgetFile(), undefined, `${raw} 非法选择不得产生 .sdo/budget.yml`)
  }
  // 对照：真的没给 choice 时仍走"需要 --choice=…" —— 两种失败必须可区分
  fresh()
  assert.equal(await budget('--decide'), t('uiCommands.k3'), '缺 choice 必须给"需要 --choice=…"')
  assert.equal(budgetFile(), undefined)
})

test('M10-04 裸 k=v 回退不得误吞：前缀相似开关 / 引号内文本 / 别人的键 / 位置参数', async () => {
  // ① 前缀相似：`--xchoice=waive` 不是 choice（回退不认 `-` 开头的 token）
  fresh()
  assert.equal(await budget('--decide --xchoice=waive'), t('uiCommands.k3'), '`--xchoice=` 不得被当成 choice')
  assert.equal(budgetFile(), undefined)

  // ② 引号内的 `k=v` 是某个选项的**值**，不是选项本身（`--decide "choice=waive"` 仍是缺参数）
  fresh()
  assert.equal(await budget('--decide "choice=waive"'), t('uiCommands.k3'), '引号内的 choice= 不得被认成选项')
  assert.equal(budgetFile(), undefined)

  // ③ 规范写法优先：同一串里既有 `--choice=` 又有裸 `choice=` 时以 `--choice=` 为准（与顺序无关的确定性）
  for (const raw of ['--decide choice=add-budget --choice=waive', '--decide --choice=waive choice=add-budget']) {
    fresh()
    await budget(raw)
    assert.equal(lastChoice(), 'waive', `${raw}：--choice= 必须优先于裸 choice=`)
  }

  // ④ 键必须整段相等：`note=7` 不是 total，未给的 currency 保持默认（不猜、不误吞）
  fresh()
  await budget('--set note=7 total=100')
  assert.equal(office.budget(call())?.total, 100)
  assert.equal(office.budget(call())?.currency, 'CNY', '未给 currency 时必须保持默认，不得被 note=7 之类污染')

  // ⑤ 位置参数不属于任何 key：`/sdo-lang en`（唯一带位置参数的命令）必须原样拿到 `en`
  const seen: string[] = []
  const withLang = { ...deps(), langSwitch: async (input?: string) => { seen.push(input ?? ''); return 'ok' } } as unknown as OfficeCommandDeps
  const lang = createOfficeCommands(withLang, false).find((item) => item.name === 'sdo-lang')
  assert.ok(lang !== undefined, '命令面缺少 sdo-lang')
  await lang.handler(invocationFor('en'))
  assert.deepEqual(seen, ['en'], '位置参数必须原样传给命令，不得被裸 k=v 回退改写或吞掉')
})
