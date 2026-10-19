const test = require('node:test'); const assert = require('node:assert/strict');
const P = require('../src/proctoring');

const live = (extra = {}) => ({ status: 'in_progress', warnings: 0, deadline_at: 10_000_000 + 30 * 60000, ...extra });

test('strict mode blocks on the first exit', () => {
  assert.deepEqual(P.pxViolation(live(), 'strict'), { action: 'block', warnings: 1 });
});
test('warn mode warns twice and blocks on the third exit', () => {
  assert.equal(P.pxViolation(live({ warnings: 0 }), 'warn').action, 'warn');
  assert.equal(P.pxViolation(live({ warnings: 1 }), 'warn').action, 'warn');
  assert.equal(P.pxViolation(live({ warnings: 2 }), 'warn').action, 'block');
});
test('off mode only logs; unknown mode never silently blocks', () => {
  assert.equal(P.pxViolation(live(), 'off').action, 'log');
  assert.equal(P.pxViolation(live(), 'nonsense').action, 'log');
});
test('events on an attempt that is not running are ignored', () => {
  for (const status of ['blocked', 'submitted', 'idle', 'ready']) assert.equal(P.pxViolation({ status, warnings: 0 }, 'strict').action, 'ignore', status);
  assert.equal(P.pxViolation(null, 'strict').action, 'ignore');
});
test('blocking freezes the remaining time', () => {
  const now = 10_000_000 + 10 * 60000;                                  // 20 minutes left
  const b = P.pxBlock(live(), now);
  assert.equal(b.status, 'blocked'); assert.equal(b.remaining_ms, 20 * 60000);
  assert.equal(P.pxRemaining({ ...live(), ...b }, now + 99 * 60000), 20 * 60000);   // clock does not run while blocked
});
test('a blocked attempt cannot save or submit', () => {
  assert.deepEqual(P.pxCanWrite({ ...live(), status: 'blocked' }, 10_000_000), { ok: false, reason: 'blocked' });
});
test('writes are refused after the deadline plus grace, allowed within grace', () => {
  const d = 10_000_000 + 30 * 60000;
  assert.ok(P.pxCanWrite(live(), d + 4000).ok);
  assert.equal(P.pxCanWrite(live(), d + 6000).reason, 'time_expired');
  assert.equal(P.pxCanWrite({ status: 'submitted' }, d).reason, 'already_submitted');
  assert.equal(P.pxCanWrite({ status: 'idle' }, d).reason, 'not_started');
  assert.equal(P.pxCanWrite(null, d).reason, 'no_attempt');
});
test('reinstating needs a reason and a blocked attempt, then resuming restores the saved time', () => {
  const now = 20_000_000;
  const blocked = { status: 'blocked', remaining_ms: 12 * 60000, warnings: 1, reinstated_count: 0 };
  assert.throws(() => P.pxReinstate(blocked, now, ''));
  assert.throws(() => P.pxReinstate(live(), now, 'Power cut during the test'));
  const r = P.pxReinstate(blocked, now, 'Power cut during the test');
  assert.equal(r.status, 'ready'); assert.equal(r.warnings, 0); assert.equal(r.reinstated_count, 1);
  const res = P.pxResume({ ...blocked, ...r }, now + 3600_000);
  assert.equal(res.status, 'in_progress'); assert.equal(res.deadline_at, now + 3600_000 + 12 * 60000);
  assert.throws(() => P.pxResume({ status: 'submitted' }, now));
});
