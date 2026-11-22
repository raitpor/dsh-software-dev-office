// 内容 hash 单点（M8-2 C5）：基线四份文件的版本标识只在这里算。
// 口径：文件按相对路径排序；每份 sha256("/相对路径\n" + 归一后内容)；把四份 hex 拼接后再 sha256。
// 归一：剥 UTF-8 BOM、\r\n / \r → \n（避免纯换行变化造成假漂移）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const BASELINE_FILES = [
  "architecture.md",
  "quality-risk.md",
  "requirement.md",
  "test-strategy.md",
];

export function normalizeBaselineText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function baselineHash(root = ".") {
  const parts = [];
  for (const name of BASELINE_FILES) {
    const rel = `.sdo/baseline/${name}`;
    const abs = path.join(root, rel);
    const body = fs.existsSync(abs) ? normalizeBaselineText(fs.readFileSync(abs, "utf8")) : "";
    parts.push(sha256Text(`${rel}\n${body}`));
  }
  return sha256Text(parts.join(""));
}
