'use strict';
// Firebase Admin SDK initialization — single instance shared by all modules.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const bucket = process.env.STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'semil-a9cf1.firebasestorage.app';
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || 'semil-a9cf1',
    storageBucket: bucket,
  });
}

const db = admin.firestore();
const auth = admin.auth();
const storage = admin.storage();

module.exports = { admin, db, auth, storage };

