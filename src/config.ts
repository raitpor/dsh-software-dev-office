/**
 * 配置：**插件行配置**（preset 里 `config.plugins[].config`）与**项目级配置**（`.sdo/config.yml`）。
 *
 * 设计对应：§11.2（结构配置，预设行整体替换语义）、§7.5（规模与裁剪）、§10.6（预算，M5）。
 *
 * 纪律：
 *   · 插件行配置每个字段都有默认值，因此 `apply` 拿到的配置永远完整；
 *   · 项目级配置由**人在项目里编辑**，读失败一律回落到默认值并给出原因（不静默丢配置）。
 */
import z from '@deepseek-ai/schemastery'

import { SCALES } from './types.js'
import type { Scale } from './types.js'
import { SdoStore } from './infra/store.js'

/** 插件行的结构配置。 */
export interface SdoConfig {
  /** 项目数据目录名，相对会话工作目录；默认 `.sdo` */
  projectDir: string
  /** 状态块在系统提示里的排序位 */
  promptOrder: number
  /** 是否每轮注入状态块 */
  injectStatus: boolean
  /** 状态块字符上限（超出则截断） */
  statusChars: number
  /**
   * 界面语言：语言包文件名（不含 `.yml`），随包提供 `zh-CN`（基准，永远完整）与 `en`。
   * 规则：**基准语言是回退链的末端** —— 目标语言缺某个键时回落显示基准文案，
   * 因此新增/补译语言包不会出现空白或键名。未知语言一律回落到基准语言。
   */
  lang: string
  /**
   * 阶段纪律级别（设计 §9.4）：
   * `suggest`=只提示（L1）；`enforce`=门禁 + 工具前置（L2，默认）；`strict`=L2 + 拦截写类工具（L3）
   */
  gateLevel: 'suggest' | 'enforce' | 'strict'
  /**
   * **受写入范围纪律管辖的工具**（`domain/writeScope.ts`）。
   *
   * 带路径参数的（`write`/`edit`）会**逐路径**核对本卡的 `writeScopes`；
   * 不带路径参数的（`bash`）**没有路径可判** ⇒ 纪律只能如实标 `checked: false`，
   * 越界写仍由 `done` 时的 A2 写范围对账兜底（**不许假装拦住了**）。
   * （2026-10-08 之前这个字段**没人读**，是死配置。）
   */
  disciplineTools: string[]
  /**
   * **公共放行面**（相对路径前缀）：这些位置**不受卡级 `writeScopes` 约束**。
   *
   * 默认 `.sdo/`（台账，由 SDO 工具自己落 —— SDO-34）、`docs/`（派生文档）、
   * `test/`（用例是跨卡共用面）。卡写范围只管产品文件（`src/`、`lib/` 之类）。
   * （2026-10-08 之前这个字段**没人读**，是死配置。）
   */
  disciplineAllowPaths: string[]
  registerTools: boolean
  registerCommands: boolean
  /** 编排后端；Q-09 结论：每个 preset 只能选一种，不得混用 */
  orchestrator: 'subagent' | 'native-team' | 'inline'
  /** 并行派发上限（派发前的自我容量预算；`maxActiveSubagents` 默认 8） */
  maxParallelDispatch: number
  /**
   * **未结算派发的孤儿 TTL（分钟）**：`dispatch/started` 之后迟迟没有 `dispatch/finished`
   * （子会话被强杀、宿主重启、派发丢了）时，超过这个时长就**不再占用池位**（并如实标注"已超时"）。
   *
   * 为什么需要它（真机缺陷）：池状态从台账现算，没有回收 ⇒ 历史僵尸派发会把池永久占满，
   * 「空闲可复用」恒为 0、真复用永不发生、池满的卡只排队不放行。真机实测 developer 池被 5 笔
   * 跨了两天重启的未结算派发占满（上限 4）。
   *
   * 代价如实说：这是**启发式**（真跑超过这个时长的子代理会被误判），所以① 可配、② 回执里点名 TTL，
   * ③ 被误判者只影响"占位"，**不会**被复用（它们不进"空闲可复用"清单）。
   */
  dispatchOrphanTtlMinutes: number
  /**
   * **按角色的子代理池上限**（子代理复用）：`{ developer: 2, tester: 1 }`。
   * 没写的角色用 `maxParallelDispatch`（⇒ 默认行为不变：不额外收紧）。
   * 池满的卡**排队**（不丢），等池里有子代理结算后由下一次派发放行。
   */
  poolCaps: Record<string, number>
  /** 是否采集 `workspace/changes` 证据（M4 起生效） */
  captureWorkspaceChanges: boolean
  /**
   * **B6：是否对"认得出的派发角色"硬拦掩码之外的调用**（默认开）。
   * 关掉它只是不拦，回执与派发请求里的掩码**照旧声明**（声明与执行分开）。
   */
  enforceRoleMask: boolean
  /** 真派发用的 provider 名（宿主 `subagents.list()` 里的名字；preset 默认装 `spawn`）。 */
  dispatchProvider: string
  /** 派发深度上限（子代理不应再开子代理 ⇒ 默认 1）。 */
  dispatchMaxDepth: number
  /**
   * 斜杠命令结果如何回显（设计 §9.2：命令 handler 针对 agent 运行、**不产生模型消息**，
   * 但结果**要让用户感知**——这个"感知"由命令结果本身承担，不该靠额外产生一轮模型消息来补）：
   *   · `echo`（**默认**）—— 把命令结果投递成一条用户可见消息：
   *     优先 `agent.inbox.send(msg, 'next-step', false)`（**不唤醒轮次**），退而 `agent.followup()`。
   *     **实测可用**：会话 `session-ccda9900` 里 3 条命令各产生一条 `agent/inbox/spliced` 事件
   *     （seq 5 / 11 / 283），界面正常渲染、不触发模型回复。
   *   · `none` —— 只回命令面（设计 §9.2 的原始语义）。Web 客户端仍不渲染"轮次之外"的命令节点，
   *     因此设 `none` 时命令结果在界面上看不到（上游问题见 `docs/verification/`）。
   * 环境变量 `SDO_COMMAND_ECHO=followup|none` 可覆盖，免得为此重写整个 preset 行。
   */
  commandEcho: 'none' | 'echo'
  board: {
    text: boolean
    panel: boolean
  }
  cost: {
    enabled: boolean
    /** 跨阈值档时是否询问用户（Q-13/Q-19）；默认 true */
    warnOnBudget: boolean
    /** 单价表：`<provider>/<model>` → 每 `perTokens` 个 token 的价格（用户手填） */
    prices: Record<string, number>
    currency: string
    perTokens: number
    /** 阈值档位（百分比），每档只问一次 */
    tiers: number[]
  }
}

