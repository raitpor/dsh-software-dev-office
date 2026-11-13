import { rowHash } from './canonical.js';
import type { Event, FoldWorking, InputEdge, Row, TableName } from './types.js';

/**
 * docs/03:77：assumption 的 `inputs[]` 边按 hash 失效传播——不按事件类型枚举（枚举必漏）。
 * 任一 input 行的当前 hash 与边上的 hash 不等 ⇒ 落一次 assumption.invalidated 的效果，
 * 幂等键 `(spec_id, input_id, 旧 hash)`；回 open 后按新 hash 重建边。
 */
export function propagateInvalidations(state: FoldWorking, event: Event): void {
  for (const owner of Object.keys(state.inputs).sort()) {
    const spec = state.tables.spec[owner];
    if (spec === undefined || spec['kind'] !== 'assumption') {
      continue;
    }
    const rebuilt: InputEdge[] = [];
    let invalidated = false;
    for (const edge of state.inputs[owner] ?? []) {
      const table = state.tables[edge.kind as TableName];
      const target: Row | undefined = table?.[edge.id];
      if (target === undefined) {
        rebuilt.push(edge);
        continue;
      }
      const current = rowHash(target);
      if (current === edge.hash) {
        rebuilt.push(edge);
        continue;
      }
      const key = `${owner}|${edge.id}|${edge.hash}`;
      if (state.invalidatedSeen[key] !== true) {
        state.invalidatedSeen[key] = true;
        state.invalidatedKeys.push(key);
        invalidated = true;
      }
      rebuilt.push({ kind: edge.kind, id: edge.id, hash: current });
    }
    state.inputs[owner] = rebuilt;
    if (invalidated) {
      state.tables.spec[owner] = {
        ...spec,
        status: 'open',
        invalidated_reason: 'inputs hash changed',
        invalidated_at: event.at,
      };
    }
  }
}
