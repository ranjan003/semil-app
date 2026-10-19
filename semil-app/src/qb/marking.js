'use strict';
// Candidate-facing question shape, response validation and scoring. Answer keys live only in the stored
// snapshot and are read here on the server; nothing in presentQuestion can leak them.
const r2 = n => Math.round(n * 100) / 100;

class ResponseError extends Error { constructor(m) { super(m); this.name = 'ResponseError'; this.status = 400; this.code = 'bad_response'; } }

// aq: { id, position, snapshot:{question_text,type,options,correct_answer,explanation,reference_answer}, option_order, marks, negative_marks }
function presentQuestion(aq) {
  const s = aq.snapshot;
  return {
    id: aq.id, position: aq.position, type: s.type, text: s.question_text,
    options: s.options ? aq.option_order.map(i => s.options[i]) : null,
    marks: Number(aq.marks), negativeMarks: Number(aq.negative_marks),
  };
}

// Responses are stored as positions in the order shown to this candidate.
function normalizeResponse(aq, raw) {
  const t = aq.snapshot.type;
  if (raw === null || raw === undefined) return null;
  if (t === 'descriptive') {
    if (typeof raw !== 'string') throw new ResponseError('A written answer must be text.');
    if (raw.length > 10000) throw new ResponseError('The answer is too long (maximum 10,000 characters).');
    return raw.replace(/\u0000/g, '');
  }
  const n = aq.option_order.length;
  const okPos = v => Number.isInteger(v) && v >= 0 && v < n;
  if (t === 'mcq') { if (!okPos(raw)) throw new ResponseError('Choose one of the listed options.'); return raw; }
  if (!Array.isArray(raw) || !raw.every(okPos)) throw new ResponseError('Choose from the listed options.');
  const u = [...new Set(raw)].sort((a, b) => a - b);
  return u.length ? u : null;
}

const isAnswered = (aq, resp) => resp !== null && resp !== undefined && !(aq.snapshot.type === 'descriptive' && String(resp).trim() === '');

function markObjective(aq, resp) {
  const t = aq.snapshot.type;
  if (!isAnswered(aq, resp)) return { marks: 0, correct: null };
  const marks = Number(aq.marks), neg = Number(aq.negative_marks);
  const orig = t === 'mcq' ? aq.option_order[resp] : resp.map(p => aq.option_order[p]).sort((a, b) => a - b);
  const key = aq.snapshot.correct_answer;
  const right = t === 'mcq' ? orig === key : orig.length === key.length && orig.every((v, i) => v === key[i]);
  return right ? { marks, correct: true } : { marks: -neg, correct: false };
}

// questions: attempt_questions rows; responses: Map(attempt_question_id -> {response, manual_marks})
function scoreAttempt(questions, responses, { passPct = 0 } = {}) {
  let raw = 0, max = 0, needsReview = false;
  const per = [];
  for (const aq of questions) {
    max += Number(aq.marks);
    const r = responses.get(aq.id) || {};
    let marks = 0, correct = null, status = 'unanswered';
    if (aq.snapshot.type === 'descriptive') {
      if (isAnswered(aq, r.response)) {
        if (r.manual_marks === null || r.manual_marks === undefined) { needsReview = true; status = 'awaiting_review'; }
        else { marks = Math.min(Number(r.manual_marks), Number(aq.marks)); status = 'reviewed'; }
      }
    } else {
      const m = markObjective(aq, r.response);
      marks = m.marks; correct = m.correct; status = m.correct === null ? 'unanswered' : m.correct ? 'correct' : 'wrong';
    }
    raw += marks; per.push({ id: aq.id, position: aq.position, marks: r2(marks), max: Number(aq.marks), correct, status });
  }
  const score = Math.max(0, r2(raw));                   // never below zero
  const pct = max > 0 ? r2(score / max * 100) : 0;
  return { score, max: r2(max), pct, passed: pct >= passPct, resultStatus: needsReview ? 'pending_review' : 'final', perQuestion: per };
}

function validateManualMarks(aq, v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > Number(aq.marks)) throw new ResponseError(`Marks must be between 0 and ${Number(aq.marks)}.`);
  return r2(n);
}

module.exports = { ResponseError, presentQuestion, normalizeResponse, isAnswered, markObjective, scoreAttempt, validateManualMarks };
