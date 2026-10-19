'use strict';
// The candidate side: what a candidate may see, starting (which draws and stores their own paper), autosave,
// submit, results, and the sweeper that closes expired attempts. Answer keys never leave this module toward a candidate:
// presentQuestion() is the only way a question is turned into a response.
const R = require('./random');
const M = require('./marking');
const P = require('../proctoring');
const U = require('./util');

const SAVE_GRACE_MS = 5000;
const SWEEP_AFTER_MS = 15000;

const ATTEMPT_SQL = `SELECT t.id, t.status, t.attempt_no, t.started_at, t.deadline_at, t.remaining_ms, t.warnings, t.submitted_at, t.result_status, t.final_score, t.final_pct, t.passed, t.max_score, t.submit_ref, t.auto_score,
  g.id AS assignment_id, g.application_id, g.assessment_version AS assigned_version, g.due_at,
  a.id AS assessment_id, a.title, a.instructions, a.round, a.time_limit_minutes, a.pass_mark_pct, a.lock_mode, a.monitor_mode, a.status::text AS assessment_status, a.opens_at, a.closes_at, a.current_version,
  b.rules, b.shuffle_questions, b.shuffle_options, b.results_policy, b.results_published_at,
  c.user_id AS candidate_user, c.assessor_id, ap.stage::text AS stage, v.role_code
  FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id AND a.source='bank'
  JOIN assessment_blueprints b ON b.assessment_id=a.id JOIN applications ap ON ap.id=g.application_id JOIN candidates c ON c.id=ap.candidate_id JOIN vacancies v ON v.id=ap.vacancy_id
  WHERE t.id=$1`;

async function loadRow(c, id, { lock = false } = {}) {
  U.uuid(id);
  return (await c.query(`${ATTEMPT_SQL} ${lock ? 'FOR UPDATE OF t' : ''}`, [id])).rows[0] || null;
}
async function loadOwn(c, id, actor, opts) {
  const r = await loadRow(c, id, opts);
  if (!r || r.candidate_user !== actor.id) throw U.notFound();      // 404 for someone else's attempt: ids cannot be probed
  return r;
}

const toAttemptQuestion = (x, id) => ({
  id, position: x.position, option_order: x.optionOrder, marks: x.question.marks, negative_marks: x.question.negative_marks,
  snapshot: { question_text: x.question.question_text, type: x.question.type, options: x.question.options || null, correct_answer: x.question.correct_answer ?? null, reference_answer: x.question.reference_answer || null, explanation: x.question.explanation || null, topic: x.question.topic, difficulty: x.question.difficulty },
});

// ---------------------------------------------------------------- eligibility
async function eligibility(c, round, app) {
  const rs = (await c.query(`SELECT enabled, published, eligibility FROM round_settings WHERE round=$1`, [round])).rows[0];
  if (!rs || !rs.enabled) return 'This round is disabled.';
  const e = rs.eligibility || {};
  if (e.require_stage && app.stage !== `round_${round}`) return `Candidate is at stage "${app.stage}"; move them to round ${round} first (or switch off the stage rule for this round).`;
  if (e.min_previous_pct != null && round > 1) {
    const best = (await c.query(`SELECT max(t.final_pct) AS best FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id WHERE g.application_id=$1 AND a.source='bank' AND a.round=$2 AND t.result_status='final'`, [app.id, round - 1])).rows[0].best;
    if (best === null || best === undefined || Number(best) < Number(e.min_previous_pct)) return `Needs at least ${e.min_previous_pct}% in round ${round - 1} (best so far: ${best === null || best === undefined ? 'no result' : Number(best) + '%'}).`;
  }
  return null;
}

