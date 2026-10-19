'use strict';
// Question bank: browse, create, edit, archive, import (preview then commit), round settings, export.
// Every function takes ctx = { db, actor, audit } so it can run under HTTP, a script or a test.
const { validateQuestion, toFlat, COLUMNS, LETTERS } = require('./schema');
const importer = require('./importer');
const { writeCsv } = require('./csv');
const { writeXlsx } = require('./xlsx');
const { MIMES } = require('./templates');
const U = require('./util');

const Q_COLS = `id, question_code, question_text, type, options, correct_answer, reference_answer, explanation, difficulty, role_code, round, topic, marks, negative_marks, shuffle_options, status, version, import_batch_id, created_at, updated_at`;
const SORTS = { updated: 'updated_at DESC', created: 'created_at DESC', code: 'question_code ASC', round: 'round ASC, topic ASC, difficulty ASC', topic: 'topic ASC, question_code ASC' };

function qOut(r, withFlat = false) {
  if (!r) return r;
  const o = { ...r, marks: Number(r.marks), negative_marks: Number(r.negative_marks), round: Number(r.round), version: Number(r.version) };
  if (withFlat) o.flat = toFlat(o);
  return o;
}
const snapshotOf = r => ({ question_code: r.question_code, question_text: r.question_text, type: r.type, options: r.options, correct_answer: r.correct_answer, reference_answer: r.reference_answer, explanation: r.explanation, difficulty: r.difficulty, role_code: r.role_code, round: Number(r.round), topic: r.topic, marks: Number(r.marks), negative_marks: Number(r.negative_marks), status: r.status });
const json = v => (v === null || v === undefined ? null : JSON.stringify(v));

function filterSql(q, p = []) {
  const where = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
  if (q.q) { p.push(`%${U.likeEscape(String(q.q).slice(0, 100))}%`); where.push(`(question_text ILIKE $${p.length} OR question_code ILIKE $${p.length} OR topic ILIKE $${p.length})`); }
  if (q.round) add('round = ?', U.int(q.round, 'round', { min: 1, max: 5 }));
  if (q.type) add('type = ?::bank_question_type', U.oneOf(q.type, 'type', ['mcq', 'multi_select', 'descriptive']));
  if (q.difficulty) add('difficulty = ?::bank_difficulty', U.oneOf(q.difficulty, 'difficulty', ['easy', 'medium', 'hard']));
  if (q.role) { if (String(q.role).toUpperCase() === 'ALL') where.push('role_code IS NULL'); else add('role_code = ?', String(q.role).toUpperCase().slice(0, 20)); }
  if (q.topic) add('lower(topic) = lower(?)', String(q.topic).slice(0, 60));
  const st = q.status || 'live';
  if (st === 'live') where.push(`status <> 'archived'`);
  else if (st !== 'all') add('status = ?', U.oneOf(st, 'status', ['active', 'inactive', 'archived']));
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
}

// ---------------------------------------------------------------- browse
async function listQuestions(ctx, query) {
  const pg = U.page(query);
  const { where, p } = filterSql(query);
  const order = SORTS[query.sort] || SORTS.updated;
  const total = Number((await ctx.db.query(`SELECT count(*) AS n FROM question_bank ${where}`, p)).rows[0].n);
  const rows = (await ctx.db.query(`SELECT ${Q_COLS} FROM question_bank ${where} ORDER BY ${order}, id LIMIT ${pg.per} OFFSET ${pg.offset}`, p)).rows;
  return { items: rows.map(r => qOut(r)), total, page: pg.page, per: pg.per };
}

async function getQuestion(ctx, id) {
  U.uuid(id);
  const r = (await ctx.db.query(`SELECT ${Q_COLS} FROM question_bank WHERE id=$1`, [id])).rows[0];
  if (!r) throw U.notFound();
  const versions = (await ctx.db.query(`SELECT v.version, v.change_note, v.changed_at, u.full_name AS changed_by FROM question_versions v LEFT JOIN users u ON u.id=v.changed_by WHERE v.question_id=$1 ORDER BY v.version DESC LIMIT 20`, [id])).rows;
  const usage = (await ctx.db.query(`SELECT count(*) AS n FROM attempt_questions WHERE bank_question_id=$1`, [id])).rows[0].n;
  return { ...qOut(r, true), versions, times_issued: Number(usage) };
}

