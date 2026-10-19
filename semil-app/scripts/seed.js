'use strict';
// Creates the first Super Admin and the five initial vacancies. Run once after migrating.
// Usage: ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='long-passphrase-1' node scripts/seed.js
const { query, getPool } = require('../src/db');
const { hashPassword, passwordProblems } = require('../src/passwords');
(async () => {
  const email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
  const problems = passwordProblems(pw, email); if (problems.length) throw new Error(problems.join(' '));
  const u = await query(`INSERT INTO users(email,password_hash,full_name,role) VALUES ($1,$2,$3,'super_admin') ON CONFLICT DO NOTHING RETURNING id`, [email, hashPassword(pw), process.env.ADMIN_NAME || 'Super Admin']);
  const roles = [['Software Development Engineer (SDE I)','SDE','technical'],['Cloud & DevOps Engineer','DEVOPS','technical'],['Frontend Engineer','FE','technical'],['Business Development Associate','BDA','business'],['Operations & Logistics Associate','OPS','business']];
  for (const [t, c, tr] of roles) await query(`INSERT INTO vacancies(title,role_code,track,status) SELECT $1,$2,$3,'draft' WHERE NOT EXISTS (SELECT 1 FROM vacancies WHERE role_code=$2)`, [t, c, tr]);
  console.log(u.rows.length ? 'Super Admin created.' : 'Super Admin already exists.');
  await getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
