/**
 * 接口契约（Schema-first，设计 §6.4）。
 *
 * 纪律：
 *   · 每个**跨组件交互**都要有契约——G4 的 `design.contracts` 准则按组件视图的依赖边逐条核对；
 *   · 契约必须写清**失败语义**（超时 / 重试 / 幂等），否则"对接好了"只是乐观假设。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Contract } from '../types.js'
import { componentEdges } from './architecture.js'

export function listContractIds(store: SdoStore): string[] {
  return store
    .listNames('contracts')
    .filter((name) => /^CT-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readContract(store: SdoStore, id: string): Contract | undefined {
  return store.readYaml<{ contract: Contract }>('contracts', `${id}.yml`)?.contract
}

export function listContracts(store: SdoStore): Contract[] {
  const out: Contract[] = []
  for (const id of listContractIds(store)) {
    const contract = readContract(store, id)
    if (contract !== undefined) out.push(contract)
  }
  return out
}

export function writeContract(store: SdoStore, contract: Contract): void {
  store.writeYaml(['contracts', `${contract.id}.yml`], { contract })
}

export interface RecordContractInput {
  name: string
  kind?: Contract['kind'] | undefined
  /** 给了 id 则原地更新（D4-3） */
  id?: string | undefined
  producer: string
  consumer: string
  schema: string
  failureSemantics?: Partial<Contract['failureSemantics']> | undefined
}

/** 记录一份契约。 */
/** 作废一份契约（**回收路径**）：加 `dropped` 标记并留痕，不删除记录（追加式真源）。 */
export function dropContract(store: SdoStore, journal: Journal, contractId: string, reason: string): Contract | undefined {
  const existing = listContracts(store).find((item) => item.id === contractId)
  if (existing === undefined) return undefined
  const dropped: Contract = { ...existing, dropped: true, droppedReason: reason }
  writeContract(store, dropped)
  journal.append('contract/dropped', { id: contractId, reason })
  return dropped
}

export function recordContract(store: SdoStore, journal: Journal, input: RecordContractInput): Contract {
  // D4-3：给了 id 就**原地更新**（否则错记录会永久留存：传 id=CT-001 却新建 CT-010）
  const existing = input.id === undefined ? undefined : listContracts(store).find((item) => item.id === input.id)
  const contract: Contract = {
    id: existing?.id ?? nextId('CT', listContractIds(store)),
    name: input.name,
    kind: input.kind ?? 'schema',
    producer: input.producer,
    consumer: input.consumer,
    schema: input.schema,
    failureSemantics: {
      timeout: input.failureSemantics?.timeout ?? '',
      retry: input.failureSemantics?.retry ?? '',
      idempotency: input.failureSemantics?.idempotency ?? '',
    },
    at: new Date().toISOString(),
  }
  writeContract(store, contract)
  journal.append(existing === undefined ? 'contract/recorded' : 'contract/updated', {
    id: contract.id,
    name: contract.name,
    producer: contract.producer,
    consumer: contract.consumer,
  })
  return contract
}

/** 契约完整性：组件视图的每条依赖边都要有对应契约（producer/consumer 对得上）。 */
export function contractCoverage(store: SdoStore): {
  ok: boolean
  totalEdges: number
  covered: number
  missing: { consumer: string; producer: string }[]
  incompleteSemantics: string[]
} {
  // 已作废的契约不参与覆盖判定（否则作废后仍算"已覆盖"，等于没作废）
  const contracts = listContracts(store).filter((contract) => contract.dropped !== true)
  const edges = componentEdges(store)
  const missing = edges.filter(
    (edge) =>
      !contracts.some(
        (contract) =>
          (contract.consumer === edge.consumer && contract.producer === edge.producer) ||
          (contract.consumer === edge.consumer && contract.name.includes(edge.producer)),
      ),
  )
  const incompleteSemantics = contracts.filter((contract) => contract.dropped !== true)
    .filter(
      (contract) =>
        contract.failureSemantics.timeout.trim() === '' ||
        contract.failureSemantics.retry.trim() === '' ||
        contract.failureSemantics.idempotency.trim() === '',
    )
    .map((contract) => contract.id)
  return {
    ok: edges.length > 0 && missing.length === 0 && incompleteSemantics.length === 0,
    totalEdges: edges.length,
    covered: edges.length - missing.length,
    missing,
    incompleteSemantics,
  }
}
