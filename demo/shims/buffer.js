// Minimal Buffer for the browser demo: just what the question-bank modules use.
const dec = new TextDecoder('utf-8'), enc = new TextEncoder();
export class Buffer extends Uint8Array {
  static isBuffer(x) { return x instanceof Buffer; }
  static alloc(n) { return new Buffer(n); }
  static from(v, e) {
    if (typeof v === 'string') {
      if (e === 'hex') { const b = new Buffer(v.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16); return b; }
      const u = enc.encode(v); const b = new Buffer(u.length); b.set(u); return b;
    }
    if (v instanceof ArrayBuffer) return new Buffer(v);
    const b = new Buffer(v.length); b.set(v); return b;
  }
  static concat(list, total) {
    const n = total ?? list.reduce((s, x) => s + x.length, 0); const b = new Buffer(n); let o = 0;
    for (const x of list) { b.set(x, o); o += x.length; } return b;
  }
  toString(e, s = 0, t = this.length) {
    const part = this.subarray(s, t);
    if (e === 'hex') return Array.from(part, x => x.toString(16).padStart(2, '0')).join('');
    if (e === 'latin1' || e === 'binary') return Array.from(part, x => String.fromCharCode(x)).join('');
    return dec.decode(part);
  }
  readUInt32BE(o) { return ((this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]) >>> 0; }
  readUInt16LE(o) { return this[o] | (this[o + 1] << 8); }
  readUInt32LE(o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24)) >>> 0; }
  writeUInt16LE(v, o) { this[o] = v & 255; this[o + 1] = (v >>> 8) & 255; return o + 2; }
  writeUInt32LE(v, o) { this[o] = v & 255; this[o + 1] = (v >>> 8) & 255; this[o + 2] = (v >>> 16) & 255; this[o + 3] = (v >>> 24) & 255; return o + 4; }
  writeBigUInt64BE(v, o = 0) { for (let i = 7; i >= 0; i--) { this[o + i] = Number(v & 0xffn); v >>= 8n; } return o + 8; }
  equals(o) { if (o.length !== this.length) return false; for (let i = 0; i < o.length; i++) if (this[i] !== o[i]) return false; return true; }
}
