import assert from 'node:assert/strict'
import { locale as i18nLocalePeek, t } from '../src/domain/i18n.js'
import { countCjkLiterals } from '../src/domain/langScan.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { disciplineOrAllow, evaluateDiscipline } from '../src/domain/discipline.js'
import { ROLES } from '../src/domain/plan.js'
import {
  listRoleCards,
  maskAllows,
  maskConflicts,
  roleCardPath,
  rolesConsistent,
  toolAllowList,
} from '../src/domain/roles.js'
import { roleToolFilter } from '../src/integration/orchestrator.js'
import { renderBoard } from '../src/board/render.js'
import { createOfficeCommands, echoMessage } from '../src/interface/commands.js'
import { callOf, createOfficeTools } from '../src/interface/tools.js'
import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { afterEach, beforeEach } from 'node:test'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)) // lib/test → 包根（skills/ 在这里）
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m7/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

test('M7-01 八张角色卡齐备，且六段式内容非空', () => {
  const cards = listRoleCards()
  assert.equal(cards.length, 8)
  assert.deepEqual(rolesConsistent(cards), { missing: [], extra: [] }, '角色集必须与流程引擎一致')

  for (const card of cards) {
    const path = join(ROOT, roleCardPath(card.code))
    assert.ok(existsSync(path), `缺角色卡 ${path}`)
    const text = readFileSync(path, 'utf8')
    for (const section of ['## 目标', '## 输入契约', '## 输出契约', '## 完成定义', '## 禁止事项', '## 提问 / 评审模板']) {
      assert.ok(text.includes(section), `${card.code} 的卡缺 ${section}`)
    }
    assert.ok(card.rationale.trim() !== '', `${card.code} 缺掩码理由`)
    assert.ok(card.allow.length > 0, `${card.code} 的白名单不能为空`)
  }
})

test('M7-02 掩码表：白名单语义 + 三条硬性禁令 + 无自相矛盾', () => {
  assert.deepEqual(maskConflicts(), [], 'deny 与 allow 不得同时包含同一工具')

  // 三条硬性禁令（计划 T-M7-02 点名）
  assert.equal(maskAllows('analyst', 'sdo_redteam'), false, 'analyst 不得自跑红队')
  assert.equal(maskAllows('developer', 'sdo_review'), false, 'developer 不可见评审（不得自评）')
  assert.equal(maskAllows('tester', 'edit'), false, 'tester 无编辑类工具（不得改被测实现）')

  // 更一般的越界检查
  for (const role of ['red-team', 'reviewer'] as const) {
    for (const tool of ['write', 'edit', 'bash']) {
      assert.equal(maskAllows(role, tool), false, `${role} 不该有 ${tool}`)
    }
  }
  assert.equal(maskAllows('delivery', 'sdo_review'), false)
  assert.equal(maskAllows('architect', 'sdo_requirement'), false, '架构师不改需求')
  assert.equal(maskAllows('office', 'edit'), false, '流程官不碰实现')

  // 白名单语义：allow 之外一律不可见
  assert.equal(maskAllows('developer', 'some-random-tool'), false)
  assert.equal(maskAllows('developer', 'read'), true)

  // 派发时用的工具面与掩码表一致（不允许两份真相）
  for (const role of ROLES) {
    assert.deepEqual(roleToolFilter(role), toolAllowList(role), `${role} 的派发工具面应与掩码表一致`)
  }
})

