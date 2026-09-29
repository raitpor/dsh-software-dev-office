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
   * 阶段纪律级别（设计 §9.4）：
   * `suggest`=只提示（L1）；`enforce`=门禁 + 工具前置（L2，默认）；`strict`=L2 + 拦截写类工具（L3）
   */
  gateLevel: 'suggest' | 'enforce' | 'strict'
  /** L3 拦截的工具名（仅 `gateLevel: strict` 生效） */
  disciplineTools: string[]
  /** L3 允许写入的相对路径前缀（放行白名单） */
  disciplineAllowPaths: string[]
  registerTools: boolean
  registerCommands: boolean
  /** 编排后端；Q-09 结论：每个 preset 只能选一种，不得混用 */
  orchestrator: 'subagent' | 'native-team' | 'inline'
  /** 并行派发上限（派发前的自我容量预算；`maxActiveSubagents` 默认 8） */
  maxParallelDispatch: number
  /** 是否采集 `workspace/changes` 证据（M4 起生效） */
  captureWorkspaceChanges: boolean
  board: {
    text: boolean
    panel: boolean
  }
  cost: {
    enabled: boolean
    /** 跨阈值档时是否询问用户（Q-13/Q-19）；默认 true */
    warnOnBudget: boolean
  }
}

/** 配置 schema：所有字段都有默认值。 */
export const Config: z<SdoConfig> = z.object({
  projectDir: z.string().default('.sdo'),
  promptOrder: z.number().default(240),
  injectStatus: z.boolean().default(true),
  statusChars: z.natural().min(200).max(4000).default(1500),
  gateLevel: z.union([z.const('suggest'), z.const('enforce'), z.const('strict')]).default('enforce'),
  disciplineTools: z.array(z.string()).default(['write', 'edit', 'bash']),
  disciplineAllowPaths: z.array(z.string()).default(['.sdo/', 'docs/', 'test/']),
  registerTools: z.boolean().default(true),
  registerCommands: z.boolean().default(true),
  orchestrator: z.union([z.const('subagent'), z.const('native-team'), z.const('inline')]).default('subagent'),
  maxParallelDispatch: z.natural().min(1).max(8).default(4),
  captureWorkspaceChanges: z.boolean().default(true),
  board: z.object({
    text: z.boolean().default(true),
    panel: z.boolean().default(false),
  }),
  cost: z.object({
    enabled: z.boolean().default(true),
    warnOnBudget: z.boolean().default(true),
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
  return { ...rest, projectDirName: cleaned === '' ? '.sdo' : cleaned }
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
