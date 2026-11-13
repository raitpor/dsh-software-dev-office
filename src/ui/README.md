# src/ui/ · 控制台三页

M0-5。给人看的三个**独立只读页**：`/`（总览）、`/board`、`/plan`。页面上的每个数字都带来源
`{view, args}`，可以用 `sdo_query` 按同一视图复算；模板里不写死业务数字。

## 怎么起

```sh
npm run build
SDO_DB_PATH=/path/to/sdo.db \
SDO_DB_PASSPHRASE='<库口令>' \
npm run console
# 打开 http://127.0.0.1:4173/
```

- 只绑 `127.0.0.1`（本机只读页，不对外）；
- 库必须**已迁移**（`user_version ≥ 2` 且 `view_catalog` 可读）：M0 尚无 migrate CLI，
  控制台自己**不建表、不迁移、不写事件**；库没迁移时会直接退出并提示；
- 环境变量：`SDO_DB_PATH`（默认 `./sdo.db`）、`SDO_DB_PASSPHRASE`（必填，缺失即拒绝，
  无明文降级）、`SDO_CONSOLE_PORT`（默认 `4173`，`0` 由内核分配）、`SDO_CONSOLE_RIGHT`
  （默认 `decider`；M0 没有登录身份，权限由启动方固定，见卡「已知边界」）。

## 三页各回答什么

M0 里「宿主预览页」和这里的「独立控制台」是**同一套视图、两套入口**：预览在宿主里（M0 不依赖、
不要求插槽），控制台是独立只读页；两边数字都只来自 `query(view, args)`，没有第二个真源。

与 `docs/05` §9 的八页定位逐条对齐（M0 只做其中一部分）：

| 本页 | `docs/05` §9 定位 | M0 做到哪 | 数据来源（只允许目录里的视图） |
|---|---|---|---|
| `/` 总览 | 「总览」：首屏三问（我要做什么 / 改了影响什么 / 为什么） | **只做第 1 问的数字层**：阶段、健康度、卡数、红过、被卡卡数、要我决定（待审项）+ `pm_queue` 前 7 行；第 2/3 问要 intent/impact 视图，M1+；点数字下钻 M2 | `overview`、`review_queue`、`pm_queue` |
| `/board` | 「计划」页的**任务板面**：待办、谁在做什么、卡在哪 | 卡级状态/负责人/最近动作/最近报告/阻塞码（只读） | `board` |
| `/plan` | 「计划」页的**依赖链面**：依赖、写域、分解树 | 计划行 + 未满足依赖 + 写域；分解树折叠 M2 | `plan` |

§9 其余页面 M0 不做：**待审**（P10/M2）、**证据**、**缺陷**、**团队**、**审计**、**设置**。

两个容易混的东西，这里说清：

- **「要我决定」**（`to_decide`，来源 `review_queue` 行数）= 待审项，M0 只显示个数（decider 权限才可见；reader 显示“权限不足”）。
- **「PM 队列（只读）」**（来源 `pm_queue`，≤7 行）= PM 的下一步建议，**不是待审队列**，也不提供批准按钮；真正的待审交互在 M2。

每个读数在 HTML 里带 `data-figure`（读数 id）与 `data-source`（视图名）属性；表格区带
`data-view`。负数/截断等边界会显式提示，不把空态当正常。

## 文件

| 文件 | 职责 |
|---|---|
| `pages.ts` | 装载三页模型：每个数字是 `Figure {value, source:{view,args}, derive}`；表格行来自同一查询 |
| `render.ts` | 纯渲染（模型 → HTML）：模板只有占位符，不做计算/排序/聚合 |
| `server.ts` | `node:http` 只读服务：三条 GET 路由，未知路径 404、非 GET 405、异常 500 |
| `serve.ts` | `npm run console` 入口：读环境变量、开加密库、绑 `127.0.0.1` |

## 纪律（判据对应）

- **C2 数字可复算**：测试对每个 `Figure` 重放 `query(source.view, source.args)`，按 `derive`
  （`field` / `row_count`）比同一值；空库与有数据两次都跑。
- **C3 只读**：`src/ui/` 无写 SQL、无 `prepare/exec/pragma/transaction`、不调迁移；测试在
  请求前后比对 `event` / `task` 行数。
- **C4 不依赖宿主**：只用 `node:` 内置模块与仓库内相对 import；`test/ui/cli.test.ts` 用纯
  `node lib/src/ui/serve.js` 子进程起服务并 GET 三页。
- **C1 三页存在**：`GET /`、`/board`、`/plan` 均 200，含页面标题与至少一个读数；未知路径 404。

## 已知边界

- M0 只做看图：不做审批/签字（P10 在 M2）；「要我决定」只显示条数，「PM 队列」只显示 PM 建议，都不能点。
- 没有登录/身份：读取权限固定（默认 `decider`），不区分人/agent。
- 不承诺实时推送：刷新才更新；M2 再接事件流。
- 数据经 `sdo_query`：单次 ≤8KB、`row_budget` 截断；截断时页面明确提示，续查要
  `next_cursor`（控制台不提供续查按钮）。
- 总览第 2–3 问（改了影响什么 / 为什么）M0 不做，需要 intent/impact 视图与事件链钻取，M1+。
- plan 页的分解树折叠与拖动排序 M2；M0 只按 `seq` 平铺计划行。
- `docs/05` §9 要求界面跟随宿主 locale（`zh_CN` 缺省、`en_US` 二包）；M0 独立页无宿主
  locale，界面中文硬编码，i18n 留 M2。
- 数字来源只允许 `view_catalog` 里的视图（数量随目录变）；页面不直接读表。
