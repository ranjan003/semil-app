'use strict';
// Runs the REAL route handlers of the question bank module without Express (which cannot be installed in the build
// sandbox). Provides just the parts of Express the module uses: route registration with :params, req.query / body /
// get(), res.status().json() / send() / set(). Also can serve the web app over HTTP for browser tests.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const perms = require('../../src/permissions');
const qb = require('../../src/qb/routes');

function makeRouter() {
  const routes = [];
  const app = { routes };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, ...handlers) => {
      const keys = [];
      const re = new RegExp('^' + p.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
      routes.push({ method: m.toUpperCase(), re, keys, handlers });
    };
  }
  return app;
}

function createHarness(db) {
  const app = makeRouter();
  const audit = async (req, action, entityType, entityId, before, after, client = db) => client.query(
    `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, before, after, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.user ? req.user.id : null, req.user ? req.user.role : null, action, entityType, String(entityId || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.ip || null]);
  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'unauthenticated' }));
  qb.mount(app, { db, requireAuth, perms, audit, raw: (req, res, next) => next() });

  // inject({ method, url, user, json | file:{buffer}, headers }) -> { status, body, headers, raw }
  async function inject({ method = 'GET', url, user = null, json, buffer, headers = {} }) {
    const u = new URL(url, 'http://x');
    const route = app.routes.find(r => r.method === method && r.re.test(u.pathname));
    const query = Object.fromEntries(u.searchParams);
    if (!route) return { status: 404, body: { error: 'not_found' }, headers: {} };
    const m = route.re.exec(u.pathname);
    const params = {}; route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method, params, query, body: buffer !== undefined ? buffer : (json !== undefined ? JSON.parse(JSON.stringify(json)) : {}), user, ip: '127.0.0.1', get: n => lower[n.toLowerCase()] };
    return new Promise(resolve => {
      const res = { code: 200, hdr: {} };
      res.status = c => { res.code = c; return res; };
      res.set = (k, v) => { if (typeof k === 'object') Object.assign(res.hdr, k); else res.hdr[k] = v; return res; };
      res.json = o => { res.hdr['Content-Type'] = 'application/json'; resolve({ status: res.code, body: JSON.parse(JSON.stringify(o)), headers: res.hdr }); };
      res.send = b => resolve({ status: res.code, raw: b, body: null, headers: res.hdr });
      res.end = () => resolve({ status: res.code, body: null, headers: res.hdr });
      const chain = route.handlers.slice();
      const next = err => {
        if (err) { return resolve({ status: 500, body: { error: 'server_error', detail: String(err && err.stack || err) }, headers: {} }); }
        const fn = chain.shift();
        if (!fn) return;
        try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); }
      };
      next();
    });
  }

  // ---- HTTP server for browser tests: cookie "sid" = user id of a seeded user (login by e-mail, test-only)
  const users = new Map();
  function serve(port = 0, publicDir = path.join(__dirname, '../../public')) {
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    const server = http.createServer(async (rq, rs) => {
      try {
        const u = new URL(rq.url, 'http://x');
        const cookies = Object.fromEntries((rq.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => c.split('=')));
        const user = users.get(cookies.sid) || null;
        const chunks = []; for await (const c of rq) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (u.pathname === '/api/auth/login' && rq.method === 'POST') {
          const { email } = JSON.parse(body.toString() || '{}');
          const found = [...users.values()].find(x => x.email === email);
          if (!found) { rs.writeHead(401, { 'Content-Type': 'application/json' }); return rs.end('{"error":"invalid_credentials"}'); }
          rs.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${found.id}; Path=/; HttpOnly` });
          return rs.end(JSON.stringify({ id: found.id, email: found.email, full_name: found.full_name, role: found.role }));
        }
        if (u.pathname === '/api/auth/logout' && rq.method === 'POST') { rs.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); return rs.end('{"ok":true}'); }
        if (u.pathname === '/api/me') { rs.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify(user || { error: 'unauthenticated' })); }
        if (u.pathname === '/api/candidates' && rq.method === 'GET' && user && perms.can(user, 'candidate:read')) {   // stand-in for the existing app.js list route (same columns), used by the assign screen
          const st = u.searchParams.get('stage');
          const r = await db.query(`SELECT c.id, c.candidate_code, c.full_name, c.email, v.role_code, a.stage::text AS stage, a.id AS application_id FROM candidates c JOIN applications a ON a.candidate_id=c.id JOIN vacancies v ON v.id=a.vacancy_id WHERE c.deleted_at IS NULL ${st ? 'AND a.stage = $1::app_stage' : ''} ORDER BY c.full_name LIMIT 100`, st ? [st] : []);
          rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ items: r.rows, page: 1 }));
        }
        if (u.pathname.startsWith('/api/')) {
          if (!['GET', 'HEAD'].includes(rq.method) && rq.headers['x-requested-with'] !== 'semil') { rs.writeHead(403, { 'Content-Type': 'application/json' }); return rs.end('{"error":"csrf_check_failed"}'); }
          const isJson = (rq.headers['content-type'] || '').includes('application/json');
          const out = await inject({ method: rq.method, url: rq.url, user, ...(isJson ? { json: body.length ? JSON.parse(body.toString()) : {} } : { buffer: body }), headers: { 'content-type': rq.headers['content-type'] || '' } });
          if (out.raw !== undefined) { rs.writeHead(out.status, out.headers); return rs.end(out.raw); }
          rs.writeHead(out.status, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify(out.body));
        }
        const file = path.join(publicDir, path.normalize(u.pathname === '/' ? '/index.html' : u.pathname).replace(/^(\.\.[/\\])+/, ''));
        if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rs.writeHead(404); return rs.end('not found'); }
        rs.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); rs.end(fs.readFileSync(file));
      } catch (e) { rs.writeHead(500); rs.end(String(e && e.stack)); }
    });
    return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port })));
  }
  const registerUser = u => users.set(u.id, u);
  return { app, inject, serve, registerUser };
}

module.exports = { createHarness };
