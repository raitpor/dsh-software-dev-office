/**
 * M89：**文档漂移守卫**。
 *
 * 为什么要有它（2026-10-10 用户要求"整理文档、不许留本地路径、清理漂移"）：
 *   · 文档里混进 `/home/<某人>/...` 这类**指向某台机器**的路径 ⇒ 换台机器照抄就失效，
 *     而且会把本机用户名带进仓库（本轮就清了 8 篇文档 + 1 处测试夹具）；
 *   · `docs/README.md` 是权威索引（"别把历史文档当现行规格"），可它自己会漂 ——
 *     本轮就发现**当轮交接文档与最新复测报告都没被收录**，读者按索引找不到最新的那两篇。
 *
 * 两条守卫都是**机械可复算**的：① 逐行正则扫全部 .md；② 索引链接与磁盘文件双向对账。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 递归收集某个目录下的 `.md`（相对 `ROOT`，POSIX 分隔符）。 */
function markdownUnder(dir: string): string[] {
  const base = join(ROOT, dir)
  if (!existsSync(base)) return []
  const out: string[] = []
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.md')) out.push(relative(ROOT, full).split('\\').join('/'))
    }
  }
  walk(base)
  return out
}

/** 全部文档：面向使用者的 + 历史记录（`.review/` 是评审档案，同样是文档）。 */
function docFiles(): string[] {
  return [
    'README.md',
    'CHANGELOG.md',
    ...markdownUnder('docs'),
    ...markdownUnder('.review'),
    ...markdownUnder('skills'),
  ].sort()
}

/**
 * 指向**某台机器**的绝对路径。刻意**不**禁 `~/.local/...` 这类相对家目录的写法
 * （那是对外可照抄的占位），也不禁 `/tmp`（与机器无关）。
 */
const LOCAL_PATH_PATTERNS: readonly RegExp[] = [
  /(?<![\w$.])\/home\/[A-Za-z0-9._-]+\//u, // Linux/macOS 家目录下的绝对路径
  /(?<![\w$.])\/Users\/[A-Za-z0-9._-]+\//u, // macOS 家目录
  /[A-Za-z]:\\\\/u, // Windows 盘符
  /--home-[A-Za-z0-9._-]+-/u, // 宿主把工作区绝对路径转义出来的会话目录名（内嵌用户名）
]

