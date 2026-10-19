'use strict';
// Firestore database helpers.
//
// Production path: Cloud Firestore through firebase-admin (requires a service account on Vercel).
// Legacy path: the Realtime Database adapter, kept only as an explicit fallback so an existing
// deployment does not go dark before a service account is added. New deployments should set
// FIREBASE_SERVICE_ACCOUNT and use Firestore.
//
// All application reads/writes go through this module so the rest of the API does not care
// which backend is active.
const firebase = require('./firebase');

const backend = firebase.hasFirestore ? 'firestore' : (process.env.FIREBASE_DISABLE_RTDB_FALLBACK === 'true' ? 'unconfigured' : 'rtdb');

let db, FieldValue, Timestamp, runWithToken;

if (backend === 'firestore') {
  const fstore = require('firebase-admin/firestore');
  db = firebase.getFirestore();
  FieldValue = fstore.FieldValue;
  Timestamp = fstore.Timestamp;
  runWithToken = (token, fn) => fn();
  console.log('[data] Using Cloud Firestore project', firebase.projectId);
} else {
  if (process.env.FIREBASE_DISABLE_RTDB_FALLBACK === 'true') {
    const notConfigured = () => {
      const err = new Error('Firestore credentials are missing. Set FIREBASE_SERVICE_ACCOUNT (service-account JSON) on the server.');
      err.code = 'firebase_not_configured';
      return err;
    };
    db = {
      collection() { throw notConfigured(); },
      batch() { throw notConfigured(); },
      runTransaction() { throw notConfigured(); },
    };
    FieldValue = { serverTimestamp: () => ({ __fieldValue: 'serverTimestamp' }), increment: n => ({ __fieldValue: 'increment', val: Number(n) || 0 }) };
    Timestamp = { now: () => new Date(), fromDate: d => new Date(d) };
    runWithToken = (token, fn) => fn();
    console.error('[data] Firestore is not configured and the legacy RTDB fallback is disabled.');
  } else {
    const rtdb = require('./rtdb-adapter');
    db = rtdb.db;
    FieldValue = rtdb.FieldValue;
    Timestamp = rtdb.Timestamp;
    runWithToken = rtdb.runWithToken;
    console.warn('[data] FIREBASE SERVICE ACCOUNT NOT SET — using the legacy Realtime Database fallback.');
    console.warn('[data] Add FIREBASE_SERVICE_ACCOUNT in Vercel and deploy database.rules.json to move to Cloud Firestore.');
  }
}

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || process.env.SUPER_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmail(email) {
  return !!email && adminEmails().includes(String(email).trim().toLowerCase());
}

function normaliseProfile(id, data, fallback = {}) {
  const d = data || {};
  return {
    id,
    uid: id,
    email: d.email || fallback.email || '',
    full_name: d.fullName || d.full_name || d.displayName || fallback.fullName || d.email || fallback.email || 'User',
    fullName: d.fullName || d.full_name || d.displayName || fallback.fullName || d.email || fallback.email || 'User',
    role: d.role || fallback.role || 'candidate',
    isActive: d.isActive !== false,
    ...d,
  };
}

/**
 * Resolve a user profile by Firebase UID. Never creates anything.
 * The profile document id is always the Firebase UID, so the same person can never
 * end up with two profile documents.
 */
async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  return normaliseProfile(uid, snap.data());
}

/**
 * Create the profile on first sign-in (email/password or Google). Existing profiles are
 * returned untouched, so a role assigned by an administrator is never overwritten.
 */
async function ensureUserProfile({ uid, email, fullName, role } = {}) {
  if (!uid) throw new Error('A Firebase UID is required to create a profile.');
  const existing = await getUserProfile(uid);
  if (existing) return existing;

  const effectiveRole = isAdminEmail(email) ? 'super_admin' : (role || 'candidate');
  const profile = {
    email: email || '',
    fullName: fullName || email || 'User',
    role: effectiveRole,
    isActive: true,
    failedLogins: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection('users').doc(uid).set(profile, { merge: true });

  // Re-read so callers get the same server timestamp representation as other requests.
  const created = await getUserProfile(uid);
  return created || normaliseProfile(uid, profile, { email, fullName });
}

async function touchLastLogin(uid) {
  if (!uid) return;
  try {
    await db.collection('users').doc(uid).update({ lastLoginAt: FieldValue.serverTimestamp() });
  } catch { /* the profile may not exist yet; not fatal */ }
}

// ── Auto-increment counters (replaces PostgreSQL sequences) ──
async function nextCounter(counterName, prefix = '', padLen = 4) {
  const ref = db.collection('counters').doc(counterName);
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const current = snap.exists ? snap.data().value : 0;
    const next = current + 1;
    t.set(ref, { value: next }, { merge: true });
    return next;
  });
  return prefix ? `${prefix}${String(result).padStart(padLen, '0')}` : String(result);
}

async function nextCandidateCode() {
  const year = new Date().getFullYear();
  return nextCounter('candidateCode', `NT-${year}-`, 4);
}

async function nextQuestionCode() {
  return nextCounter('questionCode', 'Q-', 5);
}

// ── Audit log (append-only) ──
async function audit(req, action, entityType, entityId, before, after) {
  try {
    await db.collection('auditLogs').add({
      actorId: req.user ? req.user.id : null,
      actorRole: req.user ? req.user.role : null,
      action,
      entityType,
      entityId: String(entityId || ''),
      before: before || null,
      after: after || null,
      ip: req.ip || null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // An audit failure must never make a successful business write look like a failure.
    console.error('[audit] could not write audit log:', err.message);
  }
}

// ── Pagination helper ──
function paginate(query, page = 1, perPage = 25) {
  const offset = (page - 1) * perPage;
  return query.limit(perPage).offset(offset);
}

// ── Timestamp conversion helpers ──
function toDate(ts) {
  if (!ts) return null;
  if (typeof Timestamp === 'function' && ts instanceof Timestamp) return ts.toDate();
  if (ts instanceof Date) return ts;
  if (typeof ts === 'object' && typeof ts.toDate === 'function') return ts.toDate();
  return new Date(ts);
}

function toIso(value) {
  const d = toDate(value);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

// Sort values that may be ISO strings, Firestore Timestamps or Dates.
function compareValues(a, b) {
  const av = a instanceof Date || (a && typeof a.toDate === 'function') ? toDate(a) : a;
  const bv = b instanceof Date || (b && typeof b.toDate === 'function') ? toDate(b) : b;
  if (av === bv) return 0;
  if (av === null || av === undefined) return 1;
  if (bv === null || bv === undefined) return -1;
  return av > bv ? 1 : -1;
}

function sortBy(items, field, dir = 'asc') {
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => sign * compareValues(a[field], b[field]));
}

function now() {
  return FieldValue.serverTimestamp();
}

// ── Snapshot-to-object helper ──
function docData(snap) {
  if (!snap || !snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

function queryData(snap) {
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
  db,
  FieldValue,
  Timestamp,
  backend,
  isFirestore: backend === 'firestore',
  runWithToken,
  adminEmails,
  isAdminEmail,
  getUserProfile,
  ensureUserProfile,
  touchLastLogin,
  nextCounter,
  nextCandidateCode,
  nextQuestionCode,
  audit,
  paginate,
  toDate,
  toIso,
  compareValues,
  sortBy,
  now,
  docData,
  queryData,
};
