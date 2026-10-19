'use strict';
// Small validation helpers (the module has no third-party dependencies) and the error type routes turn into JSON.
class ServiceError extends Error {
  constructor(status, code, message, extra = {}) { super(message || code); this.name = 'ServiceError'; this.status = status; this.code = code; Object.assign(this, extra); }
}
const bad = (message, fields) => new ServiceError(400, 'validation_failed', message, { fields });
const notFound = (what = 'not_found') => new ServiceError(404, 'not_found', what === 'not_found' ? 'Not found.' : what);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = v => typeof v === 'string' && UUID.test(v);
function uuid(v, name = 'id') { if (!isUuid(v)) throw notFound(); return v.toLowerCase(); }

function str(v, name, { min = 0, max = 1000, optional = false } = {}) {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`, [{ path: name, message: 'Required' }]); }
  if (typeof v !== 'string') throw bad(`${name} must be text.`, [{ path: name, message: 'Must be text' }]);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min ? `${min} to ` : 'at most '}${max} characters.`, [{ path: name, message: `Length ${min}-${max}` }]);
  return s;
}
function int(v, name, { min = -Infinity, max = Infinity, optional = false, def } = {}) {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; if (optional) return null; throw bad(`${name} is required.`, [{ path: name, message: 'Required' }]); }
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}.`, [{ path: name, message: 'Invalid number' }]);
  return n;
}
function num(v, name, { min = -Infinity, max = Infinity, optional = false, def } = {}) {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; if (optional) return null; throw bad(`${name} is required.`, [{ path: name, message: 'Required' }]); }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}.`, [{ path: name, message: 'Invalid number' }]);
  return n;
}
function bool(v, name, { def } = {}) {
  if (v === undefined || v === null) { if (def !== undefined) return def; throw bad(`${name} is required.`, [{ path: name, message: 'Required' }]); }
  if (typeof v !== 'boolean') throw bad(`${name} must be true or false.`, [{ path: name, message: 'Must be boolean' }]);
  return v;
}
function oneOf(v, name, list, { def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`, [{ path: name, message: 'Invalid value' }]);
  return v;
}
function date(v, name, { optional = true } = {}) {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${name} is required.`); }
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw bad(`${name} must be a valid date and time.`, [{ path: name, message: 'Invalid date' }]);
  return d;
}
function page(q, { per = 25, maxPer = 100 } = {}) {
  const p = Math.max(1, parseInt(q.page, 10) || 1), n = Math.min(maxPer, Math.max(1, parseInt(q.per, 10) || per));
  return { page: p, per: n, offset: (p - 1) * n };
}
const iso = d => (d ? new Date(d).toISOString() : null);
const likeEscape = s => String(s).replace(/[\\%_]/g, c => '\\' + c);

module.exports = { ServiceError, bad, notFound, isUuid, uuid, str, int, num, bool, oneOf, date, page, iso, likeEscape };
