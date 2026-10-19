'use strict';
// Authentication middleware.
//
// The browser talks to Firebase Authentication and sends the resulting ID token in the
// Authorization header (and the server also accepts the __session cookie set at login).
// A token is accepted only after it has been verified by the Firebase Admin SDK or by
// Google Identity Toolkit. Roles are read from users/{uid} in the database; the web API
// key alone is never treated as a credential.
const crypto = require('node:crypto');
const firebase = require('./firebase');
const { auth } = firebase;
const { getUserProfile, ensureUserProfile, isAdminEmail, runWithToken, db, FieldValue } = require('./firestore-db');

// Only used by the legacy signSession helper. No secret is committed to the repository.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || process.env.GOOGLE_API_KEY || 'AIzaSyCdRMtDEgohaX74lylHfH0PrqDewTfR3Xw';

const VALID_ROLES = new Set(['super_admin', 'hr_admin', 'technical_assessor', 'business_assessor', 'candidate']);

function normaliseRole(role) {
  return VALID_ROLES.has(role) ? role : 'candidate';
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim() || null;
  if (req.cookies && req.cookies.__session) return String(req.cookies.__session).trim() || null;
  return null;
}

async function lookupWithIdentityToolkit(token) {
  if (!FIREBASE_API_KEY) return null;
  const resLookup = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
  if (!resLookup.ok) return null;
  const data = await resLookup.json();
  const u = data.users && data.users[0];
  if (!u) return null;
  let claimRole = null;
  if (u.customAttributes) {
    try { claimRole = JSON.parse(u.customAttributes).role || null; } catch { /* ignore malformed claims */ }
  }
  return {
    uid: u.localId,
    email: u.email || '',
    name: u.displayName || '',
    role: claimRole,
  };
}

/**
 * Express middleware. Sets req.user = { id, uid, email, full_name, role } and
 * req.authToken on success. Invalid/expired tokens are simply treated as unauthenticated.
 */
async function authMiddleware(req, res, next) {
  const token = readToken(req);
  req.user = null;
  req.authToken = null;
  if (!token) return next();

  let decoded = null;

  // 1. Preferred: Firebase Admin SDK (cryptographic verification, works offline/emulator).
  if (firebase.hasAdminCredentials) {
    try {
      decoded = await auth.verifyIdToken(token);
    } catch { /* invalid token — try the REST verifier below */ }
  }

  // 2. Fallback: Identity Toolkit REST verification with the public web API key.
  //    This is still Google verifying the signature; it is not a local trust decision.
  if (!decoded) {
    try {
      const lookedUp = await lookupWithIdentityToolkit(token);
      if (lookedUp) decoded = lookedUp;
    } catch (err) {
      console.warn('[auth] token verification failed:', err.message);
    }
  }

  if (!decoded || !decoded.uid) return next();

  const email = decoded.email || '';
  let profile = null;
  try {
    profile = await runWithToken(token, () => getUserProfile(decoded.uid));
    if (!profile) {
      profile = await runWithToken(token, () => ensureUserProfile({
        uid: decoded.uid,
        email,
        fullName: decoded.name || '',
        role: normaliseRole(decoded.role),
      }));
    }
  } catch (err) {
    console.warn('[auth] could not load user profile:', err.message);
  }

  // ADMIN_EMAILS is the explicit, server-side bootstrap/override list. It is never
  // exposed to the browser and still requires a valid Firebase login for that address.
  const forcedAdmin = isAdminEmail(email);
  const role = forcedAdmin ? 'super_admin' : normaliseRole((profile && profile.role) || decoded.role);

  if (forcedAdmin && profile && profile.role !== 'super_admin') {
    try {
      await runWithToken(token, () => db.collection('users').doc(decoded.uid).set({ role: 'super_admin', updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
      profile.role = 'super_admin';
    } catch (err) {
      console.warn('[auth] could not persist admin role:', err.message);
    }
  }

  req.authToken = token;
  req.user = {
    id: decoded.uid,
    uid: decoded.uid,
    email,
    full_name: (profile && (profile.full_name || profile.fullName)) || decoded.name || email || 'User',
    role,
  };
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: 'Please sign in to continue.' });
  next();
}

module.exports = { authMiddleware, requireAuth, signSession, verifySession };
