'use strict';
// Assessments built from the bank: blueprint (counts per topic and difficulty), publishing, assigning candidates,
// submissions, manual marking, result publication, reports and exports.
const R = require('./random');
const M = require('./marking');
const A = require('./attempt');
const { writeCsv } = require('./csv');
const { writeXlsx } = require('./xlsx');
const { MIMES } = require('./templates');
const U = require('./util');

const POLICIES = ['hidden', 'score', 'score_and_review'];
const LOCKS = ['strict', 'warn', 'off'];
const ROLE_RE = /^[A-Z0-9_]{2,20}$/;

const SELECT_ASSESSMENT = `SELECT a.id, a.title, a.round, a.instructions, a.time_limit_minutes, a.pass_mark_pct, a.lock_mode, a.monitor_mode, a.opens_at, a.closes_at, a.status::text AS status, a.current_version, a.max_attempts, a.created_at,
    b.rules, b.shuffle_questions, b.shuffle_options, b.results_policy, b.results_published_at,
    (SELECT coalesce(array_agg(r.role_code ORDER BY r.role_code), '{}') FROM assessment_roles r WHERE r.assessment_id=a.id) AS roles
  FROM assessments a JOIN assessment_blueprints b ON b.assessment_id=a.id`;

function out(a) {
  return { ...a, round: Number(a.round), time_limit_minutes: Number(a.time_limit_minutes), pass_mark_pct: Number(a.pass_mark_pct), current_version: Number(a.current_version), roles: a.roles || [], rules: a.rules || [] };
}

async function poolFor(c, round) {
  return (await c.query(`SELECT question_code, topic, difficulty::text AS difficulty, role_code, status, marks FROM question_bank WHERE round=$1 AND status='active'`, [round])).rows.map(r => ({ ...r, marks: Number(r.marks) }));
}
// availability of every rule for each role the assessment targets (or for the role-neutral pool when it targets all)
function availabilityReport(pool, rules, roles) {
  const targets = roles.length ? roles : [null];
  const per = targets.map(role => ({ role, rules: R.availability(pool, rules, role) }));
  const ok = per.every(t => t.rules.every(x => x.ok));
  const est = rules.reduce((s, r) => {
    const cell = pool.filter(q => q.topic.toLowerCase() === r.topic.toLowerCase() && (r.difficulty === 'any' || q.difficulty === r.difficulty));
    const avg = cell.length ? cell.reduce((a, q) => a + q.marks, 0) / cell.length : 0;
    return s + avg * r.count;
  }, 0);
  return { ok, byRole: per, questions: rules.reduce((s, r) => s + r.count, 0), estimatedMarks: Math.round(est * 100) / 100 };
}

