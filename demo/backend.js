'use strict';
// In-browser stand-in for the Semil server, used only by the single-file demo page.
// It reuses the real validation, import, templates, randomisation and marking modules; only storage (memory +
// localStorage instead of PostgreSQL) and the HTTP layer are replaced. The real server is in src/qb/service.js etc.
const { validateQuestion, toFlat, COLUMNS, LETTERS } = require('../semil-app/src/qb/schema');
const importer = require('../semil-app/src/qb/importer');
const R = require('../semil-app/src/qb/random');
const M = require('../semil-app/src/qb/marking');
const P = require('../semil-app/src/proctoring');
const U = require('../semil-app/src/qb/util');
const { buildTemplate, MIMES } = require('../semil-app/src/qb/templates');
const { writeCsv } = require('../semil-app/src/qb/csv');
const { writeXlsx } = require('../semil-app/src/qb/xlsx');
const { Buffer } = require('./shims/buffer.js');
const { seedData } = require('./seed.js');

const KEY = 'semil_demo_v1';
const uid = () => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const nowIso = () => new Date().toISOString();
const SAVE_GRACE_MS = 5000;

let S = null;
function load() {
  try { const t = localStorage.getItem(KEY); if (t) { S = JSON.parse(t); return; } } catch { /* storage unavailable */ }
  if (!S) S = seedData(uid);
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* ignore */ } }
function reset() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } S = seedData(uid); save(); }
load();

const ROLE_CAPS = {
  super_admin: ['*'],
  hr_admin: ['qbank:read', 'qbank:write', 'qbank:import', 'assessment:publish', 'assessment:assign', 'results:read', 'results:publish', 'stage:change', 'candidate:read'],
  candidate: ['attempt:own'],
};
const can = (u, c) => !!u && (ROLE_CAPS[u.role] || []).some(x => x === '*' || x === c);
const err = (status, error, message) => ({ status, json: { error, message } });
const ok = (json, status = 200) => ({ status, json });

function audit(user, action, type, id, before, after) {
  S.audit.unshift({ id: S.audit.length ? S.audit[0].id + 1 : 1, action, entity_type: type, entity_id: String(id), before: before ?? null, after: after ?? null, created_at: nowIso(), actor_role: user ? user.role : null, actor: user ? user.full_name : null });
  if (S.audit.length > 1000) S.audit.length = 1000;
}

// ---------------------------------------------------------------- helpers
const qOut = r => { const o = { ...r, marks: Number(r.marks), negative_marks: Number(r.negative_marks), round: Number(r.round), version: Number(r.version) }; delete o.versions; delete o.text_hash; o.flat = toFlat(o); return o; };
const qList = r => { const o = qOut(r); delete o.flat; return o; };
const snapshotOf = r => ({ question_code: r.question_code, question_text: r.question_text, type: r.type, options: r.options, correct_answer: r.correct_answer, difficulty: r.difficulty, role_code: r.role_code, round: r.round, topic: r.topic, marks: r.marks, negative_marks: r.negative_marks, status: r.status });
function nextCode() { let n = S.counters.q; for (;;) { const c = 'Q-' + String(n).padStart(5, '0'); n++; if (!S.questions.some(q => q.question_code.toLowerCase() === c.toLowerCase())) { S.counters.q = n; return c; } } }
const live = q => q.status !== 'archived';
const icontains = (s, t) => String(s).toLowerCase().includes(String(t).toLowerCase());
function sortBy(arr, ...keys) { return arr.sort((a, b) => { for (const [k, d] of keys) { const x = typeof k === 'function' ? k(a) : a[k], y = typeof k === 'function' ? k(b) : b[k]; if (x < y) return -d; if (x > y) return d; } return 0; }); }

function filterQuestions(q) {
  let r = S.questions;
  if (q.q) { const t = String(q.q).slice(0, 100); r = r.filter(x => icontains(x.question_text, t) || icontains(x.question_code, t) || icontains(x.topic, t)); }
  if (q.round) r = r.filter(x => x.round === U.int(q.round, 'round', { min: 1, max: 5 }));
  if (q.type) { U.oneOf(q.type, 'type', ['mcq', 'multi_select', 'descriptive']); r = r.filter(x => x.type === q.type); }
  if (q.difficulty) { U.oneOf(q.difficulty, 'difficulty', ['easy', 'medium', 'hard']); r = r.filter(x => x.difficulty === q.difficulty); }
  if (q.role) r = String(q.role).toUpperCase() === 'ALL' ? r.filter(x => !x.role_code) : r.filter(x => x.role_code === String(q.role).toUpperCase());
  if (q.topic) r = r.filter(x => x.topic.toLowerCase() === String(q.topic).toLowerCase());
  const st = q.status || 'live';
  if (st === 'live') r = r.filter(live); else if (st !== 'all') { U.oneOf(st, 'status', ['active', 'inactive', 'archived']); r = r.filter(x => x.status === st); }
  return r;
}
const SORTS = { updated: [['updated_at', -1]], created: [['created_at', -1]], code: [['question_code', 1]], round: [['round', 1], ['topic', 1], ['difficulty', 1]], topic: [['topic', 1], ['question_code', 1]] };
const fail = v => U.bad(v.errors.map(e => e.message).join(' '), v.errors.map(e => ({ path: e.field, message: e.message })));
const dupOf = (d, exceptId) => S.questions.find(x => x.round === d.round && x.text_hash === d.text_hash && live(x) && x.id !== exceptId);
const FIELDS = ['question_text', 'type', 'options', 'correct_answer', 'reference_answer', 'explanation', 'difficulty', 'role_code', 'round', 'topic', 'marks', 'negative_marks', 'shuffle_options', 'status', 'text_hash'];
const pick = (d) => { const o = {}; for (const k of FIELDS) o[k] = d[k] ?? null; return o; };

