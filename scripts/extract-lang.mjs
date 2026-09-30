/**
 * 抽取器 v3：把面向用户模块里的**中文文案**搬进 `src/data/lang/zh-CN.yml`。
 *
 * 硬规则（踩坑得到）：
 *   · 键一律**两层**（`<section>.<key>`）；`t()` 只认两层，无点号会返回空串；
 *   · YAML 里**键不加引号**（本插件的 YAML 子集解析器不支持带引号键），值用 JSON 引号；
 *   · 模板字符串里的 `${expr}` → `{pN}` 占位符 + `fmt(key, { pN: expr })`；
 *   · 跳过**数据位**（对象键位、索引、比较/includes、label/idOf/phaseText 参数、枚举取值）与**注释**；
 *   · 幂等：每次整段重写该模块的 YAML 段。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CJK = /[\u4e00-\u9fff]/
const files = process.argv.slice(2)
const yamlPath = 'src/data/lang/zh-CN.yml'

/** TS 字面量转义 → 真实字符（**必须做**：否则 `\`` 会以"反斜杠+反引号"的形态进 YAML，渲染出来就多一个反斜杠）。 */
const unescape = (text) =>
  text.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[\s\S])/gu, (all, esc) => {
    if (esc[0] === 'x' || esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16))
    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '`': '`', "'": "'", '"': '"', '\\': '\\', $: '$' }
    return map[esc] ?? esc
  })