function readBlueprintInput(b, cur, roundDefaults) {
  const rules = b.rules === undefined ? (cur ? cur.rules : []) : b.rules;
  if (!Array.isArray(rules)) throw U.bad('Rules must be a list.');
  const clean = rules.map(r => ({ topic: r && r.topic, difficulty: (r && r.difficulty) || 'any', count: r && r.count }));
  if (clean.length) { const errs = R.validateRules(clean); if (errs.length) throw U.bad(errs.join(' '), errs.map(m => ({ path: 'rules', message: m }))); }
  let roles = b.roles === undefined ? (cur ? cur.roles : []) : b.roles;
  if (!Array.isArray(roles)) throw U.bad('Roles must be a list.');
  roles = [...new Set(roles.map(x => String(x).trim().toUpperCase()))];
  if (roles.some(x => !ROLE_RE.test(x))) throw U.bad('Roles must be role codes such as SDE.');
  const opens = b.opens_at === undefined ? (cur ? cur.opens_at : null) : U.date(b.opens_at, 'opens_at');
  const closes = b.closes_at === undefined ? (cur ? cur.closes_at : null) : U.date(b.closes_at, 'closes_at');
  if (opens && closes && new Date(closes) <= new Date(opens)) throw U.bad('The closing time must be after the opening time.');
  return {
    title: b.title === undefined && cur ? cur.title : U.str(b.title, 'title', { min: 3, max: 150 }),
    round: b.round === undefined && cur ? Number(cur.round) : U.int(b.round, 'round', { min: 1, max: 5 }),
    instructions: b.instructions === undefined && cur ? cur.instructions : U.str(b.instructions, 'instructions', { max: 4000, optional: true }),
    time_limit_minutes: b.time_limit_minutes === undefined ? (cur ? Number(cur.time_limit_minutes) : roundDefaults.duration_minutes) : U.int(b.time_limit_minutes, 'time_limit_minutes', { min: 1, max: 480 }),
    pass_mark_pct: b.pass_mark_pct === undefined ? (cur ? Number(cur.pass_mark_pct) : Number(roundDefaults.pass_threshold_pct)) : U.num(b.pass_mark_pct, 'pass_mark_pct', { min: 0, max: 100 }),
    lock_mode: b.lock_mode === undefined ? (cur ? cur.lock_mode : 'strict') : U.oneOf(b.lock_mode, 'lock_mode', LOCKS),
    monitor_mode: b.monitor_mode === undefined ? (cur ? cur.monitor_mode : 'off') : U.oneOf(b.monitor_mode, 'monitor_mode', ['off', 'required']),
    shuffle_questions: b.shuffle_questions === undefined ? (cur ? cur.shuffle_questions : true) : U.bool(b.shuffle_questions, 'shuffle_questions'),
    shuffle_options: b.shuffle_options === undefined ? (cur ? cur.shuffle_options : true) : U.bool(b.shuffle_options, 'shuffle_options'),
    results_policy: b.results_policy === undefined ? (cur ? cur.results_policy : 'hidden') : U.oneOf(b.results_policy, 'results_policy', POLICIES),
    rules: clean, roles, opens_at: opens, closes_at: closes,
  };
}

async function loadAssessment(c, id, { lock = false } = {}) {
  U.uuid(id);
  const a = (await c.query(`${SELECT_ASSESSMENT} WHERE a.id=$1 AND a.source='bank' ${lock ? 'FOR UPDATE OF a' : ''}`, [id])).rows[0];
  if (!a) throw U.notFound();
  return out(a);
}

async function listAssessments(ctx, q = {}) {
  const p = [], w = [`a.source='bank'`];
  if (q.round) { p.push(U.int(q.round, 'round', { min: 1, max: 5 })); w.push(`a.round=$${p.length}`); }
  if (q.status) { p.push(U.oneOf(q.status, 'status', ['draft', 'active', 'archived'])); w.push(`a.status=$${p.length}::assessment_status`); }
  const rows = (await ctx.db.query(`${SELECT_ASSESSMENT.replace('FROM assessments a', `, (SELECT count(*) FROM assignments g WHERE g.assessment_id=a.id)::int AS assigned, (SELECT count(*) FROM assignments g JOIN attempts t ON t.assignment_id=g.id WHERE g.assessment_id=a.id AND t.status='submitted')::int AS submitted FROM assessments a`)} WHERE ${w.join(' AND ')} ORDER BY a.created_at DESC LIMIT 200`, p)).rows;
  return { items: rows.map(out) };
}

async function getAssessment(ctx, id) {
  const a = await loadAssessment(ctx.db, id);
  const pool = await poolFor(ctx.db, a.round);
  const counts = (await ctx.db.query(`SELECT count(*)::int AS assigned, count(*) FILTER (WHERE t.status='in_progress')::int AS in_progress, count(*) FILTER (WHERE t.status='submitted')::int AS submitted FROM assignments g JOIN attempts t ON t.assignment_id=g.id WHERE g.assessment_id=$1`, [id])).rows[0];
  return { ...a, availability: a.rules.length ? availabilityReport(pool, a.rules, a.roles) : null, counts };
}

