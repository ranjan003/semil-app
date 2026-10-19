'use strict';
// End-to-end workflow against a real PostgreSQL: admin upload -> preview -> confirm -> assessment -> publish -> assign ->
// candidate paper -> autosave -> submit -> marking -> results -> reports. Skipped when no test database is reachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/testenv');
const { createHarness } = require('./helpers/harness');
const { readXlsx } = require('../src/qb/xlsx');
const { parseCsv } = require('../src/qb/csv');
const att = require('../src/qb/attempt');

const HAVE_DB = env.available();
const T = (name, fn) => test(name, { skip: HAVE_DB ? false : 'no PostgreSQL available (run scripts/pg-sandbox.sh start)' }, fn);

let db, hx, sa, hr, assessor, candA, candB, candC, candX, vacancy, otherVacancy, asmId, importedBatch;
const api = (user, method, url, json) => hx.inject({ method, url, user, json });
const get = (u, url) => api(u, 'GET', url);
const post = (u, url, j) => api(u, 'POST', url, j || {});
const put = (u, url, j) => api(u, 'PUT', url, j || {});
const upload = (user, buffer, name, mime, conflict) => hx.inject({ method: 'POST', url: `/api/qb/import/preview?name=${encodeURIComponent(name)}${conflict ? '&on_conflict=' + conflict : ''}`, user, buffer, headers: { 'content-type': mime } });
const L = 'ABCD';

const BAD_CSV_SUFFIX = ',"Bad row without answer",mcq,x,y,,,,,easy,ALL,1,Aptitude,1,0,\r\n';
function csvBank() {
  const head = 'question_id,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,job_role,round,topic,marks,negative_marks,status';
  const rows = [];
  let n = 0;
  for (const topic of ['Aptitude', 'Logic']) for (const d of ['easy', 'medium', 'hard']) for (let i = 1; i <= 4; i++) {
    n++; const ans = L[n % 4];
    rows.push(`,"${topic} ${d} question ${i}: pick the right option",mcq,Alpha ${n},Bravo ${n},Charlie ${n},Delta ${n},${ans},"Because option ${ans} is right ${n}",${d},ALL,1,${topic},2,0.5,active`);
  }
  rows.push(',"Select the two even numbers (set 1)",multi_select,2,3,4,5,"A,C","2 and 4",medium,ALL,1,Aptitude,3,1,active');
  for (let i = 1; i <= 3; i++) rows.push(`,"Written question ${i}: describe your approach",descriptive,,,,,"Look for structure and clarity",,easy,ALL,1,Written,5,,active`);
  rows.push(',"SDE only question about sockets",mcq,tcp,udp,icmp,arp,A,,easy,SDE,1,Networks,1,0,active');
  return head + '\r\n' + rows.join('\r\n') + '\r\n';
}

T('setup: database, users, vacancy, candidates', async () => {
  db = env.createDb('qb_flow'); hx = createHarness(db);
  sa = await env.addUser(db, 'super_admin', 'Super Admin'); hr = await env.addUser(db, 'hr_admin', 'HR Admin'); assessor = await env.addUser(db, 'technical_assessor', 'Assessor');
  vacancy = await env.addVacancy(db, 'SDE'); otherVacancy = await env.addVacancy(db, 'DATA_ANALYST', 'Analyst');
  candA = await env.addCandidate(db, vacancy, { name: 'Cand A', assessorId: assessor.id });
  candB = await env.addCandidate(db, vacancy, { name: 'Cand B' });
  candC = await env.addCandidate(db, vacancy, { name: 'Cand C', stage: 'applied' });
  candX = await env.addCandidate(db, otherVacancy, { name: 'Cand X' });
});

T('access control: every admin route refuses candidates, assessors and anonymous callers', async () => {
  const adminRoutes = [['GET', '/api/qb/questions'], ['POST', '/api/qb/questions'], ['GET', '/api/qb/meta'], ['GET', '/api/qb/templates/csv'], ['GET', '/api/qb/assessments'], ['POST', '/api/qb/assessments'], ['GET', '/api/qb/rounds'], ['GET', '/api/qb/audit'], ['GET', '/api/qb/questions/export'], ['GET', '/api/qb/submissions/export']];
  for (const [m, u] of adminRoutes) {
    assert.equal((await api(null, m, u, {})).status, 401, `${u} anonymous`);
    assert.equal((await api(candA.user, m, u, {})).status, 403, `${u} candidate`);
    assert.equal((await api(assessor, m, u, {})).status, 403, `${u} assessor`);
  }
  assert.equal((await api(hr, 'PUT', '/api/qb/rounds/1', { published: true })).status, 403, 'HR cannot change round settings');
  assert.equal((await api(candA.user, 'GET', '/api/qb/submissions')).status, 403);
  assert.equal((await api(null, 'GET', '/api/qb/my/assessments')).status, 401);
  assert.equal((await api(hr, 'GET', '/api/qb/my/assessments')).status, 403, 'staff do not use the candidate portal routes');
});

