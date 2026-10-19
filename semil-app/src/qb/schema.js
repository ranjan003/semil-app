'use strict';
// Column definitions, header aliases and row validation for question uploads and for the admin edit form.
// One validator is used for every path (CSV, XLSX, DOCX and the single-question form), so the rules cannot drift.
const crypto = require('node:crypto');

const COLUMNS = [
  { key: 'question_id',   label: 'question_id',   required: false, help: 'Optional. Your own ID (letters, digits, . _ -). Blank = the system assigns Q-00001, Q-00002 ... An existing ID updates that question when "update existing" is chosen.' },
  { key: 'question_text', label: 'question_text', required: true,  help: '5 to 2000 characters.' },
  { key: 'question_type', label: 'question_type', required: true,  help: 'mcq (one correct answer), multi_select (two or more correct answers) or descriptive (written answer, marked by a reviewer). "aptitude" and "technical" are accepted and read as mcq.' },
  { key: 'option_a',      label: 'option_a',      required: false, help: 'Required for mcq and multi_select.' },
  { key: 'option_b',      label: 'option_b',      required: false, help: 'Required for mcq and multi_select.' },
  { key: 'option_c',      label: 'option_c',      required: false, help: 'Optional.' },
  { key: 'option_d',      label: 'option_d',      required: false, help: 'Optional. Use C before D (no gaps).' },
  { key: 'correct_answer',label: 'correct_answer',required: false, help: 'mcq: one letter, e.g. B. multi_select: letters separated by commas, e.g. A,C. descriptive: optional model answer or marking notes (seen by reviewers only).' },
  { key: 'explanation',   label: 'explanation',   required: false, help: 'Optional. Shown to a candidate only if results review is enabled for the assessment.' },
  { key: 'difficulty',    label: 'difficulty',    required: true,  help: 'easy, medium or hard.' },
  { key: 'job_role',      label: 'job_role',      required: false, help: 'Role code such as SDE or DATA_ANALYST. Blank or ALL = usable for every role.' },
  { key: 'round',         label: 'round',         required: true,  help: 'Interview round number, 1 to 5.' },
  { key: 'topic',         label: 'topic',         required: true,  help: 'Topic or category, e.g. Aptitude, Logical Reasoning, SQL. Up to 60 characters.' },
  { key: 'marks',         label: 'marks',         required: true,  help: 'Marks for a fully correct answer, greater than 0 and at most 100.' },
  { key: 'negative_marks',label: 'negative_marks',required: false, help: 'Optional. Marks deducted for a wrong answer (a positive number, not more than marks). Blank = 0. Not allowed for descriptive questions.' },
  { key: 'status',        label: 'status',        required: false, help: 'active or inactive. Blank = active.' },
];
const REQUIRED_KEYS = COLUMNS.filter(c => c.required).map(c => c.key);

