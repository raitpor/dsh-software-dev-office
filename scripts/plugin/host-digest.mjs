#!/usr/bin/env node
/**
 * 宿主安装树内容哈希（M5-0 C8）。
 *
 * 用法：node scripts/plugin/host-digest.mjs --install <dir> [--exclude <dir>]...
 * 对目录下每个普通文件取 `相对路径\0内容` 的 sha256，再对排序后的行取 sha256。
 * 排除插件自身安装目录与任意 `node_modules/.cache`，避免把“装插件改 profile”算成改宿主源码。
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

function parseArgs(argv) {
  const out = { install: undefined, excludes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--install') out.install = argv[++i];
    else if (argv[i] === '--exclude') out.excludes.push(argv[++i]);
  }
  return out;
}

function isExcluded(path, excludes) {
  const abs = resolve(path);
  return excludes.some((excluded) => {
    const prefix = resolve(excluded);
    return abs === prefix || abs.startsWith(prefix + sep);
  });
}

function walk(root, dir, excludes, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (isExcluded(path, excludes)) continue;
    if (entry.isDirectory()) {
      if (entry.name === '.cache' && basename(dir) === 'node_modules') continue;
      walk(root, path, excludes, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.install === undefined) {
  process.stderr.write('usage: host-digest.mjs --install <dir> [--exclude <dir>]...\n');
  process.exit(2);
}
const root = resolve(args.install);
const excludes = args.excludes.map((path) => resolve(path));
if (!lstatSync(root).isDirectory()) {
  process.stderr.write(`not a directory: ${root}\n`);
  process.exit(2);
}
const files = [];
walk(root, root, excludes, files);
const lines = files.map((file) => {
  const rel = relative(root, file).split(sep).join('/');
  const content = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${rel}\0${content}`;
});
lines.sort();
const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
process.stdout.write(`${JSON.stringify({ install: root, files: files.length, sha256: digest })}\n`);