/** 配置 schema：所有字段都有默认值。 */
export const Config: z<SdoConfig> = z.object({
  projectDir: z.string().default('.sdo'),
  promptOrder: z.number().default(240),
  injectStatus: z.boolean().default(true),
  statusChars: z.natural().min(200).max(4000).default(1500),
  lang: z.string().default('zh-CN'),
  gateLevel: z.union([z.const('suggest'), z.const('enforce'), z.const('strict')]).default('enforce'),
  disciplineTools: z.array(z.string()).default(['write', 'edit', 'bash']),
  disciplineAllowPaths: z.array(z.string()).default(['.sdo/', 'docs/', 'test/']),
  registerTools: z.boolean().default(true),
  registerCommands: z.boolean().default(true),
  orchestrator: z.union([z.const('subagent'), z.const('native-team'), z.const('inline')]).default('subagent'),
  maxParallelDispatch: z.natural().min(1).max(8).default(4),
  poolCaps: z.dict(z.natural().min(1).max(8)).default({}),
  dispatchOrphanTtlMinutes: z.natural().min(1).max(1440).default(60),
  captureWorkspaceChanges: z.boolean().default(true),
  enforceRoleMask: z.boolean().default(true),
  dispatchProvider: z.string().default('spawn'),
  dispatchMaxDepth: z.number().min(0).max(4).default(1),
  commandEcho: z.union([z.const('none'), z.const('echo')]).default('echo'),
  board: z.object({
    text: z.boolean().default(true),
    panel: z.boolean().default(false),
  }),
  cost: z.object({
    enabled: z.boolean().default(true),
    warnOnBudget: z.boolean().default(true),
    prices: z.dict(z.number()).default({}),
    currency: z.string().default('CNY'),
    perTokens: z.natural().min(1).default(1_000_000),
    tiers: z.array(z.number()).default([50, 80, 100]),
  }),
})