// May this (not yet started) attempt be started now? Returns null when yes, otherwise a candidate-safe reason.
async function authorised(c, row, now = Date.now()) {
  if (row.assessment_status !== 'active') return { code: 'not_available', message: 'This assessment is not open.' };
  const rs = (await c.query(`SELECT enabled, published FROM round_settings WHERE round=$1`, [row.round])).rows[0];
  if (!rs || !rs.enabled || !rs.published) return { code: 'not_available', message: 'This round is not open yet.' };
  if (row.opens_at && new Date(row.opens_at).getTime() > now) return { code: 'not_open_yet', message: `This assessment opens on ${new Date(row.opens_at).toUTCString()}.` };
  if (row.closes_at && new Date(row.closes_at).getTime() < now) return { code: 'closed', message: 'This assessment has closed.' };
  const why = await eligibility(c, Number(row.round), { id: row.application_id, stage: row.stage });
  if (why) return { code: 'not_eligible', message: 'You are not cleared for this round yet. Please contact HR.' };
  return null;
}

// ---------------------------------------------------------------- scoring / finalising
async function recompute(c, attemptId) {
  const qs = (await c.query(`SELECT q.id, q.position, q.snapshot, q.option_order, q.marks, q.negative_marks, r.response, r.manual_marks FROM attempt_questions q LEFT JOIN attempt_responses r ON r.attempt_question_id=q.id WHERE q.attempt_id=$1 ORDER BY q.position`, [attemptId])).rows;
  const pass = Number((await c.query(`SELECT a.pass_mark_pct FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id WHERE t.id=$1`, [attemptId])).rows[0].pass_mark_pct);
  const map = new Map(qs.map(q => [q.id, { response: q.response, manual_marks: q.manual_marks }]));
  const s = M.scoreAttempt(qs, map, { passPct: pass });
  const objective = M.scoreAttempt(qs, new Map(qs.map(q => [q.id, { response: q.response }])), { passPct: pass });
  for (const q of qs) {
    if (q.snapshot.type === 'descriptive' || q.response === null || q.response === undefined) continue;
    const m = M.markObjective(q, q.response);
    await c.query(`UPDATE attempt_responses SET auto_marks=$2 WHERE attempt_question_id=$1`, [q.id, m.marks]);
  }
  const final = s.resultStatus === 'final';
  await c.query(`UPDATE attempts SET max_score=$2, auto_score=$3, result_status=$4, final_score=$5, final_pct=$6, passed=$7, finalized_at=CASE WHEN $4='final' THEN coalesce(finalized_at, now()) ELSE NULL END WHERE id=$1`,
    [attemptId, s.max, Math.min(9999.99, objective.score), s.resultStatus, final ? s.score : null, final ? s.pct : null, final ? s.passed : null]);
  return s;
}

