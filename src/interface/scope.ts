/**
 * 从宿主给的 `scope` 解析出「本会话工作区」。
 *
 * **真机教训**：`systemPrompt.context({ text })` 的回调只拿到 `AssembleContext.scope`，而它是
 * `@deepseek-ai/dsh-scope` 的 `ScopeKey`（`type ScopeKey = object`）。`dsh-agent` 用
 * `scopeTarget(agent, agent)` 建键 —— **键就是 agent 对象本身**。因此旧实现里
 * `String(scope)` 得到 `"[object Object]"`，与 `session/created` 记下的会话 id 永不相等 →
 * 作用域定位失败 → 注入块报"工作区未能确定"，而同一轮的工具调用却能正常读出项目
 * （工具路径有 `agent.session.header.cwd`）。
 *
 * 解析顺序（全部失败就**诚实降级**为空 call，绝不猜别的项目）：
 *   1. scope 自身就是 agent（鸭子类型 `session.header.cwd`）；
 *   2. scope 是字符串/数字（某些宿主传裸 id）；
 *   3. scope 上的 `sessionId` / `id` / `session.id` 候选；
 *   4. 每个候选 id 依次问：本插件的会话表 → 宿主 sessions 服务。
 */
import type { OfficeCall } from '../office.js'

export interface ScopeSources {
  /** 本插件记下的 会话 id → 工作目录（`session/created` 时登记）。 */
  fromMap(id: string): OfficeCall
  /** 宿主 sessions 服务：按 id 取会话，读 `header.cwd`。 */
  fromSessions(id: string): string | undefined
}

function cwdOfAgentLike(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const holder = value as { session?: { header?: { cwd?: unknown } } }
  const cwd = holder.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function candidateIds(scope: unknown): string[] {
  const ids: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value !== '' && !ids.includes(value)) ids.push(value)
  }
  push(scope)
  if (typeof scope === 'object' && scope !== null) {
    const holder = scope as { sessionId?: unknown; id?: unknown; session?: { id?: unknown } }
    push(holder.sessionId)
    push(holder.id)
    push(holder.session?.id)
  }
  return ids
}

export function resolveScopeCall(scope: unknown, sources: ScopeSources): OfficeCall {
  // ① scope 即 agent（dsh 的 ScopeKey 就是 agent 对象）
  const direct = cwdOfAgentLike(scope)
  const sessionId = candidateIds(scope)[0]
  if (direct !== undefined) return sessionId === undefined ? { cwd: direct } : { sessionId, cwd: direct }
  if (scope === undefined || scope === null) return {}
  // ②③④ 候选 id：先查本插件会话表，再问宿主 sessions 服务
  for (const id of candidateIds(scope)) {
    const mapped = sources.fromMap(id)
    if (mapped.sessionId !== undefined) return mapped
    const cwd = sources.fromSessions(id)
    if (cwd !== undefined) return { sessionId: id, cwd }
  }
  return sessionId === undefined ? {} : { sessionId }
}