const inComment = (src, idx) => {
  const lineStart = src.lastIndexOf('\n', idx) + 1
  const line = src.slice(lineStart, idx)
  if (line.includes('//')) return true
  const before = src.slice(0, idx)
  return before.lastIndexOf('/*') > before.lastIndexOf('*/')
}
const isData = (src, start, end) => {
  const before = src.slice(Math.max(0, start - 56), start)
  const after = src.slice(end, end + 4)
  if (/t\(\s*$|t\('[^']*',\s*$/u.test(before)) return true
  if (/(===|!==|==|!=|\bcase\b|\.includes\(|\.startsWith\(|\.endsWith\(|\.indexOf\(|\bimport\b|\brequire\()\s*$/u.test(before)) return true
  if (/(label|idOf|gateIdOf|phaseText|nextId)\(\s*$/u.test(before)) return true
  // 冒号未必是"对象键位"：三元 `cond ? '中文' : x` 里的 `:` 也是冒号。
  // 判定：只有当"最近的分隔符之后没有 `?`"时才算键位（键位=数据，跳过）。
  if (/^\s*:/u.test(after)) {
    const since = before.slice(Math.max(before.lastIndexOf('?'), before.lastIndexOf('{'), before.lastIndexOf(','), before.lastIndexOf('(')))
    if (!since.includes('?')) return true
  }
  // 索引 vs 数组字面量：只有紧跟在标识符/`)`/`]` 之后的 `[` 才是索引（数据）；
  // `= [ '文案' ]`、`return [ '文案' ]`、`push([ '文案' ])` 是数组字面量（正常文案，必须迁移）
  const bracket = before.lastIndexOf('[')
  if (bracket >= 0 && /[\w)\]]\s*$/u.test(before.slice(0, bracket))) return true
  if (/(kind|status|role|priority|phase|gate|scale|process|verdict|action|source|type|dimension)\s*:\s*$/u.test(before)) return true
  return false
}

for (const file of files) {
  const original = readFileSync(file, 'utf8')
  if (!existsSync(file + '.lang-bak')) writeFileSync(file + '.lang-bak', original)
  const module = file.split('/').pop().replace(/\.[jt]s$/u, '').replace(/[^a-zA-Z0-9]/gu, '')
  const section = 'ui' + module.charAt(0).toUpperCase() + module.slice(1)
  const entries = []
  let out = ''
  let cursor = 0
  // 已有键必须保留（教训：整段替换会毁掉上一批的键，老引用立刻变成无值键）
  const sectionNow = new RegExp(`^${section}:\\n((?:  .*\\n)*)`, 'mu').exec(readFileSync(yamlPath, 'utf8'))
  const keptLines = sectionNow === null ? [] : sectionNow[1].split('\n').filter((line) => line.trim() !== '')
  let nextIndex = 0
  for (const line of keptLines) {
    const hit = /^  k(\d+):/u.exec(line)
    if (hit !== null) nextIndex = Math.max(nextIndex, Number(hit[1]))
  }
  const emit = (text, params) => {
    nextIndex += 1
    const key = `${section}.k${nextIndex}`
    entries.push([`k${nextIndex}`, unescape(text)])
    return params.length === 0
      ? `t('${key}')`
      : `fmt('${key}', { ${params.map((p, i) => `p${i + 1}: ${p}`).join(', ')} })`
  }
  // 状态机扫描：正确处理嵌套模板字符串（`${cond ? `中文` : ''}`）
  const scan = (src, from) => {
    const ch = src[from]
    if (ch === "'" || ch === '"') {
      for (let i = from + 1; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue }
        if (src[i] === ch) return { end: i + 1, params: [], text: src.slice(from + 1, i), template: false }
      }
      return null
    }
    // 模板字符串：跟踪 ${ } 深度，嵌套模板整体作为表达式
    const params = []
    let text = ''
    let i = from + 1
    while (i < src.length) {
      if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue }
      if (src[i] === '`') return { end: i + 1, params, text, template: true }
      if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 1
        let j = i + 2
        let expr = ''
        while (j < src.length && depth > 0) {
          if (src[j] === '\\') { expr += src.slice(j, j + 2); j += 2; continue }
          if (src[j] === '{') depth += 1
          if (src[j] === '}') { depth -= 1; if (depth === 0) break }
          if (src[j] === '`') {  // 嵌套模板：整体跳过
            let k = j + 1
            while (k < src.length && src[k] !== '`') { if (src[k] === '\\') k += 1; k += 1 }
            expr += src.slice(j, k + 1); j = k + 1; continue
          }
          if (src[j] === "'" || src[j] === '"') {
            const q = src[j]; let k = j + 1
            while (k < src.length && src[k] !== q) { if (src[k] === '\\') k += 1; k += 1 }
            expr += src.slice(j, k + 1); j = k + 1; continue
          }
          expr += src[j]; j += 1
        }
        params.push(expr)
        text += `{p${params.length}}`
        i = j + 1
        continue
      }
      text += src[i]; i += 1
    }
    return null
  }

    // 递归迁移一个"表达式"里的文案：既处理里面的**嵌套模板字符串**，也处理单引号字面量。
    // （教训：只处理单引号时，`${c ? `中文 ${x}` : '中文'}` 这类嵌套模板会全部漏掉。）
    const migrateExpr = (expr) => {
      let out = ''
      let cursor = 0
      let i = 0
      while (i < expr.length) {
        const ch = expr[i]
        if (ch !== '`' && ch !== "'" && ch !== '"') { i += 1; continue }
        const inner = scan(expr, i)
        if (inner === null) { i += 1; continue }
        if (!CJK.test(inner.text)) { i = inner.end; continue }
        if (inner.template) {
          out += expr.slice(cursor, i) + emit(inner.text, inner.params.map(migrateExpr))
          cursor = inner.end
          i = inner.end
          continue
        }
        const before = expr.slice(Math.max(0, i - 28), i)
        const after = expr.slice(inner.end, inner.end + 3)
        const looksLikeKey = /^\s*:/u.test(after) && !before.slice(Math.max(before.lastIndexOf('?'), before.lastIndexOf('{'), before.lastIndexOf(','), before.lastIndexOf('('))).includes('?')
        // 注意：**不要**因为"前面是 `(`/`[`/`,`/`{`"就跳过 ——
        // `lines.push(`、`return [`、`{ key: '文案' }` 里的字符串都是**正常文案**。
        // 只有"冒号键位"和"比较/label 位"才是数据。（教训：过宽的括号规则整类漏掉了函数参数里的文案。）
        if (looksLikeKey) { i = inner.end; continue }
        if (/(===|!==|==|!=|includes\(|startsWith\(|endsWith\(|indexOf\(|label\(|idOf\(|gateIdOf\(|phaseText\()\s*$/u.test(before)) { i = inner.end; continue }
        out += expr.slice(cursor, i) + emit(inner.text, [])
        cursor = inner.end
        i = inner.end
      }
      return out + expr.slice(cursor)
    }

  let index = 0
  while (index < original.length) {
    const ch = original[index]
    if (ch !== '`' && ch !== "'" && ch !== '"') { index += 1; continue }
    const found = scan(original, index)
    if (found === null) { index += 1; continue }
    const raw = original.slice(index, found.end)
    if (inComment(original, index) || isData(original, index, found.end)) {
      index = found.end; continue
    }
    // ⚠️ 外层模板本身可能**没有中文**（中文全在嵌套模板/表达式里）——此时**不能整块跳过**，
    // 必须先递归处理参数；参数没变化才真的跳过。（教训：这里曾漏掉整类嵌套模板。）
    const fixedInner = (found.template ? found.params : []).map(migrateExpr)
    const paramsChanged = found.template && fixedInner.some((param, i) => param !== found.params[i])
    if (!CJK.test(found.text) && !paramsChanged) {
      index = found.end; continue
    }
    out += original.slice(cursor, index) + emit(found.text, fixedInner)
    cursor = found.end
    index = found.end
  }
  out += original.slice(cursor)
  if (entries.length === 0) { console.log(`= ${file}: 无可迁移文案`); continue }
  // 导入处理：已有 i18n 导入就把 fmt/t 合并进去，否则新插一行
  const needsFmt = entries.some(([, text]) => text.includes('{p'))
  const i18nImport = /import \{([^}]*)\} from '([^']*i18n\.js)'/u.exec(out)
  if (i18nImport !== null) {
    const names = new Set(i18nImport[1].split(',').map((name) => name.trim()).filter((name) => name !== ''))
    names.add('t')
    if (needsFmt) names.add('fmt')
    out = out.replace(i18nImport[0], `import { ${[...names].sort().join(', ')} } from '${i18nImport[2]}'`)
  } else {
    const depth = file.includes('/interface/') || file.includes('/board/') ? '../domain' : './domain'
    const names = needsFmt ? 'fmt, t' : 't'
    out = out.replace(/^(import .*\n)/u, `$1import { ${names} } from '${depth}/i18n.js'\n`)
  }
  writeFileSync(file, out)

  // YAML：幂等重写该 section
  let yaml = readFileSync(yamlPath, 'utf8')
  const block = `${section}:\n` + [...keptLines, ...entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)].join('\n') + '\n'
  const existing = new RegExp(`^${section}:\\n(?:  .*\\n)*`, 'mu')
  yaml = existing.test(yaml) ? yaml.replace(existing, block) : yaml + '\n' + block
  writeFileSync(yamlPath, yaml)
  console.log(`✔ ${file}: 迁移 ${entries.length} 条 → ${section}`)
}
