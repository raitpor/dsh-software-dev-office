/**
 * M4-0：工作副本的目录形态（docs/07 §12）。
 *
 * <repo>/.work/<card>/           检出目录
 * <repo>/.sdo/vcs-objects/       共享对象库
 * <repo>/.sdo/vcs-cards/<card>.git/  每卡独立 gitdir（index/HEAD 各自独立）
 *
 * 卡 id 只允许安全字符，所有路径都断言在 repo 根内（防 ../ 逃逸）。
 */
import { isAbsolute, join, relative, resolve } from 'node:path';

export const WORK_DIR = '.work';
export const SDO_DIR = '.sdo';
export const OBJECTS_DIR = join(SDO_DIR, 'vcs-objects');
export const CARDS_DIR = join(SDO_DIR, 'vcs-cards');

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertCardId(card: string): string {
  if (!CARD_ID.test(card) || card.includes('..')) {
    throw new Error(`invalid card id: ${JSON.stringify(card)} (allowed: [A-Za-z0-9][A-Za-z0-9._-]*)`);
  }
  return card;
}

export function resolveInside(root: string, path: string): string {
  const base = resolve(root);
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${JSON.stringify(path)}`);
  }
  return abs;
}

export function objectsDir(root: string): string {
  return join(resolve(root), OBJECTS_DIR);
}

export function cardGitdir(root: string, card: string): string {
  return join(resolve(root), CARDS_DIR, `${assertCardId(card)}.git`);
}

export function cardWorkdir(root: string, card: string): string {
  return join(resolve(root), WORK_DIR, assertCardId(card));
}

/** 路径是否等于 prefix 或位于 prefix/ 之下（用于 scope_paths 判定）。 */
export function pathInScope(path: string, scopePaths: readonly string[]): boolean {
  const norm = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return scopePaths.some((raw) => {
    const scope = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return scope !== '' && (norm === scope || norm.startsWith(`${scope}/`));
  });
}
