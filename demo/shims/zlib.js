import pako from 'pako';
import { Buffer } from './buffer.js';
export function inflateRawSync(raw, opts = {}) {
  const out = pako.inflateRaw(raw);
  if (opts.maxOutputLength && out.length > opts.maxOutputLength) throw new RangeError('Cannot create a Buffer larger than the limit');
  return Buffer.from(out);
}
export function deflateRawSync(data, opts = {}) { return Buffer.from(pako.deflateRaw(data, { level: opts.level ?? 6 })); }
export default { inflateRawSync, deflateRawSync };
