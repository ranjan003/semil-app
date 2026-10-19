'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('node:crypto');
const { z } = require('zod');

const { db, FieldValue, nextCandidateCode, audit, docData, queryData, now, backend, runWithToken, getUserProfile, ensureUserProfile, isAdminEmail, adminEmails, sortBy, toIso } = require('./firestore-db');
const perms = require('./permissions');
const scoring = require('./scoring');
const { authMiddleware, requireAuth } = require('./auth-middleware');
const { FirebaseStorage, validateUpload } = require('./firebase-storage');
const proctor = require('./proctoring');
const firebaseConfig = require('./firebase');
const { mountQB } = require('./qb-firestore');

const STAGES = ['applied', 'round_1', 'round_2', 'round_3', 'round_4', 'round_5', 'selected', 'offer_sent', 'offer_accepted', 'joined', 'rejected', 'on_hold'];

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  const fileStorage = new FirebaseStorage();

  const path = require('node:path');
  const fs = require('node:fs');
  const publicDir = path.resolve(__dirname, '../../public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ── CSRF ──
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'semil') return res.status(403).json({ error: 'csrf_check_failed' });
    next();
  });

  // ── Firebase Auth middleware ──
  app.use('/api', authMiddleware);
  // Carry the verified user's ID token through the request so the legacy RTDB adapter
  // can authenticate against security rules instead of requiring a public database.
  app.use('/api', (req, res, next) => runWithToken(req.authToken, next));

  // Public Firebase web configuration (safe to expose; contains no private key).
  app.get('/config.js', (req, res) => {
    const cfg = {
      apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyCdRMtDEgohaX74lylHfH0PrqDewTfR3Xw',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'semil-a9cf1.firebaseapp.com',
      databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: process.env.FIREBASE_PROJECT_ID || 'semil-a9cf1',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'semil-a9cf1.firebasestorage.app',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '124354464493',
      appId: process.env.FIREBASE_APP_ID || '1:124354464493:web:06fc3d812bc641513c9ae4',
      measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-TZYB5VGRVH',
    };
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').send(`/* generated from server environment */\nwindow.FIREBASE_CONFIG = ${JSON.stringify(cfg)};\n`);
  });

  // ── In-memory rate limiter (Cloud Functions are stateless, so this resets per instance) ──
  const _memLimiter = { _m: new Map(), limited(k) { const n = Date.now(); const a = (this._m.get(k)||[]).filter(t=>n-t<15*60*1000); this._m.set(k,a); return a.length>=10; }, note(k) { this._m.set(k,[...(this._m.get(k)||[]),Date.now()]); } };
  async function limited(key) { return _memLimiter.limited(key); }
  async function noteAttempt(key) { _memLimiter.note(key); }

  app.get('/healthz', (req, res) => res.json({ ok: true, dataBackend: backend }));

  app.get('/api/health/firebase', (req, res) => {
    res.json({
      ok: true,
      projectId: firebaseConfig.projectId,
      dataBackend: backend,
      firestoreConfigured: firebaseConfig.hasFirestore,
      serviceAccountConfigured: firebaseConfig.hasAdminCredentials,
      authApiKeyConfigured: !!(process.env.FIREBASE_API_KEY || process.env.GOOGLE_API_KEY),
      adminEmailOverrides: adminEmails().length,
      storageBucket: firebaseConfig.storageBucket,
      timestamp: new Date().toISOString(),
    });
  });

  // =====================================================================================
  // Auth — Sign in, sign up profile, session verification and role management
  // =====================================================================================
  app.post('/api/auth/login', h(async (req, res) => {
    const { email, password } = z.object({
      email: z.string().trim().email().max(200),
      password: z.string().min(1).max(128),
    }).parse(req.body);

    const normEmail = email.toLowerCase().trim();
    const limitKey = `login:${normEmail}:${req.ip || 'unknown'}`;
    if (await limited(limitKey)) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes and try again.' });
    }

    const apiKey = process.env.FIREBASE_API_KEY || process.env.GOOGLE_API_KEY || 'AIzaSyCdRMtDEgohaX74lylHfH0PrqDewTfR3Xw';
    if (!apiKey) {
      return res.status(503).json({ error: 'firebase_not_configured', message: 'Firebase Authentication is not configured on the server.' });
    }

    let data = null;
    try {
      const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normEmail, password, returnSecureToken: true }),
      });
      data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.idToken) {
        await noteAttempt(limitKey);
        const code = data && data.error && data.error.message;
        const friendly = code === 'EMAIL_NOT_FOUND' || code === 'INVALID_PASSWORD' || code === 'INVALID_LOGIN_CREDENTIALS'
          ? 'E-mail or password is not correct.'
          : code === 'USER_DISABLED' ? 'This account has been disabled. Contact an administrator.'
            : code === 'TOO_MANY_ATTEMPTS_TRY_LATER' ? 'Too many attempts. Wait a few minutes and try again.'
              : 'Sign-in failed. Check your details and try again.';
        return res.status(401).json({ error: 'invalid_credentials', message: friendly });
      }
    } catch (err) {
      console.warn('[auth/login] Firebase request failed:', err.message);
      return res.status(503).json({ error: 'auth_unavailable', message: 'Cannot reach Firebase Authentication. Try again shortly.' });
    }

    const user = await runWithToken(data.idToken, async () => {
      let profile = await getUserProfile(data.localId);
      if (!profile) {
        profile = await ensureUserProfile({ uid: data.localId, email: data.email || normEmail, fullName: data.displayName || '', role: 'candidate' });
      }
      if (profile && profile.isActive === false) return null;
      const role = isAdminEmail(data.email || normEmail) ? 'super_admin' : (profile.role || 'candidate');
      return {
        id: data.localId,
        uid: data.localId,
        email: data.email || normEmail,
        full_name: profile.full_name || profile.fullName || data.displayName || data.email || normEmail,
        role,
      };
    });

    if (!user) return res.status(403).json({ error: 'account_disabled', message: 'This account has been disabled. Contact an administrator.' });

    res.cookie('__session', data.idToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 55 * 60 * 1000,
    });

    return res.json({ ok: true, user });
  }));

  // Called by the browser right after createUserWithEmailAndPassword / Google sign-in.
  // Idempotent: the document id is the Firebase UID, so repeated calls never duplicate a profile.
  app.post('/api/auth/register', requireAuth, h(async (req, res) => {
    const d = z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
    }).parse(req.body || {});

    let profile = await getUserProfile(req.user.id);
    if (profile) {
      // Only fill in a missing display name; never overwrite an existing profile or role.
      if (d.fullName && (!profile.fullName || profile.fullName === profile.email || profile.fullName === 'User')) {
        await db.collection('users').doc(req.user.id).update({ fullName: d.fullName, updatedAt: FieldValue.serverTimestamp() });
        profile = await getUserProfile(req.user.id);
      }
      return res.json({ ok: true, created: false, user: { ...profile, id: req.user.id, full_name: profile.full_name || profile.fullName, role: isAdminEmail(req.user.email) ? 'super_admin' : profile.role } });
    }

    profile = await ensureUserProfile({
      uid: req.user.id,
      email: req.user.email,
      fullName: d.fullName || req.user.full_name,
      role: isAdminEmail(req.user.email) ? 'super_admin' : 'candidate',
    });
    await audit(req, 'user.register', 'user', req.user.id, null, { email: req.user.email, role: profile.role });
    res.status(201).json({ ok: true, created: true, user: { ...profile, id: req.user.id, full_name: profile.full_name || profile.fullName, role: isAdminEmail(req.user.email) ? 'super_admin' : profile.role } });
  }));

  app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('__session', { path: '/' });
    res.json({ ok: true });
  });

  // Register a new user with role (admin-only)
  // Firebase Admin user creation requires a service account. Use the Firebase Console when
  // no service account is configured; the public sign-up flow above still works.
  app.post('/api/users', requireAuth, perms.requireCap('user:manage'), h(async (req, res) => {
    const d = z.object({
      email: z.string().email().max(200),
      password: z.string().min(10).max(128).optional(),
      fullName: z.string().trim().min(2).max(120),
      role: z.enum(['hr_admin', 'technical_assessor', 'business_assessor', 'candidate']),
    }).parse(req.body);

    if (!firebaseConfig.hasFirestore) {
      return res.status(503).json({
        error: 'admin_sdk_not_configured',
        message: 'Creating users from the app needs a Firebase service account. Add FIREBASE_SERVICE_ACCOUNT in Vercel, or create the user in the Firebase Console.',
      });
    }

    const userRecord = await firebaseConfig.auth.createUser({
      email: d.email,
      password: d.password,
      displayName: d.fullName,
    });

    await firebaseConfig.auth.setCustomUserClaims(userRecord.uid, { role: d.role });

    await db.collection('users').doc(userRecord.uid).set({
      email: d.email,
      fullName: d.fullName,
      role: d.role,
      isActive: true,
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });

    await audit(req, 'user.create', 'user', userRecord.uid, null, { email: d.email, role: d.role });
    res.status(201).json({ id: userRecord.uid, email: d.email, fullName: d.fullName, role: d.role });
  }));

  // =====================================================================================
  // Candidates
  // =====================================================================================
  const phone = z.string().transform(s => s.replace(/[\s-]/g, '')).refine(s => /^\+?[0-9]{10,13}$/.test(s), 'Enter a valid mobile number');
  const url = z.string().url().refine(u => /^https?:\/\//i.test(u), 'Use an http(s) link');
  const candidateBase = z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    phone,
    city: z.string().trim().max(80).optional(),
    collegeName: z.string().trim().max(200).optional(),
    degree: z.string().trim().max(120).optional(),
    branch: z.string().trim().max(120).optional(),
    graduationYear: z.number().int().min(2015).max(2035).optional(),
    academicInfo: z.string().max(500).optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    experience: z.string().max(2000).optional(),
    portfolioUrl: url.optional().or(z.literal('').transform(() => undefined)),
    certifications: z.string().max(2000).optional(),
    joiningAvailability: z.string().max(100).optional(),
    expectedCompensation: z.string().max(100).optional(),
    source: z.string().max(60).optional(),
    hrOwnerId: z.string().optional(),
    assessorId: z.string().optional(),
    internalNotes: z.string().max(4000).optional(),
    vacancyId: z.string().optional(),
    campaignId: z.string().optional(),
  });

  // Get or create college document
  async function collegeId(name) {
    if (!name) return null;
    const snap = await db.collection('colleges').where('name', '==', name).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
    const ref = await db.collection('colleges').add({ name, city: null });
    return ref.id;
  }

  app.post('/api/candidates', requireAuth, perms.requireCap('candidate:write'), h(async (req, res) => {
    const d = candidateBase.parse(req.body);
    if (d.internalNotes !== undefined && !perms.can(req.user, 'candidate:notes')) return res.status(403).json({ error: 'forbidden' });

    const code = await nextCandidateCode();
    const colId = await collegeId(d.collegeName);

    const candidateData = {
      candidateCode: code,
      userId: null,
      fullName: d.fullName,
      email: d.email,
      phone: d.phone,
      city: d.city || null,
      collegeId: colId,
      collegeName: d.collegeName || null,
      degree: d.degree || null,
      branch: d.branch || null,
      graduationYear: d.graduationYear || null,
      academicInfo: d.academicInfo || null,
      skills: d.skills || [],
      experience: d.experience || null,
      portfolioUrl: d.portfolioUrl || null,
      certifications: d.certifications || null,
      joiningAvailability: d.joiningAvailability || null,
      expectedCompensation: d.expectedCompensation || null,
      source: d.source || null,
      hrOwnerId: d.hrOwnerId || null,
      assessorId: d.assessorId || null,
      internalNotes: d.internalNotes || null,
      deletedAt: null,
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('candidates').add(candidateData);
    const cand = { id: ref.id, ...candidateData };

    if (d.vacancyId) {
      await db.collection('candidates').doc(ref.id).collection('applications').add({
        vacancyId: d.vacancyId,
        campaignId: d.campaignId || null,
        stage: 'applied',
        stageEnteredAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
      // Increment applicant count on vacancy
      await db.collection('vacancies').doc(d.vacancyId).update({
        applicantCount: FieldValue.increment(1),
      });
    }

    await audit(req, 'candidate.create', 'candidate', ref.id, null, { candidateCode: code, email: d.email });
    res.status(201).json(perms.candidateView(req.user, cand));
  }));

  // Attach the candidate's current application so the Tests page can assign by
  // application id and know which role/stage the candidate belongs to.
  async function attachApplications(items, vacancyMap) {
    return Promise.all(items.map(async c => {
      let apps = [];
      try {
        apps = queryData(await db.collection('candidates').doc(c.id).collection('applications').get());
      } catch { /* no applications yet */ }
      const active = apps
        .filter(a => a && a.stage !== 'rejected')
        .sort((a, b) => String(b.createdAt || b.stageEnteredAt || '').localeCompare(String(a.createdAt || a.stageEnteredAt || '')))[0]
        || apps[0] || null;
      const vacancy = active && active.vacancyId ? vacancyMap[active.vacancyId] : null;
      return {
        ...c,
        application_id: active ? active.id : null,
        applicationId: active ? active.id : null,
        stage: (active && active.stage) || c.stage || 'applied',
        vacancyId: (active && active.vacancyId) || c.vacancyId || null,
        role_code: c.roleCode || (vacancy && vacancy.roleCode) || c.role_code || null,
        vacancy_title: vacancy ? vacancy.title : null,
      };
    }));
  }

  app.get('/api/candidates', requireAuth, h(async (req, res) => {
    const staffAll = perms.can(req.user, 'candidate:read');
    if (!staffAll && !perms.can(req.user, 'candidate:read:assigned')) return res.status(403).json({ error: 'forbidden' });

    const q = z.object({
      q: z.string().max(100).optional(),
      stage: z.enum(STAGES).optional(),
      source: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      per: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);

    // Fetch first, filter in memory. This keeps working when older Firestore documents
    // do not have deletedAt/createdAt fields (an orderBy would silently drop them).
    let query = db.collection('candidates');
    if (!staffAll) query = query.where('assessorId', '==', req.user.id);
    const snap = await query.get();
    let items = queryData(snap).filter(c => !c.deletedAt);

    const vacSnap = await db.collection('vacancies').get().catch(() => ({ docs: [] }));
    const vacancyMap = Object.fromEntries(queryData(vacSnap).map(v => [v.id, v]));
    items = await attachApplications(items, vacancyMap);

    if (q.q) {
      const search = q.q.toLowerCase();
      items = items.filter(c => String(c.fullName || '').toLowerCase().includes(search)
        || String(c.candidateCode || c.candidate_code || '').toLowerCase().includes(search)
        || String(c.email || '').toLowerCase().includes(search));
    }
    if (q.stage) items = items.filter(c => c.stage === q.stage);
    if (q.source) items = items.filter(c => c.source === q.source);

    items = sortBy(items, 'createdAt', 'desc');
    const total = items.length;
    const start = (q.page - 1) * q.per;
    const view = items.slice(start, start + q.per).map(c => perms.candidateView(req.user, c)).filter(Boolean);
    res.json({ items: view, page: q.page, per: q.per, total });
  }));

  app.get('/api/candidates/:id', requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('candidates').doc(id).get();
    const c = docData(snap);
    if (!c || c.deletedAt) return res.status(404).json({ error: 'not_found' });
    const view = perms.candidateView(req.user, c);
    if (!view) return res.status(404).json({ error: 'not_found' });

    const appsSnap = await db.collection('candidates').doc(id).collection('applications').get();
    const apps = queryData(appsSnap);

    const docsSnap = await db.collection('candidates').doc(id).collection('documents').get();
    const docs = sortBy(queryData(docsSnap), 'createdAt', 'desc');

    res.json({ ...view, applications: apps, documents: docs });
  }));

  app.patch('/api/candidates/:id', requireAuth, perms.requireCap('candidate:write'), h(async (req, res) => {
    const id = req.params.id;
    const d = candidateBase.partial().parse(req.body);
    if (d.internalNotes !== undefined && !perms.can(req.user, 'candidate:notes')) return res.status(403).json({ error: 'forbidden' });

    const snap = await db.collection('candidates').doc(id).get();
    if (!snap.exists || snap.data().deletedAt) return res.status(404).json({ error: 'not_found' });

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) updates[k] = v;
    }
    if (d.collegeName) updates.collegeId = await collegeId(d.collegeName);

    await db.collection('candidates').doc(id).update(updates);
    const afterSnap = await db.collection('candidates').doc(id).get();
    const after = docData(afterSnap);
    await audit(req, 'candidate.update', 'candidate', id, null, updates);
    res.json(perms.candidateView(req.user, after));
  }));

  app.delete('/api/candidates/:id', requireAuth, perms.requireCap('candidate:delete'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('candidates').doc(id).get();
    if (!snap.exists || snap.data().deletedAt) return res.status(404).json({ error: 'not_found' });
    await db.collection('candidates').doc(id).update({ deletedAt: FieldValue.serverTimestamp() });
    await audit(req, 'candidate.delete', 'candidate', id);
    res.json({ ok: true });
  }));

  // =====================================================================================
  // Documents (private storage, Firebase signed links)
  // =====================================================================================
  async function canUseDocs(user, candidateId, write) {
    const snap = await db.collection('candidates').doc(candidateId).get();
    const c = docData(snap);
    if (!c || c.deletedAt) return null;
    if (user.role === 'super_admin' || user.role === 'hr_admin') return c;
    if (user.role === 'candidate') return c.userId === user.id ? c : null;
    if (!write && perms.can(user, 'document:read:assigned') && c.assessorId === user.id) return c;
    return null;
  }

  app.post('/api/candidates/:id/documents', requireAuth, upload.single('file'), h(async (req, res) => {
    const id = req.params.id;
    const kind = z.enum(['resume', 'photo', 'submission', 'presentation']).parse(req.query.kind);
    const c = await canUseDocs(req.user, id, true);
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const check = validateUpload(kind, req.file.originalname, req.file.buffer);
    if (!check.ok) return res.status(400).json({ error: 'invalid_file', message: check.error });
    const stored = await fileStorage.put({ kind, ownerId: id, ext: check.ext }, req.file.buffer);
    const docRef = await db.collection('candidates').doc(id).collection('documents').add({
      kind,
      storageKey: stored.key,
      originalName: req.file.originalname.slice(0, 200),
      mimeType: check.mime,
      sizeBytes: stored.size,
      sha256: stored.sha256,
      uploadedBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    });
    await audit(req, 'document.upload', 'candidate', id, null, { kind, name: req.file.originalname });
    res.status(201).json({ id: docRef.id, kind, originalName: req.file.originalname, sizeBytes: stored.size });
  }));

  app.get('/api/documents/:candidateId/:docId/link', requireAuth, h(async (req, res) => {
    const { candidateId, docId } = req.params;
    const c = await canUseDocs(req.user, candidateId, false);
    if (!c) return res.status(404).json({ error: 'not_found' });
    const docSnap = await db.collection('candidates').doc(candidateId).collection('documents').doc(docId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'not_found' });
    const d = docSnap.data();
    const url = await fileStorage.getSignedUrl(d.storageKey, 600);
    await audit(req, 'document.link', 'document', docId);
    res.json({ url, expires_in: 600 });
  }));

  // =====================================================================================
  // Vacancies
  // =====================================================================================
  const vacancyBase = z.object({
    title: z.string().trim().min(3).max(150),
    roleCode: z.string().max(20).optional(),
    track: z.enum(['technical', 'business']).default('technical'),
    department: z.string().max(100).optional(),
    description: z.string().max(5000).optional(),
    requiredSkills: z.array(z.string().max(40)).max(30).default([]),
    minQualifications: z.string().max(1000).optional(),
    openings: z.number().int().min(1).max(500).default(1),
    salaryMinLpa: z.number().min(0).max(1000).optional(),
    salaryMaxLpa: z.number().min(0).max(1000).optional(),
    location: z.string().max(120).default('Bengaluru, India'),
    employmentType: z.enum(['full_time', 'internship', 'contract']).default('full_time'),
    joiningTimeline: z.string().max(100).optional(),
    applicationDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assessmentTemplate: z.string().max(100).optional(),
    selectionCriteria: z.string().max(3000).optional(),
    hiringManagerId: z.string().optional(),
  });

  app.get('/api/vacancies', requireAuth, h(async (req, res) => {
    const snap = await db.collection('vacancies').get();
    let items = sortBy(queryData(snap), 'createdAt', 'desc');

    if (req.user.role === 'candidate') {
      items = items.filter(v => v.status === 'active').map(v => ({
        id: v.id, title: v.title, department: v.department, description: v.description,
        requiredSkills: v.requiredSkills, minQualifications: v.minQualifications,
        location: v.location, employmentType: v.employmentType, applicationDeadline: v.applicationDeadline,
      }));
    }
    res.json(items);
  }));

  app.post('/api/vacancies', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const d = vacancyBase.parse(req.body);
    const data = {
      ...d,
      status: 'draft',
      applicantCount: 0,
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Fill nulls for optional fields
    for (const k of Object.keys(data)) {
      if (data[k] === undefined) data[k] = null;
    }
    const ref = await db.collection('vacancies').add(data);
    await audit(req, 'vacancy.create', 'vacancy', ref.id, null, { title: d.title });
    res.status(201).json({ id: ref.id, ...data });
  }));

  app.patch('/api/vacancies/:id', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = req.params.id;
    const d = vacancyBase.partial().parse(req.body);
    const updates = { updatedAt: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) updates[k] = v;
    }
    const snap = await db.collection('vacancies').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    await db.collection('vacancies').doc(id).update(updates);
    const afterSnap = await db.collection('vacancies').doc(id).get();
    await audit(req, 'vacancy.update', 'vacancy', id, null, d);
    res.json(docData(afterSnap));
  }));

  app.post('/api/vacancies/:id/status', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = req.params.id;
    const { status } = z.object({ status: z.enum(['draft', 'active', 'closed']) }).parse(req.body);
    const snap = await db.collection('vacancies').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const v = snap.data();
    if (status === 'active' && (!v.description || !v.applicationDeadline)) {
      return res.status(400).json({ error: 'incomplete_vacancy', message: 'Add a role description and an application deadline before publishing.' });
    }
    await db.collection('vacancies').doc(id).update({ status });
    await audit(req, 'vacancy.status', 'vacancy', id, { status: v.status }, { status });
    res.json({ ok: true, status });
  }));

  app.post('/api/vacancies/:id/duplicate', requireAuth, perms.requireCap('vacancy:write'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('vacancies').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const original = snap.data();
    const copy = {
      ...original,
      title: original.title + ' (copy)',
      status: 'draft',
      applicantCount: 0,
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('vacancies').add(copy);
    await audit(req, 'vacancy.duplicate', 'vacancy', id, null, { newId: ref.id });
    res.status(201).json({ id: ref.id, ...copy });
  }));

  // =====================================================================================
  // Stage changes, evaluations, scoring
  // =====================================================================================
  app.post('/api/applications/:candidateId/:appId/stage', requireAuth, perms.requireCap('stage:change'), h(async (req, res) => {
    const { candidateId, appId } = req.params;
    const { to, reason } = z.object({ to: z.enum(STAGES), reason: z.string().trim().min(5).max(500) }).parse(req.body);

    const appRef = db.collection('candidates').doc(candidateId).collection('applications').doc(appId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) return res.status(404).json({ error: 'not_found' });
    const a = appSnap.data();
    if (a.stage === to) return res.json({ ok: true, stage: to });

    await appRef.update({ stage: to, stageEnteredAt: FieldValue.serverTimestamp() });
    await appRef.collection('stageChanges').add({
      fromStage: a.stage,
      toStage: to,
      manual: true,
      reason,
      changedBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    });
    await audit(req, 'application.stage', 'application', appId, { stage: a.stage }, { stage: to, reason });
    res.json({ ok: true, stage: to });
  }));

  app.post('/api/applications/:candidateId/:appId/evaluations', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'evaluation:write:assigned') && req.user.role !== 'super_admin') return res.status(403).json({ error: 'forbidden' });
    const { candidateId, appId } = req.params;
    const d = z.object({
      round: z.number().int().min(1).max(5),
      competencyScores: z.record(z.number().min(0).max(5)).default({}),
      totalScore: z.number().min(0).max(100).optional(),
      evidence: z.string().max(5000).optional(),
      comments: z.string().max(5000).optional(),
      recommendation: z.enum(['advance', 'hold', 'reject']).optional(),
      status: z.enum(['draft', 'submitted']).default('draft'),
    }).parse(req.body);

    if (d.status === 'submitted' && (d.totalScore == null || (d.evidence || '').trim().length < 10)) {
      return res.status(400).json({ error: 'evidence_required', message: 'Add a total score and written evidence before submitting.' });
    }

    const evalData = {
      applicationId: appId,
      round: d.round,
      evaluatorId: req.user.id,
      competencyScores: d.competencyScores,
      totalScore: d.totalScore ?? null,
      evidence: d.evidence ?? null,
      comments: d.comments ?? null,
      recommendation: d.recommendation ?? null,
      status: d.status,
      submittedAt: d.status === 'submitted' ? FieldValue.serverTimestamp() : null,
    };

    // Check for an existing evaluation (upsert pattern). Fetching the small
    // sub-collection and filtering in memory avoids a Firestore composite index.
    const evalCol = db.collection('candidates').doc(candidateId).collection('applications').doc(appId).collection('evaluations');
    const existing = queryData(await evalCol.get()).find(e => Number(e.round) === d.round && e.evaluatorId === req.user.id);

    let evalId;
    if (existing) {
      evalId = existing.id;
      await evalCol.doc(evalId).update(evalData);
    } else {
      const ref = await evalCol.add(evalData);
      evalId = ref.id;
    }

    await audit(req, 'evaluation.' + d.status, 'application', appId, null, { round: d.round, totalScore: d.totalScore });
    res.status(201).json({ id: evalId, round: d.round, status: d.status, totalScore: d.totalScore });
  }));

  // ── Scoring config ──
  app.put('/api/scoring/config', requireAuth, perms.requireCap('config:write'), h(async (req, res) => {
    const cfg = z.object({ weights: z.record(z.number()), thresholds: z.record(z.number()), target: z.number() }).parse(req.body);
    const errors = scoring.validateConfig(cfg);
    if (errors.length) return res.status(400).json({ error: 'invalid_config', details: errors });

    // Deactivate all existing configs
    const activeSnap = await db.collection('scoringConfig').where('isActive', '==', true).get();
    const batch = db.batch();
    activeSnap.docs.forEach(doc => batch.update(doc.ref, { isActive: false }));

    // Add new config
    const newRef = db.collection('scoringConfig').doc();
    batch.set(newRef, {
      weights: cfg.weights,
      thresholds: cfg.thresholds,
      overallTarget: cfg.target,
      isActive: true,
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();
    await audit(req, 'scoring.config', 'scoringConfig', null, null, cfg);
    res.json({ ok: true });
  }));

  // =====================================================================================
  // Assessments
  // =====================================================================================
  app.get('/api/assessments', requireAuth, perms.requireCap('assessment:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').get();
    res.json(sortBy(queryData(snap), 'createdAt', 'desc'));
  }));

  app.post('/api/assessments', requireAuth, perms.requireCap('assessment:assign'), h(async (req, res) => {
    const d = z.object({
      title: z.string().trim().min(3).max(200),
      type: z.string().max(100),
      round: z.number().int().min(1).max(5),
      description: z.string().max(5000).optional(),
      instructions: z.string().max(5000).optional(),
      timeLimitMinutes: z.number().int().min(1).max(480).optional(),
      passMarkPct: z.number().min(0).max(100).default(50),
      lockMode: z.enum(['strict', 'warn', 'off']).default('strict'),
      source: z.enum(['manual', 'bank']).default('manual'),
    }).parse(req.body);

    const data = {
      ...d,
      status: 'draft',
      currentVersion: 1,
      maxAttempts: 1,
      evaluationMode: 'mixed',
      rubric: [],
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    };
    for (const k of Object.keys(data)) { if (data[k] === undefined) data[k] = null; }

    const ref = await db.collection('assessments').add(data);
    await audit(req, 'assessment.create', 'assessment', ref.id, null, { title: d.title });
    res.status(201).json({ id: ref.id, ...data });
  }));

  // =====================================================================================
  // Interviews
  // =====================================================================================
  app.get('/api/interviews', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'interview:write') && !perms.can(req.user, 'interview:read:own')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    let items = sortBy(queryData(await db.collection('interviews').get()), 'startsAt', 'asc');
    if (perms.can(req.user, 'interview:read:own') && !perms.can(req.user, 'interview:write')) {
      items = items.filter(i => i.interviewerId === req.user.id);
    }
    res.json(items);
  }));

  app.post('/api/interviews', requireAuth, perms.requireCap('interview:write'), h(async (req, res) => {
    const d = z.object({
      applicationId: z.string(),
      candidateId: z.string(),
      round: z.number().int().min(1).max(5),
      interviewerId: z.string(),
      startsAt: z.string(),
      durationMinutes: z.number().int().min(5).max(480),
      location: z.string().max(200).optional(),
      instructions: z.string().max(2000).optional(),
    }).parse(req.body);

    const data = {
      ...d,
      startsAt: new Date(d.startsAt),
      endsAt: new Date(new Date(d.startsAt).getTime() + d.durationMinutes * 60000),
      status: 'scheduled',
      reminderSentAt: null,
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('interviews').add(data);
    await audit(req, 'interview.create', 'interview', ref.id, null, { round: d.round });
    res.status(201).json({ id: ref.id, ...data });
  }));

  // =====================================================================================
  // Offers
  // =====================================================================================
  app.post('/api/offers', requireAuth, perms.requireCap('offer:send'), h(async (req, res) => {
    const d = z.object({
      applicationId: z.string(),
      candidateId: z.string(),
      joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body);

    const ref = await db.collection('offers').add({
      ...d,
      status: 'draft',
      sentAt: null,
      respondedAt: null,
      approvedBy: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    await audit(req, 'offer.create', 'offer', ref.id);
    res.status(201).json({ id: ref.id, ...d, status: 'draft' });
  }));

  // =====================================================================================
  // Reports / Dashboard KPIs
  // =====================================================================================
  app.get('/api/reports/dashboard', requireAuth, perms.requireCap('report:read'), h(async (req, res) => {
    const [candidatesSnap, vacanciesSnap] = await Promise.all([
      db.collection('candidates').get(),
      db.collection('vacancies').get(),
    ]);
    const candidates = queryData(candidatesSnap).filter(c => !c.deletedAt);
    const vacancies = queryData(vacanciesSnap);

    const totalCandidates = candidates.length;
    const totalVacancies = vacancies.length;
    const activeVacancies = vacancies.filter(v => v.status === 'active').length;

    // Count by source
    const sourceMap = {};
    candidates.forEach(c => {
      const s = c.source || 'Unknown';
      sourceMap[s] = (sourceMap[s] || 0) + 1;
    });

    res.json({
      totalCandidates,
      totalVacancies,
      activeVacancies,
      bySource: sourceMap,
    });
  }));

  // =====================================================================================
  // Colleges (lookup)
  // =====================================================================================
  app.get('/api/colleges', requireAuth, h(async (req, res) => {
    const snap = await db.collection('colleges').get();
    res.json(sortBy(queryData(snap), 'name', 'asc'));
  }));

  // =====================================================================================
  // Campaigns
  // =====================================================================================
  app.get('/api/campaigns', requireAuth, h(async (req, res) => {
    const snap = await db.collection('campaigns').get();
    res.json(sortBy(queryData(snap), 'createdAt', 'desc'));
  }));

  app.post('/api/campaigns', requireAuth, perms.requireCap('campaign:write'), h(async (req, res) => {
    const d = z.object({
      name: z.string().trim().min(2).max(150),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      hiringTarget: z.number().int().min(0).optional(),
    }).parse(req.body);

    const ref = await db.collection('campaigns').add({
      ...d,
      status: 'active',
      createdBy: req.user.id,
      createdAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ id: ref.id, ...d, status: 'active' });
  }));

  // =====================================================================================
  // Notifications
  // =====================================================================================
  app.get('/api/notifications', requireAuth, h(async (req, res) => {
    const snap = await db.collection('notifications').get();
    const items = sortBy(queryData(snap).filter(n => n.userId === req.user.id), 'createdAt', 'desc').slice(0, 50);
    res.json(items);
  }));

  app.patch('/api/notifications/:id/read', requireAuth, h(async (req, res) => {
    await db.collection('notifications').doc(req.params.id).update({ readAt: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  }));

  // =====================================================================================
  // Audit Logs (read-only for admins)
  // =====================================================================================
  app.get('/api/audit-logs', requireAuth, perms.requireCap('config:write'), h(async (req, res) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), per: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const all = sortBy(queryData(await db.collection('auditLogs').get()), 'createdAt', 'desc');
    const start = (q.page - 1) * q.per;
    res.json({ items: all.slice(start, start + q.per), page: q.page });
  }));

  // =====================================================================================
  // Question Bank & Candidate Testing Engine
  // =====================================================================================
  mountQB(app, { requireAuth, upload });

  // Serve frontend index.html for any non-API GET request
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/files')) return next();
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });

  // ── Error handling ──
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'The requested API endpoint does not exist.' }));
  app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'validation_failed', fields: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err && (err.status === 413 || err.type === 'entity.too.large')) return res.status(413).json({ error: 'payload_too_large', message: 'The request is too large.' });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'invalid_file', message: 'File is too large.' });
    if (err && (err.code === 'firebase_not_configured' || err.message === 'firebase_not_configured')) {
      return res.status(503).json({
        error: 'firebase_not_configured',
        message: 'Firebase is not fully configured on the server. Add FIREBASE_SERVICE_ACCOUNT in Vercel, then redeploy.',
      });
    }
    if (err && (err.code === 'permission_denied' || err.code === 7 || err.status === 403)) {
      return res.status(403).json({ error: 'permission_denied', message: 'You do not have permission to perform this action.' });
    }
    if (err && (err.code === 'auth/id-token-expired' || err.code === 'auth/argument-error')) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Your session has expired. Please sign in again.' });
    }
    console.error('[api]', req.method, req.originalUrl, err && (err.stack || err.message) || err);
    const message = process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again.'
      : (err && err.message) || 'Something went wrong.';
    res.status(500).json({ error: 'server_error', message });
  });

  return app;
}

module.exports = { createApp };
