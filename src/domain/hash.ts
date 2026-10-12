/**
 * **内容指纹**的公共工具（2026-10-12 从 `design.ts` 抽出，供确认戳与签字审核单共用）。
 *
 * 口径（沿用 F-19 那套，**不要另造**）：
 *   · 指纹绑的是**内容**（规范化 JSON），不是文件字节、不是 mtime —— 换行/键序/注释变化不该改指纹；
 *   · 存储形态带算法前缀 `sha256:` —— 纯十六进制里"全是数字"的哈希会被 YAML 解析成 number，
 *     于是"指纹不相等"永远成立（活锁）。带前缀即永远是字符串。
 */
import { createHash } from 'node:crypto'

/** 指纹的存储前缀。 */
export const HASH_PREFIX = 'sha256:'

/** 稳定的 JSON 序列化（键排序、跳过 `undefined`），保证同一内容永远同一指纹。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** 任意内容的内容指纹（`sha256:<hex>`）。 */
export function contentHash(value: unknown): string {
  return HASH_PREFIX + createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** 指纹的短显示（去掉算法前缀，回执/文档里人眼比对用）。 */
export function shortHash(hash: string): string {
  const hex = hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : hash
  return hex.slice(0, 8)
}