// ---------------------------------------------------------------- question bank
const svc = {
  meta() {
    const topics = {}; for (const q of S.questions.filter(live)) { const k = q.round + '|' + q.topic; topics[k] = (topics[k] || 0) + 1; }
    const tl = Object.entries(topics).map(([k, n]) => { const [round, topic] = k.split('|'); return { round: Number(round), topic, n }; });
    sortBy(tl, ['round', 1], ['topic', 1]);
    const roles = [...new Set([...S.questions.map(q => q.role_code).filter(Boolean), ...S.candidates.map(c => c.role_code)])].sort();
    return { topics: tl, roles, rounds: S.rounds.map(r => ({ round: r.round, name: r.name, enabled: r.enabled, published: r.published })), types: ['mcq', 'multi_select', 'descriptive'], difficulties: ['easy', 'medium', 'hard'], columns: COLUMNS.map(c => ({ key: c.key, required: c.required, help: c.help })) };
  },
  pool(q) {
    const round = U.int(q.round, 'round', { min: 1, max: 5 }); const role = q.role ? String(q.role).toUpperCase() : null;
    const m = {}; for (const x of S.questions) if (x.round === round && x.status === 'active' && (!x.role_code || x.role_code === role)) { const k = x.topic + '|' + x.difficulty; m[k] = (m[k] || 0) + 1; }
    const cells = Object.entries(m).map(([k, n]) => { const [topic, difficulty] = k.split('|'); return { topic, difficulty, n }; });
    sortBy(cells, ['topic', 1], ['difficulty', 1]);
    return { round, role, cells };
  },
  list(q) {
    const pg = U.page(q); const r = filterQuestions(q); const s = SORTS[q.sort] || SORTS.updated;
    sortBy(r, ...s, ['id', 1]);
    return { items: r.slice(pg.offset, pg.offset + pg.per).map(qList), total: r.length, page: pg.page, per: pg.per };
  },
  get(id) {
    U.uuid(id); const r = S.questions.find(x => x.id === id); if (!r) throw U.notFound();
    const versions = [...r.versions].reverse().slice(0, 20).map(v => ({ version: v.version, change_note: v.change_note, changed_at: v.changed_at, changed_by: v.changed_by }));
    return { ...qOut(r), versions, times_issued: S.attempts.reduce((n, a) => n + a.qs.filter(x => x.question_code === r.question_code).length, 0) };
  },
  create(u, body) {
    const v = validateQuestion(body || {}); if (!v.ok) throw fail(v); const d = v.data;
    if (d.question_code && S.questions.some(x => x.question_code.toLowerCase() === d.question_code.toLowerCase())) throw new U.ServiceError(409, 'duplicate_id', `Question ID "${d.question_code}" is already used.`);
    const dup = dupOf(d); if (dup) throw new U.ServiceError(409, 'duplicate_question', `The same question text already exists in round ${d.round} as ${dup.question_code}.`, { existing: { id: dup.id, question_code: dup.question_code } });
    const t = nowIso();
    const r = { id: uid(), question_code: d.question_code || nextCode(), ...pick(d), version: 1, import_batch_id: null, created_at: t, updated_at: t, versions: [] };
    r.versions.push({ version: 1, change_note: 'Created', changed_at: t, changed_by: u.full_name });
    S.questions.push(r); audit(u, 'qb.question.create', 'question', r.question_code, null, { round: r.round, topic: r.topic, type: r.type });
    return qOut(r);
  },
  update(u, id, body) {
    U.uuid(id); const cur = S.questions.find(x => x.id === id); if (!cur) throw U.notFound();
    if (cur.status === 'archived') throw new U.ServiceError(409, 'archived', 'This question is archived. Restore it before editing.');
    const merged = { ...toFlat(qOut(cur)), ...(body || {}) };
    if (body && body.question_id !== undefined && String(body.question_id).trim().toLowerCase() !== cur.question_code.toLowerCase()) throw U.bad('The question ID cannot be changed.', [{ path: 'question_id', message: 'Cannot be changed' }]);
    merged.question_id = cur.question_code;
    const v = validateQuestion(merged); if (!v.ok) throw fail(v); const d = v.data;
    const dup = dupOf(d, id); if (dup) throw new U.ServiceError(409, 'duplicate_question', `The same question text already exists in round ${d.round} as ${dup.question_code}.`, { existing: { id: dup.id, question_code: dup.question_code } });
    const before = snapshotOf(cur); Object.assign(cur, pick(d)); cur.version++; cur.updated_at = nowIso();
    cur.versions.push({ version: cur.version, change_note: String((body && body.change_note) || 'Edited').slice(0, 200), changed_at: cur.updated_at, changed_by: u.full_name });
    audit(u, 'qb.question.update', 'question', cur.question_code, before, snapshotOf(cur));
    return qOut(cur);
  },
  setStatus(u, ids, status) {
    U.oneOf(status, 'status', ['active', 'inactive', 'archived']);
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw U.bad('Select between 1 and 500 questions.');
    ids.forEach(i => U.uuid(i));
    const cur = ids.map(i => S.questions.find(x => x.id === i)); if (cur.some(x => !x)) throw U.notFound();
    const changed = cur.filter(q => q.status !== status);
    for (const q of changed) if (status !== 'archived' && S.questions.some(o => o.id !== q.id && o.round === q.round && o.text_hash === q.text_hash && live(o))) throw new U.ServiceError(409, 'duplicate_question', `${q.question_code} cannot be restored because an active question with the same text already exists in its round.`);
    for (const q of changed) { q.status = status; q.updated_at = nowIso(); }
    if (changed.length) audit(u, `qb.question.${status === 'archived' ? 'archive' : status === 'active' ? 'activate' : 'deactivate'}`, 'question', changed.map(q => q.question_code).slice(0, 20).join(','), null, { status, count: changed.length });
    return { updated: changed.length, unchanged: cur.length - changed.length };
  },
  exportQuestions(u, q) {
    const format = U.oneOf(q.format || 'xlsx', 'format', ['csv', 'xlsx']);
    const head = [...COLUMNS.map(c => c.label), 'version', 'last_updated'];
    const rows = filterQuestions(q); sortBy(rows, ['round', 1], ['topic', 1], ['question_code', 1]);
    const data = rows.map(r => { const f = toFlat(qOut(r)); return [...COLUMNS.map(c => f[c.key]), r.version, String(r.updated_at).slice(0, 10)]; });
    audit(u, 'qb.export', 'question', 'bank', null, { rows: rows.length, format });
    const stamp = nowIso().slice(0, 10);
    if (format === 'csv') return { body: Buffer.from(writeCsv([head, ...data]), 'utf8'), mime: MIMES.csv, fileName: `semil-question-bank-${stamp}.csv` };
    return { body: writeXlsx([{ name: 'Questions', rows: [head, ...data], widths: [14, 60, 14, 22, 22, 22, 22, 18, 40, 11, 16, 8, 20, 8, 15, 10, 8, 12] }]), mime: MIMES.xlsx, fileName: `semil-question-bank-${stamp}.xlsx` };
  },

  // ---- import
  existingFor() {
    const ex = { byCode: new Map(), byHash: new Map() };
    for (const r of S.questions) { const rec = { id: r.id, code: r.question_code, status: r.status, round: r.round }; ex.byCode.set(r.question_code.toLowerCase(), rec); if (r.status !== 'archived') ex.byHash.set(`${r.round}|${r.text_hash}`, rec); }
    return ex;
  },
  previewImport(u, { buffer, fileName, mime, onConflict }) {
    const oc = U.oneOf(onConflict || 'skip', 'on_conflict', ['skip', 'update']);
    const format = importer.checkUpload({ buffer, fileName, mime });
    const parsed = importer.parseFile(buffer, format);
    const first = importer.buildPreview(parsed, undefined, oc);
    if (first.fileErrors.length) return { batchId: null, format, fileName, fileErrors: first.fileErrors, warnings: first.warnings, summary: first.summary, rows: [] };
    const plan = importer.buildPreview(parsed, svc.existingFor(), oc);
    const sha = importer.sha256(buffer);
    const prior = S.batches.find(b => b.file_sha256 === sha && b.status === 'committed');
    if (prior) plan.warnings.push(`This exact file was already imported on ${prior.committed_at.slice(0, 10)}. Importing it again will skip every existing question.`);
    const b = { id: uid(), created_by: u.id, created_by_name: u.full_name, file_name: String(fileName).slice(0, 200), file_format: format, file_sha256: sha, on_conflict: oc, rows: plan.rows, summary: { ...plan.summary, warnings: plan.warnings }, status: 'previewed', result: null, created_at: nowIso(), committed_at: null, expires_at: new Date(Date.now() + 7200000).toISOString() };
    S.batches.unshift(b); audit(u, 'qb.import.preview', 'import_batch', b.id, null, { file: fileName, format, ...plan.summary });
    return { batchId: b.id, expiresAt: b.expires_at, format, fileName, fileErrors: [], warnings: plan.warnings, summary: plan.summary, rows: pageRows(plan.rows, {}) };
  },
  getBatch(u, id, q = {}) { const b = loadBatch(u, id); const pg = U.page(q, { per: 100, maxPer: 200 }); return { batchId: b.id, fileName: b.file_name, format: b.file_format, status: b.status, onConflict: b.on_conflict, expiresAt: b.expires_at, summary: b.summary, result: b.result, rows: pageRows(b.rows, { status: q.status, page: pg.page, per: pg.per }) }; },
  listBatches() { return { items: S.batches.slice(0, 50).map(b => ({ id: b.id, file_name: b.file_name, file_format: b.file_format, status: b.status, summary: b.summary, result: b.result, created_at: b.created_at, committed_at: b.committed_at, created_by: b.created_by_name })) }; },
  cancelBatch(u, id) { const b = loadBatch(u, id); if (b.status !== 'previewed') throw new U.ServiceError(409, 'not_pending', `This import is already ${b.status}.`); b.status = 'cancelled'; audit(u, 'qb.import.cancel', 'import_batch', id); return { ok: true }; },
  commitImport(u, id) {
    const b = loadBatch(u, id);
    if (b.status === 'committed') throw new U.ServiceError(409, 'already_committed', 'This import was already completed.', { result: b.result });
    if (b.status !== 'previewed') throw new U.ServiceError(409, 'not_pending', `This import was ${b.status}.`);
    if (new Date(b.expires_at) < new Date()) throw new U.ServiceError(410, 'expired', 'This preview expired. Upload the file again.');
    const todo = b.rows.filter(r => r.status === 'new' || r.status === 'update');
    if (!todo.length) throw U.bad('There are no valid rows to import.');
    const res = { created: 0, updated: 0, skipped: 0, skippedRows: [], codes: [] };
    for (const it of todo) {
      const d = it.data; const existing = d.question_code ? S.questions.find(x => x.question_code.toLowerCase() === d.question_code.toLowerCase()) : null;
      if (existing && (b.on_conflict !== 'update' || existing.status === 'archived')) { res.skipped++; res.skippedRows.push({ row: it.row, reason: existing.status === 'archived' ? 'ID belongs to an archived question' : 'ID already exists' }); continue; }
      if (existing) {
        if (dupOf(d, existing.id)) { res.skipped++; res.skippedRows.push({ row: it.row, reason: 'Same wording now exists in that round' }); continue; }
        Object.assign(existing, pick(d)); existing.version++; existing.updated_at = nowIso(); existing.versions.push({ version: existing.version, change_note: `Updated by import ${b.file_name}`.slice(0, 200), changed_at: existing.updated_at, changed_by: u.full_name });
        res.updated++; res.codes.push(existing.question_code); continue;
      }
      if (dupOf(d) || (d.question_code && S.questions.some(x => x.question_code.toLowerCase() === d.question_code.toLowerCase()))) { res.skipped++; res.skippedRows.push({ row: it.row, reason: 'Created by someone else while you were reviewing' }); continue; }
      const t = nowIso(); const r = { id: uid(), question_code: d.question_code || nextCode(), ...pick(d), version: 1, import_batch_id: b.id, created_at: t, updated_at: t, versions: [{ version: 1, change_note: `Imported from ${b.file_name}`.slice(0, 200), changed_at: t, changed_by: u.full_name }] };
      S.questions.push(r); res.created++; res.codes.push(r.question_code);
    }
    const result = { created: res.created, updated: res.updated, skipped: res.skipped + (b.rows.length - todo.length), skippedRows: res.skippedRows.slice(0, 50), codes: res.codes.slice(0, 50) };
    b.status = 'committed'; b.committed_at = nowIso(); b.result = result;
    audit(u, 'qb.import.commit', 'import_batch', id, null, { file: b.file_name, created: result.created, updated: result.updated, skipped: result.skipped });
    return result;
  },

  // ---- rounds
  listRounds() { return { items: S.rounds.map(r => ({ ...r, active_questions: S.questions.filter(q => q.round === r.round && q.status === 'active').length, live_assessments: S.assessments.filter(a => a.round === r.round && a.status === 'active').length })) }; },
  updateRound(u, n, b = {}) {
    const round = U.int(n, 'round', { min: 1, max: 5 }); const cur = S.rounds.find(r => r.round === round); if (!cur) throw U.notFound();
    const e = b.eligibility === undefined ? cur.eligibility : b.eligibility;
    if (!e || typeof e !== 'object' || typeof e.require_stage !== 'boolean' || !(e.min_previous_pct === null || (typeof e.min_previous_pct === 'number' && e.min_previous_pct >= 0 && e.min_previous_pct <= 100))) throw U.bad('Eligibility must be { require_stage: true|false, min_previous_pct: null or 0-100 }.');
    const nv = {
      name: b.name === undefined ? cur.name : U.str(b.name, 'name', { min: 2, max: 80 }),
      description: b.description === undefined ? cur.description : U.str(b.description, 'description', { max: 500, optional: true }),
      enabled: b.enabled === undefined ? cur.enabled : U.bool(b.enabled, 'enabled'),
      published: b.published === undefined ? cur.published : U.bool(b.published, 'published'),
      duration_minutes: b.duration_minutes === undefined ? cur.duration_minutes : U.int(b.duration_minutes, 'duration_minutes', { min: 1, max: 480 }),
      pass_threshold_pct: b.pass_threshold_pct === undefined ? cur.pass_threshold_pct : U.num(b.pass_threshold_pct, 'pass_threshold_pct', { min: 0, max: 100 }),
      eligibility: { require_stage: e.require_stage, min_previous_pct: e.min_previous_pct },
    };
    if (nv.published && !nv.enabled) throw U.bad('A round must be enabled before it can be published.');
    const before = { ...cur }; Object.assign(cur, nv, { updated_at: nowIso() }); audit(u, 'qb.round.update', 'round', round, before, { ...cur });
    return { ...cur };
  },
};
function pageRows(rows, { status, page = 1, per = 100 }) {
  let r = rows;
  if (status && status !== 'all') r = r.filter(x => x.status === status); else if (!status) r = [...rows.filter(x => x.status === 'error'), ...rows.filter(x => x.status !== 'error')];
  const start = (Math.max(1, page) - 1) * per;
  return r.slice(start, start + per).map(x => ({ row: x.row, status: x.status, errors: x.errors, warnings: x.warnings, existing: x.existing, preview: x.data ? previewOf(x.data) : null }));
}
function previewOf(d) {
  return { question_code: d.question_code, question_text: d.question_text, type: d.type, options: d.options, answer: d.type === 'mcq' ? LETTERS[d.correct_answer] : d.type === 'multi_select' ? (d.correct_answer || []).map(i => LETTERS[i]).join(',') : null, difficulty: d.difficulty, role_code: d.role_code, round: d.round, topic: d.topic, marks: d.marks, negative_marks: d.negative_marks, status: d.status };
}
function loadBatch(u, id) { U.uuid(id); const b = S.batches.find(x => x.id === id); if (!b || (b.created_by !== u.id && u.role !== 'super_admin')) throw U.notFound(); return b; }

