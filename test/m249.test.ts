/**
 * **措辞守卫**（`TASK-243`）：`src/` 里的强断言必须带限定语；确要保留，就只能登记进基线
 * **并写明非空 `why`**（`why` 是必填项 —— 写「以后再说」这类空话视同为空 ⇒ 红）。
 *
 * 立案依据（office 2026-10-25 裁定）：本族已发生 14 次漂移（写本卡时），逐条都是**新写**的断言
 * （`TASK-231` 的 `pool.ts:561`、`REV-105` 的措辞、`TASK-237` 的 `orphanLocks` 注释），
 * 而存量站点**没有一处**是 bug 现场 ⇒ 治**新增**才是止血点。
 *
 * ⚠️ **本守卫不声明的事（必须一起读）**：
 *   · 存量条目的 `why` 一律是 `grandfathered: 2026-10-25 存量快照，未审` —— 它们是**未审的存量**，
 *     登记为技术债快照；本守卫**不宣称**这批今天就成立，也不宣称措辞面已收口；
 *   · 存量递减**不在本卡范围**（会在后续触碰那些文件的卡里顺带递减，或另立卡）；
 *   · **已知缝隙（如实登记，别当它不存在）**：字面表抓不住**换词变体**。本卡在飞期间落的第 15 次
 *     （`TASK-248`，`8db077b`）把那句假断言从「结构上**不可能进入**台账」换成「结构上**进不了**台账」
 *     —— `REV-110` 判决因此把判据升级成**二维轴**（见下），`结构上×进不了` 现在抓得住；
 *     但**否定词被拉远**的形态仍抓不住，例如「任何情况下都**不会**漏」里 `任何` 与 `不会` 隔得很开
 *     （轴要求紧邻，理由见 `AXIS_MAX_GAP`）。这一族由字面表兜（`不会漏` 已在表里），兜不住的只能靠 review。
 *   · **粒度**：一行 = 一个站点、也 = 一句（本仓断言按行写）。轴的两端必须在**同一行**且紧邻，
 *     不跨行配对 —— 跨行配对在本仓全是巧合（实测）。
 *
 * **机制的实情（上一版写错过，`TASK-243` 更正）**：门**不是**「或进基线就完事」。上一版同时要求
 * 「条数上界 = 当前条数」和「新增须带 `why`」—— 两条互斥：上界=当前条数 ⇒ 根本不许新增 ⇒ `why`
 * 永远用不上 ⇒ 那扇门**不存在**（上一版的第③态在「条数不超过上界」的保证下 `slice` 必然恒空）。
 * 现在只留一条：**任何条目的 `why` 必须非空，且必须说明「该断言为何在本范围成立」**；
 * 递增**不需要**先过 review，但 `why` 的内容由 review 判（是不是真的说了理由）。
 *
 * 判据 = **三族词 × 一个前提**（`REV-110` 判决第 11/13 条，`REV-108` 必核三的正面回答）：
 *   · 族① **字面表**（`STRONG_PHRASES`）：`唯一出口` / `所有分支可见` / `必然收口` 这类**没有否定词**
 *     的强断言 —— 二维轴看不见它们（轴只抓「全称 × 否定」），所以字面表必须留着；
 *   · 族② **二维轴**（`UNIVERSAL_AXIS × NEGATION_AXIS`，紧邻即命中）：抓「换词」—— 换掉字面表里的词
 *     不等于换掉这套语法形态；
 *   · 族③ **正向式**（`POSITIVE_PHRASES`）：零否定、零全称，却声称"更强的机制"（「同一事务」「必须同生同死」）；
 *   · **前提**（`QUALIFIER_RE`）：命中行 ±1 行窗口里出现限定语/前提从句 ⇒ 不判。**第 12 条要求先扩它**
 *     —— 顺序反了就是「判据比机制严」，那比没有守卫更糟（会把真红淹掉）。
 *
 * 基线**不用 `file:line`**（行号会漂：`REV-106`#5 的 seq 8407 锚点今天就过期了），
 * 按「文件 + 该行去空白后的原文」做**多重集**（同文件同文本出现次数也要对得上）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/**
 * **族①：字面强断言词**（删词就是**放宽**判据 ⇒ 本表**只许加不许减**）。
 *
 * `TASK-243` / `REV-108` 必核三：上一版只有 5 条子串，历史那 14 次事故的真实写法
 * （`必然收口` / `一定不会漏` / `无例外` …）**都不在表里** ⇒ 下一个 `office.ts:4431` 照样绕开。
 * 现按实证补齐：`悬空在结构上不可能`、`同生同死`、`决定与收口`、`必然收口`、`一定不会漏`、
 * `不会漏`、`无例外`、`不可能发生`、`所有分支可见`、`唯一出口`（后三条上一版已有），
 * 另加 `不留悬空`（本族被删掉的那半句真实写法）与 `不会有例外`（本卡点名的「换词」样本之一：
 * 不加它那条样本压根抓不住 —— 样本自带旧词蒙过去 ≠ 机制抓住）。
 *
 * **`进不了` / `不存在` 不在这里**：它们是**否定轴**成员（`REV-110` 第 11 条），要求与全称量词紧邻才判。
 * 提成无条件字面词会当场把 20+ 条普通叙述（"不存在的卡""不存在的实体"）算成强断言 ⇒ 判据比机制严。
 */