test('M89-01 文档里不许出现指向某台机器的本地绝对路径', () => {
  const offenders: string[] = []
  for (const rel of docFiles()) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${rel}:${index + 1}  ${line.trim().slice(0, 140)}`)
        }
      })
  }
  assert.deepEqual(offenders, [], `文档里出现本地绝对路径（换成 <仓库根> / <测试工作区> / <临时目录> 这类占位）：\n${offenders.join('\n')}`)
  // 反自身：扫描面不能因为路径改名而悄悄变空（文档清单至少要覆盖住已知规模）
  assert.ok(docFiles().length >= 30, `文档清单可疑（只扫到 ${docFiles().length} 篇）`)
})

/**
 * **本机运行痕迹**（不是"绑机器"，但也不该无节制增长）：会话 uuid、本地端口、`$HOME` 下写死的实例版本。
 *
 * 与 `M89-01` 的分工：`M89-01` 判**红**的是"换台机器就失效"的绝对路径（含用户名）；这里判的是
 * **一次运行的标识**——它可移植（用 `$HOME`/变量写法），但会让文档带上"当时那台机器/那次会话"的痕迹。
 * 历史文档不改（历史不重写），所以口径是**只许减不许增**的棘轮：新增一处就要在这里加数并说明理由。
 */
const RUNTIME_TRACE_PATTERNS: readonly RegExp[] = [
  /session-[0-9a-f]{8}/u,                  // 会话 uuid 片段
  /127\.0\.0\.1:\d+/u,                     // 本地端口
  /\$HOME\/\.local\/share\/hdsl\/instances\//u, // 把本地实例布局+版本写进文档
]

/** 现值（2026-10-22 现算）。**只许减不许增**：减了就改成更小的数，增了必须写清为什么。 */
const KNOWN_RUNTIME_TRACES: Readonly<Record<string, number>> = {
  使用者文档: 25, // README/CHANGELOG/docs/skills 共 71 篇里，25 行带运行痕迹
  评审档案: 51,   // .review 历史归档 50 篇里，51 行带运行痕迹（归档不改，只计数）
}

function runtimeTraceCount(files: string[]): { total: number; offenders: string[] } {
  const offenders: string[] = []
  let total = 0
  for (const rel of files) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!RUNTIME_TRACE_PATTERNS.some((pattern) => pattern.test(line))) return
        total += 1
        offenders.push(`${rel}:${index + 1}`)
      })
  }
  return { total, offenders }
}

test('M89-04 本机运行痕迹（会话 id / 本地端口 / 写死的实例版本）只许减不许增', () => {
  const scopes: [string, string[]][] = [
    ['使用者文档', ['README.md', 'CHANGELOG.md', ...markdownUnder('docs'), ...markdownUnder('skills')]],
    ['评审档案', markdownUnder('.review')],
  ]
  for (const [label, files] of scopes) {
    const { total, offenders } = runtimeTraceCount(files)
    const known = KNOWN_RUNTIME_TRACES[label] ?? 0
    assert.ok(
      total <= known,
      `${label}里本机运行痕迹从 ${known} 处涨到 ${total} 处（新增处：${offenders.slice(-8).join('、')}）`
        + '——新文档请用占位符（`<会话id>` / `<GUI 地址>` / `<实例目录>`）；若确有必要保留实例标识，请同步调高 KNOWN_RUNTIME_TRACES 并在此写明理由',
    )
  }
})

test('M89-02 docs/README.md 必须收录 docs/ 下每一篇文档，且不许有死链', () => {
  const indexRel = 'docs/README.md'
  const index = readFileSync(join(ROOT, indexRel), 'utf8')
  // 索引里的相对链接（本守卫只看 .md 目标）
  const listed: string[] = []
  for (const match of index.matchAll(/\]\(([^)\s]+\.md)\)/gu)) {
    if (match[1] !== undefined) listed.push(match[1])
  }
  const onDisk = markdownUnder('docs').filter((rel) => rel !== indexRel)

  // ① 磁盘上有、索引里没有 ⇒ 读者按索引找不到它（本轮真踩过：当轮交接与最新复测报告）
  const missing = onDisk.filter((rel) => !listed.includes(rel.slice('docs/'.length)))
  assert.deepEqual(missing, [], `docs/README.md 漏收录：${missing.join('、')}`)

  // ② 索引里写了、磁盘上没有 ⇒ 死链（改名/删除后忘了改索引）
  const dead = listed.filter((target) => !existsSync(join(ROOT, indexRel, '..', target)))
  assert.deepEqual(dead, [], `docs/README.md 里的死链：${dead.join('、')}`)

  // ③ 索引收录的每一篇都必须是 docs/ 下的真实文档（不许指到目录外）
  const outside = listed.filter((target) => target.includes('..'))
  assert.deepEqual(outside, [], `索引不许指向 docs/ 之外：${outside.join('、')}`)

  // 反自身：这篇索引确实列出了绝大多数文档，而不是空表
  assert.ok(listed.length >= onDisk.length, `索引只列了 ${listed.length} 条，磁盘上有 ${onDisk.length} 篇`)
})

test('M89-03 索引与文档的"权威顺序"仍然写在实际位置（防目录改名后索引失语）', () => {
  const index = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
  for (const anchor of ['src/**', 'README.md', 'CHANGELOG.md', 'docs/plan/**', 'docs/verification/**']) {
    assert.ok(index.includes(anchor), `索引的权威顺序里必须仍写着 ${anchor}`)
  }
  // 索引指向的四个目录必须真实存在（顶层 docs 子目录）
  for (const dir of ['design', 'plan', 'verification']) {
    assert.ok(existsSync(join(ROOT, 'docs', dir)), `索引提到 docs/${dir}/，但它不存在`)
  }
  assert.ok(dirname(join(ROOT, 'docs', 'README.md')).endsWith('docs'), '索引本身必须待在 docs/ 里')
})