T('templates: every format downloads for HR', async () => {
  for (const [f, magic] of [['csv', 'question_id'], ['xlsx', 'PK'], ['docx', 'PK']]) {
    const r = await get(hr, `/api/qb/templates/${f}`);
    assert.equal(r.status, 200); assert.match(r.headers['Content-Disposition'], new RegExp(`\\.${f}"`)); assert.ok(r.raw.toString('latin1').includes(magic) || r.raw.subarray(0, 2).toString() === magic);
  }
  assert.equal((await get(hr, '/api/qb/templates/pdf')).status, 404);
});

T('import: bad uploads are refused with clear messages', async () => {
  assert.equal((await upload(hr, Buffer.from('a,b'), 'x.exe', 'application/octet-stream')).status, 415);
  assert.equal((await upload(hr, Buffer.alloc(0), 'x.csv', 'text/csv')).status, 400);
  const r = await upload(hr, Buffer.from('<html>'), 'x.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(r.status, 415); assert.match(r.body.message, /not a valid/);
  const missing = await upload(hr, Buffer.from('question_text\r\nHello there\r\n'), 'x.csv', 'text/csv');
  assert.equal(missing.status, 200); assert.equal(missing.body.batchId, null); assert.match(missing.body.fileErrors[0], /Missing required/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM question_bank')).rows[0].n, 0, 'nothing saved');
});

T('import: preview shows row errors, nothing is saved until confirmed, commit is atomic and once only', async () => {
  const bad = csvBank() + BAD_CSV_SUFFIX;
  const prev = await upload(hr, Buffer.from(bad), 'bank.csv', 'text/csv');
  assert.equal(prev.status, 201, JSON.stringify(prev.body));
  assert.equal(prev.body.summary.error, 1); assert.equal(prev.body.summary.new, 29);
  assert.equal(prev.body.rows[0].status, 'error'); assert.match(prev.body.rows[0].errors[0].message, /Correct answer is required/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM question_bank')).rows[0].n, 0, 'preview must not save');
  importedBatch = prev.body.batchId;
  // another admin cannot confirm or read someone else's preview
  assert.equal((await post(await env.addUser(db, 'hr_admin', 'Other HR'), `/api/qb/import/${importedBatch}/commit`)).status, 404);
  // two confirm clicks at the same time: exactly one wins
  const [c1, c2] = await Promise.all([post(hr, `/api/qb/import/${importedBatch}/commit`), post(hr, `/api/qb/import/${importedBatch}/commit`)]);
  const ok = [c1, c2].filter(x => x.status === 201), dup = [c1, c2].filter(x => x.status === 409);
  assert.equal(ok.length, 1, JSON.stringify([c1.body, c2.body])); assert.equal(dup.length, 1); assert.equal(dup[0].body.error, 'already_committed');
  assert.equal(ok[0].body.created, 29);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM question_bank')).rows[0].n, 29);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM question_versions`)).rows[0].n, 29);
  assert.equal((await post(hr, `/api/qb/import/${importedBatch}/commit`)).status, 409, 'third try also refused');
  const batch = await get(hr, `/api/qb/import/${importedBatch}`); assert.equal(batch.body.status, 'committed');
  // codes were generated
  const codes = (await db.query('SELECT question_code FROM question_bank ORDER BY question_code')).rows.map(r => r.question_code);
  assert.equal(codes[0], 'Q-00001'); assert.equal(new Set(codes).size, 29);
});

T('import: re-uploading the same file reports duplicates and saves nothing new; update mode edits by ID', async () => {
  const again = await upload(hr, Buffer.from(csvBank() + BAD_CSV_SUFFIX), 'bank.csv', 'text/csv');
  assert.equal(again.body.summary.duplicate, 29); assert.equal(again.body.summary.importable, 0); assert.equal(again.body.summary.error, 1);
  assert.ok(again.body.warnings.some(w => /already imported/.test(w)));
  assert.equal((await post(hr, `/api/qb/import/${again.body.batchId}/commit`)).status, 400, 'nothing to import');
  const first = (await db.query(`SELECT question_code FROM question_bank WHERE topic='Networks'`)).rows[0].question_code;
  const csv = `question_id,question_text,question_type,option_a,option_b,correct_answer,difficulty,round,topic,marks\r\n${first},"SDE only question about sockets (edited)",mcq,tcp,udp,B,easy,1,Networks,1\r\nNEW-1,"Brand new imported question",mcq,yes,no,A,easy,2,Basics,1\r\n`;
  const skip = await upload(hr, Buffer.from(csv), 'u.csv', 'text/csv', 'skip'); assert.equal(skip.body.summary.duplicate, 1);
  const upd = await upload(hr, Buffer.from(csv), 'u.csv', 'text/csv', 'update'); assert.equal(upd.body.summary.update, 1);
  const done = await post(hr, `/api/qb/import/${upd.body.batchId}/commit`); assert.equal(done.body.updated, 1); assert.equal(done.body.created, 1);
  const q = (await db.query(`SELECT question_text, version, correct_answer FROM question_bank WHERE question_code=$1`, [first])).rows[0];
  assert.equal(q.version, 2); assert.match(q.question_text, /edited/); assert.equal(Number(q.correct_answer), 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM question_bank WHERE question_code='NEW-1'`)).rows[0].n, 1);
  const cancelled = await upload(hr, Buffer.from(csv.replace('NEW-1', 'NEW-2').replace('Brand new', 'Another new')), 'c.csv', 'text/csv');
  assert.equal((await post(hr, `/api/qb/import/${cancelled.body.batchId}/cancel`)).status, 200);
  assert.equal((await post(hr, `/api/qb/import/${cancelled.body.batchId}/commit`)).status, 409);
});

T('import: Excel and Word uploads work end to end', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const xl = await upload(hr, fs.readFileSync(path.join(__dirname, 'fixtures/qb/valid.xlsx')), 'valid.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(xl.status, 201); assert.equal(xl.body.summary.new, 3); assert.equal(xl.body.summary.error, 3);
  assert.equal((await post(hr, `/api/qb/import/${xl.body.batchId}/commit`)).body.created, 3);
  const dx = await upload(hr, fs.readFileSync(path.join(__dirname, 'fixtures/qb/valid.docx')), 'valid.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(dx.status, 201); assert.equal(dx.body.summary.duplicate, 3, 'same questions as the xlsx are duplicates');
  await post(hr, `/api/qb/import/${dx.body.batchId}/cancel`);
  await db.query(`UPDATE question_bank SET status='archived' WHERE import_batch_id=$1`, [xl.body.batchId]);   // keep the main bank clean for the next tests
});

T('question CRUD: create, duplicate refused, edit with version history, deactivate, archive, search', async () => {
  const body = { question_text: 'Which layer routes packets between networks?', question_type: 'mcq', option_a: 'Link', option_b: 'Network', option_c: 'Transport', option_d: 'Session', correct_answer: 'B', difficulty: 'medium', job_role: 'SDE', round: 1, topic: 'Networks', marks: 2, negative_marks: 0.5, explanation: 'Layer 3' };
  assert.equal((await api(hr, 'POST', '/api/qb/questions', { ...body, correct_answer: 'F' })).status, 400);
  const made = await api(hr, 'POST', '/api/qb/questions', body); assert.equal(made.status, 201); const id = made.body.id;
  assert.equal(made.body.flat.correct_answer, 'B');
  const dup = await api(hr, 'POST', '/api/qb/questions', body); assert.equal(dup.status, 409); assert.equal(dup.body.error, 'duplicate_question');
  assert.equal((await api(hr, 'POST', '/api/qb/questions', { ...body, question_id: made.body.question_code, question_text: 'Another different wording here' })).body.error, 'duplicate_id');
  const ed = await put(hr, `/api/qb/questions/${id}`, { marks: 3, change_note: 'raise marks' }); assert.equal(ed.status, 200); assert.equal(ed.body.version, 2); assert.equal(ed.body.marks, 3);
  assert.equal((await put(hr, `/api/qb/questions/${id}`, { question_id: 'Q-99999' })).status, 400, 'ID cannot change');
  const detail = await get(hr, `/api/qb/questions/${id}`); assert.equal(detail.body.versions.length, 2);
  const found = await get(hr, '/api/qb/questions?q=packets&round=1&type=mcq&difficulty=medium&role=SDE&topic=networks'); assert.equal(found.body.total, 1);
  assert.equal((await get(hr, '/api/qb/questions?q=%25')).body.total, 0, 'wildcards are escaped');
  assert.equal((await post(hr, '/api/qb/questions/status', { ids: [id], status: 'inactive' })).body.updated, 1);
  assert.equal((await get(hr, '/api/qb/questions?status=inactive')).body.total, 1);
  assert.equal((await post(hr, '/api/qb/questions/status', { ids: [id], status: 'archived' })).body.updated, 1);
  assert.equal((await get(hr, '/api/qb/questions?q=packets')).body.total, 0, 'archived hidden by default');
  assert.equal((await get(hr, '/api/qb/questions?q=packets&status=archived')).body.total, 1);
  assert.equal((await put(hr, `/api/qb/questions/${id}`, { marks: 4 })).status, 409, 'archived cannot be edited');
  // recreate the same wording while the old one is archived, then restoring the old one must conflict
  assert.equal((await api(hr, 'POST', '/api/qb/questions', body)).status, 201);
  assert.equal((await post(hr, '/api/qb/questions/status', { ids: [id], status: 'active' })).status, 409);
  assert.equal((await get(hr, '/api/qb/questions/not-a-uuid')).status, 404);
  const exp = await get(hr, '/api/qb/questions/export?format=csv&round=1'); assert.equal(exp.status, 200);
  assert.ok(parseCsv(exp.raw).rows.length > 30);
  const xl = readXlsx((await get(hr, '/api/qb/questions/export?format=xlsx')).raw); assert.ok(xl.rows.length > 30);
  await post(hr, '/api/qb/questions/status', { ids: [(await db.query(`SELECT id FROM question_bank WHERE question_text='Which layer routes packets between networks?' AND status='active'`)).rows[0].id], status: 'archived' });
});

T('rounds: HR cannot edit, Super Admin can; validation; audited', async () => {
  const list = await get(hr, '/api/qb/rounds'); assert.equal(list.body.items.length, 5); assert.equal(list.body.items[0].published, false);
  assert.equal((await put(sa, '/api/qb/rounds/1', { duration_minutes: 0 })).status, 400);
  assert.equal((await put(sa, '/api/qb/rounds/1', { eligibility: { require_stage: 'yes' } })).status, 400);
  assert.equal((await put(sa, '/api/qb/rounds/9', {})).status, 400);
  const ok = await put(sa, '/api/qb/rounds/1', { name: 'Mind Ability and Aptitude', duration_minutes: 30, pass_threshold_pct: 40 }); assert.equal(ok.status, 200);
  assert.equal((await get(hr, '/api/qb/rounds')).body.items[0].name, 'Mind Ability and Aptitude');
  assert.ok((await db.query(`SELECT 1 FROM audit_logs WHERE action='qb.round.update'`)).rows.length >= 1);
});

T('assessment: blueprint validation, shortage blocks publishing, publish, edit bumps version', async () => {
  const bad = await api(hr, 'POST', '/api/qb/assessments', { title: 'X', round: 1 }); assert.equal(bad.status, 400);
  const overlap = await api(hr, 'POST', '/api/qb/assessments', { title: 'Overlap test', round: 1, rules: [{ topic: 'Aptitude', difficulty: 'any', count: 1 }, { topic: 'aptitude', difficulty: 'easy', count: 1 }] });
  assert.equal(overlap.status, 400); assert.match(overlap.body.message, /overlap/);
  const rules = [{ topic: 'Aptitude', difficulty: 'easy', count: 3 }, { topic: 'Aptitude', difficulty: 'medium', count: 2 }, { topic: 'Logic', difficulty: 'any', count: 3 }, { topic: 'Written', difficulty: 'easy', count: 1 }];
  const short = await api(hr, 'POST', '/api/qb/assessments', { title: 'Too many', round: 1, rules: [{ topic: 'Logic', difficulty: 'hard', count: 9 }] });
  assert.equal(short.status, 201);
  const refuse = await post(hr, `/api/qb/assessments/${short.body.id}/publish`, { action: 'publish' }); assert.equal(refuse.status, 409); assert.match(refuse.body.message, /need 9, have 4/);
  const made = await api(hr, 'POST', '/api/qb/assessments', { title: 'Round 1 Aptitude Test', round: 1, rules, instructions: 'Read each question carefully.', results_policy: 'score_and_review', lock_mode: 'strict' });
  assert.equal(made.status, 201, JSON.stringify(made.body)); asmId = made.body.id;
  assert.equal(made.body.time_limit_minutes, 30, 'defaults to the round duration'); assert.equal(made.body.pass_mark_pct, 40);
  const g = await get(hr, `/api/qb/assessments/${asmId}`); assert.equal(g.body.availability.ok, true); assert.equal(g.body.availability.questions, 9);
  assert.equal((await post(hr, `/api/qb/assessments/${asmId}/publish`, { action: 'publish' })).body.status, 'active');
  const upd = await put(hr, `/api/qb/assessments/${asmId}`, { instructions: 'Read each question carefully. No calculators.' }); assert.equal(upd.body.current_version, 1, 'text change keeps the version');
  const upd2 = await put(hr, `/api/qb/assessments/${asmId}`, { time_limit_minutes: 35 }); assert.equal(upd2.body.current_version, 2, 'timing change bumps the version');
  const prev = await get(hr, `/api/qb/assessments/${asmId}/preview`); assert.equal(prev.body.questions.length, 9);
  assert.ok(prev.body.questions.some(q => q.correct !== null), 'admin preview shows the key');
});

T('assign: eligibility follows the existing workflow, wrong role and repeat assignments are reported', async () => {
  const roleScoped = await api(hr, 'POST', '/api/qb/assessments', { title: 'Analyst only', round: 1, roles: ['DATA_ANALYST'], rules: [{ topic: 'Logic', difficulty: 'easy', count: 2 }] });
  await post(hr, `/api/qb/assessments/${roleScoped.body.id}/publish`, { action: 'publish' });
  const wrongRole = await post(hr, `/api/qb/assessments/${roleScoped.body.id}/assign`, { application_ids: [candA.applicationId] });
  assert.equal(wrongRole.body.results[0].status, 'ineligible'); assert.match(wrongRole.body.results[0].reason, /DATA_ANALYST/);
  const r = await post(hr, `/api/qb/assessments/${asmId}/assign`, { application_ids: [candA.applicationId, candB.applicationId, candC.applicationId, candX.applicationId] });
  const by = Object.fromEntries(r.body.results.map(x => [x.application_id, x]));
  assert.equal(by[candA.applicationId].status, 'assigned'); assert.equal(by[candB.applicationId].status, 'assigned');
  assert.equal(by[candC.applicationId].status, 'ineligible'); assert.match(by[candC.applicationId].reason, /move them to round 1/, 'candidate still at "applied" is not forced into the round');
  assert.equal(by[candX.applicationId].status, 'assigned');
  assert.equal((await post(hr, `/api/qb/assessments/${asmId}/assign`, { application_ids: [candA.applicationId] })).body.results[0].status, 'already_assigned');
  assert.equal((await db.query(`SELECT stage::text AS s FROM applications WHERE id=$1`, [candC.applicationId])).rows[0].s, 'applied', 'stage untouched');
  const a = (await db.query(`SELECT assessment_version FROM assignments WHERE application_id=$1 AND assessment_id=$2`, [candA.applicationId, asmId])).rows[0]; assert.equal(a.assessment_version, 2);
});

T('candidate portal: nothing is visible until the round is published; then only the authorised test', async () => {
  assert.deepEqual((await get(candA.user, '/api/qb/my/assessments')).body.current, [], 'round not published yet');
  assert.equal((await post(candA.user, `/api/qb/my/attempts/${(await db.query(`SELECT t.id FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.application_id=$1 AND g.assessment_id=$2`, [candA.applicationId, asmId])).rows[0].id}/start`)).status, 404);
  assert.equal((await put(sa, '/api/qb/rounds/1', { published: true })).status, 200);
  const mine = await get(candA.user, '/api/qb/my/assessments'); assert.equal(mine.body.current.length, 1);
  assert.equal(mine.body.current[0].state, 'available'); assert.equal(mine.body.current[0].title, 'Round 1 Aptitude Test');
  assert.deepEqual((await get(candC.user, '/api/qb/my/assessments')).body.current, [], 'unassigned candidate sees nothing');
  const info = await get(candA.user, `/api/qb/my/attempts/${mine.body.current[0].attempt_id}`);
  assert.equal(info.body.can_start, true); assert.equal(info.body.questions, 9); assert.equal(info.body.duration_minutes, 35);
  assert.ok(!JSON.stringify(info.body).match(/correct|explanation|snapshot/i));
});

const attemptOf = async (cand) => (await db.query(`SELECT t.id FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.application_id=$1 AND g.assessment_id=$2`, [cand.applicationId, asmId])).rows[0].id;
const keyShown = async (attemptId) => (await db.query(`SELECT id, snapshot, option_order, position FROM attempt_questions WHERE attempt_id=$1 ORDER BY position`, [attemptId])).rows.map(q => {
  const s = q.snapshot;
  const shown = s.type === 'mcq' ? q.option_order.indexOf(s.correct_answer) : s.type === 'multi_select' ? s.correct_answer.map(i => q.option_order.indexOf(i)).sort((a, b) => a - b) : 'A thoughtful written answer';
  return { id: q.id, type: s.type, shown, snapshot: s };
});
let paperA, paperB, attA, attB;

T('start: a server-side random paper per candidate, no keys, stored once, identical on refresh/resume', async () => {
  attA = await attemptOf(candA); attB = await attemptOf(candB);
  const sA = await post(candA.user, `/api/qb/my/attempts/${attA}/start`); assert.equal(sA.status, 200, JSON.stringify(sA.body)); paperA = sA.body;
  const sB = await post(candB.user, `/api/qb/my/attempts/${attB}/start`); paperB = sB.body;
  for (const p of [paperA, paperB]) {
    assert.equal(p.questions.length, 9); assert.equal(p.attempt.status, 'in_progress');
    assert.ok(Math.abs(p.attempt.remaining_ms - 35 * 60000) < 5000);
    const dump = JSON.stringify(p);
    for (const bad of ['correct_answer', 'explanation', 'reference', 'option_order', 'snapshot', 'text_hash', 'Because option']) assert.ok(!dump.includes(bad), `leaked ${bad}`);
    assert.deepEqual(Object.keys(p.questions[0]).sort(), ['id', 'marks', 'negativeMarks', 'options', 'position', 'text', 'type']);
  }
  const ids = p => p.questions.map(q => q.text).join('|');
  assert.notEqual(ids(paperA), ids(paperB), 'two candidates get different papers');
  assert.equal(new Set(paperA.questions.map(q => q.id)).size, 9);
  // blueprint counts honoured (via the stored snapshots)
  const sn = (await keyShown(attA)).map(k => k.snapshot);
  const cnt = (t, d) => sn.filter(s => s.topic === t && (!d || s.difficulty === d)).length;
  assert.equal(cnt('Aptitude', 'easy'), 3); assert.equal(cnt('Aptitude', 'medium'), 2); assert.equal(cnt('Logic'), 3); assert.equal(cnt('Written'), 1);
  assert.ok(sn.every(s => s.topic !== 'Networks'), 'SDE-only question not in a pool that did not ask for that topic');
  // persisted: ids, option order, version, timestamp
  const stored = (await db.query(`SELECT p.assessment_version, p.generated_at, p.seed, count(q.id)::int AS n, bool_and(q.option_order IS NOT NULL OR q.snapshot->>'type'='descriptive') AS orders FROM attempt_papers p JOIN attempt_questions q ON q.attempt_id=p.attempt_id WHERE p.attempt_id=$1 GROUP BY 1,2,3`, [attA])).rows[0];
  assert.equal(stored.n, 9); assert.equal(stored.assessment_version, 2); assert.ok(stored.generated_at); assert.equal(stored.seed.length, 32); assert.ok(stored.orders);
  assert.ok((await db.query(`SELECT created_at FROM assignments WHERE application_id=$1`, [candA.applicationId])).rows[0].created_at);
  // refresh, second tab, double-click start: same paper
  for (const again of [await get(candA.user, `/api/qb/my/attempts/${attA}/paper`), await post(candA.user, `/api/qb/my/attempts/${attA}/start`)]) {
    assert.deepEqual(again.body.questions, paperA.questions);
  }
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_papers WHERE attempt_id=$1`, [attA])).rows[0].n, 1);
  // shuffles really happen: across the 9+9 questions some options are not in bank order
  const moved = (await db.query(`SELECT count(*)::int AS n FROM attempt_questions WHERE option_order IS NOT NULL AND option_order::text <> '[0, 1, 2, 3]' AND attempt_id = ANY($1::uuid[])`, [[attA, attB]])).rows[0].n;
  assert.ok(moved >= 4, `options shuffled in ${moved} questions`);
});

T('isolation: one candidate cannot read, save to or submit another candidate\'s attempt', async () => {
  const qid = paperA.questions[0].id;
  for (const [m, u, j] of [['GET', `/api/qb/my/attempts/${attA}`], ['GET', `/api/qb/my/attempts/${attA}/paper`], ['POST', `/api/qb/my/attempts/${attA}/start`], ['PUT', `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: qid, rev: 1, response: 0 }] }], ['POST', `/api/qb/my/attempts/${attA}/submit`], ['GET', `/api/qb/my/attempts/${attA}/result`], ['POST', `/api/qb/my/attempts/${attA}/events`, { kind: 'violation' }]]) {
    assert.equal((await api(candB.user, m, u, j)).status, 404, `${m} ${u}`);
    assert.equal((await api(candX.user, m, u, j)).status, 404, `${m} ${u} (other role)`);
  }
  // B cannot write into A's question even through B's own attempt
  const r = await put(candB.user, `/api/qb/my/attempts/${attB}/responses`, { items: [{ id: qid, rev: 1, response: 0 }] }); assert.equal(r.status, 400);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_responses WHERE attempt_question_id=$1`, [qid])).rows[0].n, 0);
  assert.equal((await get(assessor, `/api/qb/attempts/${attB}`)).status, 404, 'assessor sees only their own candidates');
});

T('autosave: saves, ignores late retries, validates, survives logout/login and reconnect', async () => {
  const keys = await keyShown(attA);
  const mcqs = keys.filter(k => k.type === 'mcq');       // the draw is random, so pick questions by type, not by position
  const q0 = mcqs[0], q1 = mcqs[1];
  const s1 = await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q0.id, rev: 1, response: (q0.shown + 1) % 4 }] }); assert.equal(s1.status, 200); assert.equal(s1.body.saved[0].saved, true);
  await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q0.id, rev: 3, response: q0.shown }] });
  const late = await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q0.id, rev: 2, response: (q0.shown + 2) % 4 }] });
  assert.equal(late.body.saved[0].saved, false); assert.equal(late.body.saved[0].stale, true);
  assert.equal((await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q0.id, rev: 4, response: 9 }] })).status, 400, 'option out of range');
  assert.equal((await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q0.id, rev: 4, response: 'x' }] })).status, 400);
  assert.equal((await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: 'nope', rev: 4, response: 1 }] })).status, 404);
  // "logout, come back": a fresh GET of the paper has the saved answers
  const back = await get(candA.user, `/api/qb/my/attempts/${attA}/paper`);
  assert.equal(back.body.answers[q0.id].response, q0.shown); assert.equal(back.body.answers[q0.id].rev, 3); assert.equal(back.body.progress.answered, 1);
  // offline queue flush: several answers at once, in any order
  const batch = keys.filter(k => k.id !== q0.id).slice(0, 5).map((k, i) => ({ id: k.id, rev: 1, response: k.type === 'multi_select' ? k.shown : k.type === 'descriptive' ? k.shown : k.shown }));
  const flushed = await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: batch }); assert.equal(flushed.body.saved.every(x => x.saved), true);
  assert.equal(flushed.body.answered, 6);
  // clearing an answer
  assert.equal((await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q1.id, rev: 2, response: null }] })).body.answered, 5);
  await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: q1.id, rev: 3, response: q1.shown }] });
});

