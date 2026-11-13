import assert from 'node:assert/strict';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { chain, fourDomainSeeds, withWriteDb } from './append-helpers.js';

test('P1-1: failure after BEGIN always rolls back and the connection stays usable', () => {
  withWriteDb((db) => {
    const events = fourDomainSeeds();

    // readChain 在 BEGIN 之后抛错：把 event 表改名，SELECT ... FROM event 会 no such table。
    db.exec('ALTER TABLE event RENAME TO event_backup');
    const first = append(db, chain(events));
    assert.equal(first.ok, false);
    assert.equal(first.rolled_back, true, 'the transaction was really rolled back');
    assert.equal(db.inTransaction, false, 'failed append must not leave the connection in a transaction');
    db.exec('ALTER TABLE event_backup RENAME TO event');

    const second = append(db, chain(events));
    assert.equal(second.ok, true, 'a legal append must work right after the failed one');
    assert.equal(second.written, events.length);
  });
});

test('P1-1: validation and materialize failures also leave no open transaction', () => {
  withWriteDb((db) => {
    const events = chain(fourDomainSeeds());
    const broken = events.map((event, index) => (index === 2 ? { ...event, prev: 'sha256:nope' } : event));
    const result = append(db, broken);
    assert.equal(result.ok, false);
    assert.equal(db.inTransaction, false);
    assert.equal(append(db, events).ok, true);
  });
});
