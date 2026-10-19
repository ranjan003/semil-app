const test = require('node:test'); const assert = require('node:assert/strict');
const { evaluate, validateConfig, markObjective, DEFAULT_CONFIG } = require('../src/scoring');

test('weighted overall matches the spec formula when all rounds are scored', () => {
  const r = evaluate({ 1: 80, 2: 70, 3: 60, 4: 75, 5: 70 });
  assert.equal(r.overall, 72);              // .2*80+.2*70+.15*60+.3*75+.15*70
  assert.equal(r.status, 'meets_criteria');
  assert.equal(r.provisional, false);
});
test('missing rounds are not zero and are not failures', () => {
  const r = evaluate({ 1: 80, 2: 70 });
  assert.equal(r.overall, 75);              // normalised over rounds 1-2 only
  assert.equal(r.status, 'incomplete');
  assert.equal(r.provisional, true);
  assert.deepEqual(r.missingRounds, [3, 4, 5]);
});
test('no scores means pending review, not failed', () => {
  const r = evaluate({});
  assert.equal(r.overall, null); assert.equal(r.status, 'pending_review');
});
test('one round below its threshold blocks the candidate even with a high overall', () => {
  const r = evaluate({ 1: 90, 2: 90, 3: 90, 4: 55, 5: 90 });
  assert.equal(r.overall, 79.5);
  assert.deepEqual(r.belowThreshold, [4]);
  assert.equal(r.status, 'below_criteria');
});
test('overall below target fails even when every threshold is met', () => {
  const r = evaluate({ 1: 55, 2: 55, 3: 55, 4: 61, 5: 55 });
  assert.equal(r.status, 'below_criteria'); assert.equal(r.meetsTarget, false);
});
test('invalid scores are ignored rather than counted', () => {
  const r = evaluate({ 1: 80, 2: 'abc', 3: -5, 4: 101, 5: null });
  assert.deepEqual(r.scoredRounds, [1]); assert.equal(r.overall, 80);
});
test('override needs a reason and changes the verdict but not the numbers', () => {
  assert.throws(() => evaluate({ 1: 40 }, DEFAULT_CONFIG, { decision: 'advance', reason: '' }));
  const r = evaluate({ 1: 40, 2: 40, 3: 40, 4: 40, 5: 40 }, DEFAULT_CONFIG, { decision: 'advance', reason: 'Strong portfolio reviewed by founder' });
  assert.equal(r.status, 'overridden'); assert.equal(r.overall, 40);
});
test('config validation rejects weights that do not total 100', () => {
  const bad = { ...DEFAULT_CONFIG, weights: { 1: 20, 2: 20, 3: 20, 4: 30, 5: 15 } };
  assert.ok(validateConfig(bad).length); assert.throws(() => evaluate({ 1: 50 }, bad));
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});
test('custom weights are honoured', () => {
  const cfg = { weights: { 1: 10, 2: 10, 3: 10, 4: 50, 5: 20 }, thresholds: DEFAULT_CONFIG.thresholds, target: 60 };
  assert.equal(evaluate({ 1: 60, 2: 60, 3: 60, 4: 100, 5: 60 }, cfg).overall, 80);
});
test('objective marking: mcq, multi-select all-or-nothing, written needs a reviewer', () => {
  assert.equal(markObjective({ kind: 'mcq', correct_answer: 1, marks: 2 }, 1), 2);
  assert.equal(markObjective({ kind: 'mcq', correct_answer: 1, marks: 2 }, 0), 0);
  const ms = { kind: 'multi_select', correct_answer: [0, 2], marks: 3 };
  assert.equal(markObjective(ms, [2, 0]), 3); assert.equal(markObjective(ms, [0]), 0); assert.equal(markObjective(ms, [0, 1, 2]), 0);
  assert.equal(markObjective({ kind: 'long_text', marks: 5 }, 'text'), null);
});