test('M7-03 阶段纪律：只在 L3 拦、规则可解释、且 fail-open', () => {
  const base = { gateLevel: 'strict' as const, phase: 'requirements', role: 'developer', tool: 'write', initialized: true }

  // L1/L2 不拦（观察阶段）
  assert.equal(evaluateDiscipline({ ...base, gateLevel: 'enforce' }).kind, 'allow')
  assert.equal(evaluateDiscipline({ ...base, gateLevel: 'suggest' }).kind, 'allow')

  // 未初始化 → 只许 sdo_init
  assert.equal(evaluateDiscipline({ ...base, initialized: false, tool: 'sdo_init' }).kind, 'allow')
  assert.equal(evaluateDiscipline({ ...base, initialized: false }).kind, 'deny')

  // 基线前不许写设计
  assert.equal(evaluateDiscipline({ ...base, phase: 'requirements', tool: 'sdo_design' }).kind, 'deny')
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'sdo_design' }).kind, 'allow')

  // 非实现阶段不许写 src/ 代码；实现阶段放行
  assert.equal(evaluateDiscipline({ ...base, phase: 'architecture', tool: 'write', paths: ['src/x.ts'] }).kind, 'deny')
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'write', paths: ['src/x.ts'] }).kind, 'allow')
  // 文档类写入不受限
  assert.equal(evaluateDiscipline({ ...base, phase: 'requirements', tool: 'write', paths: ['docs/SRS.md'] }).kind, 'allow')

  // 真源不可手改
  assert.equal(evaluateDiscipline({ ...base, phase: 'construction', tool: 'write', paths: ['.sdo/journal.jsonl'] }).kind, 'deny')

  // 驾驶舱不受阶段纪律约束（纪律只约束派发出去的角色）
  assert.equal(evaluateDiscipline({ ...base, role: 'cockpit', tool: 'write', paths: ['src/x.ts'] }).kind, 'allow')

  // fail-open：策略抛错时必须放行
  let reported: unknown
  const decision = disciplineOrAllow(
    {
      ...base,
      get tool(): string {
        throw new Error('boom')
      },
    } as never,
    (error) => {
      reported = error
    },
  )
  assert.equal(decision.kind, 'allow', '钩子异常必须放行（fail-open）')
  assert.equal(decision.reason, 'discipline hook failed open')
  assert.ok(reported instanceof Error)
})

let workspace: string
let office: SoftwareDevOffice
beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M7 测试', scale: 'normal', stakeholders: ['业务方'] })
})
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('commandEcho 默认 echo（inbox splice 投递，真机确认可用），可被配置/环境变量关掉', () => {
  assert.equal(resolveSettings(Config({} as unknown as SdoConfig)).commandEcho, 'echo', '默认回显：否则界面看不到命令结果')
  assert.equal(resolveSettings(Config({ commandEcho: 'none' } as never)).commandEcho, 'none', '可关闭')
  process.env['SDO_COMMAND_ECHO'] = 'none'
  try {
    assert.equal(resolveSettings(Config({} as unknown as SdoConfig)).commandEcho, 'none', '环境变量可关闭')
  } finally {
    delete process.env['SDO_COMMAND_ECHO']
  }
  process.env['SDO_COMMAND_ECHO'] = 'echo'
  try {
    assert.equal(resolveSettings(Config({ commandEcho: 'none' } as never)).commandEcho, 'echo', '环境变量优先于配置')
    process.env['SDO_COMMAND_ECHO'] = 'followup'
    assert.equal(resolveSettings(Config({ commandEcho: 'none' } as never)).commandEcho, 'echo', '旧写法 followup 仍被接受（开发环境便利）')
  } finally {
    delete process.env['SDO_COMMAND_ECHO']
  }
})

test('命令回显消息形状（缺 id/source 会让命令报"处理失败"、会话记录读不出来）', () => {
  const message = echoMessage('sdo-status', 'SDO 状态\n- 尚未初始化') as unknown as {
    id: string
    role: string
    source: { kind: string }
    content: { type: string; text: string }[]
  }
  assert.ok(typeof message.id === 'string' && message.id !== '', '构造器必须填出 id（手搓对象缺它就是"后续全失败"的根因）')
  assert.equal(message.role, 'user')
  // 形状随会话格式：当前格式（minor>=2）要求 `plugin:<插件名>`；旧格式才是 {kind:'plugin',plugin}
  assert.equal(message.source.kind, 'plugin:dsh-software-dev-office', 'source 形状错会让宿主每步处理失败')
  assert.match(message.source.kind, /^plugin:/u)
  assert.equal(message.content[0]?.type, 'text')
  assert.match(message.content[0]?.text ?? '', /SDO 命令 `sdo-status` 的结果/u)
  assert.match(message.content[0]?.text ?? '', /尚未初始化/u)
  assert.notEqual(
    (echoMessage('x', 'y') as unknown as { id: string }).id,
    (echoMessage('x', 'y') as unknown as { id: string }).id,
    '两次调用 id 不同（宿主靠它去重/定位）',
  )
  const long = echoMessage('sdo-board', 'x'.repeat(9000)) as unknown as { content: { text: string }[] }
  assert.ok((long.content[0]?.text.length ?? 0) < 4300, '回显必须有长度上限')
  assert.match(long.content[0]?.text ?? '', /回显已截断/u)
})

