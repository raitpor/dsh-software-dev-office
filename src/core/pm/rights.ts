/**
 * M2-5 · 静态权限表（C2）。
 *
 * `docs/07` §5：M2 的 PM 是 Lead（人 + agent 混合），grant 机制 M4 才开 ⇒ 权限只来自
 * 这里写死的静态表。写域定义来自 `plan/01` §2「写域即边界」与各卡 frontmatter。
 *
 * 读权限（`viewRight`）复用 `src/views/catalog.ts` 的 Right 层级；读队列/视图时由查询层
 * 用 `viewsForRight` 做投影裁剪（`src/query/execute.ts`）。
 * **写动作的权限**按 `docs/07` §2 的静态授权矩阵判定（`grants` + `scopes`），不经过视图投影；
 * P2-3：本文件的 `viewRight` 与 `src/views/catalog.ts` 的 min_right 是两张静态表，
 * `test/core/pm/pm.test.ts` 的一致性守卫会断言同一 right 下视图集合一致，防漂移。
 */

import type { Right } from '../../views/catalog.js';

export type SeatName =
  | 'lead'
  | 'impl-core'
  | 'impl-surface'
  | 'impl-import'
  | 'impl-security'
  | 'reviewer';

export type PmRightKind = 'plan' | 'assign' | 'escalate';

export interface PmGrant {
  readonly kind: PmRightKind;
  /** '*' 或写域 glob（如 `src/core/**`）。 */
  readonly scope: string;
}

export interface Seat {
  readonly name: SeatName;
  /** 读视图用的最小权限层级（`src/views/catalog.ts` 的 Right）。 */
  readonly viewRight: Right;
  readonly grants: readonly PmGrant[];
  /** 本席位可写的路径（glob）。 */
  readonly scopes: readonly string[];
}

export const SEATS: Readonly<Record<SeatName, Seat>> = {
  lead: {
    name: 'lead',
    viewRight: 'signer',
    grants: [
      { kind: 'plan', scope: '*' },
      { kind: 'assign', scope: '*' },
      { kind: 'escalate', scope: '*' },
    ],
    scopes: ['*'],
  },
  'impl-core': {
    name: 'impl-core',
    viewRight: 'reader',
    grants: [],
    scopes: ['src/core/**', 'src/db/**', 'migrations/**', 'test/core/**', 'test/db/**'],
  },
  'impl-surface': {
    name: 'impl-surface',
    viewRight: 'reader',
    grants: [],
    scopes: [
      'src/views/**',
      'src/query/**',
      'src/ui/**',
      'src/align/**',
      'src/check/**',
      'src/preview/**',
      'src/core/pm/**',
      'test/views/**',
      'test/query/**',
      'test/ui/**',
      'test/align/**',
      'test/check/**',
      'test/preview/**',
      'test/core/pm/**',
      'scripts/**',
      'package.json',
    ],
  },
  'impl-import': {
    name: 'impl-import',
    viewRight: 'reader',
    grants: [],
    scopes: [
      'src/importer/**',
      'src/claim/**',
      'test/importer/**',
      'test/claim/**',
      'test/fixtures/**',
      'test/readings/**',
    ],
  },
  'impl-security': {
    name: 'impl-security',
    viewRight: 'reader',
    grants: [],
    scopes: ['src/sign/**', 'signerd/**', 'test/sign/**'],
  },
  reviewer: {
    name: 'reviewer',
    viewRight: 'reviewer',
    grants: [],
    scopes: [],
  },
};

export function isSeatName(value: string): value is SeatName {
  return Object.hasOwn(SEATS, value);
}

export function seatOf(name: string): Seat | undefined {
  return isSeatName(name) ? SEATS[name] : undefined;
}

function patternPrefix(pattern: string): string {
  if (pattern === '*' || pattern === '**') return '';
  if (pattern.endsWith('/**')) return `${pattern.slice(0, -3)}/`;
  if (pattern.endsWith('**')) return pattern.slice(0, -2);
  if (pattern.endsWith('*')) return pattern.slice(0, -1);
  return pattern;
}

/** 一个 glob 是否覆盖一条具体路径。 */
export function scopeCovered(pattern: string, path: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (!pattern.includes('*')) return pattern === path;
  const prefix = patternPrefix(pattern);
  const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === bare || path.startsWith(prefix);
}

export function scopesCovered(patterns: readonly string[], paths: readonly string[]): boolean {
  return paths.every((path) => patterns.some((pattern) => scopeCovered(pattern, path)));
}

/** 两条写域是否可能重叠（前缀关系即视为重叠）。 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      const x = patternPrefix(pa);
      const y = patternPrefix(pb);
      if (x === '' || y === '') return true;
      if (x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}

/** actor 是否持有某类 PM 权且覆盖给定写域。 */
export function hasPmRight(actor: string, kind: PmRightKind, scopePaths: readonly string[]): boolean {
  const seat = seatOf(actor);
  if (seat === undefined) return false;
  return seat.grants.some(
    (grant) =>
      grant.kind === kind &&
      (grant.scope === '*' || scopePaths.every((path) => scopeCovered(grant.scope, path))),
  );
}

/** 该席位能否看见某个视图（复用 M0-4 的 `viewsForRight` 层级，不新造投影）。 */
export function seatViewRight(actor: string): Right | undefined {
  return seatOf(actor)?.viewRight;
}