// row must be locked (FOR UPDATE). Safe to call for a submitted attempt: it does nothing.
async function submitCore(ctx, c, row, { auto, ref }) {
  if (row.status === 'submitted') return false;
  await c.query(`UPDATE attempts SET status='submitted', submitted_at=now(), remaining_ms=NULL, submit_ref=$2 WHERE id=$1`, [row.id, ref || null]);
  const s = await recompute(c, row.id);
  await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)`, [row.id, auto ? 'auto_submitted' : 'submitted', auto ? 'Time ran out' : null]);
  await ctx.audit(auto ? 'qb.attempt.auto_submit' : 'qb.attempt.submit', 'attempt', row.id, null, { score: s.score, max: s.max, result_status: s.resultStatus }, c);
  return true;
}

// ---------------------------------------------------------------- listing and instructions
async function listMine(ctx) {
  const rows = (await ctx.db.query(`SELECT t.id AS attempt_id, t.status, t.submitted_at, t.result_status, g.due_at, g.created_at AS assigned_at, a.id AS assessment_id, a.title, a.round, a.time_limit_minutes, a.opens_at, a.closes_at, a.status::text AS assessment_status, rs.name AS round_name, rs.enabled, rs.published, b.results_policy, b.results_published_at, ap.id AS application_id, ap.stage::text AS stage
      FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id AND a.source='bank' JOIN assessment_blueprints b ON b.assessment_id=a.id
      JOIN applications ap ON ap.id=g.application_id JOIN candidates c ON c.id=ap.candidate_id AND c.user_id=$1 JOIN round_settings rs ON rs.round=a.round
      ORDER BY g.created_at DESC LIMIT 100`, [ctx.actor.id])).rows;
  const current = [], completed = [];
  for (const r of rows) {
    const base = { attempt_id: r.attempt_id, title: r.title, round: Number(r.round), round_name: r.round_name, duration_minutes: Number(r.time_limit_minutes), status: r.status, due_at: r.due_at };
    if (r.status === 'submitted') {
      const shown = !!r.results_published_at && r.results_policy !== 'hidden';
      completed.push({ ...base, submitted_at: r.submitted_at, result: !shown ? 'not_published' : r.result_status === 'final' ? 'available' : 'under_review' });
    } else if (r.status === 'in_progress' || r.status === 'blocked') current.push({ ...base, state: r.status });
    else {
      const why = await authorised(ctx.db, { ...r, assessment_status: r.assessment_status, application_id: r.application_id });
      if (!why) current.push({ ...base, state: 'available' });
      else if (why.code === 'not_open_yet') current.push({ ...base, state: 'scheduled', opens_at: r.opens_at, message: why.message });
      // anything else: not authorised, so it is not shown at all
    }
  }
  return { current, completed };
}

async function info(ctx, attemptId) {
  const row = await loadOwn(ctx.db, attemptId, ctx.actor);
  const status = row.status;
  const why = status === 'ready' ? await authorised(ctx.db, row) : null;
  if (status === 'ready' && why && why.code !== 'not_open_yet') throw U.notFound();
  const left = status === 'in_progress' ? P.pxRemaining({ status, deadline_at: row.deadline_at }, Date.now()) : status === 'blocked' ? Number(row.remaining_ms) : null;
  return {
    attempt_id: row.id, status, title: row.title, instructions: row.instructions, round: Number(row.round), duration_minutes: Number(row.time_limit_minutes),
    questions: (row.rules || []).reduce((s, r) => s + Number(r.count), 0), lock_mode: row.lock_mode, monitor_mode: row.monitor_mode, max_warnings: P.MAX_WARNINGS,
    can_start: status === 'ready' && !why, message: why ? why.message : null, remaining_ms: left, server_now: new Date().toISOString(),
    review_requested: status === 'blocked' ? !!(await ctx.db.query(`SELECT review_requested_at FROM attempts WHERE id=$1`, [row.id])).rows[0].review_requested_at : false,
  };
}

// ---------------------------------------------------------------- the paper
async function payload(c, row) {
  const qs = (await c.query(`SELECT q.id, q.position, q.snapshot, q.option_order, q.marks, q.negative_marks, r.response, r.rev FROM attempt_questions q LEFT JOIN attempt_responses r ON r.attempt_question_id=q.id WHERE q.attempt_id=$1 ORDER BY q.position`, [row.id])).rows;
  const answers = {};
  let answered = 0;
  for (const q of qs) {
    if (q.rev !== null && q.rev !== undefined) answers[q.id] = { response: q.response, rev: Number(q.rev) };
    if (M.isAnswered(q, q.response)) answered++;
  }
  return {
    attempt: { id: row.id, status: row.status, deadline_at: row.deadline_at, remaining_ms: row.status === 'in_progress' ? P.pxRemaining({ status: row.status, deadline_at: row.deadline_at }, Date.now()) : Number(row.remaining_ms) || 0, server_now: new Date().toISOString(), warnings: Number(row.warnings), lock_mode: row.lock_mode, monitor_mode: row.monitor_mode, max_warnings: P.MAX_WARNINGS },
    assessment: { title: row.title, instructions: row.instructions, round: Number(row.round) },
    questions: qs.map(M.presentQuestion),
    answers, progress: { answered, total: qs.length },
  };
}

async function generatePaper(ctx, c, row) {
  const rules = row.rules;
  const topics = [...new Set(rules.map(r => String(r.topic).toLowerCase()))];
  const pool = (await c.query(`SELECT * FROM question_bank WHERE round=$1 AND status='active' AND (role_code IS NULL OR role_code=$2) AND lower(topic) = ANY($3::text[])`, [row.round, row.role_code, topics])).rows;
  const seed = R.newSeed();
  let paper;
  try { paper = R.drawPaper({ pool, rules, role: row.role_code, seed, shuffleQuestions: row.shuffle_questions, shuffleOptions: row.shuffle_options }); }
  catch (e) {
    if (e.code === 'insufficient_pool') { await ctx.audit('qb.paper.failed', 'attempt', row.id, null, { reason: e.message }, c).catch(() => {}); throw new U.ServiceError(409, 'not_ready', 'This assessment is not ready yet. Please contact HR.'); }
    throw e;
  }
  const blueprint = { rules, shuffle_questions: row.shuffle_questions, shuffle_options: row.shuffle_options, role: row.role_code, round: Number(row.round) };
  await c.query(`INSERT INTO attempt_papers(attempt_id, seed, generator_version, assessment_version, blueprint, total_marks) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [row.id, seed, paper.generatorVersion, row.current_version, JSON.stringify(blueprint), paper.totalMarks]);
  for (const x of paper.questions) {
    const aq = toAttemptQuestion(x, null);
    await c.query(`INSERT INTO attempt_questions(attempt_id, position, bank_question_id, question_code, question_version, snapshot, option_order, marks, negative_marks) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
      [row.id, aq.position, x.question.id, x.question.question_code, x.question.version, JSON.stringify(aq.snapshot), aq.option_order ? JSON.stringify(aq.option_order) : null, aq.marks, aq.negative_marks]);
  }
  await ctx.audit('qb.paper.generate', 'attempt', row.id, null, { questions: paper.questions.length, total_marks: paper.totalMarks, assessment_version: row.current_version }, c);
  return paper;
}

async function start(ctx, attemptId) {
  return ctx.db.tx(async c => {
    const row = await loadOwn(c, attemptId, ctx.actor, { lock: true });
    if (row.status === 'submitted') throw new U.ServiceError(409, 'already_submitted', 'You have already submitted this assessment.');
    if (row.status === 'blocked') throw new U.ServiceError(409, 'blocked', 'This attempt is blocked. Ask HR to review it.');
    if (row.status === 'in_progress') {
      const w = P.pxCanWrite({ status: row.status, deadline_at: row.deadline_at }, Date.now(), SAVE_GRACE_MS);
      if (!w.ok && w.reason === 'time_expired') { await submitCore(ctx, c, row, { auto: true }); throw new U.ServiceError(409, 'time_expired', 'Time is up. Your answers were submitted.'); }
      return payload(c, row);                                  // refresh / logout and come back / second device: the same paper
    }
    const why = await authorised(c, row);
    if (why) throw new U.ServiceError(why.code === 'not_open_yet' || why.code === 'closed' ? 403 : 404, why.code, why.message);
    const existing = (await c.query(`SELECT 1 FROM attempt_papers WHERE attempt_id=$1`, [row.id])).rows[0];
    if (!existing) await generatePaper(ctx, c, row);           // stored once; never regenerated
    const left = row.remaining_ms === null || row.remaining_ms === undefined ? Number(row.time_limit_minutes) * 60000 : Number(row.remaining_ms);
    const dl = P.pxResume({ status: 'ready', remaining_ms: left }, Date.now()).deadline_at;
    await c.query(`UPDATE attempts SET status='in_progress', started_at=CASE WHEN $3::boolean THEN now() ELSE started_at END, deadline_at=$2, remaining_ms=NULL WHERE id=$1`, [row.id, new Date(dl), !existing]);
    await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,'start',$2)`, [row.id, existing ? 'Resumed' : null]);
    await ctx.audit('qb.attempt.start', 'attempt', row.id, null, { resumed: !!existing }, c);
    return payload(c, { ...row, status: 'in_progress', deadline_at: new Date(dl), remaining_ms: null });
  });
}

