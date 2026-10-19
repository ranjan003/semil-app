'use strict';
const crypto = require('node:crypto');

const IDLE_MS = 30 * 60 * 1000;          // session expires after 30 minutes without activity
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // and never lives longer than 12 hours
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// `db` is anything with query(text, params) => Promise<{rows}>, e.g. a pg Pool.
async function createSession(db, userId, { ip, userAgent } = {}, now = Date.now()) {
  const token = newToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [userId, hashToken(token), new Date(now + ABSOLUTE_MS), ip || null, (userAgent || '').slice(0, 300)]);
  return token;   // sent once as an HttpOnly cookie; only the hash is stored
}

async function lookupSession(db, token, now = Date.now()) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.email, u.full_name, u.role, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [hashToken(token)]);
  const s = rows[0];
  if (!s || !s.is_active) return null;
  if (new Date(s.expires_at).getTime() < now || new Date(s.last_seen_at).getTime() + IDLE_MS < now) return null;
  await db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, [s.session_id, new Date(now)]);
  return { id: s.id, email: s.email, full_name: s.full_name, role: s.role, sessionId: s.session_id };
}

async function revokeSession(db, token) { await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [hashToken(token)]); }
async function revokeAllForUser(db, userId) { await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]); }

module.exports = { IDLE_MS, ABSOLUTE_MS, hashToken, newToken, createSession, lookupSession, revokeSession, revokeAllForUser };