// ---------------------------------------------------------------- assessments
const POLICIES = ['hidden', 'score', 'score_and_review'], LOCKS = ['strict', 'warn', 'off'], ROLE_RE = /^[A-Z0-9_]{2,20}$/;
const aOut = a => ({ ...a, round: Number(a.round), roles: a.roles || [], rules: a.rules || [] });
function poolFor(round) { return S.questions.filter(q => q.round === round && q.status === 'active').map(r => ({ question_code: r.question_code, topic: r.topic, difficulty: r.difficulty, role_code: r.role_code, status: r.status, marks: Number(r.marks) })); }
function availabilityReport(pool, rules, roles) {
  const targets = roles.length ? roles : [null]; const per = targets.map(role => ({ role, rules: R.availability(pool, rules, role) }));
  const ok = per.every(t => t.rules.every(x => x.ok));
  const est = rules.reduce((s, r) => { const cell = pool.filter(q => q.topic.toLowerCase() === r.topic.toLowerCase() && (r.difficulty === 'any' || q.difficulty === r.difficulty)); const avg = cell.length ? cell.reduce((a, q) => a + q.marks, 0) / cell.length : 0; return s + avg * r.count; }, 0);
  return { ok, byRole: per, questions: rules.reduce((s, r) => s + r.count, 0), estimatedMarks: Math.round(est * 100) / 100 };
}
function readBlueprint(b, cur, rd) {
  const rules = b.rules === undefined ? (cur ? cur.rules : []) : b.rules; if (!Array.isArray(rules)) throw U.bad('Rules must be a list.');
  const clean = rules.map(r => ({ topic: r && r.topic, difficulty: (r && r.difficulty) || 'any', count: r && r.count }));
  if (clean.length) { const errs = R.validateRules(clean); if (errs.length) throw U.bad(errs.join(' '), errs.map(m => ({ path: 'rules', message: m }))); }
  let roles = b.roles === undefined ? (cur ? cur.roles : []) : b.roles; if (!Array.isArray(roles)) throw U.bad('Roles must be a list.');
  roles = [...new Set(roles.map(x => String(x).trim().toUpperCase()))]; if (roles.some(x => !ROLE_RE.test(x))) throw U.bad('Roles must be role codes such as SDE.');
  const od = b.opens_at === undefined ? (cur ? cur.opens_at : null) : U.date(b.opens_at, 'opens_at'), cd = b.closes_at === undefined ? (cur ? cur.closes_at : null) : U.date(b.closes_at, 'closes_at');
  const opens = od ? new Date(od).toISOString() : null, closes = cd ? new Date(cd).toISOString() : null;
  if (opens && closes && new Date(closes) <= new Date(opens)) throw U.bad('The closing time must be after the opening time.');
  return {
    title: b.title === undefined && cur ? cur.title : U.str(b.title, 'title', { min: 3, max: 150 }), round: b.round === undefined && cur ? Number(cur.round) : U.int(b.round, 'round', { min: 1, max: 5 }),
    instructions: b.instructions === undefined && cur ? cur.instructions : U.str(b.instructions, 'instructions', { max: 4000, optional: true }),
    time_limit_minutes: b.time_limit_minutes === undefined ? (cur ? cur.time_limit_minutes : rd.duration_minutes) : U.int(b.time_limit_minutes, 'time_limit_minutes', { min: 1, max: 480 }),
    pass_mark_pct: b.pass_mark_pct === undefined ? (cur ? cur.pass_mark_pct : rd.pass_threshold_pct) : U.num(b.pass_mark_pct, 'pass_mark_pct', { min: 0, max: 100 }),
    lock_mode: b.lock_mode === undefined ? (cur ? cur.lock_mode : 'strict') : U.oneOf(b.lock_mode, 'lock_mode', LOCKS),
    monitor_mode: b.monitor_mode === undefined ? (cur ? cur.monitor_mode || 'off' : 'off') : U.oneOf(b.monitor_mode, 'monitor_mode', ['off', 'required']),
    shuffle_questions: b.shuffle_questions === undefined ? (cur ? cur.shuffle_questions : true) : U.bool(b.shuffle_questions, 'shuffle_questions'),
    shuffle_options: b.shuffle_options === undefined ? (cur ? cur.shuffle_options : true) : U.bool(b.shuffle_options, 'shuffle_options'),
    results_policy: b.results_policy === undefined ? (cur ? cur.results_policy : 'hidden') : U.oneOf(b.results_policy, 'results_policy', POLICIES),
    rules: clean, roles, opens_at: opens, closes_at: closes,
  };
}
const getA = id => { U.uuid(id); const a = S.assessments.find(x => x.id === id); if (!a) throw U.notFound(); return a; };
const attemptsOf = id => S.attempts.filter(t => t.assessment_id === id);
const asm = {
  list(q = {}) {
    let r = S.assessments; if (q.round) r = r.filter(a => a.round === U.int(q.round, 'round', { min: 1, max: 5 })); if (q.status) r = r.filter(a => a.status === U.oneOf(q.status, 'status', ['draft', 'active', 'archived']));
    r = [...r].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { items: r.map(a => ({ ...aOut(a), assigned: attemptsOf(a.id).length, submitted: attemptsOf(a.id).filter(t => t.status === 'submitted').length })) };
  },
  get(id) {
    const a = getA(id); const ts = attemptsOf(id);
    return { ...aOut(a), availability: a.rules.length ? availabilityReport(poolFor(a.round), a.rules, a.roles) : null, counts: { assigned: ts.length, in_progress: ts.filter(t => t.status === 'in_progress').length, submitted: ts.filter(t => t.status === 'submitted').length } };
  },
  create(u, body) {
    const b = body || {}; const round = U.int(b.round, 'round', { min: 1, max: 5 }); const rd = S.rounds.find(r => r.round === round);
    const d = readBlueprint(b, null, rd); const a = { id: uid(), ...d, status: 'draft', current_version: 1, max_attempts: 1, created_at: nowIso(), results_published_at: null };
    S.assessments.push(a); audit(u, 'qb.assessment.create', 'assessment', a.id, null, { title: d.title, round: d.round, rules: d.rules, roles: d.roles }); return aOut(a);
  },
  update(u, id, body) {
    const a = getA(id); if (a.status === 'archived') throw new U.ServiceError(409, 'archived', 'An archived assessment cannot be edited.');
    const rd = S.rounds.find(r => r.round === a.round); const d = readBlueprint(body || {}, a, rd);
    if (d.round !== a.round && attemptsOf(id).length) throw new U.ServiceError(409, 'round_locked', 'The round cannot change after candidates have been assigned.');
    const sig = x => JSON.stringify([Number(x.round), x.rules.map(r => [String(r.topic).toLowerCase(), r.difficulty, Number(r.count)]), [...x.roles].sort(), x.shuffle_questions, x.shuffle_options, Number(x.time_limit_minutes), Number(x.pass_mark_pct)]);
    const bump = sig(d) !== sig(a); const before = { title: a.title, rules: a.rules, version: a.current_version };
    Object.assign(a, d); if (bump) a.current_version++;
    audit(u, 'qb.assessment.update', 'assessment', id, before, { title: a.title, rules: a.rules, version: a.current_version }); return aOut(a);
  },
  setPublished(u, id, action) {
    const act = U.oneOf(action, 'action', ['publish', 'unpublish', 'archive']); const a = getA(id);
    if (act === 'publish') {
      if (a.status === 'active') return { status: 'active', unchanged: true };
      if (!a.rules.length) throw U.bad('Add at least one rule (topic, difficulty and count) before publishing.');
      const rs = S.rounds.find(r => r.round === a.round); if (!rs || !rs.enabled) throw new U.ServiceError(409, 'round_disabled', 'This round is disabled in the round settings.');
      const av = availabilityReport(poolFor(a.round), a.rules, a.roles);
      if (!av.ok) { const short = av.byRole.flatMap(t => t.rules.filter(x => !x.ok).map(x => `${x.topic}/${x.difficulty}${t.role ? ' for ' + t.role : ''}: need ${x.count}, have ${x.available}`)); throw new U.ServiceError(409, 'insufficient_pool', 'The bank does not have enough active questions: ' + short.join('; ') + '.', { shortfalls: short }); }
    } else if (act === 'unpublish') {
      if (a.status !== 'active') throw new U.ServiceError(409, 'not_active', 'The assessment is not published.');
      const n = attemptsOf(id).filter(t => ['in_progress', 'blocked'].includes(t.status)).length;
      if (n) throw new U.ServiceError(409, 'in_use', `${n} candidate(s) are in the middle of this test. Wait until they finish, then unpublish.`);
    }
    const to = act === 'publish' ? 'active' : act === 'unpublish' ? 'draft' : 'archived'; const from = a.status; a.status = to;
    audit(u, `qb.assessment.${act}`, 'assessment', id, { status: from }, { status: to, version: a.current_version }); return { status: to };
  },
  preview(id, q = {}) {
    const a = getA(id); if (!a.rules.length) throw U.bad('Add at least one rule first.');
    const role = q.role ? String(q.role).toUpperCase() : (a.roles[0] || null);
    const rows = S.questions.filter(x => x.round === a.round && x.status === 'active');
    const paper = R.drawPaper({ pool: rows, rules: a.rules, role, seed: R.newSeed(), shuffleQuestions: a.shuffle_questions, shuffleOptions: a.shuffle_options });
    const items = paper.questions.map(x => { const aq = toAQ(x, 'preview'); return { ...M.presentQuestion({ ...aq, id: x.question.question_code }), code: x.question.question_code, topic: x.question.topic, difficulty: x.question.difficulty, correct: keyOf(aq) }; });
    return { role, totalMarks: paper.totalMarks, questions: items, note: 'Preview only. Marked "correct" positions are visible to admins and never sent to candidates.' };
  },
  assign(u, id, body) {
    const ids = body && body.application_ids; if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw U.bad('Choose between 1 and 500 candidates.');
    const dueAt = U.date(body.due_at, 'due_at'); const a = getA(id);
    if (a.status !== 'active') throw new U.ServiceError(409, 'not_published', 'Publish the assessment before assigning candidates.');
    const results = [];
    for (const appId of [...new Set(ids)]) {
      const c = S.candidates.find(x => x.application_id === appId);
      if (!c) { results.push({ application_id: appId, status: 'not_found', reason: 'Application not found.' }); continue; }
      if (a.roles.length && !a.roles.includes(c.role_code)) { results.push({ application_id: appId, status: 'ineligible', reason: `This assessment is for ${a.roles.join(', ')}; the candidate applied for ${c.role_code || 'another role'}.` }); continue; }
      const why = eligibility(a.round, c); if (why) { results.push({ application_id: appId, status: 'ineligible', reason: why }); continue; }
      if (S.attempts.some(t => t.assessment_id === id && t.application_id === appId)) { results.push({ application_id: appId, status: 'already_assigned' }); continue; }
      const t = { id: uid(), assessment_id: id, application_id: appId, attempt_no: 1, status: 'ready', assigned_at: nowIso(), assessment_version: a.current_version, due_at: dueAt ? new Date(dueAt).toISOString() : null, started_at: null, deadline_at: null, remaining_ms: null, warnings: 0, submitted_at: null, result_status: null, final_score: null, final_pct: null, passed: null, max_score: null, auto_score: null, review_requested_at: null, reinstated_count: 0, paper: null, qs: [], events: [] };
      S.attempts.push(t); results.push({ application_id: appId, status: 'assigned', attempt_id: t.id });
    }
    const n = results.filter(r => r.status === 'assigned').length; audit(u, 'qb.assessment.assign', 'assessment', id, null, { requested: ids.length, assigned: n, version: a.current_version }); return { assigned: n, results };
  },
  publishResults(u, id, body) {
    const pub = U.bool(body && body.published, 'published'); const a = getA(id);
    const policy = body.results_policy === undefined ? a.results_policy : U.oneOf(body.results_policy, 'results_policy', POLICIES);
    if (pub && policy === 'hidden') throw U.bad('Choose "score" or "score and review" before publishing results to candidates.');
    const was = !!a.results_published_at; const bp = a.results_policy; a.results_policy = policy; a.results_published_at = pub ? (a.results_published_at || nowIso()) : null;
    const pending = attemptsOf(id).filter(t => t.result_status === 'pending_review').length;
    audit(u, pub ? 'qb.results.publish' : 'qb.results.unpublish', 'assessment', id, { policy: bp, published: was }, { policy, published: pub, pending_review: pending }); return { published: pub, results_policy: policy, pending_review: pending };
  },
  report(id) {
    const a = getA(id); const rows = attemptsOf(id); const by = s => rows.filter(r => r.status === s).length; const fin = rows.filter(r => r.result_status === 'final'); const pcts = fin.map(r => Number(r.final_pct));
    const topics = new Map();
    for (const t of rows) for (const q of t.qs) { if (q.snapshot.type === 'descriptive') continue; const tp = topics.get(q.snapshot.topic) || { topic: q.snapshot.topic, asked: 0, answered: 0, correct: 0 }; const m = M.markObjective(q, q.response); tp.asked++; if (m.correct !== null) tp.answered++; if (m.correct) tp.correct++; topics.set(q.snapshot.topic, tp); }
    const submitted = by('submitted'); const r1 = n => Math.round(n * 10) / 10;
    return {
      assessment: { id: a.id, title: a.title, round: a.round, status: a.status, version: a.current_version },
      counts: { assigned: rows.length, not_started: by('ready'), in_progress: by('in_progress'), blocked: by('blocked'), submitted, pending_review: rows.filter(r => r.result_status === 'pending_review').length, completed_with_result: fin.length },
      completion_rate: rows.length ? r1(submitted / rows.length * 100) : 0,
      scores: fin.length ? { average_pct: r1(pcts.reduce((s, x) => s + x, 0) / pcts.length), highest_pct: Math.max(...pcts), lowest_pct: Math.min(...pcts), passed: fin.filter(r => r.passed).length, failed: fin.filter(r => !r.passed).length, pass_rate: r1(fin.filter(r => r.passed).length / fin.length * 100) } : null,
      topics: [...topics.values()].map(t => ({ ...t, accuracy_pct: t.asked ? r1(t.correct / t.asked * 100) : 0 })).sort((x, y) => (x.topic < y.topic ? -1 : 1)),
      flagged: rows.filter(r => Number(r.warnings) > 0).length,
    };
  },
};
const keyOf = aq => aq.snapshot.type === 'mcq' ? aq.option_order.indexOf(aq.snapshot.correct_answer) : aq.snapshot.type === 'multi_select' ? aq.snapshot.correct_answer.map(i => aq.option_order.indexOf(i)).sort((a, b) => a - b) : null;
const toAQ = (x, id) => ({ id, position: x.position, option_order: x.optionOrder, marks: x.question.marks, negative_marks: x.question.negative_marks, snapshot: { question_text: x.question.question_text, type: x.question.type, options: x.question.options || null, correct_answer: x.question.correct_answer ?? null, reference_answer: x.question.reference_answer || null, explanation: x.question.explanation || null, topic: x.question.topic, difficulty: x.question.difficulty } });

