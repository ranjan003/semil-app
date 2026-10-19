'use strict';
// Creates a fresh PostgreSQL database with every migration applied, plus seed users, so each test file starts clean.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PgTestDb } = require('./pgdb');

const ENV = { PGHOST: process.env.PGHOST || '/tmp', PGPORT: process.env.PGPORT || '54329', PGUSER: process.env.PGUSER || 'postgres' };
const psql = (args, opts = {}) => spawnSync('psql', ['-X', '-q', ...args], { env: { ...process.env, ...ENV }, encoding: 'utf8', ...opts });

function available() { const r = psql(['-d', 'postgres', '-Atc', 'select 1']); return r.status === 0 && r.stdout.trim() === '1'; }

function createDb(name) {
  const dbName = 'nt_' + name.replace(/\W/g, '_');
  psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${dbName}`, '-c', `CREATE DATABASE ${dbName}`]);
  const dir = path.join(__dirname, '../../db/migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    const r = psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-1', '-f', path.join(dir, f)]);
    if (r.status !== 0) throw new Error(`migration ${f} failed: ${r.stderr}`);
  }
  return new PgTestDb({ env: ENV, dbName });
}

let n = 0;
// Inserts a user and returns the object the app puts on req.user
async function addUser(db, role, name) {
  const email = `${role}.${++n}.${Date.now() % 100000}@example.com`;
  const r = await db.query(`INSERT INTO users(email,password_hash,full_name,role) VALUES ($1,'x',$2,$3) RETURNING id`, [email, name || role + ' ' + n, role]);
  return { id: r.rows[0].id, email, full_name: name || role, role };
}
// candidate user + candidate row + application on a vacancy
async function addCandidate(db, vacancy, { stage = 'round_1', name, assessorId = null } = {}) {
  const user = await addUser(db, 'candidate', name || 'Cand ' + (n + 1));
  const c = (await db.query(`INSERT INTO candidates(full_name,email,phone,user_id,assessor_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [user.full_name, user.email, '98' + String(10000000 + n).slice(-8), user.id, assessorId])).rows[0];
  const a = (await db.query(`INSERT INTO applications(candidate_id,vacancy_id,stage) VALUES ($1,$2,$3) RETURNING id`, [c.id, vacancy.id, stage])).rows[0];
  return { user, candidateId: c.id, applicationId: a.id };
}
async function addVacancy(db, roleCode = 'SDE', title = 'Software Engineer') {
  return (await db.query(`INSERT INTO vacancies(title, role_code) VALUES ($1,$2) RETURNING id, role_code`, [title + ' ' + (++n), roleCode])).rows[0];
}

module.exports = { available, createDb, addUser, addCandidate, addVacancy, ENV };
