/**
 * **增量 189：第八批 §3.3（`DEF-088`）+ §3.5（`R19`）。**
 *
 * §3.3 的旧判据只有"关键词 + DEF 号"一句 ⇒ V16 实测**既不充分也不必要**（合法引用假阳性、英文悬空漏判、
 * 保留措辞掏空语义仍绿）。新判据只认**标识符的可解析性**与**结构标记内的逐字相等**（见 `test/docRefs.ts`），
 * 因此**同一条判据对中文与英文写入给出同一个判定** —— 这同时就是 §3.5 要求的"两种书写形态自证"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { checkDocFiles, checkDocs, normalizeNote, repoDocFaces } from './docRefs.js'
import {
  EXEMPTION_CLASSES, PAIRED_PROOFS, REJUDGED, auditDeclaredExemptions, auditPairedProofs, classifySite,
  extractProseSites, loadLangPack, siteKey,
} from './proseInventory.js'
import type { PackValue, PairedProof, ProseSite } from './proseInventory.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm189')
/** 真实例（只读观测，不进单测）用的实例路径不在单测里出现（DoD ③）。 */
beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 目录下全部 `.ts`（helper 也在内 —— `DEF-095` 的注释守卫要看它们）。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

/** 相对仓库根的路径（`ROOT` 自带尾斜杠，别用字符串拼）。 */
const relPath = (path: string): string => (path.startsWith(ROOT) ? path.slice(ROOT.length).replace(/^\//u, '') : path)

/** 测试文件遍历（本用例要现算"清单面"）。 */
function walkTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTests(full, out)
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out.sort()
}
/** 宽口径判定（含**断言消息**）：V19 的 177 是这么数的 —— 与"判取值"口径分开报。 */
const CJK_IN_LITERAL = /['"`][^'"`\n]*[\u4e00-\u9fff][^'"`\n]*['"`]/u

const carrier = (id: string, body: string): string => ` * ${'sdo:carrier'} ${id}\n * ${body}\n * ${'sdo:carrier-end'}\n`
const referral = (id: string, quote: string): string => ` * ${'sdo:ref'} ${id}\n * ${'sdo:quote:begin'}\n * ${quote}\n * ${'sdo:quote:end'}\n`

test('M189-01 ① 合法引用不许红（中英文各一格）+ 判定**两语言一致**', () => {
  const zhBody = '认不出归属时不硬猜：不施加掩码；若宿主允许无名会话则改 fail-closed'
  const enBody = 'when attribution is unknown, do not guess: apply no mask; if unnamed sessions become possible, fail closed'
  for (const [body, label] of [[zhBody, '中文'], [enBody, '英文']] as const) {
    const docs = [{ path: 'carrier.ts', text: carrier('r17', body) }, { path: 'referrer.ts', text: referral('r17', body) }]
    assert.deepEqual(checkDocs(docs), [], `${label}合法引用（载体存在 + 逐字引文）不许红`)
  }
  // 标识符解析：`DEF-054` 在别处出现 ⇒ 不红；`DEF-999` 查无此号 ⇒ 红（中英文同样对待）
  const okDef = [{ path: 'a.ts', text: ' * 本文件的归属结论记在 DEF-054。\n' }, { path: 'b.ts', text: ' * DEF-054 的判定：向上爬会串账。\n' }]
  assert.deepEqual(checkDocs(okDef), [], '别处可解析的 DEF 号不许红（V16 的假阳性就是这一格）')
  const badDefZh = [{ path: 'a.ts', text: ' * 结论记在 DEF-999。\n' }]
  const badDefEn = [{ path: 'a.ts', text: ' * The conclusion is recorded in DEF-999.\n' }]
  assert.deepEqual(checkDocs(badDefZh).map((issue) => issue.kind), ['dangling-id'], '中文悬空 DEF 号必须红')
  assert.deepEqual(
    checkDocs(badDefEn).map((issue) => issue.kind),
    checkDocs(badDefZh).map((issue) => issue.kind),
    '同一情形的英文写法必须给出**同一个判定**（语言无关）',
  )
})

test('M189-02 ① 第二种形态：指向代码里的真实定义（`` `file.ts` `` 的 `` `symbol` ``）', () => {
  const docs = [
    { path: 'a.ts', text: ' * 判定机制详见 `test/docRefs.ts` 的 `checkDocs`。\n' },
    { path: 'test/docRefs.ts', text: 'export function checkDocs(): void {}\n * `test/docRefs.ts` 的 `checkDocs`\n' },
  ]
  assert.deepEqual(checkDocs(docs), [], '指向真实定义的引用不许红')
  const bogus = [
    { path: 'a.ts', text: ' * 判定机制详见 `test/docRefs.ts` 的 `noSuchSymbol`。\n' },
    { path: 'test/docRefs.ts', text: 'export function checkDocs(): void {}\n' },
  ]
  assert.deepEqual(checkDocs(bogus).map((issue) => issue.kind), ['dangling-id'], '指向不存在的定义必须红')
})

test('M189-03 ②③ 承载性：载体缺失 / 引文为空 / 引文与载体不逐字相等（后一种 = 保留措辞掏空语义）都必红', () => {
  const body = '认不出归属时不硬猜'
  // ② 载体缺失（中英文各一格：措辞不同，判定相同）
  const missingZh = [{ path: 'r.ts', text: referral('r17', body) }]
  const missingEn = [{ path: 'r.ts', text: ` * ${'sdo:ref'} r17\n * ${'sdo:quote:begin'}\n * no guessing when attribution is unknown\n * ${'sdo:quote:end'}\n` }]
  assert.deepEqual(checkDocs(missingZh).map((issue) => issue.kind), ['missing-carrier'], '中文：载体缺失必须红')
  assert.deepEqual(checkDocs(missingEn).map((issue) => issue.kind), ['missing-carrier'], '英文：载体缺失必须红（同一判定）')
  // 引文为空
  const empty = [{ path: 'c.ts', text: carrier('r17', body) }, { path: 'r.ts', text: ` * ${'sdo:ref'} r17\n * ${'sdo:quote:begin'}\n * ${'sdo:quote:end'}\n` }]
  assert.deepEqual(checkDocs(empty).map((issue) => issue.kind), ['empty-quote'], '引文为空必须红')
  // ③ 保留措辞、掏空语义（引文换成空话）⇒ 不逐字相等 ⇒ 红
  const hollowed = [{ path: 'c.ts', text: carrier('r17', body) }, { path: 'r.ts', text: referral('r17', 'TBD') }]
  assert.deepEqual(checkDocs(hollowed).map((issue) => issue.kind), ['quote-mismatch'], '掏空语义必须红')
  // 反例（不是恒红）：把引文**逐字写回**载体结论 ⇒ 绿
  assert.deepEqual(checkDocs([{ path: 'c.ts', text: carrier('r17', body) }, { path: 'r.ts', text: referral('r17', body) }]), [], '逐字相等时不许红')
})

test('M189-04 §3.5/§3.6（R19 / DEF-093）①：候选由**抽取器**按实际行为列出（作者自报不产生任何豁免效果）', () => {
  const pack = loadLangPack(ROOT)
  // 抽取器：一条真读散文的断言 ⇒ 无条件在册（抽不出来是抽取器的漏洞，不是作者的声明能决定的）
  const sites = extractProseSites([{ path: 'x.test.ts', text: '  assert.match(receipt, /暂不可派/u)\n' }])
  assert.equal(sites.length, 1, '内联中文 + 读文本调用 ⇒ 必须在候选集里')
  assert.equal(sites[0]?.kind, 'partial', '部分匹配（读渲染文本）必须标成 partial')
  // 谎报：真读散文却自报"只读结构化键值" ⇒ **被抓**（第八批旧口径正是在这里被放过）
  const lying = [{ site: siteKey(sites[0] as ProseSite), why: '只看字段名与取值，不看散文（写得足够长也没有用）' }]
  const caught = auditDeclaredExemptions(lying, sites, pack)
  assert.equal(caught.length, 1, '谎报豁免必须被抓')
  assert.match(caught[0]?.detail ?? '', /谓词判 prose/u, '抓的依据必须是**谓词**（不是作者自报的字段）')
  // 正例：逐字等于语言包取值的站点 ⇒ 豁免成立，且理由必须带**可核键路径**
  const sample = pack[0] as PackValue
  const labelSite: ProseSite = { path: 'x.test.ts', line: 7, kind: 'exact', literal: sample.value }
  assert.equal(classifySite(labelSite, pack).cls, 'label', '语言包里的取值 ⇒ label')
  assert.deepEqual(
    auditDeclaredExemptions([{ site: 'x.test.ts:7', why: `语言包键 \`${sample.key}\`` }], [labelSite], pack),
    [],
    '带真键路径的豁免必须放行',
  )
  // 语言无关：同一段英文进不了候选集（判据只看字形，不需要"英文豁免"）
  assert.deepEqual(extractProseSites([{ path: 'en.test.ts', text: '  assert.match(receipt, /no card is dispatchable/u)\n' }]), [])
  // 归一函数必须**语言中立**（只去注释符、折叠空白）
  assert.equal(normalizeNote(' * 认不出  归属'), normalizeNote('*认不出 归属'), '归一与语言无关（只做字形处理）')
  assert.equal(normalizeNote('// no  guessing'), 'no guessing')
})

test('M189-05 真实树（只读扫描）：**引用面** `src/**` 的缺陷号引用全部可解析；符号引用用棘轮钉住', () => {
  // **两个面必须分开**（第一版混在一起 ⇒ 把任务书里的示例号 `DEF-999` 误报成悬空；如实记）：
  // 引用面 = `src/**/*.ts`（我们只patrol 代码注释里的引用）；见证面 = 它 + `docs/**/*.md`。
  const { citations, witnesses } = repoDocFaces(ROOT)
  assert.ok(citations.length >= 30, `引用面必须够宽（实际 ${citations.length} 个文件）`)
  assert.ok(witnesses.length > citations.length, '见证面必须比引用面宽（含 docs/）')
  const issues = checkDocFiles(citations, witnesses)
  const defects = issues.filter((issue) => /^DEF-\d/.test(issue.detail))
  assert.deepEqual(defects, [], `代码注释里的缺陷号引用必须全部可解析：${JSON.stringify(defects).slice(0, 800)}`)
  // 符号引用：**棘轮下界 = 0**（`DEF-092` 采取"先修抽取器、再回 0"那条路：两条旧假阳性形态——散文里的命令名、
  // 并列文件清单——现在**根本不被认证**，于是"余量 0 的永久豁免"没有了；任何**新的真悬空**立刻在这条断言上红）。
  const symbols = issues.filter((issue) => !/^DEF-\d/.test(issue.detail))
  const KNOWN_STALE = 0
  assert.equal(
    symbols.length,
    KNOWN_STALE,
    `符号引用悬空数必须为 ${KNOWN_STALE}（新真悬空直接红）：${JSON.stringify(symbols).slice(0, 800)}`,
  )
})

test('M189-06 §3.4（DEF-091）：被指符号取"结构上最近的那一个" —— S2/S3 同判、连举多词喂不饱、反例不动', () => {
  const witness = { path: 'lib.ts', text: 'export function realWord(): void {}\nexport const alsoReal = 1\n' }
  const cite = (line: string): { path: string; text: string }[] => [witness, { path: 'a.ts', text: ` * ${line}\n` }]
  // S3：悬空符号（行里没有别的反引号词）⇒ 红
  const s3 = checkDocs(cite('见 `lib.ts` 的 `dangling`。'))
  // S2：**同一处**悬空 + 行里另写一个真词（旧口径"行里所有反引号词都是候选"正是在这里被喂饱 ⇒ 绿）
  const s2 = checkDocs(cite('见 `lib.ts` 的 `dangling`，另外 `realWord` 也在用。'))
  assert.deepEqual(s3.map((issue) => issue.kind), ['dangling-id'], 'S3 必须红')
  assert.deepEqual(s2.map((issue) => issue.kind), s3.map((issue) => issue.kind), 'S2/S3 必须同判（都红）')
  // ② 真机现场"注释里连着举好几个"：真词排在悬空符号**后面** ⇒ 仍必须红
  const many = checkDocs(cite('见 `lib.ts` 的 `dangling`、`realWord` 与 `alsoReal`。'))
  assert.deepEqual(many.map((issue) => issue.kind), ['dangling-id'], '连举多个真词不许放过真悬空')
  // ④ 反例：行里多写**不存在**的词 ⇒ 判定不变（红还是红）
  const extraBogus = checkDocs(cite('见 `lib.ts` 的 `dangling`，另外 `notHere` 也不存在。'))
  assert.deepEqual(extraBogus.map((issue) => issue.kind), ['dangling-id'], '多写不存在的词 ⇒ 判定不变')
  // 反例的反面（证明没被改成"一律红"）：指向真符号 + 多写不存在的词 ⇒ 仍然绿
  assert.deepEqual(checkDocs(cite('见 `lib.ts` 的 `realWord`，另外 `notHere` 也不存在。')), [], '真符号 + 不存在的词 ⇒ 仍绿')
  // 中英一致（同一情形两种书写形态同判）：英文格同样红
  assert.deepEqual(
    checkDocs(cite('see `lib.ts` the `dangling`, and `realWord` too.')).map((issue) => issue.kind),
    ['dangling-id'],
    '英文写法必须同判',
  )
})

test('M189-07 §3.5（DEF-092）+ §3.4 豁免面：两条旧假阳性**真的不再被认证**，三条豁免形态逐条钉住', () => {
  const witness = { path: 'lib.ts', text: 'export function realWord(): void {}\n' }
  const cite = (line: string, extra: { path: string; text: string }[] = []): { path: string; text: string }[] =>
    [witness, ...extra, { path: 'a.ts', text: ` * ${line}\n` }]
  // 旧假阳性①（`reviewDoc.ts:469` 形态）：路径后面是**散文里的命令名**（间隔超限）⇒ 这一对不被认证
  assert.deepEqual(cite('修正前 `lib.ts` 组合成一棵树再 `tsc` —— 旧类型里没有这个字段。').length, 2, '夹具自检')
  assert.deepEqual(checkDocs(cite('修正前 `lib.ts` 组合成一棵树再 `tsc` —— 旧类型里没有这个字段。')), [], '命令名不是符号（间隔超限）⇒ 不被认证')
  // 旧假阳性②（`records.ts:199` 形态，**逐字复制真行**）：并列文件清单 ⇒ 第一对（`gates.ts`）不再被认证；
  // 第二对（`records.ts` 的 `blockersOpen`）按同一结构规则判定 —— 而它本来就真在那个文件里 ⇒ 整行不红。
  assert.deepEqual(
    checkDocs([
      { path: 'records.ts', text: 'export function blockersOpen(): void {}\n' },
      { path: 'gates.ts', text: 'export const g = 1\n' },
      { path: 'a.ts', text: ' * 为什么不把这件事散在 `gates.ts` 与 `records.ts` 各写一遍：`blockersOpen` 是既有读数、\n' },
    ]),
    [],
    '旧假阳性②（`gates.ts#blockersOpen`）必须不再出现',
  )
  // 豁免③：符号写在路径**之前**（`noSuchSymbol` 从 `lib.ts` 取）⇒ **有意不认证**（认它会把 5 条举例性路径当引用）
  assert.deepEqual(checkDocs(cite('`noSuchSymbol` 从 `lib.ts` 取。')), [], '路径之前的符号形态有意不认证（豁免面）')
  // 豁免④：夹了第二个路径 token 之后**很快**跟一个悬空标识符 ⇒ 只认第二对（钉住"夹路径即止"这条）
  assert.deepEqual(
    checkDocs(cite('见 `lib.ts` `x.ts` `noSuchSymbol`。', [{ path: 'x.ts', text: 'export const y = 1\n' }])).map((issue) => issue.detail),
    ['x.ts#noSuchSymbol（第 1 行）指向的定义查无实体'],
    '夹了第二个路径 token ⇒ 第一对到此为止（不许再配 `lib.ts` 那一对）',
  )
  // 反面（棘轮兜不住真问题）：同一条路径形态下的**真悬空**必须红
  assert.deepEqual(checkDocs(cite('见 `lib.ts` 的 `noSuchSymbol`。')).map((issue) => issue.kind), ['dangling-id'], '真悬空必红')
})

test('M189-08 §3.6（DEF-093）②③④⑤：灌水理由红 / 自证格可证伪 / 清单面现算量化 + 缺口按身份登记 / 两类豁免重判', () => {
  const pack = loadLangPack(ROOT)
  const sample = pack[0] as PackValue
  // ② 灌水理由（长度够、但没有可核 token）⇒ 红；长度不是理由
  const padded = auditDeclaredExemptions(
    [{ site: 'x.test.ts:7', why: '这是语言包里的取值、按键可取、不读散文语义（这句理由足够长）' }],
    [{ path: 'x.test.ts', line: 7, kind: 'exact', literal: sample.value }],
    pack,
  )
  assert.equal(padded.length, 1, '灌水理由必须红')
  assert.match(padded[0]?.detail ?? '', /可核 token/u)
  // ③ 一行文件冒充自证格 ⇒ 不许通过（判据必须**可证伪**：坏输入要判不同）
  const fake: PairedProof = { name: '一行文件冒充', criterion: () => 'ok', zh: '中文', en: 'english', bad: '坏输入' }
  assert.equal(auditPairedProofs([fake]).length, 1, '恒真的"自证格"必须被抓')
  assert.deepEqual(auditPairedProofs(PAIRED_PROOFS), [], '真自证格（判据本体）必须过：中英同判 + 非空 + 坏输入判不同')
  // ④ 清单面**现算**（抽取器跑真树）+ 与 V19 的 177 / 52 的关系
  const testFiles = walkTests(join(ROOT, 'test'))
  const docs = testFiles.map((path) => ({ path: relPath(path), text: readFileSync(path, 'utf8') }))
  const wide = docs.filter((doc) => doc.text.split('\n').some((line) => /assert\.\w+\(/u.test(line) && CJK_IN_LITERAL.test(line)))
  const sites = extractProseSites(docs)
  const verdicts = sites.map((site) => classifySite(site, pack))
  const labelSites = verdicts.filter((verdict) => verdict.cls === 'label').length
  const proseSites = sites.length - labelSites
  const partialFiles = new Set(sites.filter((site) => site.kind === 'partial').map((site) => site.path)).size
  assert.ok(sites.length >= 2000, `候选站点必须到量级（实际 ${sites.length}）`)
  assert.ok(labelSites >= 60 && proseSites >= 2000, `量化：站点 ${sites.length} = label ${labelSites} + 读散文 ${proseSites}（棘轮按身份登记，见下表）`)
  assert.ok(wide.length >= 177, `宽口径（含断言消息）文件数必须 ≥ V19 的 177（实际 ${wide.length}）`)
  assert.ok(partialFiles >= 52, `读文本调用类文件数必须 ≥ V19 的 52（实际 ${partialFiles}）`)
  assert.ok(docs.length >= 180, `普查面必须覆盖全部测试文件（实际 ${docs.length}）`)
  // 缺口**按身份登记**（文件 + 该文件里的读散文站点数）：新增读散文的断言 ⇒ 登记、或改成 label / 成对自证。
  // 这不是"计数余量"（余量 0 的棘轮就是永久豁免）—— 换位置、换文件、加一条都会红并点名。
  const gap: Record<string, number> = {}
  sites.forEach((site, index) => {
    if ((verdicts[index] as { cls: string }).cls !== 'prose') return
    gap[site.path] = (gap[site.path] ?? 0) + 1
  })
  const KNOWN_PROSE_GAP: Record<string, number> = {
  'test/dor.test.ts': 14, 'test/grill.test.ts': 10, 'test/journal.test.ts': 2, 'test/m10.test.ts': 4,
  'test/m100.test.ts': 34, 'test/m101.test.ts': 26, 'test/m102.test.ts': 3, 'test/m103.test.ts': 10,
  'test/m104.test.ts': 20, 'test/m105.test.ts': 18, 'test/m106.test.ts': 2, 'test/m107.test.ts': 18, 'test/m108.test.ts': 7,
  'test/m109.test.ts': 13, 'test/m11.test.ts': 25, 'test/m110.test.ts': 9, 'test/m119.test.ts': 2,
  'test/m12.test.ts': 35, 'test/m124.test.ts': 6, 'test/m125.test.ts': 5, 'test/m126.test.ts': 11,
  'test/m127.test.ts': 7, 'test/m128.test.ts': 4, 'test/m129.test.ts': 2, 'test/m13.test.ts': 31,
  'test/m130.test.ts': 15, 'test/m131.test.ts': 7, 'test/m132.test.ts': 7, 'test/m133.test.ts': 12,
  'test/m134.test.ts': 12, 'test/m135.test.ts': 8, 'test/m136.test.ts': 6, 'test/m137.test.ts': 13,
  'test/m138.test.ts': 8, 'test/m139.test.ts': 4, 'test/m14.test.ts': 18, 'test/m140.test.ts': 2,
  'test/m141.test.ts': 4, 'test/m142.test.ts': 3, 'test/m143.test.ts': 1, 'test/m144.test.ts': 13,
  'test/m145.test.ts': 7, 'test/m146.test.ts': 1, 'test/m147.test.ts': 6, 'test/m148.test.ts': 9,
  'test/m149.test.ts': 3, 'test/m15.test.ts': 29, 'test/m150.test.ts': 2, 'test/m151.test.ts': 5,
  'test/m152.test.ts': 5, 'test/m153.test.ts': 5, 'test/m154.test.ts': 2, 'test/m155.test.ts': 1,
  'test/m156.test.ts': 1, 'test/m157.test.ts': 1, 'test/m158.test.ts': 4, 'test/m159.test.ts': 2, 'test/m16.test.ts': 39,
  'test/m161.test.ts': 6, 'test/m162.test.ts': 11, 'test/m163.test.ts': 3, 'test/m164.test.ts': 2,
  'test/m165.test.ts': 3, 'test/m166.test.ts': 6, 'test/m167.test.ts': 2, 'test/m168.test.ts': 1, 'test/m169.test.ts': 18,
  'test/m17.test.ts': 32, 'test/m170.test.ts': 13, 'test/m171.test.ts': 13, 'test/m172.test.ts': 4,
  'test/m173.test.ts': 5, 'test/m174.test.ts': 8, 'test/m176.test.ts': 16, 'test/m177.test.ts': 9,
  'test/m178.test.ts': 8, 'test/m179.test.ts': 8, 'test/m18.test.ts': 22, 'test/m180.test.ts': 18,
  'test/m181.test.ts': 8, 'test/m182.test.ts': 4, 'test/m183.test.ts': 4, 'test/m184.test.ts': 8,
  'test/m185.test.ts': 15, 'test/m186.test.ts': 2, 'test/m187.test.ts': 14, 'test/m189.test.ts': 34,
  'test/m19.test.ts': 48, 'test/m190.test.ts': 20, 'test/m192.test.ts': 7, 'test/m193.test.ts': 9,
  'test/m195.test.ts': 3, 'test/m196.test.ts': 9, 'test/m197.test.ts': 5, 'test/m198.test.ts': 1,
  'test/m199.test.ts': 14, 'test/m2.test.ts': 2, 'test/m20.test.ts': 20, 'test/m204.test.ts': 5,
  'test/m205.test.ts': 1, 'test/m206.test.ts': 2, 'test/m207.test.ts': 1, 'test/m208.test.ts': 1, 'test/m209.test.ts': 7, 'test/m21.test.ts': 16,
  'test/m22.test.ts': 21, 'test/m23.test.ts': 64, 'test/m24.test.ts': 4, 'test/m25.test.ts': 20,
  'test/m26.test.ts': 4, 'test/m27.test.ts': 21, 'test/m28.test.ts': 11, 'test/m29.test.ts': 6,
  'test/m3.test.ts': 27, 'test/m30.test.ts': 13, 'test/m31.test.ts': 15, 'test/m32.test.ts': 45,
  'test/m33.test.ts': 49, 'test/m34.test.ts': 23, 'test/m35.test.ts': 37, 'test/m36.test.ts': 27,
  'test/m37.test.ts': 8, 'test/m38.test.ts': 61, 'test/m39.test.ts': 8, 'test/m4.test.ts': 31,
  'test/m40.test.ts': 25, 'test/m41.test.ts': 7, 'test/m42.test.ts': 17, 'test/m43.test.ts': 14,
  'test/m44.test.ts': 7, 'test/m45.test.ts': 9, 'test/m46.test.ts': 2, 'test/m47.test.ts': 11,
  'test/m48.test.ts': 6, 'test/m49.test.ts': 2, 'test/m5.test.ts': 11, 'test/m51.test.ts': 9,
  'test/m52.test.ts': 1, 'test/m53.test.ts': 2, 'test/m54.test.ts': 1, 'test/m55.test.ts': 2,
  'test/m56.test.ts': 3, 'test/m60.test.ts': 1, 'test/m62.test.ts': 2, 'test/m63.test.ts': 3,
  'test/m64.test.ts': 4, 'test/m65.test.ts': 2, 'test/m66.test.ts': 2, 'test/m67.test.ts': 2,
  'test/m68.test.ts': 10, 'test/m69.test.ts': 1, 'test/m7.test.ts': 29, 'test/m71.test.ts': 2,
  'test/m72.test.ts': 5, 'test/m73.test.ts': 27, 'test/m74.test.ts': 24, 'test/m75.test.ts': 18,
  'test/m76.test.ts': 7, 'test/m77.test.ts': 15, 'test/m78.test.ts': 9, 'test/m79.test.ts': 4,
  'test/m8.test.ts': 29, 'test/m80.test.ts': 25, 'test/m81.test.ts': 15, 'test/m82.test.ts': 5,
  'test/m83.test.ts': 24, 'test/m84.test.ts': 17, 'test/m85.test.ts': 42, 'test/m86.test.ts': 16,
  'test/m87.test.ts': 18, 'test/m88.test.ts': 60, 'test/m89.test.ts': 5, 'test/m9.test.ts': 34,
  'test/m90.test.ts': 18, 'test/m91.test.ts': 9, 'test/m92.test.ts': 13, 'test/m93.test.ts': 37,
  'test/m94.test.ts': 14, 'test/m95.test.ts': 11, 'test/m96.test.ts': 5, 'test/m97.test.ts': 23,
  'test/m98.test.ts': 18, 'test/m99.test.ts': 6, 'test/office.test.ts': 46, 'test/scoring.test.ts': 7,
  'test/task001-acceptance.test.ts': 4, 'test/task001-red-baseline.test.ts': 3, 'test/yaml.test.ts': 10,
  }
  const actualGap = Object.fromEntries(Object.entries(gap).sort(([a], [b]) => (a < b ? -1 : 1)))
  assert.deepEqual(
    actualGap,
    KNOWN_PROSE_GAP,
    '读散文的站点必须**按身份**登记（文件 + 条数）：新增/挪位置 ⇒ 登记它、改成语言包 label、或加一份成对自证',
  )
  // ⑤ 两类豁免**逐条重判**：类 1 收窄到 label 子集（回执整段散文不在内），类 2 撤销（反例读自由文本）
  for (const spec of ['test/m19.test.ts:906', 'test/m3.test.ts:608', 'test/m125.test.ts:189']) {
    const site = sites.find((item) => siteKey(item) === spec)
    assert.ok(site !== undefined, `${spec} 必须在候选集里（否则就是抽取器的漏洞被当成"没读散文"）`)
    assert.equal(classifySite(site as ProseSite, pack).cls, 'prose', `${spec} 是自由文本/整段散文的读取 ⇒ 不许再被豁免`)
  }
  assert.ok(EXEMPTION_CLASSES.every((cls) => cls.verify.length > 12), '每条豁免类都必须给可核的验证判据')
  assert.equal(EXEMPTION_CLASSES.length, 2, '豁免类收敛到两类（label 子集 / 结构约束）')
  assert.ok(REJUDGED.length >= 2, '两类旧豁免必须逐条重判')
  assert.ok(REJUDGED.every((row) => row.evidence.length > 0), '重判必须带现盘证据站点')
})

test('M189-09 §3.1（DEF-096）：符号支路也"引用自己那一行不算" —— 自解析不许恒可解析 + 反例', () => {
  // ① 自解析形态：引用写在**被指文件自己**里 ⇒ 必须红并点名
  const selfBogus = checkDocs([{ path: 'a.ts', text: ' * 见 `a.ts` 的 `noSuchSymbolV22`。\n' }])
  assert.deepEqual(selfBogus.map((issue) => issue.kind), ['dangling-id'], '自解析的真悬空必须红')
  assert.match(selfBogus[0]?.detail ?? '', /noSuchSymbolV22|a\.ts#noSuchSymbolV22/u, '必须点名被指的符号')
  // ② 写到**别的**文件里（同一符号）⇒ 同样红（两种写法同判）
  const otherBogus = checkDocs([
    { path: 'a.ts', text: ' * 见 `b.ts` 的 `noSuchSymbolV22`。\n' },
    { path: 'b.ts', text: 'export const x = 1\n' },
  ])
  assert.deepEqual(otherBogus.map((issue) => issue.kind), selfBogus.map((issue) => issue.kind), '自解析与非自解析必须同判')
  // ③ 反例（DoD ④）：**真存在**的符号写在被指文件自己里 ⇒ **不许红**
  assert.deepEqual(
    checkDocs([{ path: 'a.ts', text: ' * 见 `a.ts` 的 `realSymbol`。\nexport function realSymbol(): void {}\n' }]),
    [],
    '真存在的符号写在文件自己里不许红（别把"自己那一行不算"做成"凡自引用一律红"）',
  )
  // ④ 同一文件里"连举好几个"：各自独立点名 —— 悬空的那个红、真存在的那个不红
  const mixed = checkDocs([{
    path: 'a.ts',
    text: ' * 见 `a.ts` 的 `realSymbol`。\n * 另见 `a.ts` 的 `noSuchSymbolV22`。\nexport function realSymbol(): void {}\n',
  }])
  assert.deepEqual(mixed.map((issue) => issue.kind), ['dangling-id'], '只点悬空那一个')
  assert.match(mixed[0]?.detail ?? '', /noSuchSymbolV22/u, '点名的是悬空的那个符号（不是真存在的那个）')
  // ⑤ 中英一致：英文写法同判
  assert.deepEqual(
    checkDocs([{ path: 'a.ts', text: ' * see `a.ts` the `noSuchSymbolV22`.\n' }]).map((issue) => issue.kind),
    ['dangling-id'],
    '英文写法必须同判',
  )
})

test('M189-10 §3.2（DEF-095）：交付注释里的符号引用自己必须可解析（注释与实现同源）+ 反例', () => {
  // 引用面 = `test/docRefs.ts` 自己；见证面 = src + test（含 helper）+ docs
  const faces = repoDocFaces(ROOT)
  const witnesses = [...faces.witnesses, ...walkTs(join(ROOT, 'test'))]
  const issues = checkDocFiles([join(ROOT, 'test', 'docRefs.ts')], witnesses)
  const dangling = issues.filter((issue) => issue.kind === 'dangling-id')
  assert.deepEqual(dangling, [], `docRefs.ts 注释里的符号引用必须都能解析（真名）：${JSON.stringify(dangling).slice(0, 400)}`)
  // ② 方向与数量必须与实现逐字相符（**措辞级**判据；行为面由 `M189-06`/`M189-07` 各自钉住：
  //    "向左找"变异 ⇒ `M189-02`/`M189-05/06/07` 红；"候选取整行"变异 ⇒ `M189-05/06/07` 红）
  const source = readFileSync(join(ROOT, 'test', 'docRefs.ts'), 'utf8')
  assert.ok(source.includes('symbolAfter'), '注释必须引用真名 `symbolAfter`')
  assert.equal(source.includes('symbolsOf'), false, '`symbolsOf` 是旧名（`DEF-095`）：注释里不许再出现')
  assert.ok(source.includes('只向右、至多 1 个'), '方向与数量必须与实现逐字相符（只向右 / 至多 1 个）')
  assert.equal(/左\/右各取|最多 2 个/u.test(source), false, '不许再写"左/右各取"或"最多 2 个"')
  // 反例：同一机制喂一条**不存在的**标识符 ⇒ 必须红并点名
  const bogus = checkDocs([{ path: 'test/docRefs.ts', text: ' * 见 `test/docRefs.ts` 的 `noSuchSymbolXyz`。\n' }], [
    { path: 'test/docRefs.ts', text: 'export function checkDocs(): void {}\n' },
  ])
  assert.deepEqual(bogus.map((issue) => issue.kind), ['dangling-id'], '注释里的不存在标识符必须红并点名')
  assert.match(bogus[0]?.detail ?? '', /noSuchSymbolXyz/u)
  // 豁免面钉子：**裸反引号标识符**不构成引用形态（`DEF-095` 的判据面就是它）⇒ 加一个不存在的名字也不许红
  assert.deepEqual(
    checkDocs(
      [{ path: 'test/docRefs.ts', text: ' * 见 `noSuchBareNameXyz` 这个裸标识符（不是引用形态）。\n' }],
      [{ path: 'test/docRefs.ts', text: 'export function checkDocs(): void {}\n' }],
    ),
    [],
    '裸反引号标识符不在判据面内（豁免面：只认"路径 之后 的符号"这一形态）',
  )
})

test('M189-12 §3.2（DEF-096）：符号存在性判定不许被**超串**喂饱 —— 判据做的是整词匹配 + 反例', () => {
  // 修前形态（V24 实测）：把 `checkDocs` 里的 `\b${name}\b` 词边界去掉 ⇒ 判据退化成**子串包含** ⇒
  // 被指文件里只要有一个**名字是目标符号超串**的标识符（`realSymbolEdgeX` ⊃ `realSymbolEdge`），
  // 真悬空就被喂饱、判成"存在"。本格就是那格的守卫（单点：去掉 `\b` ⇒ 下面第 ② 条断言红）。
  const cite = (witnessText: string, line: string): { path: string; text: string }[] => [
    { path: 'lib.ts', text: witnessText },
    { path: 'a.ts', text: ` * ${line}\n` },
  ]
  // ① 反例的反面（防"一律判悬空"）：**恰好等于**目标符号的标识符 ⇒ 不许判悬空
  assert.deepEqual(
    checkDocs(cite('export function realSymbolEdge(): void {}\n', 'see `lib.ts` the `realSymbolEdge`.')),
    [],
    '恰好等于目标符号的标识符不许判悬空（整词命中 ⇒ 存在）',
  )
  // ② 子串喂饱（前缀方向）：被指文件里**没有** `realSymbolEdge`，只有它的超串 `realSymbolEdgeX` ⇒ 仍必须判悬空
  assert.deepEqual(
    checkDocs(cite('export function realSymbolEdgeX(): void {}\n', 'see `lib.ts` the `realSymbolEdge`.')).map((issue) => issue.kind),
    ['dangling-id'],
    '被指文件里只有**超串**（realSymbolEdgeX）时，realSymbolEdge 仍必须判悬空（不许被喂饱）',
  )
  // ②-b 同一格里断言真的点到了那个符号（不是"因为别的原因红了"）
  assert.match(
    checkDocs(cite('export function realSymbolEdgeX(): void {}\n', 'see `lib.ts` the `realSymbolEdge`.'))[0]?.detail ?? '',
    /realSymbolEdge\b/u,
    '必须点名被指的那个符号（而不是超串的那一个）',
  )
  // ③ 子串喂饱（后缀方向）：只有 `realSymbolEdgeXyz`（含 `Edge` 前缀、另加长尾）时同理 —— 两个方向都不许被喂饱
  assert.deepEqual(
    checkDocs(cite('export function realSymbolEdgeXyz(): void {}\n', 'see `lib.ts` the `realSymbolEdge`.')).map((issue) => issue.kind),
    ['dangling-id'],
    '超串在**后缀**方向也一样不许喂饱（整词匹配没有方向性）',
  )
  // ④ 中文书写形态同判（判据与语言无关）
  assert.deepEqual(
    checkDocs(cite('export function realSymbolEdgeX(): void {}\n', '见 `lib.ts` 的 `realSymbolEdge`。')).map((issue) => issue.kind),
    ['dangling-id'],
    '中文写法必须给出同一个判定',
  )
})

test('M189-13 §3.3（DEF-093 第十一批）：**枚举补全** —— 「行内没有该中文但被登记」的 6 个站点逐个点名 + 反例', () => {
  // V24 实测：§8.6 修法③只点名 **3** 个新站点（`test/m108.test.ts:245`、`test/m29.test.ts:42`、`test/m81.test.ts:275`），
  // 而现算共 **6** 个 ⇒ **少报**（不是错报）。本格把枚举**钉住**：这 6 个（且只有这 6 个）允许"行内没有该中文"，
  // 其余 **2247** 个候选站点（**2253 − 6 = 2247**）**必须**在那一行里真出现该中文。多一个、少一个、换位置都红。
  // **第十二批的现算账**：`2253 = label 67 + 读散文 2186`；相对第十一批的 `2263`（读散文 2196）**−10** ——
  // 逐文件现算（`git show HEAD:test/m189.test.ts` 的旧登记 vs 现算）：`test/m184.test.ts` **24 → 8**
  // （本批把"四份同哈希 / 18 条清单"的逐条中文断言改写成项目无关的原则与落点断言 ⇒ 断言消息少了 16 处）、
  // `test/m192.test.ts` **0 → 6**（本批新增的随包面无关性判据）。
  const testFiles = walkTests(join(ROOT, 'test'))
  const docs = testFiles.map((path) => ({ path: relPath(path), text: readFileSync(path, 'utf8') }))
  const sites = extractProseSites(docs)
  const rawLines = new Map(docs.map((doc) => [doc.path, doc.text.split('\n')]))
  /** 「行内没有该中文但被登记」的站点键（**现算**：抽取器的 literal 是否真出现在它自己那一行里）。 */
  const notOnLine = (): string[] => sites
    .filter((site) => !((rawLines.get(site.path) ?? [])[site.line - 1] ?? '').includes(site.literal))
    .map(siteKey)
  const KNOWN = [
    `${'test/m1'}08.test.ts:245`, // 中文绑在 `PROSE_RESPONSIBILITY` 常量上，断言那一行只有常量名
    `${'test/m1'}3.test.ts:639`,  // 中文绑在 `why` 变量上，断言那一行只有 `new RegExp(why)`
    `${'test/m1'}3.test.ts:649`,  // 同上（第二处）
    'test/m189.test.ts:102',      // 中文绑在 `body` 变量上，断言那一行只有 `carrier('r17', body)`
    'test/m29.test.ts:42',        // 中文绑在 `current` 上，断言那一行是 `line.startsWith('## ')`
    'test/m81.test.ts:275',       // 「变量再读」的字面量命中：行里 `'no-basis'` 含标识符 `basis`（已知代价）
  ]
  assert.deepEqual(notOnLine(), KNOWN, '这 6 个站点必须被逐个点名（多/少/换位置都红）')
  // 反例（DoD ③）：**行内有该中文**的站点不许被列进"被登记" —— 现算的 6 个就是全部
  assert.equal(sites.length - notOnLine().length, sites.length - KNOWN.length, '反例计数恒等（其余站点全部"行内出现"）')
  assert.ok(sites.length >= 2253, `候选站点量级不许退化（现算 ${sites.length}；第十二批基线 2253 = label 67 + 读散文 2186）`)
  // ② 普查数字（**第十二批现算**，与第十一批的 2263 / 2196 的关系见上面的 −10 算式）：
  //    `2253 = label 67 + 读散文 2186`
  const pack = loadLangPack(ROOT)
  const verdicts = sites.map((site) => classifySite(site, pack))
  const labelSites = verdicts.filter((verdict) => verdict.cls === 'label').length
  const proseSites = sites.length - labelSites
  const gapFiles = new Set(sites.filter((_site, index) => (verdicts[index] as { cls: string }).cls === 'prose').map((site) => site.path))
  assert.equal(sites.length, labelSites + proseSites, '恒等式：站点 = label + 读散文')
  assert.ok(labelSites >= 67 && proseSites >= 2180, `普查：${sites.length} = label ${labelSites} + 读散文 ${proseSites}（第十二批实测 2186；留 6 格余量防自指抖动）`)
  assert.ok(gapFiles.size >= 171, `登记面（含读散文站点的文件）不许退化（现算 ${gapFiles.size}）`)
  assert.ok(docs.length >= 185, `普查文件数不许退化（现算 ${docs.length}）`)
})

test('M189-11 §3.5（DEF-093 第十批）：三条未登记豁免面 —— 形态集口径 / `siteKey` 折叠 / 变量再 `includes`', () => {
  // ① **形态集口径与实现同源**：`assert.*` **整行**都在册（行里写 `indexOf`/`split` 也是），
  //    而**非 assert** 行只认四类读文本调用（`includes`/`match`/`startsWith`/`endsWith`）
  const inAssert = extractProseSites([{ path: 'x.test.ts', text: "assert.equal(x.indexOf('暂不可派'), 1)\n" }])
  assert.equal(inAssert.length, 1, 'assert 行里的 `indexOf` 也在册（口径 = `assert.*` 整行）')
  assert.deepEqual(
    extractProseSites([{ path: 'x.test.ts', text: "const at = line.indexOf('暂不可派')\n" }]),
    [],
    '非 assert 行里的 `indexOf` 不在册（登记在豁免面表：只认四类调用）',
  )
  // ② `siteKey = path:line` 会把**同一行的两处**折叠成一个键（登记在表里 —— 不是漏，是已知代价）
  const two = extractProseSites([{ path: 'x.test.ts', text: 'assert.match(a, /暂不可派/u); assert.match(b, /另说/u)\n' }])
  assert.equal(two.length, 2, '同一行的两处都必须在候选集里（抽取器看得见）')
  assert.equal(new Set(two.map(siteKey)).size, 1, '但 `siteKey` 把它们折叠成一个键（豁免面登记项）')
  // ③ **真缝隙（第十批修）**：中文先放变量、再 `includes(变量)` ⇒ 必须被抓
  const viaBinding = extractProseSites([{ path: 'x.test.ts', text: "const zh = '暂不可派'\nassert.ok(receipt.includes(zh))\n" }])
  assert.equal(viaBinding.length, 1, '变量再 `includes` 的形态必须被抽取器抓住（此前 `sites = 0`）')
  assert.equal(viaBinding[0]?.literal, '暂不可派', '被登记的必须是变量里绑定的那段中文')
  assert.equal(viaBinding[0]?.kind, 'partial', '它是"读渲染文本"那一类')
  // 反例（不是恒红）：变量绑的是**英文** ⇒ 不进候选集（判据只看字形）
  assert.deepEqual(
    extractProseSites([{ path: 'x.test.ts', text: "const en = 'dispatchable'\nassert.ok(receipt.includes(en))\n" }]),
    [],
    '英文变量的读取不进候选集（语言无关：只按"有没有汉字"判）',
  )
})
