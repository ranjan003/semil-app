'use strict';
// Redis plugin: session store and rate limiter for multi-server deployments.
// Falls back to in-memory stores when REDIS_URL is not set (single-server / dev).

let Redis;
try { Redis = require('ioredis'); } catch { Redis = null; }

// =====================================================================================
// Connection
// =====================================================================================

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url || !Redis) return null;
  _client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
    enableReadyCheck: true,
  });
  _client.on('error', err => console.error('[redis] connection error:', err.message));
  _client.on('connect', () => console.log('[redis] connected'));
  return _client;
}

async function disconnect() {
  if (_client) { await _client.quit(); _client = null; }
}

// =====================================================================================
// Rate limiter (sliding window)
// =====================================================================================

class RedisRateLimiter {
  /**
   * @param {number} maxAttempts  Max attempts in the window
   * @param {number} windowMs    Window duration in milliseconds
   */
  constructor(maxAttempts = 10, windowMs = 15 * 60 * 1000) {
    this.max = maxAttempts;
    this.windowMs = windowMs;
  }

  async isLimited(key) {
    const client = getClient();
    if (!client) return this._memoryLimited(key);
    const now = Date.now();
    const k = `rl:${key}`;
    const pipe = client.pipeline();
    pipe.zremrangebyscore(k, 0, now - this.windowMs);
    pipe.zcard(k);
    const results = await pipe.exec();
    const count = results[1][1];
    return count >= this.max;
  }

  async note(key) {
    const client = getClient();
    if (!client) return this._memoryNote(key);
    const now = Date.now();
    const k = `rl:${key}`;
    const pipe = client.pipeline();
    pipe.zadd(k, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
    pipe.zremrangebyscore(k, 0, now - this.windowMs);
    pipe.expire(k, Math.ceil(this.windowMs / 1000));
    await pipe.exec();
  }

  // Fallback: in-memory (single server only)
  _memStore = new Map();
  _memoryLimited(key) {
    const now = Date.now();
    const a = (this._memStore.get(key) || []).filter(t => now - t < this.windowMs);
    this._memStore.set(key, a);
    return a.length >= this.max;
  }
  _memoryNote(key) {
    const a = this._memStore.get(key) || [];
    a.push(Date.now());
    this._memStore.set(key, a);
  }
}

// =====================================================================================
// Session cache (optional: speeds up session lookups, not a replacement for DB)
// =====================================================================================

class RedisSessionCache {
  constructor(ttlSeconds = 300) {
    this.ttl = ttlSeconds;
  }

  async get(tokenHash) {
    const client = getClient();
    if (!client) return null;
    const data = await client.get(`sess:${tokenHash}`);
    return data ? JSON.parse(data) : null;
  }

  async set(tokenHash, sessionData) {
    const client = getClient();
    if (!client) return;
    await client.setex(`sess:${tokenHash}`, this.ttl, JSON.stringify(sessionData));
  }

  async invalidate(tokenHash) {
    const client = getClient();
    if (!client) return;
    await client.del(`sess:${tokenHash}`);
  }

  async invalidateUser(userId) {
    const client = getClient();
    if (!client) return;
    // Invalidate all sessions for a user (scan + delete pattern)
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        const pipe = client.pipeline();
        for (const k of keys) {
          pipe.get(k);
        }
        const vals = await pipe.exec();
        const delKeys = [];
        vals.forEach(([err, val], i) => {
          if (!err && val) {
            try { const d = JSON.parse(val); if (d.id === userId) delKeys.push(keys[i]); } catch { /* skip */ }
          }
        });
        if (delKeys.length) await client.del(...delKeys);
      }
    } while (cursor !== '0');
  }
}

// =====================================================================================
// Pub/Sub helper (for real-time events across servers)
// =====================================================================================

class RedisPubSub {
  constructor() {
    this._sub = null;
    this._handlers = new Map();
  }

  _getSub() {
    if (this._sub) return this._sub;
    const url = process.env.REDIS_URL;
    if (!url || !Redis) return null;
    this._sub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this._sub.on('message', (channel, message) => {
      const handlers = this._handlers.get(channel) || [];
      let data;
      try { data = JSON.parse(message); } catch { data = message; }
      handlers.forEach(fn => fn(data));
    });
    return this._sub;
  }

  subscribe(channel, handler) {
    const sub = this._getSub();
    if (!sub) return;
    if (!this._handlers.has(channel)) {
      this._handlers.set(channel, []);
      sub.subscribe(channel);
    }
    this._handlers.get(channel).push(handler);
  }

  async publish(channel, data) {
    const client = getClient();
    if (!client) return;
    await client.publish(channel, JSON.stringify(data));
  }

  async close() {
    if (this._sub) { await this._sub.quit(); this._sub = null; }
  }
}

module.exports = {
  getClient,
  disconnect,
  RedisRateLimiter,
  RedisSessionCache,
  RedisPubSub,
};
