'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Stream, newSeed, validateRules, availability, drawPaper } = require('../src/qb/random');
const { presentQuestion, normalizeResponse, markObjective, scoreAttempt, validateManualMarks } = require('../src/qb/marking');

let n = 0;
const q = (topic, difficulty, o = {}) => ({ question_code: 'Q' + String(++n).padStart(4, '0'), question_text: `Question ${n} about ${topic}`, type: 'mcq', options: ['w', 'x', 'y', 'z'], correct_answer: 1, topic, difficulty, role_code: null, status: 'active', marks: 2, negative_marks: 0.5, shuffle_options: true, ...o });
const pool = [];
for (const t of ['Aptitude', 'Logic']) for (const d of ['easy', 'medium', 'hard']) for (let i = 0; i < 8; i++) pool.push(q(t, d));
pool.push(q('Aptitude', 'easy', { status: 'inactive' }), q('Aptitude', 'easy', { status: 'archived' }), q('Aptitude', 'easy', { role_code: 'HR' }));
const rules = () => [{ topic: 'Aptitude', difficulty: 'easy', count: 3 }, { topic: 'aptitude', difficulty: 'hard', count: 2 }, { topic: 'Logic', difficulty: 'any', count: 4 }];

test('stream: reproducible, labelled streams differ, unbiased', () => {
  assert.deepEqual(new Stream('s', 'a').shuffle([1, 2, 3, 4, 5, 6]), new Stream('s', 'a').shuffle([1, 2, 3, 4, 5, 6]));
  assert.notDeepEqual(new Stream('s', 'a').shuffle([...Array(20).keys()]), new Stream('s', 'b').shuffle([...Array(20).keys()]));
  const counts = [0, 0, 0, 0]; for (let i = 0; i < 4000; i++) counts[new Stream('seed' + i, 'x').shuffle([0, 1, 2, 3])[0]]++;
  counts.forEach(c => assert.ok(c > 800 && c < 1200, counts.join()));
  assert.equal(newSeed().length, 32); assert.notEqual(newSeed(), newSeed());
});

test('rules: validation and overlap detection', () => {
  assert.deepEqual(validateRules(rules()), []);
  assert.match(validateRules([])[0], /at least one/);
  assert.match(validateRules([{ topic: 'A', difficulty: 'easy', count: 0 }])[0], /count/);
  assert.match(validateRules([{ topic: 'A', difficulty: 'weird', count: 1 }])[0], /difficulty/);
  assert.match(validateRules([{ topic: 'A', difficulty: 'any', count: 1 }, { topic: 'a', difficulty: 'easy', count: 1 }])[0], /overlap/);
  assert.match(validateRules([{ topic: 'A', difficulty: 'easy', count: 1 }, { topic: 'A', difficulty: 'easy', count: 1 }])[0], /overlap/);
});