async function meta(ctx) {
  const topics = (await ctx.db.query(`SELECT round, topic, count(*)::int AS n FROM question_bank WHERE status <> 'archived' GROUP BY round, topic ORDER BY round, topic`)).rows;
  const roles = (await ctx.db.query(`SELECT code FROM (SELECT role_code AS code FROM question_bank WHERE role_code IS NOT NULL UNION SELECT role_code FROM vacancies WHERE role_code IS NOT NULL) x ORDER BY code`)).rows.map(r => r.code);
  const rounds = (await ctx.db.query(`SELECT round, name, enabled, published FROM round_settings ORDER BY round`)).rows;
  return { topics, roles, rounds, types: ['mcq', 'multi_select', 'descriptive'], difficulties: ['easy', 'medium', 'hard'], columns: COLUMNS.map(c => ({ key: c.key, required: c.required, help: c.help })) };
}

// How many active questions exist per topic and difficulty for a round (and optionally a role): drives the blueprint form.
async function poolMatrix(ctx, query) {
  const round = U.int(query.round, 'round', { min: 1, max: 5 });
  const role = query.role ? String(query.role).toUpperCase().slice(0, 20) : null;
  const rows = (await ctx.db.query(`SELECT topic, difficulty::text AS difficulty, count(*)::int AS n FROM question_bank WHERE round=$1 AND status='active' AND (role_code IS NULL OR role_code=$2) GROUP BY topic, difficulty ORDER BY topic, difficulty`, [round, role])).rows;
  return { round, role, cells: rows };
}

// ---------------------------------------------------------------- single question CRUD
function sqlValues(d) {
  return [d.question_text, d.type, json(d.options), json(d.correct_answer), d.reference_answer, d.explanation, d.difficulty, d.role_code, d.round, d.topic, d.marks, d.negative_marks, d.shuffle_options, d.status, d.text_hash];
}
async function duplicateOf(c, d, exceptId = null) {
  return (await c.query(`SELECT id, question_code FROM question_bank WHERE round=$1 AND text_hash=$2 AND status <> 'archived' AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`, [d.round, d.text_hash, exceptId])).rows[0] || null;
}
function fail(v) {
  return U.bad(v.errors.map(e => e.message).join(' '), v.errors.map(e => ({ path: e.field, message: e.message })));
}

async function createQuestion(ctx, body) {
  const v = validateQuestion(body || {});
  if (!v.ok) throw fail(v);
  const d = v.data;
  return ctx.db.tx(async c => {
    if (d.question_code && (await c.query(`SELECT 1 FROM question_bank WHERE lower(question_code)=lower($1)`, [d.question_code])).rows[0]) throw new U.ServiceError(409, 'duplicate_id', `Question ID "${d.question_code}" is already used.`);
    const dup = await duplicateOf(c, d);
    if (dup) throw new U.ServiceError(409, 'duplicate_question', `The same question text already exists in round ${d.round} as ${dup.question_code}.`, { existing: dup });
    const r = (await c.query(`INSERT INTO question_bank(question_code, question_text, type, options, correct_answer, reference_answer, explanation, difficulty, role_code, round, topic, marks, negative_marks, shuffle_options, status, text_hash, created_by, updated_by)
      VALUES (COALESCE($1, next_question_code()), $2, $3::bank_question_type, $4::jsonb, $5::jsonb, $6, $7, $8::bank_difficulty, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17) RETURNING ${Q_COLS}`, [d.question_code, ...sqlValues(d), ctx.actor.id])).rows[0];
    await c.query(`INSERT INTO question_versions(question_id, version, snapshot, change_note, changed_by) VALUES ($1,1,$2::jsonb,'Created',$3)`, [r.id, JSON.stringify(snapshotOf(r)), ctx.actor.id]);
    await ctx.audit('qb.question.create', 'question', r.question_code, null, { round: r.round, topic: r.topic, type: r.type }, c);
    return qOut(r, true);
  });
}

