#!/usr/bin/env node
/**
 * M0-G · 里程碑门四条判死读数（卡 plan/cards/M0-G.md）。
 *
 * 一条命令：`npm run readings`（先生成 lib/，再跑本脚本）。
 * 产物：`plan/milestone/M0-读数.json`、`plan/milestone/M0-读数.md`。
 * 退出码：任一读数 fail ⇒ 非 0；partial 不算 fail，但 stdout 会打 overall。
 * 纪律：全部在临时目录的新库上跑（A3），不碰 `~/.local/state/sdo/`，不写 `src/**`。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openSdoDatabase } from '../lib/src/db/open.js';
import { query } from '../lib/src/query/index.js';
import { insertEvents, insertFoldRows, makeChain, PASSPHRASE, withTempDb } from './readings/fixtures.mjs';
import { measureR1, measureR2, measureR3, M0_VIEW_COUNT } from './readings/measure.mjs';
import { measureR4 } from './readings/r4.mjs';
import { exitCodeFor, overallFor } from './readings/verdicts.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SCRIPT));
const OUT_DIR = join(ROOT, 'plan', 'milestone');

function runChild() {
  const db = openSdoDatabase(process.env['SDO_R2_DB'], process.env['SDO_R2_PASSPHRASE'] ?? PASSPHRASE);
  try {
    const view = process.env['SDO_R2_VIEW'] ?? 'overview';
    const right = process.env['SDO_R2_RIGHT'];
    const result = right ? query(db, { view }, { right }) : query(db, { view });
    process.stdout.write(JSON.stringify(result));
  } finally {
    db.close();
  }
}

function seed(db) {
  const events = makeChain();
  insertEvents(db, events);
  insertFoldRows(db, events);
}

function runMain() {
  const results = {};
  results['R1'] = withTempDb(({ db }) => measureR1(db));
  results['R2'] = withTempDb(({ db, dbPath }) => {
    seed(db);
    return measureR2(db, dbPath, SCRIPT);
  });
  results['R3'] = withTempDb(({ db, dbPath }) => {
    seed(db);
    return measureR3(db, dbPath);
  });
  results['R4'] = measureR4();

  const r1 = results['R1'].measured;
  const r2 = results['R2'].measured;
  const r3 = results['R3'].measured;
  const r4 = results['R4'].measured;

  const report = {
    card: 'M0-G',
    generatedAt: new Date().toISOString(),
    command: 'npm run readings',
    node: process.version,
    metric: 'R1 = 查询在字节码里打开 event 表游标的次数（结构口径，不是运行期行访问数）',
    readings: {
      R1: { title: `一次 status 查询中 event 表游标打开次数 ≤ 1（overview 表开 ${r1.overview.eventTableOpens} / 索引开 ${r1.overview.eventIndexOpens}）`, verdict: results['R1'].verdict, measured: r1 },
      R2: { title: '同一 as_of 两次查询逐字节相同（同进程 + 两个独立进程）', verdict: results['R2'].verdict, measured: r2 },
      R3: { title: '读只留探针线索；写/篡改由 verify 发现；都不承诺归因', verdict: results['R3'].verdict, measured: r3 },
      R4: { title: 'gaps 能看到 query_miss 的聚合（生产写入路径不在 M0）', verdict: results['R4'].verdict, measured: r4 },
    },
  };

  const verdicts = Object.fromEntries(Object.entries(report.readings).map(([key, value]) => [key, value.verdict]));
  const overall = overallFor(verdicts);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'M0-读数.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const lines = [
    '# M0 读数报告（M0-G）',
    '',
    `- 生成：\`npm run readings\`（${report.generatedAt}）`,
    `- Node：${report.node}`,
    `- 视图快照：M0 时点 \`view_catalog\` 共 ${r1.viewCount} 个视图（常量 \`M0_VIEW_COUNT=${M0_VIEW_COUNT}\`，加视图须手动更新）`,
    '- 纪律：全部在临时目录的新库上跑；不碰 `~/.local/state/sdo/`；不写 `src/**`。',
    '- 归因边界：本报告只记录“发现什么”，**不包含**任何“谁改的”结论。',
    '- R1 口径：**打开次数（结构）**。`eventTableOpens` = `EXPLAIN` 里 `OpenRead/OpenWrite` 且 `p2 = event` 表 rootpage；`eventIndexOpens` = `p2` 属于 event 索引 rootpage。两者**不相加**（同一访问点的索引段与表段会重复计），也不是运行期扫描次数。',
    '',
    '| 读数 | verdict | 摘要 |',
    '|---|---|---|',
    `| R1 event 游标打开次数 | ${verdicts['R1']} | overview：表开 ${r1.overview.eventTableOpens} / 索引开 ${r1.overview.eventIndexOpens}；红证单表表开 ${r1.redProof.single.eventTableOpens}/UNION 表开 ${r1.redProof.union.eventTableOpens}；gaps 变异表开 ${r1.mutation?.before?.eventTableOpens}→${r1.mutation?.after?.eventTableOpens} |`,
    `| R2 as_of 逐字节相同 | ${verdicts['R2']} | 13 视图 in-process 相等=${r2.allEqual}，每视图两个独立进程互比；结果均非 miss、view 名匹配 |`,
    `| R3 探针/verify | ${verdicts['R3']} | access.log=${r3.accessLines} 行；投影=${r3.projection?.code ?? 'n/a'}；hash=${r3.hash?.code ?? 'n/a'} |`,
    `| R4 gaps 聚合 query_miss | ${verdicts['R4']} | verify.ok=${r4.verify.ok}、events=${r4.verify.eventCount}；聚合 ${r4.rows.length} 组、${r4.totalMisses} 条；生产写入路径缺（D-012） |`,
    '',
    '## R1 · event 表游标打开次数（结构口径）',
    '',
    '- 命令：`npm run readings`（取 `event` 表与索引 rootpage；对 `view_catalog` 的 13 条视图逐条 `EXPLAIN SELECT * FROM (<view.sql>)`，分别数表/索引游标打开行）。',
    `- 原始输出（perView：eventTableOpens / eventIndexOpens，两数不相加）：\n\n\`\`\`json\n${JSON.stringify(r1.perView, null, 2)}\n\`\`\``,
    `- 红证（证明计数器随结构倍数变化，不是常量）：单表 SQL ⇒ \`{table:${r1.redProof.single.eventTableOpens}, index:${r1.redProof.single.eventIndexOpens}}\`；同一查询 \`UNION ALL\` 两次 ⇒ \`{table:${r1.redProof.union.eventTableOpens}, index:${r1.redProof.union.eventIndexOpens}}\`；覆盖索引 \`SELECT max(at) FROM event\` ⇒ \`{table:${r1.redProof.coveringIndex.eventTableOpens}, index:${r1.redProof.coveringIndex.eventIndexOpens}}\`（表游标 0，证明索引口径也数得出来）。`,
    `  \`\`\`sql\n${r1.redProof.singleSql}\n-- 对照：\n${r1.redProof.unionSql}\n  \`\`\``,
    `- 变异演示（卡 C1 正例 2）：把 \`gaps\` 的 SQL 结构复制成 UNION ALL 两份 ⇒ 表开从 **${r1.mutation?.before?.eventTableOpens}** 变 **${r1.mutation?.after?.eventTableOpens}**。`,
    `  \`\`\`sql\n${r1.mutation?.sql ?? '(no gaps view)'}\n  \`\`\``,
    `- 观察项：\`pm_queue\` 有 **4 个事件访问点**：baseline \`e\`（索引+表）、内层 \`MAX(x.at)\`（**唯一的覆盖索引、无表游标**）、change.applied \`e\`（索引+表）、lease（索引+表）；因此 \`eventTableOpens=3\`、\`eventIndexOpens=4\`（同一访问点的索引段与表段各计一次，**不要相加**）。\`board\` 为 1/1、\`agents\` 为 1/0、\`gaps\`/\`pm_gaps\` 为 1/1。R1 只约束 status 查询 \`overview\` 的 \`{0,0}\`；\`pm_queue\` 是每查询的常量倍数访问，M1 若把它变成热路径要复核（台账 D-022）。`,
    '- **度量口径与边界**：本读数数的是“结构上打开几次 event 游标”，与别名/CTE 名无关；相关子查询这类“结构 1 次打开、运行期每行访问”的形态**数不出来**，本读数不声称覆盖运行期行访问数（M1 接真实读数时补，台账 D-023）。',
    `- verdict：**${verdicts['R1']}**（overview=0 ⇒ 上界“1 次”成立）。`,
    '',
    '## R2 · 同一 as_of 逐字节相同',
    '',
    '- 命令：`npm run readings`（13 视图全量：每视图同进程连查两次比较 `JSON.stringify`；再起**两个独立 node 进程**各查一次，两个子进程 stdout 互比、并与父进程结果逐字节比较）。',
    `- 原始输出：\`\`\`json\n${JSON.stringify(r2, null, 2)}\n\`\`\``,
    `- verdict：**${verdicts['R2']}**。`,
    '',
    '## R3 · 读留探针、写由 verify 发现',
    '',
    '- 命令：`npm run readings`（3 次 `query()` ⇒ 读 `access.log`；裸连接改 `task.title` ⇒ `verify`；另建坏 hash 链 ⇒ `verify`）。',
    `- 原始输出：\`\`\`json\n${JSON.stringify(r3, null, 2)}\n\`\`\``,
    `- verdict：**${verdicts['R3']}**。`,
    '',
    '## R4 · gaps 聚合 query_miss',
    '',
    '- 命令：`npm run readings`（合法 hash 链夹具写入 `query_miss` 事件，先跑 `verify` 自证夹具合法，再 `query(db, {view:\'gaps\'}, {right:\'reviewer\'})`）。',
    `- 原始输出：\`\`\`json\n${JSON.stringify(r4, null, 2)}\n\`\`\``,
    `- verdict：**${verdicts['R4']}**（部分达标：视图侧聚合已通；生产写入路径属 M1/D-012）。`,
    '',
    '## 附：本报告不承诺的事',
    '',
    '- 不承诺归因：R3 只说明“有线索/能发现”，不知道是谁。',
    '- R2 的“逐字节相同”只对本次夹具库与当前视图 SQL 成立；`as_of` 是输入一致性令牌，不是历史快照读。',
    '- R1 是结构口径，不覆盖运行期行访问数（相关子查询、LIKE 扫描等）。',
  ];

  writeFileSync(join(OUT_DIR, 'M0-读数.md'), `${lines.join('\n')}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({ overall, verdicts, out: OUT_DIR }, null, 2)}\n`);
  process.exitCode = exitCodeFor(verdicts);
}

if (process.argv[2] === '--r2-child') {
  runChild();
} else {
  runMain();
}