// ---------------------------------------------------------------- candidate side helpers
function eligibility(round, c) {
  const rs = S.rounds.find(r => r.round === round); if (!rs || !rs.enabled) return 'This round is disabled.';
  const e = rs.eligibility || {};
  if (e.require_stage && c.stage !== `round_${round}`) return `Candidate is at stage "${c.stage}"; move them to round ${round} first (or switch off the stage rule for this round).`;
  if (e.min_previous_pct != null && round > 1) {
    const best = S.attempts.filter(t => t.application_id === c.application_id && assessOf(t).round === round - 1 && t.result_status === 'final').reduce((m, t) => Math.max(m, Number(t.final_pct)), -1);
    if (best < Number(e.min_previous_pct)) return `Needs at least ${e.min_previous_pct}% in round ${round - 1} (best so far: ${best < 0 ? 'no result' : best + '%'}).`;
  }
  return null;
}
const assessOf = t => S.assessments.find(a => a.id === t.assessment_id);
const candOf = t => S.candidates.find(c => c.application_id === t.application_id);
function authorised(t, now = Date.now()) {
  const a = assessOf(t); if (a.status !== 'active') return { code: 'not_available', message: 'This assessment is not open.' };
  const rs = S.rounds.find(r => r.round === a.round); if (!rs || !rs.enabled || !rs.published) return { code: 'not_available', message: 'This round is not open yet.' };
  if (a.opens_at && new Date(a.opens_at).getTime() > now) return { code: 'not_open_yet', message: `This assessment opens on ${new Date(a.opens_at).toUTCString()}.` };
  if (a.closes_at && new Date(a.closes_at).getTime() < now) return { code: 'closed', message: 'This assessment has closed.' };
  if (eligibility(a.round, candOf(t))) return { code: 'not_eligible', message: 'You are not cleared for this round yet. Please contact HR.' };
  return null;
}
function recompute(t) {
  const a = assessOf(t); const map = new Map(t.qs.map(q => [q.id, { response: q.response, manual_marks: q.manual_marks }]));
  const s = M.scoreAttempt(t.qs, map, { passPct: Number(a.pass_mark_pct) });
  const obj = M.scoreAttempt(t.qs, new Map(t.qs.map(q => [q.id, { response: q.response }])), { passPct: Number(a.pass_mark_pct) });
  for (const q of t.qs) { if (q.snapshot.type === 'descriptive' || q.response === null || q.response === undefined) continue; q.auto_marks = M.markObjective(q, q.response).marks; }
  const fin = s.resultStatus === 'final'; t.max_score = s.max; t.auto_score = Math.min(9999.99, obj.score); t.result_status = s.resultStatus; t.final_score = fin ? s.score : null; t.final_pct = fin ? s.pct : null; t.passed = fin ? s.passed : null;
  return s;
}
function submitCore(t, { auto }) {
  if (t.status === 'submitted') return false;
  t.status = 'submitted'; t.submitted_at = nowIso(); t.remaining_ms = null; const s = recompute(t);
  t.events.push({ kind: auto ? 'auto_submitted' : 'submitted', detail: auto ? 'Time ran out' : null, created_at: nowIso() });
  audit(S.users.find(x => x.id === candOf(t).user_id), auto ? 'qb.attempt.auto_submit' : 'qb.attempt.submit', 'attempt', t.id, null, { score: s.score, max: s.max, result_status: s.resultStatus }); return true;
}
function ownAttempt(u, id) { U.uuid(id); const t = S.attempts.find(x => x.id === id); if (!t || candOf(t).user_id !== u.id) throw U.notFound(); return t; }
const left = t => (t.status === 'in_progress' ? P.pxRemaining({ status: t.status, deadline_at: t.deadline_at }, Date.now()) : Number(t.remaining_ms) || 0);
function payload(t) {
  const a = assessOf(t); const answers = {}; let answered = 0;
  for (const q of t.qs) { if (q.rev !== null && q.rev !== undefined) answers[q.id] = { response: q.response, rev: q.rev }; if (M.isAnswered(q, q.response)) answered++; }
  return {
    attempt: { id: t.id, status: t.status, deadline_at: t.deadline_at, remaining_ms: left(t), server_now: nowIso(), warnings: t.warnings, lock_mode: a.lock_mode, monitor_mode: 'off', max_warnings: P.MAX_WARNINGS },
    assessment: { title: a.title, instructions: a.instructions, round: a.round }, questions: t.qs.map(M.presentQuestion), answers, progress: { answered, total: t.qs.length },
  };
}
function visible(a) { return !!a.results_published_at && a.results_policy !== 'hidden'; }
function resultFor(t) {
  const a = assessOf(t); if (t.status !== 'submitted') return { visible: false };
  if (!visible(a)) return { visible: false, message: 'Results will be shared by the hiring team.' };
  if (t.result_status !== 'final') return { visible: false, message: 'Your written answers are still being reviewed. Results will appear here when ready.' };
  const base = { visible: true, score: Number(t.final_score), max: Number(t.max_score), percent: Number(t.final_pct), passed: !!t.passed, pass_mark_percent: Number(a.pass_mark_pct) };
  if (a.results_policy !== 'score_and_review') return base;
  const s = M.scoreAttempt(t.qs, new Map(t.qs.map(q => [q.id, { response: q.response, manual_marks: q.manual_marks }])), { passPct: Number(a.pass_mark_pct) }); const per = new Map(s.perQuestion.map(p => [p.id, p]));
  base.review = t.qs.map(q => ({ position: q.position, text: q.snapshot.question_text, type: q.snapshot.type, options: q.snapshot.options ? q.option_order.map(i => q.snapshot.options[i]) : null, your_answer: q.response ?? null, correct_answer: keyOf(q), explanation: q.snapshot.explanation, marks_awarded: per.get(q.id).marks, marks: q.marks, outcome: per.get(q.id).status }));
  return base;
}
const att = {
  listMine(u) {
    const mine = S.attempts.filter(t => candOf(t).user_id === u.id).sort((a, b) => (a.assigned_at < b.assigned_at ? 1 : -1)); const current = [], completed = [];
    for (const t of mine) {
      const a = assessOf(t); const rs = S.rounds.find(r => r.round === a.round);
      const base = { attempt_id: t.id, title: a.title, round: a.round, round_name: rs.name, duration_minutes: a.time_limit_minutes, status: t.status, due_at: t.due_at };
      if (t.status === 'submitted') completed.push({ ...base, submitted_at: t.submitted_at, result: !visible(a) ? 'not_published' : t.result_status === 'final' ? 'available' : 'under_review' });
      else if (t.status === 'in_progress' || t.status === 'blocked') current.push({ ...base, state: t.status });
      else { const why = authorised(t); if (!why) current.push({ ...base, state: 'available' }); else if (why.code === 'not_open_yet') current.push({ ...base, state: 'scheduled', opens_at: a.opens_at, message: why.message }); }
    }
    return { current, completed };
  },
  info(u, id) {
    const t = ownAttempt(u, id); const a = assessOf(t); const why = t.status === 'ready' ? authorised(t) : null;
    if (t.status === 'ready' && why && why.code !== 'not_open_yet') throw U.notFound();
    return { attempt_id: t.id, status: t.status, title: a.title, instructions: a.instructions, round: a.round, duration_minutes: a.time_limit_minutes, questions: a.rules.reduce((s, r) => s + Number(r.count), 0), lock_mode: a.lock_mode, monitor_mode: 'off', max_warnings: P.MAX_WARNINGS, can_start: t.status === 'ready' && !why, message: why ? why.message : null, remaining_ms: t.status === 'in_progress' ? left(t) : t.status === 'blocked' ? Number(t.remaining_ms) : null, server_now: nowIso(), review_requested: t.status === 'blocked' ? !!t.review_requested_at : false };
  },
  start(u, id) {
    const t = ownAttempt(u, id);
    if (t.status === 'submitted') throw new U.ServiceError(409, 'already_submitted', 'You have already submitted this assessment.');
    if (t.status === 'blocked') throw new U.ServiceError(409, 'blocked', 'This attempt is blocked. Ask HR to review it.');
    if (t.status === 'in_progress') { const w = P.pxCanWrite({ status: t.status, deadline_at: t.deadline_at }, Date.now(), SAVE_GRACE_MS); if (!w.ok && w.reason === 'time_expired') { submitCore(t, { auto: true }); throw new U.ServiceError(409, 'time_expired', 'Time is up. Your answers were submitted.'); } return payload(t); }
    const why = authorised(t); if (why) throw new U.ServiceError(why.code === 'not_open_yet' || why.code === 'closed' ? 403 : 404, why.code, why.message);
    const a = assessOf(t); const c = candOf(t); const existing = !!t.paper;
    if (!existing) {
      const topics = a.rules.map(r => String(r.topic).toLowerCase()); const pool = S.questions.filter(q => q.round === a.round && q.status === 'active' && (!q.role_code || q.role_code === c.role_code) && topics.includes(q.topic.toLowerCase()));
      const seed = R.newSeed(); let paper; try { paper = R.drawPaper({ pool, rules: a.rules, role: c.role_code, seed, shuffleQuestions: a.shuffle_questions, shuffleOptions: a.shuffle_options }); }
      catch (e) { if (e.code === 'insufficient_pool') throw new U.ServiceError(409, 'not_ready', 'This assessment is not ready yet. Please contact HR.'); throw e; }
      t.paper = { seed, generator_version: paper.generatorVersion, assessment_version: a.current_version, generated_at: nowIso(), total_marks: paper.totalMarks };
      t.qs = paper.questions.map(x => { const aq = toAQ(x, uid()); return { id: aq.id, position: aq.position, question_code: x.question.question_code, question_version: x.question.version, snapshot: aq.snapshot, option_order: aq.option_order, marks: Number(aq.marks), negative_marks: Number(aq.negative_marks), response: null, rev: null, manual_marks: null, auto_marks: null, review_comment: null, reviewed_at: null, saved_at: null }; });
      audit(u, 'qb.paper.generate', 'attempt', t.id, null, { questions: t.qs.length, total_marks: paper.totalMarks, assessment_version: a.current_version });
    }
    const remaining = t.remaining_ms === null || t.remaining_ms === undefined ? a.time_limit_minutes * 60000 : Number(t.remaining_ms);
    t.deadline_at = new Date(P.pxResume({ status: 'ready', remaining_ms: remaining }, Date.now()).deadline_at).toISOString(); t.status = 'in_progress'; t.remaining_ms = null; if (!existing) t.started_at = nowIso();
    t.events.push({ kind: 'start', detail: existing ? 'Resumed' : null, created_at: nowIso() }); audit(u, 'qb.attempt.start', 'attempt', t.id, null, { resumed: existing }); return payload(t);
  },
  paper(u, id) {
    const t = ownAttempt(u, id);
    if (t.status === 'ready') throw new U.ServiceError(409, 'not_started', 'Start the assessment first.');
    if (t.status !== 'in_progress') return { attempt: { id: t.id, status: t.status, remaining_ms: Number(t.remaining_ms) || 0, server_now: nowIso() }, questions: [], answers: {}, progress: null };
    if (!P.pxCanWrite({ status: t.status, deadline_at: t.deadline_at }, Date.now(), SAVE_GRACE_MS).ok) { submitCore(t, { auto: true }); return { attempt: { id: t.id, status: 'submitted', remaining_ms: 0, server_now: nowIso() }, questions: [], answers: {}, progress: null }; }
    return payload(t);
  },
  save(u, id, items) {
    if (!Array.isArray(items) || !items.length || items.length > 200) throw U.bad('Send between 1 and 200 answers.');
    const t = ownAttempt(u, id); const w = P.pxCanWrite({ status: t.status, deadline_at: t.deadline_at }, Date.now(), SAVE_GRACE_MS);
    if (!w.ok) { if (w.reason === 'time_expired' && t.status === 'in_progress') submitCore(t, { auto: true }); throw new U.ServiceError(409, w.reason, w.reason === 'blocked' ? 'This attempt is blocked.' : w.reason === 'time_expired' ? 'Time is up. Your answers were submitted.' : w.reason === 'already_submitted' ? 'Already submitted.' : 'The assessment has not started.'); }
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') throw U.bad('Each answer must be an object.'); const qid = U.uuid(it.id); const rev = U.int(it.rev, 'rev', { min: 1, max: 1e9 });
      const q = t.qs.find(x => x.id === qid); if (!q) throw U.bad('Unknown question.');
      const response = M.normalizeResponse(q, it.response === undefined ? null : it.response);
      if (q.rev === null || q.rev < rev) { q.response = response; q.rev = rev; q.saved_at = nowIso(); out.push({ id: qid, saved: true, rev }); } else out.push({ id: qid, saved: false, stale: true, rev: q.rev });
    }
    return { saved: out, answered: t.qs.filter(q => M.isAnswered(q, q.response)).length, server_now: nowIso() };
  },
  submit(u, id) {
    const t = ownAttempt(u, id); let dup = false;
    if (t.status === 'submitted') dup = true;
    else if (t.status === 'blocked') throw new U.ServiceError(409, 'blocked', 'This attempt is blocked. Ask HR to review it.');
    else if (t.status !== 'in_progress') throw new U.ServiceError(409, 'not_started', 'The assessment has not been started.');
    else submitCore(t, { auto: !P.pxCanWrite({ status: t.status, deadline_at: t.deadline_at }, Date.now(), SAVE_GRACE_MS).ok });
    return { status: 'submitted', submitted_at: t.submitted_at, duplicate: dup, answered: t.qs.filter(q => M.isAnswered(q, q.response)).length, total: t.qs.length, message: 'Your answers have been submitted. You cannot change them now.', result: resultFor(t) };
  },
  result(u, id) { const t = ownAttempt(u, id); if (t.status !== 'submitted') throw new U.ServiceError(409, 'not_submitted', 'Submit the assessment first.'); return resultFor(t); },
  event(u, id, body = {}) {
    const kind = U.oneOf(body.kind, 'kind', ['violation', 'note', 'monitor']); if (kind === 'monitor') return { action: 'ignore' }; const detail = U.str(body.detail, 'detail', { max: 300, optional: true }); const t = ownAttempt(u, id); const a = assessOf(t);
    if (kind === 'note') { t.events.push({ kind: 'note', detail, created_at: nowIso() }); return { action: 'logged', status: t.status }; }
    const r = P.pxViolation({ status: t.status, warnings: t.warnings }, a.lock_mode); if (r.action === 'ignore') return { action: 'ignore', status: t.status };
    t.events.push({ kind: r.action === 'block' ? 'blocked' : r.action === 'warn' ? 'warning' : 'violation', detail, created_at: nowIso() });
    if (r.action === 'block') { const b = P.pxBlock({ status: t.status, deadline_at: t.deadline_at }, Date.now()); t.status = 'blocked'; t.warnings = r.warnings; t.remaining_ms = b.remaining_ms; audit(u, 'qb.attempt.blocked', 'attempt', t.id, null, { detail }); return { action: 'block', status: 'blocked' }; }
    t.warnings = r.warnings; return { action: r.action, status: t.status, warnings: r.warnings, max_warnings: P.MAX_WARNINGS };
  },
  requestReview(u, id) { const t = ownAttempt(u, id); if (t.status !== 'blocked') throw new U.ServiceError(409, 'not_blocked', 'Only a blocked attempt can be sent for review.'); t.review_requested_at = nowIso(); audit(u, 'qb.attempt.review_requested', 'attempt', t.id); return { ok: true }; },
  reinstate(u, id, body = {}) {
    const reason = U.str(body.reason, 'reason', { min: 5, max: 500 }); U.uuid(id); const t = S.attempts.find(x => x.id === id); if (!t) throw U.notFound();
    if (t.status !== 'blocked') throw new U.ServiceError(409, 'not_blocked', 'Only a blocked attempt can be reinstated.');
    const r = P.pxReinstate({ status: t.status, reinstated_count: t.reinstated_count }, Date.now(), reason); t.status = 'ready'; t.warnings = 0; t.reinstated_count = r.reinstated_count;
    t.events.push({ kind: 'reinstated', detail: reason, created_at: nowIso() }); audit(u, 'qb.attempt.reinstate', 'attempt', t.id, { status: 'blocked' }, { status: 'ready', reason }); return { ok: true };
  },
  sweep() { let n = 0; for (const t of S.attempts) if (t.status === 'in_progress' && new Date(t.deadline_at).getTime() < Date.now() - 15000) { submitCore(t, { auto: true }); n++; } if (n) save(); return n; },
};

