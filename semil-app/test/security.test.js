const test = require('node:test'); const assert = require('node:assert/strict');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { hashPassword, verifyPassword, passwordProblems } = require('../src/passwords');
const { LocalPrivateStorage, validateUpload } = require('../src/storage');
const S = require('../src/sessions');

test('passwords: hash verifies, wrong password fails, hashes are salted', () => {
  const h = hashPassword('Correct-horse-9'); assert.ok(verifyPassword('Correct-horse-9', h));
  assert.equal(verifyPassword('wrong', h), false); assert.notEqual(h, hashPassword('Correct-horse-9'));
  assert.equal(verifyPassword('x', 'garbage'), false);
});
test('password policy', () => {
  assert.ok(passwordProblems('short1').length); assert.ok(passwordProblems('onlyletterslong').length);
  assert.ok(passwordProblems('password1234').length); assert.deepEqual(passwordProblems('Blue-river-42'), []);
});
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 1)]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(100, 2)]);
test('uploads: type, size and real content are all checked', () => {
  assert.ok(validateUpload('resume', 'cv.pdf', pdf).ok); assert.ok(validateUpload('resume', 'cv.docx', zip).ok);
  assert.equal(validateUpload('resume', 'cv.exe', pdf).ok, false);                       // extension not allowed
  assert.equal(validateUpload('resume', 'cv.pdf', zip).ok, false);                       // renamed file
  assert.equal(validateUpload('resume', 'cv.pdf', Buffer.alloc(6 * 1048576)).ok, false); // too large
  assert.equal(validateUpload('resume', 'cv.pdf', Buffer.alloc(0)).ok, false);
  assert.equal(validateUpload('photo', 'me.png', pdf).ok, false);
});
test('storage: private put/read, signed link expiry, user binding, tamper and traversal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntg-')); const st = new LocalPrivateStorage({ root, secret: 'x'.repeat(40) });
  const { key } = await st.put({ kind: 'resume', ownerId: 'cand1', ext: '.pdf' }, pdf);
  assert.ok(!key.includes('cv')); assert.equal((await st.read(key)).length, pdf.length);
  const t0 = 1_000_000_000_000; const tok = st.sign(key, 'userA', 600, t0);
  assert.equal(st.verify(tok, 'userA', t0 + 599_000), key);
  assert.equal(st.verify(tok, 'userA', t0 + 601_000), null);   // expired
  assert.equal(st.verify(tok, 'userB', t0 + 1000), null);      // another user
  assert.equal(st.verify(tok.slice(0, -2) + 'AA', 'userA', t0 + 1000), null);   // tampered
  await assert.rejects(() => st.read('../../etc/passwd'));
  assert.throws(() => new LocalPrivateStorage({ root, secret: 'short' }));
});
test('sessions: only hashes stored; idle and absolute expiry enforced', async () => {
  const rows = []; let seen = null;
  const db = { async query(sql, p) {
    if (/INSERT INTO sessions/.test(sql)) { rows.push({ token_hash: p[1], expires_at: p[2], last_seen_at: new Date(), user_id: p[0] }); return { rows: [] }; }
    if (/FROM sessions s JOIN users/.test(sql)) { const r = rows.find(x => x.token_hash === p[0]); return { rows: r ? [{ ...r, session_id: 's1', id: 'u1', email: 'a@b.co', full_name: 'A', role: 'hr_admin', is_active: true }] : [] }; }
    if (/UPDATE sessions SET last_seen_at/.test(sql)) { seen = p[1]; const r = rows[0]; r.last_seen_at = p[1]; return { rows: [] }; }
    return { rows: [] }; } };
  const now = Date.now(); const tok = await S.createSession(db, 'u1', {}, now);
  assert.ok(!JSON.stringify(rows).includes(tok)); assert.equal(rows[0].token_hash, S.hashToken(tok));
  assert.ok(await S.lookupSession(db, tok, now + 60_000));
  assert.equal(await S.lookupSession(db, tok, now + 60_000 + S.IDLE_MS + 1), null);          // idle
  rows[0].last_seen_at = new Date(now + S.ABSOLUTE_MS); assert.equal(await S.lookupSession(db, tok, now + S.ABSOLUTE_MS + 1), null);   // absolute
  assert.equal(await S.lookupSession(db, 'bogus', now), null);
});