async function updateQuestion(ctx, id, body, note) {
  U.uuid(id);
  return ctx.db.tx(async c => {
    const cur = (await c.query(`SELECT ${Q_COLS} FROM question_bank WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw U.notFound();
    if (cur.status === 'archived') throw new U.ServiceError(409, 'archived', 'This question is archived. Restore it before editing.');
    const merged = { ...toFlat(qOut(cur)), ...(body || {}) };
    if (body && body.question_id !== undefined && String(body.question_id).trim().toLowerCase() !== cur.question_code.toLowerCase()) throw U.bad('The question ID cannot be changed.', [{ path: 'question_id', message: 'Cannot be changed' }]);
    merged.question_id = cur.question_code;
    const v = validateQuestion(merged);
    if (!v.ok) throw fail(v);
    const d = v.data;
    const dup = await duplicateOf(c, d, id);
    if (dup) throw new U.ServiceError(409, 'duplicate_question', `The same question text already exists in round ${d.round} as ${dup.question_code}.`, { existing: dup });
    const r = (await c.query(`UPDATE question_bank SET question_text=$2, type=$3::bank_question_type, options=$4::jsonb, correct_answer=$5::jsonb, reference_answer=$6, explanation=$7, difficulty=$8::bank_difficulty, role_code=$9, round=$10, topic=$11, marks=$12, negative_marks=$13, shuffle_options=$14, status=$15, text_hash=$16, version=version+1, updated_by=$17, updated_at=now() WHERE id=$1 RETURNING ${Q_COLS}`, [id, ...sqlValues(d), ctx.actor.id])).rows[0];
    await c.query(`INSERT INTO question_versions(question_id, version, snapshot, change_note, changed_by) VALUES ($1,$2,$3::jsonb,$4,$5)`, [id, r.version, JSON.stringify(snapshotOf(r)), (note || 'Edited').slice(0, 200), ctx.actor.id]);
    await ctx.audit('qb.question.update', 'question', r.question_code, snapshotOf(cur), snapshotOf(r), c);
    return qOut(r, true);
  });
}

async function setStatus(ctx, ids, status) {
  U.oneOf(status, 'status', ['active', 'inactive', 'archived']);
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw U.bad('Select between 1 and 500 questions.');
  ids.forEach(i => U.uuid(i));
  return ctx.db.tx(async c => {
    const cur = (await c.query(`SELECT id, question_code, status FROM question_bank WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids])).rows;
    if (cur.length !== new Set(ids).size) throw U.notFound();
    const changed = cur.filter(q => q.status !== status);
    for (const q of changed) {
      try { await c.query(`UPDATE question_bank SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1`, [q.id, status, ctx.actor.id]); }
      catch (e) { if (e.code === '23505') { throw new U.ServiceError(409, 'duplicate_question', `${q.question_code} cannot be restored because an active question with the same text already exists in its round.`); } throw e; }
    }
    if (changed.length) await ctx.audit(`qb.question.${status === 'archived' ? 'archive' : status === 'active' ? 'activate' : 'deactivate'}`, 'question', changed.map(q => q.question_code).slice(0, 20).join(','), { status: [...new Set(changed.map(q => q.status))].join() }, { status, count: changed.length }, c);
    return { updated: changed.length, unchanged: cur.length - changed.length };
  });
}

// ---------------------------------------------------------------- import: preview, then commit once
const BATCH_TTL_MS = 2 * 60 * 60 * 1000;

async function existingFor(c, items) {
  const codes = [...new Set(items.filter(i => i.data && i.data.question_code).map(i => i.data.question_code.toLowerCase()))];
  const hashes = [...new Set(items.filter(i => i.data && i.data.text_hash).map(i => i.data.text_hash))];
  const ex = { byCode: new Map(), byHash: new Map() };
  if (!codes.length && !hashes.length) return ex;
  const rows = (await c.query(`SELECT id, question_code, round, status, text_hash FROM question_bank WHERE lower(question_code) = ANY($1) OR text_hash = ANY($2)`, [codes, hashes])).rows;
  for (const r of rows) {
    const rec = { id: r.id, code: r.question_code, status: r.status, round: Number(r.round) };
    if (codes.includes(r.question_code.toLowerCase())) ex.byCode.set(r.question_code.toLowerCase(), rec);
    if (r.status !== 'archived') ex.byHash.set(`${r.round}|${r.text_hash}`, rec);
  }
  return ex;
}

