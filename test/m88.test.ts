/**
 * **增量 88：门禁签字的交互优化守卫（0.1.5 起）**
 *
 * 背景（2026-10-09）：`sdo_gate action=sign channel=question` 过去只把**一句固定文案**
 * （`uiSign.detail`）放进问答卡 —— 用户"签字"时看不到自己签的是什么。这正是
 * "看起来同意了"与"有留痕的用户同意"被混为一谈的温床（同日真机：复用旧原话补签）。
 *
 * 本轮的形状：
 *   · **宿主侧**把待签对象渲染成一份**审核单**（判据三态 + 未通过项修法 + 本门产物清单），
 *     由 `office.signReviewDoc` 从真源**现读现渲染**，塞进问答卡的 `detail`（不经过模型）；
 *   · **客户端侧**新增 `client.js`，在 `user-questions/request` 这条 **waterfall** 上做
 *     **旁观者**（读 `detail` → 打开右侧边栏 → 无条件 `next()` 委派），把同一份审核单
 *     放进右侧边栏**可滚动通读** —— 这是宿主驱动不了的部分（`sidebarRight` 是客户端服务）。
 *
 * **2026-10-09 真机反馈后的两处收紧**（它们各自都有独立守卫）：
 *   · 审核单**不再整篇内联产物原文**（第一版会把问答卡撑成一堵墙）⇒ M88-03；
 *   · 客户端半的失败**不许静默**（第一版"右栏没弹却毫无报错"，谁都诊断不了）⇒ M88-05。
 *
 * 守卫（本文件）：
 *   · **M88-01** 审核单渲染：三态齐、每条判据带 id/要求/实测、未通过项带修法（正/反双向）；
 *   · **M88-02** 首行必须是 `# ` 标题（客户端拿首行当卡片标题与标签页标题）；
 *   · **M88-03** 审核单**只列产物清单**（路径/状态/字节），**不得内联原文** —— 体积必须有界；
 *   · **M88-04** 语言包：新增的 `uiSignReview` 段两包齐全，且**原有 `uiReview` 段不得被顶掉**
 *     （本轮真踩过：新段与旧段同名 ⇒ 后段整段覆盖前段 ⇒ 评审核实的 18 个键集体漏出键名）；
 *   · **M88-05** 客户端半的声明与形状（`dsh.client` / `./client` 导出 / `files` /
 *     模块加载器协议 / 标签页 key 与实现 id 同源 / **必须委派 `next()`** / **失败必须留痕** /
 *     `params` 必须有声明合并）；
 *   · **M88-06** 宿主侧接线：签字问题必须带上**现算的审核单**（源码级守卫，与 M87-06 同法）；
 *   · **M88-07** 文案不得写死**别的门禁编号**（真机缺陷：签 G7 时选项说明说"G3 不可通过"）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { renderSignReviewDoc, renderSignReviewSummary } from '../src/domain/reviewDoc.js'
import type { SignReviewDoc } from '../src/domain/reviewDoc.js'
import { parseYaml } from '../src/infra/yaml.js'

/**
 * 去掉注释后的源码。
 *
 * **负向断言（不许出现 X）必须看代码，不能看注释** —— 否则"注释里解释过这个坑"就会骗过守卫；
 * 本轮真踩过两次：一次是"注释里提到 extractMarkdownPlainText"让正向守卫假绿，
 * 一次是"注释里解释上一版用了 useSidebarMounted"让**负向**守卫假红。
 *
 * **删注释的顺序不能反**：必须**先删行注释、再删块注释**。反过来的话，行注释里出现的
 * "斜杠加星号"序列（真机例子：有条注释写着 dsh-resource 协议的 `sdo-review/**`，
 * 其中的斜杠星号被当成块注释起点）会一路吞到下一个块注释结束标记，**吃掉约 2KB 代码**，
 * 于是负向断言看的是残缺代码、变异照样"存活"（Z22/Z23 就是这么假的）。
 * `//` 只在**前面不是冒号**时才算注释起点（dsh-resource 协议与 https URL 不受影响）。
 */