T('submit: scored on the server from the stored key (negative marks, multi-select, floor), idempotent, hidden until published', async () => {
  const keys = await keyShown(attA);
  // finish A: answer everything correctly except flip one MCQ to wrong
  const items = keys.map((k, i) => ({ id: k.id, rev: 10, response: k.type === 'mcq' && i === 2 ? (k.shown + 1) % 4 : k.shown }));
  await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items });
  const [s1, s2] = await Promise.all([post(candA.user, `/api/qb/my/attempts/${attA}/submit`, { ref: 'r1' }), post(candA.user, `/api/qb/my/attempts/${attA}/submit`, { ref: 'r2' })]);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  assert.deepEqual([s1.body.duplicate, s2.body.duplicate].sort(), [false, true], 'exactly one submit did the work');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id=$1 AND kind IN ('submitted','auto_submitted')`, [attA])).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='qb.attempt.submit'`, [attA])).rows[0].n, 1);
  assert.equal(s1.body.result.visible, false); assert.match(s1.body.result.message, /hiring team/);
  // expected score, computed independently from the stored snapshots
  let exp = 0, max = 0;
  keys.forEach((k, i) => { const m = Number(k.snapshot.type === 'descriptive' ? 5 : k.snapshot.type === 'multi_select' ? 3 : 2); max += m; if (k.type === 'mcq' && i === 2) exp -= 0.5; else if (k.type !== 'descriptive') exp += m; });
  const row = (await db.query(`SELECT status, result_status, auto_score, max_score, final_score FROM attempts WHERE id=$1`, [attA])).rows[0];
  assert.equal(row.status, 'submitted'); assert.equal(row.result_status, 'pending_review', 'written answer awaits a reviewer'); assert.equal(Number(row.auto_score), exp); assert.equal(Number(row.max_score), max); assert.equal(row.final_score, null);
  // nothing can be changed afterwards
  assert.equal((await put(candA.user, `/api/qb/my/attempts/${attA}/responses`, { items: [{ id: keys[0].id, rev: 99, response: 0 }] })).status, 409);
  assert.equal((await post(candA.user, `/api/qb/my/attempts/${attA}/start`)).status, 409);
  assert.equal((await get(candA.user, `/api/qb/my/assessments`)).body.completed[0].result, 'not_published');
  assert.equal((await get(candA.user, `/api/qb/my/attempts/${attA}/result`)).body.visible, false);
});

