'use strict';
// Upload handling for the question bank: file checks, parsing (CSV / XLSX / DOCX), header mapping,
// row validation and the preview plan. Pure functions, no database access: the service supplies what already exists.
const crypto = require('node:crypto');
const path = require('node:path');
const { parseCsv, CsvError } = require('./csv');
const { readXlsx, XlsxError } = require('./xlsx');
const { readDocx, DocxError } = require('./docx');
const { COLUMNS, REQUIRED_KEYS, headerKey, validateQuestion, IS_SAMPLE } = require('./schema');

class UploadError extends Error { constructor(m, status = 400, code = 'bad_upload') { super(m); this.name = 'UploadError'; this.status = status; this.code = code; } }

const MAX_BYTES = 5 * 1024 * 1024;
const MIME = {
  csv:  new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'text/comma-separated-values', 'application/octet-stream', '']),
  xlsx: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed', '']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed', '']),
};
const LEGACY = { xls: 'Excel 97-2003 (.xls) files are not supported. Open it in Excel and use Save As > Excel Workbook (.xlsx).', doc: 'Word 97-2003 (.doc) files are not supported. Open it in Word and use Save As > Word Document (.docx).' };

// Validates name, size, declared MIME and magic bytes. Returns the format.
function checkUpload({ buffer, fileName, mime }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new UploadError('The file is empty.');
  if (buffer.length > MAX_BYTES) throw new UploadError(`The file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it into smaller files.`, 413, 'too_large');
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  if (LEGACY[ext]) throw new UploadError(LEGACY[ext], 415, 'unsupported');
  if (!MIME[ext]) throw new UploadError('Unsupported file type. Upload a .csv, .xlsx or .docx file.', 415, 'unsupported');
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!MIME[ext].has(m)) throw new UploadError(`The file type "${m}" does not match a .${ext} file.`, 415, 'mime_mismatch');
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (ext === 'csv') {
    if (isZip) throw new UploadError('This file is an Office document, not a CSV. Rename it with the right extension or export as CSV.', 415, 'mime_mismatch');
    if (buffer.subarray(0, 8).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))) throw new UploadError(LEGACY.xls, 415, 'unsupported');
    if (buffer.subarray(0, 2048).includes(0)) throw new UploadError('This does not look like a text CSV file.', 415, 'mime_mismatch');
  } else if (!isZip) throw new UploadError(`This is not a valid .${ext} file (it does not have the expected content).`, 415, 'mime_mismatch');
  return ext;
}

function parseFile(buffer, format) {
  try {
    if (format === 'csv') return { rows: parseCsv(buffer).rows, formulas: [], errorCells: [] };
    if (format === 'xlsx') { const r = readXlsx(buffer); return { rows: r.rows, formulas: r.formulas, errorCells: r.errorCells, sheet: r.sheet }; }
    const r = readDocx(buffer); return { rows: r.rows, formulas: [], errorCells: [] };
  } catch (e) {
    if (e instanceof CsvError || e instanceof XlsxError || e instanceof DocxError) throw new UploadError(e.message, e.code === 'too_large' ? 413 : 422, e.code);
    throw e;
  }
}