test('工具描述必须是中文（用户可见，不许残留英文说明）', async () => {
  const stub = new Proxy({}, { get: () => async () => 'ok' }) as never
  const tools = createOfficeTools(stub)
  assert.equal(tools.length, 20, '工具数量 = 设计 §9.1 的 19 个 + 语言切换 sdo_lang')
  const baseLocale = i18nLocalePeek()
  for (const tool of tools) {
    const text = String((tool as { description?: unknown }).description ?? '')
    // 描述必须**来自语言包**（而不是硬编码），这条与当前语言无关
    const packed = t(`tool.${tool.name}`, '')
    assert.equal(text, packed, `${tool.name} 的描述不是取自语言包`)
    if (baseLocale !== 'zh-CN') continue
    assert.match(text, /[\u4e00-\u9fff]/u, `${tool.name} 的描述缺少中文`)
    // 不得以英文句子为主（TELOS 这类专有名词允许，故按 ASCII 占比判定）
    const ascii = [...text].filter((ch) => ch.charCodeAt(0) < 128).length
    assert.ok(ascii / text.length < 0.5, `${tool.name} 的描述仍以英文为主：${text.slice(0, 40)}`)
  }
})

test('命令面覆盖设计 §9.2 的清单（这条会挡住"漏实现某个命令"，例如 sdo-init）', () => {
  // 依赖只在 handler 内被调用，因此用 Proxy 造桩即可
  const stub = new Proxy({}, { get: () => async () => 'ok' }) as never
  const commands = createOfficeCommands(stub)
  const names = commands.map((command) => command.name)

  // 设计 §9.2 的命令（D-01：冒号非法，`/sdo:new` → `sdo-init`）
  for (const required of [
    'sdo-init', // /sdo:new —— 初始化（曾经漏掉，导致用户无法用命令建项目）
    'sdo-status',
    'sdo-next',
    'sdo-board',
    'sdo-grill',
    'sdo-gate',
    'sdo-redteam',
    'sdo-render',
    'sdo-budget',
    // 增量 1/2：设计阶段的交互闭环（与 `sdo_design` 的五个动作一一对应）
    'sdo-design-grill',
    'sdo-design-answer',
    'sdo-design-confirm',
    'sdo-design-issues',
    'sdo-design-render',
  ]) {
    assert.ok(names.includes(required), `缺命令 ${required}（设计 §9.2 要求）`)
  }
  // 命令名必须符合 dsh 的命名规则（只能小写字母/数字/下划线/连字符）
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_-]*$/u, `命令名非法：${name}`)
  // 回显包装不得改变命令集
  assert.deepEqual(createOfficeCommands(stub, true).map((command) => command.name), names)
})

