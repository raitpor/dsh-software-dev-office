import { CODE } from '../core/errors/codes.js';
/**
 * M3-4 · 渲染器注册目录（真源，收口 D-034）。
 *
 * 三条硬口径（卡 C1–C4）：
 * 1. **目录是数据表**：`renderer_catalog(id, module_path, views[], at)`，行只由
 *    `renderer.registered` 事件投影（`rebuildRendererCatalog` 全量重建），没有第二套登记表。
 * 2. **登记即代码**：登记时 `module_path` 必须指向仓库内真实存在的 `src/` 实现，并用
 *    `import()` 动态校验它导出了渲染函数（存在性检查之外再加载；抛错/超时 ⇒
 *    `renderer_module_invalid`）。
 * 3. **登记要权**：`admin@domain`（S20 第四条裁定），经 `src/db/auth.ts` 的 `hasRight`
 *    走数据化矩阵；动作沿用 `config`（改配置，`docs/07` §2 要求 `admin@domain`）。
 *
 * 分层：`src/db/` 可 import `src/core/`；本文件不 import `src/claim/`（claim 侧只消费本模块）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../core/fold/canonical.js';
import type { Event } from '../core/fold/types.js';
import { computeEventHash } from '../core/verify-events.js';
import type { ActorRef } from '../core/auth/rights.js';
import { hasRight } from './auth.js';
import type { SdoDatabase } from './driver.js';
import { requiredTable } from './write-materialize.js';
import { appendAsTool, chainHead } from './write.js';
import {
  mintRendererRegistrationAuthority,
  rendererRegistrationPayloadHash,
} from './renderer-authority.js';

/** 登记动作的权：`config` 动作在 docs/07 §2 要求 `admin@domain`（S20 ④）。 */
export const RENDERER_PERMISSION_ACTION = 'config';
/** 注册表是全局配置，目标 scope 固定为配置域；持 `admin@domain:*` 覆盖者才能登记。 */
export const RENDERER_REGISTRY_SCOPE = 'domain:renderers';
/** 渲染器模块必须导出的函数名（`render` 或 `renderClaimRows`）。 */
export const RENDERER_EXPORTS = ['render', 'renderClaimRows'] as const;

/**
 * 引擎内置渲染器（迁移 010 同步播种）：v1 结论回执。
 *
 * 它不是用户登记，但 C2 要求 `claim.derived_by` 必须在目录里，所以随迁移进表；
 * `rebuildRendererCatalog()` 在全量重建后用 `INSERT OR IGNORE` 还原兜底行
 * （若事件流里已有同 id 的 `renderer.registered`，事件行优先）。
 */
export const BUILTIN_RENDERERS: readonly RendererCatalogRow[] = [
  {
    id: 'renderer:gate-result',
    module_path: 'src/claim/render.ts',
    views: ['board', 'plan'],
    at: '2026-11-15',
  },
];

const IMPORT_TIMEOUT_MS = 2_000;

/** 从当前模块向上找 `package.json` 所在的包根（编译产物在 `lib/src/db/` 下）。 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate package root from ${start}`);
}

const PACKAGE_ROOT = findPackageRoot(fileURLToPath(new URL('.', import.meta.url)));
const RENDERER_ID = /^renderer:[A-Za-z0-9._:-]+$/;
const MODULE_PATH = /^src\/[A-Za-z0-9._/-]+\.ts$/;

export interface RendererCatalogRow {
  readonly id: string;
  readonly module_path: string;
  readonly views: readonly string[];
  readonly at: string;
}

export interface RendererRegisterFailure {
  readonly ok: false;
  readonly reason_code:
    | typeof CODE.invalid_field
    | typeof CODE.renderer_module_invalid
    | typeof CODE.renderer_views_unknown
    | typeof CODE.renderer_conflict
    | 'no_permission'
    | 'event_rejected';
  readonly message: string;
}

export interface RendererRegisterSuccess {
  readonly ok: true;
  readonly id: string;
  /** true = 首次登记；false = 幂等重跑（目录行与事件都不新增）。 */
  readonly created: boolean;
  readonly event_id?: string;
}

export type RendererRegisterResult = RendererRegisterSuccess | RendererRegisterFailure;

function fail(reason_code: RendererRegisterFailure['reason_code'], message: string): RendererRegisterFailure {
  return { ok: false, reason_code, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseViews(raw: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !isNonEmptyString(item))) return undefined;
  return [...new Set(parsed as string[])];
}

