// 内容指纹：无 git 时的被签对象锚点（M11-11）。
// 规则：只收普通文件，按相对路径字节序；每条 sha256(路径 + "\0" + sha256(内容))，
// 再对拼接后的 hex 取 sha256，输出 32 位十六进制。纯 node，不跟随符号链接。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const FINGERPRINT_EXCLUDED_DIRS = [".git", "node_modules", ".tmp", ".work"];

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function excluded(rel, extra = []) {
  const parts = rel.split("/");
  if (parts.some((p) => FINGERPRINT_EXCLUDED_DIRS.includes(p))) return true;
  const normalized = parts.join("/");
  if (normalized.startsWith(".sdo/.index/")) return true;
  for (const item of extra) {
    if (normalized === item || normalized.startsWith(`${item.replace(/\/+$/, "")}/`)) return true;
  }
  return false;
}

function walk(root, rel, out, extra) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (excluded(`${childRel}/`, extra)) continue;
      walk(root, childRel, out, extra);
    } else if (e.isFile()) {
      if (excluded(childRel, extra)) continue;
      out.push(childRel);
    }
  }
}

export function signatureExcludes(milestone) {
  return [".sdo/sign", `.sdo/milestones/${milestone}.md`];
}

export function treeFingerprint(root, options = {}) {
  const extra = Array.isArray(options.exclude) ? options.exclude : [];
  const files = [];
  walk(path.resolve(root), "", files, extra);
  files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const hasher = crypto.createHash("sha256");
  for (const rel of files) {
    const content = fs.readFileSync(path.join(path.resolve(root), rel));
    hasher.update(rel, "utf8");
    hasher.update("\0", "utf8");
    hasher.update(sha256Hex(content), "utf8");
  }
  return hasher.digest("hex").slice(0, 32);
}