test('M6-02 文本看板：幂等（同状态两次逐字节相同）且含任务/迭代/门禁', () => {
  office.updateProject(call(), { scopeIn: ['对账'], scopeOut: ['自动调账'], metricsSuccess: ['识别率 ≥ 99%'], glossary: { 差异: '不一致' } })
  office.startIteration(call(), '最小闭环')
  office.planDecompose(call(), {
    suggestions: [{ title: '实现核心', dod: ['验收标准通过'], role: 'developer', writeScopes: ['src/core/'], size: 'small' }],
  })
  const model = () => {
    const status = office.status(call())
    return {
      project: status.project,
      config: status.config,
      counts: status.counts,
      gates: office.gatesFor(call()),
      requirements: office.boardRequirements(call()),
      process: office.process(call()),
      pendingGate: status.pendingGate,
      tasks: office.tasks(call()),
      iteration: office.iteration(call()),
      dataDirName: '.sdo',
      truncated: status.truncated,
    }
  }
  const first = renderBoard(model())
  const second = renderBoard(model())
  assert.equal(first, second, '看板必须幂等（同状态逐字节相同）')

  const withAll = renderBoard(model(), { all: true })
  assert.ok(withAll.length >= first.length)
  assert.match(first, /立项/u)
  assert.match(first, /门禁/u)
  assert.match(withAll, /TASK-001/u, '看板必须真的列出任务卡（不能只出现"迭代"二字就蒙过去）')
  assert.match(withAll, /实现工程师/u, '任务行里的角色要用中文')
  assert.match(withAll, /待派发|进行中|已完成/u, '任务行的状态要用中文')
  assert.equal(/\b(planned|in-progress|developer)\b/u.test(withAll), false, '看板不得出现英文状态码/角色码')
})

test('DEF 回归：callOf 必须从 agent.session.header.cwd 取工作目录', () => {
  // 真实形状：Agent 只有 session（其中 header.cwd 才是工作目录）
  const call = callOf({ agent: { id: 's1', session: { header: { cwd: '/tmp/ws-x' } } } } as never)
  assert.equal(call.cwd, '/tmp/ws-x', '读错字段会导致"无法确定本会话的工作区"')
  assert.equal(call.sessionId, 's1')
  // 没有工作目录时不得编造
  assert.equal(callOf({ agent: { id: 's1', session: {} } } as never).cwd, undefined)
})