async function createAssessment(ctx, body) {
  const b = body || {};
  const round = U.int(b.round, 'round', { min: 1, max: 5 });
  return ctx.db.tx(async c => {
    const rs = (await c.query(`SELECT * FROM round_settings WHERE round=$1`, [round])).rows[0];
    const d = readBlueprintInput(b, null, rs);
    const a = (await c.query(`INSERT INTO assessments(title, type, round, instructions, time_limit_minutes, pass_mark_pct, lock_mode, monitor_mode, opens_at, closes_at, source, status, created_by, evaluation_mode)
      VALUES ($1,'Question bank test',$2,$3,$4,$5,$6,$10,$7,$8,'bank','draft',$9,'mixed') RETURNING id`, [d.title, d.round, d.instructions, d.time_limit_minutes, d.pass_mark_pct, d.lock_mode, d.opens_at, d.closes_at, ctx.actor.id, d.monitor_mode])).rows[0];
    await c.query(`INSERT INTO assessment_blueprints(assessment_id, rules, shuffle_questions, shuffle_options, results_policy, updated_by) VALUES ($1,$2::jsonb,$3,$4,$5,$6)`, [a.id, JSON.stringify(d.rules), d.shuffle_questions, d.shuffle_options, d.results_policy, ctx.actor.id]);
    for (const r of d.roles) await c.query(`INSERT INTO assessment_roles(assessment_id, role_code) VALUES ($1,$2)`, [a.id, r]);
    await ctx.audit('qb.assessment.create', 'assessment', a.id, null, { title: d.title, round: d.round, rules: d.rules, roles: d.roles }, c);
    return out(await loadAssessment(c, a.id));
  });
}

async function updateAssessment(ctx, id, body) {
  return ctx.db.tx(async c => {
    const cur = await loadAssessment(c, id, { lock: true });
    if (cur.status === 'archived') throw new U.ServiceError(409, 'archived', 'An archived assessment cannot be edited.');
    const rs = (await c.query(`SELECT * FROM round_settings WHERE round=$1`, [cur.round])).rows[0];
    const d = readBlueprintInput(body || {}, cur, rs);
    if (d.round !== cur.round) {
      const used = (await c.query(`SELECT 1 FROM assignments WHERE assessment_id=$1 LIMIT 1`, [id])).rows[0];
      if (used) throw new U.ServiceError(409, 'round_locked', 'The round cannot change after candidates have been assigned.');
    }
    const sig = x => JSON.stringify([Number(x.round), x.rules.map(r => [String(r.topic).toLowerCase(), r.difficulty, Number(r.count)]), [...x.roles].sort(), x.shuffle_questions, x.shuffle_options, Number(x.time_limit_minutes), Number(x.pass_mark_pct)]);   // key order inside jsonb is not stable, so compare normalised values
    const bump = sig(d) !== sig(cur);
    await c.query(`UPDATE assessments SET title=$2, round=$3, instructions=$4, time_limit_minutes=$5, pass_mark_pct=$6, lock_mode=$7, opens_at=$8, closes_at=$9, current_version=current_version+$10, monitor_mode=$11 WHERE id=$1`, [id, d.title, d.round, d.instructions, d.time_limit_minutes, d.pass_mark_pct, d.lock_mode, d.opens_at, d.closes_at, bump ? 1 : 0, d.monitor_mode]);
    await c.query(`UPDATE assessment_blueprints SET rules=$2::jsonb, shuffle_questions=$3, shuffle_options=$4, results_policy=$5, updated_by=$6, updated_at=now() WHERE assessment_id=$1`, [id, JSON.stringify(d.rules), d.shuffle_questions, d.shuffle_options, d.results_policy, ctx.actor.id]);
    await c.query(`DELETE FROM assessment_roles WHERE assessment_id=$1`, [id]);
    for (const r of d.roles) await c.query(`INSERT INTO assessment_roles(assessment_id, role_code) VALUES ($1,$2)`, [id, r]);
    const after = await loadAssessment(c, id);
    const pick = x => ({ title: x.title, round: x.round, rules: x.rules, roles: x.roles, time_limit_minutes: x.time_limit_minutes, pass_mark_pct: x.pass_mark_pct, lock_mode: x.lock_mode, monitor_mode: x.monitor_mode, shuffle_questions: x.shuffle_questions, shuffle_options: x.shuffle_options, results_policy: x.results_policy, version: x.current_version });
    await ctx.audit('qb.assessment.update', 'assessment', id, pick(cur), pick(after), c);
    return after;
  });
}

