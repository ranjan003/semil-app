'use strict';
// Camera / microphone monitoring: the setting is stored, alert codes are logged, loss of camera follows the lock mode,
// nothing but short codes is accepted, and tests without monitoring ignore alerts. Needs PostgreSQL (skipped otherwise).
const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/testenv');
const { createHarness } = require('./helpers/harness');

const HAVE_DB = env.available();
const T = (name, fn) => test(name, { skip: HAVE_DB ? false : 'no PostgreSQL available (run scripts/pg-sandbox.sh start)' }, fn);
let db, hx, sa, hr, vac, cand, cand2, plain;
const api = (user, method, url, json) => hx.inject({ method, url, user, json });

T('setup', async () => {
  db = env.createDb('qb_monitor'); hx = createHarness(db);
  sa = await env.addUser(db, 'super_admin', 'SA'); hr = await env.addUser(db, 'hr_admin', 'HR');
  vac = await env.addVacancy(db, 'SDE');
  cand = await env.addCandidate(db, vac, { name: 'Cam A' }); cand2 = await env.addCandidate(db, vac, { name: 'Cam B' }); plain = await env.addCandidate(db, vac, { name: 'No Cam' });
  for (let i = 1; i <= 3; i++) assert.equal((await api(hr, 'POST', '/api/qb/questions', { question_text: `Monitor question ${i} pick one`, question_type: 'mcq', option_a: 'a', option_b: 'b', correct_answer: 'A', difficulty: 'easy', round: 1, topic: 'Aptitude', marks: 1 })).status, 201);
  assert.equal((await api(sa, 'PUT', '/api/qb/rounds/1', { published: true })).status, 200);
});

async function makeTest(extra, who) {
  const r = await api(hr, 'POST', '/api/qb/assessments', { title: 'Monitor test ' + Math.random().toString(36).slice(2, 6), round: 1, rules: [{ topic: 'Aptitude', difficulty: 'any', count: 2 }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await api(hr, 'POST', `/api/qb/assessments/${r.body.id}/publish`, { action: 'publish' })).status, 200);
  const as = await api(hr, 'POST', `/api/qb/assessments/${r.body.id}/assign`, { application_ids: [who.applicationId] });
  assert.equal(as.body.assigned, 1, JSON.stringify(as.body));
  const attempt = (await db.query(`SELECT t.id FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.assessment_id=$1`, [r.body.id])).rows[0].id;
  return { id: r.body.id, attempt, body: r.body };
}

T('setting is validated, stored, shown to the candidate and changes are audited', async () => {
  assert.equal((await api(hr, 'POST', '/api/qb/assessments', { title: 'Bad mode', round: 1, monitor_mode: 'always', rules: [] })).status, 400);
  const t = await makeTest({ monitor_mode: 'required', lock_mode: 'strict' }, cand);
  assert.equal(t.body.monitor_mode, 'required');
  const info = await api(cand.user, 'GET', `/api/qb/my/attempts/${t.attempt}`);
  assert.equal(info.body.monitor_mode, 'required');
  const plainT = await makeTest({}, plain);
  assert.equal(plainT.body.monitor_mode, 'off');
  const upd = await api(hr, 'PUT', `/api/qb/assessments/${plainT.id}`, { monitor_mode: 'required' });
  assert.equal(upd.status, 200); assert.equal(upd.body.monitor_mode, 'required');
  assert.ok((await db.query(`SELECT 1 FROM audit_logs WHERE action='qb.assessment.update' AND after::text LIKE '%monitor_mode%'`)).rows.length >= 1);
});

T('alerts are logged without blocking; only codes are accepted; loss of camera follows the lock mode', async () => {
  const t = await makeTest({ monitor_mode: 'required', lock_mode: 'strict' }, cand2);
  const start = await api(cand2.user, 'POST', `/api/qb/my/attempts/${t.attempt}/start`);
  assert.equal(start.status, 200); assert.equal(start.body.attempt.monitor_mode, 'required');
  const ev = (code, detail) => api(cand2.user, 'POST', `/api/qb/my/attempts/${t.attempt}/events`, { kind: 'monitor', code, detail });
  for (const code of ['camera_on', 'no_face', 'multiple_faces', 'camera_covered', 'loud_noise', 'face_check_unavailable']) { const r = await ev(code); assert.equal(r.status, 200); assert.equal(r.body.action, 'logged', code); }
  assert.equal((await ev('nonsense')).status, 400);
  assert.equal((await ev('DROP TABLE')).status, 400);
  const row = (await db.query(`SELECT status FROM attempts WHERE id=$1`, [t.attempt])).rows[0]; assert.equal(row.status, 'in_progress', 'alerts alone never block');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id=$1 AND kind='monitor'`, [t.attempt])).rows[0].n, 6);
  const sub = await api(hr, 'GET', `/api/qb/submissions?assessment_id=${t.id}`); assert.equal(sub.body.items[0].monitor_flags, 6);
  const lost = await ev('camera_lost'); assert.equal(lost.body.action, 'block');
  assert.equal((await db.query(`SELECT status FROM attempts WHERE id=$1`, [t.attempt])).rows[0].status, 'blocked');
  assert.equal((await api(cand2.user, 'GET', `/api/qb/my/attempts/${t.attempt}/paper`)).body.questions.length, 0, 'blocked attempts get no questions');
  const detail = await api(hr, 'GET', `/api/qb/attempts/${t.attempt}`); assert.ok(detail.body.events.some(e => e.kind === 'monitor' && /No face/.test(e.detail)));
});

T('tests without monitoring ignore alerts, and another candidate cannot post to this attempt', async () => {
  const t = await makeTest({}, plain);
  await api(hr, 'PUT', `/api/qb/assessments/${t.id}`, { monitor_mode: 'off' });
  assert.equal((await api(plain.user, 'POST', `/api/qb/my/attempts/${t.attempt}/start`)).status, 200);
  const r = await api(plain.user, 'POST', `/api/qb/my/attempts/${t.attempt}/events`, { kind: 'monitor', code: 'no_face' }); assert.equal(r.body.action, 'ignore');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id=$1 AND kind='monitor'`, [t.attempt])).rows[0].n, 0);
  assert.equal((await api(cand.user, 'POST', `/api/qb/my/attempts/${t.attempt}/events`, { kind: 'monitor', code: 'no_face' })).status, 404);
});

T('warn mode: losing the camera warns first, then blocks', async () => {
  const w = await env.addCandidate(db, vac, { name: 'Warn' });
  const t = await makeTest({ monitor_mode: 'required', lock_mode: 'warn' }, w);
  await api(w.user, 'POST', `/api/qb/my/attempts/${t.attempt}/start`);
  const ev = () => api(w.user, 'POST', `/api/qb/my/attempts/${t.attempt}/events`, { kind: 'monitor', code: 'mic_lost' });
  assert.equal((await ev()).body.action, 'warn'); assert.equal((await ev()).body.action, 'warn'); assert.equal((await ev()).body.action, 'block');
});

test('teardown', { skip: !HAVE_DB }, async () => { if (db) await db.end(); });
