import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatchWindow, eventsInWindow, pickDeclinedInWindow, type WindowEvent } from '../../../src/core/agentpool/window.js';

const event = (id: string, at: string, kind: string, subject: string, payload: Record<string, unknown> = {}): WindowEvent => ({
  id,
  at,
  actor: 'lead',
  kind,
  subject,
  payload,
});

test('A1: dispatch window runs from lease.issued to lease.expired/revoked or card close', () => {
  const events = [
    event('lease-1', '2026-11-17T10:00:00Z', 'lease.issued', 'CARD-1', { card: 'CARD-1', lease_id: 'lease-1' }),
    event('decline-1', '2026-11-17T10:00:01Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-1' }),
    event('lease-done', '2026-11-17T10:00:02Z', 'lease.expired', 'lease-1', { lease_id: 'lease-1' }),
    event('decline-after', '2026-11-17T10:00:03Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-1' }),
  ];
  const result = dispatchWindow(events, 'lease-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.card, 'CARD-1');
  assert.equal(result.window.until, '2026-11-17T10:00:02Z');
  assert.equal(eventsInWindow(events, result.window).length, 2);
  assert.equal(pickDeclinedInWindow(events, result.window), 1);
});

test('A1: card done/dropped closes the window when lease stays open', () => {
  const events = [
    event('lease-1', '2026-11-17T10:00:00Z', 'lease.issued', 'CARD-1', { card: 'CARD-1' }),
    event('decline-1', '2026-11-17T10:00:01Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-1' }),
    event('task-done', '2026-11-17T10:00:05Z', 'task.done', 'CARD-1'),
    event('decline-later', '2026-11-17T10:00:06Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-1' }),
  ];
  const result = dispatchWindow(events, 'lease-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.until, '2026-11-17T10:00:05Z');
  assert.equal(pickDeclinedInWindow(events, result.window), 1);
});

test('A1: missing lease.issued is a structured failure and default right-edge is open-ended', () => {
  assert.equal(dispatchWindow([], 'lease-x').ok, false);
  const events = [event('lease-1', '2026-11-17T10:00:00Z', 'lease.issued', 'CARD-1', { card: 'CARD-1' })];
  const result = dispatchWindow(events, 'lease-1');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.window.until, undefined);
});

test('P3: pick_declined events from another dispatch do not count in this window', () => {
  const events = [
    event('lease-1', '2026-11-17T10:00:00Z', 'lease.issued', 'CARD-1', { card: 'CARD-1' }),
    event('decline-1', '2026-11-17T10:00:01Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-1' }),
    event('decline-other', '2026-11-17T10:00:02Z', 'agent.pick_declined', 'CARD-1', { dispatch_id: 'lease-2' }),
  ];
  const result = dispatchWindow(events, 'lease-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(pickDeclinedInWindow(events, result.window), 1);
});

test('A1: window ordering respects timestamp offsets (Date.parse, not string order)', () => {
  const events = [
    event('lease-1', '2026-11-17T10:00:00Z', 'lease.issued', 'CARD-1', { card: 'CARD-1' }),
    event('close', '2026-11-17T05:30:00-05:00', 'lease.expired', 'lease-1', { lease_id: 'lease-1' }),
  ];
  const result = dispatchWindow(events, 'lease-1');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.window.until, '2026-11-17T05:30:00-05:00');
});
