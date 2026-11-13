/**
 * 控制台三页的渲染层（M0-5，C2/C4）。
 *
 * 纯函数：模型进、HTML 出。模板里**不出现任何业务数字**——所有值来自
 * `PageModel.figures` / `PageModel.tables`，它们又全部由 `src/ui/pages.ts` 从
 * `query(view,args)` 取得。渲染层不做聚合、排序或格式化计算（docs/05 §15「界面零本地计算」）。
 */

import type { Figure, PageModel, PageMiss, TableModel } from './pages.js';

/** 手写转义（不依赖任何模板引擎；也避免在渲染层引入字符串替换链）。 */
export function escapeHtml(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function display(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function renderFigure(figure: Figure): string {
  const unit = figure.unit === undefined ? '' : ` <span class="unit">${escapeHtml(figure.unit)}</span>`;
  return [
    `<div class="figure" data-figure="${escapeHtml(figure.id)}" data-source="${escapeHtml(figure.source.view)}">`,
    `<div class="figure-value">${escapeHtml(display(figure.value))}${unit}</div>`,
    `<div class="figure-label">${escapeHtml(figure.label)}</div>`,
    `<div class="figure-source">来源 query(${escapeHtml(figure.source.view)})</div>`,
    '</div>',
  ].join('');
}

function renderTable(table: TableModel): string {
  const head = table.columns
    .map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`)
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${table.columns
          .map((column) => `<td>${escapeHtml(display(row[column.name]))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const truncation = table.truncated
    ? '<p class="warn">结果已截断：这是 query 返回的前若干行，续查要带 next_cursor（M0 控制台不提供续查按钮）。</p>'
    : '';
  const empty = table.rows.length === 0 ? '<p class="empty">没有数据。</p>' : '';
  return [
    `<section class="table-source" data-view="${escapeHtml(table.source.view)}">`,
    `<h2>${escapeHtml(table.title ?? table.source.view)}</h2>`,
    truncation,
    empty,
    table.rows.length === 0
      ? ''
      : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    '</section>',
  ].join('');
}

/** miss 文案按 reason 分叉（docs/05 §13：无权限/视图缺失要显式说清楚，不静默隐藏）。 */
function missText(miss: PageMiss): string {
  switch (miss.reason) {
    case 'view_not_found':
      return `这个视图还不在：${miss.view}`;
    case 'column_not_found':
      return `视图「${miss.view}」缺列`;
    case 'filtered_by_permission':
      return `权限不足：看「${miss.view}」需要更高权限（当前不是 decider/signer）`;
    case 'stale_as_of':
      return 'as_of 已过期：库里有新事件，请重新加载页面';
    case 'unsafe_view_sql':
      return `视图 SQL 未通过只读校验：${miss.view}`;
    case 'result_too_large':
      return `「${miss.view}」的单行结果超出 8KB 预算`;
    case 'invalid_args':
      return `读取「${miss.view}」的参数不合法`;
    default:
      return `读取「${miss.view}」失败：${miss.reason}`;
  }
}

function renderMiss(miss: PageMiss): string {
  const hint = miss.hint === undefined ? '' : `（${escapeHtml(miss.hint)}）`;
  return `<p class="miss" data-miss-view="${escapeHtml(miss.view)}" data-miss-reason="${escapeHtml(
    miss.reason,
  )}">${escapeHtml(missText(miss))}${hint}</p>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; line-height: 1.5; }
nav a { margin-right: 1rem; }
nav a[aria-current="page"] { font-weight: 700; text-decoration: none; }
.figures { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
.figure { border: 1px solid currentColor; border-radius: 0.5rem; padding: 0.75rem 1rem; min-width: 9rem; }
.figure-value { font-size: 1.75rem; font-variant-numeric: tabular-nums; }
.figure-label { font-weight: 600; }
.figure-source, .source-note { font-size: 0.8rem; opacity: 0.75; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid currentColor; }
.warn { color: #b45309; }
.miss { color: #b91c1c; font-weight: 600; }
.empty { opacity: 0.7; }
footer { margin-top: 2rem; font-size: 0.8rem; opacity: 0.7; }
`.trim();

function nav(current: PageModel['id']): string {
  const links: Array<[PageModel['id'], string, string]> = [
    ['overview', '/', '总览'],
    ['board', '/board', 'Board'],
    ['plan', '/plan', 'Plan'],
  ];
  return `<nav>${links
    .map(([id, href, label]) => {
      const marker = id === current ? ' aria-current="page"' : '';
      return `<a href="${href}"${marker}>${escapeHtml(label)}</a>`;
    })
    .join('')}</nav>`;
}

function renderPageBody(model: PageModel): string {
  const misses = model.misses.map(renderMiss).join('');
  const figures = model.figures.map(renderFigure).join('');
  const tables = model.tables.map(renderTable).join('');
  const asOf = model.as_of.map((id) => escapeHtml(id)).join(', ');
  return [
    nav(model.id),
    `<h1>${escapeHtml(model.heading)}</h1>`,
    '<p class="source-note">每个数字都可用 sdo_query 按标注的视图复算；M0 只做看图（不做审批），刷新才更新。</p>',
    misses,
    `<section class="figures" data-page="${escapeHtml(model.id)}">${figures}</section>`,
    tables,
    `<footer>as_of: [${asOf}] · 数据来自 view_catalog 中的视图</footer>`,
  ].join('\n');
}

function document(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · SDO 控制台</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

/** 渲染一页控制台（纯函数；同一模型两次渲染逐字节相同）。 */
export function renderPage(model: PageModel): string {
  return document(model.title, renderPageBody(model));
}

/** 404 页（C1 的负例：未知路径不能渲染成空白 200）。 */
export function renderNotFound(path: string): string {
  return document(
    '404',
    `${nav('overview')}<h1>没有这个页面</h1><p class="miss">GET ${escapeHtml(path)} 不在控制台三页里（/、/board、/plan）。</p>`,
  );
}

/** 500 页：显式红条，不把半成品当正常页（docs/05 §13）。 */
export function renderError(message: string): string {
  return document(
    '500',
    `${nav('overview')}<h1>渲染失败</h1><p class="miss">${escapeHtml(message)}</p>`,
  );
}
