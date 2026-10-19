'use strict';
// Build-time sanity check. It never prints secrets and never fails a deploy because an
// optional integration is missing — it reports exactly what still needs configuring.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadEnv(path.join(root, 'semil-app/.env'));
loadEnv(path.join(root, '.env'));
const requiredFiles = [
  'api/index.js',
  'semil-app/public/index.html',
  'semil-app/public/js/firebase-auth.js',
  'semil-app/public/js/main.js',
  'semil-app/functions/src/app.js',
  'semil-app/functions/src/qb-firestore.js',
];
let failed = false;
for (const file of requiredFiles) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.error('Missing required file:', file); failed = true; }
}
if (failed) process.exit(1);

try {
  const { createApp } = require(path.join(root, 'semil-app/functions/src/app'));
  createApp();
  console.log('Express app created successfully.');
} catch (err) {
  console.error('The Express app failed to load:', err.message);
  process.exit(1);
}

const env = process.env;
const publicKeys = ['FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID'];
const missingPublic = publicKeys.filter(k => !env[k]);
if (missingPublic.length) console.warn('Missing public Firebase settings:', missingPublic.join(', '));
const hasServiceAccount = !!(env.FIREBASE_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS);
console.log(hasServiceAccount
  ? 'Firebase Admin credentials detected — Cloud Firestore will be used.'
  : 'No Firebase Admin credentials detected — the legacy RTDB fallback will be used. Add FIREBASE_SERVICE_ACCOUNT for Firestore.');
if (!env.ADMIN_EMAILS) console.warn('ADMIN_EMAILS is not set. New accounts default to the candidate role.');
console.log('Configuration check complete.');