/** 归一化后的设置。 */
export interface Settings extends Omit<SdoConfig, 'projectDir'> {
  /** `.sdo` 目录名（去掉 `./` 前缀与结尾斜杠） */
  projectDirName: string
}

/** 归一化插件配置（去噪，保证后续逻辑无需再判断）。 */
export function resolveSettings(config: SdoConfig): Settings {
  const cleaned = config.projectDir.replace(/^\.\//, '').replace(/[/\\]+$/, '').trim()
  const { projectDir: _raw, ...rest } = config
  // 环境变量优先于配置：SDO_COMMAND_ECHO=followup|none
  const env = process.env['SDO_COMMAND_ECHO']
  // `followup` 作为等价写法一并接受：本插件的开发环境里可能残留旧值（未发布，不留兼容承诺）
  const commandEcho: 'none' | 'echo' =
    env === 'none' ? 'none' : env === 'echo' || env === 'followup' ? 'echo' : rest.commandEcho
  return { ...rest, commandEcho, projectDirName: cleaned === '' ? '.sdo' : cleaned }
}

/**
 * 项目级配置（`.sdo/config.yml`）——人在项目里维护。
 * 只放"项目级"的东西：流程与规模、红队默认、看板窗口；预算/单价表在 M5 追加。
 * （结构配置留在 preset 行，见设计 §11.2 的分工表。）
 */
export interface ProjectConfig {
  /** 流程：waterfall | prototype | agile */
  process: string
  scale: Scale
  /** 红队默认策略：auto 按规模档决定；on/off 强制 */
  redTeam: 'auto' | 'on' | 'off'
  board: {
    /** 看板投影保留的已完成条目数（Q-12） */
    window: number
  }
  /** 快速原型：原型目录与「可丢弃」标记（Q-05 / 设计 §7.2） */
  prototype: {
    dir: string
    throwaway: boolean
  }
}

/** 默认项目配置。 */
export function defaultProjectConfig(): ProjectConfig {
  return {
    process: 'waterfall',
    scale: 'normal',
    redTeam: 'auto',
    board: { window: 10 },
    prototype: { dir: 'prototype', throwaway: false },
  }
}

/** 读取项目配置；缺失或损坏时回落默认值，并说明原因。 */
export function readProjectConfig(store: SdoStore): { config: ProjectConfig; source: 'file' | 'default' } {
  const defaults = defaultProjectConfig()
  const raw = store.readYaml<Partial<ProjectConfig>>('config.yml')
  if (raw === undefined) return { config: defaults, source: 'default' }
  const config: ProjectConfig = {
    process: typeof raw.process === 'string' && raw.process !== '' ? raw.process : defaults.process,
    scale: SCALES.includes(raw.scale as Scale) ? (raw.scale as Scale) : defaults.scale,
    redTeam: raw.redTeam === 'on' || raw.redTeam === 'off' ? raw.redTeam : defaults.redTeam,
    board: {
      window:
        typeof raw.board?.window === 'number' && raw.board.window > 0
          ? Math.floor(raw.board.window)
          : defaults.board.window,
    },
    prototype: {
      dir:
        typeof raw.prototype?.dir === 'string' && raw.prototype.dir.trim() !== ''
          ? raw.prototype.dir.trim()
          : defaults.prototype.dir,
      throwaway: raw.prototype?.throwaway === true,
    },
  }
  return { config, source: 'file' }
}

/** 写入项目配置（人在项目里编辑；SDO 只在初始化与人类命令时写）。 */
export function writeProjectConfig(store: SdoStore, config: ProjectConfig): string {
  return store.writeYaml(['config.yml'], config)
}
