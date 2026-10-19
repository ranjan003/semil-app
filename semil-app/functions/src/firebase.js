'use strict';
// Firebase Admin SDK initialization — a single instance shared by all modules.
//
// Credentials are read, in order, from:
//   1. FIREBASE_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT_JSON  (JSON string, also accepts base64)
//   2. GOOGLE_APPLICATION_CREDENTIALS                            (path to a service-account JSON file)
//   3. Application Default Credentials                           (Cloud Functions / Cloud Run / GCE)
//
// On Vercel there is no ambient Google credential, so one of (1) or (2) must be set for
// Firestore, Firebase Storage and Admin Auth to work. The web API key is NOT a credential.
const admin = require('firebase-admin');

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const text = String(raw).trim();
  const candidates = [text];
  if (!text.startsWith('{')) {
    try { candidates.push(Buffer.from(text, 'base64').toString('utf8')); } catch { /* not base64 */ }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.private_key) {
        // Vercel / GitHub secrets often store the key with literal \n sequences.
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
        return parsed;
      }
    } catch { /* try the next representation */ }
  }
  console.error('[firebase] FIREBASE_SERVICE_ACCOUNT is set but could not be parsed as JSON.');
  return null;
}

const serviceAccount = parseServiceAccount();
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'semil-a9cf1';
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || 'semil-a9cf1.firebasestorage.app';
const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app';

if (!admin.apps.length) {
  const options = { projectId, storageBucket, databaseURL };
  if (serviceAccount) options.credential = admin.credential.cert(serviceAccount);
  admin.initializeApp(options);
}

// The Admin SDK can talk to Firestore without a local key when it runs inside Google Cloud
// (Application Default Credentials), or when the emulator host is configured.
const runningInGoogleCloud = !!(process.env.FUNCTION_TARGET || process.env.K_SERVICE || process.env.FIREBASE_CONFIG);
const hasServiceAccount = !!serviceAccount || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
const usingFirestoreEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
const hasFirestore = hasServiceAccount || usingFirestoreEmulator || runningInGoogleCloud;
const hasAdminCredentials = hasServiceAccount || usingFirestoreEmulator || runningInGoogleCloud;
const usingAuthEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

let firestoreSingleton = null;
function getFirestore() {
  if (!hasFirestore) {
    const err = new Error('Firestore is not configured. Set FIREBASE_SERVICE_ACCOUNT (the service-account JSON) on the server.');
    err.code = 'firebase_not_configured';
    throw err;
  }
  if (!firestoreSingleton) firestoreSingleton = admin.firestore();
  return firestoreSingleton;
}

const auth = admin.auth();
const storage = admin.storage();
const rtdb = typeof admin.database === 'function' ? admin.database() : null;

module.exports = {
  admin,
  auth,
  storage,
  rtdb,
  projectId,
  databaseURL,
  storageBucket,
  hasFirestore,
  hasServiceAccount,
  hasAdminCredentials,
  usingFirestoreEmulator,
  usingAuthEmulator,
  getFirestore,
};
