/**
 * SDO 客户端半：把**门禁签字审核单**放进右侧边栏，可滚动通读。
 *
 * 为什么需要客户端半：宿主侧 `sdo_gate action=sign channel=question` 只能把**提问卡**用到的
 * 那几个字段送到浏览器；"在右侧边栏打开、可滚动"是**客户端插件**的能力
 * （`sidebarRight` / `sidebarRightTabs` / `sidebar.right.pane.tab` 座位），宿主驱动不了它。
 *
 * **卡片与侧边栏的分工**（用户裁定 2026-10-10）：
 *   · 提问卡只放**摘要**（判定总览那 5 行：门禁/阶段/判定/判据计数/生成时间）—— 卡片渲染的正是
 *     `detail`，所以正文一旦塞进去卡片就会被撑开；用户明确要求卡片只留摘要。
 *   · 全文（逐条判据 + 未通过项与修法 + 产物清单）由宿主落盘到 **`.sdo/reviews/<门禁>.md`
 *     与固定名的 `.sdo/reviews/latest.md`**，本客户端半按**固定路径**用宿主自己的**只读文件
 *     Remote**（`ctx.remote.workspaceFiles.read`）取回来放进侧边栏。
 *     取不到就**退化为摘要**（不回归），并把原因写进探针。
 *
 * **打开时机（两版真机教训之后的形态）**：`sidebarRight.openResource` 对"屏幕上那个会话"生效，
 * 所以会话 id 从 `ctx.sidebarRight.mounted` 现取（宿主文档：它比 React 渲染更早更新），
 * 用 **`openResourceIn(sessionId, …)`** 显式指定；**兜底座位**挂在两个"随时都在"的环境位上，
 * 用**标准 prop `sessionId`**（不依赖 `hooks`/`inject`）。两条路径共用一把"已开"锁。
 *
 * 怎么收到提问：`user-questions/request` 是一条 **waterfall** 事件，契约原文是
 * “Return an answer to claim the request or call `next()` to delegate”。本插件只做**旁观者**：
 * 收下问题后**无条件 `next()` 委派**给真正的答复者 —— 绝不截断问答链。
 *
 * **失败与进度必须看得见**：每一处都 `console.error` 留痕，并把现场记进
 * `globalThis.__SDO_REVIEW__`（浏览器控制台可直接读）：
 *
 *   { applied, captured, seatRendered, fileRead, opened, stage, lastError }
 *     applied      模块执行过（false/undefined ⇒ 根本没投递）
 *     captured     收到过几次本插件的签字提问（0 ⇒ 事件没到或问题 id 不匹配）
 *     seatRendered 兜底座位渲染过没有
 *     fileRead     全文取回结果（ok:<调用形态> / failed:<原因>）—— 失败时侧边栏只有摘要
 *     opened       成功打开过几次
 *     stage/lastError  最后一次动作与最后一次错误原文
 *
 * 但仍**不影响签字**：侧边栏只是多一个视图，打不开也不能让签字流程失败。
 *
 * 本文件是**浏览器模块**（`window.__ModuleLoader__` 协议），不是 tsc 的产物；
 * `require` 只能解析静态模块表（react / dsh-client-ui-primitives 等基线模块）。
 * 导航参数的类型契约见同目录 `client.d.ts`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-software-dev-office',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 本实现的身份，也是 `sidebar.right.pane.tab` / `.title` 座位上的 key。 */
    const TAB_ID = 'dsh-software-dev-office/review'
    /** 座位的 kind：`dsh-resource://sdo-review/**` 的地址归它。 */
    const TAB_KIND = 'sdo-review'
    /** 宿主侧 `gateSignQuestion` 用的固定问题 id（见 src/index.ts）。 */
    const SIGN_QUESTION_ID = 'sdo-gate-sign'
    /**
     * 审核单全文的**固定路径**（宿主 `office.signReview` 落盘处）。
     * 落在 `evidence/sign-reviews/` 而不是 `reviews/` —— 后者是**评审台账**（`REV-*.yml`），别混。
     * 必须固定：客户端只按路径取，拿不到门禁名（门禁名在提问摘要里，解析它是脆弱做法）。
     */
    /**
     * 宿主**引导页**的地址（`sidebar://<kind>`，host 的 `pageAddress(GUIDE_KIND)`，`GUIDE_KIND = 'guide'`）。
     *
     * 它是这一栏**常驻**的"门"，不是用户开的页 —— 收起面板的判据必须把它排除，
     * 否则 `tabsIn()` 永远 ≥ 1、"关完就收起"永远不成立（真机 OBS-014 的根因，
     * 报告 §15：作答后剩下的是宿主自己的「开始」页）。
     */
    const GUIDE_ADDRESS = 'sidebar://guide'
    const REVIEW_PATH = '.sdo/evidence/sign-reviews/latest.md'
    /** 续页时每页请求的行数（宿主可能会按自己的 `maxLines` 再收窄）。 */
    const PAGE_LINES = 400
    const NS = 'sdo-review'
    const SCHEME = 'dsh-resource://sdo-review/'
    let sequence = 0

    const DICT = {
      zh: {
        tab: '门禁审核单',
        missing: '这份审核单的正文没有取到（旧版宿主或缺只读文件通道）。请在会话里的签字卡片中查看摘要。',
      },
      en: {
        tab: 'Gate review',
        missing: 'The review body could not be loaded (an older host, or no read-only file channel). Read the summary in the signature card in the conversation.',
      },
    }

    /** 诊断探针（浏览器控制台读 `__SDO_REVIEW__`）：投递 / 收下 / 座位 / 取全文 / 打开 五段现场。 */
    const probe = {
      applied: false,
      captured: 0,
      seatRendered: false,
      fileRead: '',
      filePages: 0,
      session: '',
      closed: 0,
      collapsed: 0,
      closeWhy: '',
      closeGuard: undefined,
      opened: 0,
      stage: 'loading',
      lastError: '',
    }
    globalThis.__SDO_REVIEW__ = probe

    function note(stage, error) {
      probe.stage = stage
      probe.lastError = error instanceof Error ? error.message : String(error)
      try {
        console.error(`[dsh-software-dev-office] ${stage}: ${probe.lastError}`)
      } catch {
        /* 控制台不可用时也不能抛 */
      }
    }

    // —————————————————————— 待打开的审核单（waterfall 收下 → 打开） ——————————————————————

    let pendingReview
    const listeners = new Set()
    function setPendingReview(review) {
      pendingReview = review
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不能影响其它订阅者 */
        }
      }
    }
    function usePendingReview() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((count) => count + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return pendingReview
    }

    /**
     * 屏幕上那个会话的 id（`sidebarRight.mounted` 比 React 渲染更早更新，事件回调里读得到）。
     *
     * **契约是 `getSnapshot()`，没有 `get()`**（`@deepseek-ai/dsh-client-store` 的
     * `lib/types/contract.d.ts`：`ObservableSnapshot<T>` 只有 `getSnapshot()` 与 `subscribe()`）。
     * 宿主自己的 `dsh-client-ui-sidebar-right` 读它也是 `this.mounted.getSnapshot()`。
     * 写成 `.get()` 不会抛错、只会**永远拿到 undefined** —— 真机 OBS-009 就是这么静默降级的：
     * 会话 id 恒空 ⇒ 取全文的作用域非法 ⇒ 只有摘要 ⇒ 还把带真 sessionId 的兜底座位压掉。
     * `get()` 只作兼容退路，而且**必须真的调用它**（`typeof x === 'function'` 后忘了调用是同一类错）。
     */
    // —————————————————————— 提问是否已结算（作答后自动关标签页） ——————————————————————

    /**
     * 已结算（用户作答）的审核单 key。
     *
     * **为什么用 `next()` 的完成当信号**：客户端可见的问答远端事件**只有 `user-questions/request`**
     * （`@deepseek-ai/dsh-api-remotes` 的 remote-events 白名单里没有"已作答"事件），而
     * `userQuestions` 投影只记 **timed** 路径的调用（SDO 走的是服务级 `ask()`）⇒ 投影不可靠。
     * 唯一必然触发的信号是：我们**就在这条 waterfall 上**，把请求委派出去之后，**这次 `next()`
     * 的完成**就是"提问已结算"（用户作答 / 被取代）。
     */
    let settledKey = ''
    const settledListeners = new Set()
    function markSettled(key) {
      if (typeof key !== 'string' || key === '') return
      settledKey = key
      for (const listener of settledListeners) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不能影响其它订阅者 */
        }
      }
    }
    function useSettledKey() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((count) => count + 1)
        settledListeners.add(listener)
        return () => {
          settledListeners.delete(listener)
        }
      }, [])
      return settledKey
    }

    /** 从资源地址取回审核单 key（与 `addressFor` 互为逆运算）。 */
    function keyOfAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(SCHEME)) return ''
      try {
        return decodeURIComponent(address.slice(SCHEME.length))
      } catch {
        return ''
      }
    }

    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sidebarRight?.mounted
        if (snapshot === undefined || snapshot === null) return undefined
        const session = typeof snapshot.getSnapshot === 'function'
          ? snapshot.getSnapshot()
          : typeof snapshot.get === 'function'
            ? snapshot.get()
            : undefined
        return typeof session === 'string' && session !== '' ? session : undefined
      } catch (error) {
        note('read-mounted', error)
        return undefined
      }
    }

    /**
     * `detail` 的第一行当标题 —— **走宿主自带的纯文本提取器**（`extractMarkdownPlainText`）。
     * markdown 语法（`#`、`**`、反引号）与换行会漏进标签页，而标签页标题是**纯文本位**。
     */
    function firstLine(markdown) {
      const text = String(markdown)
      const extract = primitives.extractMarkdownPlainText
      if (typeof extract === 'function') {
        try {
          const title = extract(text, { mode: 'first-line' })
          if (typeof title === 'string' && title.trim() !== '') return title.trim()
        } catch {
          /* 提取器抛错也要能退化 */
        }
      }
      const line = text.split('\n').find((item) => item.trim() !== '')
      return (line ?? '').replace(/^#+\s*/u, '').replace(/[*`_]/gu, '').trim()
    }

    function isReviewAddress(address) {
      return typeof address === 'string' && address.startsWith(SCHEME)
    }

    function addressFor(key) {
      return SCHEME + encodeURIComponent(key)
    }

    function reviewOf(request) {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      const question = questions.find((item) => item?.id === SIGN_QUESTION_ID)
      if (question === undefined || typeof question.detail !== 'string' || question.detail.trim() === '') return undefined
      return {
        markdown: question.detail,
        title: firstLine(question.detail) || 'SDO',
        key: request?.wait?.callId === undefined ? `q${(sequence += 1)}` : String(request.wait.callId),
      }
    }

    /** 正文从导航参数来（`SidebarRightResourceParamsMap['sdo-review']`，见 client.d.ts）。 */
    function documentOf(params) {
      if (params === null || typeof params !== 'object') return undefined
      const doc = params.sdoReview
      if (doc === null || typeof doc !== 'object') return undefined
      if (typeof doc.markdown !== 'string') return undefined
      return doc
    }

    /** 远端失败的文本面（`RemoteFailure` 的形状不做假设：message / code / 序列化都试）。 */
    function failureText(failure) {
      if (failure === undefined || failure === null) return 'no-value'
      if (typeof failure === 'string') return failure
      if (typeof failure.message === 'string' && failure.message !== '') return failure.message
      if (typeof failure.code === 'string' && failure.code !== '') return failure.code
      try {
        return JSON.stringify(failure) ?? 'no-value'
      } catch {
        return 'no-value'
      }
    }

    /**
     * 只读文件回包的文本面：`string` / `{ text }` 两种形态。
     * 注意 `WorkspaceFileText.lines` 是**数字**（本页几行），不是行数组 —— 别照猜。
     */
    function textOf(result) {
      if (typeof result === 'string') return result
      if (result === null || typeof result !== 'object') return undefined
      if (typeof result.text === 'string') return result.text
      return undefined
    }

    /**
     * 取审核单**全文**（只读文件 Remote）。
     *
     * **必须先声明 `remote.workspaceFiles` 才允许碰它**：cordis 的服务守卫对没声明的点号服务
     * 直接抛 `cannot get property "<prop>" without inject`（宿主 `@deepseek-ai/cordis/lib/index.js`
     * 的 Proxy 守卫原文），而且**属性访问那一下就抛** —— 所以访问本身必须在 `try` 里，
     * 否则异常会以 `Uncaught (in promise)` 逃逸，探针连原因都留不下（真机 OBS-008）。
     * 调用形态照宿主自带包 `dsh-client-ui-sidebar-documentpreview`：
     * `remote.workspaceFiles.read(sessionId, path, { … }, signal)` —— **裸 sessionId**，
     * scope 由 Typert 代查（`read({sessionId}, …)` 是上一版猜的形态，已删）。
     */
    async function readReviewFile(ctx, sessionId) {
      let files
      try {
        files = ctx.remote?.workspaceFiles
      } catch (error) {
        probe.fileRead = 'failed:no-workspaceFiles'
        note('read-review:access', error)
        return { ok: false, why: 'no-workspaceFiles' }
      }
      if (files === undefined || typeof files.read !== 'function') {
        probe.fileRead = 'failed:no-workspaceFiles'
        return { ok: false, why: 'no-workspaceFiles' }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      // **必须续页取全**：`read` 只回一页（`{ offset, lines, eof }`），审核单一旦超过一页，
      // 只取首页就会**静默截断**（真机 OBS-011）。页与页之间用 `\n` 接回原文
      //（每页 text 末尾不带换行符）。
      const MAX_PAGES = 20
      const pages = []
      let offset = 1
      try {
        for (let index = 0; index < MAX_PAGES; index += 1) {
          const result = await files.read(sessionId, REVIEW_PATH, { offset, limit: PAGE_LINES }, controller?.signal)
          // **客户端 remote 的返回值是 `RemoteResult` 信封**：
          // `{ ok: true, value: T } | { ok: false, error: RemoteFailure }`
          //（`@deepseek-ai/dsh-typert-protocol` 的 types：What every generated Remote method resolves to）。
          // 不脱信封 ⇒ 永远读不到内层字段，而且**不抛错** ⇒ 被压成笼统的 `unreadable`、`lastError` 还空着
          //（真机 OBS-012）。官方消费者 `dsh-client-ui-sidebar-documentpreview` 就是"先判 ok、再取 value"。
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            probe.fileRead = 'failed:remote'
            note('read-review:remote', new Error(failureText(result?.error)))
            return { ok: false, why: 'remote' }
          }
          const page = result.value
          const chunk = textOf(page)
          if (typeof chunk === 'string') pages.push(chunk)
          const rows = typeof page?.lines === 'number' ? page.lines : 0
          if (page?.eof === true || rows === 0) {
            probe.filePages = index + 1
            const text = pages.join('\n')
            if (text.trim() === '') break
            return { ok: true, text, shape: 'sessionId' }
          }
          offset += rows
        }
      } catch (error) {
        note('read-review:sessionId', error)
      }
      if (pages.length > 0) {
        // 到页数上限还没读完：**如实标注**，别假装取全了
        probe.filePages = pages.length
        return { ok: true, text: pages.join('\n'), shape: 'sessionId', truncated: true }
      }
      return { ok: false, why: 'unreadable' }
    }

    /**
     * 打开侧边栏 —— **优先会话显式**的 `openResourceIn(sessionId, …)`，失败再退到
     * 按 kind 开、最后退到不带会话的 `openResource`。三段都失败就留痕。
     * **任何分支都不抛给调用方。**
     */
    function openReviewIn(ctx, sessionId, review) {
      const params = { sdoReview: { markdown: review.markdown, title: review.title } }
      const address = addressFor(review.key)
      const attempt = (stage, run) => {
        try {
          run()
          probe.opened += 1
          probe.stage = stage
          return true
        } catch (error) {
          note(stage, error)
          return false
        }
      }
      if (sessionId !== undefined && ctx.sidebarRight.openResourceIn !== undefined) {
        if (attempt('opened', () => ctx.sidebarRight.openResourceIn(sessionId, address, { params }))) return true
      }
      if (sessionId !== undefined && ctx.sidebarRight.openTabIn !== undefined) {
        if (attempt('opened-by-kind', () => ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, { params }))) return true
      }
      return attempt('opened-global', () => ctx.sidebarRight.openResource(address, { params }))
    }

    /** 同一份审核单只开一次（两条路径会并发：事件回调 + 兜底座位）。 */
    let openedKey = ''

    /**
     * **取全文 → 打开**。两条路径（事件回调 / 兜底座位）都走这里，靠 `openedKey` 去重。
     * 全文取不到就用摘要当正文（不回归），失败原因落在探针 `fileRead`。
     */
    async function openWithFull(ctx, sessionId, review, origin) {
      if (openedKey === review.key) return true
      probe.session = sessionId === undefined ? 'none' : 'mounted'
      // **没有会话 id 就不开**：全局 `openResource` 虽然还能弹出，但正文只能退化成摘要，
      // 而且 `openedKey` 一置位就把**带真 sessionId 的兜底座位**永久压掉 ——
      // "先弹个只有摘要的页"会把正确路径挤死（真机 OBS-009 的附带后果）。留给座位重试。
      if (sessionId === undefined) {
        probe.stage = `no-session:${origin}`
        return false
      }
      const file = await readReviewFile(ctx, sessionId)
      probe.fileRead = file.ok ? (file.truncated === true ? 'ok:truncated' : `ok:${file.shape}`) : `failed:${file.why}`
      if (openedKey === review.key) return true
      const body = file.ok ? file.text : review.markdown
      const title = firstLine(body) || review.title
      if (openReviewIn(ctx, sessionId, { ...review, markdown: body, title })) {
        openedKey = review.key
        probe.stage = `opened-from-${origin}`
        return true
      }
      return false
    }

    /**
     * **兜底打开器**：一个只做副作用的座位组件（渲染 `null`）。
     * 只在事件回调那次没开成时才有意义；用**标准 prop `sessionId`**，不依赖 `hooks`/`inject`。
     */
    function makeOpener(ctx) {
      return function ReviewOpener({ sessionId }) {
        const review = usePendingReview()
        const [opened, setOpened] = React.useState('')
        const [attempt, setAttempt] = React.useState(0)
        React.useEffect(() => {
          probe.seatRendered = true
          if (review === undefined || opened === review.key || attempt >= 3) return undefined
          let cancelled = false
          const timer = setTimeout(() => {
            void openWithFull(ctx, sessionId, review, 'seat').then((ok) => {
              if (cancelled) return
              if (ok) setOpened(review.key)
              else setAttempt((count) => count + 1)
            })
          }, 0)
          return () => {
            cancelled = true
            clearTimeout(timer)
          }
        }, [review, opened, attempt, sessionId])
        return null
      }
    }

    /** 同一份审核单只关一次（重渲染/切会话会重复触发 effect）。 */
    let closedKey = ''

    /**
     * 侧边栏正文：整份审核单，Markdown 渲染，**可滚动**；**作答后自己关掉**。
     *
     * `closeIn(sessionId, tabId)` 是宿主公开的关闭口径（`dsh-client-ui-sidebar-right` 的
     * `service.d.ts`：「Close a tab of one session, preserving the sole docked guide」），
     * `tab.id` 来自标准 prop `useTabInfo()`（宿主自带包也是这么取 tabId 的）。
     * 关不掉**不影响签字**：只留痕，不抛回调用方。
     */
    function makeDocument(ctx) {
      return function ReviewDocument({ sessionId, useTabInfo, t }) {
      const tab = useTabInfo()
      const settled = useSettledKey()
      const doc = documentOf(tab?.tab?.navigation?.params)
      React.useEffect(() => {
        const key = keyOfAddress(tab?.tab?.navigation?.address)
        if (key === '' || settled !== key || closedKey === key) return undefined
        closedKey = key
        try {
          const myTabId = tab.tab.id
          // **先数、后关**：`tabsIn` 读的是**已提交**的记录，关完再读可能还没提交
          //（契约原文：Read the committed tabs of a Session … or an empty list before adoption）。
          // 数不清就**保守**按"还有别的页"处理 —— 宁可面板不收，也不要误收用户的栏。
          let others = 1
          let rest = ''
          let expanded = false
          try {
            const records = ctx.sidebarRight.tabsIn?.(sessionId) ?? []
            const addressOf = (record) => String(record?.navigation?.address ?? record?.contentId ?? '')
            // 排除**自己这一页**与**宿主引导页**；其余任何页（文档、别的插件、别的审核单…）
            // 都算"用户还开着别的东西"，那时**不许**动面板。
            const remaining = records.filter((record) => record?.id !== myTabId && addressOf(record) !== GUIDE_ADDRESS)
            others = remaining.length
            rest = remaining.map(addressOf).join(' ').slice(0, 120)
            expanded = ctx.sidebarRight.isExpanded?.() === true
            // 把守卫的**实际取值**落进探针：上一轮就是靠"collapsed:0 + lastError:'' + 剩下页是什么"
            // 才定到守卫上的，只留一个计数不足以定案（报告 §15.4 明确要求）。
            probe.closeGuard = { others, expanded, rest }
          } catch (error) {
            note('count-tabs', error)
          }
          ctx.sidebarRight.closeIn(sessionId, myTabId)
          probe.closed += 1
          probe.closeWhy = 'settled'
          // **只有这一栏关了之后没有别的标签页，才收起面板**（用户口径 2026-10-10）。
          // `toggleExpanded` 是**双向**开关且**会被录制进序列**（用户可见的界面状态变更）——
          // 用户还开着别的页时替他收起，属越权改动界面。`isExpanded()` 先判，避免把"收起"
          // 变成"展开"。
          if (others === 0 && expanded) {
            ctx.sidebarRight.toggleExpanded?.()
            probe.collapsed += 1
            probe.closeWhy = 'settled-collapsed'
          }
        } catch (error) {
          note('close-review', error)
        }
        return undefined
      }, [settled, sessionId, tab])
      if (doc === undefined) {
        return React.createElement('div', {
          role: 'status',
          style: { padding: '24px', color: 'var(--dsw-alias-label-secondary)', fontSize: 14, lineHeight: 1.75 },
        }, t('missing'))
      }
      return React.createElement('section', {
        'data-sdo-review': tab.tab.navigation.address,
        'aria-label': doc.title,
        style: { height: '100%', overflow: 'auto', padding: '20px 24px 40px' },
      }, React.createElement('div', {
        style: {
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 14,
          lineHeight: 1.75,
          overflowWrap: 'anywhere',
        },
      }, React.createElement(primitives.MarkdownText, { text: doc.markdown })))
      }
    }

    /** 标签页标题：用审核单自己的首行标题（纯文本），而不是一个泛称。 */
    function ReviewTitle({ useTabInfo, t }) {
      const tab = useTabInfo()
      const doc = documentOf(tab?.tab?.navigation?.params)
      return React.createElement('span', null, doc === undefined ? t('tab') : doc.title)
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'sdo-review: dictionaries')

      // ① 注册标签页类型：只认 `dsh-resource://sdo-review/**`（`patterns` 含 `:` 时匹配整串地址）。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        patterns: [`${SCHEME}**`],
        canOpen: isReviewAddress,
        title: () => t('tab'),
      }), 'sdo-review: sidebar tab type')

      // ② 正文与标题按**实现的 id** 落座（注册契约：body/title 用 definition.id 当 key）。
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, makeDocument(ctx)))
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: NS,
      }, ReviewTitle))

      // ③ **兜底座位**：挂在两个"随时都在"的环境位上（提问卡出现时输入框区的座位可能不渲染）。
      const ReviewOpener = makeOpener(ctx)
      for (const slot of ['conversation.input.dock', 'conversation.composer.dock']) {
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          id: `${TAB_ID}/${slot === 'conversation.input.dock' ? 'input' : 'dock'}`,
          order: 100,
        }, ReviewOpener))
      }

      // ④ 旁观签字提问：收下（此时 `detail` 只有**摘要**），交给 `openWithFull` 取全文并打开，
      //    然后照旧 `next()` 委派给真正的答复者 —— 绝不截断问答链、也不在这里 await
      //    （await 会把提问卡本身推迟到文件读完之后）。
      ctx.remote.$on('user-questions/request', (request, next) => {
        let review
        try {
          review = reviewOf(request)
          if (review !== undefined) {
            probe.captured += 1
            probe.stage = 'captured'
            setPendingReview(review)
            void openWithFull(ctx, currentSessionId(ctx), review, 'event')
          }
        } catch (error) {
          note('read-question', error)
        }
        // 委派给真正的答复者（**只调用一次** `next()`，返回值原样传下去）。
        const settled = next()
        if (review !== undefined) {
          // **结算信号**：这次 `next()` 完成即"提问已结算"。但只有**真的拿到答复**
          //（`answer !== undefined`）才算 —— 没人认领时它是 undefined，
          // 那种情况**不能**关标签页（否则用户还没作答，页就没了）。
          void Promise.resolve(settled).then((answer) => {
            if (answer !== undefined) markSettled(review.key)
          }, () => {})
        }
        return settled
      })

      probe.applied = true
      probe.stage = 'applied'
      try {
        console.info('[dsh-software-dev-office] client half applied (sdo-review)')
      } catch {
        /* 控制台不可用 */
      }
    }

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale', 'remote', 'remote.workspaceFiles'],
      apply,
    }
  },
})