T('marking: assessor reviews only own candidate\'s written answer; result becomes final; publishing controls candidate view', async () => {
  const detail = await get(hr, `/api/qb/attempts/${attA}`); assert.equal(detail.status, 200);
  const written = detail.body.questions.find(q => q.type === 'descriptive');
  assert.ok(detail.body.paper.seed); assert.equal(detail.body.paper.assessment_version, 2);
  assert.equal((await get(assessor, `/api/qb/attempts/${attA}`)).status, 200, 'assigned assessor can open it');
  assert.equal((await put(assessor, `/api/qb/attempts/${attA}/review/${written.id}`, { marks: 6 })).status, 400, 'above the question marks');
  const mk = await put(assessor, `/api/qb/attempts/${attA}/review/${written.id}`, { marks: 4, comment: 'Clear structure' });
  assert.equal(mk.status, 200, JSON.stringify(mk.body)); assert.equal(mk.body.result_status, 'final');
  const row = (await db.query(`SELECT final_score, max_score, final_pct, passed FROM attempts WHERE id=$1`, [attA])).rows[0];
  assert.equal(Number(row.final_score), Number(row.final_score)); assert.equal(row.passed, true);
  const mcq = detail.body.questions.filter(q => q.type !== 'descriptive');
  const expected = mcq.reduce((s, q, i) => s + (q.type === 'mcq' && detail.body.questions.indexOf(q) === 2 ? -0.5 : q.marks), 0) + 4;
  assert.equal(Number(row.final_score), expected);
  // not published yet -> candidate still sees nothing; then publish
  assert.equal((await get(candA.user, `/api/qb/my/attempts/${attA}/result`)).body.visible, false);
  assert.equal((await post(hr, `/api/qb/assessments/${asmId}/results`, { published: true, results_policy: 'hidden' })).status, 400);
  const pub = await post(hr, `/api/qb/assessments/${asmId}/results`, { published: true, results_policy: 'score_and_review' }); assert.equal(pub.status, 200);
  const res = await get(candA.user, `/api/qb/my/attempts/${attA}/result`);
  assert.equal(res.body.visible, true); assert.equal(res.body.score, expected); assert.equal(res.body.passed, true);
  assert.equal(res.body.review.length, 9); assert.ok(res.body.review.every(r => r.correct_answer !== undefined));
  assert.ok(res.body.review.some(r => r.explanation));
  // candidate B has not submitted: still no result
  assert.equal((await get(candB.user, `/api/qb/my/attempts/${attB}/result`)).status, 409);
  // policy "score" hides the review
  await post(hr, `/api/qb/assessments/${asmId}/results`, { published: true, results_policy: 'score' });
  assert.equal((await get(candA.user, `/api/qb/my/attempts/${attA}/result`)).body.review, undefined);
  await post(hr, `/api/qb/assessments/${asmId}/results`, { published: false });
  assert.equal((await get(candA.user, `/api/qb/my/attempts/${attA}/result`)).body.visible, false);
});

