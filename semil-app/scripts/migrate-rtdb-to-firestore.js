'use strict';
/*
 * Copy the legacy Realtime Database collections into Cloud Firestore.
 *
 * Usage (PowerShell):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\serviceAccount.json"
 *   $env:FIREBASE_DATABASE_URL="https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app"
 *   node scripts/migrate-rtdb-to-firestore.js --dry-run
 *   node scripts/migrate-rtdb-to-firestore.js
 *
 * The script keeps document ids, merges into existing Firestore documents (it never
 * deletes or replaces unrelated fields) and moves known RTDB sub-collections into real
 * Firestore sub-collections.
 */
const admin = require('firebase-admin');

const RTDB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/+$/, '');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'semil-a9cf1';
const DRY = process.argv.includes('--dry-run');
const SUBCOLLECTIONS = new Set(['versions', 'documents', 'applications', 'evaluations', 'stageChanges', 'events']);

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT_ID,
    credential: admin.credential.applicationDefault(),
    databaseURL: RTDB_URL,
  });
}
const db = admin.firestore();

async function fetchCollection(name) {
  // Use the Admin SDK rather than an unauthenticated REST call so the script works after
  // database.rules.json has been deployed (anonymous reads are denied).
  const snapshot = await admin.database().ref(name).once('value');
  return snapshot.val();
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

async function writeDoc(ref, data, stats) {
  const fields = {};
  const children = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (SUBCOLLECTIONS.has(key) && isPlainObject(value)) children.push([key, value]);
    else fields[key] = value;
  }
  if (DRY) { stats.docs++; }
  else if (Object.keys(fields).length) { await ref.set(fields, { merge: true }); stats.docs++; }
  for (const [sub, items] of children) {
    for (const [id, child] of Object.entries(items)) {
      if (isPlainObject(child)) await writeDoc(ref.collection(sub).doc(id), child, stats);
      else { if (!DRY) await ref.collection(sub).doc(id).set({ value: child }, { merge: true }); stats.docs++; }
    }
  }
}

(async () => {
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Source:  ${RTDB_URL}`);
  console.log(DRY ? 'Mode:    dry run (nothing is written)' : 'Mode:    write (existing fields are merged)');
  const root = await fetchCollection('');
  const collections = Object.keys(root || {}).filter(k => isPlainObject(root[k]));
  const total = { collections: 0, docs: 0 };
  for (const name of collections) {
    const data = await fetchCollection(name);
    if (!isPlainObject(data)) continue;
    const stats = { docs: 0 };
    for (const [id, doc] of Object.entries(data)) {
      if (!isPlainObject(doc)) continue;
      await writeDoc(db.collection(name).doc(id), doc, stats);
    }
    total.collections++;
    total.docs += stats.docs;
    console.log(`${name}: ${stats.docs} document(s)`);
  }
  console.log(`Done. ${total.docs} document(s) across ${total.collections} collection(s).`);
  if (DRY) console.log('Run again without --dry-run to write the data.');
})().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