test('守卫（DEF-03）：preset 新增插件行必须先登记（未登记的行会让整个 preset 注册失败）', () => {
  const preset = readFileSync(new URL('../../presets/sdo-office.patch.yml', import.meta.url), 'utf8')
  // **只扫真正的行，不扫注释**：注释里可以写到包名（例如"历史理由：不要引用 X"这类说明），
  // 被注释掉的行不会挂载，把它当"未登记的行"是误报。
  const rowLines = preset.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  const names = [...rowLines.join('\n').matchAll(/name:\s*'?([^'\s]+)'?/gu)].map((m) => m[1] as string).filter((name) => /^[@a-z]/.test(name))  // 只看包/分组行（排除 preset 显示名这类中文行）
  // 基线：这些行是 preset 从建立起就有、且真机会话里确实生效过的（fs/bash/ask/subagent/persona）。
  // 任何**新增**行都必须先在这里登记，并且先在真实 profile 里实测「能否选中该 preset」——
  // 解析失败的行会让整个 preset 注册失败（DEF-03：重启后选不到 sdo-office）。
  const baseline = new Set([
    'dsh-software-dev-office',
    'cordis:group',
    '@deepseek-ai/dsh-agent-preset',
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-ask-user',
    // 角色卡技能（B2）的加载器行。登记依据（三层，均可复跑）：
    //   ① 官方 standard/ptc/cordis 三个 preset 都挂这一行（`dsh-web-app/presets/*.patch.yml`）；
    //   ② 它在 harness 自己的"可安装插件包"清单里（`cordis-composition-reference/references/packages.md`
    //      第 402 行：Model-facing skill loading tool），且是 dsh 应用的依赖（与 `dsh-tool-fs` 同类）；
    //   ③ 从 cordis-plugin-loader 自身的解析基准 `createRequire(loader/lib/index.js)` 实测：
    //      `@deepseek-ai/dsh-tool-skill` 可解析（对照 `dsh-tool-fs`/`dsh-tool-bash`/`dsh-persona` 同样可解析，
    //      反证 `@deepseek-ai/dsh-tool-nonexistent` 解析失败）。
    '@deepseek-ai/dsh-tool-skill',
    // 搜索族与控制面（复审 22:48 审计出的同一根因：宿主 `disabled: true` 的行必须由 preset 补挂）。
    // 登记依据同上一行：官方 standard/ptc preset 都挂；同在 harness 可安装包清单与 dsh 应用依赖里；
    // 且以 cordis-plugin-loader 自身为基准 `createRequire(loader/lib/index.js)` 实测可解析
    // （含子路径 `@deepseek-ai/dsh-tool-subagent-control/list-agents`）。
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent-control/list-agents',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ])
  const unregistered = names.filter((name) => !baseline.has(name))
  assert.deepEqual(unregistered, [], `preset 新增了未登记的插件行：${unregistered.join(', ')}（加行前必须实测可解析）`)
  assert.ok(names.includes('dsh-software-dev-office'), 'preset 必须包含本插件行')
  // 顺带报告：这些行的真实解析情况（信息性输出，不影响结论）
  const require = createRequire(import.meta.url)
  const resolution = names.map((name) => {
    if (name === 'dsh-software-dev-office' || name.startsWith('cordis:')) return `${name}=own`
    try {
      require.resolve(name + '/package.json')
      return `${name}=ok`
    } catch {
      return `${name}=unresolved`
    }
  })
  console.log('preset 行解析情况: ' + resolution.join(' | '))
})

test('棘轮守卫：面向用户模块的硬编码中文不得增加（应逐步迁入 lang 文件）', () => {
  // 目标：所有面向用户的表述都来自 `src/data/lang/zh-CN.yml`。
  // 迁移是渐进的，因此这里用**棘轮**：只允许减少、不允许增加。
  // 余量说明：这些是**有意保留**的项 —— 作为"标识/数据位"使用的中文字面量
  // （例如动作分支值 `action === 'view' ? '查看' : '进入'`）。它们的翻译应走
  // `label()/idOf()` 这类标识翻译，而不是 `t()` 文案键。迁移已完成 396 → 15（−96%）。
  // **全部归零**：面向用户的表述一律来自 `src/data/lang/zh-CN.yml`。
  // 迁移历程：`396 → 15 → 0`；本轮新并入棘轮的三个模块（gates / plan / describe+index 余量）也已清零。
  // 期间修掉了扫描器的一个真 bug（正则体里的反引号被当成模板起点 → 幻影字面量，
  // 曾把 plan.ts 的真值 27 掩盖成 10，并让提取器把该文件改到编译不过）。
  // 教训：`scripts/extract-lang.mjs` 的扫描器仍有同源盲区，**不要**再用它处理含正则/模板的文件；
  // 迁移请用修好的 `src/domain/langScan.ts` 做计数，模板类文案手工做占位符映射（`${x}` → `{pN}` + `fmt`）。
  const baseline: Record<string, number> = {
    'src/interface/describe.ts': 0,
    'src/interface/inject.ts': 0,
    'src/board/render.ts': 0,
    'src/interface/commands.ts': 0,
    'src/index.ts': 0,
    'src/interface/tools.ts': 0,
    'src/domain/gates.ts': 0,
    'src/domain/plan.ts': 0,
    // 增量 1 新模块：设计交互闭环 / 界面视图 / 设计文档，文案一律走语言包（基线 0）
    'src/domain/design.ts': 0,
    // 增量 2：设计交互回执抽成独立模块（工具与命令共用），同样不允许硬编码文案
    'src/interface/designReceipt.ts': 0,
    // 增量 2：设计方法论方法包（选择解析 / 产物检查器 / 一致性检查），文案一律走语言包
    'src/domain/method.ts': 0,
    // 预算回执抽成独立模块（命令面与装配层共用，非法选择的拒绝文案也在其中）
    'src/interface/budgetReceipt.ts': 0,
    // 界面线框图 / PlantUML 骨架：只排版，文案一律由调用方（语言包）传入
    'src/domain/wireframe.ts': 0,
    // 完整 argv 解析器：纯结构化解析，不含任何面向用户的文案
    'src/interface/argv.ts': 0,
    // 增量 3：设计适用性声明 / 门禁签字（文案一律走语言包，棘轮基线 0）
    'src/domain/applicability.ts': 0,
    'src/domain/signature.ts': 0,
    // F-20：契约字段的 YAML 类型提示同样一律走语言包（新增模块也进棘轮，不留硬编码后门）
    'src/domain/contracts.ts': 0,
    'src/infra/scalar.ts': 0,
    // F-21：手写 YAML 的形状提示（容器族 / `dropped` 非布尔）同样一律走语言包
    'src/domain/shapeNotes.ts': 0,
  }

  const root = fileURLToPath(new URL('../../', import.meta.url))
  const regressed: string[] = []
  for (const [file, allowed] of Object.entries(baseline)) {
    const text = readFileSync(join(root, file), 'utf8')
    const count = countCjkLiterals(text)
    if (count > allowed) regressed.push(`${file}: ${count} > ${allowed}`)
  }
  assert.deepEqual(regressed, [], `这些模块新增了硬编码中文，请改为 lang 文件里的键：${regressed.join('; ')}`)
})

test('lang 守卫：语言包可解析、代码引用到的键都有中文值', () => {
  // ① 关键节必须取到中文（取不到时 t() 会返回"键的后半段"，据此判定）
  for (const key of ['gate.G1', 'status.title', 'command.sdo-status', 'param.ids', 'tool.sdo_status', 'dimension.data', 'redteam.proposeHeader']) {
    const value = t(key)
    assert.notEqual(value, key.split('.').slice(1).join('.'), `语言包缺键或被解析器吃掉：${key}`)
    assert.ok(value.length > 0, `语言包键为空：${key}`)
  }
  // ② 扫描源码里所有 t('…') 引用，逐个校验键存在（防止"删了兜底却忘了加键"，也防止 YAML 结构写坏）
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files = readdirSync(join(root, 'src'), { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(root, 'src', entry))
  const referenced = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/gu)) referenced.add(match[1] as string)
  }
  const missing = [...referenced].filter((key) => {
    const id = key.split('.').slice(1).join('.')
    return t(key) === id
  })
  assert.deepEqual(missing, [], `这些键在 zh-CN.yml 里没有中文值：${missing.join(', ')}`)
})