/** 目录全量读（行由事件投影，见 `rebuildRendererCatalog`）。 */
export function readRendererCatalog(db: SdoDatabase): RendererCatalogRow[] {
  const rows = db
    .prepare('SELECT id, module_path, views, at FROM renderer_catalog ORDER BY id')
    .all() as Array<{ id: string; module_path: string; views: string; at: string }>;
  return rows.flatMap((row) => {
    const views = parseViews(row.views);
    return views === undefined ? [] : [{ ...row, views }];
  });
}

export function rendererById(db: SdoDatabase, id: string): RendererCatalogRow | undefined {
  return readRendererCatalog(db).find((row) => row.id === id);
}

/** C2 的唯一判定口径：`claim.derived_by` 必须在本表里。 */
export function isRendererRegistered(db: SdoDatabase, id: string): boolean {
  return rendererById(db, id) !== undefined;
}

/** `renderer_catalog` 的投影哨兵名（迁移 011 建表并播种）。 */
const RENDERER_CATALOG_GUARD = 'renderer_catalog';

/**
 * 迁移 011 的投影守卫：只有 append 事务内的物化器可以写 `renderer_catalog`。
 * 窗口外（含裸连接直插）被触发器 ABORT；这里负责在合法窗口内把哨兵置 1、结束复位。
 */
export function withRendererCatalogProjection<T>(db: SdoDatabase, fn: () => T): T {
  const set = (active: 0 | 1): void => {
    db.prepare('UPDATE projection_guard SET active = ? WHERE name = ?').run(active, RENDERER_CATALOG_GUARD);
  };
  // 整个窗口（置位 → 写入 → 复位）放在一个事务里：异常走 finally 复位；
  // 进程在窗口内崩溃时未提交事务整体回滚，`active` 不会永久停在 1（否则投影表会锁死）。
  const guarded = db.transaction((): T => {
    set(1);
    try {
      return fn();
    } finally {
      set(0);
    }
  });
  return guarded();
}

/** 从事件载荷解析目录行形状；非法形状直接抛（append 事务内调用，整批回滚）。 */
function catalogRowFromEvent(event: Event): RendererCatalogRow | undefined {
  let payload: unknown = event.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const id = record['id'];
  const modulePath = record['module_path'];
  const views = record['views'];
  if (!isNonEmptyString(id) || !isNonEmptyString(modulePath) || !Array.isArray(views)) return undefined;
  if (views.some((view) => !isNonEmptyString(view))) return undefined;
  return { id, module_path: modulePath, views: [...new Set(views as string[])], at: event.at };
}

/**
 * 写网关在 append 事务内调用（P1-3）：把本批 `renderer.registered` 事件投影进目录。
 * 放在物化阶段之后、COMMIT 之前；抛错 ⇒ `append` 整批 ROLLBACK。
 */
export function applyRendererRegistrations(db: SdoDatabase, events: readonly Event[]): void {
  const registrations = events.filter((event) => event.kind === 'renderer.registered');
  if (registrations.length === 0) return;
  const rows = registrations.map(catalogRowFromEvent);
  if (rows.some((row) => row === undefined)) {
    throw new Error('renderer.registered payload must be {id, module_path, views[]}');
  }
  withRendererCatalogProjection(db, () => {
    const upsert = db.prepare(
      `INSERT INTO renderer_catalog (id, module_path, views, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET module_path = excluded.module_path, views = excluded.views, at = excluded.at`,
    );
    for (const row of rows as RendererCatalogRow[]) {
      upsert.run(row.id, row.module_path, canonicalJson(row.views), row.at);
    }
  });
}

/**
 * 全量重建目录：事件流是唯一的注册真源（幂等；直改目录表会被下一次重建抹掉）。
 *
 * @internal 维护面（CLI/测试），产品路径不调用：生产里目录只由 `append` 在事务内投影；
 * 本函数只在迁移/修复时使用，用完必须和事件链对账（`verifyClaims`）。
 */