export const STRONG_PHRASES = [
  '唯一出口',
  '所有分支可见',
  '结构上不可能',
  '永远不可能',
  '不可能发生',
  '悬空在结构上不可能',
  '同生同死',
  '决定与收口',
  '必然收口',
  '一定不会漏',
  '不会漏',
  '无例外',
  '不会有例外',
  '不留悬空',
] as const

/** **族②的全称量词轴**（`REV-110` 第 11 条）。 */
export const UNIVERSAL_AXIS = ['结构上', '必然', '一定', '永远', '所有', '任何'] as const

/** **族②的否定可能轴**（同上）。 */
export const NEGATION_AXIS = ['不可能', '不会', '无例外', '进不了', '不留', '不存在', '没有', '不会是', '绝非'] as const

/**
 * 轴的两端**最多隔几个字**算「同句紧邻」。
 *
 * 依据是实测（现盘 `src/` 94 个文件，且已过前提窗口；口径 = 全称量词在否定词**之前**）：
 *   · **不设上限** ⇒ 仅轴命中 **40** 条，其中 **12** 条只因「任何×没有」才命中 ——
 *     本仓用它**抱怨缺机制**（"没有任何判据核对"），语义正好相反；
 *   · 若按"同句出现即可、不看先后"记数 ⇒ 匹配 **169** 行，其中 **120** 行（71%）只因「任何×没有」
 *     —— 这就是那对组合必须排除的原因（它不是断言，是缺机制的抱怨格式）；
 *   · `≤4` ⇒ 仅轴命中 **11** 条，逐条人工核过：`永远不会和全文的总览对不上`（`reviewDoc.ts:170`）、
 *     `残片永远不会告警`（`office.ts:5548`）、`任何…不会产生 journal 事件` 之类**都是**本族该抓的形态。
 * 所以取 4：轴抓的是「量词紧贴着被否定的谓语」这种**语法上就在声称全称**的写法；
 * 隔得远的（"任何情况下都不会漏"）交给字面表（`不会漏` 在表里）。
 */
export const AXIS_MAX_GAP = 4

/** 轴上**明确排除**的组合（实测唯一的成规模噪音源，见 `AXIS_MAX_GAP` 的读数）。 */
export const AXIS_EXCLUDED_PAIRS = ['任何×没有'] as const

/**
 * **族③：正向断言**（`REV-110` 第 13 条）：零否定、零全称，却在声称"更强的机制"。
 *
 * 为什么是**带谓词的形态**而不是裸 `原子`：现盘 10 处 `原子` 命中里 8 处是 `原子写`
 * （= 临时文件 + `rename` 的**机制名**，见 `infra/store.ts:86`）。把它当强断言 ⇒ 8 条噪音，
 * 且以后每写一次「原子写」都要登记 `why` —— 那正是第 12 条要防的「判据比机制严」。
 * `原子落地` / `一次落地` / `同一事务` / `一次事务` / `同生同死` 才是"声称等价于事务"的那句话本身。
 */
export const POSITIVE_PHRASES = ['同一事务', '一次事务', '原子落地', '一次落地', '同生同死'] as const

/**
 * 正向词的**否定前缀豁免**：`不等于一次事务` / `并非原子落地` 是在**否认**那个声称，
 * 不是声称。命中词前 6 个字符里出现否定词 ⇒ 不算正向断言。
 */
export const POSITIVE_DENIAL_RE = /(不|非|无|未|没|从不|绝不)/

/**
 * **前提识别**（`REV-110` 第 12 条：先扩它，再叠 why 白名单）。
 *
 * 上一版只认 `本X` / `前提下` / `范围内` / `限于` / `同一出口` —— **认不出把前提写成地点从句的形态**，
 * 于是「**不在仓库内** ⇒ 结构上不可能进索引」（`worktree.ts:24`）会被当成无限定语的强断言。
 * 现补：`前提`（原 `前提下` 的超集）、`在…内` / `不在…内`、`之外`。
 * 实测：扩前 `worktree.ts:24` 判红、扩后不判（同类一共 1 条，读数见报告）。
 *
 * ⚠️ **故意没放裸 `范围`**：实测它会把 **7 条真正的强断言**挡掉 —— 「追加的**范围**不得与另一张在飞卡相交」
 * 「两张卡的写**范围**相交该不该串行」「与写**范围**判定同一套语义」里的「范围」是**主语**，不是前提。
 * 保留 `范围内` 就够（那才是前提形态）。这一条是"放宽必须逐条有读数"的例子。
 */
export const QUALIFIER_RE = /(本[层模块文件函数判据侧卡条批仓处]|这一?[层处侧]|前提|范围内|口径下|就本|对此?判据|本实现|在本|如本|限于|只在这里|同一出口|不?在[^。；\n]{0,12}内|之外)/

/**
 * **扩前的旧前提正则**（只用于「扩前/扩后误报对照」这条读数，判据本身用 {@link QUALIFIER_RE}）。
 * 留一份原件而不是在注释里描述"以前是什么"：对照要能机械复跑。
 */
