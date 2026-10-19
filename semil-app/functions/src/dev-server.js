'use strict';
// Local development server (not used by Vercel or Firebase Functions).
// Loads .env files without adding a dependency, then starts the same Express app
// that Vercel and Cloud Functions use.
const fs = require('node:fs');
const path = require('node:path');

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

loadEnv(path.resolve(__dirname, '../../.env'));
loadEnv(path.resolve(__dirname, '../../../.env'));

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();
app.listen(port, () => {
  console.log(`Semil API + web app listening on http://localhost:${port}`);
  console.log('Health: /healthz   Firebase status: /api/health/firebase');
});
