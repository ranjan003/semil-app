'use strict';
// S3-compatible private file storage with presigned URLs.
// Works with AWS S3, MinIO, DigitalOcean Spaces, Backblaze B2, etc.
// Drop-in replacement for LocalPrivateStorage: same put/read/remove/sign/verify interface.

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('node:crypto');

class S3PrivateStorage {
  /**
   * @param {object} opts
   * @param {string}  opts.bucket            S3 bucket name
   * @param {string}  opts.region            AWS region (e.g. 'ap-south-1')
   * @param {string}  [opts.endpoint]        Custom endpoint for MinIO / Spaces
   * @param {string}  [opts.accessKeyId]     AWS access key
   * @param {string}  [opts.secretAccessKey] AWS secret key
   * @param {string}  opts.secret            Signing secret for internal signed links (32+ chars)
   * @param {boolean} [opts.forcePathStyle]  true for MinIO (path-style URLs)
   */
  constructor(opts) {
    if (!opts.bucket) throw new Error('S3 bucket name is required');
    if (!opts.secret || opts.secret.length < 32) throw new Error('STORAGE_SIGNING_SECRET must be at least 32 characters');

    this.bucket = opts.bucket;
    this.secret = opts.secret;
    this.prefix = opts.prefix || '';

    const clientOpts = { region: opts.region || process.env.AWS_REGION || 'ap-south-1' };
    if (opts.endpoint) clientOpts.endpoint = opts.endpoint;
    if (opts.forcePathStyle) clientOpts.forcePathStyle = true;
    if (opts.accessKeyId) {
      clientOpts.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      };
    }
    this.client = new S3Client(clientOpts);
  }

  _key(key) { return this.prefix ? `${this.prefix}/${key}` : key; }

  async put({ kind, ownerId, ext }, buf) {
    const key = `${kind}/${ownerId}/${crypto.randomUUID()}${ext}`;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this._key(key),
      Body: buf,
      ServerSideEncryption: 'AES256',
      ContentLength: buf.length,
      Metadata: { sha256, kind, owner: ownerId },
    }));

    return { key, sha256, size: buf.length };
  }

  async read(key) {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this._key(key),
    }));
    // Collect stream into Buffer
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async remove(key) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this._key(key),
    }));
  }

  /**
   * Generate a presigned S3 GET URL (for direct browser download, bypasses the app server).
   * @param {string} key       Storage key
   * @param {number} ttlSeconds  Link lifetime (default 600 = 10 min)
   * @returns {Promise<string>} Presigned URL
   */
  async presignedUrl(key, ttlSeconds = 600) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: this._key(key),
    }), { expiresIn: ttlSeconds });
  }

  // ---- Internal signed links (same interface as LocalPrivateStorage) ----
  // These bind the link to a specific user and are verified by the app server.
  // For S3 deployments, presignedUrl() is preferred (direct-to-S3 download).

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

module.exports = { S3PrivateStorage };