async function setPublished(ctx, id, action) {
  const act = U.oneOf(action, 'action', ['publish', 'unpublish', 'archive']);
  return ctx.db.tx(async c => {
    const a = await loadAssessment(c, id, { lock: true });
    if (act === 'publish') {
      if (a.status === 'active') return { status: 'active', unchanged: true };
      if (!a.rules.length) throw U.bad('Add at least one rule (topic, difficulty and count) before publishing.');
      const rs = (await c.query(`SELECT enabled FROM round_settings WHERE round=$1`, [a.round])).rows[0];
      if (!rs || !rs.enabled) throw new U.ServiceError(409, 'round_disabled', 'This round is disabled in the round settings.');
      const av = availabilityReport(await poolFor(c, a.round), a.rules, a.roles);
      if (!av.ok) {
        const short = av.byRole.flatMap(t => t.rules.filter(x => !x.ok).map(x => `${x.topic}/${x.difficulty}${t.role ? ' for ' + t.role : ''}: need ${x.count}, have ${x.available}`));
        throw new U.ServiceError(409, 'insufficient_pool', 'The bank does not have enough active questions: ' + short.join('; ') + '.', { shortfalls: short });
      }
    } else if (act === 'unpublish') {
      if (a.status !== 'active') throw new U.ServiceError(409, 'not_active', 'The assessment is not published.');
      const live = Number((await c.query(`SELECT count(*) AS n FROM assignments g JOIN attempts t ON t.assignment_id=g.id WHERE g.assessment_id=$1 AND t.status IN ('in_progress','blocked')`, [id])).rows[0].n);
      if (live) throw new U.ServiceError(409, 'in_use', `${live} candidate(s) are in the middle of this test. Wait until they finish, then unpublish.`);
    }
    const to = act === 'publish' ? 'active' : act === 'unpublish' ? 'draft' : 'archived';
    await c.query(`UPDATE assessments SET status=$2::assessment_status WHERE id=$1`, [id, to]);
    await ctx.audit(`qb.assessment.${act}`, 'assessment', id, { status: a.status }, { status: to, version: a.current_version }, c);
    return { status: to };
  });
}

// one sample paper, for the admin to see what a candidate would get. Nothing is stored.
async function previewPaper(ctx, id, query = {}) {
  const a = await loadAssessment(ctx.db, id);
  if (!a.rules.length) throw U.bad('Add at least one rule first.');
  const role = query.role ? String(query.role).toUpperCase() : (a.roles[0] || null);
  const rows = (await ctx.db.query(`SELECT * FROM question_bank WHERE round=$1 AND status='active'`, [a.round])).rows;
  const paper = R.drawPaper({ pool: rows, rules: a.rules, role, seed: R.newSeed(), shuffleQuestions: a.shuffle_questions, shuffleOptions: a.shuffle_options });
  const items = paper.questions.map(x => {
    const aq = A.toAttemptQuestion(x, 'preview');
    return { ...M.presentQuestion({ ...aq, id: x.question.question_code }), code: x.question.question_code, topic: x.question.topic, difficulty: x.question.difficulty, correct: aq.snapshot.type === 'mcq' ? aq.option_order.indexOf(aq.snapshot.correct_answer) : aq.snapshot.type === 'multi_select' ? aq.snapshot.correct_answer.map(i => aq.option_order.indexOf(i)).sort() : null };
  });
  return { role, totalMarks: paper.totalMarks, questions: items, note: 'Preview only. Marked "correct" positions are visible to admins and never sent to candidates.' };
}

