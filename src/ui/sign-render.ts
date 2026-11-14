/**
 * M2-6 签字页的纯渲染（C1/C5/C6/C8；无业务判断，所有安全校验在 src/sign/page.ts）。
 *
 * 页面必须让人在点确认前看到四元组：命题 / 证据 / 差异 / 后果；baseline 还要看到
 * will_change 与 guarantee_delta。没有“全部同意”，一次只提交一条待签项。
 */
import { escapeHtml } from './render.js';
import type { FailureGuidance, PublicPendingItem, SigningCostEntry, SigningPageStatus } from '../sign/page.js';

export interface SigningPageModel {
  readonly status: SigningPageStatus;
  readonly pending: readonly PublicPendingItem[];
  readonly guidance: Readonly<Record<string, FailureGuidance>>;
  readonly costs: readonly SigningCostEntry[];
  /** 上一次操作的失败码（页面顶部红条）。 */
  readonly failure?: string;
  readonly failureMessage?: string;
  readonly notice?: string;
}

const STYLE = `
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c1f24}
main{max-width:880px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:24px 0 8px}
.meta{color:#5a6270;font-size:13px}
.card{background:#fff;border:1px solid #dde1e8;border-radius:10px;padding:14px;margin:12px 0}
.warn{background:#fff4e5;border-color:#f0b562}
.fail{background:#fdecec;border-color:#e05a5a}
.ok{background:#eaf7ee;border-color:#5cae7a}
dl{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;margin:0}
dt{color:#5a6270}
dd{margin:0;white-space:pre-wrap;word-break:break-word}
form{display:inline-block;margin:10px 8px 0 0}
input[type=password],input[type=text]{padding:6px 8px;border:1px solid #c7cdd6;border-radius:6px}
button{padding:7px 14px;border:1px solid #2f6feb;background:#2f6feb;color:#fff;border-radius:6px;cursor:pointer}
button.secondary{background:#fff;color:#2f6feb}
code{font-size:12px;background:#f0f2f5;padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid #e3e7ee;padding:6px 8px;text-align:left}
ul{margin:4px 0;padding-left:18px}
`;

function renderGuaranteeDelta(delta: Readonly<Record<string, string>> | null): string {
  if (delta === null) return '<span class="meta">（不适用）</span>';
  const parts = Object.keys(delta)
    .sort()
    .map((key) => `保证 ${escapeHtml(key)}：${escapeHtml(delta[key] ?? '')}`);
  return `<ul>${parts.map((part) => `<li>${part}</li>`).join('')}</ul>`;
}