test('方案 D 前提：plan-mode 的 section 必须非空（空配置会让装载在子 fiber 静默失败）', async () => {
  const planMode = await import('@deepseek-ai/dsh-plan-mode')
  assert.throws(
    () => planMode.resolveConfig({ section: '' }),
    /non-empty/u,
    '空 section 会抛错——而错误只落在子 fiber，try/catch 抓不到，服务因此永不注册',
  )
  const text = t('planMode.section')
  // 关键：必须是 lang 里的**真值**，而不是 t() 兜底返回的键名（否则假绿）
  assert.notEqual(text, 'section', 'lang 缺 planMode.section 时会兜底返回键名，测试必须识破')
  assert.ok(text.length > 0, 'lang 里的 planMode.section 不能为空')
  assert.doesNotThrow(() => planMode.resolveConfig({ section: text }), 'SDO 传入的 section 必须能通过校验')
})

test('planMode.section 必须包含结构化计划要求（否则计划只有一句话）', () => {
  const text = t('planMode.section')
  assert.notEqual(text, 'section', 'lang 缺键会兜底返回键名')
  for (const must of ['备选方案', '视图', '契约', '追溯', '风险', '任务拆分', '测试计划', 'exit_plan_mode']) {
    assert.ok(text.includes(must), `plan 规则缺少要求：${must}`)
  }
  const receipt = t('uiIndex.planChecklist')
  assert.ok(receipt.length > 80, '进入 plan mode 的回执应带完整清单')
})

