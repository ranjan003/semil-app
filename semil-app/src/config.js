'use strict';
// Centralised configuration: validates required env vars and provides defaults.
// Every module reads from here, so there is one place to check.

function need(name, min = 1) {
  const v = process.env[name];
  if (!v || v.length < min) throw new Error(`Missing or too short environment variable: ${name}`);
  return v;
}

function opt(name, fallback) {
  return process.env[name] || fallback;
}

module.exports = {
  // ---- core ----
  get port() { return Number(process.env.PORT || 3000); },
  get databaseUrl() { return need('DATABASE_URL'); },
  get storageRoot() { return process.env.STORAGE_ROOT || './storage'; },
  get storageSecret() { return need('STORAGE_SIGNING_SECRET', 32); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
  get appOrigin() { return process.env.APP_ORIGIN || 'http://localhost:3000'; },

  // ---- SMTP (email) ----
  get smtpHost() { return opt('SMTP_HOST', ''); },
  get smtpPort() { return Number(opt('SMTP_PORT', '587')); },
  get smtpSecure() { return opt('SMTP_SECURE', 'false') === 'true'; },
  get smtpUser() { return opt('SMTP_USER', ''); },
  get smtpPass() { return opt('SMTP_PASS', ''); },
  get smtpFrom() { return opt('SMTP_FROM', 'Semil Talent Discovery <noreply@semil.in>'); },

  // ---- S3 storage ----
  get s3Bucket() { return opt('S3_BUCKET', ''); },
  get s3Region() { return opt('S3_REGION', opt('AWS_REGION', 'ap-south-1')); },
  get s3Endpoint() { return opt('S3_ENDPOINT', ''); },
  get s3AccessKey() { return opt('S3_ACCESS_KEY', opt('AWS_ACCESS_KEY_ID', '')); },
  get s3SecretKey() { return opt('S3_SECRET_KEY', opt('AWS_SECRET_ACCESS_KEY', '')); },
  get s3ForcePathStyle() { return opt('S3_FORCE_PATH_STYLE', 'false') === 'true'; },

  // ---- Redis ----
  get redisUrl() { return opt('REDIS_URL', ''); },
};
