'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('node:crypto');
const { z } = require('zod');

const perms = require('./permissions');
const scoring = require('./scoring');
const { hashPassword, verifyPassword, passwordProblems } = require('./passwords');
const sessions = require('./sessions');
const { validateUpload } = require('./storage');
const proctor = require('./proctoring');
const importer = require('./importer');
const path = require('node:path');
const { mountCamera } = require('./camera');
const { mountReports } = require('./reports');
const qb = require('./qb/routes');

const COOKIE = 'ntg_session';
const STAGES = ['applied', 'round_1', 'round_2', 'round_3', 'round_4', 'round_5', 'selected', 'offer_sent', 'offer_accepted', 'joined', 'rejected', 'on_hold'];
const DUMMY_HASH = hashPassword('not-a-real-password-0');   // keeps login timing the same for unknown emails

/**
 * @param {{db:{query:Function, tx:Function}, storage:object, mailer?:{send:Function}, rateLimiter?:object, sessionCache?:object, isProd?:boolean}} deps
 * Dependencies are injected so the same app runs against a real database in production and a
 * test database in integration tests.
 */
function createApp({ db, storage, mailer, rateLimiter, sessionCache, isProd = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  const send = mailer || { async send(to, subject, body) { if (!isProd) console.log(`[mail to ${to}] ${subject}\n${body}`); } };

  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- CSRF: cookies are SameSite=Strict, and every state-changing call must carry a custom header
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'semil') return res.status(403).json({ error: 'csrf_check_failed' });
    next();
  });

  // ---- authentication: resolves the session cookie to a user on every request
  app.use(h(async (req, res, next) => {
    const token = req.cookies && req.cookies[COOKIE];
    if (sessionCache && token) {
      const cached = await sessionCache.get(sessions.hashToken(token));
      if (cached) { req.user = cached; return next(); }
    }
    const user = await sessions.lookupSession(db, token);
    if (user && sessionCache && token) {
      await sessionCache.set(sessions.hashToken(token), user);
    }
    req.user = user;
    next();
  }));
  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'unauthenticated' }));

  async function audit(req, action, entityType, entityId, before, after, client = db) {
    await client.query(
      `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, before, after, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user ? req.user.id : null, req.user ? req.user.role : null, action, entityType, String(entityId || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.ip || null]);
  }

  // ---- rate limiter: Redis-backed when available, in-memory fallback ----
  const _memLimiter = { _m: new Map(), limited(k) { const now = Date.now(); const a = (this._m.get(k)||[]).filter(t=>now-t<15*60*1000); this._m.set(k,a); return a.length>=10; }, note(k) { this._m.set(k,[...(this._m.get(k)||[]),Date.now()]); } };
  async function limited(key) {
    if (rateLimiter) return rateLimiter.isLimited(key);
    return _memLimiter.limited(key);
  }
  async function noteAttempt(key) {
    if (rateLimiter) return rateLimiter.note(key);
    _memLimiter.note(key);
  }

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: isProd ? '1h' : 0 }));   // web app (admin, HR and candidate screens)

  // =====================================================================================
  // Auth
  // =====================================================================================
  const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
  app.post('/api/auth/login', h(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const key = `${req.ip}|${email.toLowerCase()}`;
    if (await limited(key)) return res.status(429).json({ error: 'too_many_attempts' });
    const { rows } = await db.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    const u = rows[0];
    const locked = u && u.locked_until && new Date(u.locked_until) > new Date();
    const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && u && u.is_active && !locked;
    if (!ok) {
      await noteAttempt(key);
      if (u) await db.query(`UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id=$1`, [u.id]);
      return res.status(401).json({ error: 'invalid_credentials' });   // same message for every failure
    }
    await db.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
    const token = await sessions.createSession(db, u.id, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(COOKIE, token, { httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: sessions.ABSOLUTE_MS, path: '/' });
    req.user = { id: u.id, role: u.role };
    await audit(req, 'auth.login', 'user', u.id);
    res.json({ id: u.id, email: u.email, full_name: u.full_name, role: u.role });
  }));

  app.post('/api/auth/logout', h(async (req, res) => {
    const t = req.cookies && req.cookies[COOKIE];
    if (t) {
      if (sessionCache) await sessionCache.invalidate(sessions.hashToken(t));
      await sessions.revokeSession(db, t);
    }
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

  app.post('/api/auth/forgot', h(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const { rows } = await db.query('SELECT id, email FROM users WHERE lower(email)=lower($1) AND is_active', [email]);
    if (rows[0]) {
      const token = sessions.newToken();
      await db.query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [rows[0].id, sessions.hashToken(token)]);
      if (send.sendTemplate) {
        await send.sendTemplate(rows[0].email, 'password_reset', { name: rows[0].full_name, link: `${process.env.APP_ORIGIN || ''}/reset?token=${token}` });
      } else {
        await send.send(rows[0].email, 'Reset your Semil password', `Open this link within 30 minutes: ${process.env.APP_ORIGIN || ''}/reset?token=${token}`);
      }
    }
    res.json({ ok: true });   // identical response whether or not the email exists
  }));

  app.post('/api/auth/reset', h(async (req, res) => {
    const { token, password } = z.object({ token: z.string().min(20), password: z.string() }).parse(req.body);
    const { rows } = await db.query(
      `SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > now()`, [sessions.hashToken(token)]);
    if (!rows[0]) return res.status(400).json({ error: 'invalid_or_expired_token' });
    const problems = passwordProblems(password, rows[0].email);
    if (problems.length) return res.status(400).json({ error: 'weak_password', details: problems });
    await db.tx(async c => {
      await c.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [rows[0].user_id, hashPassword(password)]);
      await c.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [rows[0].id]);
      await sessions.revokeAllForUser(c, rows[0].user_id);   // signs out every other device
      if (sessionCache) await sessionCache.invalidateUser(rows[0].user_id);
    });
    res.json({ ok: true });
  }));

  // =====================================================================================
  // Candidates
  // =====================================================================================
  const phone = z.string().transform(s => s.replace(/[\s-]/g, '')).refine(s => /^\+?[0-9]{10,13}$/.test(s), 'Enter a valid mobile number');
  const url = z.string().url().refine(u => /^https?:\/\//i.test(u), 'Use an http(s) link');
  const candidateBase = z.object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    phone,
    city: z.string().trim().max(80).optional(),
    college_name: z.string().trim().max(200).optional(),
    degree: z.string().trim().max(120).optional(),
    branch: z.string().trim().max(120).optional(),
    graduation_year: z.number().int().min(2015).max(2035).optional(),
    academic_info: z.string().max(500).optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    experience: z.string().max(2000).optional(),
    portfolio_url: url.optional().or(z.literal('').transform(() => undefined)),
    certifications: z.string().max(2000).optional(),
    joining_availability: z.string().max(100).optional(),
    expected_compensation: z.string().max(100).optional(),
    source: z.string().max(60).optional(),
    hr_owner_id: z.string().uuid().optional(),
    assessor_id: z.string().uuid().optional(),
    internal_notes: z.string().max(4000).optional(),
    vacancy_id: z.string().uuid().optional(),
    campaign_id: z.string().uuid().optional(),
  });
  const COLS = ['full_name', 'email', 'phone', 'city', 'degree', 'branch', 'graduation_year', 'academic_info', 'skills', 'experience', 'portfolio_url', 'certifications', 'joining_availability', 'expected_compensation', 'source', 'hr_owner_id', 'assessor_id', 'internal_notes'];

  async function collegeId(client, name) {
    if (!name) return null;
    const r = await client.query(`INSERT INTO colleges(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [name]);
    return r.rows[0].id;
  }

  app.post('/api/candidates', requireAuth, perms.requireCap('candidate:write'), h(async (req, res) => {
    const d = candidateBase.parse(req.body);
    if (d.internal_notes !== undefined && !perms.can(req.user, 'candidate:notes')) return res.status(403).json({ error: 'forbidden' });
    const created = await db.tx(async c => {
      const cid = await collegeId(c, d.college_name);
      const vals = COLS.map(k => (k === 'skills' ? d.skills || [] : d[k] === undefined ? null : d[k]));
      const ins = await c.query(
        `INSERT INTO candidates(${COLS.join(',')}, college_id, created_by) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')}, $${COLS.length + 1}, $${COLS.length + 2}) RETURNING *`,
        [...vals, cid, req.user.id]);
      const cand = ins.rows[0];
      if (d.vacancy_id) await c.query('INSERT INTO applications(candidate_id, vacancy_id, campaign_id) VALUES ($1,$2,$3)', [cand.id, d.vacancy_id, d.campaign_id || null]);
      await audit(req, 'candidate.create', 'candidate', cand.id, null, { candidate_code: cand.candidate_code, email: cand.email }, c);
      return cand;
    });
    res.status(201).json(perms.candidateView(req.user, created));
  }));

  app.get('/api/candidates', requireAuth, h(async (req, res) => {
    const staffAll = perms.can(req.user, 'candidate:read');
    if (!staffAll && !perms.can(req.user, 'candidate:read:assigned')) return res.status(403).json({ error: 'forbidden' });
    const q = z.object({ q: z.string().max(100).optional(), college: z.string().optional(), role: z.string().optional(), stage: z.enum(STAGES).optional(), source: z.string().optional(), skill: z.string().max(40).optional(), year: z.coerce.number().int().optional(), page: z.coerce.number().int().min(1).default(1), per: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    const where = ['c.deleted_at IS NULL']; const p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
    if (!staffAll) add('c.assessor_id = ?', req.user.id);                      // assessors see only assigned candidates
    if (q.q) { p.push(`%${q.q}%`); where.push(`(c.full_name ILIKE $${p.length} OR c.candidate_code ILIKE $${p.length})`); }
    if (q.college) add('col.name = ?', q.college);
    if (q.role) add('v.role_code = ?', q.role);
    if (q.stage) add('a.stage = ?', q.stage);
    if (q.source) add('c.source = ?', q.source);
    if (q.year) add('c.graduation_year = ?', q.year);
    if (q.skill) add(`array_to_string(c.skills, ' ') ILIKE ?`, `%${q.skill}%`);
    const sql = `SELECT c.id, c.candidate_code, c.full_name, c.email, c.graduation_year, c.skills, c.source, col.name AS college, v.role_code, v.title AS role, a.stage, a.id AS application_id
        FROM candidates c LEFT JOIN colleges col ON col.id=c.college_id LEFT JOIN applications a ON a.candidate_id=c.id LEFT JOIN vacancies v ON v.id=a.vacancy_id
       WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${q.per} OFFSET ${(q.page - 1) * q.per}`;
    res.json({ items: (await db.query(sql, p)).rows, page: q.page });
  }));

  async function loadCandidate(id) {
    const { rows } = await db.query(`SELECT c.*, col.name AS college FROM candidates c LEFT JOIN colleges col ON col.id=c.college_id WHERE c.id=$1 AND c.deleted_at IS NULL`, [id]);
    return rows[0];
  }
  const uuid = z.string().uuid();

  app.get('/api/candidates/:id', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const c = await loadCandidate(id);
    const view = c && perms.candidateView(req.user, c);
    if (!view) return res.status(404).json({ error: 'not_found' });   // 404, not 403, so ids cannot be probed
    const apps = (await db.query(`SELECT a.id, a.stage, a.stage_entered_at, v.title, v.role_code FROM applications a JOIN vacancies v ON v.id=a.vacancy_id WHERE a.candidate_id=$1`, [id])).rows;
    const docs = (await db.query(`SELECT id, kind, original_name, size_bytes, created_at FROM documents WHERE candidate_id=$1 ORDER BY created_at DESC`, [id])).rows;
    res.json({ ...view, applications: apps, documents: docs });
  }));

  app.patch('/api/candidates/:id', requireAuth, perms.requireCap('candidate:write'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const d = candidateBase.partial().parse(req.body);
    if (d.internal_notes !== undefined && !perms.can(req.user, 'candidate:notes')) return res.status(403).json({ error: 'forbidden' });
    const before = await loadCandidate(id); if (!before) return res.status(404).json({ error: 'not_found' });
    const sets = [], p = [id];
    for (const k of COLS) if (d[k] !== undefined) { p.push(d[k]); sets.push(`${k}=$${p.length}`); }
    if (d.college_name !== undefined) { p.push(await collegeId(db, d.college_name)); sets.push(`college_id=$${p.length}`); }
    if (!sets.length) return res.json(perms.candidateView(req.user, before));
    const after = (await db.query(`UPDATE candidates SET ${sets.join(',')} WHERE id=$1 RETURNING *`, p)).rows[0];
    await audit(req, 'candidate.update', 'candidate', id, pick(before, Object.keys(d)), pick(after, Object.keys(d)));
    res.json(perms.candidateView(req.user, after));
  }));

  app.delete('/api/candidates/:id', requireAuth, perms.requireCap('candidate:delete'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const r = await db.query('UPDATE candidates SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'candidate.delete', 'candidate', id);
    res.json({ ok: true });
  }));

  // =====================================================================================
  // Documents (private storage, expiring signed links)
  // =====================================================================================
  async function canUseDocs(user, candidateId, write) {
    const c = await loadCandidate(candidateId); if (!c) return null;
    if (user.role === 'super_admin' || user.role === 'hr_admin') return c;
    if (user.role === 'candidate') return c.user_id === user.id ? c : null;
    if (!write && perms.can(user, 'document:read:assigned') && c.assessor_id === user.id) return c;
    return null;
  }

  app.post('/api/candidates/:id/documents', requireAuth, upload.single('file'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const kind = z.enum(['resume', 'photo', 'submission', 'presentation']).parse(req.query.kind);
    const c = await canUseDocs(req.user, id, true);
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const check = validateUpload(kind, req.file.originalname, req.file.buffer);
    if (!check.ok) return res.status(400).json({ error: 'invalid_file', message: check.error });
    const stored = await storage.put({ kind, ownerId: id, ext: check.ext }, req.file.buffer);
    const doc = (await db.query(
      `INSERT INTO documents(candidate_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, original_name, size_bytes, created_at`,
      [id, kind, stored.key, req.file.originalname.slice(0, 200), check.mime, stored.size, stored.sha256, req.user.id])).rows[0];
    await audit(req, 'document.upload', 'candidate', id, null, { kind, name: doc.original_name });
    res.status(201).json(doc);
  }));

  app.get('/api/documents/:id/link', requireAuth, h(async (req, res) => {
    const d = (await db.query('SELECT id, candidate_id, storage_key FROM documents WHERE id=$1', [uuid.parse(req.params.id)])).rows[0];
    if (!d || !(await canUseDocs(req.user, d.candidate_id, false))) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'document.link', 'document', d.id);
    res.json({ url: `/files/${storage.sign(d.storage_key, req.user.id, 600)}`, expires_in: 600 });
  }));

  app.get('/files/:token', requireAuth, h(async (req, res) => {
    const key = storage.verify(req.params.token, req.user.id);
    if (!key) return res.status(403).json({ error: 'link_invalid_or_expired' });
    const d = (await db.query('SELECT original_name, mime_type FROM documents WHERE storage_key=$1', [key])).rows[0];
    if (!d) return res.status(404).end();
    res.set({ 'Content-Type': d.mime_type, 'Content-Disposition': `attachment; filename="${d.original_name.replace(/[^\w.\- ]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(await storage.read(key));
  }));

  // =====================================================================================
  // Vacancies
  // =====================================================================================
  const vacancyBase = z.object({
    title: z.string().trim().min(3).max(150), role_code: z.string().max(20).optional(), track: z.enum(['technical', 'business']).default('technical'),
    department: z.string().max(100).optional(), description: z.string().max(5000).optional(), required_skills: z.array(z.string().max(40)).max(30).default([]),
    min_qualifications: z.string().max(1000).optional(), openings: z.number().int().min(1).max(500).default(1),
    salary_min_lpa: z.number().min(0).max(1000).optional(), salary_max_lpa: z.number().min(0).max(1000).optional(),
    location: z.string().max(120).default('Bengaluru, India'), employment_type: z.enum(['full_time', 'internship', 'contract']).default('full_time'),
    joining_timeline: z.string().max(100).optional(), application_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assessment_template: z.string().max(100).optional(), selection_criteria: z.string().max(3000).optional(), hiring_manager_id: z.string().uuid().optional(),
  });
  const vacancySchema = vacancyBase.refine(v => v.salary_max_lpa == null || v.salary_min_lpa == null || v.salary_max_lpa >= v.salary_min_lpa, { message: 'Maximum salary must be at least the minimum', path: ['salary_max_lpa'] });
  const VCOLS = ['title', 'role_code', 'track', 'department', 'description', 'required_skills', 'min_qualifications', 'openings', 'salary_min_lpa', 'salary_max_lpa', 'location', 'employment_type', 'joining_timeline', 'application_deadline', 'assessment_template', 'selection_criteria', 'hiring_manager_id'];

  app.get('/api/vacancies', requireAuth, h(async (req, res) => {
    if (req.user.role === 'candidate') {   // candidates only see published roles, and only public fields
      const r = await db.query(`SELECT id, title, department, description, required_skills, min_qualifications, location, employment_type, application_deadline FROM vacancies WHERE status='active'`);
      return res.json(r.rows);
    }
    res.json((await db.query(`SELECT v.*, (SELECT count(*) FROM applications a WHERE a.vacancy_id=v.id)::int AS applicants FROM vacancies v ORDER BY v.created_at DESC`)).rows);
  }));

  app.post('/api/vacancies', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const d = vacancySchema.parse(req.body);
    const r = await db.query(`INSERT INTO vacancies(${VCOLS.join(',')}, created_by) VALUES (${VCOLS.map((_, i) => '$' + (i + 1)).join(',')}, $${VCOLS.length + 1}) RETURNING *`, [...VCOLS.map(k => (d[k] === undefined ? null : d[k])), req.user.id]);
    await audit(req, 'vacancy.create', 'vacancy', r.rows[0].id, null, { title: d.title });
    res.status(201).json(r.rows[0]);
  }));

  app.patch('/api/vacancies/:id', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const d = vacancyBase.partial().parse(req.body);
    const sets = [], p = [id];
    for (const k of VCOLS) if (d[k] !== undefined) { p.push(d[k]); sets.push(`${k}=$${p.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    const r = await db.query(`UPDATE vacancies SET ${sets.join(',')} WHERE id=$1 RETURNING *`, p);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'vacancy.update', 'vacancy', id, null, d);
    res.json(r.rows[0]);
  }));

  app.post('/api/vacancies/:id/status', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { status } = z.object({ status: z.enum(['draft', 'active', 'closed']) }).parse(req.body);
    const v = (await db.query('SELECT * FROM vacancies WHERE id=$1', [id])).rows[0];
    if (!v) return res.status(404).json({ error: 'not_found' });
    if (status === 'active' && (!v.description || !v.application_deadline)) return res.status(400).json({ error: 'incomplete_vacancy', message: 'Add a role description and an application deadline before publishing.' });
    await db.query('UPDATE vacancies SET status=$2 WHERE id=$1', [id, status]);
    await audit(req, 'vacancy.status', 'vacancy', id, { status: v.status }, { status });
    res.json({ ok: true, status });
  }));

  app.post('/api/vacancies/:id/duplicate', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const r = await db.query(`INSERT INTO vacancies(${VCOLS.join(',')}, status, created_by) SELECT ${VCOLS.map(k => (k === 'title' ? `title || ' (copy)'` : k)).join(',')}, 'draft', $2 FROM vacancies WHERE id=$1 RETURNING *`, [id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(req, 'vacancy.duplicate', 'vacancy', id, null, { new_id: r.rows[0].id });
    res.status(201).json(r.rows[0]);
  }));

  // =====================================================================================
  // Stage changes, evaluations, scoring
  // =====================================================================================
  app.post('/api/applications/:id/stage', requireAuth, perms.requireCap('stage:change'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { to, reason } = z.object({ to: z.enum(STAGES), reason: z.string().trim().min(5, 'A reason is required').max(500) }).parse(req.body);
    const out = await db.tx(async c => {
      const a = (await c.query('SELECT id, stage FROM applications WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!a) return null;
      if (a.stage === to) return a;
      await c.query('UPDATE applications SET stage=$2, stage_entered_at=now() WHERE id=$1', [id, to]);
      await c.query('INSERT INTO stage_changes(application_id, from_stage, to_stage, manual, reason, changed_by) VALUES ($1,$2,$3,true,$4,$5)', [id, a.stage, to, reason, req.user.id]);
      await audit(req, 'application.stage', 'application', id, { stage: a.stage }, { stage: to, reason }, c);
      return { ...a, stage: to };
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, stage: out.stage });
  }));

  app.post('/api/applications/:id/evaluations', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'evaluation:write:assigned') && req.user.role !== 'super_admin') return res.status(403).json({ error: 'forbidden' });
    const id = uuid.parse(req.params.id);
    const d = z.object({
      round: z.number().int().min(1).max(5), competency_scores: z.record(z.number().min(0).max(5)).default({}), total_score: z.number().min(0).max(100).optional(),
      evidence: z.string().max(5000).optional(), comments: z.string().max(5000).optional(), recommendation: z.enum(['advance', 'hold', 'reject']).optional(), status: z.enum(['draft', 'submitted']).default('draft'),
    }).parse(req.body);
    const a = (await db.query(`SELECT a.id, c.assessor_id FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.id=$1`, [id])).rows[0];
    if (!a || (req.user.role !== 'super_admin' && a.assessor_id !== req.user.id)) return res.status(404).json({ error: 'not_found' });   // only the assigned assessor
    if (d.status === 'submitted' && (d.total_score == null || (d.evidence || '').trim().length < 10)) return res.status(400).json({ error: 'evidence_required', message: 'Add a total score and written evidence before submitting.' });
    const r = await db.query(
      `INSERT INTO evaluations(application_id, round, evaluator_id, competency_scores, total_score, evidence, comments, recommendation, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::eval_status, CASE WHEN $9::text='submitted' THEN now() END)
       ON CONFLICT (application_id, round, evaluator_id) DO UPDATE SET competency_scores=EXCLUDED.competency_scores, total_score=EXCLUDED.total_score, evidence=EXCLUDED.evidence, comments=EXCLUDED.comments, recommendation=EXCLUDED.recommendation, status=EXCLUDED.status, submitted_at=EXCLUDED.submitted_at
       RETURNING id, round, status, total_score, submitted_at`,
      [id, d.round, req.user.id, JSON.stringify(d.competency_scores), d.total_score ?? null, d.evidence ?? null, d.comments ?? null, d.recommendation ?? null, d.status]);
    await audit(req, 'evaluation.' + d.status, 'application', id, null, { round: d.round, total_score: d.total_score });
    res.status(201).json(r.rows[0]);
  }));

  async function activeConfig() {
    const r = (await db.query('SELECT weights, thresholds, overall_target FROM scoring_config WHERE is_active')).rows[0];
    return { weights: r.weights, thresholds: r.thresholds, target: Number(r.overall_target) };
  }

  app.get('/api/applications/:id/score', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const a = (await db.query(`SELECT a.id, c.assessor_id, c.user_id FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.id=$1`, [id])).rows[0];
    const ok = a && (['super_admin', 'hr_admin'].includes(req.user.role) || (req.user.role.endsWith('assessor') && a.assessor_id === req.user.id));
    if (!ok) return res.status(404).json({ error: 'not_found' });   // candidates do not read scores here; released results use a separate endpoint
    const ev = (await db.query(`SELECT round, avg(total_score)::float AS score FROM evaluations WHERE application_id=$1 AND status='submitted' GROUP BY round`, [id])).rows;
    const scores = {}; ev.forEach(e => { scores[e.round] = e.score; });
    // Question-bank tests: when no assessor score exists for a round, its final test percentage stands in (assessor scores always win).
    const bank = (await db.query(`SELECT a.round, max(t.final_pct)::float AS pct FROM attempts t JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id WHERE g.application_id=$1 AND a.source='bank' AND t.result_status='final' GROUP BY a.round`, [id])).rows;
    const sources = {}; bank.forEach(b => { if (scores[b.round] === undefined) { scores[b.round] = b.pct; sources[b.round] = 'question_bank'; } });
    const ov = (await db.query('SELECT decision, reason FROM score_overrides WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0] || null;
    res.json({ scores, sources, result: scoring.evaluate(scores, await activeConfig(), ov) });
  }));

  app.put('/api/scoring/config', requireAuth, perms.requireCap('config:write'), h(async (req, res) => {
    const cfg = z.object({ weights: z.record(z.number()), thresholds: z.record(z.number()), target: z.number() }).parse(req.body);
    const errors = scoring.validateConfig(cfg);
    if (errors.length) return res.status(400).json({ error: 'invalid_config', details: errors });
    await db.tx(async c => {
      await c.query('UPDATE scoring_config SET is_active=false WHERE is_active');
      await c.query('INSERT INTO scoring_config(weights, thresholds, overall_target, created_by) VALUES ($1,$2,$3,$4)', [JSON.stringify(cfg.weights), JSON.stringify(cfg.thresholds), cfg.target, req.user.id]);
      await audit(req, 'scoring.config', 'scoring_config', null, null, cfg, c);
    });
    res.json({ ok: true });
  }));

  app.post('/api/applications/:id/override', requireAuth, perms.requireCap('override:record'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const d = z.object({ decision: z.string().trim().min(2).max(100), reason: z.string().trim().min(5).max(1000) }).parse(req.body);
    await db.query('INSERT INTO score_overrides(application_id, decision, reason, decided_by) VALUES ($1,$2,$3,$4)', [id, d.decision, d.reason, req.user.id]);
    await audit(req, 'score.override', 'application', id, null, d);
    res.status(201).json({ ok: true });
  }));


  // =====================================================================================
  // Question import (all five rounds)
  // =====================================================================================
  // Step 1: check the file and return row-by-row problems. Nothing is saved.
  app.post('/api/questions/import/check', requireAuth, perms.requireCap('assessment:assign'), h(async (req, res) => {
    const { text, filename } = z.object({ text: z.string().max(1100000), filename: z.string().max(200).optional() }).parse(req.body);
    res.json(importer.impParse(text, filename));
  }));

  // Step 2: save the valid rows. Re-validates on the server, so a tampered client cannot add bad rows.
  app.post('/api/questions/import', requireAuth, perms.requireCap('assessment:assign'), h(async (req, res) => {
    const { text, filename, assessment_id } = z.object({ text: z.string().max(1100000), filename: z.string().max(200).optional(), assessment_id: z.string().uuid().optional() }).parse(req.body);
    const parsed = importer.impParse(text, filename);
    if (parsed.fatal) return res.status(400).json({ error: 'invalid_file', message: parsed.fatal });
    const valid = parsed.rows.filter(r => r.ok);
    if (!valid.length) return res.status(400).json({ error: 'nothing_to_import' });
    const KIND = { mc: 'mcq', ms: 'multi_select', sa: 'short_text', la: 'long_text', fu: 'file_upload' };
    const touched = await db.tx(async c => {
      const ids = new Map();   // round -> assessment id
      let target = null;
      if (assessment_id) { target = (await c.query('SELECT id, round FROM assessments WHERE id=$1', [assessment_id])).rows[0]; if (!target) return null; }
      let imported = 0;
      for (const r of valid) {
        if (target && r.q.round !== target.round) continue;       // an existing assessment only takes its own round
        let aid = target ? target.id : ids.get(r.q.round);
        if (!aid) {
          aid = (await c.query(`INSERT INTO assessments(title, type, round, status, created_by) VALUES ($1,'Imported question set',$2,'draft',$3) RETURNING id`, [`Imported questions, Round ${r.q.round}`, r.q.round, req.user.id])).rows[0].id;
          ids.set(r.q.round, aid);
        }
        const pos = (await c.query('SELECT coalesce(max(position),0)+1 AS p FROM questions WHERE assessment_id=$1', [aid])).rows[0].p;
        await c.query(`INSERT INTO questions(assessment_id, position, kind, prompt, options, correct_answer, marks, difficulty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [aid, pos, KIND[r.q.k], r.q.t, r.q.o.length ? JSON.stringify(r.q.o) : null, r.q.a.length ? JSON.stringify(r.q.k === 'mc' ? r.q.a[0] : r.q.a) : null, r.q.m, r.q.diff || null]);
        imported++;
      }
      const used = target ? [target.id] : [...ids.values()];
      await c.query('INSERT INTO question_imports(imported_by, file_name, rows_total, rows_imported, assessment_ids) VALUES ($1,$2,$3,$4,$5)', [req.user.id, filename || null, parsed.rows.length, imported, used]);
      await audit(req, 'questions.import', 'assessment', used.join(','), null, { file: filename, imported, skipped: parsed.rows.length - imported }, c);
      return { imported, assessment_ids: used, skipped: parsed.rows.length - imported };
    });
    if (!touched) return res.status(404).json({ error: 'not_found' });
    res.status(201).json(touched);
  }));

  // =====================================================================================
  // Secure test attempts: server-side timer, lock events, block and reinstate
  // =====================================================================================
  async function ownAttempt(req, id, client = db) {
    const r = (await client.query(
      `SELECT t.*, a.lock_mode, a.time_limit_minutes, a.source, c.user_id AS candidate_user FROM attempts t
         JOIN assignments g ON g.id=t.assignment_id JOIN assessments a ON a.id=g.assessment_id
         JOIN applications ap ON ap.id=g.application_id JOIN candidates c ON c.id=ap.candidate_id WHERE t.id=$1`, [id])).rows[0];
    return r && r.candidate_user === req.user.id ? r : null;
  }
  const shape = a => ({ ...a, deadline_at: a.deadline_at });

  // The browser reports that the candidate left the test window. The server decides what that means.
  app.post('/api/attempts/:id/events', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { kind, detail } = z.object({ kind: z.enum(['violation', 'note']), detail: z.string().max(300).optional() }).parse(req.body);
    const out = await db.tx(async c => {
      const a = await ownAttempt(req, id, c); if (!a) return null;
      await c.query('SELECT 1 FROM attempts WHERE id=$1 FOR UPDATE', [id]);
      const now = Date.now();
      if (kind === 'note') { await c.query('INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)', [id, 'note', detail || null]); return { action: 'logged', status: a.status }; }
      const r = proctor.pxViolation({ status: a.status, warnings: a.warnings }, a.lock_mode);
      if (r.action === 'ignore') return { action: 'ignore', status: a.status };
      await c.query('INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)', [id, r.action === 'block' ? 'blocked' : r.action === 'warn' ? 'warning' : 'violation', detail || null]);
      if (r.action === 'block') {
        const b = proctor.pxBlock({ status: a.status, deadline_at: a.deadline_at }, now);
        await c.query(`UPDATE attempts SET status='blocked', warnings=$2, remaining_ms=$3, blocked_at=now() WHERE id=$1`, [id, r.warnings, b.remaining_ms]);
        await audit(req, 'attempt.blocked', 'attempt', id, null, { detail }, c);
        return { action: 'block', status: 'blocked' };
      }
      await c.query('UPDATE attempts SET warnings=$2 WHERE id=$1', [id, r.warnings]);
      return { action: r.action, status: a.status, warnings: r.warnings };
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  }));

  // Saving answers is refused once the attempt is blocked, submitted or past its deadline.
  app.put('/api/attempts/:id/answers/:qid', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id), qid = uuid.parse(req.params.qid);
    const { response } = z.object({ response: z.any() }).parse(req.body);
    const a = await ownAttempt(req, id); if (!a) return res.status(404).json({ error: 'not_found' });
    if (a.source === 'bank') return res.status(409).json({ error: 'use_question_bank_endpoints' });   // bank tests save through /api/qb/my/attempts
    const w = proctor.pxCanWrite({ status: a.status, deadline_at: a.deadline_at }, Date.now());
    if (!w.ok) return res.status(409).json({ error: w.reason });
    await db.query(`INSERT INTO answers(attempt_id, question_id, response) VALUES ($1,$2,$3) ON CONFLICT (attempt_id, question_id) DO UPDATE SET response=EXCLUDED.response, saved_at=now()`, [id, qid, JSON.stringify(response)]);
    res.json({ ok: true });
  }));

  app.post('/api/attempts/:id/submit', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const out = await db.tx(async c => {
      const a = await ownAttempt(req, id, c); if (!a) return { code: 404 };
      if (a.source === 'bank') return { code: 409, reason: 'use_question_bank_endpoints' };
      const w = proctor.pxCanWrite({ status: a.status, deadline_at: a.deadline_at }, Date.now());
      if (!w.ok && w.reason !== 'time_expired') return { code: 409, reason: w.reason };
      // Objective questions are marked on the server from the stored answer key.
      const rows = (await c.query(`SELECT q.kind, q.marks, q.correct_answer, an.response FROM answers an JOIN questions q ON q.id=an.question_id WHERE an.attempt_id=$1`, [id])).rows;
      let total = 0;
      for (const r of rows) { const m = scoring.markObjective({ kind: r.kind === 'mcq' ? 'mcq' : r.kind, marks: r.marks, correct_answer: r.correct_answer }, r.response); if (m != null) total += m; }
      await c.query(`UPDATE attempts SET status='submitted', submitted_at=now(), auto_score=$2 WHERE id=$1`, [id, total]);
      await c.query('INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)', [id, w.ok ? 'submitted' : 'auto_submitted', null]);
      await audit(req, 'attempt.submit', 'attempt', id, null, { auto_score: total }, c);
      return { code: 200 };
    });
    if (out.code === 404) return res.status(404).json({ error: 'not_found' });
    if (out.code === 409) return res.status(409).json({ error: out.reason });
    res.json({ ok: true });
  }));

  // The blocked candidate can ask HR to look at the attempt.
  app.post('/api/attempts/:id/request-review', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const a = await ownAttempt(req, id); if (!a || a.status !== 'blocked') return res.status(404).json({ error: 'not_found' });
    await db.query('UPDATE attempts SET review_requested_at=now() WHERE id=$1', [id]);
    await audit(req, 'attempt.review_requested', 'attempt', id);
    res.json({ ok: true });
  }));

  // Only HR or the Super Admin can reinstate, and always with a written reason.
  app.post('/api/attempts/:id/reinstate', requireAuth, perms.requireCap('stage:change'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const out = await db.tx(async c => {
      const a = (await c.query('SELECT * FROM attempts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!a || a.status !== 'blocked') return null;
      const r = proctor.pxReinstate({ status: a.status, reinstated_count: a.reinstated_count }, Date.now(), reason);
      await c.query(`UPDATE attempts SET status='ready', warnings=0, reinstated_count=$2, reinstated_by=$3, reinstate_reason=$4 WHERE id=$1`, [id, r.reinstated_count, req.user.id, reason]);
      await c.query('INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)', [id, 'reinstated', reason]);
      await audit(req, 'attempt.reinstate', 'attempt', id, { status: 'blocked' }, { status: 'ready', reason }, c);
      return true;
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  }));

  // The candidate presses Start or Resume. The server sets the deadline from the time left.
  app.post('/api/attempts/:id/resume', requireAuth, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const a = await ownAttempt(req, id); if (!a) return res.status(404).json({ error: 'not_found' });
    if (a.source === 'bank') return res.status(409).json({ error: 'use_question_bank_endpoints' });   // bank tests restart through /api/qb/my/attempts/:id/start
    if (a.status !== 'ready') return res.status(409).json({ error: 'cannot_resume' });
    const left = a.remaining_ms == null ? (a.time_limit_minutes || 0) * 60000 : Number(a.remaining_ms);
    const r = proctor.pxResume({ status: 'ready', remaining_ms: left }, Date.now());
    await db.query(`UPDATE attempts SET status='in_progress', deadline_at=$2 WHERE id=$1`, [id, new Date(r.deadline_at)]);
    await db.query('INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ($1,$2,$3)', [id, 'start', 'Resumed after reinstatement']);
    res.json({ ok: true, deadline_at: new Date(r.deadline_at).toISOString() });
  }));

  // ---- question bank module (bank, imports, randomised tests, results)
  qb.mount(app, { db, requireAuth, perms, audit, raw: express.raw({ type: () => true, limit: '6mb' }) });

  // ---- camera proctoring (no media stored, only alert codes)
  mountCamera(app, { db, requireAuth, audit, realtime: app.locals.realtime });

  // ---- reports and analytics
  mountReports(app, { db, requireAuth, perms });

  // ---- errors
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'validation_failed', fields: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err && err.code === '23505') return res.status(409).json({ error: 'already_exists' });
    if (err && err.code === '23P01') return res.status(409).json({ error: 'schedule_conflict' });
    if (err && err.code === '23514') return res.status(400).json({ error: 'constraint_failed' });
    if (err && (err.status === 413 || err.type === 'entity.too.large')) return res.status(413).json({ error: 'payload_too_large' });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'invalid_file', message: 'File is too large.' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });   // never leak internals
  });

  return app;
}

function pick(o, keys) { const out = {}; keys.forEach(k => { if (k in o) out[k] = k === 'internal_notes' ? '[restricted]' : o[k]; }); return out; }

module.exports = { createApp };