test('i18n：语言可选（基准 zh-CN / en）、en 覆盖全部键且无中文、未知语言回落基准', async () => {
  const i18n = await import('../src/domain/i18n.js')
  const { loadPackagedYaml } = await import('../src/infra/data.js')
  type Pack = Record<string, unknown>
  const zh = loadPackagedYaml<Pack>('src/data/lang/zh-CN.yml')
  const en = loadPackagedYaml<Pack>('src/data/lang/en.yml')

  // ① en 必须**逐键覆盖**基准语言：不允许靠回退中文来"看起来有英文"（否则半翻译会被假绿放过）
  const missing: string[] = []
  for (const [section, table] of Object.entries(zh)) {
    if (section === 'locale' || typeof table !== 'object' || table === null) continue
    for (const key of Object.keys(table as Record<string, string>)) {
      const hit = (en[section] as Record<string, string> | undefined)?.[key]
      if (hit === undefined || hit.trim() === '') missing.push(`${section}.${key}`)
    }
  }
  assert.deepEqual(missing, [], `en.yml 缺这些键：${missing.slice(0, 8).join(', ')}`)

  // ② en 里不得残留中文（"翻了但没翻干净"必须变红）
  const cjk = /[\u4e00-\u9fff]/u
  const dirty: string[] = []
  for (const [section, table] of Object.entries(en)) {
    if (section === 'locale' || typeof table !== 'object' || table === null) continue
    for (const [key, value] of Object.entries(table as Record<string, string>)) {
      if (cjk.test(String(value))) dirty.push(`${section}.${key}`)
    }
  }
  assert.deepEqual(dirty, [], `en.yml 里仍有中文：${dirty.slice(0, 8).join(', ')}`)
  assert.equal(en['locale'], 'en')

  // ③ 切到 en：取文是英文；切到未知语言：回落基准（不出现空白/键名）
  try {
    i18n.setLocale('en')
    assert.equal(i18n.locale(), 'en')
    assert.match(i18n.t('gate.G0'), /Intake Gate/)
    assert.match(i18n.t('status.title'), /Software Dev Office/)
    i18n.setLocale('zz-XX')
    assert.equal(i18n.locale(), 'zh-CN', '未知语言必须回落基准语言')
    assert.equal(i18n.t('gate.G0'), '立项门禁')
  } finally {
    i18n.setLocale('zh-CN')
  }
  assert.equal(i18n.locale(), 'zh-CN')
})

test('i18n：显示层在非基准语言下优先语言包（阶段名/判据描述不再半中半英）', async () => {
  const i18n = await import('../src/domain/i18n.js')
  try {
    // 基准语言：流程数据优先（允许项目自定义措辞）
    i18n.setLocale('zh-CN')
    assert.equal(i18n.phaseText('architecture', '架构（自定义措辞）'), '架构（自定义措辞）')
    // 非基准语言：语言包优先，否则英文界面会配中文的阶段名与判据描述
    i18n.setLocale('en')
    assert.equal(i18n.phaseText('architecture', '架构'), 'Architecture')
    // 断言"语言包优先"这件事本身，**不钉死措辞** —— C-20 的描述已随实现改口径
    // （N-12：实现按"声明要做的视图"执法，不再只认五视图），钉死字符串会让文案改进变成假红。
    const c20 = i18n.textOrProcess('criterion.C-20', '五视图齐备')
    assert.equal(c20, i18n.t('criterion.C-20'), '非基准语言下必须优先语言包')
    assert.notEqual(c20, '五视图齐备', '不得回落中文流程数据')
    assert.match(c20, /five views/iu, `英文判据描述必须真的讲清口径：${c20}`)
    // 语言包里没有的键仍回落流程数据（不出现空白）
    assert.equal(i18n.textOrProcess('criterion.NOT-A-KEY', '数据里的兜底文案'), '数据里的兜底文案')
  } finally {
    i18n.setLocale('zh-CN')
  }
})