T('interruption: leaving the window blocks; saves are refused; HR reinstates; the same paper and remaining time come back', async () => {
  const keys = await keyShown(attB);
  await put(candB.user, `/api/qb/my/attempts/${attB}/responses`, { items: [{ id: keys[0].id, rev: 1, response: keys[0].shown }] });
  const ev = await post(candB.user, `/api/qb/my/attempts/${attB}/events`, { kind: 'violation', detail: 'tab hidden' });
  assert.equal(ev.body.action, 'block');
  assert.equal((await put(candB.user, `/api/qb/my/attempts/${attB}/responses`, { items: [{ id: keys[1].id, rev: 1, response: keys[1].shown }] })).body.error, 'blocked');
  assert.equal((await post(candB.user, `/api/qb/my/attempts/${attB}/submit`)).status, 409);
  const paper = await get(candB.user, `/api/qb/my/attempts/${attB}/paper`); assert.deepEqual(paper.body.questions, [], 'no questions while blocked');
  const rem = Number((await db.query(`SELECT remaining_ms FROM attempts WHERE id=$1`, [attB])).rows[0].remaining_ms); assert.ok(rem > 34 * 60000);
  assert.equal((await post(candB.user, `/api/qb/my/attempts/${attB}/request-review`)).status, 200);
  assert.equal((await post(candB.user, `/api/qb/attempts/${attB}/reinstate`, { reason: 'ok' })).status, 403, 'candidates cannot reinstate');
  assert.equal((await post(hr, `/api/qb/attempts/${attB}/reinstate`, { reason: 'x' })).status, 400, 'reason required');
  assert.equal((await post(hr, `/api/qb/attempts/${attB}/reinstate`, { reason: 'Browser crashed, verified by call' })).status, 200);
  const back = await post(candB.user, `/api/qb/my/attempts/${attB}/start`); assert.equal(back.status, 200);
  assert.deepEqual(back.body.questions, paperB.questions, 'same paper, same order');
  assert.deepEqual(back.body.answers[keys[0].id].response, keys[0].shown, 'saved answer kept');
  assert.ok(Math.abs(back.body.attempt.remaining_ms - rem) < 5000, 'remaining time preserved');
});

