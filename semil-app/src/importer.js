'use strict';
// Question import for all five rounds. Accepts CSV or JSON, checks every row, and reports problems by
// row number so an admin can fix the file and retry. Nothing is saved until the admin confirms.
// Excel files: save as CSV first.

const KIND = { mcq: 'mc', multi: 'ms', short: 'sa', long: 'la', scenario: 'la', upload: 'fu' };
const MAX_ROWS = 500;
const MAX_CHARS = 1048576;
const LETTERS = ['A', 'B', 'C', 'D'];

function impParseCsv(text) {
  const rows = []; let row = [], cur = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return { rows: rows.filter(r => r.some(c => String(c).trim() !== '')), unclosed: quoted };
}

function impNormalizeJson(v) {
  if (!v || typeof v !== 'object') return {};
  const o = {};
  for (const k of Object.keys(v)) o[String(k).toLowerCase()] = Array.isArray(v[k]) ? v[k].join(';') : (v[k] == null ? '' : String(v[k]).trim());
  if (Array.isArray(v.options)) v.options.slice(0, 4).forEach((x, i) => { o['option_' + 'abcd'[i]] = String(x == null ? '' : x).trim(); });
  return o;
}

function impCheckRow(v) {
  const errors = [];
  const round = Number(v.round);
  if (!Number.isInteger(round) || round < 1 || round > 5) errors.push('Round must be 1 to 5');
  const type = String(v.type || '').toLowerCase();
  const k = KIND[type];
  if (!k) errors.push('Type must be one of: ' + Object.keys(KIND).join(', '));
  const t = String(v.question || '').trim();
  if (t.length < 5) errors.push('Question text is missing or too short');
  if (t.length > 2000) errors.push('Question text is longer than 2000 characters');
  const marks = v.marks === '' || v.marks == null ? 1 : Number(v.marks);
  if (!Number.isFinite(marks) || marks <= 0 || marks > 100) errors.push('Marks must be a number from 1 to 100');
  const diff = String(v.difficulty || '').toLowerCase();
  if (diff && !['easy', 'medium', 'hard'].includes(diff)) errors.push('Difficulty must be easy, medium or hard');
  let o = [], a = [];
  if (k === 'mc' || k === 'ms') {
    const opts = [v.option_a, v.option_b, v.option_c, v.option_d].map(x => String(x || '').trim());
    let n = opts.length; while (n > 0 && !opts[n - 1]) n--;
    o = opts.slice(0, n);
    if (o.length < 2) errors.push('Give at least two options (option_a, option_b ...)');
    else if (o.some(x => !x)) errors.push('Fill the options in order without gaps');
    const letters = [...new Set(String(v.correct || '').toUpperCase().match(/[A-D]/g) || [])];
    if (!letters.length) errors.push('Mark the correct answer (A to D)');
    else {
      a = letters.map(l => LETTERS.indexOf(l)).sort();
      if (a.some(i => i >= o.length)) errors.push('The correct answer points to an empty option');
      if (k === 'mc' && a.length !== 1) errors.push('Single-choice questions need exactly one correct answer');
      if (k === 'ms' && a.length < 2) errors.push('Multi-select questions need two or more correct answers');
    }
  }
  return { errors, q: { round, k, t, o, a, m: marks, diff } };
}

function impParse(text, filename) {
  const res = { rows: [], fatal: null, summary: null };
  const s = String(text || '');
  if (!s.trim()) { res.fatal = 'The file is empty.'; return res; }
  if (s.length > MAX_CHARS) { res.fatal = 'The file is larger than 1 MB. Split it into smaller files.'; return res; }
  let recs;
  if (/\.json$/i.test(filename || '') || /^\s*[\[{]/.test(s)) {
    let j; try { j = JSON.parse(s); } catch (e) { res.fatal = 'This is not valid JSON.'; return res; }
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.questions) ? j.questions : null);
    if (!list) { res.fatal = 'JSON must be a list of questions, or an object with a "questions" list.'; return res; }
    recs = list.map((v, i) => ({ line: i + 1, v: impNormalizeJson(v) }));
  } else {
    const p = impParseCsv(s);
    if (p.unclosed) { res.fatal = 'A quoted value is not closed. Look for a missing " in the file.'; return res; }
    const head = p.rows[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
    const miss = ['round', 'type', 'question'].filter(h => !head.includes(h));
    if (miss.length) { res.fatal = 'Missing column(s): ' + miss.join(', ') + '. The first row must be the header.'; return res; }
    recs = p.rows.slice(1).map((r, i) => ({ line: i + 2, v: Object.fromEntries(head.map((h, j) => [h, String(r[j] == null ? '' : r[j]).trim()])) }));
  }
  if (!recs.length) { res.fatal = 'No questions found under the header.'; return res; }
  if (recs.length > MAX_ROWS) { res.fatal = `The file has ${recs.length} questions. The limit is ${MAX_ROWS} per import.`; return res; }
  const seen = new Map();
  for (const { line, v } of recs) {
    const { errors, q } = impCheckRow(v);
    const key = q.round + '|' + q.t.toLowerCase().replace(/\s+/g, ' ');
    if (!errors.length) {
      if (seen.has(key)) errors.push('Duplicate of row ' + seen.get(key));
      else seen.set(key, line);
    }
    res.rows.push({ line, ok: errors.length === 0, errors, q });
  }
  const valid = res.rows.filter(r => r.ok);
  const byRound = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  valid.forEach(r => { byRound[r.q.round]++; });
  res.summary = { total: res.rows.length, valid: valid.length, invalid: res.rows.length - valid.length, byRound };
  return res;
}

module.exports = { KIND, MAX_ROWS, impParseCsv, impParse, impCheckRow };