test('语言可切换（用户路径）：/sdo-lang 命令与 sdo_lang 工具必须存在，且切换后取文变英文', async () => {
  // ① 命令面：注册了 sdo-lang（交互式会话里用户可直接敲）
  const { createOfficeCommands } = await import('../src/interface/commands.js')
  const stub = new Proxy({}, { get: () => async () => 'stub' }) as never
  const names = createOfficeCommands(stub, false).map((command) => command.name)
  assert.ok(names.includes('sdo-lang'), `命令面缺少 sdo-lang：${names.join(',')}`)

  // ② 工具面：注册了 sdo_lang（聊天里让模型调用）
  const { createOfficeTools } = await import('../src/interface/tools.js')
  const toolNames = createOfficeTools(stub).map((tool) => tool.name)
  assert.ok(toolNames.includes('sdo_lang'), `工具面缺少 sdo_lang：${toolNames.filter((n) => n.startsWith('sdo_')).join(',')}`)

  // ③ 语言包里有它的文案（否则用户看到的是键名）
  const i18n = await import('../src/domain/i18n.js')
  assert.notEqual(i18n.t('command.sdo-lang'), 'sdo-lang')
  assert.notEqual(i18n.t('tool.sdo_lang'), 'sdo_lang')
  assert.notEqual(i18n.t('uiLang.current'), 'uiLang.current'.split('.').pop())
  i18n.setLocale('en')
  assert.notEqual(i18n.t('tool.sdo_lang'), 'sdo_lang', '英文包也必须覆盖新键')
  i18n.setLocale('zh-CN')
})

test('G-07 变体：注入路径必须能从宿主给的 scope 解析出工作区（scope 就是 agent 对象）', async () => {
  const { resolveScopeCall } = await import('../src/interface/scope.js')
  const sessions: Record<string, string> = { 'session-abc': '/w/from-sessions' }
  const sources = {
    fromMap: (id: string) => (id === 'session-mapped' ? { sessionId: id } : {}),
    fromSessions: (id: string) => sessions[id],
  }
  // ① 真机形态：scope 是 agent 本身（dsh 用 scopeTarget(agent, agent) 建键）——必须直接读到 cwd
  assert.equal(resolveScopeCall({ session: { header: { cwd: '/w/project' } } }, sources).cwd, '/w/project')
  // ② 形态：带上会话 id 的 agent（两者都要拿到）
  assert.deepEqual(
    resolveScopeCall({ id: 'session-abc', session: { id: 'session-abc', header: { cwd: '/w/project' } } }, sources),
    { sessionId: 'session-abc', cwd: '/w/project' },
  )
  // ③ 形态：裸 id 字符串（有些宿主这么传）→ 走本插件会话表
  assert.deepEqual(resolveScopeCall('session-mapped', sources), { sessionId: 'session-mapped' })
  // ④ 形态：裸 id 字符串 → 本插件表没有时问宿主 sessions 服务
  assert.deepEqual(resolveScopeCall('session-abc', sources), { sessionId: 'session-abc', cwd: '/w/from-sessions' })
  // ⑤ 都解析不出来：诚实降级为空（绝不猜别的项目）
  assert.deepEqual(resolveScopeCall({}, sources), {})
  assert.deepEqual(resolveScopeCall(undefined, sources), {})
})

test('G-08：语言包覆盖率必须与基准键同口径（不出现 980/951 这种读数）', async () => {
  const i18n = await import('../src/domain/i18n.js')
  try {
    i18n.setLocale('en')
    const covered = i18n.coveredBaseKeys()
    const total = i18n.baseKeyCount()
    assert.ok(covered <= total, `覆盖数 ${covered} 不得超过基准键总数 ${total}`)
    assert.ok(covered > 0, '英文包必须覆盖大部分基准键')
    assert.ok(i18n.extraKeys() > 0, '英文包带专属键（criterion.C-xx）——回执要如实说明')
  } finally {
    i18n.setLocale('zh-CN')
  }
  assert.equal(i18n.coveredBaseKeys(), i18n.baseKeyCount(), '基准语言下覆盖率恒为 100%')
})