function stripComments(source: string, markers: readonly string[]): string {
  const stripped = source
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
  assert.ok(stripped.length > source.length / 3, '去注释不能把代码本身吃掉（辅助函数自检）')
  // 代码标记自检：**由调用方给出它那份源码里必然存在的标记**（少一个就说明正则吞了代码）。
  // 标记必须显式传：写死成 client.js 专有的字符串时，换个文件调用就会误报。
  assert.ok(markers.length > 0, '去注释自检必须给出至少一个代码标记')
  for (const marker of markers) {
    assert.ok(stripped.includes(marker), `去注释吃掉了代码（缺 ${marker}）—— 检查删注释的顺序`)
  }
  return stripped
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function docOf(overrides: Partial<SignReviewDoc> = {}): SignReviewDoc {
  return {
    gate: 'G3',
    gateText: '架构门禁',
    phaseText: '架构',
    statusText: '未通过',
    at: '2026-10-09T12:00:00.000Z',
    payload: [],
    fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    seq: 0,
    criteria: [
      { id: 'C-20', ok: true, na: false, desc: '视图齐备', detail: '五视图非空', remedy: '', warnings: [] },
      { id: 'C-2D', ok: false, na: false, desc: '门禁签字', detail: '尚未签字', remedy: '调用 sdo_gate action=sign', warnings: [] },
      { id: 'C-27', ok: false, na: true, desc: '界面确认', detail: '本项目不含 UI', remedy: '', warnings: [] },
    ],
    artifacts: [],
    unjudged: false,
    ...overrides,
  }
}

test('M88-01 审核单：三态齐、判据逐条带 id/要求/实测、未通过项带修法', () => {
  const text = renderSignReviewDoc(docOf())
  // 三态标记同 `describeGate` 口径：✅ / ❌ / ➖
  assert.match(text, /✅/u)
  assert.match(text, /❌/u)
  assert.match(text, /➖/u)
  for (const id of ['C-20', 'C-2D', 'C-27']) assert.ok(text.includes(id), `审核单必须点名判据 ${id}`)
  assert.ok(text.includes('尚未签字'), '未通过项的**实测**必须在单里')
  assert.ok(text.includes('调用 sdo_gate action=sign'), '未通过项的**修法**必须在单里')
  // 反向：没有的判据不许凭空出现；全绿时不许印修法
  const passed = renderSignReviewDoc(docOf({
    criteria: [{ id: 'C-20', ok: true, na: false, desc: '视图齐备', detail: 'ok', remedy: '', warnings: [] }],
    statusText: '已通过',
  }))
  assert.ok(!passed.includes('C-2D'), '没有的判据不许凭空出现在单里')
  assert.equal(/调用 sdo_gate action=sign/u.test(passed), false, '全绿时不许印修法')
})

test('M88-02 审核单首行必须是 `# ` 标题（客户端拿它当标题）', () => {
  const text = renderSignReviewDoc(docOf())
  const first = text.split('\n')[0] ?? ''
  assert.match(first, /^#\s+\S/u)
  assert.ok(first.includes('架构门禁'), '标题要点名门禁')
  // 真源读不出来（unjudged）时仍然要有标题与"没有逐条判定"的真话
  const unjudged = renderSignReviewDoc(docOf({ criteria: [], unjudged: true, statusText: '未通过' }))
  assert.match(unjudged.split('\n')[0] ?? '', /^#\s+\S/u)
  assert.equal(/(✅|❌)/u.test(unjudged), false, '没有逐条判定时不许印判据标记')
})

test('M88-03 审核单只列产物清单，不得内联原文（体积必须有界）', () => {
  // 一件"很大"的产物：单里只能出现它的路径/状态/字节数，**不能**出现它的内容。
  const secret = 'DOC-BODY-MARKER-'.repeat(500)
  const text = renderSignReviewDoc(docOf({
    artifacts: [
      { name: 'SDD.md', path: 'docs/SDD.md', exists: true, bytes: 123456 },
      { name: 'SRS.md', path: 'docs/SRS.md', exists: false, bytes: 0 },
    ],
  }))
  assert.ok(text.includes('docs/SDD.md'), '存在与否都要如实列出路径')
  assert.ok(text.includes('docs/SRS.md'), '缺失的产物也要列出来')
  assert.ok(text.includes('123456'), '要给出字节数（原文的规模感）')
  assert.ok(!text.includes(secret), '不许内联产物原文')
  // 体积有界：整份单不该因为产物而膨胀（上限给得宽松，只卡"不会随产物增长"）
  assert.ok(text.length < 4000, `审核单体积必须有界，实测 ${text.length} 字符`)
  // 缺正文（unjudged）与无产物两种退化路径都要有可读输出
  assert.ok(renderSignReviewDoc(docOf({ criteria: [], unjudged: true })).length > 0)
  assert.ok(renderSignReviewDoc(docOf({ artifacts: [] })).length > 0)
})

test('M88-04 语言包：新增 uiSignReview 段两包齐全，且不得顶掉原有 uiReview 段', () => {
  const read = (locale: string): Record<string, Record<string, string>> =>
    parseYaml(readFileSync(join(ROOT, 'src', 'data', 'lang', `${locale}.yml`), 'utf8')) as Record<string, Record<string, string>>
  const zh = read('zh-CN')
  const en = read('en')

  // ① 本轮新增的段：两包都要有，且键必须一一对应
  const zhSign = zh.uiSignReview
  const enSign = en.uiSignReview
  assert.ok(zhSign !== undefined && enSign !== undefined, 'uiSignReview 段两包都必须存在')
  assert.deepEqual(Object.keys(zhSign).sort(), Object.keys(enSign).sort(), 'uiSignReview 两包键必须一一对应')
  for (const key of ['title', 'metaCounts', 'unjudged', 'colBytes']) {
    assert.ok((zhSign[key] ?? '') !== '', `uiSignReview.${key} 中文值不得为空`)
    assert.ok((enSign[key] ?? '') !== '', `uiSignReview.${key} 英文值不得为空`)
  }

  // ② **回归守卫**：语言包 YAML 子集里同名段后段会整段覆盖前段 —— 原有 uiReview 段必须还在。
  //    （本轮真踩过：新段取名叫 uiReview ⇒ 评审核实的 18 个键集体漏出键名、11 条用例变红。）
  assert.ok(zh.uiReview !== undefined && en.uiReview !== undefined, '原有 uiReview 段必须仍在')
  for (const key of ['stateVerified', 'stateTampered', 'stateUnrecorded', 'noReview', 'alreadyVerified']) {
    assert.ok((zh.uiReview[key] ?? '') !== '', `uiReview.${key} 被顶掉了（后段覆盖前段）`)
    assert.ok((en.uiReview[key] ?? '') !== '', `uiReview.${key} 被顶掉了（后段覆盖前段）`)
  }
})

test('M88-05 客户端半：声明齐备 + 形状正确 + 委派 next() + 失败必须留痕', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    files?: string[]
    dsh?: { client?: { platform?: string; inject?: string[] } }
  }
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const decl = readFileSync(join(ROOT, 'client.d.ts'), 'utf8')

  // ① 声明：浏览器半要被宿主发现，必须先声明；文件要进包（`files` 漏了等于随包丢失）
  assert.equal(manifest.dsh?.client?.platform, 'web', '必须在 package.json 里声明 dsh.client.platform=web')
  assert.ok(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0, 'dsh.client.inject 必须列出依赖的客户端插件')
  const clientExport = manifest.exports?.['./client']
  const defaultTarget = typeof clientExport === 'string'
    ? clientExport
    : (clientExport as { default?: string } | undefined)?.default
  assert.equal(defaultTarget, './client.js', './client 导出的默认目标必须是 client.js')
  const files = manifest.files ?? []
  assert.ok(files.includes('client.js'), 'client.js 必须在 files 里（否则随包丢失）')
  assert.ok(files.includes('client.d.ts'), 'client.d.ts 必须在 files 里（否则类型契约随包丢失）')

  // ② 形状：模块加载器协议 + 与自身包名同 id（宿主按包名注册组合）
  assert.match(client, /window\.__ModuleLoader__\.load\(/u)
  assert.match(client, /id:\s*'dsh-software-dev-office'/u)
  // ③ 座位 key 必须与标签页类型的实现 id 同源（注册契约：body/title 用 definition.id 当 key）
  assert.ok(/const TAB_ID = '[^']+'/u.test(client), '客户端半必须显式声明 TAB_ID')
  assert.ok(/const TAB_KIND = '[^']+'/u.test(client), '客户端半必须显式声明 TAB_KIND')
  assert.ok(client.includes('key: TAB_ID'), 'sidebar.right.pane.tab 的 key 必须是 TAB_ID')
  assert.ok(client.includes("'sidebar.right.pane.tab.title'"), '必须同时注册标签页标题座位')
  assert.ok(client.includes('patterns:'), '必须声明能认领的地址模式')
  // ④ **旁观者纪律**：读到提问后必须 `next()` 委派，绝不能截断问答链（截断 = 签字卡永远不出现）。
  //    改成 `const settled = next()` 是为了接住它的完成当**结算信号**（见 M88-10），
  //    所以这里断言的是"调用一次 + 原样传下去"，而不是某种字面写法。
  assert.equal(
    (stripComments(client, ['probe.applied = true', 'function apply(ctx)']).match(/[^.\w]next\(\)/gu) ?? []).length,
    1,
    '整个客户端半只许调用一次 next()',
  )
  assert.match(client, /const settled = next\(\)/u, '必须接住 next() 的返回值用以委派')
  assert.match(client, /return settled/u, '必须把 next() 的返回值原样传下去')
  // ⑤ **打开时机（两版真机读数之后的形态）**：
  //    第一版在回调里 `openResource`（不带会话）→ 不弹且被吞；第二版"回调只收下、座位里等
  //    `useSidebarMounted` 再开"→ 真机 `{applied:true, opened:0, lastError:''}`（`openReviewIn`
  //    一次都没被调用）⇒ **"回调里不能开"这条从未被证实**，而"座位会渲染 + hooks 会被注入"
  //    这两个前提也没被证实（那个座位的 catalog 里 `slotInject`/`hookContext` 都是空的）。
  //    现在的形态：**回调里先取屏上会话再开**，座位只作兜底，且不依赖 hooks/inject。
  assert.match(
    client,
    /ctx\.sidebarRight\?\.mounted/u,
    '必须从 ctx.sidebarRight.mounted 现取「屏上会话」（它比 React 渲染更早更新，回调里读得到）',
  )
  // **契约名必须对**：`ObservableSnapshot<T>` 只有 `getSnapshot()`，**没有 `get()`**
  //（`@deepseek-ai/dsh-client-store/lib/types/contract.d.ts`；宿主 `dsh-client-ui-sidebar-right`
  //  自己也是 `this.mounted.getSnapshot()`）。写成 `.get()` 不抛错、只永远拿 undefined
  // ⇒ 取全文的作用域非法 ⇒ 只剩摘要，还把带真 sessionId 的兜底座位压掉（真机 OBS-009）。
  assert.match(client, /snapshot\.getSnapshot\(\)/u, '必须按契约读 getSnapshot()')
  assert.match(
    client,
    /typeof snapshot\.get === 'function'[\s\S]{0,80}snapshot\.get\(\)/u,
    '兼容退路若保留，必须**真的调用** `get()`（只判类型不调用，与写错方法名是同一类错）',
  )
  // 报告建议②：没有会话 id 时**不许**用降级内容开（否则 `openedKey` 一置位就压掉正确路径）
  assert.match(
    client,
    /if \(sessionId === undefined\) \{[\s\S]{0,120}return false/u,
    '没有会话 id 时必须放弃本次打开、留给带真 sessionId 的兜底座位重试',
  )
  // OBS-011：`read` 只回一页，必须按 `eof` 续页，否则超过一页就静默截断
  assert.match(
    client,
    /files\.read\(sessionId, REVIEW_PATH, \{ offset, limit: PAGE_LINES \}, controller\?\.signal\)/u,
    '必须带 offset/limit 分页读',
  )
  assert.match(client, /result\.ok !== true/u, '必须先判 RemoteResult 信封的 ok')
  assert.match(
    client,
    /const page = result\.value/u,
    '必须**脱信封**取 result.value —— 直接读内层字段会永远拿不到文本且不抛错（真机 OBS-012）',
  )
  assert.match(client, /textOf\(page\)/u, '解析文本必须针对脱信封后的 page，而不是信封本身')
  assert.match(
    client,
    /probe\.fileRead = 'failed:remote'/u,
    '远端失败必须单独标注（不许被压成笼统的 unreadable）',
  )
  assert.match(client, /note\('read-review:remote', new Error\(failureText\(/u, '远端失败的具体原因必须写进 lastError')
  assert.match(client, /page\?\.eof === true \|\| rows === 0/u, '必须按 eof 判断读完没有')
  assert.match(client, /offset \+= rows/u, '必须按本页行数推进下一页起点')
  // 精确到调用形态：删掉 sessionId 就退化成"对屏上会话"，会话切换时会开错地方
  assert.ok(
    client.includes('openResourceIn(sessionId, address, { params })'),
    '必须用会话显式的 openResourceIn(sessionId, …)（不是不带会话的 openResource）',
  )
  assert.ok(
    client.includes('openTabIn(sessionId, TAB_KIND, { params })'),
    '按地址打开失败后必须有按 kind 打开的兜底（同样是会话显式的 openTabIn）',
  )
  // 回调块 = 从 `$on('user-questions/request'` 到本函数下一句（`probe.applied = true`）
  const handlerStart = client.indexOf("$on('user-questions/request'")
  const handlerEnd = client.indexOf('probe.applied = true', handlerStart)
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, '定位不到 waterfall 回调块')
  const handlerBlock = client.slice(handlerStart, handlerEnd)
  assert.ok(handlerBlock.includes('setPendingReview'), '回调必须把正文收下（否则兜底座位没有素材）')
  // **R-1（多会话正确性，2026-10-12 真机）**：打开用的会话必须是**提问所属会话**，
  // 由宿主给这条事件的作用域 `this` 现问 `sessions` 服务（官方问答客户端同款）——
  // 旧实现用 `sidebarRight.mounted`（屏幕上那个会话）⇒ 审核单会开进别的会话。
  assert.match(
    handlerBlock,
    /owner = ctx\.sessions\?\.scopeOf\?\.\(this\)/u,
    '必须用作用域 this 问出**提问所属会话**（ctx.sessions.scopeOf）',
  )
  assert.match(
    handlerBlock,
    /const session = typeof owner === 'string' && owner !== '' \? owner : currentSessionId\(ctx\)/u,
    '优先用所属会话；只有取不到时才退回屏上会话（并留痕 sessionSource）',
  )
  assert.ok(
    /openWithFull\(ctx, session, review, 'event'\)/u.test(handlerBlock),
    '回调里必须**立刻发起一次打开**（用所属会话）—— 上一版"只收下不开"真机 reading 是 opened:0',
  )
  // 处理器必须是 **function**：箭头函数拿不到作用域 this（拿不到就永远退化成屏上会话）
  assert.match(client, /ctx\.remote\.\$on\('user-questions\/request', function onSdoSignRequest\(request, next\)/u,
    '处理器必须用 function 声明（箭头函数拿不到作用域 this）')
  assert.match(handlerBlock, /return settled/u, '回调最后必须把 next() 的返回值原样传下去，绝不截断问答链')
  // ⑦ **卡片摘要 / 侧边栏全文的分工**（用户裁定 2026-10-10）：全文不许再塞进提问卡，
  //    改由宿主落盘 + 客户端只读取回。这条同时钉住"固定路径"（客户端拿不到门禁名）。
  assert.ok(
    client.includes("'.sdo/evidence/sign-reviews/latest.md'"),
    '必须按**固定路径**取全文（客户端拿不到门禁名）',
  )
  assert.ok(client.includes('ctx.remote?.workspaceFiles'), '必须用宿主自己的只读文件 Remote 取全文')
  // **宿主口径**（真机 OBS-006 三条，逐条对照宿主自带包核实过）：
  //   ① 点号服务名必须写进客户端半的 inject —— cordis 守卫对未声明的服务**在属性访问那一下就抛**
  //      `cannot get property "<prop>" without inject`（`@deepseek-ai/cordis/lib/index.js` Proxy 守卫）；
  //   ② 模块级 `dsh.client.inject` 必须列出提供方包（对照 dsh-client-ui-sidebar-files 的 package.json）；
  //   ③ 调用形态是**裸 sessionId**（对照 dsh-client-ui-sidebar-documentpreview：
  //      `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`）。
  assert.match(
    client,
    /inject: \[[^\]]*'remote\.workspaceFiles'/u,
    "客户端半的 inject 必须含点号服务名 'remote.workspaceFiles'（否则属性访问被 cordis 守卫拒绝）",
  )
  // **R-1**：线程/会话作用域服务必须声明（点号服务名 + 提供方包，与 OBS-006 同一纪律）
  assert.match(
    client,
    /inject: \[[^\]]*'sessions'/u,
    "客户端半的 inject 必须含 'sessions'（否则 ctx.sessions.scopeOf 的属性访问会被 cordis 守卫拒绝）",
  )
  assert.ok(
    (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-api-session-controller'),
    'dsh.client.inject 必须列出 @deepseek-ai/dsh-api-session-controller（客户端 sessions 服务的提供方）',
  )
  assert.ok(
    (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-api-workspace-files'),
    'dsh.client.inject 必须列出 @deepseek-ai/dsh-api-workspace-files（该 Remote 的提供方客户端半）',
  )
  assert.match(
    client,
    /files\.read\(sessionId, REVIEW_PATH, \{ offset, limit: PAGE_LINES \}/u,
    '必须照宿主口径用裸 sessionId 读取（scope 由 Typert 代查），并按 eof 续页',
  )
  assert.equal(
    /\{ sessionId \}, REVIEW_PATH/u.test(stripComments(client, ['probe.applied = true', 'function apply(ctx)'])),
    false,
    '不许再留"猜的" scope 对象形态（宿主自带包一律是裸 sessionId）',
  )
  // ④ 属性访问必须在 try 里（OBS-008：逃逸成 Uncaught (in promise) ⇒ 探针连原因都没有）
  const readFnStart = client.indexOf('async function readReviewFile')
  const readFnEnd = client.indexOf('function openReviewIn', readFnStart)
  assert.ok(readFnStart > 0 && readFnEnd > readFnStart, '定位不到 readReviewFile')
  const readFnBody = client.slice(readFnStart, readFnEnd)
  assert.ok(
    readFnBody.indexOf('try {') < readFnBody.indexOf('ctx.remote?.workspaceFiles'),
    '对 remote.workspaceFiles 的**属性访问必须在 try 内**（守卫在访问时就抛）',
  )
  assert.ok(
    readFnBody.includes("probe.fileRead = 'failed:no-workspaceFiles'"),
    '取不到通道时必须把原因写进探针 fileRead（不许异常逃逸、探针留空）',
  )
  // ⑤ 标题座位必须声明 locale —— 否则组件里的 `t` 不是函数（真机 OBS-007：座位崩溃）
  const titleSeat = client.slice(
    client.indexOf("ctx.slots.inject('sidebar.right.pane.tab.title'"),
    client.indexOf('ReviewTitle))'),
  )
  assert.ok(titleSeat.includes('locale: NS'), 'sidebar.right.pane.tab.title 座位必须声明 locale: NS（否则 t 不是函数）')
  assert.match(
    client,
    /const body = file\.ok \? file\.text : review\.markdown/u,
    '取不到全文必须**退化为摘要**（不回归：侧边栏至少还有摘要）',
  )
  assert.ok(client.includes('fileRead'), '探针必须暴露 fileRead（否则"取全文失败"与"打开失败"读出来一样）')
  // 光"函数体里有这些字符串"不够：必须**在打开函数里真的调用它**
  //（本守卫第一版只查了函数体，变异"把取全文那一步删掉"照样绿 —— 第四次同类假绿）。
  const openFullStart = client.indexOf('async function openWithFull')
  const openFullEnd = client.indexOf('function makeOpener', openFullStart)
  assert.ok(openFullStart > 0 && openFullEnd > openFullStart, '定位不到 openWithFull')
  assert.ok(
    client.slice(openFullStart, openFullEnd).includes('await readReviewFile(ctx, sessionId)'),
    '取全文的那一步必须在 openWithFull 里真的被调用（只留着函数定义不算）',
  )
  // 反向：上一版押的两个**没验证过的前提**不许回来（看**代码**，不看注释）
  const code = stripComments(client, ['probe.applied = true', 'function apply(ctx)'])
  assert.equal(/useSidebarMounted/u.test(code), false, '不许再押 hooks:sidebarMounted（该座位没声明 hook 上下文）')
  assert.equal(/\bhooks:\s*\{/u.test(code), false, '不许再依赖槽位 hooks 注入（没验证过它会被接线）')
  // 兜底座位：挂在两个"随时都在"的环境位上，用标准 prop sessionId
  assert.ok(client.includes("'conversation.input.dock'"), '兜底座位要挂在 conversation.input.dock（提问卡出现时输入框区可能不渲染）')
  assert.ok(client.includes("'conversation.composer.dock'"), '兜底座位同时挂在 conversation.composer.dock')
  assert.match(client, /function ReviewOpener\(\{ sessionId \}\)/u, '兜底座位必须用标准 prop sessionId（不靠 inject）')
  // ⑥ **失败与进度必须看得见**（真机教训：静默降级 ⇒ 右栏没弹却毫无报错）
  assert.ok(client.includes('__SDO_REVIEW__'), '必须把诊断探针挂到全局，便于浏览器控制台取证')
  assert.ok(client.includes('console.error'), '失败必须打到控制台，不许静默吞掉')
  assert.ok(client.includes('catch'), '打开侧边栏必须容错（不许把失败抛回问答链）')
  // 探针要能**分辨三段**：投递 / 收下 / 座位渲染 —— 上一版 `{applied:true,opened:0,lastError:''}`
  // 就是这个缺陷（三种成因读出来一模一样，白白多跑一轮真机）。
  // 断言**探针字面量本身**含这几个字段，而不是"文件里出现过这个词"
  //（`probe.captured += 1` 也会让关键词命中 —— 第一版就是这么写的，变异 Z24 没被杀）。
  const probeLiteral = /const probe = \{([^}]*)\}/u.exec(stripComments(client, ['probe.applied = true', 'function apply(ctx)']))
  assert.ok(probeLiteral !== null, '必须有一处 `const probe = { … }` 探针字面量')
  for (const field of ['applied', 'captured', 'seatRendered', 'fileRead', 'filePages', 'session', 'opened', 'stage', 'lastError']) {
    assert.ok((probeLiteral?.[1] ?? '').includes(field), `探针字面量必须含 ${field}（否则三种成因读出来一样）`)
  }
  // ⑦ 导航参数必须有**声明合并**（OBS-001：靠约定写、从未被类型校验）
  assert.ok(decl.includes('SidebarRightResourceParamsMap'), 'client.d.ts 必须声明参数映射那一片')
  assert.ok(decl.includes("'sdo-review'"), 'client.d.ts 必须声明本资源类型（地址里的 dsh-resource://sdo-review）')
  assert.ok(decl.includes('sdoReview'), 'client.d.ts 声明的参数形状必须与 client.js 读的一致')
  // ⑧ 标签页标题是**纯文本位**：必须走宿主的 markdown→纯文本提取器，且退化路径也要去强调符
  //    （技术库 tq_4e2eda88：把 markdown 原文塞进标题会让 `#`/`**`/反引号漏进 UI）
  //    注意断言**调用形态**而不是关键词 —— 关键词在注释里也出现，那样的守卫会被"只改注释"骗过
  //    （本守卫第一版就是这么写的，变异 Z18 没被杀）。
  assert.match(
    client,
    /primitives\.extractMarkdownPlainText/u,
    '标题必须真的调用宿主的 extractMarkdownPlainText（不是只在注释里提到它）',
  )
  assert.match(client, /extract\(text, \{ mode: 'first-line' \}\)/u, '必须以 first-line 模式提取单行标题')
  assert.match(client, /replace\(\/\[\*`_\]\/gu, ''\)/u, '提取器缺失时的退路也必须去掉强调符（** ` _）')
})

test('M88-06 宿主接线：签字问题只带**摘要**，全文落盘（卡片/侧边栏分工）', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // 摘要由 office 现算（不是模型传进来的），并作为第 3 个参数交给问答通道
  assert.match(index, /office\.signReview\(call, args\.gate\)/u, '签字前必须现算审核单（摘要 + 全文）')
  assert.match(
    index,
    /gateSignQuestion\?\.\(call, args\.gate, review\.summary\)/u,
    '提问卡只能拿**摘要**（卡片渲染的正是 detail；塞全文就会把卡片撑开）',
  )
  // 问答通道必须用传进来的 detail；缺省才退回旧的那句固定文案（老路径/无客户端场景）
  assert.match(index, /detail: detail \?\? t\('uiSign\.detail'\)/u, '问答卡必须优先使用传入的摘要')
  // 全文必须落盘，且**固定名**那份与客户端读的路径一致
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(
    office,
    /\['evidence', 'sign-reviews', 'latest\.md'\]/u,
    '全文必须落盘到 .sdo/evidence/sign-reviews/latest.md（客户端按固定路径取）',
  )
  assert.match(
    office,
    /store\.writeText\(\['evidence', 'sign-reviews', `\$\{doc\.gate\}\.md`\]/u,
    '同时按门禁归档一份（审计件）',
  )
  // 反向：签字审核单**不许**混进评审台账目录（`.sdo/reviews/` 是 `REV-*.yml`）
  assert.equal(
    /\['reviews',/u.test(stripComments(office, ['signReview(', "'evidence', 'sign-reviews'"])),
    false,
    '签字审核单不许写进 reviews/（那是评审台账，语义会打架）',
  )
})

test('M88-09 卡片摘要 = 判定总览那 5 行，且与全文总览**同源**（不许各写一份）', () => {
  const summary = renderSignReviewSummary(docOf())
  const lines = summary.trim().split('\n')
  assert.equal(lines.length, 5, `摘要必须正好 5 行（门禁/阶段/判定/判据计数/生成时间），实测 ${lines.length}`)
  for (const needle of ['G3', '架构门禁', '架构', '未通过', '3 条', '2026-10-09T12:00:00.000Z']) {
    assert.ok(summary.includes(needle), `摘要必须含 ${needle}`)
  }
  // 摘要**不许**带全文才有的东西（逐条判据表、未通过项、产物清单、标题行）
  for (const forbidden of ['# ', '## ', '| ', 'C-2D']) {
    assert.equal(summary.includes(forbidden), false, `摘要不许含全文内容：${forbidden}`)
  }
  // 同源：全文的前 5 行（跳过 `# 标题` 与空行）必须与摘要逐字一致
  const full = renderSignReviewDoc(docOf())
  const fullMeta = full.split('\n').filter((line) => line !== '').slice(1, 6)
  assert.deepEqual(fullMeta, lines, '摘要与全文的总览必须逐字一致（两处各写一份就会漂）')
})

test('M88-07 签字文案不得写死别的门禁编号（签 G7 时不许说 G3）', () => {
  const read = (locale: string): Record<string, Record<string, string>> =>
    parseYaml(readFileSync(join(ROOT, 'src', 'data', 'lang', `${locale}.yml`), 'utf8')) as Record<string, Record<string, string>>
  // `uiSign` 的文案是**任何门禁**共用的（选项说明直接下发到提问卡）⇒ 里面出现 G0…G9 必然是错的。
  // 真机缺陷（2026-10-09）：签交付门禁 G7 时，拒绝选项的说明写着"G3 不可通过"。
  const gateId = /\bG\d+\b/u
  for (const locale of ['zh-CN', 'en']) {
    const sign = read(locale).uiSign ?? {}
    for (const [key, value] of Object.entries(sign)) {
      // `header`/`question` 等都不该带编号；审核单段的标题由 `gateText` 现算，不在此列。
      assert.equal(gateId.test(value), false, `uiSign.${key}（${locale}）写死了门禁编号：${value}`)
    }
  }
})

test('M88-08 客户端半的投递锚点：profile 顶层行必须「启用 + 裸包名 + clientHalfOnly」（OBS-005）', () => {
  const patch = readFileSync(join(ROOT, 'presets', 'sdo-office.patch.yml'), 'utf8')
  const lines = patch.split('\n')
  // profile 顶层行 = **4 空格**缩进的 `- id:`（preset 内的插件行缩进更深；`- insert:` 在 0 列）
  const topRows = lines.filter((line) => /^ {4}- id:/u.test(line))
  assert.ok(
    topRows.some((line) => line.includes('preset-sdo-office')),
    '必须保留 preset 行（唯一会话入口，C-09）',
  )
  const anchorStart = lines.findIndex((line) => /^ {4}- id:\s*sdo-client-half-anchor\s*$/u.test(line))
  assert.ok(anchorStart >= 0, '必须有客户端半投递锚点行（否则浏览器端永远加载不到 ./client，真机 OBS-005）')
  const rest = lines.slice(anchorStart + 1)
  const nextRow = rest.findIndex((line) => /^ {4}- id:/u.test(line))
  const block = (nextRow < 0 ? rest : rest.slice(0, nextRow)).join('\n')

  // ① 行名必须是**裸包名**：`client-modules.locatePkgJson` 对子路径名直接返回 undefined（静默跳过）
  assert.match(
    block,
    /name:\s*'dsh-software-dev-office'/u,
    '锚点行必须用**裸包名**（子路径名 `pkg/sub` 会被 locatePkgJson 直接判为不可解析、静默跳过）',
  )
  // ② 行**不能** disabled：组图会跳过 `entry.disabled` 与没有 fiber 的行（真机第一版就死在这条）
  assert.equal(
    /^\s*disabled:\s*true\s*$/mu.test(block),
    false,
    '锚点行不许 disabled —— client-modules 组图时会跳过禁用行（真机复测 delivered:false）',
  )
  // ③ 既然要挂载出 fiber，就必须靠配置让 apply **什么都不注册**（否则 profile 层会加载整个宿主半）
  assert.match(
    block,
    /clientHalfOnly:\s*true/u,
    '锚点行必须带 config.clientHalfOnly: true（挂载出 fiber 但不注册任何东西，守住 E2E-09 / AC-007）',
  )
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(
    index,
    /if \(config\.clientHalfOnly === true\) return/u,
    'apply 必须在 clientHalfOnly 时立刻返回（这是"挂载但不注册"的机械保证）',
  )
  // 反向①：preset 行不得 disabled，否则连选了 preset 的会话也不加载 SDO
  const presetRow = lines.findIndex((line) => /^ {4}- id:\s*preset-sdo-office\s*$/u.test(line))
  assert.ok(presetRow >= 0 && presetRow < anchorStart, 'preset 行必须在锚点行之前')
  // 只看**非注释行**：锚点行的说明注释夹在这段区间里，里面到处是 `clientHalfOnly` 这个词
  const presetBlock = lines
    .slice(presetRow, anchorStart)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
  assert.equal(
    /^\s*disabled:\s*true\s*$/mu.test(presetBlock),
    false,
    'preset 行不许 disabled（否则 SDO 在任何会话里都不加载）',
  )
  assert.equal(
    /clientHalfOnly/u.test(presetBlock),
    false,
    'preset 行**不许**带 clientHalfOnly（否则选了 preset 的会话也只剩一个空壳）',
  )
  // 反向②：profile 顶层**只许**这两条 —— 能力行（工具/命令/注入）必须留在 preset 内
  assert.equal(topRows.length, 2, `profile 顶层只许有 preset 行与锚点行两条，实测 ${topRows.join(' | ')}`)
})

test('M88-10 作答后自动关闭：结算信号取自身 waterfall 的 `next()` 完成，且只关自己那一页', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')

  // ① **结算信号**必须来自我们自己的 `next()` 完成 —— 客户端可见的问答事件只有
  //    `user-questions/request`（没有"已作答"事件），而 `userQuestions` 投影只记 timed 路径，
  //    SDO 走的是服务级 `ask()` ⇒ 自续接是唯一必然触发的信号。
  assert.match(client, /const settled = next\(\)/u, '必须把 `next()` 的返回值接住（只调用一次）')
  assert.match(client, /return settled/u, '必须把 `next()` 的返回值原样传给下游（不许截断问答链）')
  assert.match(
    client,
    /Promise\.resolve\(settled\)\.then\(\(answer\) => \{[\s\S]{0,80}markSettled\(review\.key\)/u,
    '必须用 `next()` 的完成当结算信号',
  )
  // ② **不许早关**：没人认领时 `next()` 会以 undefined 完成，那时用户还没作答
  assert.match(
    client,
    /if \(answer !== undefined\) markSettled\(review\.key\)/u,
    '只有真的拿到答复才算结算（undefined 时关页 = 用户还没答就把页收了）',
  )
  // ③ 关闭用宿主公开口径，且 tabId 来自标准 prop
  // **R-2（2026-10-12 真机）**：关页在**插件根**按**地址**找自己那页（pane 可能一直不可见，
  // 它的 effect 不会跑 ⇒ 旧实现下陈旧标签页永远关不掉）。
  assert.match(client, /function closeSettledReview\(ctx, sessionId, key\)/u, '必须有根级的结算关页函数')
  assert.match(
    client,
    /String\(record\?\.navigation\?\.address \?\? ''\) !== address/u,
    '必须按**地址**认出自己那页（不依赖 pane 可见性）',
  )
  assert.match(client, /ctx\.sidebarRight\.closeIn\(sessionId, record\.id\)/u, '必须用 closeIn(sessionId, tabId) 关自己那页')
  assert.match(client, /const tab = useTabInfo\(\)/u, 'tabId 必须来自标准 prop useTabInfo()（宿主自带包同款）')
  // 关页侧按**地址**认页（`addressFor(key)` = 打开时用的那个地址），不再依赖 pane 里的 tabInfo
  assert.match(client, /const address = addressFor\(key\)/u, '必须按打开时用的**地址**认"是不是我这页"')
  assert.equal(
    /keyOfAddress\(tab\?\.tab\?\.navigation\?\.address\)/u.test(client),
    false,
    '旧实现"在 pane 里按 key 认页并关闭"已被 R-2 取代，不许回来',
  )
  // ④ 只关一次 + 关不掉不影响签字
  // 只关一次：按 `会话:key` 记已关集合（重复通知/重渲染不重复关）
  assert.match(client, /const token = `\$\{sessionId\}:\$\{key\}`/u, '必须以「会话:key」为幂等键')
  assert.match(client, /if \(closedKeys\.has\(token\)\) return/u, '必须只关一次（重复通知/重渲染会重复触发）')
  assert.equal(/closedKey === key/u.test(client), false, '旧的单值 closedKey 已被集合取代，不许回来')
  assert.match(client, /note\('close-review', error\)/u, '关不掉必须只留痕，不许抛回渲染')
  // ⑤ 探针要能分辨"关了没有、为什么、收起了没有"
  for (const field of ['closed', 'collapsed', 'closeWhy']) {
    assert.match(client, new RegExp(`${field}:`, 'u'), `探针字面量必须含 ${field}`)
  }
  // ⑥ **收起面板的判据**（用户口径 2026-10-10）：只有"这一栏关了之后没有别的标签页"才收起。
  //    `toggleExpanded` 是**双向**开关且**会被录制进序列** —— 用户还开着别的页时替他收起，
  //    属越权改动界面；不加 `isExpanded()` 判断还可能把"收起"变成"展开"。
  assert.match(
    client,
    /ctx\.sidebarRight\.tabsIn\?\.\(sessionId\)/u,
    '必须用 tabsIn(sessionId) 数这一栏还有没有别的页',
  )
  //    判据必须是"**除了宿主引导页**没有别的页"：宿主引导页（`sidebar://guide`，`GUIDE_KIND='guide'`）
  //    是这一栏常驻的门，不是用户开的页 —— 不排除它，`tabsIn()` 永远 ≥ 1，收起永远不触发
  //    （真机 OBS-014：作答后剩下的是宿主自己的「开始」页）。
  assert.match(client, /const GUIDE_ADDRESS = 'sidebar:\/\/guide'/u, '必须定义宿主引导页地址常量')
  assert.match(
    client,
    /addressOf\(record\) !== address && addressOf\(record\) !== GUIDE_ADDRESS/u,
    '计数必须同时排除"自己这一页"与"宿主引导页"',
  )
  assert.match(client, /if \(others === 0 && expanded\)/u, '只有"没有别的页"且"当前是展开态"才允许收起')
  assert.match(client, /expanded = ctx\.sidebarRight\.isExpanded\?\.\(\) === true/u, '展开态必须真去读 isExpanded()')
  // 守卫的**实际取值**必须落进探针（上一轮就是靠"计数 + 剩下页是什么"才定案的）
  assert.match(
    client,
    /probe\.closeGuard = \{ others, expanded, rest \}/u,
    '守卫取值（others/expanded/剩余页地址）必须写进探针，否则下次还要靠猜',
  )
  assert.match(client, /ctx\.sidebarRight\.toggleExpanded\?\.\(\)/u, '收起用宿主公开的 toggleExpanded()')
  // **R-2**：结算必须在**插件根**监听并关页（pane 不可见时它的 effect 不会跑）
  assert.match(
    client,
    /ctx\.effect\(\(\) => \{\s*\n\s*const listener = \(\) => \{\s*\n\s*closeSettledReview\(ctx, lastReviewSession, settledKey\)/u,
    '必须在插件根注册"结算即关页"的监听（不依赖 pane 可见性）',
  )

  // **R-3**：pane 在参数里没有正文时，必须**按固定路径重读**并自证（不再只显示一句"取不到"）
  const pane = client.slice(client.indexOf('function makeDocument(ctx)'), client.indexOf('function ReviewTitle('))
  assert.match(pane, /readReviewFile\(ctx, sessionId\)/u, 'pane 必须在缺正文时按固定路径重读')
  assert.match(pane, /probe\.lastMissing = \{/u, 'pane 必须把"参数就没有"这一现场写进探针（R-3 自证）')
  assert.match(pane, /probe\.paneRead = /u, 'pane 必须把重读结果写进探针')
  // 顺序：**先数后关**（tabsIn 读的是已提交记录，关完再读可能还没提交）
  // 计数的时序问题改由**按地址排除自己**解决（不再依赖"先数后关"）：
  // `tabsIn` 读的是已提交记录，关完再数可能把刚关掉的那页又数进来，所以判据是地址而非次序。
  assert.match(
    client,
    /addressOf\(record\) !== address && addressOf\(record\) !== GUIDE_ADDRESS/u,
    '计数必须按地址排除自己（否则关完再数会把已关的页又数进来）',
  )
  // 反向：pane 里**不许**再有关页逻辑（否则又回到"不可见就不跑"的老毛病）
  const paneStart = client.indexOf('function makeDocument(ctx)')
  const paneEnd = client.indexOf('function ReviewTitle(', paneStart)
  assert.ok(paneStart > 0 && paneEnd > paneStart, '定位不到 makeDocument')
  assert.equal(
    /closeIn|toggleExpanded/u.test(client.slice(paneStart, paneEnd)),
    false,
    'pane 里不许再有关页/收起逻辑（R-2：必须在插件根做）',
  )
  // 数不清时**保守**按"还有别的页"处理（宁可面板不收，也不要误收用户的栏）
  assert.match(
    client,
    /let others = 1[\s\S]{0,900}note\('count-tabs', error\)/u,
    '数不清时必须保守（默认当成还有别的页），不许在异常路径上收面板',
  )
})
