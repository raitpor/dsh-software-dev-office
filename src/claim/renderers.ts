/**
 * M1 的渲染器注册面代理（D-034）。
 *
 * 设计里的真源是 `renderer_catalog`（`docs/03` §3）；M1 没有这张表，按卡 A3 用
 * `RENDERERS` 常量表 ∩ `view_catalog` 的 view 名代理：一个渲染器“已注册”必须同时
 *   · 出现在本常量表里（代码即注册），且
 *   · 它声明的输入视图真的在 `view_catalog` 里。
 * M2 接 `renderer_catalog` 后删掉本代理，契约不变：`isRegisteredRenderer`。
 */
import type { SdoDatabase } from '../db/driver.js';

export interface RendererDef {
  readonly id: string;
  /** 渲染器读取的视图（`view_catalog.name`）。 */
  readonly view: string;
}

/** v1 回执里的 `renderer:gate-result` 对应门禁结果视图 `board`。 */
export const RENDERERS: readonly RendererDef[] = [
  { id: 'renderer:gate-result', view: 'board' },
];

export function rendererById(id: string): RendererDef | undefined {
  return RENDERERS.find((renderer) => renderer.id === id);
}

/** 注册面 = 常量表 ∩ `view_catalog`。视图缺失（未迁移 002）视为未注册。 */
export function isRegisteredRenderer(db: SdoDatabase, id: string): boolean {
  const renderer = rendererById(id);
  if (renderer === undefined) return false;
  const row = db.prepare('SELECT name FROM view_catalog WHERE name = ?').get(renderer.view) as
    | { name: string }
    | undefined;
  return row !== undefined;
}
