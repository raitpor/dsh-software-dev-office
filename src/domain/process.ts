/**
 * 流程引擎：读流程数据、在阶段/门禁图上导航。
 *
 * 设计对应：§7.1（流程即数据）、§7.3/§7.4（门禁判定与阶段历史）。
 * **流程是纯数据**（`src/data/processes/*.yml`）：新增流程只要加一个文件，
 * 本模块通过目录列举发现它，不改代码（NFR-005）。
 */
import { listPackagedNames, loadPackagedYaml } from '../infra/data.js'
import type { GateDef, PhaseDef, ProcessDef } from '../types.js'

const PROCESS_DIR = 'src/data/processes'

/** 列出随包流程 id（按文件名字典序）。 */
export function listProcessIds(): string[] {
  return listPackagedNames(PROCESS_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/** 读取一个流程定义；不存在返回 undefined。 */
export function loadProcess(id: string): ProcessDef | undefined {
  if (!listProcessIds().includes(id)) return undefined
  const process = loadPackagedYaml<ProcessDef>(`${PROCESS_DIR}/${id}.yml`)
  if (!Array.isArray(process.phases) || process.phases.length === 0) return undefined
  return process
}

/** 读取全部流程定义。 */
export function loadAllProcesses(): ProcessDef[] {
  return listProcessIds()
    .map((id) => loadProcess(id))
    .filter((process): process is ProcessDef => process !== undefined)
}

/** 取阶段定义。 */
export function phaseDef(process: ProcessDef, phase: string): PhaseDef | undefined {
  return process.phases.find((item) => item.id === phase)
}

/** 阶段展示名（数据里没写就退回 id）。 */
export function phaseLabel(process: ProcessDef, phase: string): string {
  return phaseDef(process, phase)?.name ?? phase
}

/** 阶段在流程里的序号（不存在返回 -1）。 */
export function phaseIndex(process: ProcessDef, phase: string): number {
  return process.phases.findIndex((item) => item.id === phase)
}

/** 下一个阶段（末尾返回 undefined）。 */
export function nextPhase(process: ProcessDef, phase: string): PhaseDef | undefined {
  const index = phaseIndex(process, phase)
  return index < 0 ? undefined : process.phases[index + 1]
}

/** 该阶段的**出口**门禁（可多个）。 */
export function exitGates(process: ProcessDef, phase: string): string[] {
  return phaseDef(process, phase)?.exit ?? []
}

/** 该阶段的**入口**门禁。 */
export function entryGates(process: ProcessDef, phase: string): string[] {
  return phaseDef(process, phase)?.entry ?? []
}

/** 当前阶段**待判定**的门禁 = 出口门禁里第一个尚未通过的（由调用方给出已通过集合）。 */
export function pendingGate(process: ProcessDef, phase: string, satisfied: Iterable<string>): string | undefined {
  const done = new Set(satisfied)
  return exitGates(process, phase).find((gate) => !done.has(gate))
}

/** 取门禁定义。 */
export function gateDef(process: ProcessDef, gateId: string): GateDef | undefined {
  return process.gates.find((gate) => gate.id === gateId)
}

/** 该门禁属于哪个阶段的出口（找不到返回 undefined）。 */
export function gatePhase(process: ProcessDef, gateId: string): string | undefined {
  return process.phases.find((phase) => phase.exit.includes(gateId))?.id
}