export const QUALIFIER_RE_BEFORE_243 = /(本[层模块文件函数判据侧卡条批仓处]|这一?[层处侧]|前提下|范围内|口径下|就本|对此?判据|本实现|在本|如本|限于|只在这里|同一出口)/

/** 命中来自哪一族（诊断用；`phrase` 就是命中的那个词/那一对）。 */
export type ClaimKind = 'literal' | 'axis' | 'positive'

export interface StrongClaimHit {
  file: string
  line: number
  text: string
  phrase: string
  kind: ClaimKind
}

/** 轴配对：返回本行里**紧邻**成立的 `全称×否定` 组合（排除 {@link AXIS_EXCLUDED_PAIRS}）。 */
export function axisPairsOf(line: string): string[] {
  const out: string[] = []
  for (const universal of UNIVERSAL_AXIS) {
    let at = line.indexOf(universal)
    while (at !== -1) {
      for (const negation of NEGATION_AXIS) {
        const pair = `${universal}×${negation}`
        if ((AXIS_EXCLUDED_PAIRS as readonly string[]).includes(pair)) continue
        const from = at + universal.length
        const next = line.indexOf(negation, from)
        if (next !== -1 && next - from <= AXIS_MAX_GAP) out.push(pair)
      }
      at = line.indexOf(universal, at + 1)
    }
  }
  return [...new Set(out)]
}

/** 正向词命中（带否定前缀豁免）。 */
export function positivePhrasesOf(line: string): string[] {
  const out: string[] = []
  for (const phrase of POSITIVE_PHRASES) {
    let at = line.indexOf(phrase)
    while (at !== -1) {
      const before = line.slice(Math.max(0, at - 6), at)
      if (!POSITIVE_DENIAL_RE.test(before)) out.push(phrase)
      at = line.indexOf(phrase, at + 1)
    }
  }
  return [...new Set(out)]
}

/**
 * 扫一份文件集合，返回**未限定**的强断言（纯函数：不碰磁盘，便于双态探针）。
 *
 * **一行 = 一个站点**：同一行命中一族里多个词只记**一条**（`phrase` 取表里最长的那个，只为诊断）。
 * 不这么做的后果：`一定不会漏` ⊃ `不会漏` 这类包含关系会让同一行在基线上要登记**两遍**，
 * 条数就不再是"站点数"，读的人也没法对账。
 * **族之间按 字面 > 轴 > 正向 取第一个命中的族**（三族会同时命中同一行，只记一次）。
 */
export function scanStrongClaims(files: readonly { path: string; text: string }[]): StrongClaimHit[] {
  return scanStrongClaimsWith(files, QUALIFIER_RE)
}

/**
 * 同 {@link scanStrongClaims}，但前提正则可换 —— 只为一件事：让「扩前/扩后误报对照」这条读数
 * 能用**同一套判据**跑两遍（换前提一处），而不是在注释里描述"扩前会怎样"。
 */
export function scanStrongClaimsWith(
  files: readonly { path: string; text: string }[],
  premise: RegExp,
): StrongClaimHit[] {
  const hits: StrongClaimHit[] = []
  for (const file of files) {
    const lines = file.text.split('\n')
    lines.forEach((line, index) => {
      const literal = STRONG_PHRASES.filter((phrase) => line.includes(phrase))
      const axes = axisPairsOf(line)
      const positives = positivePhrasesOf(line)
      if (literal.length === 0 && axes.length === 0 && positives.length === 0) return
      const window$ = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join(' ')
      if (premise.test(window$)) return
      const longest = (list: readonly string[]): string => list.reduce((long, next) => (next.length > long.length ? next : long), '')
      const hit: { phrase: string; kind: ClaimKind } = literal.length > 0
        ? { phrase: longest(literal), kind: 'literal' }
        : axes.length > 0
          ? { phrase: longest(axes), kind: 'axis' }
          : { phrase: longest(positives), kind: 'positive' }
      hits.push({ file: file.path, line: index + 1, text: line.trim(), ...hit })
    })
  }
  return hits
}

/**
 * 读 `src` 下所有 `.ts` 源码（不碰 `test/` 与生成物）。
 *
 * 导出只为一件事：**基线重算**直接吃这同一份读数（不另写一套抽取逻辑 —— 两套必然分叉）。
 */