T('time limit: late saves are refused and the attempt closes itself with the saved answers; the sweeper does the same for absent candidates', async () => {
  const keys = await keyShown(attB);
  await put(candB.user, `/api/qb/my/attempts/${attB}/responses`, { items: keys.slice(0, 3).map(k => ({ id: k.id, rev: 5, response: k.shown })) });
  await db.query(`UPDATE attempts SET deadline_at = now() - interval '1 minute' WHERE id=$1`, [attB]);
  const late = await put(candB.user, `/api/qb/my/attempts/${attB}/responses`, { items: [{ id: keys[3].id, rev: 1, response: keys[3].shown }] });
  assert.equal(late.status, 409); assert.equal(late.body.error, 'time_expired');
  const row = (await db.query(`SELECT status, auto_score FROM attempts WHERE id=$1`, [attB])).rows[0];
  assert.equal(row.status, 'submitted'); assert.ok(Number(row.auto_score) > 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id=$1 AND kind='auto_submitted'`, [attB])).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempt_responses WHERE attempt_question_id=$1`, [keys[3].id])).rows[0].n, 0, 'the late answer was not stored');
  // absent candidate: X starts, never returns
  const attX = await attemptOf(candX); const px = await post(candX.user, `/api/qb/my/attempts/${attX}/start`);
  assert.equal(px.status, 200); assert.equal(px.body.questions.length, 9, 'role-neutral pool gives candidate X a full paper');
  await db.query(`UPDATE attempts SET deadline_at = now() - interval '2 minutes' WHERE id=$1`, [attX]);
  const swept = await att.sweepExpired(db, (a, t, i, b, af, c) => (c || db).query(`INSERT INTO audit_logs(action, entity_type, entity_id, after) VALUES ($1,$2,$3,$4)`, [a, t, String(i), af ? JSON.stringify(af) : null]));
  assert.equal(swept.closed, 1);
  assert.equal((await db.query(`SELECT status FROM attempts WHERE id=$1`, [attX])).rows[0].status, 'submitted');
  assert.equal((await att.sweepExpired(db, async () => {})).closed, 0, 'second sweep finds nothing');
});