// parsed: { rows:[{row,cells}], formulas, errorCells }.
// existing: { byCode: Map(lowerCode -> {id, code, round, status, text_hash}), byHash: Map(`${round}|${hash}` -> {id, code, status}) }
function buildPreview(parsed, existing = { byCode: new Map(), byHash: new Map() }, onConflict = 'skip') {
  const fileErrors = [], warnings = [];
  if (!parsed.rows.length) return { fileErrors: ['The file has no data. Download a template and fill it in.'], warnings, rows: [], summary: summarise([]) };
  const [head, ...body] = parsed.rows;
  const colOf = {}, ignored = [];
  head.cells.forEach((h, i) => {
    const raw = String(h || '').trim();
    if (!raw) return;
    const k = headerKey(raw);
    if (!k) { ignored.push(raw); return; }
    if (k in colOf) fileErrors.push(`The column "${k}" appears twice ("${raw}"). Remove the duplicate column.`);
    else colOf[k] = i;
  });
  const missing = REQUIRED_KEYS.filter(k => !(k in colOf));
  if (missing.length) fileErrors.push(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download a template to see the expected headings.`);
  if (ignored.length) warnings.push(`Ignored unknown column${ignored.length > 1 ? 's' : ''}: ${ignored.join(', ')}.`);
  const formulaRows = new Set((parsed.formulas || []).map(r => parseInt(String(r).replace(/\D/g, ''), 10)));
  const errCellRows = new Set((parsed.errorCells || []).map(r => parseInt(String(r).replace(/\D/g, ''), 10)));
  if (fileErrors.length) return { fileErrors, warnings, rows: [], summary: summarise([]) };

  const out = [];
  const seenCode = new Map(), seenHash = new Map();
  for (const r of body) {
    const raw = {};
    for (const k of Object.keys(colOf)) raw[k] = r.cells[colOf[k]] ?? '';
    const item = { row: r.row, status: 'new', errors: [], warnings: [], data: null, existing: null };
    if (IS_SAMPLE(raw.question_id)) { item.status = 'ignored'; item.warnings.push({ field: 'question_id', message: 'Example row from the template, ignored.' }); out.push(item); continue; }
    if (formulaRows.has(r.row)) item.errors.push({ field: '*', message: 'A cell contains a formula. Formulas are not accepted: paste the values only.' });
    if (errCellRows.has(r.row)) item.errors.push({ field: '*', message: 'A cell contains a spreadsheet error value (e.g. #REF!).' });
    const v = validateQuestion(raw);
    item.errors.push(...v.errors); item.warnings.push(...v.warnings);
    if (item.errors.length) { item.status = 'error'; item.data = v.data; out.push(item); continue; }
    const d = v.data; item.data = d;

    // duplicates inside the file
    const codeKey = d.question_code ? d.question_code.toLowerCase() : null;
    if (codeKey && seenCode.has(codeKey)) { item.status = 'error'; item.errors.push({ field: 'question_id', message: `Question ID "${d.question_code}" is already used on row ${seenCode.get(codeKey)} of this file.` }); out.push(item); continue; }
    const hk = `${d.round}|${d.text_hash}`;
    if (seenHash.has(hk)) { item.status = 'error'; item.errors.push({ field: 'question_text', message: `Duplicate of row ${seenHash.get(hk)} in this file (same question text in the same round).` }); out.push(item); continue; }
    if (codeKey) seenCode.set(codeKey, r.row);
    seenHash.set(hk, r.row);

    // against the existing bank
    const byCode = codeKey ? existing.byCode.get(codeKey) : null;
    const byHash = existing.byHash.get(hk);
    if (byCode) {
      item.existing = { id: byCode.id, code: byCode.code };
      if (byCode.status === 'archived') { item.status = 'error'; item.errors.push({ field: 'question_id', message: `"${byCode.code}" is archived. Restore it from the bank first or use a different ID.` }); }
      else if (byHash && byHash.id !== byCode.id) { item.status = 'error'; item.errors.push({ field: 'question_text', message: `The same wording already exists as ${byHash.code} in round ${d.round}.` }); }
      else if (onConflict === 'update') item.status = 'update';
      else { item.status = 'duplicate'; item.warnings.push({ field: 'question_id', message: `"${byCode.code}" already exists and will be skipped.` }); }
    } else if (byHash) {
      item.existing = { id: byHash.id, code: byHash.code };
      item.status = 'duplicate'; item.warnings.push({ field: 'question_text', message: `Same question text already exists as ${byHash.code} in round ${d.round}; skipped.` });
    }
    out.push(item);
  }
  if (!out.length) fileErrors.push('The file has headings but no questions.');
  return { fileErrors, warnings, rows: out, summary: summarise(out) };
}

function summarise(rows) {
  const s = { total: rows.length, new: 0, update: 0, duplicate: 0, error: 0, ignored: 0 };
  for (const r of rows) s[r.status]++;
  s.importable = s.new + s.update;
  return s;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { UploadError, MAX_BYTES, checkUpload, parseFile, buildPreview, summarise, sha256, COLUMNS };