async function previewImport(ctx, { buffer, fileName, mime, onConflict }) {
  const oc = U.oneOf(onConflict || 'skip', 'on_conflict', ['skip', 'update']);
  const format = importer.checkUpload({ buffer, fileName, mime });
  const parsed = importer.parseFile(buffer, format);
  const first = importer.buildPreview(parsed, undefined, oc);
  if (first.fileErrors.length) return { batchId: null, format, fileName, fileErrors: first.fileErrors, warnings: first.warnings, summary: first.summary, rows: [] };
  const plan = importer.buildPreview(parsed, await existingFor(ctx.db, first.rows), oc);
  const sha = importer.sha256(buffer);
  const prior = (await ctx.db.query(`SELECT committed_at FROM qb_import_batches WHERE file_sha256=$1 AND status='committed' ORDER BY committed_at DESC LIMIT 1`, [sha])).rows[0];
  if (prior) plan.warnings.push(`This exact file was already imported on ${new Date(prior.committed_at).toISOString().slice(0, 10)}. Importing it again will skip every existing question.`);
  const batch = (await ctx.db.query(`INSERT INTO qb_import_batches(created_by, file_name, file_format, file_sha256, file_size, on_conflict, rows, summary, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id, expires_at`,
    [ctx.actor.id, String(fileName).slice(0, 200), format, sha, buffer.length, oc, JSON.stringify(plan.rows), JSON.stringify({ ...plan.summary, warnings: plan.warnings }), new Date(Date.now() + BATCH_TTL_MS)])).rows[0];
  await ctx.audit('qb.import.preview', 'import_batch', batch.id, null, { file: fileName, format, ...plan.summary });
  return { batchId: batch.id, expiresAt: batch.expires_at, format, fileName, fileErrors: [], warnings: plan.warnings, summary: plan.summary, rows: pageRows(plan.rows, {}) };
}

function pageRows(rows, { status, page = 1, per = 100 }) {
  let r = rows;
  if (status && status !== 'all') r = r.filter(x => x.status === status);
  else if (!status) r = [...rows.filter(x => x.status === 'error'), ...rows.filter(x => x.status !== 'error')];
  const start = (Math.max(1, page) - 1) * per;
  return r.slice(start, start + per).map(x => ({ row: x.row, status: x.status, errors: x.errors, warnings: x.warnings, existing: x.existing, preview: x.data ? previewOf(x.data) : null }));
}
function previewOf(d) {
  return { question_code: d.question_code, question_text: d.question_text, type: d.type, options: d.options, answer: d.type === 'mcq' ? LETTERS[d.correct_answer] : d.type === 'multi_select' ? (d.correct_answer || []).map(i => LETTERS[i]).join(',') : null, difficulty: d.difficulty, role_code: d.role_code, round: d.round, topic: d.topic, marks: d.marks, negative_marks: d.negative_marks, status: d.status };
}