// ---------------------------------------------------------------- submissions
const subRow = t => {
  const a = assessOf(t), c = candOf(t);
  return { attempt_id: t.id, attempt_status: t.status, attempt_no: 1, started_at: t.started_at, submitted_at: t.submitted_at, warnings: t.warnings, max_score: t.max_score, final_score: t.final_score, final_pct: t.final_pct, passed: t.passed, result_status: t.result_status, auto_score: t.auto_score, candidate_id: c.id, candidate_code: c.candidate_code, full_name: c.full_name, email: c.email, role_code: c.role_code, application_id: c.application_id, stage: c.stage, assessment_id: a.id, assessment_title: a.title, round: a.round, assigned_at: t.assigned_at, assessment_version: t.assessment_version, paper_generated_at: t.paper ? t.paper.generated_at : null, paper_version: t.paper ? t.paper.assessment_version : null };
};
function subs(q) {
  let r = S.attempts;
  if (q.assessment_id) r = r.filter(t => t.assessment_id === U.uuid(q.assessment_id));
  if (q.round) r = r.filter(t => assessOf(t).round === U.int(q.round, 'round', { min: 1, max: 5 }));
  if (q.status) r = r.filter(t => t.status === U.oneOf(q.status, 'status', ['ready', 'in_progress', 'blocked', 'submitted']));
  if (q.result === 'passed') r = r.filter(t => t.passed === true); else if (q.result === 'failed') r = r.filter(t => t.passed === false); else if (q.result === 'pending_review') r = r.filter(t => t.result_status === 'pending_review');
  if (q.q) { const s = String(q.q).slice(0, 100); r = r.filter(t => { const c = candOf(t); return icontains(c.full_name, s) || icontains(c.email, s) || icontains(c.candidate_code, s); }); }
  if (q.from) { const f = U.date(q.from, 'from'); r = r.filter(t => new Date(t.submitted_at || t.assigned_at) >= f); }
  if (q.to) { const f = U.date(q.to, 'to'); r = r.filter(t => new Date(t.submitted_at || t.assigned_at) < f); }
  return [...r].sort((a, b) => ((a.submitted_at || a.assigned_at) < (b.submitted_at || b.assigned_at) ? 1 : -1));
}
const EXPORT_COLS = [['candidate_code', 'Candidate ID'], ['full_name', 'Name'], ['email', 'Email'], ['role_code', 'Role'], ['assessment_title', 'Assessment'], ['round', 'Round'], ['assessment_version', 'Assignment version'], ['assigned_at', 'Assigned at'], ['paper_version', 'Paper version'], ['paper_generated_at', 'Paper generated at'], ['attempt_status', 'Attempt status'], ['started_at', 'Started at'], ['submitted_at', 'Submitted at'], ['warnings', 'Lock warnings'], ['final_score', 'Score'], ['max_score', 'Max score'], ['final_pct', 'Percent'], ['passed', 'Passed'], ['result_status', 'Result status'], ['question_ids', 'Question IDs']];
const sub = {
  list(q = {}) { const pg = U.page(q); const r = subs(q); return { items: r.slice(pg.offset, pg.offset + pg.per).map(subRow), total: r.length, page: pg.page, per: pg.per }; },
  export(u, q = {}) {
    const format = U.oneOf(q.format || 'xlsx', 'format', ['csv', 'xlsx']); const rows = subs(q).map(t => ({ ...subRow(t), question_ids: t.qs.map(x => x.question_code).join(';') }));
    const fmt = (k, v) => (v === null || v === undefined ? '' : k === 'passed' ? (v ? 'Yes' : 'No') : /_at$/.test(k) ? new Date(v).toISOString() : v);
    const head = EXPORT_COLS.map(c => c[1]); const data = rows.map(r => EXPORT_COLS.map(([k]) => fmt(k, r[k]))); audit(u, 'qb.results.export', 'assessment', q.assessment_id || 'all', null, { rows: rows.length, format });
    const stamp = nowIso().slice(0, 10);
    if (format === 'csv') return { body: Buffer.from(writeCsv([head, ...data]), 'utf8'), mime: MIMES.csv, fileName: `semil-results-${stamp}.csv` };
    return { body: writeXlsx([{ name: 'Results', rows: [head, ...data], widths: head.map((h, i) => (i === 2 ? 30 : i === 4 ? 30 : i === 19 ? 50 : 16)) }]), mime: MIMES.xlsx, fileName: `semil-results-${stamp}.xlsx` };
  },
  detail(u, id) {
    U.uuid(id); const t = S.attempts.find(x => x.id === id); if (!t) throw U.notFound();
    return { ...subRow(t), deadline_at: t.deadline_at, events: t.events.map(e => ({ kind: e.kind, detail: e.detail, created_at: e.created_at })),
      paper: t.paper ? { generator_version: t.paper.generator_version, assessment_version: t.paper.assessment_version, generated_at: t.paper.generated_at, total_marks: t.paper.total_marks, seed: t.paper.seed } : null,
      questions: t.qs.map(q => ({ id: q.id, position: q.position, code: q.question_code, version: q.question_version, type: q.snapshot.type, topic: q.snapshot.topic, difficulty: q.snapshot.difficulty, text: q.snapshot.question_text, options: q.snapshot.options ? q.option_order.map(i => q.snapshot.options[i]) : null, option_order: q.option_order, correct: keyOf(q), reference_answer: q.snapshot.reference_answer || null, marks: q.marks, negative_marks: q.negative_marks, response: q.response, auto_marks: q.auto_marks, manual_marks: q.manual_marks, review_comment: q.review_comment, saved_at: q.saved_at })) };
  },
  review(u, id, qid, body) {
    U.uuid(id); U.uuid(qid); const t = S.attempts.find(x => x.id === id); if (!t) throw U.notFound();
    if (t.status !== 'submitted') throw new U.ServiceError(409, 'not_submitted', 'Only a submitted attempt can be marked.');
    const q = t.qs.find(x => x.id === qid); if (!q || q.snapshot.type !== 'descriptive') throw U.notFound();
    const marks = M.validateManualMarks(q, body && body.marks); const comment = U.str(body && body.comment, 'comment', { max: 1000, optional: true });
    const before = q.manual_marks; q.manual_marks = marks; q.review_comment = comment; q.reviewed_at = nowIso(); const res = recompute(t);
    audit(u, 'qb.attempt.review', 'attempt', id, { manual_marks: before }, { question: qid, manual_marks: marks, result_status: res.resultStatus, score: res.score });
    return { result_status: res.resultStatus, score: res.score, max: res.max, pct: res.pct, passed: res.resultStatus === 'final' ? res.passed : null };
  },
  audit(q = {}) {
    const pg = U.page(q, { per: 50 }); let r = S.audit.filter(l => l.action.startsWith('qb.'));
    if (q.entity_type) r = r.filter(l => l.entity_type === String(q.entity_type)); if (q.entity_id) r = r.filter(l => l.entity_id === String(q.entity_id)); if (q.action) r = r.filter(l => l.action.startsWith(String(q.action)));
    return { items: r.slice(pg.offset, pg.offset + pg.per), page: pg.page };
  },
};

