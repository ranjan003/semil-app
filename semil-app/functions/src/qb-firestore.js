'use strict';
// Question Bank and Assessment Engine.
//
// The API is deliberately defensive about document shape: assessments and questions can
// come from the current UI, from older versions of the app, or from the RTDB fallback.
// Every route normalises what it reads and what it writes, so a missing optional field can
// never crash a page or silently drop options/answers.
const crypto = require('node:crypto');
const { z } = require('zod');
const { db, FieldValue, nextQuestionCode, audit, docData, queryData, sortBy, toIso } = require('./firestore-db');
const perms = require('./permissions');

// Reuse the existing format readers from the original backend so CSV, Excel and Word
// uploads keep working without adding a parsing dependency.
let parseCsv, readXlsx, readDocx;
try {
  ({ parseCsv } = require('../../src/qb/csv'));
  ({ readXlsx } = require('../../src/qb/xlsx'));
  ({ readDocx } = require('../../src/qb/docx'));
} catch (err) {
  console.warn('[qb] import parsers are unavailable:', err.message);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const Q_TYPES = ['mcq', 'multi_select', 'descriptive'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const ROUND_COUNT = 5;

const DEFAULT_ROUNDS = [
  { round: 1, name: 'Skills-Based Shortlisting', duration_minutes: 45, pass_threshold_pct: 50 },
  { round: 2, name: 'Group Project Development', duration_minutes: 60, pass_threshold_pct: 50 },
  { round: 3, name: 'Mindset and Reasoning Assessment', duration_minutes: 45, pass_threshold_pct: 50 },
  { round: 4, name: 'Individual Practical Creation', duration_minutes: 90, pass_threshold_pct: 60 },
  { round: 5, name: 'HR and Founder Interview', duration_minutes: 45, pass_threshold_pct: 50 },
];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function asArray(value) {
  if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function cleanDoc(data) {
  if (!data) return {};
  // The RTDB adapter stores sub-collections as nested objects; they are not document fields.
  const { versions, documents, applications, events, evaluations, stageChanges, ...rest } = data;
  return rest;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
function normaliseQuestion(raw) {
  const d = cleanDoc(raw || {});
  const type = Q_TYPES.includes(d.type) ? d.type : (Q_TYPES.includes(d.question_type) ? d.question_type : 'mcq');
  let options = Array.isArray(d.options) ? d.options : [];
  if (!options.length) options = [d.option_a, d.option_b, d.option_c, d.option_d];
  options = options.map(o => (o === null || o === undefined ? '' : String(o))).filter(o => o.trim() !== '');

  let correct = d.correct_answer !== undefined ? d.correct_answer : d.correctAnswer;
  if (type === 'mcq') {
    if (typeof correct === 'string') {
      const t = correct.trim().toUpperCase();
      if (/^[A-Z]$/.test(t)) correct = LETTERS.indexOf(t);
      else if (/^\d+$/.test(t)) correct = Number(t);
      else correct = null;
    }
    if (typeof correct !== 'number' || !Number.isInteger(correct)) correct = null;
  } else if (type === 'multi_select') {
    if (typeof correct === 'string') correct = correct.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).map(l => LETTERS.indexOf(l)).filter(i => i >= 0);
    else if (Array.isArray(correct)) correct = correct.map(v => (typeof v === 'string' ? LETTERS.indexOf(v.trim().toUpperCase()) : Number(v))).filter(i => Number.isInteger(i) && i >= 0);
    else correct = correct === null || correct === undefined ? [] : [Number(correct)].filter(i => Number.isInteger(i) && i >= 0);
    correct = [...new Set(correct)].sort((a, b) => a - b);
  } else {
    correct = null;
  }

  return {
    ...d,
    question_code: d.question_code || d.questionCode || '',
    question_text: d.question_text || d.questionText || d.text || '',
    type,
    options,
    correct_answer: correct,
    reference_answer: d.reference_answer || d.referenceAnswer || (type === 'descriptive' ? (typeof d.correct_answer === 'string' ? d.correct_answer : null) : null),
    explanation: d.explanation || null,
    difficulty: DIFFICULTIES.includes(d.difficulty) ? d.difficulty : 'medium',
    role_code: d.role_code || d.roleCode || d.job_role || null,
    round: clamp(num(d.round, 1), 1, ROUND_COUNT),
    topic: d.topic || d.category || 'General',
    marks: num(d.marks, 1),
    negative_marks: num(d.negative_marks !== undefined ? d.negative_marks : d.negativeMarks, 0),
    shuffle_options: d.shuffle_options !== undefined ? !!d.shuffle_options : true,
    status: ['active', 'inactive', 'archived'].includes(d.status) ? d.status : 'active',
    version: num(d.version, 1),
    created_at: d.created_at || d.createdAt || null,
    updated_at: d.updated_at || d.updatedAt || null,
  };
}

// Convert the editor payload (option_a..d, correct_answer="B") into the stored shape
// (options array, correct_answer=1).
function questionFromBody(body) {
  const b = body || {};
  const type = Q_TYPES.includes(b.type) ? b.type : (Q_TYPES.includes(b.question_type) ? b.question_type : 'mcq');
  let options = Array.isArray(b.options) ? b.options : [b.option_a, b.option_b, b.option_c, b.option_d];
  options = options.map(o => (o === null || o === undefined ? '' : String(o).trim())).filter(Boolean);

  let correct = b.correct_answer;
  if (type === 'mcq') {
    if (typeof correct === 'string') {
      const t = correct.trim().toUpperCase();
      if (/^[A-Z]$/.test(t)) correct = LETTERS.indexOf(t);
      else if (/^\d+$/.test(t)) correct = Number(t);
      else correct = null;
    }
    if (typeof correct !== 'number' || !Number.isInteger(correct)) correct = null;
  } else if (type === 'multi_select') {
    if (typeof correct === 'string') correct = correct.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).map(l => LETTERS.indexOf(l)).filter(i => i >= 0);
    else if (Array.isArray(correct)) correct = correct.map(v => (typeof v === 'string' ? LETTERS.indexOf(v.trim().toUpperCase()) : Number(v))).filter(i => Number.isInteger(i) && i >= 0);
    else correct = [];
    correct = [...new Set(correct)].sort((a, b) => a - b);
  } else {
    correct = null;
  }

  return {
    question_text: String(b.question_text || '').trim(),
    type,
    options,
    correct_answer: correct,
    reference_answer: b.reference_answer || (type === 'descriptive' && typeof b.correct_answer === 'string' ? b.correct_answer : null),
    explanation: b.explanation ? String(b.explanation) : null,
    difficulty: DIFFICULTIES.includes(b.difficulty) ? b.difficulty : 'medium',
    role_code: b.role_code || b.job_role ? String(b.role_code || b.job_role).trim().toUpperCase() : null,
    round: clamp(num(b.round, 1), 1, ROUND_COUNT),
    topic: String(b.topic || b.category || 'General').trim() || 'General',
    marks: num(b.marks, 1),
    negative_marks: type === 'descriptive' ? 0 : Math.max(0, num(b.negative_marks, 0)),
    shuffle_options: b.shuffle_options !== undefined ? !!b.shuffle_options : true,
    status: ['active', 'inactive', 'archived'].includes(b.status) ? b.status : 'active',
  };
}

function validateQuestion(q) {
  const fields = [];
  if (!q.question_text || q.question_text.length < 3) fields.push({ path: 'question_text', message: 'Enter the question text.' });
  if (!Q_TYPES.includes(q.type)) fields.push({ path: 'question_type', message: 'Choose a question type.' });
  if (!DIFFICULTIES.includes(q.difficulty)) fields.push({ path: 'difficulty', message: 'Choose a difficulty.' });
  if (!(q.marks > 0)) fields.push({ path: 'marks', message: 'Marks must be greater than zero.' });
  if (q.round < 1 || q.round > ROUND_COUNT) fields.push({ path: 'round', message: 'Choose a round from 1 to 5.' });

  if (q.type === 'mcq' || q.type === 'multi_select') {
    if (q.options.length < 2) fields.push({ path: 'options', message: 'Add at least two answer options.' });
    if (q.type === 'mcq' && (!Number.isInteger(q.correct_answer) || q.correct_answer < 0 || q.correct_answer >= q.options.length)) {
      fields.push({ path: 'correct_answer', message: 'Choose the correct answer.' });
    }
    if (q.type === 'multi_select') {
      if (!q.correct_answer.length) fields.push({ path: 'correct_answer', message: 'Choose at least two correct answers.' });
      else if (q.correct_answer.length < 2) fields.push({ path: 'correct_answer', message: 'Choose at least two correct answers.' });
      if (q.correct_answer.some(i => i < 0 || i >= q.options.length)) fields.push({ path: 'correct_answer', message: 'A correct answer is outside the option list.' });
    }
  }
  return fields;
}

function flatQuestion(q) {
  const type = q.type || 'mcq';
  const opts = q.options || [];
  let correct = q.correct_answer;
  if (type === 'mcq') correct = Number.isInteger(correct) ? (LETTERS[correct] || '') : '';
  else if (type === 'multi_select') correct = (Array.isArray(correct) ? correct : []).map(i => LETTERS[i] || '').filter(Boolean).join(',');
  else correct = q.reference_answer || '';
  return {
    question_text: q.question_text || '',
    question_type: type,
    option_a: opts[0] || '',
    option_b: opts[1] || '',
    option_c: opts[2] || '',
    option_d: opts[3] || '',
    correct_answer: correct,
    explanation: q.explanation || '',
    difficulty: q.difficulty || 'medium',
    job_role: q.role_code || '',
    round: q.round || 1,
    topic: q.topic || '',
    marks: q.marks ?? 1,
    negative_marks: q.negative_marks ?? 0,
    status: q.status || 'active',
  };
}

// ---------------------------------------------------------------------------
// Assessments / rounds
// ---------------------------------------------------------------------------
function normaliseRule(rule) {
  const r = rule || {};
  return {
    topic: String(r.topic || '').trim(),
    difficulty: DIFFICULTIES.includes(r.difficulty) ? r.difficulty : 'any',
    count: clamp(num(r.count, 1), 1, 200),
  };
}

function normaliseAssessment(raw, roundSettings = {}) {
  const a = cleanDoc(raw || {});
  const rules = Array.isArray(a.rules) ? a.rules.map(normaliseRule).filter(r => r.topic) : [];
  const roles = asArray(a.roles !== undefined ? a.roles : (a.roleCodes || a.role_codes));
  const round = clamp(num(a.round, 1), 1, ROUND_COUNT);
  const settings = roundSettings[round] || DEFAULT_ROUNDS[round - 1] || {};
  return {
    ...a,
    title: a.title || 'Untitled Assessment',
    round,
    source: a.source || 'bank',
    status: a.status || 'draft',
    current_version: num(a.current_version !== undefined ? a.current_version : a.currentVersion, 1),
    roles,
    rules,
    time_limit_minutes: clamp(num(a.time_limit_minutes !== undefined ? a.time_limit_minutes : a.timeLimitMinutes, settings.duration_minutes || 45), 1, 480),
    pass_mark_pct: clamp(num(a.pass_mark_pct !== undefined ? a.pass_mark_pct : a.passMarkPct, settings.pass_threshold_pct || 50), 0, 100),
    lock_mode: ['strict', 'warn', 'off'].includes(a.lock_mode || a.lockMode) ? (a.lock_mode || a.lockMode) : 'strict',
    monitor_mode: ['off', 'required'].includes(a.monitor_mode || a.monitorMode) ? (a.monitor_mode || a.monitorMode) : 'off',
    shuffle_questions: a.shuffle_questions !== undefined ? !!a.shuffle_questions : true,
    shuffle_options: a.shuffle_options !== undefined ? !!a.shuffle_options : true,
    results_policy: ['hidden', 'score', 'score_and_review'].includes(a.results_policy) ? a.results_policy : 'hidden',
    instructions: a.instructions || '',
    opens_at: a.opens_at || a.opensAt || null,
    closes_at: a.closes_at || a.closesAt || null,
    assigned: num(a.assigned, 0),
    submitted: num(a.submitted, 0),
    created_at: a.created_at || a.createdAt || null,
    updated_at: a.updated_at || a.updatedAt || null,
    results_published: !!a.results_published,
    results_published_at: a.results_published_at || (a.results_published ? (a.results_published_at || a.updated_at || null) : null),
  };
}

function assessmentFromBody(body) {
  const b = body || {};
  return {
    title: String(b.title || '').trim(),
    round: clamp(num(b.round, 1), 1, ROUND_COUNT),
    roles: asArray(b.roles),
    rules: (Array.isArray(b.rules) ? b.rules : []).map(normaliseRule).filter(r => r.topic),
    time_limit_minutes: b.time_limit_minutes === null || b.time_limit_minutes === undefined || b.time_limit_minutes === '' ? null : clamp(num(b.time_limit_minutes, 45), 1, 480),
    pass_mark_pct: b.pass_mark_pct === null || b.pass_mark_pct === undefined || b.pass_mark_pct === '' ? null : clamp(num(b.pass_mark_pct, 50), 0, 100),
    lock_mode: ['strict', 'warn', 'off'].includes(b.lock_mode) ? b.lock_mode : 'strict',
    monitor_mode: ['off', 'required'].includes(b.monitor_mode) ? b.monitor_mode : 'off',
    shuffle_questions: b.shuffle_questions !== false,
    shuffle_options: b.shuffle_options !== false,
    results_policy: ['hidden', 'score', 'score_and_review'].includes(b.results_policy) ? b.results_policy : 'hidden',
    instructions: String(b.instructions || ''),
    opens_at: b.opens_at || null,
    closes_at: b.closes_at || null,
  };
}

function validateAssessment(a) {
  const fields = [];
  if (!a.title || a.title.length < 2) fields.push({ path: 'title', message: 'Enter a test title.' });
  if (a.round < 1 || a.round > ROUND_COUNT) fields.push({ path: 'round', message: 'Choose a round from 1 to 5.' });
  if (!a.rules.length) fields.push({ path: 'rules', message: 'Add at least one question rule.' });
  if (a.rules.some(r => !r.topic)) fields.push({ path: 'rules', message: 'Every question rule needs a topic.' });
  return fields;
}

async function roundSettingsMap() {
  const map = {};
  try {
    const snap = await db.collection('roundSettings').get();
    queryData(snap).forEach(r => { map[num(r.round, 0)] = r; });
  } catch (err) {
    console.warn('[qb] could not read round settings:', err.message);
  }
  return map;
}

async function questionPool() {
  try {
    const snap = await db.collection('questionBank').get();
    return queryData(snap).map(normaliseQuestion).filter(q => q.status === 'active');
  } catch (err) {
    console.warn('[qb] could not read question bank:', err.message);
    return [];
  }
}

function availabilityFor(assessment, pool) {
  const roles = assessment.roles.length ? assessment.roles : [null];
  const byRole = roles.map(role => {
    const rules = assessment.rules.map(rule => {
      const n = pool.filter(q => q.round === assessment.round
        && q.topic.toLowerCase() === rule.topic.toLowerCase()
        && (rule.difficulty === 'any' || q.difficulty === rule.difficulty)
        && (!role || !q.role_code || q.role_code === role)).length;
      return { topic: rule.topic, difficulty: rule.difficulty, count: rule.count, available: n, ok: n >= rule.count };
    });
    const estimatedMarks = assessment.rules.reduce((sum, r) => sum + r.count * (pool.find(q => q.topic.toLowerCase() === r.topic.toLowerCase())?.marks || 1), 0);
    return { role: role || 'all', rules, estimatedMarks };
  });
  return {
    ok: byRole.every(br => br.rules.every(r => r.ok)),
    estimatedMarks: byRole[0] ? byRole[0].estimatedMarks : 0,
    byRole,
  };
}

function publicPaper(paper) {
  return (paper || []).map(q => ({
    id: q.id,
    position: q.position,
    topic: q.topic,
    difficulty: q.difficulty,
    marks: q.marks,
    type: q.type,
    text: q.text,
    options: q.options || [],
    negativeMarks: q.negative_marks || 0,
  }));
}

function gradeAttempt(attempt) {
  const paper = attempt.paper || [];
  const responses = attempt.responses || {};
  let score = 0;
  let maxScore = 0;
  let answered = 0;
  let needsReview = false;

  for (const q of paper) {
    const marks = num(q.marks, 1);
    maxScore += marks;
    const answer = responses[q.id];
    const hasAnswer = answer !== undefined && answer !== null && answer !== '' && !(Array.isArray(answer) && !answer.length);
    if (!hasAnswer) continue;
    answered++;
    if (q.type === 'descriptive') { needsReview = true; continue; }
    const correct = q.correct_answer;
    let right = false;
    if (q.type === 'multi_select') {
      const mine = Array.isArray(answer) ? [...answer].sort((a, b) => a - b) : [];
      const expected = Array.isArray(correct) ? [...correct].sort((a, b) => a - b) : [];
      right = mine.length === expected.length && mine.every((v, i) => v === expected[i]);
    } else {
      right = Number(answer) === Number(correct);
    }
    if (right) score += marks;
    else score -= Math.max(0, num(q.negative_marks, 0));
  }

  score = Math.max(0, Math.round(score * 100) / 100);
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const passMark = num(attempt.pass_mark_pct, 50);
  const passed = pct >= passMark;
  return { score, maxScore, pct: Math.round(pct * 100) / 100, passed, answered, total: paper.length, needsReview };
}

function resultPayload(attempt, assessment) {
  const visible = !!attempt.results_published && attempt.result_status !== 'pending_review';
  if (!visible) {
    return { visible: false, message: 'Results are under review and will be published shortly.' };
  }
  const review = assessment && assessment.results_policy === 'score_and_review'
    ? (attempt.paper || []).map(q => {
      const mine = attempt.responses ? attempt.responses[q.id] : null;
      return {
        position: q.position,
        text: q.text,
        type: q.type,
        options: q.options || [],
        marks: q.marks,
        marks_awarded: q.manual_marks !== undefined && q.manual_marks !== null ? q.manual_marks : (q.auto_marks ?? 0),
        outcome: q.outcome || 'not_answered',
        your_answer: mine,
        correct_answer: q.correct_answer,
        explanation: q.explanation || null,
      };
    })
    : null;
  return {
    visible: true,
    passed: !!attempt.passed,
    score: num(attempt.score, 0),
    max: num(attempt.max_score, 0),
    percent: Math.round(num(attempt.score_pct, 0) * 100) / 100,
    pass_mark_percent: num(attempt.pass_mark_pct, 50),
    message: attempt.passed ? 'You passed this assessment.' : 'You did not pass this assessment.',
    review,
  };
}

async function findCandidateForUser(user) {
  if (!user) return null;
  let snap = await db.collection('candidates').get();
  let items = queryData(snap).filter(c => !c.deletedAt);
  let found = items.find(c => c.userId === user.id || c.uid === user.id);
  if (!found && user.email) found = items.find(c => String(c.email || '').toLowerCase() === String(user.email).toLowerCase());
  return found || null;
}

async function attemptBelongsToUser(attempt, user) {
  if (!attempt || !user) return false;
  if (perms.can(user, 'results:read') || perms.can(user, 'evaluation:read')) return true;
  if (attempt.userId && attempt.userId === user.id) return true;
  if (attempt.email && user.email && String(attempt.email).toLowerCase() === String(user.email).toLowerCase()) return true;
  const candidate = await findCandidateForUser(user);
  if (!candidate) return false;
  if (attempt.candidateId === candidate.id) return true;
  if (attempt.applicationId) {
    const app = await db.collection('candidates').doc(candidate.id).collection('applications').doc(attempt.applicationId).get();
    return !!app.exists;
  }
  return false;
}

function mountQB(app, { requireAuth, upload }) {
  const P = '/api/qb';
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const cap = c => [requireAuth, perms.requireCap(c)];

  // -------------------------------------------------------------------------
  // Metadata & pool
  // -------------------------------------------------------------------------
  app.get(`${P}/meta`, ...cap('qbank:read'), h(async (req, res) => {
    const rounds = await roundSettingsMap();
    const pool = await questionPool();
    const topicMap = {};
    const roleSet = new Set();

    pool.forEach(q => {
      const key = `${q.round}:${q.topic}`;
      if (!topicMap[key]) topicMap[key] = { round: q.round, topic: q.topic, n: 0 };
      topicMap[key].n++;
      if (q.role_code) roleSet.add(q.role_code);
    });

    try {
      const vacSnap = await db.collection('vacancies').get();
      queryData(vacSnap).forEach(v => { if (v.roleCode) roleSet.add(v.roleCode); });
    } catch { /* vacancies are optional */ }

    res.json({
      topics: Object.values(topicMap),
      roles: Array.from(roleSet).sort(),
      rounds: Array.from({ length: ROUND_COUNT }, (_, i) => {
        const n = i + 1;
        const stored = rounds[n] || {};
        const def = DEFAULT_ROUNDS[i];
        return {
          round: n,
          name: stored.name || def.name,
          enabled: stored.enabled !== false,
          published: stored.published !== false,
        };
      }),
      types: Q_TYPES,
      difficulties: DIFFICULTIES,
      columns: [
        { key: 'topic', required: true, help: 'Category or subject' },
        { key: 'difficulty', required: true, help: 'easy | medium | hard' },
        { key: 'type', required: true, help: 'mcq | multi_select | descriptive' },
        { key: 'question_text', required: true, help: 'The question text' },
        { key: 'options', required: false, help: 'Options array for MCQ' },
        { key: 'correct_answer', required: false, help: '0-based index or array of indices' },
        { key: 'marks', required: true, help: 'Marks for a correct answer' },
      ],
    });
  }));

  app.get(`${P}/pool`, ...cap('qbank:read'), h(async (req, res) => {
    const round = clamp(num(req.query.round, 1), 1, ROUND_COUNT);
    const role = req.query.role ? String(req.query.role).toUpperCase().trim() : null;
    const pool = (await questionPool()).filter(q => q.round === round && (!role || !q.role_code || q.role_code === role));
    const cellMap = {};
    pool.forEach(q => {
      const key = `${q.topic}:${q.difficulty}`;
      if (!cellMap[key]) cellMap[key] = { topic: q.topic, difficulty: q.difficulty, n: 0 };
      cellMap[key].n++;
    });
    res.json({ round, role, cells: Object.values(cellMap) });
  }));

  // -------------------------------------------------------------------------
  // Question bank CRUD
  // -------------------------------------------------------------------------
  app.get(`${P}/questions/export`, ...cap('qbank:read'), h(async (req, res) => {
    const pool = await questionPool();
    const rows = [['question_id', 'question_text', 'question_type', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'explanation', 'difficulty', 'job_role', 'round', 'topic', 'marks', 'negative_marks', 'status']];
    for (const q of pool) {
      const f = flatQuestion(q);
      rows.push([q.question_code, f.question_text, f.question_type, f.option_a, f.option_b, f.option_c, f.option_d, f.correct_answer, f.explanation, f.difficulty, f.job_role, f.round, f.topic, f.marks, f.negative_marks, f.status]);
    }
    const csv = rows.map(r => r.map(v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="question-bank.csv"');
    res.send(csv);
  }));

  app.get(`${P}/questions`, ...cap('qbank:read'), h(async (req, res) => {
    const page = Math.max(1, num(req.query.page, 1));
    const per = clamp(num(req.query.per, 25), 1, 100);
    let all = [];
    try {
      const snap = await db.collection('questionBank').get();
      all = queryData(snap).map(normaliseQuestion);
    } catch (err) {
      console.warn('[qb] questions read failed:', err.message);
      return res.json({ items: [], total: 0, page, per });
    }

    if (req.query.round) all = all.filter(q => q.round === Number(req.query.round));
    if (req.query.status && req.query.status !== 'all' && req.query.status !== 'live') all = all.filter(q => q.status === req.query.status);
    if (!req.query.status || req.query.status === 'live') all = all.filter(q => q.status !== 'archived');
    if (req.query.type) all = all.filter(q => q.type === req.query.type);
    if (req.query.difficulty) all = all.filter(q => q.difficulty === req.query.difficulty);
    if (req.query.topic) all = all.filter(q => q.topic.toLowerCase() === String(req.query.topic).toLowerCase());
    if (req.query.role) all = all.filter(q => !q.role_code || q.role_code === String(req.query.role).toUpperCase());
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      all = all.filter(q => q.question_text.toLowerCase().includes(s) || q.question_code.toLowerCase().includes(s) || q.topic.toLowerCase().includes(s));
    }

    all = sortBy(all, 'created_at', 'desc');
    const total = all.length;
    const start = (page - 1) * per;
    res.json({ items: all.slice(start, start + per), total, page, per });
  }));

  app.get(`${P}/questions/:id`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('questionBank').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Question not found.' });
    const q = normaliseQuestion({ id: snap.id, ...snap.data() });
    let versions = [];
    try { versions = queryData(await db.collection('questionBank').doc(req.params.id).collection('versions').get()); } catch { /* optional */ }
    res.json({ ...q, id: snap.id, versions, flat: flatQuestion(q), times_issued: 0 });
  }));

  app.post(`${P}/questions`, ...cap('qbank:write'), h(async (req, res) => {
    const q = questionFromBody(req.body);
    const fields = validateQuestion(q);
    if (fields.length) return res.status(400).json({ error: 'validation_failed', fields });

    const code = await nextQuestionCode();
    const data = {
      ...q,
      question_code: code,
      version: 1,
      created_by: req.user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const ref = await db.collection('questionBank').add(data);
    try {
      await db.collection('questionBank').doc(ref.id).collection('versions').add({
        version: 1,
        change_note: 'Initial version',
        changed_by: req.user.full_name || req.user.email,
        changed_at: new Date().toISOString(),
        snapshot: data,
      });
    } catch (err) { console.warn('[qb] version history write failed:', err.message); }

    await audit(req, 'qb.question.create', 'question', code, null, { round: data.round, topic: data.topic });
    res.status(201).json({ id: ref.id, ...data, flat: flatQuestion(data) });
  }));

  app.put(`${P}/questions/:id`, ...cap('qbank:write'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('questionBank').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Question not found.' });
    const current = normaliseQuestion({ id, ...snap.data() });

    // Merge, so a partial edit never wipes options or the answer.
    const incoming = req.body || {};
    const mergedInput = { ...flatQuestion(current), ...incoming };
    if (incoming.options === undefined && incoming.option_a === undefined && incoming.option_b === undefined && incoming.option_c === undefined && incoming.option_d === undefined) {
      mergedInput.options = current.options;
    }
    const merged = questionFromBody(mergedInput);
    const fields = validateQuestion(merged);
    if (fields.length) return res.status(400).json({ error: 'validation_failed', fields });

    const nextVer = (current.version || 1) + 1;
    const updates = { ...merged, version: nextVer, updated_at: new Date().toISOString() };
    await db.collection('questionBank').doc(id).update(updates);

    try {
      await db.collection('questionBank').doc(id).collection('versions').add({
        version: nextVer,
        change_note: (req.body && req.body.change_note) || 'Updated via editor',
        changed_by: req.user.full_name || req.user.email,
        changed_at: new Date().toISOString(),
        snapshot: updates,
      });
    } catch (err) { console.warn('[qb] version history write failed:', err.message); }

    await audit(req, 'qb.question.update', 'question', current.question_code, null, updates);
    res.json({ id, ...current, ...updates, flat: flatQuestion({ ...current, ...updates }) });
  }));

  app.post(`${P}/questions/status`, ...cap('qbank:write'), h(async (req, res) => {
    const { ids, status } = z.object({ ids: z.array(z.string()).min(1), status: z.enum(['active', 'inactive', 'archived']) }).parse(req.body);
    for (const id of ids) {
      await db.collection('questionBank').doc(id).update({ status, updated_at: new Date().toISOString() });
    }
    await audit(req, 'qb.question.status', 'question', ids[0], null, { ids, status });
    res.json({ ok: true, count: ids.length, status });
  }));

  // -------------------------------------------------------------------------
  // Round settings
  // -------------------------------------------------------------------------
  app.get(`${P}/rounds`, ...cap('qbank:read'), h(async (req, res) => {
    const stored = await roundSettingsMap();
    const pool = await questionPool();
    let assessments = [];
    try { assessments = queryData(await db.collection('assessments').get()).map(a => normaliseAssessment(a, stored)); } catch { /* optional */ }

    const items = Array.from({ length: ROUND_COUNT }, (_, i) => {
      const round = i + 1;
      const s = stored[round] || {};
      const def = DEFAULT_ROUNDS[i];
      const eligibility = s.eligibility || {};
      return {
        round,
        name: s.name || def.name,
        description: s.description || '',
        enabled: s.enabled !== false,
        published: s.published !== false,
        duration_minutes: clamp(num(s.duration_minutes, def.duration_minutes), 1, 480),
        pass_threshold_pct: clamp(num(s.pass_threshold_pct, def.pass_threshold_pct), 0, 100),
        eligibility: {
          require_stage: !!eligibility.require_stage,
          min_previous_pct: eligibility.min_previous_pct === null || eligibility.min_previous_pct === undefined || eligibility.min_previous_pct === ''
            ? null : clamp(num(eligibility.min_previous_pct, 0), 0, 100),
        },
        active_questions: pool.filter(q => q.round === round).length,
        live_assessments: assessments.filter(a => a.round === round && a.status === 'active').length,
        updated_at: s.updated_at || s.updatedAt || null,
      };
    });
    res.json({ items });
  }));

  app.put(`${P}/rounds/:n`, ...cap('config:write'), h(async (req, res) => {
    const n = clamp(num(req.params.n, 0), 1, ROUND_COUNT);
    const d = req.body || {};
    const ref = db.collection('roundSettings').doc(String(n));
    const roundData = {
      round: n,
      name: String(d.name || (DEFAULT_ROUNDS[n - 1] && DEFAULT_ROUNDS[n - 1].name) || `Round ${n}`),
      description: d.description !== undefined ? String(d.description) : '',
      enabled: d.enabled !== false,
      published: d.published !== false,
      duration_minutes: clamp(num(d.duration_minutes, DEFAULT_ROUNDS[n - 1].duration_minutes), 1, 480),
      pass_threshold_pct: clamp(num(d.pass_threshold_pct, DEFAULT_ROUNDS[n - 1].pass_threshold_pct), 0, 100),
      eligibility: {
        require_stage: !!(d.eligibility && d.eligibility.require_stage),
        min_previous_pct: d.eligibility && d.eligibility.min_previous_pct !== null && d.eligibility.min_previous_pct !== undefined && d.eligibility.min_previous_pct !== ''
          ? clamp(num(d.eligibility.min_previous_pct, 0), 0, 100) : null,
      },
      updated_at: new Date().toISOString(),
    };
    await ref.set(roundData, { merge: true });
    await audit(req, 'qb.round.update', 'round', String(n), null, roundData);
    res.json(roundData);
  }));

  // -------------------------------------------------------------------------
  // Assessments
  // -------------------------------------------------------------------------
  app.get(`${P}/assessments`, ...cap('qbank:read'), h(async (req, res) => {
    let items = [];
    try {
      const stored = await roundSettingsMap();
      items = queryData(await db.collection('assessments').get()).map(a => normaliseAssessment(a, stored));
    } catch (err) {
      console.warn('[qb] assessments read failed:', err.message);
      return res.json({ items: [] });
    }
    items = sortBy(items, 'created_at', 'desc');
    res.json({ items });
  }));

  app.get(`${P}/assessments/:id`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Test not found.' });
    const stored = await roundSettingsMap();
    const a = normaliseAssessment({ id: snap.id, ...snap.data() }, stored);
    const attempts = await attemptsForAssessment(snap.id);
    a.counts = {
      assigned: Math.max(a.assigned, attempts.length),
      in_progress: attempts.filter(t => t.status === 'in_progress').length,
      submitted: Math.max(a.submitted, attempts.filter(t => t.status === 'submitted').length),
      blocked: attempts.filter(t => t.status === 'blocked').length,
    };
    a.availability = availabilityFor(a, await questionPool());
    res.json(a);
  }));

  app.post(`${P}/assessments`, ...cap('qbank:write'), h(async (req, res) => {
    const a = assessmentFromBody(req.body);
    const fields = validateAssessment(a);
    if (fields.length) return res.status(400).json({ error: 'validation_failed', fields });

    const stored = await roundSettingsMap();
    const def = stored[a.round] || DEFAULT_ROUNDS[a.round - 1];
    const data = {
      ...a,
      time_limit_minutes: a.time_limit_minutes === null ? num(def.duration_minutes, 45) : a.time_limit_minutes,
      pass_mark_pct: a.pass_mark_pct === null ? num(def.pass_threshold_pct, 50) : a.pass_mark_pct,
      source: 'bank',
      status: 'draft',
      current_version: 1,
      assigned: 0,
      submitted: 0,
      created_by: req.user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ref = await db.collection('assessments').add(data);
    await audit(req, 'qb.assessment.create', 'assessment', ref.id, null, { title: data.title, round: data.round });
    const saved = normaliseAssessment({ id: ref.id, ...data }, stored);
    saved.availability = availabilityFor(saved, await questionPool());
    res.status(201).json(saved);
  }));

  app.put(`${P}/assessments/:id`, ...cap('qbank:write'), h(async (req, res) => {
    const id = req.params.id;
    const ref = db.collection('assessments').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Test not found.' });

    const stored = await roundSettingsMap();
    const current = normaliseAssessment({ id, ...snap.data() }, stored);
    const merged = { ...current, ...assessmentFromBody({ ...current, ...(req.body || {}) }) };
    const fields = validateAssessment(merged);
    if (fields.length) return res.status(400).json({ error: 'validation_failed', fields });

    const updates = {
      ...assessmentFromBody(merged),
      time_limit_minutes: merged.time_limit_minutes === null ? current.time_limit_minutes : merged.time_limit_minutes,
      pass_mark_pct: merged.pass_mark_pct === null ? current.pass_mark_pct : merged.pass_mark_pct,
      updated_at: new Date().toISOString(),
    };
    await ref.update(updates);
    await audit(req, 'qb.assessment.update', 'assessment', id, null, updates);
    const saved = normaliseAssessment({ id, ...snap.data(), ...updates }, stored);
    saved.availability = availabilityFor(saved, await questionPool());
    res.json(saved);
  }));

  app.post(`${P}/assessments/:id/publish`, ...cap('assessment:publish'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('assessments').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Test not found.' });
    const stored = await roundSettingsMap();
    const a = normaliseAssessment({ id, ...snap.data() }, stored);
    const action = req.body && req.body.action;
    const newStatus = action === 'unpublish' ? 'draft' : 'active';

    if (newStatus === 'active') {
      const round = stored[a.round];
      if (round && round.published === false) {
        return res.status(400).json({ error: 'round_not_published', message: `Publish Round ${a.round} in the Rounds tab before publishing this test.` });
      }
      const availability = availabilityFor(a, await questionPool());
      if (!availability.ok) {
        return res.status(400).json({ error: 'not_enough_questions', message: 'The question bank does not have enough active questions for every rule in this test.' });
      }
    }

    await db.collection('assessments').doc(id).update({ status: newStatus, updated_at: new Date().toISOString() });
    await audit(req, `qb.assessment.${newStatus}`, 'assessment', id, null, { status: newStatus });
    res.json({ ok: true, status: newStatus });
  }));

  app.post(`${P}/assessments/:id/results`, ...cap('results:publish'), h(async (req, res) => {
    const id = req.params.id;
    const published = !!(req.body && req.body.published);
    const policy = ['hidden', 'score', 'score_and_review'].includes(req.body && req.body.results_policy) ? req.body.results_policy : 'score';
    const updates = {
      results_published: published,
      results_policy: policy,
      results_published_at: published ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    await db.collection('assessments').doc(id).update(updates);
    const attempts = await attemptsForAssessment(id);
    for (const att of attempts) {
      await db.collection('attempts').doc(att.id).update({ results_published: published, results_policy: policy });
    }
    res.json({ ok: true, published, pending_review: attempts.filter(a => a.result_status === 'pending_review').length });
  }));

  app.get(`${P}/assessments/:id/preview`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Test not found.' });
    const stored = await roundSettingsMap();
    const a = normaliseAssessment({ id: snap.id, ...snap.data() }, stored);
    const pool = await questionPool();
    const chosen = [];

    for (const rule of a.rules) {
      const matches = pool.filter(q => q.round === a.round
        && q.topic.toLowerCase() === rule.topic.toLowerCase()
        && (rule.difficulty === 'any' || q.difficulty === rule.difficulty)
        && (!a.roles.length || !q.role_code || a.roles.includes(q.role_code)));
      const shuffled = matches.slice();
      for (let i = shuffled.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      chosen.push(...shuffled.slice(0, rule.count));
    }

    const questions = chosen.map((q, idx) => ({
      position: idx + 1,
      id: q.id,
      topic: q.topic,
      difficulty: q.difficulty,
      marks: q.marks,
      type: q.type,
      text: q.question_text,
      options: q.options,
      correct: q.correct_answer,
      reference: q.reference_answer,
    }));
    res.json({
      note: questions.length ? `Sample drawn from the question pool (${questions.length} questions).` : 'The question bank does not have enough active questions for this test yet.',
      totalMarks: questions.reduce((sum, q) => sum + num(q.marks, 1), 0),
      questions,
    });
  }));

  app.post(`${P}/assessments/:id/assign`, ...cap('assessment:assign'), h(async (req, res) => {
    const assessmentId = req.params.id;
    const appIds = [...new Set(asArray(req.body && req.body.application_ids))];
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) return res.status(404).json({ error: 'not_found', message: 'Test not found.' });
    const stored = await roundSettingsMap();
    const assess = normaliseAssessment({ id: assessmentId, ...aSnap.data() }, stored);
    if (assess.status !== 'active') return res.status(400).json({ error: 'not_published', message: 'Publish the test before assigning it.' });

    const existing = await attemptsForAssessment(assessmentId);
    let assigned = 0;
    const results = [];

    for (const applicationId of appIds) {
      try {
        if (existing.some(a => a.applicationId === applicationId)) {
          results.push({ applicationId, status: 'already_assigned' });
          continue;
        }
        const candidate = await candidateForApplication(applicationId);
        const assignRef = await db.collection('assignments').add({
          assessmentId,
          applicationId,
          candidateId: candidate ? candidate.id : null,
          assignedBy: req.user.id,
          createdAt: FieldValue.serverTimestamp(),
        });
        await db.collection('attempts').add({
          assignmentId: assignRef.id,
          assessmentId,
          assessmentTitle: assess.title,
          applicationId,
          candidateId: candidate ? candidate.id : null,
          candidateName: candidate ? (candidate.fullName || candidate.full_name || 'Candidate') : 'Candidate',
          candidateCode: candidate ? (candidate.candidateCode || candidate.candidate_code || '') : '',
          roleCode: candidate ? (candidate.roleCode || candidate.role_code || '') : '',
          userId: candidate ? candidate.userId || null : null,
          email: candidate ? candidate.email || null : null,
          round: assess.round,
          status: 'ready',
          time_limit_minutes: assess.time_limit_minutes,
          lock_mode: assess.lock_mode,
          monitor_mode: assess.monitor_mode,
          pass_mark_pct: assess.pass_mark_pct,
          results_published: !!assess.results_published,
          results_policy: assess.results_policy,
          warnings: 0,
          started_at: null,
          deadline_at: null,
          submitted_at: null,
          score: null,
          max_score: null,
          result_status: 'pending',
          created_at: FieldValue.serverTimestamp(),
        });
        assigned++;
        results.push({ applicationId, status: 'assigned' });
      } catch (err) {
        results.push({ applicationId, status: 'failed', reason: err.message });
      }
    }

    if (assigned) await db.collection('assessments').doc(assessmentId).update({ assigned: FieldValue.increment(assigned) });
    res.json({ assigned, results });
  }));

  async function attemptsForAssessment(assessmentId) {
    try {
      const snap = await db.collection('attempts').get();
      return queryData(snap).filter(a => a.assessmentId === assessmentId);
    } catch (err) {
      console.warn('[qb] attempts read failed:', err.message);
      return [];
    }
  }

  async function candidateForApplication(applicationId) {
    try {
      // An application lives at candidates/{candidateId}/applications/{applicationId}.
      // There is no collection-group lookup in the RTDB fallback, so scan candidates.
      const candidates = queryData(await db.collection('candidates').get()).filter(c => !c.deletedAt);
      for (const c of candidates) {
        const app = await db.collection('candidates').doc(c.id).collection('applications').doc(applicationId).get();
        if (app.exists) return c;
      }
    } catch { /* ignore */ }
    return null;
  }

  app.get(`${P}/assessments/:id/report`, ...cap('results:read'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('assessments').doc(id).get();
    const stored = await roundSettingsMap();
    const a = snap.exists ? normaliseAssessment({ id, ...snap.data() }, stored) : { title: 'Assessment' };
    const attempts = await attemptsForAssessment(id);
    const submitted = attempts.filter(t => t.status === 'submitted');
    const scores = submitted.map(t => num(t.score_pct, 0));
    const assigned = Math.max(num(a.assigned, 0), attempts.length);

    const topicMap = {};
    for (const t of submitted) {
      for (const q of (t.paper || [])) {
        const topic = q.topic || 'General';
        if (!topicMap[topic]) topicMap[topic] = { topic, asked: 0, answered: 0, correct: 0 };
        topicMap[topic].asked++;
        const mine = t.responses && t.responses[q.id];
        if (mine !== undefined && mine !== null) topicMap[topic].answered++;
        if (q.outcome === 'correct') topicMap[topic].correct++;
      }
    }

    res.json({
      assessment: { id, title: a.title || 'Assessment' },
      counts: {
        assigned,
        not_started: attempts.filter(t => t.status === 'ready').length,
        in_progress: attempts.filter(t => t.status === 'in_progress').length,
        blocked: attempts.filter(t => t.status === 'blocked').length,
        submitted: submitted.length,
        pending_review: submitted.filter(t => t.result_status === 'pending_review').length,
      },
      completion_rate: assigned ? Math.round((submitted.length / assigned) * 100) : 0,
      scores: submitted.length ? {
        average_pct: Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100,
        highest_pct: Math.round(Math.max(...scores) * 100) / 100,
        lowest_pct: Math.round(Math.min(...scores) * 100) / 100,
        passed: submitted.filter(t => t.passed).length,
        failed: submitted.filter(t => !t.passed).length,
        pass_rate: Math.round((submitted.filter(t => t.passed).length / submitted.length) * 100),
      } : null,
      topics: Object.values(topicMap).map(t => ({ ...t, accuracy_pct: t.asked ? Math.round((t.correct / t.asked) * 100) : 0 })),
    });
  }));

  // -------------------------------------------------------------------------
  // Submissions, marking and audit
  // -------------------------------------------------------------------------
  app.get(`${P}/submissions/export`, ...cap('results:read'), (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
    res.send('candidate_name,candidate_code,role,test_title,score,status,submitted_at\r\n');
  });

  app.get(`${P}/submissions`, requireAuth, h(async (req, res) => {
    const canAll = perms.can(req.user, 'results:read');
    const canAssigned = perms.can(req.user, 'evaluation:write:assigned');
    if (!canAll && !canAssigned) return res.status(403).json({ error: 'forbidden' });
    const page = Math.max(1, num(req.query.page, 1));
    const per = clamp(num(req.query.per, 25), 1, 100);
    let raw = [];
    try { raw = queryData(await db.collection('attempts').get()); } catch (err) { console.warn('[qb] submissions read failed:', err.message); }

    if (!canAll) {
      const candidates = queryData(await db.collection('candidates').get()).filter(c => c.assessorId === req.user.id);
      const ids = new Set(candidates.map(c => c.id));
      raw = raw.filter(a => ids.has(a.candidateId));
    }
    if (req.query.assessment_id) raw = raw.filter(a => a.assessmentId === req.query.assessment_id);
    if (req.query.status) raw = raw.filter(a => a.status === req.query.status);
    if (req.query.result === 'passed') raw = raw.filter(a => a.passed === true);
    if (req.query.result === 'failed') raw = raw.filter(a => a.passed === false);
    if (req.query.result === 'pending_review') raw = raw.filter(a => a.result_status === 'pending_review');
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      raw = raw.filter(a => String(a.candidateName || '').toLowerCase().includes(s)
        || String(a.candidateCode || '').toLowerCase().includes(s)
        || String(a.email || '').toLowerCase().includes(s));
    }

    raw = sortBy(raw, 'created_at', 'desc');
    const items = raw.map(att => ({
      attempt_id: att.id,
      full_name: att.candidateName || att.fullName || 'Candidate',
      candidate_code: att.candidateCode || '',
      role_code: att.roleCode || '',
      assessment_title: att.assessmentTitle || 'Skills Assessment',
      attempt_status: att.status || 'ready',
      final_score: att.score !== undefined && att.score !== null ? att.score : null,
      max_score: num(att.max_score, 100),
      final_pct: att.score !== undefined && att.score !== null ? Math.round((num(att.score, 0) / num(att.max_score, 100)) * 100) : 0,
      result_status: att.result_status || 'pending',
      passed: !!att.passed,
      submitted_at: att.submitted_at || att.created_at || null,
      monitor_flags: num(att.monitor_flags, 0),
      warnings: num(att.warnings, 0),
    }));

    const total = items.length;
    const start = (page - 1) * per;
    res.json({ items: items.slice(start, start + per), total, page, per });
  }));

  app.get(`${P}/attempts/:id`, requireAuth, h(async (req, res) => {
    const canAll = perms.can(req.user, 'results:read');
    const canAssigned = perms.can(req.user, 'evaluation:write:assigned');
    if (!canAll && !canAssigned) return res.status(403).json({ error: 'forbidden' });
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id: snap.id, ...snap.data() };
    if (!canAll) {
      const candidate = att.candidateId ? (await db.collection('candidates').doc(att.candidateId).get()) : null;
      if (!candidate || !candidate.exists || candidate.data().assessorId !== req.user.id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    const responses = att.responses || {};
    const paper = att.paper || [];
    const questions = paper.map(q => {
      const mine = responses[q.id];
      const auto = q.auto_marks;
      return {
        id: q.id,
        position: q.position,
        code: q.code || q.question_code || '',
        topic: q.topic,
        difficulty: q.difficulty,
        marks: num(q.marks, 1),
        type: q.type,
        text: q.text,
        options: q.options || [],
        response: mine === undefined ? null : mine,
        correct: q.correct_answer,
        reference_answer: q.reference_answer || null,
        auto_marks: auto === undefined ? null : auto,
        manual_marks: q.manual_marks === undefined ? null : q.manual_marks,
        review_comment: q.review_comment || null,
      };
    });
    let events = [];
    try { events = queryData(await db.collection('attempts').doc(snap.id).collection('events').get()); } catch { /* optional */ }
    res.json({
      ...att,
      attempt_id: snap.id,
      full_name: att.candidateName || att.fullName || 'Candidate',
      candidate_code: att.candidateCode || '',
      assessment_title: att.assessmentTitle || 'Assessment',
      attempt_status: att.status || 'ready',
      result_status: att.result_status || 'pending',
      final_score: att.score !== undefined ? att.score : null,
      max_score: num(att.max_score, 0),
      warnings: num(att.warnings, 0),
      questions,
      events: sortBy(events, 'created_at', 'asc'),
      paper: att.paper ? { assessment_version: att.assessment_version || 1, generated_at: att.started_at || att.created_at } : null,
    });
  }));

  app.post(`${P}/attempts/:id/reinstate`, ...cap('stage:change'), h(async (req, res) => {
    const id = req.params.id;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'reason_required', message: 'Give a reason for reinstating this attempt.' });
    await db.collection('attempts').doc(id).update({ status: 'ready', reinstate_reason: reason, updated_at: new Date().toISOString() });
    await db.collection('attempts').doc(id).collection('events').add({ kind: 'reinstated', detail: reason, created_by: req.user.id, created_at: new Date().toISOString() });
    await audit(req, 'qb.attempt.reinstate', 'attempt', id, { status: 'blocked' }, { status: 'ready', reason });
    res.json({ ok: true });
  }));

  app.put(`${P}/attempts/:id/review/:qid`, ...cap('evaluation:write:assigned'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id, ...snap.data() };
    if (!perms.can(req.user, 'results:read')) {
      const candidate = att.candidateId ? await db.collection('candidates').doc(att.candidateId).get() : null;
      if (!candidate || !candidate.exists || candidate.data().assessorId !== req.user.id) {
        return res.status(403).json({ error: 'forbidden', message: 'This candidate is not assigned to you.' });
      }
    }
    const marks = num(req.body && req.body.marks, NaN);
    if (!Number.isFinite(marks) || marks < 0) return res.status(400).json({ error: 'invalid_marks', message: 'Enter valid marks.' });

    const paper = att.paper || [];
    const q = paper.find(x => x.id === req.params.qid);
    if (!q) return res.status(404).json({ error: 'question_not_found', message: 'Question not found in this paper.' });
    if (marks > num(q.marks, 1)) return res.status(400).json({ error: 'invalid_marks', message: `Marks cannot exceed ${q.marks}.` });

    q.manual_marks = marks;
    q.review_comment = (req.body && req.body.comment) || null;
    q.outcome = marks >= num(q.marks, 1) ? 'correct' : marks > 0 ? 'partial' : 'incorrect';

    const total = paper.reduce((sum, item) => sum + (item.manual_marks !== undefined && item.manual_marks !== null ? num(item.manual_marks, 0) : num(item.auto_marks, 0)), 0);
    const maxScore = paper.reduce((sum, item) => sum + num(item.marks, 1), 0);
    const pct = maxScore ? (total / maxScore) * 100 : 0;
    const pending = paper.some(item => item.type === 'descriptive' && (item.manual_marks === undefined || item.manual_marks === null));
    const passed = pct >= num(att.pass_mark_pct, 50);

    await db.collection('attempts').doc(id).update({
      paper,
      score: Math.round(total * 100) / 100,
      max_score: maxScore,
      score_pct: Math.round(pct * 100) / 100,
      passed,
      result_status: pending ? 'pending_review' : 'final',
      updated_at: new Date().toISOString(),
    });
    res.json({ ok: true, result_status: pending ? 'pending_review' : 'final', score: Math.round(total * 100) / 100, max: maxScore });
  }));

  app.get(`${P}/audit`, ...cap('qbank:read'), h(async (req, res) => {
    let items = [];
    try { items = queryData(await db.collection('auditLogs').get()); } catch { /* optional */ }
    items = sortBy(items, 'createdAt', 'desc').slice(0, 50).map(d => ({
      id: d.id,
      created_at: toIso(d.createdAt) || d.createdAt || null,
      actor: d.actorRole || d.actorId || 'system',
      action: d.action,
      entity_type: d.entityType,
      entity_id: d.entityId,
      after: d.after,
    }));
    res.json({ items });
  }));

  // -------------------------------------------------------------------------
  // Import (CSV; Excel/Word templates remain available for download)
  // -------------------------------------------------------------------------
  function parseUpload(file) {
    const name = String(file.originalname || file.name || 'upload').toLowerCase();
    if (!parseCsv) throw new Error('Import support is not available on this deployment.');
    if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(file.buffer).rows;
    if (name.endsWith('.xlsx')) {
      if (!readXlsx) throw new Error('Excel import is not available on this deployment.');
      return readXlsx(file.buffer).rows;
    }
    if (name.endsWith('.docx')) {
      if (!readDocx) throw new Error('Word import is not available on this deployment.');
      return readDocx(file.buffer).rows;
    }
    throw new Error('Use a .csv, .xlsx or .docx file.');
  }

  function headerMap(header) {
    const map = {};
    header.forEach((h, i) => {
      const key = String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
      const aliases = {
        question_id: 'question_id', id: 'question_id', question_code: 'question_id',
        question_text: 'question_text', question: 'question_text',
        question_type: 'question_type', type: 'question_type',
        option_a: 'option_a', option_b: 'option_b', option_c: 'option_c', option_d: 'option_d',
        correct_answer: 'correct_answer', answer: 'correct_answer',
        explanation: 'explanation', difficulty: 'difficulty', level: 'difficulty',
        job_role: 'job_role', role_code: 'job_role', role: 'job_role',
        round: 'round', topic: 'topic', category: 'topic',
        marks: 'marks', negative_marks: 'negative_marks', status: 'status',
      };
      if (aliases[key]) map[aliases[key]] = i;
    });
    return map;
  }

  function rowToQuestion(cells, map) {
    const value = key => (map[key] !== undefined ? String(cells[map[key]] || '').trim() : '');
    return questionFromBody({
      question_text: value('question_text'),
      question_type: value('question_type') || 'mcq',
      option_a: value('option_a'), option_b: value('option_b'), option_c: value('option_c'), option_d: value('option_d'),
      correct_answer: value('correct_answer'),
      explanation: value('explanation'),
      difficulty: value('difficulty') || 'medium',
      job_role: value('job_role'),
      round: value('round') || 1,
      topic: value('topic') || 'General',
      marks: value('marks') || 1,
      negative_marks: value('negative_marks') || 0,
      status: value('status') || 'active',
    });
  }

  app.post(`${P}/import/preview`, ...cap('qbank:import'), (req, res, next) => {
    if (!upload) return res.status(503).json({ error: 'upload_unavailable', message: 'File upload is not available on this deployment.' });
    upload.single('file')(req, res, next);
  }, h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose a file to upload.' });
    const fileName = req.file.originalname || 'questions';
    let rows;
    try { rows = parseUpload(req.file); } catch (err) {
      return res.json({ batchId: null, fileName, fileErrors: [err.message], summary: { total: 0, new: 0, update: 0, duplicate: 0, error: 1, ignored: 0, importable: 0 }, rows: [] });
    }
    if (!rows || !rows.length) {
      return res.json({ batchId: null, fileName, fileErrors: ['The file is empty.'], summary: { total: 0, new: 0, update: 0, duplicate: 0, error: 1, ignored: 0, importable: 0 }, rows: [] });
    }
    if (rows.length > 401) {
      return res.json({ batchId: null, fileName, fileErrors: ['This build supports up to 400 questions per import. Split the file into smaller batches.'], summary: { total: 0, new: 0, update: 0, duplicate: 0, error: 1, ignored: 0, importable: 0 }, rows: [] });
    }

    const header = rows[0].cells.map(c => String(c || '').trim());
    const map = headerMap(header);
    const required = ['question_text', 'question_type', 'difficulty', 'topic', 'marks'];
    const missing = required.filter(k => map[k] === undefined);
    if (missing.length) {
      return res.json({ batchId: null, fileName, fileErrors: [`Missing required column(s): ${missing.join(', ')}. Download the template for the expected headings.`], summary: { total: 0, new: 0, update: 0, duplicate: 0, error: 1, ignored: 0, importable: 0 }, rows: [] });
    }

    const existing = queryData(await db.collection('questionBank').get()).map(normaliseQuestion);
    const byCode = new Map(existing.filter(q => q.question_code).map(q => [q.question_code, q]));
    const onConflict = req.query.on_conflict === 'update' ? 'update' : 'skip';
    const summary = { total: 0, new: 0, update: 0, duplicate: 0, error: 0, ignored: 0, importable: 0 };
    const previewRows = [];

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].cells;
      if (!cells.some(c => String(c || '').trim() !== '')) { summary.ignored++; continue; }
      summary.total++;
      const code = map.question_id !== undefined ? String(cells[map.question_id] || '').trim() : '';
      const q = rowToQuestion(cells, map);
      const fields = validateQuestion(q);
      let status;
      if (fields.length) { status = 'error'; summary.error++; }
      else if (code && byCode.has(code)) {
        if (onConflict === 'update') { status = 'update'; summary.update++; }
        else { status = 'duplicate'; summary.duplicate++; }
      } else { status = 'new'; summary.new++; }
      if (status === 'new' || status === 'update') summary.importable++;
      previewRows.push({
        row: rows[i].row,
        status,
        preview: {
          question_text: q.question_text,
          type: q.type,
          round: q.round,
          topic: q.topic,
          difficulty: q.difficulty,
          answer: q.type === 'descriptive' ? (q.reference_answer || '') : (Array.isArray(q.correct_answer) ? q.correct_answer.map(i2 => LETTERS[i2]).join(',') : LETTERS[q.correct_answer] || ''),
        },
        errors: fields,
        warnings: [],
        question_code: code || null,
        data: q,
      });
    }

    const batch = {
      file_name: fileName,
      status: 'preview',
      created_by: req.user.full_name || req.user.email,
      created_by_id: req.user.id,
      created_at: new Date().toISOString(),
      on_conflict: onConflict,
      summary,
      rows: previewRows,
    };
    const ref = await db.collection('importBatches').add(batch);
    res.json({ batchId: ref.id, fileName, summary, rows: previewRows, warnings: [] });
  }));

  app.get(`${P}/import/:id`, ...cap('qbank:import'), h(async (req, res) => {
    const snap = await db.collection('importBatches').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Import not found.' });
    const batch = { id: snap.id, ...snap.data() };
    const statusFilter = req.query.status ? String(req.query.status) : '';
    const allRows = Array.isArray(batch.rows) ? batch.rows : [];
    const rows = statusFilter ? allRows.filter(r => r.status === statusFilter) : allRows;
    const page = Math.max(1, num(req.query.page, 1));
    const per = 50;
    res.json({ ...batch, rows: rows.slice((page - 1) * per, page * per), rowPage: page, rowTotal: rows.length });
  }));

  app.post(`${P}/import/:id/cancel`, ...cap('qbank:import'), h(async (req, res) => {
    await db.collection('importBatches').doc(req.params.id).update({ status: 'cancelled', cancelled_at: new Date().toISOString() });
    res.json({ ok: true });
  }));

  app.post(`${P}/import/:id/commit`, ...cap('qbank:import'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('importBatches').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Import not found.' });
    const batch = { id, ...snap.data() };
    if (batch.status !== 'preview') return res.status(409).json({ error: 'already_committed', message: 'This import has already been processed.' });

    let created = 0, updated = 0, skipped = 0;
    const skippedRows = [];
    for (const row of (batch.rows || [])) {
      if (row.status !== 'new' && row.status !== 'update') { skipped++; continue; }
      try {
        const q = row.data || {};
        if (row.status === 'update' && row.question_code) {
          const existing = queryData(await db.collection('questionBank').get()).map(normaliseQuestion).find(x => x.question_code === row.question_code);
          if (!existing) { skipped++; skippedRows.push({ row: row.row, reason: 'Question no longer exists.' }); continue; }
          await db.collection('questionBank').doc(existing.id).update({ ...q, version: (existing.version || 1) + 1, updated_at: new Date().toISOString() });
          updated++;
        } else {
          const code = await nextQuestionCode();
          await db.collection('questionBank').add({ ...q, question_code: code, version: 1, created_by: req.user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
          created++;
        }
      } catch (err) {
        skipped++;
        skippedRows.push({ row: row.row, reason: err.message });
      }
    }

    const result = { created, updated, skipped };
    await db.collection('importBatches').doc(id).update({ status: 'committed', committed_at: new Date().toISOString(), result });
    await audit(req, 'qb.import.commit', 'importBatch', id, null, result);
    res.json({ ok: true, ...result, skippedRows });
  }));

  app.get(`${P}/import`, ...cap('qbank:import'), h(async (req, res) => {
    let items = [];
    try { items = queryData(await db.collection('importBatches').get()).map(({ rows, ...b }) => b); } catch { /* optional */ }
    res.json({ items: sortBy(items, 'created_at', 'desc').slice(0, 20) });
  }));

  app.get(`${P}/templates/:format`, ...cap('qbank:read'), (req, res) => {
    const sample = 'topic,difficulty,type,question_text,option_a,option_b,option_c,option_d,correct_answer,marks,negative_marks\r\nAptitude,easy,mcq,What is 10 + 10?,15,20,25,30,B,1,0.25\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="question_template.csv"');
    res.send(sample);
  });

  // -------------------------------------------------------------------------
  // Candidate portal
  // -------------------------------------------------------------------------
  app.get(`${P}/my/assessments`, requireAuth, h(async (req, res) => {
    if (perms.can(req.user, 'results:read') || req.user.role !== 'candidate') {
      return res.status(403).json({ error: 'forbidden', message: 'This area is for candidates.' });
    }
    const candidate = await findCandidateForUser(req.user);
    if (!candidate) return res.json({ current: [], completed: [] });

    let attempts = [];
    try { attempts = queryData(await db.collection('attempts').get()); } catch (err) { console.warn('[qb] candidate attempts read failed:', err.message); }
    attempts = attempts.filter(a => a.candidateId === candidate.id || a.userId === req.user.id || (a.email && req.user.email && String(a.email).toLowerCase() === String(req.user.email).toLowerCase()));

    const items = [];
    for (const att of attempts) {
      const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
      const assess = aSnap.exists ? normaliseAssessment({ id: att.assessmentId, ...aSnap.data() }) : {};
      const roundName = `Round ${assess.round || att.round || 1}`;
      items.push({
        id: att.id,
        attempt_id: att.id,
        assessment_id: att.assessmentId,
        title: assess.title || att.assessmentTitle || 'Assessment',
        round: assess.round || att.round || 1,
        round_name: roundName,
        status: att.status || 'ready',
        duration_minutes: num(assess.time_limit_minutes, num(att.time_limit_minutes, 45)),
        deadline_at: att.deadline_at || null,
        score: att.score,
        result_status: att.result_status || 'pending',
        state: att.status === 'in_progress' ? 'in_progress' : att.status === 'blocked' ? 'blocked' : att.status === 'submitted' ? 'submitted' : 'available',
        result: att.status === 'submitted' ? (att.results_published && att.result_status !== 'pending_review' ? 'available' : 'under_review') : null,
        submitted_at: att.submitted_at || null,
      });
    }

    res.json({
      current: items.filter(x => x.status !== 'submitted'),
      completed: items.filter(x => x.status === 'submitted'),
    });
  }));

  app.get(`${P}/my/attempts/:id`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id: snap.id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? normaliseAssessment({ id: att.assessmentId, ...aSnap.data() }) : {};
    const locked = att.status === 'blocked';
    const expectedQuestions = (att.paper && att.paper.length)
      ? att.paper.length
      : (assess.rules || []).reduce((sum, rule) => sum + num(rule.count, 0), 0);
    res.json({
      ...att,
      attempt_id: snap.id,
      title: assess.title || att.assessmentTitle || 'Assessment',
      round: assess.round || att.round || 1,
      round_name: `Round ${assess.round || att.round || 1}`,
      lock_mode: assess.lock_mode || 'strict',
      monitor_mode: assess.monitor_mode || 'off',
      instructions: assess.instructions || '',
      duration_minutes: num(assess.time_limit_minutes, num(att.time_limit_minutes, 45)),
      questions: expectedQuestions,
      warnings: num(att.warnings, 0),
      max_warnings: (assess.lock_mode || 'strict') === 'warn' ? 2 : (assess.lock_mode === 'off' ? 0 : 1),
      can_start: !locked && att.status !== 'submitted',
      message: locked ? 'This attempt is paused until the hiring team reviews it.' : att.status === 'submitted' ? 'This attempt has been submitted.' : null,
    });
  }));

  app.post(`${P}/my/attempts/:id/start`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });
    if (att.status === 'submitted') return res.status(409).json({ error: 'already_submitted', message: 'This attempt has already been submitted.' });
    if (att.status === 'blocked') return res.status(409).json({ error: 'blocked', message: 'This attempt is paused until the hiring team reviews it.' });

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    if (!aSnap.exists) return res.status(404).json({ error: 'not_found', message: 'The test for this attempt no longer exists.' });
    const assess = normaliseAssessment({ id: att.assessmentId, ...aSnap.data() });
    if (assess.status !== 'active') return res.status(409).json({ error: 'not_open', message: 'This test is not open right now.' });
    if (!assess.rules.length) return res.status(409).json({ error: 'no_questions', message: 'This test has no question rules yet.' });
    const durationMs = num(assess.time_limit_minutes, 45) * 60 * 1000;
    const nowMs = Date.now();

    let paper = att.paper || [];
    if (!paper.length) {
      const pool = await questionPool();
      const chosen = [];
      for (const rule of assess.rules) {
        const matches = pool.filter(q => q.round === assess.round
          && q.topic.toLowerCase() === rule.topic.toLowerCase()
          && (rule.difficulty === 'any' || q.difficulty === rule.difficulty)
          && (!assess.roles.length || !q.role_code || assess.roles.includes(q.role_code)));
        for (let i = matches.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [matches[i], matches[j]] = [matches[j], matches[i]]; }
        chosen.push(...matches.slice(0, rule.count));
      }
      paper = chosen.map((q, idx) => ({
        id: q.id,
        code: q.question_code,
        position: idx + 1,
        topic: q.topic,
        difficulty: q.difficulty,
        marks: q.marks,
        negative_marks: q.negative_marks,
        type: q.type,
        text: q.question_text,
        options: q.options,
        correct_answer: q.correct_answer,
        reference_answer: q.reference_answer,
        explanation: q.explanation,
      }));
    }

    const deadline = att.deadline_at ? new Date(att.deadline_at).getTime() : nowMs + durationMs;
    if (deadline <= nowMs && att.status === 'in_progress') {
      return res.status(409).json({ error: 'time_expired', message: 'The time for this attempt has ended.' });
    }

    await db.collection('attempts').doc(id).update({
      status: 'in_progress',
      started_at: att.started_at || new Date(nowMs).toISOString(),
      deadline_at: new Date(deadline).toISOString(),
      paper,
      max_score: paper.reduce((sum, q) => sum + num(q.marks, 1), 0),
      pass_mark_pct: assess.pass_mark_pct,
      results_published: !!assess.results_published,
      results_policy: assess.results_policy,
      updated_at: new Date().toISOString(),
    });

    res.json({
      attempt: {
        id,
        status: 'in_progress',
        remaining_ms: Math.max(0, deadline - nowMs),
        deadline_at: new Date(deadline).toISOString(),
        warnings: num(att.warnings, 0),
        max_warnings: assess.lock_mode === 'warn' ? 2 : assess.lock_mode === 'off' ? 0 : 1,
        monitor_mode: assess.monitor_mode,
        lock_mode: assess.lock_mode,
      },
      assessment: { id: assess.id, title: assess.title, round: assess.round, instructions: assess.instructions },
      questions: publicPaper(paper),
      answers: Object.fromEntries(Object.entries(att.responses || {}).map(([qid, response]) => [qid, { response, rev: 1 }])),
    });
  }));

  app.get(`${P}/my/attempts/:id/paper`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id: snap.id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });
    const deadlineMs = att.deadline_at ? new Date(att.deadline_at).getTime() : Date.now();
    res.json({
      attempt: {
        id: snap.id,
        status: att.status,
        remaining_ms: Math.max(0, deadlineMs - Date.now()),
        warnings: num(att.warnings, 0),
      },
      questions: publicPaper(att.paper),
    });
  }));

  app.put(`${P}/my/attempts/:id/responses`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });
    if (att.status === 'blocked') return res.status(409).json({ error: 'blocked', message: 'This attempt is paused.' });
    if (att.status === 'submitted') return res.status(409).json({ error: 'already_submitted', message: 'This attempt has already been submitted.' });

    const paperIds = new Set((att.paper || []).map(q => q.id));
    const responses = { ...(att.responses || {}) };
    const saved = [];
    for (const item of items) {
      if (!item || !paperIds.has(item.id)) continue;
      responses[item.id] = item.response;
      saved.push({ id: item.id, rev: num(item.rev, 1) });
    }
    await db.collection('attempts').doc(id).update({ responses, last_saved_at: new Date().toISOString() });
    res.json({ ok: true, saved });
  }));

  app.post(`${P}/my/attempts/:id/submit`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });
    if (att.status === 'blocked') return res.status(409).json({ error: 'blocked', message: 'This attempt is paused until the hiring team reviews it.' });
    if (att.status === 'submitted') return res.status(409).json({ error: 'already_submitted', message: 'This attempt has already been submitted.' });

    const graded = gradeAttempt(att);

    // Record per-question outcome and auto marks so the marking screen has context.
    const paper = (att.paper || []).map(q => {
      const response = (att.responses || {})[q.id];
      const hasAnswer = response !== undefined && response !== null && response !== '' && !(Array.isArray(response) && !response.length);
      if (!hasAnswer) return { ...q, auto_marks: 0, outcome: 'not_answered' };
      if (q.type === 'descriptive') return { ...q, auto_marks: null, outcome: 'pending_review' };
      let right = false;
      if (q.type === 'multi_select') {
        const mine = Array.isArray(response) ? [...response].sort((a, b) => a - b) : [];
        const expected = Array.isArray(q.correct_answer) ? [...q.correct_answer].sort((a, b) => a - b) : [];
        right = mine.length === expected.length && mine.every((v, i) => v === expected[i]);
      } else right = Number(response) === Number(q.correct_answer);
      return { ...q, auto_marks: right ? num(q.marks, 1) : -Math.max(0, num(q.negative_marks, 0)), outcome: right ? 'correct' : 'incorrect' };
    });

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? normaliseAssessment({ id: att.assessmentId, ...aSnap.data() }) : {};
    const resultStatus = graded.needsReview ? 'pending_review' : 'final';

    await db.collection('attempts').doc(id).update({
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      paper,
      score: graded.score,
      max_score: graded.maxScore,
      score_pct: graded.pct,
      passed: graded.passed,
      pass_mark_pct: num(assess.pass_mark_pct, num(att.pass_mark_pct, 50)),
      result_status: resultStatus,
      results_published: !!assess.results_published,
      results_policy: assess.results_policy,
      answered: graded.answered,
      total_questions: graded.total,
      updated_at: new Date().toISOString(),
    });
    await db.collection('assessments').doc(att.assessmentId).update({ submitted: FieldValue.increment(1) }).catch(() => {});

    const updated = { ...att, status: 'submitted', paper, score: graded.score, max_score: graded.maxScore, score_pct: graded.pct, passed: graded.passed, results_published: !!assess.results_published, pass_mark_pct: num(assess.pass_mark_pct, 50), result_status: resultStatus };
    res.json({
      ok: true,
      message: 'Your answers have been submitted.',
      answered: graded.answered,
      total: graded.total,
      result: resultPayload(updated, assess),
    });
  }));

  app.post(`${P}/my/attempts/:id/events`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = { id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden' });
    const kind = String((req.body && req.body.kind) || 'event');
    const detail = (req.body && req.body.detail) || (req.body && req.body.code) || null;

    await db.collection('attempts').doc(id).collection('events').add({ kind, detail, created_at: new Date().toISOString() });

    let action = 'none';
    let warnings = num(att.warnings, 0);
    if (kind === 'violation' || kind === 'monitor') {
      const lockMode = att.lock_mode || 'strict';
      warnings += 1;
      if (lockMode === 'strict') action = 'block';
      else if (lockMode === 'warn' && warnings >= 2) action = 'block';
      else if (lockMode === 'warn') action = 'warn';
      const updates = { warnings, updated_at: new Date().toISOString() };
      if (action === 'block') updates.status = 'blocked';
      if (kind === 'monitor') updates.monitor_flags = FieldValue.increment(1);
      await db.collection('attempts').doc(id).update(updates);
    }
    res.json({ ok: true, action, warnings, max_warnings: (att.lock_mode === 'warn' ? 2 : att.lock_mode === 'off' ? 0 : 1) });
  }));

  app.post(`${P}/my/attempts/:id/request-review`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = { id: snap.id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden' });
    await db.collection('attempts').doc(req.params.id).update({ review_requested: true });
    res.json({ ok: true });
  }));

  app.get(`${P}/my/attempts/:id/result`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found', message: 'Attempt not found.' });
    const att = { id: snap.id, ...snap.data() };
    if (!(await attemptBelongsToUser(att, req.user))) return res.status(403).json({ error: 'forbidden', message: 'This attempt does not belong to you.' });
    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? normaliseAssessment({ id: att.assessmentId, ...aSnap.data() }) : {};
    res.json(resultPayload(att, assess));
  }));
}

module.exports = { mountQB, normaliseQuestion, normaliseAssessment, flatQuestion };
