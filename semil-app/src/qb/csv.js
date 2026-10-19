'use strict';
// CSV reader and writer (RFC 4180 quoting, auto-detected , ; or tab delimiter, UTF-8 with Windows-1252 fallback).
class CsvError extends Error { constructor(m, code = 'bad_csv') { super(m); this.name = 'CsvError'; this.code = code; } }

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

function detectDelimiter(text) {
  let first = '', q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    if (!q && (ch === '\n' || ch === '\r')) break;
    first += ch;
  }
  let best = ',', n = -1;
  for (const d of [',', ';', '\t']) {
    let c = 0, inq = false;
    for (const ch of first) { if (ch === '"') inq = !inq; else if (!inq && ch === d) c++; }
    if (c > n) { n = c; best = d; }
  }
  return best;
}

// returns { rows: [{ row, cells: string[] }] } where row is the 1-based record number; blank records are dropped
function parseCsv(input, { maxRows = 5001, maxCols = 40 } = {}) {
  const text = Buffer.isBuffer(input) ? decodeText(input) : String(input).replace(/^﻿/, '');
  if (text.includes('\0')) throw new CsvError('This does not look like a text CSV file.');
  const delim = detectDelimiter(text);
  const rows = [];
  let cells = [], field = '', inQ = false, recNo = 1, wasQuoted = false;
  const endField = () => { cells.push(field); field = ''; wasQuoted = false; if (cells.length > maxCols) throw new CsvError('The file has too many columns.', 'too_large'); };
  const endRecord = () => {
    endField();
    if (cells.some(c => c.trim() !== '')) rows.push({ row: recNo, cells });
    cells = []; recNo++;
    if (recNo > maxRows + 1) throw new CsvError(`The file has more than ${maxRows - 1} rows. Split it into smaller files.`, 'too_large');
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"' && field === '' && !wasQuoted) { inQ = true; wasQuoted = true; }
    else if (ch === delim) endField();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRecord(); }
    else if (ch === '\n') endRecord();
    else field += ch;
  }
  if (inQ) throw new CsvError('A quoted value is not closed. Check for a stray double quote.');
  if (field !== '' || cells.length) endRecord();
  return { rows, delimiter: delim };
}

// Spreadsheet programs run text starting with = + - @ as a formula. Exports prefix such text with an apostrophe.
function csvSafe(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + s;
  return s;
}
function csvCell(v) {
  const s = csvSafe(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(rows, { bom = true } = {}) {
  return (bom ? '﻿' : '') + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { CsvError, decodeText, parseCsv, writeCsv, csvSafe };
