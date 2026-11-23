/**
 * paths.mjs — SDO 脚本的唯一路径解析点。
 *
 * 项目根：从 cwd 向上找 `.sdo/`（只认项目数据）。
 * 技能根：优先 `<cwd>/skills/sdo-flow/SKILL.md`（兼容已拷贝安装的项目）；
 *         否则用脚本自身所在目录（`<skill>/scripts/lib` 上溯两层），
 *         这样脚本从仓库里被调用时，cwd 不需要包含 skills/。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 脚本自带的技能根：lib → scripts → <skill> */
export const BUNDLED_SKILL_ROOT = path.dirname(path.dirname(LIB_DIR));

export function findProjectRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, ".sdo"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function resolveSkillRoot(cwd = process.cwd()) {
  const local = path.join(path.resolve(cwd), "skills", "sdo-flow");
  if (fs.existsSync(path.join(local, "SKILL.md"))) return { root: local, source: "project" };
  return { root: BUNDLED_SKILL_ROOT, source: "script" };
}

export function resolvePaths(cwd = process.cwd()) {
  const projectRoot = findProjectRoot(cwd);
  const skill = resolveSkillRoot(cwd);
  return { projectRoot, skillRoot: skill.root, skillSource: skill.source };
}

export function projectPath(projectRoot, rel) {
  return path.join(projectRoot, rel);
}

export function skillPath(skillRoot, rel) {
  return path.join(skillRoot, rel);
}
