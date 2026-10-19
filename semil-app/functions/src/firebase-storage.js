'use strict';
// Firebase Storage adapter — replaces LocalPrivateStorage and S3 storage.
const crypto = require('node:crypto');
const path = require('node:path');
const { storage, hasAdminCredentials } = require('./firebase');

const LIMITS = {
  resume: { max: 5 * 1024 * 1024, ext: ['.pdf', '.docx'] },
  photo: { max: 2 * 1024 * 1024, ext: ['.png', '.jpg', '.jpeg'] },
  submission: { max: 20 * 1024 * 1024, ext: ['.zip', '.pdf'] },
  presentation: { max: 50 * 1024 * 1024, ext: ['.pdf', '.pptx', '.mp4'] },
};

function sniff(buf) {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';
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
  return {
    ok: true,
    ext,
    mime: ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : SIG_TO_MIME[sig],
  };
}

class FirebaseStorage {
  constructor() {
    this._bucket = null;
  }

  get bucket() {
    if (!this._bucket) {
      const bucketName = process.env.STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || (process.env.GCLOUD_PROJECT ? `${process.env.GCLOUD_PROJECT}.appspot.com` : undefined);
      try {
        this._bucket = bucketName ? storage.bucket(bucketName) : storage.bucket();
      } catch (e) {
        this._bucket = storage.bucket(bucketName || 'default-bucket');
      }
    }
    return this._bucket;
  }

  async put({ kind, ownerId, ext }, buf) {
    if (!hasAdminCredentials) {
      const err = new Error('File storage needs a Firebase service account. Add FIREBASE_SERVICE_ACCOUNT in Vercel.');
      err.code = 'firebase_not_configured';
      throw err;
    }
    const key = `documents/${ownerId}/${kind}/${crypto.randomUUID()}${ext}`;
    const file = this.bucket.file(key);
    await file.save(buf, {
      metadata: { contentType: SIG_TO_MIME[sniff(buf)] || 'application/octet-stream' },
      resumable: false,
    });
    return {
      key,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
    };
  }

  async read(key) {
    const file = this.bucket.file(key);
    const [buf] = await file.download();
    return buf;
  }

  async remove(key) {
    try {
      await this.bucket.file(key).delete();
    } catch { /* ignore if not found */ }
  }

  async getSignedUrl(key, ttlSeconds = 600) {
    if (!hasAdminCredentials) {
      const err = new Error('File storage needs a Firebase service account. Add FIREBASE_SERVICE_ACCOUNT in Vercel.');
      err.code = 'firebase_not_configured';
      throw err;
    }
    const file = this.bucket.file(key);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlSeconds * 1000,
    });
    return url;
  }

  // Compatibility: sign returns a token, verify checks it. For Firebase we use getSignedUrl instead.
  sign(key, userId, ttlSeconds = 600, now = Date.now()) {
    const payload = Buffer.from(`${key}|${Math.floor(now / 1000) + ttlSeconds}|${userId}`).toString('base64url');
    const secret = process.env.STORAGE_SIGNING_SECRET || 'firebase-default-secret-change-me-32chars!';
    const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  verify(token, userId, now = Date.now()) {
    const [payload, mac] = String(token).split('.');
    if (!payload || !mac) return null;
    const secret = process.env.STORAGE_SIGNING_SECRET || 'firebase-default-secret-change-me-32chars!';
    const good = crypto.createHmac('sha256', secret).update(payload).digest();
    let given; try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
    const [key, exp, uid] = Buffer.from(payload, 'base64url').toString().split('|');
    if (uid !== userId || Number(exp) * 1000 < now) return null;
    return key;
  }
}

module.exports = { FirebaseStorage, validateUpload, sniff, LIMITS };
