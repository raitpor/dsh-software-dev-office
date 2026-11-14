// spike 测试的公共路径工具：从当前文件向上找仓库根（package.json name=sdo-v2）。
// 这样同一份测试在 test/spike/ 源码位置和 lib/spike-test/ 构建产物位置都能跑。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))) {
  let current = resolve(start);
  for (;;) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'sdo-v2') return current;
      } catch {
        /* 继续向上 */
      }
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
