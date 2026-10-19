'use strict';
const http = require('node:http');
const config = require('./config');
const db = require('./db');
const { createStorage } = require('./storage-factory');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');
const { createRealtime } = require('./realtime');
const redis = require('./redis');

// ---- build dependencies ----
const storage = createStorage(config);
const mailer = createMailer({
  host: config.smtpHost || undefined,
  port: config.smtpPort,
  secure: config.smtpSecure,
  user: config.smtpUser || undefined,
  pass: config.smtpPass || undefined,
  from: config.smtpFrom,
  isProd: config.isProd,
});

const rateLimiter = new redis.RedisRateLimiter(10, 15 * 60 * 1000);
const sessionCache = new redis.RedisSessionCache(300);
const pubsub = new redis.RedisPubSub();

const app = createApp({ db, storage, mailer, rateLimiter, sessionCache, isProd: config.isProd });

// ---- HTTP server ----
const httpServer = http.createServer(app);

// ---- WebSocket / real-time ----
const realtime = createRealtime(httpServer, { db, pubsub, isProd: config.isProd });
// Attach realtime to app locals so routes (camera, etc.) can use it
app.locals.realtime = realtime;

// ---- Sweeper: closes question-bank attempts whose time ran out ----
const sweep = () => require('./qb/attempt').sweepExpired(db, (action, type, id, before, after, client) => (client || db).query(
  `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, before, after) VALUES (NULL, NULL, $1, $2, $3, $4, $5)`,
  [action, type, String(id || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null])).catch(e => console.error('sweep failed', e.message));
const sweeper = setInterval(sweep, 30000); sweeper.unref();

// ---- Start ----
httpServer.listen(config.port, () => {
  console.log(`Semil Talent Discovery API listening on :${config.port}`);
  console.log(`  Environment : ${config.isProd ? 'production' : 'development'}`);
  console.log(`  Storage     : ${config.s3Bucket ? 'S3 (' + config.s3Bucket + ')' : 'local disk'}`);
  console.log(`  Redis       : ${config.redisUrl ? 'connected' : 'in-memory fallback'}`);
  console.log(`  Email       : ${config.smtpHost ? config.smtpHost : 'console (dev mode)'}`);
  console.log(`  WebSocket   : /ws`);
});

// ---- Graceful shutdown ----
async function shutdown() {
  console.log('\n[shutdown] closing…');
  clearInterval(sweeper);
  httpServer.close(async () => {
    try { await pubsub.close(); } catch { /* ignore */ }
    try { await redis.disconnect(); } catch { /* ignore */ }
    try { await db.getPool().end(); } catch { /* ignore */ }
    console.log('[shutdown] done');
    process.exit(0);
  });
  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => { console.error('[shutdown] forced exit'); process.exit(1); }, 10000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
process.on('uncaughtException', (err) => { console.error('[fatal] uncaught exception:', err); shutdown(); });
process.on('unhandledRejection', (err) => { console.error('[fatal] unhandled rejection:', err); });