async function getPaper(ctx, attemptId) {
  const row = await loadOwn(ctx.db, attemptId, ctx.actor);
  if (row.status === 'ready') throw new U.ServiceError(409, 'not_started', 'Start the assessment first.');
  if (row.status !== 'in_progress') return { attempt: { id: row.id, status: row.status, remaining_ms: Number(row.remaining_ms) || 0, server_now: new Date().toISOString() }, questions: [], answers: {}, progress: null };
  if (!P.pxCanWrite({ status: row.status, deadline_at: row.deadline_at }, Date.now(), SAVE_GRACE_MS).ok) {
    await ctx.db.tx(async c => { const r = await loadOwn(c, attemptId, ctx.actor, { lock: true }); if (r.status === 'in_progress') await submitCore(ctx, c, r, { auto: true }); });
    return { attempt: { id: row.id, status: 'submitted', remaining_ms: 0, server_now: new Date().toISOString() }, questions: [], answers: {}, progress: null };
  }
  return payload(ctx.db, row);
}

// ---------------------------------------------------------------- autosave
async function saveResponses(ctx, attemptId, items) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw U.bad('Send between 1 and 200 answers.');
  const pre = await loadOwn(ctx.db, attemptId, ctx.actor);
  const w0 = P.pxCanWrite({ status: pre.status, deadline_at: pre.deadline_at }, Date.now(), SAVE_GRACE_MS);
  if (!w0.ok) {
    if (w0.reason === 'time_expired') await ctx.db.tx(async c => { const r = await loadOwn(c, attemptId, ctx.actor, { lock: true }); if (r.status === 'in_progress') await submitCore(ctx, c, r, { auto: true }); });
    throw new U.ServiceError(409, w0.reason, w0.reason === 'blocked' ? 'This attempt is blocked.' : w0.reason === 'time_expired' ? 'Time is up. Your answers were submitted.' : w0.reason === 'already_submitted' ? 'Already submitted.' : 'The assessment has not started.');
  }
  return ctx.db.tx(async c => {
    const row = (await c.query(`SELECT t.id, t.status, t.deadline_at, t.warnings FROM attempts t WHERE t.id=$1 FOR SHARE`, [attemptId])).rows[0];   // waits while a submit is running
    const w = P.pxCanWrite({ status: row.status, deadline_at: row.deadline_at }, Date.now(), SAVE_GRACE_MS);
    if (!w.ok) throw new U.ServiceError(409, w.reason, 'This attempt can no longer be changed.');
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') throw U.bad('Each answer must be an object.');
      const qid = U.uuid(it.id);
      const rev = U.int(it.rev, 'rev', { min: 1, max: 1e9 });
      const aq = (await c.query(`SELECT id, snapshot, option_order FROM attempt_questions WHERE id=$1 AND attempt_id=$2`, [qid, attemptId])).rows[0];
      if (!aq) throw U.bad('Unknown question.');
      const response = M.normalizeResponse(aq, it.response === undefined ? null : it.response);
      const r = await c.query(`INSERT INTO attempt_responses(attempt_question_id, response, rev, saved_at) VALUES ($1,$2::jsonb,$3,now())
        ON CONFLICT (attempt_question_id) DO UPDATE SET response=EXCLUDED.response, rev=EXCLUDED.rev, saved_at=now() WHERE attempt_responses.rev < EXCLUDED.rev RETURNING rev`, [qid, response === null ? null : JSON.stringify(response), rev]);
      if (r.rows[0]) out.push({ id: qid, saved: true, rev });
      else { const cur = (await c.query(`SELECT rev FROM attempt_responses WHERE attempt_question_id=$1`, [qid])).rows[0]; out.push({ id: qid, saved: false, stale: true, rev: Number(cur.rev) }); }   // an older retry arrived late: the newer answer is kept
    }
    const answered = Number((await c.query(`SELECT count(*) AS n FROM attempt_responses r JOIN attempt_questions q ON q.id=r.attempt_question_id WHERE q.attempt_id=$1 AND r.response IS NOT NULL AND r.response <> 'null'::jsonb AND r.response <> '""'::jsonb AND r.response <> '[]'::jsonb`, [attemptId])).rows[0].n);
    return { saved: out, answered, server_now: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------- submit and results
async function submit(ctx, attemptId, body = {}) {
  const ref = body.ref === undefined ? null : U.str(String(body.ref), 'ref', { max: 64, optional: true });
  const res = await ctx.db.tx(async c => {
    const row = await loadOwn(c, attemptId, ctx.actor, { lock: true });
    if (row.status === 'submitted') return { row, duplicate: true };
    if (row.status === 'blocked') throw new U.ServiceError(409, 'blocked', 'This attempt is blocked. Ask HR to review it.');
    if (row.status !== 'in_progress') throw new U.ServiceError(409, 'not_started', 'The assessment has not been started.');
    const late = !P.pxCanWrite({ status: row.status, deadline_at: row.deadline_at }, Date.now(), SAVE_GRACE_MS).ok;
    await submitCore(ctx, c, row, { auto: late, ref });
    return { row: await loadRow(c, attemptId), duplicate: false, late };
  });
  return confirmation(ctx, res.row, res.duplicate);
}

async function confirmation(ctx, row, duplicate) {
  const total = Number((await ctx.db.query(`SELECT count(*) AS n FROM attempt_questions WHERE attempt_id=$1`, [row.id])).rows[0].n);
  const answered = Number((await ctx.db.query(`SELECT count(*) AS n FROM attempt_responses r JOIN attempt_questions q ON q.id=r.attempt_question_id WHERE q.attempt_id=$1 AND r.response IS NOT NULL AND r.response <> 'null'::jsonb AND r.response <> '""'::jsonb AND r.response <> '[]'::jsonb`, [row.id])).rows[0].n);
  return { status: 'submitted', submitted_at: row.submitted_at, duplicate, answered, total, message: 'Your answers have been submitted. You cannot change them now.', result: await resultFor(ctx.db, row) };
}

function visible(row) { return !!row.results_published_at && row.results_policy !== 'hidden'; }

async function resultFor(c, row) {
  if (row.status !== 'submitted') return { visible: false };
  if (!visible(row)) return { visible: false, message: 'Results will be shared by the hiring team.' };
  if (row.result_status !== 'final') return { visible: false, message: 'Your written answers are still being reviewed. Results will appear here when ready.' };
  const base = { visible: true, score: Number(row.final_score), max: Number(row.max_score), percent: Number(row.final_pct), passed: !!row.passed, pass_mark_percent: Number(row.pass_mark_pct) };
  if (row.results_policy !== 'score_and_review') return base;
  const qs = (await c.query(`SELECT q.id, q.position, q.snapshot, q.option_order, q.marks, q.negative_marks, r.response, r.manual_marks FROM attempt_questions q LEFT JOIN attempt_responses r ON r.attempt_question_id=q.id WHERE q.attempt_id=$1 ORDER BY q.position`, [row.id])).rows;
  const s = M.scoreAttempt(qs, new Map(qs.map(q => [q.id, { response: q.response, manual_marks: q.manual_marks }])), { passPct: Number(row.pass_mark_pct) });
  const per = new Map(s.perQuestion.map(p => [p.id, p]));
  base.review = qs.map(q => {
    const sn = q.snapshot;
    const key = sn.type === 'mcq' ? q.option_order.indexOf(sn.correct_answer) : sn.type === 'multi_select' ? sn.correct_answer.map(i => q.option_order.indexOf(i)).sort((a, b) => a - b) : null;
    return { position: Number(q.position), text: sn.question_text, type: sn.type, options: sn.options ? q.option_order.map(i => sn.options[i]) : null, your_answer: q.response ?? null, correct_answer: key, explanation: sn.explanation, marks_awarded: per.get(q.id).marks, marks: Number(q.marks), outcome: per.get(q.id).status };
  });
  return base;
}

async function result(ctx, attemptId) {
  const row = await loadOwn(ctx.db, attemptId, ctx.actor);
  if (row.status !== 'submitted') throw new U.ServiceError(409, 'not_submitted', 'Submit the assessment first.');
  return resultFor(ctx.db, row);
}

// ---------------------------------------------------------------- test lock events (same rules as proctoring.js)
// The browser reports that the candidate left the test window; the server decides what that means.
async function recordEvent(ctx, attemptId, body = {}) {
  const kind = U.oneOf(body.kind, 'kind', ['violation', 'note', 'monitor']);
  const detail = U.str(body.detail, 'detail', { max: 300, optional: true });
  return ctx.db.tx(async c => {
    const a = await loadOwn(c, attemptId, ctx.actor, { lock: true });
    if (kind === 'monitor') return recordMonitor(ctx, c, a, body.code, detail);
    if (kind === 'note') { await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,'note',$2)`, [a.id, detail]); return { action: 'logged', status: a.status }; }
    const r = P.pxViolation({ status: a.status, warnings: Number(a.warnings) }, a.lock_mode);
    if (r.action === 'ignore') return { action: 'ignore', status: a.status };
    await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)`, [a.id, r.action === 'block' ? 'blocked' : r.action === 'warn' ? 'warning' : 'violation', detail]);
    if (r.action === 'block') {
      const b = P.pxBlock({ status: a.status, deadline_at: a.deadline_at }, Date.now());
      await c.query(`UPDATE attempts SET status='blocked', warnings=$2, remaining_ms=$3, blocked_at=now() WHERE id=$1`, [a.id, r.warnings, b.remaining_ms]);
      await ctx.audit('qb.attempt.blocked', 'attempt', a.id, null, { detail }, c);
      return { action: 'block', status: 'blocked' };
    }
    await c.query(`UPDATE attempts SET warnings=$2 WHERE id=$1`, [a.id, r.warnings]);
    return { action: r.action, status: a.status, warnings: r.warnings, max_warnings: P.MAX_WARNINGS };
  });
}

// Camera / microphone alerts. The browser analyses video and sound on the candidate's device; only a short code arrives
// here. Nothing is recorded. "camera_lost" and "mic_lost" mean the candidate switched the device off or revoked
// permission, which counts like leaving the window (the lock mode decides: warn or block). The other codes are only
// logged for a human to review; they never fail or block anyone.
const MONITOR_INFO = { camera_on: 'Camera and microphone allowed', face_check_unavailable: 'This browser cannot count faces; only camera and sound checks run', no_face: 'No face seen for a while', multiple_faces: 'More than one face seen', camera_covered: 'Camera looks covered or very dark', loud_noise: 'Sustained loud sound', camera_lost: 'Camera switched off or permission removed', mic_lost: 'Microphone switched off or permission removed' };
const MONITOR_LOST = new Set(['camera_lost', 'mic_lost']);
async function recordMonitor(ctx, c, a, code, detail) {
  if (!Object.prototype.hasOwnProperty.call(MONITOR_INFO, code)) throw U.bad('Unknown monitoring code.');
  if (a.status !== 'in_progress') return { action: 'ignore', status: a.status };
  if (a.monitor_mode !== 'required') return { action: 'ignore', status: a.status };
  await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,'monitor',$2)`, [a.id, MONITOR_INFO[code] + (detail ? ': ' + detail : '')]);
  if (!MONITOR_LOST.has(code)) return { action: 'logged', status: a.status };
  const r = P.pxViolation({ status: a.status, warnings: Number(a.warnings) }, a.lock_mode);
  if (r.action === 'ignore' || r.action === 'log') return { action: 'logged', status: a.status };
  await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)`, [a.id, r.action === 'block' ? 'blocked' : 'warning', MONITOR_INFO[code]]);
  if (r.action === 'block') {
    const b = P.pxBlock({ status: a.status, deadline_at: a.deadline_at }, Date.now());
    await c.query(`UPDATE attempts SET status='blocked', warnings=$2, remaining_ms=$3, blocked_at=now() WHERE id=$1`, [a.id, r.warnings, b.remaining_ms]);
    await ctx.audit('qb.attempt.blocked', 'attempt', a.id, null, { detail: MONITOR_INFO[code] }, c);
    return { action: 'block', status: 'blocked' };
  }
  await c.query(`UPDATE attempts SET warnings=$2 WHERE id=$1`, [a.id, r.warnings]);
  return { action: r.action, status: a.status, warnings: r.warnings, max_warnings: P.MAX_WARNINGS };
}