T('reports and exports: counts, topic accuracy, CSV is formula-safe, Excel opens, history filters', async () => {
  const rep = await get(hr, `/api/qb/assessments/${asmId}/report`);
  assert.equal(rep.body.counts.assigned, 3); assert.equal(rep.body.counts.submitted, 3); assert.ok(rep.body.topics.some(t => t.topic === 'Aptitude'));
  const list = await get(hr, `/api/qb/submissions?assessment_id=${asmId}`); assert.equal(list.body.total, 3);
  assert.equal((await get(hr, `/api/qb/submissions?assessment_id=${asmId}&q=Cand%20A`)).body.total, 1);
  assert.equal((await get(hr, `/api/qb/submissions?assessment_id=${asmId}&result=pending_review`)).body.total, (await db.query(`SELECT count(*)::int AS n FROM attempts WHERE result_status='pending_review'`)).rows[0].n);
  assert.equal((await get(hr, `/api/qb/submissions?assessment_id=${asmId}&result=passed`)).body.total, 1);
  assert.equal((await get(assessor, `/api/qb/submissions`)).body.total, 1, 'assessor sees only own candidates');
  await db.query(`UPDATE candidates SET full_name='=HYPERLINK("http://evil","x")' WHERE id=$1`, [candB.candidateId]);
  const csv = await get(hr, `/api/qb/submissions/export?format=csv&assessment_id=${asmId}`);
  assert.equal(csv.status, 200); assert.ok(!csv.raw.toString().includes(',=HYPERLINK'), 'formula text is neutralised'); assert.ok(csv.raw.toString().includes("'=HYPERLINK"));
  const x = readXlsx((await get(hr, `/api/qb/submissions/export?format=xlsx&assessment_id=${asmId}`)).raw); assert.equal(x.rows.length, 4); assert.equal(x.rows[0].cells[0], 'Candidate ID');
  assert.ok(x.rows[1].cells[19].split(';').length >= 9, 'question IDs listed');
  const audit = await get(hr, '/api/qb/audit'); const actions = new Set(audit.body.items.map(i => i.action));
  for (const a of ['qb.import.commit', 'qb.assessment.publish', 'qb.paper.generate', 'qb.attempt.submit', 'qb.attempt.blocked', 'qb.results.publish', 'qb.attempt.reinstate']) assert.ok(actions.has(a), `audit has ${a}`);
});

T('cleanup', async () => { await db.end(); });