// ---------------------------------------------------------------- assigning
async function assign(ctx, id, body) {
  const ids = body && body.application_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw U.bad('Choose between 1 and 500 candidates.');
  ids.forEach(i => U.uuid(i));
  const dueAt = U.date(body.due_at, 'due_at');
  const a = await loadAssessment(ctx.db, id);
  if (a.status !== 'active') throw new U.ServiceError(409, 'not_published', 'Publish the assessment before assigning candidates.');
  const results = [];
  for (const appId of [...new Set(ids)]) {
    try {
      const r = await ctx.db.tx(async c => {
        const ap = (await c.query(`SELECT ap.id, ap.stage::text AS stage, v.role_code, cd.full_name FROM applications ap JOIN vacancies v ON v.id=ap.vacancy_id JOIN candidates cd ON cd.id=ap.candidate_id WHERE ap.id=$1 AND cd.deleted_at IS NULL`, [appId])).rows[0];
        if (!ap) return { status: 'not_found', reason: 'Application not found.' };
        if (a.roles.length && !a.roles.includes(ap.role_code)) return { status: 'ineligible', reason: `This assessment is for ${a.roles.join(', ')}; the candidate applied for ${ap.role_code || 'another role'}.` };
        const why = await A.eligibility(c, a.round, ap);
        if (why) return { status: 'ineligible', reason: why };
        const g = (await c.query(`INSERT INTO assignments(assessment_id, assessment_version, application_id, assigned_by, due_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (assessment_id, application_id) DO NOTHING RETURNING id`, [id, a.current_version, appId, ctx.actor.id, dueAt])).rows[0];
        if (!g) return { status: 'already_assigned' };
        const t = (await c.query(`INSERT INTO attempts(assignment_id, attempt_no, status) VALUES ($1,1,'ready') RETURNING id`, [g.id])).rows[0];
        return { status: 'assigned', attempt_id: t.id };
      });
      results.push({ application_id: appId, ...r });
    } catch (e) { results.push({ application_id: appId, status: 'error', reason: 'Could not assign this candidate.' }); console.error('assign failed', e.message); }
  }
  const n = results.filter(r => r.status === 'assigned').length;
  await ctx.audit('qb.assessment.assign', 'assessment', id, null, { requested: ids.length, assigned: n, version: a.current_version });
  return { assigned: n, results };
}

// ---------------------------------------------------------------- submissions
function submissionFilter(q, actor) {
  const p = [], w = [`a.source='bank'`];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  if (q.assessment_id) add('a.id = ?', U.uuid(q.assessment_id));
  if (q.round) add('a.round = ?', U.int(q.round, 'round', { min: 1, max: 5 }));
  if (q.status) add('t.status = ?', U.oneOf(q.status, 'status', ['ready', 'in_progress', 'blocked', 'submitted']));
  if (q.result === 'passed') w.push('t.passed IS TRUE');
  else if (q.result === 'failed') w.push('t.passed IS FALSE');
  else if (q.result === 'pending_review') w.push(`t.result_status = 'pending_review'`);
  if (q.q) { p.push(`%${U.likeEscape(String(q.q).slice(0, 100))}%`); w.push(`(c.full_name ILIKE $${p.length} OR c.email ILIKE $${p.length} OR c.candidate_code ILIKE $${p.length})`); }
  if (q.from) add('coalesce(t.submitted_at, g.created_at) >= ?', U.date(q.from, 'from'));
  if (q.to) add('coalesce(t.submitted_at, g.created_at) < ?', U.date(q.to, 'to'));
  if (actor.role !== 'super_admin' && actor.role !== 'hr_admin') add('c.assessor_id = ?', actor.id);   // assessors see only their own candidates
  return { where: w.join(' AND '), p };
}
const SUB_FROM = `FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id JOIN applications ap ON ap.id=g.application_id JOIN candidates c ON c.id=ap.candidate_id JOIN vacancies v ON v.id=ap.vacancy_id LEFT JOIN attempt_papers pp ON pp.attempt_id=t.id`;
const SUB_COLS = `t.id AS attempt_id, t.status AS attempt_status, t.attempt_no, t.started_at, t.submitted_at, t.warnings, (SELECT count(*) FROM attempt_events e WHERE e.attempt_id=t.id AND e.kind='monitor')::int AS monitor_flags, t.max_score, t.final_score, t.final_pct, t.passed, t.result_status, t.auto_score,
  c.id AS candidate_id, c.candidate_code, c.full_name, c.email, v.role_code, ap.id AS application_id, ap.stage::text AS stage,
  a.id AS assessment_id, a.title AS assessment_title, a.round, g.created_at AS assigned_at, g.assessment_version, pp.generated_at AS paper_generated_at, pp.assessment_version AS paper_version`;

async function listSubmissions(ctx, q = {}) {
  const pg = U.page(q);
  const { where, p } = submissionFilter(q, ctx.actor);
  const total = Number((await ctx.db.query(`SELECT count(*) AS n ${SUB_FROM} WHERE ${where}`, p)).rows[0].n);
  const rows = (await ctx.db.query(`SELECT ${SUB_COLS} ${SUB_FROM} WHERE ${where} ORDER BY coalesce(t.submitted_at, g.created_at) DESC, t.id LIMIT ${pg.per} OFFSET ${pg.offset}`, p)).rows;
  return { items: rows.map(subOut), total, page: pg.page, per: pg.per };
}
const subOut = r => ({ ...r, round: Number(r.round), max_score: r.max_score === null ? null : Number(r.max_score), final_score: r.final_score === null ? null : Number(r.final_score), final_pct: r.final_pct === null ? null : Number(r.final_pct), auto_score: r.auto_score === null ? null : Number(r.auto_score) });

