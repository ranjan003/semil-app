'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { createApp } = require('./src/app');

const app = createApp();

// Export as a single Cloud Function named "api"
// Firebase Hosting rewrites /api/** and /files/** to this function
exports.api = onRequest({
  region: 'asia-south1',        // Mumbai — closest to India
  timeoutSeconds: 120,
  memory: '512MiB',
  minInstances: 0,
  maxInstances: 100,
  cors: true,
}, app);
