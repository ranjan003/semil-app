'use strict';
const crypto = require('node:crypto');

// scrypt is built into Node, so password hashing needs no native dependency.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const key = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

const COMMON = new Set(['password123', 'password1234', 'qwerty12345', '1234567890', 'semil12345', 'welcome12345', 'letmein12345']);
function passwordProblems(pw, email = '') {
  const out = [];
  if (typeof pw !== 'string' || pw.length < 10) out.push('Use at least 10 characters.');
  if (pw && pw.length > 128) out.push('Use at most 128 characters.');
  if (COMMON.has(String(pw).toLowerCase())) out.push('This password is too common.');
  if (email && pw && String(pw).toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) out.push('Do not include your email name.');
  if (pw && !(/[a-z]/i.test(pw) && /[0-9]/.test(pw))) out.push('Include letters and at least one number.');
  return out;
}

module.exports = { hashPassword, verifyPassword, passwordProblems };
