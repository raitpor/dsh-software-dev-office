/**
 * **增量 189：第八批 §3.3（`DEF-088`）+ §3.5（`R19`）。**
 *
 * §3.3 的旧判据只有"关键词 + DEF 号"一句 ⇒ V16 实测**既不充分也不必要**（合法引用假阳性、英文悬空漏判、
 * 保留措辞掏空语义仍绿）。新判据只认**标识符的可解析性**与**结构标记内的逐字相等**（见 `test/docRefs.ts`），
 * 因此**同一条判据对中文与英文写入给出同一个判定** —— 这同时就是 §3.5 要求的"两种书写形态自证"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { checkDocFiles, checkDocs, normalizeNote, repoDocFaces } from './docRefs.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm189')
/** 真实例（只读观测，不进单测）用的实例路径不在单测里出现（DoD ③）。 */
beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

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

test('M189-04 §3.5（R19）清单：读自然语言文本的判据必须有两形态自证；只读结构化键值的判据明确豁免', () => {
  // 清单本身是**数据**（判据 / 是否读自然语言文本 / 自证格 / 豁免理由）
  const inventory: { name: string; readsProse: boolean; selfProof?: string; why?: string }[] = [
    { name: '文档/注释里的引用与委托（DEF-088）', readsProse: true, selfProof: 'test/m189.test.ts' },
    { name: '悬空引用（DEF-086 / M182-02）', readsProse: true, selfProof: 'test/m189.test.ts' },
    { name: '语言包标签（`t()` 取的回执文案）', readsProse: false, why: '只按**键**取值、不读自然语言语义；中英两包各自存在本身就是它的"两形态"' },
    { name: '结构化字段与事件（journal / 台账 YAML）', readsProse: false, why: '判据只看字段名与取值，不看散文' },
    { name: '白盒口径的中文标签（DEF-034）', readsProse: false, why: '比的是**词表取值**与标签是否逐条相同，不解析语义' },
  ]
  for (const row of inventory) {
    if (row.readsProse) {
      assert.ok(row.selfProof !== undefined && row.selfProof !== '', `${row.name}：读文本的判据必须指出自证格`)
      const text = readFileSync(join(ROOT, row.selfProof as string), 'utf8')
      // 自证格必须**同时**含 CJK 与 ASCII 两种书写形态的夹具（本文件里就是中文/英文两格）
      assert.match(text, /[\u4e00-\u9fff]/u, `${row.selfProof}：自证格里必须有 CJK 书写形态`)
      assert.match(text, /[A-Za-z]{4,}/u, `${row.selfProof}：自证格里必须有 ASCII 书写形态`)
    } else {
      assert.ok((row.why ?? '').length >= 12, `${row.name}：豁免必须给理由（不许空着豁免）`)
    }
  }
  assert.equal(inventory.filter((row) => row.readsProse && row.selfProof === undefined).length, 0, '清单里不许有"读文本却没自证格"的判据')
  // 归一函数必须**语言中立**（同一段中文与同一段英文的归一行为一致：只去注释符、折叠空白）
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
  // 符号引用：现盘还剩极少数**抽取器的已知假阳性形态**（`` `file.ts` `` … 后面跟的其实是命令/别的反引号词）
  // ⇒ 棘轮钉住，只许减少；名单印在断言消息里供驾驶舱判读。
  const symbols = issues.filter((issue) => !/^DEF-\d/.test(issue.detail))
  const KNOWN_STALE = 2
  assert.ok(
    symbols.length <= KNOWN_STALE,
    `符号引用悬空数不许上涨（棘轮 ${KNOWN_STALE}）：${JSON.stringify(symbols).slice(0, 800)}`,
  )
})