async function loadBatch(c, id, actor, { lock = false } = {}) {
  U.uuid(id);
  const b = (await c.query(`SELECT * FROM qb_import_batches WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!b || (b.created_by !== actor.id && actor.role !== 'super_admin')) throw U.notFound();
  return b;
}
async function getBatch(ctx, id, query = {}) {
  const b = await loadBatch(ctx.db, id, ctx.actor);
  const pg = U.page(query, { per: 100, maxPer: 200 });
  return { batchId: b.id, fileName: b.file_name, format: b.file_format, status: b.status, onConflict: b.on_conflict, expiresAt: b.expires_at, summary: b.summary, result: b.result, rows: pageRows(b.rows, { status: query.status, page: pg.page, per: pg.per }) };
}
async function listBatches(ctx) {
  const rows = (await ctx.db.query(`SELECT b.id, b.file_name, b.file_format, b.status, b.summary, b.result, b.created_at, b.committed_at, u.full_name AS created_by FROM qb_import_batches b JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC LIMIT 50`)).rows;
  return { items: rows };
}

async function cancelBatch(ctx, id) {
  return ctx.db.tx(async c => {
    const b = await loadBatch(c, id, ctx.actor, { lock: true });
    if (b.status !== 'previewed') throw new U.ServiceError(409, 'not_pending', `This import is already ${b.status}.`);
    await c.query(`UPDATE qb_import_batches SET status='cancelled' WHERE id=$1`, [id]);
    await ctx.audit('qb.import.cancel', 'import_batch', id, null, null, c);
    return { ok: true };
  });
}

async function commitImport(ctx, id) {
  return ctx.db.tx(async c => {
    const b = await loadBatch(c, id, ctx.actor, { lock: true });       // row lock: a second click waits here and then sees "committed"
    if (b.status === 'committed') throw new U.ServiceError(409, 'already_committed', 'This import was already completed.', { result: b.result });
    if (b.status !== 'previewed') throw new U.ServiceError(409, 'not_pending', `This import was ${b.status}.`);
    if (new Date(b.expires_at) < new Date()) throw new U.ServiceError(410, 'expired', 'This preview expired. Upload the file again.');
    const todo = b.rows.filter(r => r.status === 'new' || r.status === 'update');
    if (!todo.length) throw U.bad('There are no valid rows to import.');
    const res = { created: 0, updated: 0, skipped: 0, skippedRows: [], codes: [] };
    for (const it of todo) {
      const d = it.data;
      let existing = d.question_code ? (await c.query(`SELECT id, question_code, status, version FROM question_bank WHERE lower(question_code)=lower($1) FOR UPDATE`, [d.question_code])).rows[0] : null;
      if (existing && (b.on_conflict !== 'update' || existing.status === 'archived')) { res.skipped++; res.skippedRows.push({ row: it.row, reason: existing.status === 'archived' ? 'ID belongs to an archived question' : 'ID already exists' }); continue; }
      if (existing) {
        const upd = (await c.query(`UPDATE question_bank SET question_text=$2, type=$3::bank_question_type, options=$4::jsonb, correct_answer=$5::jsonb, reference_answer=$6, explanation=$7, difficulty=$8::bank_difficulty, role_code=$9, round=$10, topic=$11, marks=$12, negative_marks=$13, shuffle_options=$14, status=$15, text_hash=$16, version=version+1, updated_by=$17, updated_at=now(), import_batch_id=$18
            WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM question_bank o WHERE o.round=$10 AND o.text_hash=$16 AND o.status <> 'archived' AND o.id <> $1) RETURNING ${Q_COLS}`, [existing.id, ...sqlValues(d), ctx.actor.id, b.id])).rows[0];
        if (!upd) { res.skipped++; res.skippedRows.push({ row: it.row, reason: 'Same wording now exists in that round' }); continue; }
        await c.query(`INSERT INTO question_versions(question_id, version, snapshot, change_note, changed_by) VALUES ($1,$2,$3::jsonb,$4,$5)`, [upd.id, upd.version, JSON.stringify(snapshotOf(upd)), `Updated by import ${b.file_name}`.slice(0, 200), ctx.actor.id]);
        res.updated++; res.codes.push(upd.question_code);
        continue;
      }
      const ins = (await c.query(`INSERT INTO question_bank(question_code, question_text, type, options, correct_answer, reference_answer, explanation, difficulty, role_code, round, topic, marks, negative_marks, shuffle_options, status, text_hash, import_batch_id, created_by, updated_by)
        VALUES (COALESCE($1, next_question_code()), $2, $3::bank_question_type, $4::jsonb, $5::jsonb, $6, $7, $8::bank_difficulty, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18) ON CONFLICT DO NOTHING RETURNING ${Q_COLS}`, [d.question_code, ...sqlValues(d).slice(0, 14), d.text_hash, b.id, ctx.actor.id].flat())).rows[0];
      if (!ins) { res.skipped++; res.skippedRows.push({ row: it.row, reason: 'Created by someone else while you were reviewing' }); continue; }
      await c.query(`INSERT INTO question_versions(question_id, version, snapshot, change_note, changed_by) VALUES ($1,1,$2::jsonb,$3,$4)`, [ins.id, JSON.stringify(snapshotOf(ins)), `Imported from ${b.file_name}`.slice(0, 200), ctx.actor.id]);
      res.created++; res.codes.push(ins.question_code);
    }
    const result = { created: res.created, updated: res.updated, skipped: res.skipped + (b.rows.length - todo.length), skippedRows: res.skippedRows.slice(0, 50), codes: res.codes.slice(0, 50) };
    await c.query(`UPDATE qb_import_batches SET status='committed', committed_at=now(), committed_by=$2, result=$3::jsonb WHERE id=$1`, [id, ctx.actor.id, JSON.stringify(result)]);
    await ctx.audit('qb.import.commit', 'import_batch', id, null, { file: b.file_name, created: result.created, updated: result.updated, skipped: result.skipped }, c);
    return result;
  });
}

// ---------------------------------------------------------------- rounds
async function listRounds(ctx) {
  const rows = (await ctx.db.query(`SELECT r.round, r.name, r.description, r.enabled, r.published, r.duration_minutes, r.pass_threshold_pct, r.eligibility, r.updated_at,
      (SELECT count(*) FROM question_bank q WHERE q.round=r.round AND q.status='active')::int AS active_questions,
      (SELECT count(*) FROM assessments a WHERE a.round=r.round AND a.source='bank' AND a.status='active')::int AS live_assessments
      FROM round_settings r ORDER BY r.round`)).rows;
  return { items: rows.map(r => ({ ...r, round: Number(r.round), pass_threshold_pct: Number(r.pass_threshold_pct) })) };
}
async function updateRound(ctx, n, body) {
  const round = U.int(n, 'round', { min: 1, max: 5 });
  return ctx.db.tx(async c => {
    const cur = (await c.query(`SELECT * FROM round_settings WHERE round=$1 FOR UPDATE`, [round])).rows[0];
    if (!cur) throw U.notFound();
    const b = body || {};
    const e = b.eligibility === undefined ? cur.eligibility : b.eligibility;
    if (!e || typeof e !== 'object' || typeof e.require_stage !== 'boolean' || !(e.min_previous_pct === null || (typeof e.min_previous_pct === 'number' && e.min_previous_pct >= 0 && e.min_previous_pct <= 100))) throw U.bad('Eligibility must be { require_stage: true|false, min_previous_pct: null or 0-100 }.');
    const nv = {
      name: b.name === undefined ? cur.name : U.str(b.name, 'name', { min: 2, max: 80 }),
      description: b.description === undefined ? cur.description : U.str(b.description, 'description', { max: 500, optional: true }),
      enabled: b.enabled === undefined ? cur.enabled : U.bool(b.enabled, 'enabled'),
      published: b.published === undefined ? cur.published : U.bool(b.published, 'published'),
      duration_minutes: b.duration_minutes === undefined ? Number(cur.duration_minutes) : U.int(b.duration_minutes, 'duration_minutes', { min: 1, max: 480 }),
      pass_threshold_pct: b.pass_threshold_pct === undefined ? Number(cur.pass_threshold_pct) : U.num(b.pass_threshold_pct, 'pass_threshold_pct', { min: 0, max: 100 }),
      eligibility: { require_stage: e.require_stage, min_previous_pct: e.min_previous_pct },
    };
    if (nv.published && !nv.enabled) throw U.bad('A round must be enabled before it can be published.');
    const r = (await c.query(`UPDATE round_settings SET name=$2, description=$3, enabled=$4, published=$5, duration_minutes=$6, pass_threshold_pct=$7, eligibility=$8::jsonb, updated_by=$9, updated_at=now() WHERE round=$1 RETURNING *`,
      [round, nv.name, nv.description, nv.enabled, nv.published, nv.duration_minutes, nv.pass_threshold_pct, JSON.stringify(nv.eligibility), ctx.actor.id])).rows[0];
    const pick = o => ({ name: o.name, description: o.description, enabled: o.enabled, published: o.published, duration_minutes: Number(o.duration_minutes), pass_threshold_pct: Number(o.pass_threshold_pct), eligibility: o.eligibility });
    await ctx.audit('qb.round.update', 'round', round, pick(cur), pick(r), c);
    return { ...r, round };
  });
}

// ---------------------------------------------------------------- export
const EXPORT_HEAD = [...COLUMNS.map(c => c.label), 'version', 'last_updated'];
async function exportQuestions(ctx, query) {
  const format = U.oneOf(query.format || 'xlsx', 'format', ['csv', 'xlsx']);
  const { where, p } = filterSql(query);
  const rows = (await ctx.db.query(`SELECT ${Q_COLS} FROM question_bank ${where} ORDER BY round, topic, question_code LIMIT 20000`, p)).rows.map(r => qOut(r));
  const data = rows.map(r => { const f = toFlat(r); return [...COLUMNS.map(c => f[c.key]), r.version, new Date(r.updated_at).toISOString().slice(0, 10)]; });
  await ctx.audit('qb.export', 'question', 'bank', null, { rows: rows.length, format });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') return { body: Buffer.from(writeCsv([EXPORT_HEAD, ...data]), 'utf8'), mime: MIMES.csv, fileName: `semil-question-bank-${stamp}.csv` };
  return { body: writeXlsx([{ name: 'Questions', rows: [EXPORT_HEAD, ...data], widths: [14, 60, 14, 22, 22, 22, 22, 18, 40, 11, 16, 8, 20, 8, 15, 10, 8, 12] }]), mime: MIMES.xlsx, fileName: `semil-question-bank-${stamp}.xlsx` };
}

module.exports = { listQuestions, getQuestion, meta, poolMatrix, createQuestion, updateQuestion, setStatus, previewImport, getBatch, listBatches, cancelBatch, commitImport, listRounds, updateRound, exportQuestions, qOut };
