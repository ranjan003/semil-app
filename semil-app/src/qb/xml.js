'use strict';
// Tiny helpers for the fixed XML shapes inside XLSX and DOCX files. This is not a general XML parser:
// documents that declare a DOCTYPE or ENTITY are refused, which removes entity-expansion and XXE attacks.

class XmlError extends Error { constructor(m) { super(m); this.name = 'XmlError'; this.code = 'bad_xml'; } }

function assertSafeXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlError('The file contains unsupported XML.');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : '';
    }
    return NAMED[e.toLowerCase()];
  });
}

// characters XML 1.0 cannot carry
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
function escapeXml(s) {
  return String(s).replace(BAD_CHARS, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function attrs(tag) {
  const out = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w:.-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(tag))) out[m[1] || m[3]] = decode(m[2] !== undefined ? m[2] : m[4]);
  return out;
}

module.exports = { XmlError, assertSafeXml, decode, escapeXml, attrs };