export function readSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        out.push({ path: full.slice(REPO.length).replace(/\\/gu, '/'), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(join(REPO, 'src'))
  return out
}

export interface StrongClaimEntry {
  file: string
  text: string
  /** **必填**：该断言为什么在本范围成立。空 / 空话 ⇒ 判据③ 红。 */
  why: string
}

/**
 * **技术债快照**（未审）：形状 = `{ file, text, why }`，**不含行号**；比较按**多重集**。
 *
 * 增删规则（`TASK-243` 更正后只剩一条）：**任何条目的 `why` 必须非空且说明理由**；
 * `grandfathered:` 前缀只属于 2026-10-25 这批存量快照 —— 真新增的条目不许用它搪塞，
 * 那属于 review 的判断面（机制只保证"`why` 不为空、不是空话"）。
 * 条目递减照旧自由（同步删行即可，理由见判据②）。
 */
export const KNOWN_STRONG_CLAIMS: StrongClaimEntry[] = [
  { file: "src/domain/collab.ts", text: "* **`fixes` 声明的唯一出口**（判据 `C-63` 与 `done` 回显共用同一份口径）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "* **`mitigates` 声明的唯一出口**（判据 `C-64` 与 `done` 回显共用同一份口径）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "* **两个写者的机械防线**：追加的范围不得与**另一张在飞卡**相交（判定走唯一出口）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "* **卡级 `inputs` / `outputs` 声明的唯一出口**（DEF-051 / TASK-080，判据 `C-64` 的第二、三子句；", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "* 判定与读侧同源：`unsettledDispatch`（`domain/dispatchHealth.ts`）是唯一出口，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "* （职责全文、REQ 验收标准、能力名），而一句散文永远不可能被一条文件路径包含 ⇒ 逐条假红。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "// 判别位与派发面**同源**：一律走 `staleEntryGateOf`（唯一出口），只拦 `stale`，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/collab.ts", text: "// 判定走**唯一出口** `scopeIntersections` / `scopeSerialKindOf`，与派发面 `scopeHeldTasks`", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/construction.ts", text: "* **豁免清单的唯一出口**（DEF-030）：回执、看板、状态描述都从这里取，避免三处各印一份而分叉。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/design.ts", text: "* `confirmed`、`project.json` 等。手改其中任何一个**不会**产生 journal 事件，只按 journal 建键就会命中旧渲染。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/dispatchFace.ts", text: "* 现在把展开交给唯一出口 `pool.reuseSkippedRowsFromEvents`（它同时处理老形状/聚合/引用，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/entryGate.ts", text: "* **当前阶段入口门禁的签字状态**（DEF-040 / §3E 族 6）—— 这一条判据的**唯一出口**。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/entryGate.ts", text: "* **收敛到唯一出口**，其余地方一律调它。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/gates.ts", text: "* 两者都不动对方的实现：判定全在 `trace.ts` 的**唯一出口** `assessDefectLinks`，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/grill.ts", text: "* **D-3（sdo-test-new 2026-10-08，major）**：模型通道的问题以前**结构上不可能**带选项。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "* **两张卡之间是否已存在依赖序**（⇒ **不可能并行**）—— 这是\"是否可能并行\"的**唯一出口**（DEF-044）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "* **两张卡的写范围相交该不该串行**（`REQ-066` / `AC-303` 的**唯一出口**：认领面与派发面共用）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "* ⚠️ **本类型是纯函数的入参形状**：装配它的唯一出口是 `domain/entryGate.ts` 的", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "* 判定走**唯一出口** `scopeOverlaps`（归一 + 目录边界前缀，与认领期/计划期同一套语义）；", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "* 判据说\"可能并行但写范围重叠\"，派发面却永远不会把它们同时派出（真机表现：合法的排队卡被当成冲突）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/plan.ts", text: "* 派发**无人拦**。判定仍走唯一出口 `scopeOverlaps`（只用到路径集合这一个事实 ⇒ 语言/项目无关），", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "*（`blockedTasks` 只认\"指向未结束的卡\"，被作废的引用会变成\"依赖一张永远不会完成的卡\"而**永久卡住**）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/plan.ts", text: "// **ADR-009 / DEF-057**：唯一出口（归一 + 目录边界前缀）—— 旧的双向 `startsWith`", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "// **DEF-044**：唯一出口（三处逐字同一行是这条缺陷的成因，别再各写一遍）", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "// **DEF-044**：走**唯一出口** —— 认 `'*'` 与**传递依赖**（修前这行既不认星号也不算闭包，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "// **唯一出口**：认领面（`collab.claim`）与这里共用 `scopeSerialKindOf` —— 两面分叉就会出现", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/plan.ts", text: "// 路径代数走 `scopeOverlaps` **唯一出口**（ADR-009：归一 + 目录边界前缀），与既有各条同一把尺子。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/pool.ts", text: "* \"结构上必然收口\"的强断言（旧版本正是这么写的，被 `REV-104` #2 推翻）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/pool.ts", text: "* ⚠️ 措辞更正（`REV-104` #5）：上一版把它写成\"唯一出口\"，而 `recoverView` / `inflightView`", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/pool.ts", text: "* 折叠出**每一笔派发决定**的收口状态（`TASK-231` 落点一 / 落点三的唯一出口）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* **已修但无测试结论的缺陷**（DEF-075 / 第三批 §3.8）—— 判据的唯一出口。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* **待修主张必须带\"当前仍失败的复现命令\"**（DEF-048 / 第三批 §3.16）—— **唯一出口**。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* **评审点名的缺陷必须真实存在**（DEF-076 / 第四批 §3.3）—— **唯一出口**。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* **调用方声明的产物哈希与现算值对账**（DEF-011 / 第三批 §3.9）—— 唯一出口。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* **阻塞级缺陷的四态分类**（防御门禁 C-51 与读数共用的**唯一出口**）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/records.ts", text: "* 每个 id 必须**真实存在**（`reviewDefectIssue` 是唯一出口；未知 id ⇒ 可读拒绝、零写盘）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/releaseTool.ts", text: "/** 一次调用要用的台账入口（域层不自己拼绝对路径：`SdoStore` 才是路径沙箱的唯一出口）。 */", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/reviewDoc.ts", text: "* 两处用的是**同一个** `metaLines`，所以摘要永远不会和全文的总览对不上。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/reviewVerification.ts", text: "* **有 `pass` 测试结论、却没有被已采纳评审点名的 `fixed` 缺陷**（DEF-076 / 第四批 §3.3）—— 判据的唯一出口。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/snapshot.ts", text: "/** 一个\"挡路者\"的结构化读数 + 人读细节（两栏同生同死，避免回执与快照各说一半）。 */", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/trace.ts", text: "// 于是 `req-task` / `req-tc` 指向不存在的卡或用例、以及任何指向不存在需求的边，都能**静默建起来** ——", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/trace.ts", text: "// 现在：任何一端指向不存在的实体（或 id 不属于任何已知类别）⇒ **整条边抛错、不落盘**（不是跳过那一端）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/domain/unfrozen.ts", text: "* **「未冻结完成 ⇒ 交付前必须有一次全量绿」**（DEF-033 第三面 / 第四批 §3.5）—— 判据的**唯一出口**。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/unfrozen.ts", text: "* 读出这条要求的现状（**唯一出口**：判据、回执、测试都读它，不各写一份）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/domain/writeScope.ts", text: "// **ADR-009**：公共面命中同样走唯一出口（目录边界前缀），与写范围判定同一套语义", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "* 上一版这里写着「所有分支可见」，那句是过度声称。**", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "* 悬空的派发决定在这里**一个字都不印**（评审也是在这一点上推翻了我上一版「所有分支可见」的", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "// **D-3**：`options`/`recommendation` 也在这里接受（模型通道以前结构上不可能带选项）", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "// **N-10（R-23③ / R-29③）**：撤销一条豁免 —— 误探自愈的唯一出口（`waivedGates` 只增不减）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "// 判据在域层唯一出口（`reviewReproIssue`），这里只把抛出的 `ReviewReproError` 转成回执。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "// 引用者的 `blockedBy` 就指向一张**永远不会完成**的卡（永久卡住，且回执里看不出为什么）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/index.ts", text: "// 形状不对 ⇒ 当场可读拒绝；未知 id 由**域层唯一出口** `reviewDefectIssue` 拦（这里只转回执）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/index.ts", text: "// 永远没有需求链接（追溯静默漏掉这些卡）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/index.ts", text: "// 现在改用**唯一出口** `office.workspaceRootFor`：只认\"本次 cwd\"或\"本会话登记的 cwd\"", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/integration/orchestrator.ts", text: "* 采纳态的唯一出口在 `reviewVerification.ts`）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/interface/describe.ts", text: "* 「100 张卡 < 4000 字符」这条守卫就永远不可能成立）。标题截 40 字，owner 截 8 位。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/interface/tools.ts", text: "* 这里是工具定义**建好之后、注册之前**的唯一出口，类型面最小。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* **N-10（R-23③ / R-29③）：撤销一条豁免**（误探自愈的唯一出口）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 为什么单独成型而不是把三个字符串参数散在 `recordDispatch` 里：这三个键**必须同生同死**", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 判不出来的会再注入一条 —— 代价是卡面多一行，不会漏判。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 判据**复用唯一出口** `evidenceFreshness`（不另造一套\"哪条会过期\"的算法）：", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 判据本身**不在这里**：`staleEntryGateOf`（`domain/entryGate.ts`）是唯一出口，", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 真正作废仍走 `dropTask` 唯一出口；这里只回答\"作废它会把谁永久吊住\"，由调用方决定拒还是放行。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "* 聚合与\"引用上一次\"的判定都在 `pool.planReuseSkippedEvents`（唯一出口）；这里只负责落盘 ——", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "//   ② 日后给 G2 加任何判据都不会生效（配置假装数据驱动，实际被硬编码劫持）。", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/office.ts", text: "// **DEF-011**：这里**不再**一把覆盖成现算值 —— 把 `workspace` 交给域层，由**唯一出口**", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "// **DEF-021**：会话 ↔ 在飞卡 的唯一出口（同一份真源 `task/claimed` × 卡状态现算）", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "// **`TASK-219`**：脏文件与写范围的交集要落在**唯一出口**上（不另造前缀匹配）", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "// —— 判据走**唯一出口** `reviewReproIssue`（与 `recordReview` / `appendReviewFindings` 同一份）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
  { file: "src/office.ts", text: "// （2599B）时，残片**永远不会告警** —— `CHILD_REPORT_MIN_BYTES` 对它是**死判据**（真实台账实测：", why: "grandfathered: 2026-10-25 存量快照，未审（扩轴后新捕获，仍未审）" },
  { file: "src/types.ts", text: "* **唯一出口**），否则判红并**逐条点名**；**缺省 = 不声明 = 不判**（存量卡不受影响）。", why: "grandfathered: 2026-10-25 存量快照，未审" },
]

/** `why` 里的**空话**（视同为空）：写这些字眼等于没写 —— 它们不说明"该断言为何在本范围成立"。 */
export const WHY_FILLERS = [
  '以后再说',
  '见上',
  '同上',
  '待补',
  '待定',
  '暂缺',
  '不详',
  '先这样',
  'TODO',
  'FIXME',
] as const

/**
 * **判据③**：逐条点名 `why` 为空或空话的条目（纯函数 —— 写死一条 `why: ''` 必须红）。
 *
 * 为什么这条判据**不恒真**：上一版的第三态是 `KNOWN_STRONG_CLAIMS.slice(BASELINE_SIZE)`
 * —— 在"条数不得超过上界"的保证下那个切片**永远为空**，所以它永远是绿的（等于没判）。
 * 这里改成对**全表**逐条检查 `why`，空一条就红并点名。
 */
export function undocumentedWhy(
  rows: readonly { file: string; text: string; why?: string | undefined }[],
): string[] {
  const out: string[] = []
  for (const row of rows) {
    const why = (row.why ?? '').trim()
    if (why === '') {
      out.push(`${row.file} :: ${row.text.slice(0, 80)} :: why 为空`)
      continue
    }
    const filler = WHY_FILLERS.find((word) => why.includes(word))
    if (filler !== undefined) out.push(`${row.file} :: ${row.text.slice(0, 80)} :: why 是空话「${filler}」`)
  }
  return out
}

/** 多重集键（文件 + 去空白原文）。 */
const keyOf = (row: { file: string; text: string }): string =>
  `${row.file}\u0000${row.text.replace(/\s+/gu, ' ').trim()}`

function countBy(rows: readonly { file: string; text: string }[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows) {
    const key = keyOf(row)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

/** **判据①**：把扫描结果与基线按多重集对账，返回「**不在基线**」的那些站点（顺序保持扫描顺序）。 */
export function freshStrongClaims(
  hits: readonly StrongClaimHit[],
  baseline: readonly { file: string; text: string }[] = KNOWN_STRONG_CLAIMS,
): StrongClaimHit[] {
  const budget = countBy(baseline)
  return hits.filter((hit) => {
    const key = keyOf(hit)
    const left = budget.get(key) ?? 0
    if (left <= 0) return true
    budget.set(key, left - 1)
    return false
  })
}

test('M249-01 (probe) unqualified claim is red and names file:line; a qualified one is green', () => {
  const bad = scanStrongClaims([{ path: 'src/_probe.ts', text: '// 这是唯一出口\nconst x = 1\n' }])
  assert.equal(bad.length, 1, `an unqualified claim must be flagged: ${JSON.stringify(bad)}`)
  assert.equal(bad[0]?.file, 'src/_probe.ts', 'the hit must name the file')
  assert.equal(bad[0]?.line, 1, 'the hit must name the line')
  const good = scanStrongClaims([{ path: 'src/_probe.ts', text: '// 本层唯一入口\nconst x = 1\n' }])
  assert.equal(good.length, 0, `a qualified claim must pass: ${JSON.stringify(good)}`)
  // ±1 行窗口内的限定语同样算数（本仓最常见的写法：标题 + 下一行解释）
  const windowed = scanStrongClaims([{ path: 'src/_probe.ts', text: '// 唯一出口\n// 判据、回执、测试都读它（同一出口）\n' }])
  assert.equal(windowed.length, 0, 'a qualifier in the neighbouring line counts')
  // 一行 = 一个站点：同一行命中多个词只记一条（否则包含关系会在基线上要两遍）
  const twoWords = scanStrongClaims([{ path: 'src/_probe.ts', text: '// 这是唯一出口，而且一定不会漏\n' }])
  assert.equal(twoWords.length, 1, `one line is one site: ${JSON.stringify(twoWords)}`)
})

test('M249-02 (word swap) a new wording with no legacy literal is still red — 换词不许绕开', () => {
  // 三条点名的"换词"样本：**都不含上一版字面表里的任何词**，只靠族②/族③抓住。
  const samples = ['// 这条必然收口\n', '// 不会有例外\n', '// 无论怎么崩都不会漏\n']
  const probed = samples.map((text, index) => ({ path: `src/_swap${String(index)}.ts`, text }))
  const hits = scanStrongClaims(probed)
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${String(hit.line)}`),
    ['src/_swap0.ts:1', 'src/_swap1.ts:1', 'src/_swap2.ts:1'],
    `换词样本必须逐条判红并点名：${JSON.stringify(hits)}`,
  )
  // 反证（判据不是恒真）：同一批样本各加一个限定语 ⇒ 必须全绿
  const qualified = probed.map((file) => ({ path: file.path, text: file.text.replace('\n', '（本判据范围内）\n') }))
  const quiet = scanStrongClaims(qualified)
  assert.deepEqual(quiet, [], `加了限定语就得绿：${JSON.stringify(quiet)}`)
})

test('M249-03 (axis, REV-110 11) 全称×否定紧邻即红；隔远或前提在位就不红', () => {
  // 二维轴的正例：换掉了字面表里的每一个词，语法形态没换 ⇒ 仍红
  const axisOnly = scanStrongClaims([{ path: 'src/_axis.ts', text: '// 于是悬空决定在结构上进不了台账\n' }])
  assert.deepEqual(axisOnly.map((hit) => hit.kind), ['axis'], `轴必须抓住换词版：${JSON.stringify(axisOnly)}`)
  // 点名的组合两端都得来自**声明的轴**（期望值不写死中文：由词表现算，改轴会自动跟上）
  const pair = (axisOnly[0]?.phrase ?? '').split('×')
  const fromAxes = (UNIVERSAL_AXIS as readonly string[]).includes(pair[0] ?? '')
    && (NEGATION_AXIS as readonly string[]).includes(pair[1] ?? '')
  assert.equal(fromAxes, true, `必须点名是哪个组合（两端都要来自声明的轴）：${JSON.stringify(axisOnly)}`)
  // 双态一：**紧邻**才算（隔远的不判 —— 实测那全是"任何…没有"这种抱怨缺机制的写法）
  const far = scanStrongClaims([{ path: 'src/_axis.ts', text: '// 任何读者都能看出这里不会漂移\n' }])
  assert.deepEqual(far, [], `隔远的不许按轴判（任何…不会 隔了 8 个字）：${JSON.stringify(far)}`)
  // 双态二：同句带前提 ⇒ 绿
  const premised = scanStrongClaims([{ path: 'src/_axis.ts', text: '// 在本判据范围内，结构上进不了台账\n' }])
  assert.deepEqual(premised, [], `前提在位就不判：${JSON.stringify(premised)}`)
  // 双态三：被排除的组合（"没有任何机制"是本仓抱怨缺机制的固定说法，不是声称强度）
  const complaint = scanStrongClaims([{ path: 'src/_axis.ts', text: '// 台账里没有任何机制能发现它\n' }])
  assert.deepEqual(complaint, [], `排除组合不许命中：${JSON.stringify(complaint)}`)
})

test('M249-04 (positive, REV-110 13) 正向式独立成格：声称"等价于事务"即红，否认它则绿', () => {
  const claim = scanStrongClaims([{ path: 'src/_pos.ts', text: '// 这段顺序就是一次事务，两个键一次落地\n' }])
  assert.equal(claim.length, 1, `正向断言必须判红：${JSON.stringify(claim)}`)
  assert.equal(claim[0]?.kind, 'positive', `必须由族③命中：${JSON.stringify(claim)}`)
  // 双态：**否认**那个声称（"不等于一次事务"）是正确写法 ⇒ 绿
  const denied = scanStrongClaims([{ path: 'src/_pos.ts', text: '// 这段顺序不等于一次事务，后两笔之间崩溃就留悬空\n' }])
  assert.deepEqual(denied, [], `否认式不许判：${JSON.stringify(denied)}`)
  // 双态：带前提 ⇒ 绿
  const premised = scanStrongClaims([{ path: 'src/_pos.ts', text: '// 在本文件范围内，两个键一次落地\n' }])
  assert.deepEqual(premised, [], `前提在位就不判：${JSON.stringify(premised)}`)
})

test('M249-05 (state 1) no NEW unqualified strong claim may appear in src/', () => {
  const fresh = freshStrongClaims(scanStrongClaims(readSources()))
  assert.deepEqual(
    fresh.map((hit) => `${hit.file}:${String(hit.line)} [${hit.kind}:${hit.phrase}] ${hit.text.slice(0, 90)}`),
    [],
    'src/ 里出现了**不在基线**的无限定语强断言：给这句补限定语（本层 / 对 X 而言 / 在本判据下 / 不在…内）；'
    + '确需保留就把条目加进 KNOWN_STRONG_CLAIMS 并写清 why（该断言为何在本范围成立）。'
    + '改声明前先 `grep <旧措辞> src/` 列命中再改（REV-105 证实的根因：改声明凭记忆）。',
  )
})

test('M249-06 (state 2) a baseline entry that vanished from src/ is red too (no silent rot)', () => {
  const budget = countBy(scanStrongClaims(readSources()))
  const stale: string[] = []
  for (const row of KNOWN_STRONG_CLAIMS) {
    const key = keyOf(row)
    const left = budget.get(key) ?? 0
    if (left <= 0) {
      stale.push(`${row.file} :: ${row.text.slice(0, 90)}`)
      continue
    }
    budget.set(key, left - 1)
  }
  assert.deepEqual(
    stale,
    [],
    '基线已过期，请同步删条目：这些措辞在 src/ 里已经不存在（改了词或删了行）。'
    + '**不许**静默通过 —— 否则改掉一句话就永久免检。同步时请先 `grep <旧措辞> src/` 核对。',
  )
})

test('M249-07 (state 3) an entry whose why is empty or a filler is red and named', () => {
  // 红态一：`why` 缺失 / 空串（**这一格能红**：写死一条 why 为空必须红）
  const missing = undocumentedWhy([{ file: 'src/_probe.ts', text: '// 这是唯一出口' }])
  const empty = undocumentedWhy([{ file: 'src/_probe.ts', text: '// 这是唯一出口', why: '   ' }])
  assert.equal(missing.length, 1, `why 缺失必须判红：${JSON.stringify(missing)}`)
  assert.equal(empty.length, 1, `why 空串必须判红：${JSON.stringify(empty)}`)
  // 红态二：`why` 是空话（不说明"为何在本范围成立"，等于没写）
  const filler = undocumentedWhy([{ file: 'src/_probe.ts', text: '// 这是唯一出口', why: '以后再说' }])
  assert.equal(filler.length, 1, `why 是空话必须判红：${JSON.stringify(filler)}`)
  // 点名形状：必须点到文件 + 原文（不是只报个数）
  assert.equal(missing[0]?.startsWith('src/_probe.ts :: '), true, `判红必须点名文件：${JSON.stringify(missing)}`)
  // 绿态：真写了理由 / 存量快照的登记语都算数
  const reasoned = undocumentedWhy([{ file: 'src/_probe.ts', text: '// 这是唯一出口', why: '判据只读 danglingDecisions，本文件范围内没有第二条路径' }])
  const grandfathered = undocumentedWhy(KNOWN_STRONG_CLAIMS)
  assert.deepEqual(reasoned, [], `写了理由就得绿：${JSON.stringify(reasoned)}`)
  assert.deepEqual(grandfathered, [], `现存基线里不许有 why 为空/空话的条目：${JSON.stringify(grandfathered)}`)
  // 非空真：表空掉会让上面那条恒真（这里钉住总量不为零）
  assert.equal(KNOWN_STRONG_CLAIMS.length > 0, true, 'the baseline must not be emptied to fake a green')
})

test('M249-08 (premise, REV-110 12) 扩前提之后的误报对照：扩前红、扩后绿', () => {
  // 两条都是**机制描述**（把"不可能"用在了正确的地方），不是声称强度。
  // 扩前的前提正则认不出「不在仓库内」这种地点从句 ⇒ 第一条会误报。
  const location = '*      不在仓库内 ⇒ 结构上不可能进索引；`inside-repo` 是**拒绝**码，把 `.sdo/drafts/worktrees/`'
  const readOnly = '*   ① **真源仍是 `.sdo`**：本模块只读、原样解析，**不做字段映射**（结构上不可能漏字段）；'
  // 扩前读数：**同一套判据**、只把前提换成扩前那一版 ⇒ `不在仓库内` 不被认 ⇒ 误报 1 条
  const before = scanStrongClaimsWith([{ path: 'src/_premise.ts', text: location }], QUALIFIER_RE_BEFORE_243)
  assert.equal(before.length, 1, `扩前：地点从句不被认 ⇒ 这条会误报（第 12 条要防的就是它）：${JSON.stringify(before)}`)
  assert.deepEqual(scanStrongClaims([{ path: 'src/_premise.ts', text: location }]), [], '扩后：地点从句算前提 ⇒ 不判')
  assert.deepEqual(scanStrongClaims([{ path: 'src/_premise.ts', text: readOnly }]), [], '扩后：同句 `本模块` 算前提 ⇒ 不判')
  // 如实记一条**反证**：`reviewPayload.ts:8` 扩前就已经因同句 `本模块` 而绿（不在"扩前必红"之列）
  const readOnlyBefore = scanStrongClaimsWith([{ path: 'src/_premise.ts', text: readOnly }], QUALIFIER_RE_BEFORE_243)
  assert.equal(readOnlyBefore.length, 0, `这条扩前就已绿（如实读数，不许编"扩前必红"）：${JSON.stringify(readOnlyBefore)}`)
  // 反证：把前提从句拿掉，同一条断言必须判红（证明上面两条绿不是判据失灵）
  const naked = scanStrongClaims([{ path: 'src/_premise.ts', text: '      于是 ⇒ 结构上不可能进索引；`inside-repo` 是**拒绝**码。' }])
  assert.equal(naked.length, 1, `前提拿掉必须判红：${JSON.stringify(naked)}`)
})

test('M249-09 (acceptance) 两句历史原文喂进来都必须判红并点名，且都不在基线里', () => {
  // ① `TASK-231` 修前的 `src/office.ts:4431`（`git show 0f45a5a:src/office.ts` 第 4431 行）
  // ② `TASK-248` 修前的 `src/index.ts:2279`（`git show 8c2cc93:src/index.ts` 第 2279 行）——
  //    它是同一句假断言的**换词版**（不可能 → 进不了），正是 `REV-110` 第 11 条要接住的那一次。
  const original4431 = '*     于是**悬空的决定在结构上不可能进入台账**（崩溃在尝试期间 ⇒ 连 decided 都没有，不留中间态）；'
  const original2279 = '         * 事件（`outcome`），于是悬空决定在结构上进不了台账 ——'
  const simulated = [...readSources(), { path: 'src/office.ts', text: original4431 }, { path: 'src/index.ts', text: original2279 }]
  const fresh = freshStrongClaims(scanStrongClaims(simulated))
  assert.deepEqual(
    fresh.map((hit) => `${hit.file}:${String(hit.line)}:${hit.kind}`),
    ['src/office.ts:1:literal', 'src/index.ts:1:axis'],
    `两句今天若被新写，都必须判红并点名；实际读数：${JSON.stringify(fresh.map((hit) => `${hit.file}:${String(hit.line)} [${hit.kind}:${hit.phrase}]`))}`,
  )
  // 钉住「它们不在基线」—— 否则上面那条绿会变成"它在基线里所以绿"的自欺
  const registered = KNOWN_STRONG_CLAIMS.some((row) => row.text === original4431 || row.text === original2279)
  assert.equal(registered, false, '这两句都已从 src/ 删除 ⇒ 基线里不许还留着（否则 M249-06 会判它过期）')
})
