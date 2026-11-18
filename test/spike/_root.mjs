// spike 测试的公共路径工具：从当前文件向上找仓库根。
// P1-2：按目录特征（migrations/001_init.sql + plan/00-*.md）识别，不再硬编码包名；
// 这样同一份测试在 test/spike/ 源码位置和 lib/spike-test/ 构建产物位置都能跑。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function hasPlanEntry(dir) {
  const plan = join(dir, 'plan');
  if (!existsSync(plan)) return false;
  try {
    return readdirSync(plan).some((name) => /^00-.*\.md$/.test(name));
  } catch {
    return false;
  }
}

export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'migrations', '001_init.sql')) && hasPlanEntry(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`repo root not found from ${start}`);
    current = parent;
  }
}

export const REPO_ROOT = findRepoRoot();

/** 动态 import 仓库里的 .mjs 源码（.mjs 不参与 tsc，所以测试直接 import 源码）。 */
export function importRepoModule(relativePath) {
  return import(pathToFileURL(join(REPO_ROOT, relativePath)).href);
}