async function requestReview(ctx, attemptId) {
  const a = await loadOwn(ctx.db, attemptId, ctx.actor);
  if (a.status !== 'blocked') throw new U.ServiceError(409, 'not_blocked', 'Only a blocked attempt can be sent for review.');
  await ctx.db.query(`UPDATE attempts SET review_requested_at=now() WHERE id=$1`, [a.id]);
  await ctx.audit('qb.attempt.review_requested', 'attempt', a.id);
  return { ok: true };
}

// HR or the Super Admin gives a blocked candidate the time they had left, with a written reason.
async function reinstate(ctx, attemptId, body = {}) {
  const reason = U.str(body.reason, 'reason', { min: 5, max: 500 });
  return ctx.db.tx(async c => {
    const a = await loadRow(c, attemptId, { lock: true });
    if (!a) throw U.notFound();
    if (a.status !== 'blocked') throw new U.ServiceError(409, 'not_blocked', 'Only a blocked attempt can be reinstated.');
    const cnt = Number((await c.query(`SELECT reinstated_count AS n FROM attempts WHERE id=$1`, [a.id])).rows[0].n);
    const r = P.pxReinstate({ status: a.status, reinstated_count: cnt }, Date.now(), reason);
    await c.query(`UPDATE attempts SET status='ready', warnings=0, reinstated_count=$2, reinstated_by=$3, reinstate_reason=$4 WHERE id=$1`, [a.id, r.reinstated_count, ctx.actor.id, reason]);
    await c.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,'reinstated',$2)`, [a.id, reason]);
    await ctx.audit('qb.attempt.reinstate', 'attempt', a.id, { status: 'blocked' }, { status: 'ready', reason }, c);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- sweeper
async function sweepExpired(db, auditFn, limit = 200) {
  const ids = (await db.query(`SELECT t.id FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id WHERE a.source='bank' AND t.status='in_progress' AND t.deadline_at < $1 ORDER BY t.deadline_at LIMIT ${Number(limit)}`, [new Date(Date.now() - SWEEP_AFTER_MS)])).rows;
  let closed = 0;
  for (const { id } of ids) {
    await db.tx(async c => {
      const row = await loadRow(c, id, { lock: true });
      if (row && row.status === 'in_progress') { if (await submitCore({ audit: (...a) => auditFn(...a) }, c, row, { auto: true })) closed++; }
    });
  }
  return { closed };
}

module.exports = { recordEvent, requestReview, reinstate, SAVE_GRACE_MS, toAttemptQuestion, eligibility, authorised, recompute, listMine, info, start, getPaper, saveResponses, submit, result, resultFor, sweepExpired, loadRow };
