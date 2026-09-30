/**
 * 语言包迁移的**计数器**：状态机扫描源码，找出"仍写死在代码里的中文文案"。
 *
 * 为什么不用正则：注释/字符串里的英文撇号（如 `user's`）会让简单的引号配对错位，
 * 产生跨行假匹配（实测把 4 处幻影算成了 100+ 处）。这里用与抽取器同款的状态机：
 *   · 跳过行注释与块注释；
 *   · 正确处理模板字符串（含嵌套）与 `${}` 表达式；
 *   · 只统计**含中文**的字符串字面量。
 */
import { CJK_TEXT } from './langText.js'


/** 判断 `/` 是**正则字面量**起点（而非除号）：看前一个非空白字符是否处于"值位置"。 */
function regexStart(source: string, index: number): boolean {
  let k = index - 1
  while (k >= 0 && /\s/u.test(source[k] ?? '')) k -= 1
  if (k < 0) return true
  const prev = source[k] ?? ''
  if ('(,=:[!&|?{};'.includes(prev)) return true
  const word = /([A-Za-z_$][\w$]*)\s*$/u.exec(source.slice(Math.max(0, k - 10), k + 1))
  return word !== null && ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void'].includes(word[1] ?? '')
}

/** 跳过一段正则字面量（含 `\` 转义与 `[...]` 字符类），返回闭合 `/` 之后的位置。 */
function skipRegex(source: string, start: number): number {
  let j = start + 1
  let inClass = false
  while (j < source.length) {
    const ch = source[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return j + 1
    else if (ch === '\n') return j
    j += 1
  }
  return j
}

export interface CjkLiteral {
  line: number
  text: string
}

/** 扫描出所有含中文的字符串字面量（不含注释）。 */
export function scanCjkLiterals(source: string): CjkLiteral[] {
  const found: CjkLiteral[] = []
  let i = 0
  const len = source.length
  const push = (start: number, text: string): void => {
    if (CJK_TEXT.test(text)) found.push({ line: source.slice(0, start).split('\n').length, text })
  }
  while (i < len) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? len : end + 1
      continue
    }
    if (ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && regexStart(source, i)) {
      // **踩坑**：正则体里的反引号（例如 ``.replace(/`/gu, '')``）曾被当成模板字符串起点，
      // 跨行吞掉代码产生"幻影字面量"（plan.ts 因此被多算 9 条，提取器还据此改坏了该文件）。
      i = skipRegex(source, i)
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? len : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < len && source[j] !== ch) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      push(i, source.slice(i + 1, j))
      i = j + 1
      continue
    }
    if (ch === '`') {
      let j = i + 1
      let text = ''
      while (j < len) {
        if (source[j] === '\\') { text += source.slice(j, j + 2); j += 2; continue }
        if (source[j] === '`') break
        if (source[j] === '$' && source[j + 1] === '{') {
          let depth = 1
          let k = j + 2
          while (k < len && depth > 0) {
            if (source[k] === '\\') { k += 2; continue }
            if (source[k] === '{') depth += 1
            if (source[k] === '}') { depth -= 1; if (depth === 0) break }
            if (source[k] === '`') {
              let m = k + 1
              while (m < len && source[m] !== '`') { if (source[m] === '\\') m += 1; m += 1 }
              k = m + 1
              continue
            }
            k += 1
          }
          // 递归统计 ${} 表达式内部的中文字面量（它们同样是用户可见文案）
          found.push(...scanCjkLiterals(source.slice(j + 2, k)))
          j = k + 1
          continue
        }
        text += source[j]
        j += 1
      }
      push(i, text)
      i = j + 1
      continue
    }
    i += 1
  }
  return found
}

/** 计数（棘轮守卫用）。 */
export function countCjkLiterals(source: string): number {
  return scanCjkLiterals(source).length
}