test('draw: counts per topic and difficulty, only eligible questions, no repeats', () => {
  const r = rules(); validateRules(r);
  const p = drawPaper({ pool, rules: r, role: 'SDE', seed: 'abc' });
  assert.equal(p.questions.length, 9);
  const ids = p.questions.map(x => x.question.question_code); assert.equal(new Set(ids).size, 9);
  const cnt = (t, d) => p.questions.filter(x => x.question.topic === t && (!d || x.question.difficulty === d)).length;
  assert.equal(cnt('Aptitude', 'easy'), 3); assert.equal(cnt('Aptitude', 'hard'), 2); assert.equal(cnt('Logic'), 4);
  p.questions.forEach(x => { assert.equal(x.question.status, 'active'); assert.ok(!x.question.role_code); });
  assert.equal(p.totalMarks, 18);
  assert.deepEqual(p.questions.map(x => x.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // a role-specific question is usable by that role only
  const hr = drawPaper({ pool, rules: [{ topic: 'Aptitude', difficulty: 'easy', count: 9 }], role: 'HR', seed: 's' });
  assert.ok(hr.questions.some(x => x.question.role_code === 'HR'));
  assert.throws(() => drawPaper({ pool, rules: [{ topic: 'Aptitude', difficulty: 'easy', count: 9 }], role: 'SDE', seed: 's' }), e => e.code === 'insufficient_pool' && /need 9, have 8/.test(e.message));
});

test('draw: same seed reproduces, different candidates get different papers and orders', () => {
  const r = rules(); validateRules(r);
  const a1 = drawPaper({ pool, rules: r, role: 'SDE', seed: 'same' }), a2 = drawPaper({ pool, rules: r, role: 'SDE', seed: 'same' });
  assert.deepEqual(a1.questions.map(x => [x.question.question_code, x.optionOrder]), a2.questions.map(x => [x.question.question_code, x.optionOrder]));
  const sigs = new Set(); for (let i = 0; i < 50; i++) sigs.add(drawPaper({ pool, rules: r, role: 'SDE', seed: newSeed() }).questions.map(x => x.question.question_code).join());
  assert.ok(sigs.size >= 49, `distinct papers ${sigs.size}/50`);
  const ordersOnly = new Set(); for (let i = 0; i < 30; i++) ordersOnly.add(drawPaper({ pool, rules: [{ topic: 'Logic', difficulty: 'any', count: 24 }], role: 'SDE', seed: newSeed() }).questions.map(x => x.question.question_code).join());
  assert.ok(ordersOnly.size >= 29, 'question order differs even when the whole pool is used');
});

test('draw: questions and options are shuffled independently; flags switch them off', () => {
  const r = [{ topic: 'Logic', difficulty: 'any', count: 24 }];
  const on = drawPaper({ pool, rules: r, role: 'X', seed: 'k' });
  const noQ = drawPaper({ pool, rules: r, role: 'X', seed: 'k', shuffleQuestions: false });
  const noO = drawPaper({ pool, rules: r, role: 'X', seed: 'k', shuffleOptions: false });
  const codes = x => x.questions.map(y => y.question.question_code).join();
  assert.notEqual(codes(on), codes(noQ));
  assert.equal(codes(on), codes(noO));                                    // option flag does not move questions
  const optOf = x => Object.fromEntries(x.questions.map(y => [y.question.question_code, y.optionOrder.join()]));
  assert.deepEqual(optOf(on), optOf(noQ));                                // question order flag does not change option orders
  assert.ok(noO.questions.every(y => y.optionOrder.join() === '0,1,2,3'));
  assert.ok(on.questions.some(y => y.optionOrder.join() !== '0,1,2,3'));
  on.questions.forEach(y => assert.deepEqual([...y.optionOrder].sort(), [0, 1, 2, 3]));
  const locked = drawPaper({ pool: [q('L', 'easy', { shuffle_options: false })], rules: [{ topic: 'L', difficulty: 'easy', count: 1 }], role: 'X', seed: 'k' });
  assert.equal(locked.questions[0].optionOrder.join(), '0,1,2,3');
});

// ---- marking
const mk = (type, o = {}) => ({ id: 'id' + (++n), position: 1, marks: 2, negative_marks: 0.5, option_order: [2, 0, 3, 1], snapshot: { type, question_text: 'Q text here', options: ['A0', 'B1', 'C2', 'D3'], correct_answer: 1, explanation: 'secret why', reference_answer: null }, ...o });

test('candidate view never carries keys; options follow the shown order', () => {
  const v = presentQuestion(mk('mcq'));
  assert.deepEqual(v.options, ['C2', 'A0', 'D3', 'B1']);
  const json = JSON.stringify(v);
  for (const bad of ['correct', 'explanation', 'secret', 'reference', 'option_order', 'snapshot']) assert.ok(!json.toLowerCase().includes(bad), bad);
});

test('mcq marking maps shown position back to the original option', () => {
  const aq = mk('mcq');                                    // original option 1 (B1) is shown at position 3
  assert.deepEqual(markObjective(aq, 3), { marks: 2, correct: true });
  assert.deepEqual(markObjective(aq, 0), { marks: -0.5, correct: false });
  assert.deepEqual(markObjective(aq, null), { marks: 0, correct: null });
});

test('multi-select is all-or-nothing, penalty on any wrong set', () => {
  const aq = mk('multi_select', { option_order: [3, 2, 1, 0], snapshot: { type: 'multi_select', question_text: 'q', options: ['a', 'b', 'c', 'd'], correct_answer: [0, 2] } });
  assert.equal(markObjective(aq, [1, 3]).marks, 2);        // shown 1,3 -> original 2,0
  assert.equal(markObjective(aq, [1]).marks, -0.5);        // partial is wrong
  assert.equal(markObjective(aq, [0, 1, 3]).marks, -0.5);
  assert.equal(markObjective(aq, null).marks, 0);
});

test('response validation', () => {
  const aq = mk('mcq'), ms = mk('multi_select'), d = mk('descriptive', { snapshot: { type: 'descriptive', question_text: 'q' }, option_order: null });
  assert.equal(normalizeResponse(aq, 2), 2); assert.equal(normalizeResponse(aq, null), null);
  for (const bad of [4, -1, 1.5, '1', [1]]) assert.throws(() => normalizeResponse(aq, bad), /Choose/);
  assert.deepEqual(normalizeResponse(ms, [3, 1, 1]), [1, 3]); assert.equal(normalizeResponse(ms, []), null);
  assert.throws(() => normalizeResponse(ms, [9]), /Choose/);
  assert.equal(normalizeResponse(d, 'text'), 'text'); assert.throws(() => normalizeResponse(d, 'x'.repeat(10001)), /too long/); assert.throws(() => normalizeResponse(d, 5), /text/);
});

test('scoring: negatives, floor at zero, descriptive review, pass mark', () => {
  const a = mk('mcq'), b = mk('mcq'), c = mk('mcq'), d = mk('descriptive', { marks: 5, negative_marks: 0, snapshot: { type: 'descriptive', question_text: 'q' }, option_order: null });
  const R = new Map([[a.id, { response: 3 }], [b.id, { response: 0 }], [c.id, { response: 0 }], [d.id, { response: 'my answer' }]]);
  let s = scoreAttempt([a, b, c, d], R, { passPct: 30 });
  assert.equal(s.resultStatus, 'pending_review'); assert.equal(s.score, 1); assert.equal(s.max, 11);   // 2 - 0.5 - 0.5
  R.get(d.id).manual_marks = 4;
  s = scoreAttempt([a, b, c, d], R, { passPct: 50 });
  assert.equal(s.resultStatus, 'final'); assert.equal(s.score, 5); assert.equal(s.pct, 45.45); assert.equal(s.passed, false);
  const onlyWrong = scoreAttempt([b, c], new Map([[b.id, { response: 0 }], [c.id, { response: 0 }]]));
  assert.equal(onlyWrong.score, 0);                                                                   // -1 floors at 0
  assert.equal(scoreAttempt([d], new Map([[d.id, { response: '  ' }]])).resultStatus, 'final');       // blank essay needs no review
  assert.equal(scoreAttempt([a], new Map()).score, 0);
  assert.equal(validateManualMarks(d, '3.456'), 3.46); assert.throws(() => validateManualMarks(d, 6), /between 0 and 5/); assert.throws(() => validateManualMarks(d, -1), /between/);
});
