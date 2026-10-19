'use strict';
// Private file storage with expiring signed links.
// Files are never served from a public path. The default driver writes to a private folder
// on disk; the same interface can be backed by S3 / GCS in production (use their presigned URLs).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = {
  resume: { max: 5 * 1024 * 1024, ext: ['.pdf', '.docx'] },
  photo: { max: 2 * 1024 * 1024, ext: ['.png', '.jpg', '.jpeg'] },
  submission: { max: 20 * 1024 * 1024, ext: ['.zip', '.pdf'] },
  presentation: { max: 50 * 1024 * 1024, ext: ['.pdf', '.pptx', '.mp4'] },
};

// Check the real file signature, not just the name or the browser-supplied MIME type.
function sniff(buf) {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';  // zip, docx, pptx
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  return null;
}
const EXT_TO_SIG = { '.pdf': ['pdf'], '.docx': ['zip'], '.pptx': ['zip'], '.zip': ['zip'], '.png': ['png'], '.jpg': ['jpg'], '.jpeg': ['jpg'], '.mp4': ['mp4'] };
const SIG_TO_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', zip: 'application/octet-stream', mp4: 'video/mp4' };

function validateUpload(kind, originalName, buf) {
  const rule = LIMITS[kind];
  if (!rule) return { ok: false, error: 'Unknown file type category.' };
  const ext = path.extname(String(originalName)).toLowerCase();
  if (!rule.ext.includes(ext)) return { ok: false, error: `Only ${rule.ext.join(', ')} files are accepted.` };
  if (buf.length === 0) return { ok: false, error: 'The file is empty.' };
  if (buf.length > rule.max) return { ok: false, error: `File is larger than ${Math.round(rule.max / 1048576)} MB.` };
  const sig = sniff(buf);
  if (!sig || !EXT_TO_SIG[ext].includes(sig)) return { ok: false, error: 'File content does not match its extension.' };
  return { ok: true, ext, mime: ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : SIG_TO_MIME[sig] };
}

class LocalPrivateStorage {
  constructor({ root, secret }) {
    if (!secret || secret.length < 32) throw new Error('STORAGE_SIGNING_SECRET must be at least 32 characters');
    this.root = path.resolve(root);
    this.secret = secret;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  _resolve(key) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');   // blocks ../ traversal
    return full;
  }
  async put({ kind, ownerId, ext }, buf) {
    const key = `${kind}/${ownerId}/${crypto.randomUUID()}${ext}`;   // random name: original file names never reach disk
    const full = this._resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(full, buf, { mode: 0o600 });
    return { key, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  async read(key) { return fs.promises.readFile(this._resolve(key)); }
  async remove(key) { await fs.promises.rm(this._resolve(key), { force: true }); }

  // Signed link: base64url(key|expiry|userId) + HMAC. Bound to the requesting user, short lived.
  sign(key, userId, ttlSeconds = 600, now = Date.now()) {
    const payload = Buffer.from(`${key}|${Math.floor(now / 1000) + ttlSeconds}|${userId}`).toString('base64url');
    const mac = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }
  verify(token, userId, now = Date.now()) {
    const [payload, mac] = String(token).split('.');
    if (!payload || !mac) return null;
    const good = crypto.createHmac('sha256', this.secret).update(payload).digest();
    let given; try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
    const [key, exp, uid] = Buffer.from(payload, 'base64url').toString().split('|');
    if (uid !== userId || Number(exp) * 1000 < now) return null;
    return key;
  }
}

module.exports = { LocalPrivateStorage, validateUpload, sniff, LIMITS };
