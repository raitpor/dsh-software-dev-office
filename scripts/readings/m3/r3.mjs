/**
 * M3-G R3 · 撤销权限后待审项消失且显示“申请入口”。
 *
 * 真路径：dbRightsPort + readReviewQueueAccess + loadOverviewPage + renderPage。
 * 撤权表示：`scope.revoked_at`（M3 无 right.revoked 事件入口，台账 D-113 记边界）。
 */
import { chainHead } from '../../../lib/src/db/write.js';
import { buildEvent } from '../../../lib/src/db/freeze-store.js';
import { raiseAttention } from '../../../lib/src/core/pm/act.js';
import { dbRightsPort, readReviewQueueAccess } from '../../../lib/src/core/pm/access.js';
import { loadOverviewPage } from '../../../lib/src/ui/pages.js';
import { renderPage } from '../../../lib/src/ui/render.js';
import { appendAs, seedRights } from '../../../lib/test/db/append-auth.js';
import { AT, count, m3Session, withM3Db } from './helpers.mjs';

const TASK = 'T-M3G-R3';
const ACTOR = 'reviewee';

function appendEvents(db, events) {
  const result = appendAs(db, events);
  if (!result.ok) throw new Error(`r3 append failed: ${result.reason_code}: ${result.message ?? ''}`);
}

export async function measureR3() {
  return await withM3Db(async ({ db }) => {
    seedRights(db, [
      { actor: ACTOR, scope: 'domain:core', right: 'read' },
      { actor: ACTOR, scope: 'domain:core', right: 'decide' },
      { actor: ACTOR, scope: 'domain:pm', right: 'read' },
      { actor: ACTOR, scope: 'release:R-3', right: 'read' },
      { actor: ACTOR, scope: 'release:R-3', right: 'decide' },
    ]);
    appendEvents(db, [
      buildEvent(
        {
          id: 'ev-m3g-r3-task',
          at: AT,
          actor: 'alice',
          kind: 'task.created',
          subject: TASK,
          payload: {
            seq: 1,
            title: 'M3-G R3 待审卡',
            kind: 'implement',
            status: 'in_progress',
            scope_paths: ['src/readings/**'],
            inputs: ['release:R-3'],
          },
          caused_by: [],
          request_id: 'm3g-r3-task',
        },
        chainHead(db),
      ),
    ]);
    const raised = raiseAttention(db, { actor: 'fixture-root', actorKind: 'human' }, {
      taskId: TASK,
      question: 'M3-G R3：这条待审项该不该由你决定？',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00.000Z',
      at: AT,
    });
    if (raised.ok !== true) throw new Error(`raiseAttention failed: ${JSON.stringify(raised)}`);

    const session = m3Session(ACTOR);
    const before = readReviewQueueAccess(db, dbRightsPort(db, ACTOR), session);
    const pageBefore = renderPage(loadOverviewPage(db, 'decider', { actor: ACTOR, rights: dbRightsPort(db, ACTOR), session }));

    db.prepare(
      "UPDATE scope SET revoked_at = ? WHERE actor = ? AND scope = 'release:R-3' AND right = 'decide' AND revoked_at IS NULL",
    ).run(AT, ACTOR);

    const after = readReviewQueueAccess(db, dbRightsPort(db, ACTOR), session);
    const pageAfter = renderPage(loadOverviewPage(db, 'decider', { actor: ACTOR, rights: dbRightsPort(db, ACTOR), session }));

    const measured = {
      attention_id: raised.attention_id,
      task_id: TASK,
      before: {
        rows: before.rows.length,
        hidden: before.hidden.length,
        apply_entries: before.apply_entries.length,
        apply_scopes: before.apply_entries.map((entry) => entry.scope).sort(),
        page_has_apply: pageBefore.includes('你需要申请权限'),
        page_has_to_decide: pageBefore.includes('要我决定'),
        filtered: before.filtered,
      },
      after: {
        rows: after.rows.length,
        hidden: after.hidden.length,
        apply_entries: after.apply_entries.length,
        apply_scopes: after.apply_entries.map((entry) => entry.scope).sort(),
        page_has_apply: pageAfter.includes('你需要申请权限'),
        page_has_to_decide: pageAfter.includes('要我决定'),
        page_hidden_hint: /[^<>]*待审项不在你的域内[^<>]*/.exec(pageAfter)?.[0]?.trim() ?? null,
        hidden_count_leak: /\d+ 条待审项/.test(pageAfter),
        filtered: after.filtered,
        miss: after.miss ?? null,
      },
      revoked_scope_rows: count(
        db,
        "SELECT COUNT(*) FROM scope WHERE actor = ? AND scope = 'release:R-3' AND right = 'decide' AND revoked_at IS NOT NULL",
        ACTOR,
      ),
      page_before_has_to_decide: pageBefore.includes('要我决定'),
      page_before_has_apply: pageBefore.includes('你需要申请权限'),
      page_after_has_to_decide: pageAfter.includes('要我决定'),
      page_after_has_apply: pageAfter.includes('你需要申请权限'),
    };
    // F2：pass 看“迁移”而不是状态——撤权前不应有申请入口（必须给 read@domain:pm，
    // 否则 pm 队列兜底入口会让撤权前页面就有“申请权限”）。
    const pass =
      measured.before.rows === 1 &&
      measured.before.filtered === false &&
      measured.before.apply_entries === 0 &&
      measured.before.page_has_apply === false &&
      measured.after.rows === 0 &&
      measured.after.filtered === true &&
      measured.after.apply_entries > 0 &&
      measured.revoked_scope_rows === 1 &&
      measured.after.apply_entries >= 1 &&
      measured.after.page_has_apply === true &&
      measured.after.apply_scopes.includes('release:R-3') &&
      measured.after.page_has_to_decide === false;
    return {
      id: 'R3',
      question: '撤销 decide@domain:release 后待审项是否消失、且页面显示申请入口（不是静默空页）',
      command: 'node scripts/m3-readings.mjs --only R3',
      measured,
      verdict: pass ? 'pass' : 'fail',
      caveat: 'M3 没有 right.revoked 事件入口：撤权直接写 scope.revoked_at（生产 dbRightsPort 会过滤 revoked 行），这是台账 D-113 记录的边界，不是模拟。页面用生产 loadOverviewPage/renderPage 渲染。撤权后页面会提示“待审项不在你的域内”；若带具体条数即隐藏计数泄露（S25），该缺陷由 M3-7 修，本读数用 page_hidden_hint/hidden_count_leak 如实记录本次 HTML 原文。C5 边界：本机 ~/.local/state/sdo 不存在时快照只到 {exists:false}，能抓“新建生产目录”但抓不到既有目录内容变化（且只比 size+mtime）；另外 `npm run readings:m3` 默认会写 plan/milestone/M3-读数.*，C5“不碰仓库”由测试用 --out 保证（D-111 同类坑），不是脚本默认行为。',
    };
  });
}
