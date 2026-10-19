'use strict';
// Factory: create the correct storage backend from environment variables.
// Local disk for development, S3 for production.

const { LocalPrivateStorage } = require('./storage');
const { S3PrivateStorage } = require('./storage-s3');

/**
 * @param {object} config  The app config object
 * @returns {LocalPrivateStorage|S3PrivateStorage}
 */
function createStorage(config) {
  const s3Bucket = process.env.S3_BUCKET;

  if (s3Bucket) {
    console.log(`[storage] Using S3 bucket: ${s3Bucket}`);
    return new S3PrivateStorage({
      bucket: s3Bucket,
      region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      accessKeyId: process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      secret: config.storageSecret,
      prefix: process.env.S3_PREFIX || '',
    });
  }

  console.log(`[storage] Using local disk: ${config.storageRoot}`);
  return new LocalPrivateStorage({
    root: config.storageRoot,
    secret: config.storageSecret,
  });
}

module.exports = { createStorage };