async function attemptDetail(ctx, attemptId) {
  U.uuid(attemptId);
  const row = (await ctx.db.query(`SELECT ${SUB_COLS}, c.assessor_id, t.deadline_at, t.remaining_ms, pp.seed, pp.generator_version, pp.blueprint, pp.total_marks ${SUB_FROM} WHERE t.id=$1`, [attemptId])).rows[0];
  if (!row || (!['super_admin', 'hr_admin'].includes(ctx.actor.role) && row.assessor_id !== ctx.actor.id)) throw U.notFound();
  const qs = (await ctx.db.query(`SELECT q.id, q.position, q.question_code, q.question_version, q.snapshot, q.option_order, q.marks, q.negative_marks, r.response, r.manual_marks, r.auto_marks, r.review_comment, r.reviewed_at, r.saved_at FROM attempt_questions q LEFT JOIN attempt_responses r ON r.attempt_question_id=q.id WHERE q.attempt_id=$1 ORDER BY q.position`, [attemptId])).rows;
  const events = (await ctx.db.query(`SELECT kind, detail, created_at FROM attempt_events WHERE attempt_id=$1 ORDER BY created_at, id`, [attemptId])).rows;
  const isAdmin = ['super_admin', 'hr_admin'].includes(ctx.actor.role);
  return {
    ...subOut(row), deadline_at: row.deadline_at, events,
    paper: row.seed ? { generator_version: row.generator_version, assessment_version: row.paper_version, generated_at: row.paper_generated_at, total_marks: Number(row.total_marks), ...(isAdmin ? { seed: row.seed } : {}) } : null,
    questions: qs.map(q => {
      const s = q.snapshot, shown = s.options ? q.option_order.map(i => s.options[i]) : null;
      const key = s.type === 'mcq' ? q.option_order.indexOf(s.correct_answer) : s.type === 'multi_select' ? s.correct_answer.map(i => q.option_order.indexOf(i)).sort((a, b) => a - b) : null;
      return { id: q.id, position: Number(q.position), code: q.question_code, version: Number(q.question_version), type: s.type, topic: s.topic, difficulty: s.difficulty, text: s.question_text, options: shown, option_order: q.option_order, correct: key, reference_answer: s.reference_answer || null, marks: Number(q.marks), negative_marks: Number(q.negative_marks), response: q.response, auto_marks: q.auto_marks === null ? null : Number(q.auto_marks), manual_marks: q.manual_marks === null ? null : Number(q.manual_marks), review_comment: q.review_comment, saved_at: q.saved_at };
    }),
  };
}

async function reviewResponse(ctx, attemptId, aqId, body) {
  U.uuid(attemptId); U.uuid(aqId);
  return ctx.db.tx(async c => {
    const t = (await c.query(`SELECT t.id, t.status, t.result_status, c.assessor_id FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id AND a.source='bank' JOIN applications ap ON ap.id=g.application_id JOIN candidates c ON c.id=ap.candidate_id WHERE t.id=$1 FOR UPDATE OF t`, [attemptId])).rows[0];
    if (!t || (!['super_admin', 'hr_admin'].includes(ctx.actor.role) && t.assessor_id !== ctx.actor.id)) throw U.notFound();
    if (t.status !== 'submitted') throw new U.ServiceError(409, 'not_submitted', 'Only a submitted attempt can be marked.');
    const aq = (await c.query(`SELECT id, snapshot, marks FROM attempt_questions WHERE id=$1 AND attempt_id=$2`, [aqId, attemptId])).rows[0];
    if (!aq || aq.snapshot.type !== 'descriptive') throw U.notFound();
    const marks = M.validateManualMarks(aq, body && body.marks);
    const comment = U.str(body && body.comment, 'comment', { max: 1000, optional: true });
    const before = (await c.query(`SELECT manual_marks FROM attempt_responses WHERE attempt_question_id=$1`, [aqId])).rows[0];
    await c.query(`INSERT INTO attempt_responses(attempt_question_id, response, rev, manual_marks, reviewer_id, reviewed_at, review_comment) VALUES ($1,NULL,0,$2,$3,now(),$4) ON CONFLICT (attempt_question_id) DO UPDATE SET manual_marks=EXCLUDED.manual_marks, reviewer_id=EXCLUDED.reviewer_id, reviewed_at=now(), review_comment=EXCLUDED.review_comment`, [aqId, marks, ctx.actor.id, comment]);
    const res = await A.recompute(c, attemptId);
    await ctx.audit('qb.attempt.review', 'attempt', attemptId, { manual_marks: before ? before.manual_marks : null }, { question: aqId, manual_marks: marks, result_status: res.resultStatus, score: res.score }, c);
    return { result_status: res.resultStatus, score: res.score, max: res.max, pct: res.pct, passed: res.resultStatus === 'final' ? res.passed : null };
  });
}