export function rebuildRendererCatalog(db: SdoDatabase): RendererCatalogRow[] {
  const events = db
    .prepare("SELECT id, at, payload FROM event WHERE kind = 'renderer.registered' ORDER BY rowid")
    .all() as Array<{ id: string; at: string; payload: string }>;
  const latest = new Map<string, RendererCatalogRow>();
  for (const event of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const record = payload as Record<string, unknown>;
    const id = record['id'];
    const modulePath = record['module_path'];
    const views = record['views'];
    if (!isNonEmptyString(id) || !isNonEmptyString(modulePath) || !Array.isArray(views)) continue;
    if (views.some((view) => !isNonEmptyString(view))) continue;
    latest.set(id, {
      id,
      module_path: modulePath,
      views: [...new Set(views as string[])],
      at: event.at,
    });
  }
  withRendererCatalogProjection(db, () => {
    db.exec('DELETE FROM renderer_catalog');
    const insert = db.prepare(
      'INSERT INTO renderer_catalog (id, module_path, views, at) VALUES (?, ?, ?, ?)',
    );
    for (const row of latest.values()) {
      insert.run(row.id, row.module_path, canonicalJson(row.views), row.at);
    }
    // 内置渲染器兜底：事件流里没有同 id 登记时用迁移同口径的行补上。
    const restoreBuiltin = db.prepare(
      'INSERT OR IGNORE INTO renderer_catalog (id, module_path, views, at) VALUES (?, ?, ?, ?)',
    );
    for (const row of BUILTIN_RENDERERS) {
      restoreBuiltin.run(row.id, row.module_path, canonicalJson(row.views), row.at);
    }
  });
  return readRendererCatalog(db);
}

/** `src/x.ts` → `<repo>/lib/x.js`（登记校验的是**会被加载的**那份代码，不是源文件文本）。 */
export function compiledRendererFile(modulePath: string): string | undefined {
  if (!MODULE_PATH.test(modulePath) || modulePath.includes('..')) return undefined;
  // 编译产物：`<repo>/lib/src/...js`（tsconfig 的 rootDir 是仓库根）。
  return join(PACKAGE_ROOT, 'lib', modulePath.replace(/\.ts$/u, '.js'));
}

async function importWithTimeout(file: string): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`renderer module import timed out after ${IMPORT_TIMEOUT_MS}ms`)),
      IMPORT_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return (await Promise.race([
      import(pathToFileURL(file).href) as Promise<Record<string, unknown>>,
      timeout,
    ])) as Record<string, unknown>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** C3：登记即代码。返回错误消息（`undefined` = 通过）。 */
async function validateRendererModule(modulePath: string): Promise<string | undefined> {
  const file = compiledRendererFile(modulePath);
  if (file === undefined) {
    return `module_path must be a src/...ts file inside this repository: ${modulePath}`;
  }
  if (!existsSync(file)) {
    return `module_path does not exist: ${modulePath} (expected compiled ${file})`;
  }
  let namespace: Record<string, unknown>;
  try {
    namespace = await importWithTimeout(file);
  } catch (error) {
    return `module_path failed to load: ${error instanceof Error ? error.message : String(error)}`;
  }
  const exported = RENDERER_EXPORTS.filter((name) => typeof namespace[name] === 'function');
  if (exported.length === 0) {
    return `module_path exports none of the renderer functions ${RENDERER_EXPORTS.join('/')}: ${modulePath}`;
  }
  return undefined;
}

function sameViews(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((view, index) => view === sortedRight[index]);
}

function buildRegisteredEvent(input: {
  readonly id: string;
  readonly modulePath: string;
  readonly views: readonly string[];
  readonly actor: string;
  readonly at: string;
  readonly prev: string;
}): Event {
  const base = {
    id: `ren-${randomUUID()}`,
    at: input.at,
    actor: input.actor,
    kind: 'renderer.registered',
    subject: input.id,
    request_id: `registry:${input.id}`,
    payload: { id: input.id, module_path: input.modulePath, views: [...input.views] },
    caused_by: [] as readonly string[],
    prev: input.prev,
    hash: '',
  };
  const hash = computeEventHash(base);
  return { ...base, hash } as Event;
}

export interface RegisterRendererInput {
  readonly id: string;
  readonly module_path: string;
  /** 该渲染器读取的视图（`view_catalog.name`）；必须是已存在的视图。 */
  readonly views: readonly string[];
  /** 会话身份（不许由 payload 自称）。 */
  readonly actor: ActorRef;
  /** 注入时钟（测试）；缺省 current time。 */
  readonly at?: string;
}

/**
 * 登记渲染器（唯一入口）。顺序：形状 → 权（`admin@domain`）→ 目录幂等/冲突 →
 * 模块真加载（C3）→ `append` 事件 → 从事件重建目录。
 * 失败一律零写：模块校验在 append 之前，不存在“登记了但代码是假的”。
 */
