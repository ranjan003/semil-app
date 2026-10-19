const test = require('node:test'); const assert = require('node:assert/strict');
const P = require('../src/permissions');
const U = r => ({ id: r + '-1', role: r });

test('super admin can do everything; HR cannot touch admin-only capabilities', () => {
  for (const cap of ['config:write', 'user:manage', 'override:record', 'candidate:write']) assert.ok(P.can(U('super_admin'), cap));
  for (const cap of P.SUPER_ADMIN_ONLY) assert.equal(P.can(U('hr_admin'), cap), false, cap);
  assert.ok(P.can(U('hr_admin'), 'candidate:write'));
});
test('assessors cannot create vacancies, export reports or read internal notes capability', () => {
  for (const r of ['technical_assessor', 'business_assessor']) for (const cap of ['vacancy:write', 'report:export', 'candidate:notes', 'candidate:write'])
    assert.equal(P.can(U(r), cap), false, r + ' ' + cap);
});
test('unknown roles and missing users get nothing', () => {
  assert.equal(P.can(null, 'candidate:read'), false); assert.equal(P.can({ role: 'intern' }, 'candidate:read'), false);
});
test('a candidate can only open their own record', () => {
  const me = { id: 'u1', role: 'candidate' };
  assert.ok(P.canAccessCandidate(me, { user_id: 'u1' })); assert.equal(P.canAccessCandidate(me, { user_id: 'u2' }), false);
});
test('assessors only see candidates assigned to them', () => {
  const a = { id: 'a1', role: 'technical_assessor' };
  assert.ok(P.canAccessCandidate(a, { assessor_id: 'a1' })); assert.equal(P.canAccessCandidate(a, { assessor_id: 'a2' }), false);
});
test('internal notes are stripped for everyone except HR and super admin', () => {
  const row = { id: 'c1', user_id: 'u1', assessor_id: 'a1', hr_owner_id: 'h1', source: 'Referral', internal_notes: 'secret' };
  assert.equal(P.candidateView({ id: 'h', role: 'hr_admin' }, row).internal_notes, 'secret');
  assert.equal(P.candidateView({ id: 'a1', role: 'technical_assessor' }, row).internal_notes, undefined);
  const mine = P.candidateView({ id: 'u1', role: 'candidate' }, row);
  assert.equal(mine.internal_notes, undefined); assert.equal(mine.assessor_id, undefined); assert.equal(mine.source, undefined);
  assert.equal(P.candidateView({ id: 'u9', role: 'candidate' }, row), null);
});
test('answer keys never reach the candidate serializer', () => {
  const a = { id: 'a', title: 'T', rubric: ['x'], reviewers: ['r'], questions: [{ id: 'q', prompt: 'P', options: ['a', 'b'], correct_answer: 1, rubric_hint: 'h', marks: 2 }] };
  const out = P.assessmentForCandidate(a);
  assert.ok(!JSON.stringify(out).includes('correct_answer')); assert.ok(!JSON.stringify(out).includes('rubric'));
  assert.equal(out.questions[0].prompt, 'P'); assert.equal(out.questions[0].marks, 2);
});
test('requireCap middleware returns 403 and calls next correctly', () => {
  let code = null, nexted = false;
  const res = { status(c) { code = c; return this; }, json() {} };
  P.requireCap('vacancy:write')({ user: U('technical_assessor') }, res, () => { nexted = true; });
  assert.equal(code, 403); assert.equal(nexted, false);
  P.requireCap('vacancy:write')({ user: U('hr_admin') }, res, () => { nexted = true; }); assert.ok(nexted);
});