const ALIASES = {
  questionid: 'question_id', id: 'question_id', questioncode: 'question_id', qid: 'question_id', code: 'question_id',
  questiontext: 'question_text', question: 'question_text', text: 'question_text', questions: 'question_text',
  questiontype: 'question_type', type: 'question_type',
  optiona: 'option_a', optionb: 'option_b', optionc: 'option_c', optiond: 'option_d',
  a: 'option_a', b: 'option_b', c: 'option_c', d: 'option_d',
  correctanswer: 'correct_answer', answer: 'correct_answer', correct: 'correct_answer', key: 'correct_answer', answerkey: 'correct_answer', correctoption: 'correct_answer',
  explanation: 'explanation', explain: 'explanation', solution: 'explanation',
  difficulty: 'difficulty', level: 'difficulty', difficultylevel: 'difficulty',
  jobrole: 'job_role', role: 'job_role', rolecode: 'job_role',
  round: 'round', interviewround: 'round', roundnumber: 'round',
  topic: 'topic', category: 'topic', topiccategory: 'topic', categorytopic: 'topic', subject: 'topic',
  marks: 'marks', mark: 'marks', points: 'marks', score: 'marks',
  negativemarks: 'negative_marks', negativemark: 'negative_marks', negative: 'negative_marks', penalty: 'negative_marks',
  status: 'status', active: 'status',
};
const headerKey = h => ALIASES[String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || null;

const TYPE_ALIASES = {
  mcq: 'mcq', singlechoice: 'mcq', single: 'mcq', multiplechoice: 'mcq', singleselect: 'mcq', objective: 'mcq', aptitude: 'mcq', technical: 'mcq',
  multiselect: 'multi_select', multipleselect: 'multi_select', multiplecorrect: 'multi_select', multiple: 'multi_select', msq: 'multi_select', multianswer: 'multi_select',
  descriptive: 'descriptive', subjective: 'descriptive', text: 'descriptive', essay: 'descriptive', shortanswer: 'descriptive', written: 'descriptive',
};
const TYPE_TOPIC_HINT = { aptitude: 'Aptitude', technical: 'Technical' };
const DIFFICULTY = { easy: 'easy', e: 'easy', low: 'easy', medium: 'medium', moderate: 'medium', m: 'medium', hard: 'hard', difficult: 'hard', h: 'hard', high: 'hard' };
const LETTERS = ['A', 'B', 'C', 'D'];

const squash = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const unformula = s => String(s ?? '').replace(/^'(?=[=+\-@])/, '');   // undo the export-time protection prefix
const norm = s => String(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const textHash = (text, type) => crypto.createHash('sha256').update(`${type}|${norm(text)}`).digest('hex');

// raw: { key: string|number|undefined }. Returns { ok, errors:[{field,message}], warnings:[], data }
function validateQuestion(raw, { allowArchived = false } = {}) {
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const get = k => unformula(raw[k] === undefined || raw[k] === null ? '' : String(raw[k]));
  const data = {};

  // ---- id
  const id = get('question_id').trim();
  if (id) { if (/^[A-Za-z0-9._-]{1,40}$/.test(id)) data.question_code = id; else err('question_id', 'Question ID may only use letters, digits, dot, underscore and hyphen (max 40).'); }
  else data.question_code = null;

  // ---- text
  const text = squash(get('question_text'));
  if (!text) err('question_text', 'Question text is required.');
  else if (text.length < 5) err('question_text', 'Question text is too short (minimum 5 characters).');
  else if (text.length > 2000) err('question_text', 'Question text is too long (maximum 2000 characters).');
  else data.question_text = text;

  // ---- type
  const typeRaw = get('question_type').trim();
  const typeToken = typeRaw.toLowerCase().replace(/[^a-z]/g, '');
  let type = null;
  if (!typeRaw) err('question_type', 'Question type is required (mcq, multi_select or descriptive).');
  else if (!(typeToken in TYPE_ALIASES)) err('question_type', `Unknown question type "${typeRaw}". Use mcq, multi_select or descriptive.`);
  else type = TYPE_ALIASES[typeToken];
  if (type) data.type = type;

  // ---- options and answer
  const opts = LETTERS.map(l => squash(get('option_' + l.toLowerCase())));
  const answerRaw = get('correct_answer').trim();
  if (type === 'mcq' || type === 'multi_select') {
    let last = -1;
    opts.forEach((o, i) => { if (o) last = i; });
    const used = opts.slice(0, last + 1);
    if (!opts[0] || !opts[1]) err('options', 'Options A and B are required.');
    else if (used.some(o => !o)) err('options', 'Options must be filled in order: do not leave a gap before a later option.');
    else {
      const lowered = used.map(o => o.toLowerCase());
      if (new Set(lowered).size !== lowered.length) err('options', 'Two options have the same text.');
      else if (used.some(o => o.length > 500)) err('options', 'An option is longer than 500 characters.');
      else data.options = used;
    }
    if (!answerRaw) err('correct_answer', 'Correct answer is required.');
    else if (data.options) {
      const parts = answerRaw.toUpperCase().split(/[\s,;|/&+]+/).filter(Boolean).flatMap(p => (/^[A-D]{2,4}$/.test(p) && type === 'multi_select') ? p.split('') : [p]);
      const bad = parts.filter(p => !LETTERS.slice(0, data.options.length).includes(p));
      if (bad.length) err('correct_answer', `Answer "${bad.join(', ')}" does not match an available option (${LETTERS.slice(0, data.options.length).join(', ')}).`);
      else {
        const idx = [...new Set(parts.map(p => LETTERS.indexOf(p)))].sort((a, b) => a - b);
        if (type === 'mcq') { if (idx.length !== 1) err('correct_answer', 'An mcq question must have exactly one correct answer. Use multi_select for several.'); else data.correct_answer = idx[0]; }
        else { if (idx.length < 2) err('correct_answer', 'A multi_select question needs two or more correct answers (e.g. A,C). Use mcq for a single answer.'); else data.correct_answer = idx; }
      }
    }
  } else if (type === 'descriptive') {
    if (opts.some(Boolean)) err('options', 'Descriptive questions cannot have options.');
    data.options = null; data.correct_answer = null;
    data.reference_answer = answerRaw ? squash(answerRaw).slice(0, 4000) : null;
  }
  if (type !== 'descriptive') data.reference_answer = null;

  // ---- explanation
  const ex = squash(get('explanation'));
  if (ex.length > 2000) err('explanation', 'Explanation is longer than 2000 characters.'); else data.explanation = ex || null;

  // ---- difficulty
  const dRaw = get('difficulty').trim().toLowerCase();
  if (!dRaw) err('difficulty', 'Difficulty is required (easy, medium or hard).');
  else if (!DIFFICULTY[dRaw]) err('difficulty', `Unknown difficulty "${get('difficulty').trim()}". Use easy, medium or hard.`);
  else data.difficulty = DIFFICULTY[dRaw];

  // ---- role
  const roleRaw = get('job_role').trim();
  if (!roleRaw || /^(all|any|general|common|\*)$/i.test(roleRaw)) data.role_code = null;
  else {
    const role = roleRaw.toUpperCase().replace(/[\s-]+/g, '_');
    if (/^[A-Z0-9_]{2,20}$/.test(role)) data.role_code = role; else err('job_role', 'Job role must be a role code of 2 to 20 letters, digits or underscores (e.g. SDE), or blank for all roles.');
  }

  // ---- round
  const rRaw = get('round').trim();
  const rm = /^(?:round|r)?\s*([1-5])(?:\.0+)?$/i.exec(rRaw);
  if (!rRaw) err('round', 'Round is required (1 to 5).');
  else if (!rm) err('round', `Round "${rRaw}" is not valid. Use a number from 1 to 5.`);
  else data.round = parseInt(rm[1], 10);

  // ---- topic
  let topic = squash(get('topic')).replace(/\n/g, ' ');
  if (!topic && typeToken in TYPE_TOPIC_HINT) topic = TYPE_TOPIC_HINT[typeToken];
  if (!topic) err('topic', 'Topic / category is required.');
  else if (topic.length > 60) err('topic', 'Topic is longer than 60 characters.');
  else data.topic = topic;

  // ---- marks
  const num = (s) => { s = s.trim().replace(/^(\d+),(\d{1,2})$/, '$1.$2'); return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN; };
  const mRaw = get('marks');
  const marks = mRaw.trim() === '' ? NaN : num(mRaw);
  if (mRaw.trim() === '') err('marks', 'Marks are required.');
  else if (!(marks > 0 && marks <= 100)) err('marks', 'Marks must be a number greater than 0 and at most 100 (up to 2 decimals).');
  else data.marks = marks;

  const nRaw = get('negative_marks').trim();
  if (nRaw === '') data.negative_marks = 0;
  else {
    const neg = num(nRaw.replace(/^-/, ''));
    if (Number.isNaN(neg)) err('negative_marks', 'Negative marks must be a number such as 0.5.');
    else if (type === 'descriptive' && neg > 0) err('negative_marks', 'Descriptive questions cannot carry negative marks.');
    else if (data.marks !== undefined && neg > data.marks) err('negative_marks', 'Negative marks cannot be more than the question marks.');
    else { data.negative_marks = neg; if (/^-/.test(nRaw)) warnings.push({ field: 'negative_marks', message: 'Entered as a negative number; read as a deduction of ' + neg + '.' }); }
  }

  // ---- status
  const sRaw = get('status').trim().toLowerCase();
  if (!sRaw || ['active', 'yes', 'y', 'true', '1', 'enabled'].includes(sRaw)) data.status = 'active';
  else if (['inactive', 'no', 'n', 'false', '0', 'disabled'].includes(sRaw)) data.status = 'inactive';
  else if (sRaw === 'archived' && allowArchived) data.status = 'archived';
  else err('status', `Status "${get('status').trim()}" is not valid. Use active or inactive.`);

  if (text && type && !errors.some(e => e.field === 'question_text' || e.field === 'question_type')) data.text_hash = textHash(text, type);
  data.shuffle_options = !(data.options && data.options.some(o => /\b(all|none|both|neither)\s+of\s+the\s+(above|these)\b|\b(a|b|c|d)\s+(and|&)\s+(a|b|c|d)\b/i.test(o)));
  return { ok: errors.length === 0, errors, warnings, data };
}

// Library row -> the flat object the edit form and exports use
function toFlat(q) {
  const o = q.options || [];
  const ans = q.type === 'mcq' ? LETTERS[q.correct_answer] : q.type === 'multi_select' ? (q.correct_answer || []).map(i => LETTERS[i]).join(',') : (q.reference_answer || '');
  return {
    question_id: q.question_code, question_text: q.question_text, question_type: q.type,
    option_a: o[0] || '', option_b: o[1] || '', option_c: o[2] || '', option_d: o[3] || '',
    correct_answer: ans, explanation: q.explanation || '', difficulty: q.difficulty, job_role: q.role_code || '',
    round: q.round, topic: q.topic, marks: Number(q.marks), negative_marks: Number(q.negative_marks), status: q.status,
  };
}

// ---- templates ----
const SAMPLE_ROWS = [
  ['SAMPLE-001', 'A train 120 m long passes a pole in 6 seconds. What is its speed in km/h?', 'mcq', '72', '20', '60', '80', 'A', 'Speed = 120 / 6 = 20 m/s = 20 x 3.6 = 72 km/h.', 'medium', 'ALL', 1, 'Aptitude', 2, 0.5, 'active'],
  ['SAMPLE-002', 'Which of these HTTP methods are safe (read-only)? Select all that apply.', 'multi_select', 'GET', 'POST', 'HEAD', 'DELETE', 'A,C', 'GET and HEAD do not change server state.', 'easy', 'SDE', 2, 'Technical', 3, 1, 'active'],
  ['SAMPLE-003', 'Find the next number in the series: 2, 6, 12, 20, ?', 'mcq', '28', '30', '32', '36', 'B', 'Differences are 4, 6, 8, 10, so the next term is 20 + 10 = 30.', 'easy', 'ALL', 1, 'Logical Reasoning', 1, 0, 'active'],
  ['SAMPLE-004', 'Which SQL clause filters groups after aggregation?', 'mcq', 'WHERE', 'HAVING', 'GROUP BY', 'ORDER BY', 'B', '', 'medium', 'DATA_ANALYST', 3, 'SQL', 2, 0.5, 'active'],
  ['SAMPLE-005', 'Describe a time you handled a disagreement in a team. What was the outcome?', 'descriptive', '', '', '', '', 'Look for a specific example, the candidate\'s own role, how it was resolved and what they learned.', '', 'medium', 'ALL', 5, 'Behavioural', 5, '', 'active'],
];
const IS_SAMPLE = id => /^SAMPLE-/i.test(String(id || '').trim());

const ENUMS = { question_type: ['mcq', 'multi_select', 'descriptive'], difficulty: ['easy', 'medium', 'hard'], round: ['1', '2', '3', '4', '5'], status: ['active', 'inactive'] };

module.exports = { COLUMNS, REQUIRED_KEYS, headerKey, validateQuestion, toFlat, textHash, norm, SAMPLE_ROWS, IS_SAMPLE, ENUMS, LETTERS };
