'use strict';
// Realtime Database Adapter providing Firestore-compatible DocumentReference,
// CollectionReference, Query, Batch, and Transaction APIs using Firebase RTDB REST API.
// Works seamlessly in serverless environments (Vercel) without Google Cloud Service Account files.

const crypto = require('node:crypto');

const RTDB_URL = (
  process.env.FIREBASE_DATABASE_URL ||
  'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app'
).replace(/\/+$/, '');

// Short in-memory cache to keep serverless functions fast
const cache = new Map();
const CACHE_TTL = 3000; // 3 seconds

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL) return item.data;
  return null;
}

function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

function invalidateCache(prefix) {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix) || prefix.startsWith(k)) cache.delete(k);
  }
}

async function rtdbFetch(path, options = {}) {
  const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const url = `${RTDB_URL}/${cleanPath}.json`;

  const method = options.method || 'GET';
  if (method === 'GET') {
    const cached = getCached(cleanPath);
    if (cached !== null) return cached;
  }

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`RTDB request failed [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  if (method === 'GET') {
    setCached(cleanPath, data);
  } else {
    invalidateCache(cleanPath.split('/')[0]);
  }
  return data;
}

// Convert Firestore FieldValues (like serverTimestamp and increment)
function sanitizeForRTDB(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (obj.__fieldValue === 'serverTimestamp') return new Date().toISOString();
  if (obj.__fieldValue === 'increment') return obj.val;

  if (Array.isArray(obj)) return obj.map(sanitizeForRTDB);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && v.__fieldValue === 'serverTimestamp') {
      out[k] = new Date().toISOString();
    } else if (v && v.__fieldValue === 'increment') {
      out[k] = v; // handled by updater
    } else {
      out[k] = sanitizeForRTDB(v);
    }
  }
  return out;
}

class DocumentSnapshot {
  constructor(id, data, path) {
    this.id = id;
    this._data = data;
    this.path = path;
    this.exists = data !== null && data !== undefined;
  }

  data() {
    if (!this.exists) return undefined;
    const copy = { ...this._data };
    delete copy.id;
    return copy;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }

  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class DocumentReference {
  constructor(path, id) {
    this.path = path;
    this.id = id;
  }

  collection(subColName) {
    return new CollectionReference(`${this.path}/${subColName}`);
  }

  async get() {
    const data = await rtdbFetch(this.path);
    return new DocumentSnapshot(this.id, data, this.path);
  }

  async set(data, options = {}) {
    const clean = sanitizeForRTDB(data);
    if (options && options.merge) {
      await rtdbFetch(this.path, { method: 'PATCH', body: clean });
    } else {
      await rtdbFetch(this.path, { method: 'PUT', body: clean });
    }
    return { writeTime: new Date().toISOString() };
  }

  async update(fields) {
    const existing = (await rtdbFetch(this.path)) || {};
    const updates = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v && v.__fieldValue === 'increment') {
        const cur = Number(existing[k]) || 0;
        updates[k] = cur + v.val;
      } else {
        updates[k] = sanitizeForRTDB(v);
      }
    }
    await rtdbFetch(this.path, { method: 'PATCH', body: updates });
    return { writeTime: new Date().toISOString() };
  }

  async delete() {
    await rtdbFetch(this.path, { method: 'DELETE' });
    return { writeTime: new Date().toISOString() };
  }
}

class Query {
  constructor(path, filters = [], orderings = [], limitVal = null, offsetVal = 0) {
    this.path = path;
    this._filters = filters;
    this._orderings = orderings;
    this._limit = limitVal;
    this._offset = offsetVal;
  }

  where(field, op, val) {
    return new Query(this.path, [...this._filters, { field, op, val }], [...this._orderings], this._limit, this._offset);
  }

  orderBy(field, dir = 'asc') {
    return new Query(this.path, [...this._filters], [...this._orderings, { field, dir: dir.toLowerCase() }], this._limit, this._offset);
  }

  limit(n) {
    return new Query(this.path, [...this._filters], [...this._orderings], n, this._offset);
  }

  offset(n) {
    return new Query(this.path, [...this._filters], [...this._orderings], this._limit, n);
  }

  async get() {
    const raw = await rtdbFetch(this.path);
    if (!raw || typeof raw !== 'object') {
      return new QuerySnapshot([]);
    }

    let items = Object.entries(raw).map(([id, val]) => ({
      id,
      ...(val && typeof val === 'object' ? val : { value: val }),
    }));

    // Apply where filters
    for (const f of this._filters) {
      items = items.filter(item => {
        const actual = item[f.field];
        switch (f.op) {
          case '==':
            return actual === f.val;
          case '!=':
            return actual !== f.val;
          case 'in':
            return Array.isArray(f.val) && f.val.includes(actual);
          case '>':
            return actual > f.val;
          case '>=':
            return actual >= f.val;
          case '<':
            return actual < f.val;
          case '<=':
            return actual <= f.val;
          default:
            return true;
        }
      });
    }

    // Apply orderings
    if (this._orderings.length > 0) {
      items.sort((a, b) => {
        for (const ord of this._orderings) {
          const va = a[ord.field];
          const vb = b[ord.field];
          if (va === vb) continue;
          if (va === undefined || va === null) return 1;
          if (vb === undefined || vb === null) return -1;
          const cmp = va > vb ? 1 : -1;
          return ord.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }

    // Apply offset & limit
    if (this._offset > 0) {
      items = items.slice(this._offset);
    }
    if (this._limit !== null && this._limit !== undefined) {
      items = items.slice(0, this._limit);
    }

    const docs = items.map(item => new DocumentSnapshot(item.id, item, `${this.path}/${item.id}`));
    return new QuerySnapshot(docs);
  }
}

class CollectionReference extends Query {
  constructor(path) {
    super(path);
  }

  doc(id) {
    const docId = id || crypto.randomUUID();
    return new DocumentReference(`${this.path}/${docId}`, docId);
  }

  async add(data) {
    const id = crypto.randomUUID();
    const docRef = this.doc(id);
    await docRef.set(data);
    return docRef;
  }
}

class WriteBatch {
  constructor() {
    this.ops = [];
  }

  set(docRef, data, options = {}) {
    this.ops.push(() => docRef.set(data, options));
    return this;
  }

  update(docRef, fields) {
    this.ops.push(() => docRef.update(fields));
    return this;
  }

  delete(docRef) {
    this.ops.push(() => docRef.delete());
    return this;
  }

  async commit() {
    for (const op of this.ops) {
      await op();
    }
    return { writeTime: new Date().toISOString() };
  }
}

class RTDBDatabase {
  collection(name) {
    return new CollectionReference(name);
  }

  batch() {
    return new WriteBatch();
  }

  async runTransaction(updateFn) {
    const tx = {
      async get(docRef) {
        return docRef.get();
      },
      set(docRef, data, options = {}) {
        return docRef.set(data, options);
      },
      update(docRef, fields) {
        return docRef.update(fields);
      },
      delete(docRef) {
        return docRef.delete();
      },
    };
    return updateFn(tx);
  }
}

const FieldValue = {
  serverTimestamp() {
    return { __fieldValue: 'serverTimestamp' };
  },
  increment(n) {
    return { __fieldValue: 'increment', val: Number(n) || 0 };
  },
};

const Timestamp = {
  now() {
    return new Date();
  },
  fromDate(d) {
    return d instanceof Date ? d : new Date(d);
  },
};

const rtdb = new RTDBDatabase();

module.exports = {
  db: rtdb,
  FieldValue,
  Timestamp,
  RTDBDatabase,
};