// ---------------------------------------------------------------- results publication, reports, exports
async function publishResults(ctx, id, body) {
  const pub = U.bool(body && body.published, 'published');
  return ctx.db.tx(async c => {
    const a = await loadAssessment(c, id, { lock: true });
    const policy = body.results_policy === undefined ? a.results_policy : U.oneOf(body.results_policy, 'results_policy', POLICIES);
    if (pub && policy === 'hidden') throw U.bad('Choose "score" or "score and review" before publishing results to candidates.');
    await c.query(`UPDATE assessment_blueprints SET results_policy=$2, results_published_at=CASE WHEN $3::boolean THEN coalesce(results_published_at, now()) ELSE NULL END, updated_by=$4, updated_at=now() WHERE assessment_id=$1`, [id, policy, pub, ctx.actor.id]);
    const pending = Number((await c.query(`SELECT count(*) AS n FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.assessment_id=$1 AND t.result_status='pending_review'`, [id])).rows[0].n);
    await ctx.audit(pub ? 'qb.results.publish' : 'qb.results.unpublish', 'assessment', id, { policy: a.results_policy, published: !!a.results_published_at }, { policy, published: pub, pending_review: pending }, c);
    return { published: pub, results_policy: policy, pending_review: pending };
  });
}

async function report(ctx, id) {
  const a = await loadAssessment(ctx.db, id);
  const rows = (await ctx.db.query(`SELECT t.id, t.status, t.final_pct, t.passed, t.result_status, t.warnings FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.assessment_id=$1`, [id])).rows;
  const by = s => rows.filter(r => r.status === s).length;
  const fin = rows.filter(r => r.result_status === 'final');
  const pcts = fin.map(r => Number(r.final_pct));
  const topics = new Map();
  const qr = (await ctx.db.query(`SELECT q.id, q.snapshot, q.option_order, q.marks, q.negative_marks, r.response FROM attempt_questions q JOIN attempts t ON t.id=q.attempt_id JOIN assignments g ON g.id=t.assignment_id LEFT JOIN attempt_responses r ON r.attempt_question_id=q.id WHERE g.assessment_id=$1 AND t.status='submitted'`, [id])).rows;
  for (const q of qr) {
    if (q.snapshot.type === 'descriptive') continue;
    const t = topics.get(q.snapshot.topic) || { topic: q.snapshot.topic, asked: 0, answered: 0, correct: 0 };
    const m = M.markObjective(q, q.response);
    t.asked++; if (m.correct !== null) t.answered++; if (m.correct) t.correct++;
    topics.set(q.snapshot.topic, t);
  }
  const submitted = by('submitted');
  const round1 = n => Math.round(n * 10) / 10;
  return {
    assessment: { id: a.id, title: a.title, round: a.round, status: a.status, version: a.current_version },
    counts: { assigned: rows.length, not_started: by('ready'), in_progress: by('in_progress'), blocked: by('blocked'), submitted, pending_review: rows.filter(r => r.result_status === 'pending_review').length, completed_with_result: fin.length },
    completion_rate: rows.length ? round1(submitted / rows.length * 100) : 0,
    scores: fin.length ? { average_pct: round1(pcts.reduce((s, x) => s + x, 0) / pcts.length), highest_pct: Math.max(...pcts), lowest_pct: Math.min(...pcts), passed: fin.filter(r => r.passed).length, failed: fin.filter(r => !r.passed).length, pass_rate: round1(fin.filter(r => r.passed).length / fin.length * 100) } : null,
    topics: [...topics.values()].map(t => ({ ...t, accuracy_pct: t.asked ? round1(t.correct / t.asked * 100) : 0 })).sort((x, y) => x.topic < y.topic ? -1 : 1),
    flagged: rows.filter(r => Number(r.warnings) > 0).length,
  };
}