function renderPending(item: PublicPendingItem): string {
  const stale = item.stale
    ? '<p class="warn">尺子变了（frontier 已推进）：这一项已过期，请重新解锁并重新预览。</p>'
    : '';
  const evidence = item.evidence.map((ref) => `<li><code>${escapeHtml(ref)}</code></li>`).join('');
  const willChange =
    item.will_change.length === 0
      ? '<span class="meta">（无）</span>'
      : `<ul>${item.will_change.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  return `
<section class="card" data-request-id="${escapeHtml(item.id)}">
  <h2>待签：${escapeHtml(item.decision_kind)}</h2>
  ${stale}
  <dl>
    <dt>命题（渲染器）</dt><dd data-proposition>${escapeHtml(item.proposition)}</dd>
    <dt>证据</dt><dd><ul>${evidence}</ul></dd>
    <dt>差异</dt><dd>${escapeHtml(item.difference)}</dd>
    <dt>后果</dt><dd>${escapeHtml(item.consequence)}</dd>
    <dt>这一签会改什么</dt><dd>${willChange}</dd>
    <dt>保证变化</dt><dd>${renderGuaranteeDelta(item.guarantee_delta)}</dd>
    <dt>payload_hash</dt><dd><code>${escapeHtml(item.payload_hash)}</code></dd>
  </dl>
  <form method="post" action="/sign/confirm">
    <input type="hidden" name="request_id" value="${escapeHtml(item.id)}">
    <input type="hidden" name="proposition" value="${escapeHtml(item.proposition)}">
    <input type="hidden" name="payload_hash" value="${escapeHtml(item.payload_hash)}">
    <button type="submit">确认并签字</button>
  </form>
</section>`;
}

function renderCosts(costs: readonly SigningCostEntry[]): string {
  if (costs.length === 0) return '<p class="meta">还没有签发记录。</p>';
  const rows = costs
    .map(
      (cost) => `<tr>
<td><code>${escapeHtml(cost.decision_id)}</code></td>
<td>${escapeHtml(cost.signer)}</td>
<td>${String(cost.signerd_unlock_wait_ms)}</td>
<td>${String(cost.signerd_since_last_unlock_ms)}</td>
<td>${String(cost.sign_ms)}</td>
<td>${String(cost.page_unlock_wait_ms)}</td>
<td>${String(cost.page_total_ms)}</td>
<td>${String(cost.interactions)}</td>
<td>${cost.window_reused ? '复用窗口' : '本次解锁'}</td>
</tr>`,
    )
    .join('');
  return `<table data-costs><thead><tr><th>decision</th><th>签字人</th><th>signerd unlock_wait_ms</th><th>signerd since_last_unlock_ms</th><th>sign_ms</th><th>页面 unlock_wait_ms</th><th>page_total_ms</th><th>交互次数</th><th>窗口</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderSigningPage(model: SigningPageModel): string {
  const status = model.status;
  const failure =
    model.failure === undefined
      ? ''
      : `<p class="card fail" data-failure-reason="${escapeHtml(model.failure)}">${escapeHtml(
          model.guidance[model.failure]?.title ?? '签发失败',
        )}：${escapeHtml(model.failureMessage ?? '')}<br>下一步：${escapeHtml(
          model.guidance[model.failure]?.next ?? '刷新页面后重试',
        )}</p>`;
  const notice = model.notice === undefined ? '' : `<p class="card ok">${escapeHtml(model.notice)}</p>`;
  const awaiting =
    status.awaiting_unlock
      ? '<p class="card warn" data-awaiting-unlock>签名器需要解锁（或 frontier 变了要重新解锁）才能继续签字。</p>'
      : '';
  const needsWindow = status.needs_window
    ? '<p class="card warn" data-needs-window>TTL=0 的一次解锁只能签一条。要多条一起签，请开免密窗口（TTL&gt;0）后重新解锁；本页不会自动开窗。</p>'
    : '';
  const pending =
    model.pending.length === 0
      ? '<p class="meta">没有待签项。签字页只列已生成的 preview；待签不落库。</p>'
      : model.pending.map(renderPending).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>签字 · SDO</title><style>${STYLE}</style></head>
<body><main data-page="sign">
<h1>签字页</h1>
<p class="meta">frontier: <code data-frontier>${escapeHtml(status.frontier)}</code> ·
签名器：${status.locked ? '锁定' : '已解锁'}${status.window_until === null ? '' : `（窗口至 ${escapeHtml(status.window_until)}）`} ·
待签 ${String(status.pending_count)} 条 · 过期 ${String(status.stale_count)} 条</p>
${failure}${notice}${awaiting}${needsWindow}
<h2>解锁签名器</h2>
<form method="post" action="/sign/unlock" data-form="unlock">
  <input type="text" name="actor" placeholder="签字人" required>
  <input type="password" name="passphrase" placeholder="签章口令" required>
  <button type="submit">解锁</button>
</form>
<h2>待签项</h2>
${pending}
<h2>签字成本（本次会话）</h2>
${renderCosts(model.costs)}
<p class="meta">成本口径：signerd 回执的 unlock_wait_ms / sign_ms 为读数依据；页面 unlock_wait_ms 在复用窗口时为 0；page_total_ms 含人思考时间，仅展示。
窗口语义（D-060）：TTL=0 一次解锁授权一次签发；TTL&gt;0 窗口内可连签，frontier 一变立即要求重新解锁。</p>
</main></body></html>`;
}

/** 失败页（服务端没有可用模型时）；也用于 404。 */
export function renderSigningFailurePage(title: string, next: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>签字 · SDO</title>
<style>${STYLE}</style></head><body><main data-page="sign"><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(next)}</p></main></body></html>`;
}
