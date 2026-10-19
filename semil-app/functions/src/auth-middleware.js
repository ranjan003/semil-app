'use strict';
// Firebase Auth middleware — replaces the cookie-based session system.
// Verifies the Firebase ID token from the Authorization header.
const { auth } = require('./firebase');

/**
 * Express middleware: extracts and verifies the Firebase ID token.
 * Sets req.user = { id, email, full_name, role } on success.
 */
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const cookie = req.cookies && req.cookies.__session;
  let idToken = null;

  if (header.startsWith('Bearer ')) {
    idToken = header.slice(7);
  } else if (cookie) {
    idToken = cookie;
  }

  if (!idToken) {
    req.user = null;
    return next();
  }

  try {
    const decoded = await auth.verifyIdToken(idToken);
    req.user = {
      id: decoded.uid,
      email: decoded.email || '',
      full_name: decoded.name || decoded.email || '',
      role: decoded.role || 'candidate',
    };
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

module.exports = { authMiddleware, requireAuth };
