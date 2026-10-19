'use strict';
// Firestore database helpers — provides utility functions for common patterns
// that were previously done with SQL queries.
let db, FieldValue, Timestamp;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const fb = require('./firebase');
    const fstore = require('firebase-admin/firestore');
    db = fb.db;
    FieldValue = fstore.FieldValue;
    Timestamp = fstore.Timestamp;
  } catch (err) {
    const rtdb = require('./rtdb-adapter');
    db = rtdb.db;
    FieldValue = rtdb.FieldValue;
    Timestamp = rtdb.Timestamp;
  }
} else {
  const rtdb = require('./rtdb-adapter');
  db = rtdb.db;
  FieldValue = rtdb.FieldValue;
  Timestamp = rtdb.Timestamp;
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
}

// ── Pagination helper ──
function paginate(query, page = 1, perPage = 25) {
  const offset = (page - 1) * perPage;
  return query.limit(perPage).offset(offset);
}

// ── Timestamp conversion helpers ──
function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Timestamp) return ts.toDate();
  if (ts instanceof Date) return ts;
  return new Date(ts);
}

function now() {
  return FieldValue.serverTimestamp();
}

// ── Snapshot-to-object helper ──
function docData(snap) {
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

function queryData(snap) {
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
  db,
  FieldValue,
  Timestamp,
  nextCounter,
  nextCandidateCode,
  nextQuestionCode,
  audit,
  paginate,
  toDate,
  now,
  docData,
  queryData,
};