// ---------------------------------------------------------------- router
function currentUser() { try { const id = sessionStorage.getItem('nt_demo_user'); return id ? S.users.find(u => u.id === id) || null : null; } catch { return null; } }
function setUser(id) { try { if (id) sessionStorage.setItem('nt_demo_user', id); else sessionStorage.removeItem('nt_demo_user'); } catch { /* ignore */ } }

const ROUTES = [];
const route = (method, pattern, capOrFn, fn) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); ROUTES.push({ method, re, keys, cap: capOrFn, fn }); };
const P_ = '/api/qb';
route('GET', `${P_}/meta`, 'qbank:read', () => svc.meta());
route('GET', `${P_}/pool`, 'qbank:read', ({ query }) => svc.pool(query));
route('GET', `${P_}/templates/:format`, 'qbank:read', ({ params }) => { const t = buildTemplate(params.format); if (!t) return err(404, 'not_found', 'Not found.'); return { file: t }; });
route('GET', `${P_}/questions/export`, 'qbank:read', ({ u, query }) => ({ file: svc.exportQuestions(u, query) }));
route('GET', `${P_}/questions`, 'qbank:read', ({ query }) => svc.list(query));
route('POST', `${P_}/questions/status`, 'qbank:write', ({ u, body }) => svc.setStatus(u, body && body.ids, body && body.status));
route('POST', `${P_}/questions`, 'qbank:write', ({ u, body }) => ok(svc.create(u, body), 201));
route('GET', `${P_}/questions/:id`, 'qbank:read', ({ params }) => svc.get(params.id));
route('PUT', `${P_}/questions/:id`, 'qbank:write', ({ u, params, body }) => svc.update(u, params.id, body));
route('POST', `${P_}/import/preview`, 'qbank:import', ({ u, query, raw, mime }) => { if (!raw) return err(400, 'no_file', 'Send the file as the request body.'); try { const out = svc.previewImport(u, { buffer: raw, fileName: String(query.name || ''), mime, onConflict: query.on_conflict }); return ok(out, out.batchId ? 201 : 200); } catch (e) { if (e instanceof importer.UploadError) return err(e.status, e.code, e.message); throw e; } });
route('GET', `${P_}/import`, 'qbank:import', () => svc.listBatches());
route('GET', `${P_}/import/:id`, 'qbank:import', ({ u, params, query }) => svc.getBatch(u, params.id, query));
route('POST', `${P_}/import/:id/commit`, 'qbank:import', ({ u, params }) => ok(svc.commitImport(u, params.id), 201));
route('POST', `${P_}/import/:id/cancel`, 'qbank:import', ({ u, params }) => svc.cancelBatch(u, params.id));
route('GET', `${P_}/rounds`, 'qbank:read', () => svc.listRounds());
route('PUT', `${P_}/rounds/:n`, 'config:write', ({ u, params, body }) => svc.updateRound(u, params.n, body));
route('GET', `${P_}/assessments`, 'qbank:read', ({ query }) => asm.list(query));
route('POST', `${P_}/assessments`, 'qbank:write', ({ u, body }) => ok(asm.create(u, body), 201));
route('GET', `${P_}/assessments/:id`, 'qbank:read', ({ params }) => asm.get(params.id));
route('PUT', `${P_}/assessments/:id`, 'qbank:write', ({ u, params, body }) => asm.update(u, params.id, body));
route('POST', `${P_}/assessments/:id/publish`, 'assessment:publish', ({ u, params, body }) => asm.setPublished(u, params.id, body && body.action));
route('GET', `${P_}/assessments/:id/preview`, 'qbank:read', ({ params, query }) => asm.preview(params.id, query));
route('POST', `${P_}/assessments/:id/assign`, 'assessment:assign', ({ u, params, body }) => asm.assign(u, params.id, body));
route('POST', `${P_}/assessments/:id/results`, 'results:publish', ({ u, params, body }) => asm.publishResults(u, params.id, body));
route('GET', `${P_}/assessments/:id/report`, 'results:read', ({ params }) => asm.report(params.id));
route('GET', `${P_}/submissions/export`, 'results:read', ({ u, query }) => ({ file: sub.export(u, query) }));
route('GET', `${P_}/submissions`, 'results:read', ({ query }) => sub.list(query));
route('GET', `${P_}/attempts/:id`, 'results:read', ({ u, params }) => sub.detail(u, params.id));
route('PUT', `${P_}/attempts/:id/review/:qid`, 'results:read', ({ u, params, body }) => sub.review(u, params.id, params.qid, body));
route('POST', `${P_}/attempts/:id/reinstate`, 'stage:change', ({ u, params, body }) => att.reinstate(u, params.id, body));
route('GET', `${P_}/audit`, 'qbank:read', ({ query }) => sub.audit(query));
route('GET', `${P_}/my/assessments`, 'attempt:own', ({ u }) => att.listMine(u));
route('GET', `${P_}/my/attempts/:id`, 'attempt:own', ({ u, params }) => att.info(u, params.id));
route('POST', `${P_}/my/attempts/:id/start`, 'attempt:own', ({ u, params }) => att.start(u, params.id));
route('GET', `${P_}/my/attempts/:id/paper`, 'attempt:own', ({ u, params }) => att.paper(u, params.id));
route('PUT', `${P_}/my/attempts/:id/responses`, 'attempt:own', ({ u, params, body }) => att.save(u, params.id, body && body.items));
route('POST', `${P_}/my/attempts/:id/submit`, 'attempt:own', ({ u, params, body }) => att.submit(u, params.id, body || {}));
route('POST', `${P_}/my/attempts/:id/events`, 'attempt:own', ({ u, params, body }) => att.event(u, params.id, body));
route('POST', `${P_}/my/attempts/:id/request-review`, 'attempt:own', ({ u, params }) => att.requestReview(u, params.id));
route('GET', `${P_}/my/attempts/:id/result`, 'attempt:own', ({ u, params }) => att.result(u, params.id));
route('GET', '/api/candidates', 'candidate:read', ({ query }) => {
  const st = query.stage; let r = S.candidates.filter(c => !st || c.stage === st);
  return { items: sortBy([...r], ['full_name', 1]).slice(0, 100).map(c => ({ id: c.id, candidate_code: c.candidate_code, full_name: c.full_name, email: c.email, role_code: c.role_code, stage: c.stage, application_id: c.application_id })) };
});

