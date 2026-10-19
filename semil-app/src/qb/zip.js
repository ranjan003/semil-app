'use strict';
// Minimal ZIP reader and writer built on node:zlib, so XLSX and DOCX files can be read and produced
// without installing a package. The reader is defensive: uploaded files are untrusted.
//   - refuses encrypted entries, ZIP64, unknown compression methods and unsafe file names
//   - caps the number of entries and the decompressed size of every entry and of the whole archive,
//     and verifies declared sizes and CRC, which stops "zip bombs"
const zlib = require('node:zlib');

class ZipError extends Error {
  constructor(message, code = 'bad_zip') { super(message); this.name = 'ZipError'; this.code = code; }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const DEFAULT_LIMITS = { maxEntries: 300, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };

function readZip(buf, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('The file is not a valid Office document.');
  let eocd = -1;
  for (let i = buf.length - 22, stop = Math.max(0, buf.length - 22 - 65535); i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('The file is not a valid Office document (no zip directory found).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw new ZipError('ZIP64 files are not supported.', 'unsupported');
  if (count > L.maxEntries) throw new ZipError('The file contains too many parts.', 'too_large');
  if (cdOff + cdSize > buf.length) throw new ZipError('The zip directory is damaged.');

  const entries = new Map();
  let p = cdOff, declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip directory is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError('Password-protected files are not supported.', 'unsupported');
    if (method !== 0 && method !== 8) throw new ZipError('The file uses an unsupported compression method.', 'unsupported');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || name.includes('\0')) throw new ZipError('The file contains an unsafe path.', 'unsafe');
    if (usize > L.maxEntryBytes) throw new ZipError('A part of the file is too large when unpacked.', 'too_large');
    declaredTotal += usize;
    if (declaredTotal > L.maxTotalBytes) throw new ZipError('The file is too large when unpacked.', 'too_large');
    if (entries.has(name)) throw new ZipError('The file contains duplicate parts.', 'unsafe');
    if (!name.endsWith('/')) entries.set(name, { name, method, crc, csize, usize, localOff });
  }

  let inflated = 0;
  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const o = e.localOff;
      if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new ZipError('The file is damaged.');
      const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
      if (start + e.csize > buf.length) throw new ZipError('The file is damaged.');
      const raw = buf.subarray(start, start + e.csize);
      let out;
      try { out = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: e.usize + 1 }); }
      catch { throw new ZipError('A part of the file could not be unpacked.', 'bad_zip'); }
      if (out.length !== e.usize || crc32(out) !== e.crc) throw new ZipError('The file is damaged (checksum mismatch).');
      inflated += out.length;
      if (inflated > L.maxTotalBytes) throw new ZipError('The file is too large when unpacked.', 'too_large');
      return out;
    },
    text(name) { const b = this.read(name); return b ? b.toString('utf8').replace(/^﻿/, '') : null; },
  };
}

// files: [{ name, data: Buffer | string }]; output is deterministic (fixed timestamps).
function writeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data, method = useDeflate ? 8 : 0, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);                         // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

module.exports = { ZipError, readZip, writeZip, crc32 };
