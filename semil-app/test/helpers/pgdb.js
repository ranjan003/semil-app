'use strict';
// Test-only database adapter: gives the application the same { query, tx } interface as src/db.js, but talks
// to a local PostgreSQL through a pool of persistent psql processes. It exists because the "pg" npm package
// cannot be installed in the build sandbox; the SQL, constraints, locks and transactions are all real PostgreSQL.
const { spawn } = require('node:child_process');

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('bad number parameter'); return String(v); }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `'{${v.map(x => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',')}}'`;
  if (typeof v === 'object') return literal(JSON.stringify(v));
  const s = String(v);
  if (s.includes('\0')) throw new Error('NUL in parameter');
  return `'${s.replace(/'/g, "''")}'`;
}
// substitute $n outside of quoted strings
function bind(text, params = []) {
  let out = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") { let j = i + 1; while (j < text.length) { if (text[j] === "'") { if (text[j + 1] === "'") j += 2; else break; } else j++; } out += text.slice(i, j + 1); i = j + 1; }
    else if (ch === '$' && /\d/.test(text[i + 1] || '')) { let j = i + 1; while (/\d/.test(text[j] || '')) j++; const n = parseInt(text.slice(i + 1, j), 10); if (n < 1 || n > params.length) throw new Error(`parameter $${n} missing`); out += literal(params[n - 1]); i = j; }
    else { out += ch; i++; }
  }
  return out;
}
function wrap(sql) {
  const s = sql.trim().replace(/;+\s*$/, '');
  const head = /^\s*(\w+)/.exec(s)[1].toUpperCase();
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'RESET', 'SAVEPOINT', 'RELEASE'].includes(head)) return { sql: s, rows: false };
  if (head === 'SELECT' || (head === 'WITH' && !/\b(INSERT|UPDATE|DELETE)\b/i.test(s.slice(0, 400)))) return { sql: `SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (${s}) t`, rows: true };
  const body = /\bRETURNING\b/i.test(s) ? s : `${s} RETURNING 1 AS _n`;
  return { sql: `WITH t AS (${body}) SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM t`, rows: true, bare: !/\bRETURNING\b/i.test(s) };
}

class Conn {
  constructor(env, dbName) {
    this.p = spawn('sh', ['-c', `exec psql -X -q -A -t -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -d ${dbName} 2>&1`], { env: { ...process.env, ...env, PGOPTIONS: '-c client_min_messages=error' } });
    this.buf = ''; this.waiting = null; this.n = 0; this.dead = false;
    this.p.stdout.on('data', d => { this.buf += d.toString('utf8'); this._check(); });
    this.p.on('exit', () => { this.dead = true; if (this.waiting) this.waiting.reject(new Error('psql exited: ' + this.buf)); });
  }
  _check() {
    if (!this.waiting) return;
    const m = this.buf.indexOf(this.waiting.mark + '\n');
    if (m < 0) return;
    const out = this.buf.slice(0, m); this.buf = this.buf.slice(m + this.waiting.mark.length + 1);
    const w = this.waiting; this.waiting = null; w.resolve(out);
  }
  run(sql) {
    return new Promise((resolve, reject) => {
      const mark = `__END_${++this.n}__`;
      this.waiting = { mark, resolve, reject };
      this.p.stdin.write(sql.replace(/\n/g, ' ') + ';\n\\echo ' + mark + '\n');
    });
  }
  close() { try { this.p.stdin.end(); } catch { /* ignore */ } }
}

function dbError(out) {
  const m = /ERROR:\s+(\w{5}):\s+([^\n]*)/.exec(out);
  const e = new Error(m ? m[2] : out.trim()); e.code = m ? m[1] : 'XX000'; e.pgOutput = out; return e;
}

class PgTestDb {
  constructor({ size = 6, env = {}, dbName = 'semil_test' } = {}) {
    this.dbName = dbName;
    this.env = { PGHOST: '/tmp', PGPORT: '54329', PGUSER: 'postgres', ...env };
    this.free = []; this.waiters = []; this.all = []; this.size = size; this.queries = 0;
  }
  async _acquire() {
    if (this.free.length) return this.free.pop();
    if (this.all.length < this.size) { const c = new Conn(this.env, this.dbName); this.all.push(c); return c; }
    return new Promise(r => this.waiters.push(r));
  }
  _release(c) { const w = this.waiters.shift(); if (w) w(c); else this.free.push(c); }
  async _exec(conn, text, params) {
    this.queries++;
    const w = wrap(bind(text, params));
    const out = await conn.run(w.sql);
    if (/^ERROR:\s/m.test(out)) throw dbError(out);
    if (!w.rows) return { rows: [], rowCount: 0 };
    const rows = JSON.parse(out.trim().split('\n').pop() || '[]');
    return { rows: w.bare ? [] : rows, rowCount: rows.length };
  }
  async query(text, params) { const c = await this._acquire(); try { return await this._exec(c, text, params); } finally { this._release(c); } }
  async tx(fn) {
    const c = await this._acquire();
    const client = { query: (t, p) => this._exec(c, t, p) };
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection already aborted */ } throw e; }
    finally { this._release(c); }
  }
  async end() { for (const c of this.all) c.close(); }
}
module.exports = { PgTestDb, bind, wrap };
