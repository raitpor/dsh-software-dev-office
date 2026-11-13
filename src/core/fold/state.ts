import { TABLE_NAMES, type FoldState, type FoldWorking, type InputEdge, type Row, type TableName } from './types.js';

/** 空状态：34 张表都是空对象。 */
export function emptyState(): FoldState {
  return {
    eventIds: [],
    seen: {},
    tables: emptyTables(),
    inputs: {},
    invalidatedKeys: [],
  };
}

function emptyTables(): Record<TableName, Record<string, Row>> {
  const tables = {} as Record<TableName, Record<string, Row>>;
  for (const name of TABLE_NAMES) {
    tables[name] = {};
  }
  return tables;
}

/** 浅克隆：每个 map 一层拷贝；行对象不可变，不深拷。 */
export function cloneState(state: FoldState): FoldWorking {
  const tables = {} as Record<TableName, Record<string, Row>>;
  for (const name of TABLE_NAMES) {
    tables[name] = { ...state.tables[name] };
  }
  const inputs: Record<string, InputEdge[]> = {};
  for (const [owner, edges] of Object.entries(state.inputs)) {
    inputs[owner] = edges.map((edge) => ({ ...edge }));
  }
  return {
    eventIds: [...state.eventIds],
    seen: { ...state.seen },
    tables,
    inputs,
    invalidatedKeys: [...state.invalidatedKeys],
    invalidatedSeen: Object.fromEntries(state.invalidatedKeys.map((key) => [key, true as const])),
  };
}

/** 把工作副本固化成不可变输出。 */
export function freezeState(working: FoldWorking): FoldState {
  return {
    eventIds: working.eventIds,
    seen: working.seen,
    tables: working.tables,
    inputs: working.inputs,
    invalidatedKeys: working.invalidatedKeys,
  };
}