const EXPORT_COLS = [['candidate_code', 'Candidate ID'], ['full_name', 'Name'], ['email', 'Email'], ['role_code', 'Role'], ['assessment_title', 'Assessment'], ['round', 'Round'], ['assessment_version', 'Assignment version'], ['assigned_at', 'Assigned at'], ['paper_version', 'Paper version'], ['paper_generated_at', 'Paper generated at'], ['attempt_status', 'Attempt status'], ['started_at', 'Started at'], ['submitted_at', 'Submitted at'], ['warnings', 'Lock warnings'], ['final_score', 'Score'], ['max_score', 'Max score'], ['final_pct', 'Percent'], ['passed', 'Passed'], ['result_status', 'Result status'], ['question_ids', 'Question IDs']];
async function exportSubmissions(ctx, q = {}) {
  const format = U.oneOf(q.format || 'xlsx', 'format', ['csv', 'xlsx']);
  const { where, p } = submissionFilter(q, ctx.actor);
  const rows = (await ctx.db.query(`SELECT ${SUB_COLS}, (SELECT string_agg(x.question_code, ';' ORDER BY x.position) FROM attempt_questions x WHERE x.attempt_id=t.id) AS question_ids ${SUB_FROM} WHERE ${where} ORDER BY a.round, a.title, c.full_name LIMIT 20000`, p)).rows;
  const fmt = (k, v) => v === null || v === undefined ? '' : k === 'passed' ? (v ? 'Yes' : 'No') : /_at$/.test(k) ? new Date(v).toISOString() : (k === 'final_score' || k === 'max_score' || k === 'final_pct') ? Number(v) : v;
  const head = EXPORT_COLS.map(c => c[1]);
  const data = rows.map(r => EXPORT_COLS.map(([k]) => fmt(k, r[k])));
  await ctx.audit('qb.results.export', 'assessment', q.assessment_id || 'all', null, { rows: rows.length, format });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') return { body: Buffer.from(writeCsv([head, ...data]), 'utf8'), mime: MIMES.csv, fileName: `semil-results-${stamp}.csv` };
  return { body: writeXlsx([{ name: 'Results', rows: [head, ...data], widths: head.map((h, i) => (i === 2 ? 30 : i === 4 ? 30 : i === 19 ? 50 : 16)) }]), mime: MIMES.xlsx, fileName: `semil-results-${stamp}.xlsx` };
}

async function auditTrail(ctx, q = {}) {
  const pg = U.page(q, { per: 50 });
  const p = [], w = [`l.action LIKE 'qb.%'`];
  if (q.entity_type) { p.push(String(q.entity_type).slice(0, 40)); w.push(`l.entity_type=$${p.length}`); }
  if (q.entity_id) { p.push(String(q.entity_id).slice(0, 80)); w.push(`l.entity_id=$${p.length}`); }
  if (q.action) { p.push(`${U.likeEscape(String(q.action).slice(0, 40))}%`); w.push(`l.action LIKE $${p.length}`); }
  const rows = (await ctx.db.query(`SELECT l.id, l.action, l.entity_type, l.entity_id, l.before, l.after, l.created_at, l.actor_role::text AS actor_role, u.full_name AS actor FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE ${w.join(' AND ')} ORDER BY l.id DESC LIMIT ${pg.per} OFFSET ${pg.offset}`, p)).rows;
  return { items: rows, page: pg.page };
}

module.exports = { listAssessments, getAssessment, createAssessment, updateAssessment, setPublished, previewPaper, assign, listSubmissions, attemptDetail, reviewResponse, publishResults, report, exportSubmissions, auditTrail, loadAssessment, availabilityReport, poolFor };