export async function registerRenderer(
  db: SdoDatabase,
  input: RegisterRendererInput,
): Promise<RendererRegisterResult> {
  if (!RENDERER_ID.test(input.id)) {
    return fail(CODE.invalid_field, `renderer id must look like renderer:<name>: ${input.id}`);
  }
  if (!isNonEmptyString(input.module_path)) {
    return fail(CODE.invalid_field, 'module_path must be a non-empty string');
  }
  if (input.views.length === 0 || input.views.some((view) => !isNonEmptyString(view))) {
    return fail(CODE.invalid_field, 'views must be a non-empty array of view names');
  }
  if (new Set(input.views).size !== input.views.length) {
    return fail(CODE.invalid_field, 'views must not contain duplicates');
  }
  const views = [...input.views];

  const decision = hasRight(db, input.actor, RENDERER_PERMISSION_ACTION, RENDERER_REGISTRY_SCOPE);
  if (!decision.ok) {
    return fail(CODE.no_permission,
      `registering a renderer requires ${RENDERER_PERMISSION_ACTION}@${RENDERER_REGISTRY_SCOPE}: ${decision.message}`,
    );
  }

  const existing = rendererById(db, input.id);
  if (existing !== undefined) {
    if (existing.module_path === input.module_path && sameViews(existing.views, views)) {
      return { ok: true, id: input.id, created: false };
    }
    return fail(
      'renderer_conflict',
      `renderer ${input.id} is already registered as ${existing.module_path}; registrations are append-only`,
    );
  }

  const existingViews = new Set(
    (db.prepare('SELECT name FROM view_catalog').all() as Array<{ name: string }>).map((row) => row.name),
  );
  const unknownViews = views.filter((view) => !existingViews.has(view));
  if (unknownViews.length > 0) {
    return fail('renderer_views_unknown', `renderer ${input.id} declares unknown view(s): ${unknownViews.join(', ')}`);
  }

  const moduleProblem = await validateRendererModule(input.module_path);
  if (moduleProblem !== undefined) {
    return fail('renderer_module_invalid', moduleProblem);
  }

  const at = input.at ?? new Date().toISOString();
  const event = buildRegisteredEvent({
    id: input.id,
    modulePath: input.module_path,
    views,
    actor: input.actor.id,
    at,
    prev: chainHead(db),
  });
  // P1-2：登记能力绑规范化载荷摘要，写网关在 append 事务内消费（直 append 无能力 ⇒ 拒）。
  const payloadHash = rendererRegistrationPayloadHash(event.payload);
  if (payloadHash === undefined) {
    return fail(CODE.invalid_field, `renderer ${input.id}: registration payload is not canonicalizable`);
  }
  mintRendererRegistrationAuthority(payloadHash);
  const appended = appendAsTool(db, [event], input.actor.id, input.actor.kind);
  if (!appended.ok) {
    return fail('event_rejected', appended.message ?? `append rejected: ${String(appended.reason_code)}`);
  }
  // 目录行已在 append 事务内投影（`applyRendererRegistrations`）；这里只读回确认。
  return { ok: true, id: input.id, created: true, event_id: event.id };
}

export interface RendererCoverage {
  /** 渲染器声明的 `views[]` 是否覆盖声称来源表的视图。 */
  readonly ok: boolean;
  /** 没有对应声明视图的来源表（空 = 覆盖）。 */
  readonly missing_tables: readonly string[];
}

/** `views` 里有没有一个视图的 SQL 真的 `FROM/JOIN` 这张表。 */
function viewsReadingTable(db: SdoDatabase, table: string): string[] {
  const pattern = new RegExp(`\\b(?:from|join)\\s+["'\`]?${table.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["'\`]?\\b`, 'iu');
  const rows = db.prepare('SELECT name, sql FROM view_catalog').all() as Array<{ name: string; sql: string }>;
  return rows.filter((row) => pattern.test(row.sql)).map((row) => row.name);
}

/** 事件 id → 它投影的表（与写网关同一张 `requiredTable` 映射，不另写口径）。 */
export function sourceTablesOf(db: SdoDatabase, eventIds: readonly string[]): string[] {
  const tables = new Set<string>();
  for (const id of eventIds) {
    const row = db.prepare('SELECT kind FROM event WHERE id = ?').get(id) as { kind: string } | undefined;
    if (row === undefined) continue;
    const table = requiredTable(row.kind);
    if (table !== undefined) tables.add(table);
  }
  return [...tables].sort();
}

/** C4：`views[]` 覆盖来源视图——每个来源表至少有一个声明视图确实读它。 */
export function rendererViewCoverage(
  db: SdoDatabase,
  rendererId: string,
  eventIds: readonly string[],
): RendererCoverage {
  const renderer = rendererById(db, rendererId);
  const declared = new Set(renderer?.views ?? []);
  const missing: string[] = [];
  for (const table of sourceTablesOf(db, eventIds)) {
    const readers = viewsReadingTable(db, table);
    if (readers.length === 0) continue;
    if (!readers.some((view) => declared.has(view))) missing.push(table);
  }
  return { ok: missing.length === 0, missing_tables: missing };
}