// Entry point: returns { status, json } or { status:200, file }
function handle(method, url, { body, raw, mime } = {}) {
  load();   // another tab may have changed the data
  const u0 = new URL(url, 'http://demo.local'); const path = u0.pathname; const query = Object.fromEntries(u0.searchParams);
  try {
    if (path === '/api/auth/login' && method === 'POST') {
      const user = S.users.find(x => x.email.toLowerCase() === String(body && body.email || '').trim().toLowerCase());
      if (!user || String(body.password) !== 'demo') return err(401, 'invalid_credentials', 'E-mail or password is incorrect. (Demo password: demo)');
      setUser(user.id); return ok({ ok: true });
    }
    if (path === '/api/auth/logout') { setUser(null); return ok({ ok: true }); }
    const u = currentUser();
    if (path === '/api/me') return u ? ok({ id: u.id, email: u.email, full_name: u.full_name, role: u.role }) : err(401, 'unauthenticated', 'Sign in required.');
    for (const r of ROUTES) {
      if (r.method !== method) continue; const m = r.re.exec(path); if (!m) continue;
      if (!u) return err(401, 'unauthenticated', 'Sign in required.');
      if (!can(u, r.cap)) return err(403, 'forbidden', 'You do not have permission for this.');
      const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const out = r.fn({ u, params, query, body, raw, mime });
      if (out && (out.json !== undefined || out.file)) return out.file ? { status: 200, file: out.file } : out;
      return ok(out);
    }
    return err(404, 'not_found', 'Not found.');
  } catch (e) {
    if (e && e.status && e.code) { const j = { error: e.code, message: e.message }; for (const k of ['fields', 'shortfalls', 'existing', 'result']) if (e[k] !== undefined) j[k] = e[k]; return { status: e.status, json: j }; }
    console.error(e); return err(500, 'server_error', 'Something went wrong in the demo.');
  } finally { save(); }
}

module.exports = { handle, reset, sweep: att.sweep, state: () => S, users: () => S.users.map(u => ({ email: u.email, full_name: u.full_name, role: u.role })) };
