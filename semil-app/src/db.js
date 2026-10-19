'use strict';
const { Pool } = require('pg');
const config = require('./config');
let pool;
function getPool() { return pool || (pool = new Pool({ connectionString: config.databaseUrl, max: 10 })); }
const query = (text, params) => getPool().query(text, params);
// Run several statements atomically.
async function tx(fn) {
  const c = await getPool().connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
module.exports = { getPool, query, tx };
