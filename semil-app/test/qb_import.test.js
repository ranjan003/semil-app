'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkUpload, parseFile, buildPreview, UploadError } = require('../src/qb/importer');
const { buildTemplate } = require('../src/qb/templates');
const { writeCsv, parseCsv } = require('../src/qb/csv');
const { validateQuestion } = require('../src/qb/schema');
const { readZip, writeZip } = require('../src/qb/zip');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures/qb', n));
const run = (n, fmt, existing, onConflict) => buildPreview(parseFile(fx(n), fmt), existing, onConflict);
const empty = () => ({ byCode: new Map(), byHash: new Map() });

test('real Excel file (openpyxl): aliases, letters, rounds, per-row errors', () => {
  const p = run('valid.xlsx', 'xlsx');
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.rows.length, 6);
  assert.deepEqual(p.rows.map(r => r.status), ['new', 'new', 'new', 'error', 'error', 'error']);
  const [a, b, c] = p.rows.map(r => r.data);
  assert.equal(a.type, 'mcq'); assert.equal(a.correct_answer, 1); assert.equal(a.negative_marks, 0.25); assert.equal(a.round, 1);
  assert.equal(b.type, 'multi_select'); assert.deepEqual(b.correct_answer, [0, 2]); assert.equal(b.round, 2); assert.equal(b.question_code, 'EXT-2');
  assert.equal(c.type, 'descriptive'); assert.equal(c.role_code, 'SDE'); assert.equal(c.status, 'inactive'); assert.equal(c.options, null);
  assert.match(p.rows[3].errors[0].message, /Correct answer is required/);
  assert.equal(p.rows[3].row, 5);                      // spreadsheet row numbers, header is row 1
  assert.match(p.rows[4].errors.map(e => e.message).join(), /Marks must be/);
  assert.match(p.rows[5].errors[0].message, /Duplicate of row 2/);
  assert.equal(p.summary.error, 3); assert.equal(p.summary.importable, 3);
});

test('real Word file (python-docx) reads the table', () => {
  const p = run('valid.docx', 'docx');
  assert.deepEqual(p.fileErrors, []);
  assert.deepEqual(p.rows.map(r => r.status), ['new', 'new', 'new']);
  assert.deepEqual(p.rows[1].data.correct_answer, [0, 2]);
});

test('Word file without a table, and a macro-free check', () => {
  assert.throws(() => parseFile(fx('notable.docx'), 'docx'), /No table found/);
});

test('formulas in a spreadsheet are rejected, never evaluated', () => {
  const p = run('formula.xlsx', 'xlsx');
  assert.equal(p.rows[0].status, 'error');
  assert.match(p.rows[0].errors.map(e => e.message).join(), /formula/i);
});

test('zip bomb is stopped by the unpacking limits', () => {
  assert.throws(() => parseFile(fx('bomb.xlsx'), 'xlsx'), e => e instanceof UploadError && /too large/i.test(e.message));
});

test('CSV: Windows-1252 text, BOM, semicolons, quotes, formula prefix from our own export', () => {
  const p = run('win1252.csv', 'csv');
  assert.equal(p.rows[0].data.question_text, 'Café menu: which is a hot drink?');
  assert.equal(p.rows[0].data.options[0], 'Café au lait');
  const semi = Buffer.from('﻿question_text;question_type;option_a;option_b;correct_answer;difficulty;round;topic;marks\r\n"Is ""x"" true?";mcq;Yes;No;A;easy;1;Logic;1\r\n');
  const q = buildPreview(parseFile(semi, 'csv'));
  assert.equal(q.rows[0].data.question_text, 'Is "x" true?');
  const rt = parseCsv(writeCsv([['a'], ['=cmd()'], ['-5'], ['x,"y"\nz']])).rows.map(r => r.cells[0]);
  assert.deepEqual(rt, ['a', "'=cmd()", '-5', 'x,"y"\nz']);
  assert.equal(validateQuestion({ question_text: "'=SUM(A1) is text", question_type: 'descriptive', difficulty: 'easy', round: 1, topic: 'T', marks: 1 }).data.question_text, '=SUM(A1) is text');
});

test('missing columns and unknown columns are reported at file level', () => {
  const p = buildPreview(parseFile(Buffer.from('question_text,foo\r\nHello there,1\r\n'), 'csv'));
  assert.match(p.fileErrors[0], /Missing required columns: question_type, difficulty, round, topic, marks/);
  assert.equal(p.rows.length, 0);
  const d = buildPreview(parseFile(Buffer.from('question_text,question_text\r\nx,y\r\n'), 'csv'));
  assert.match(d.fileErrors.join(), /appears twice/);
});

test('every template downloads, re-imports cleanly (examples ignored) and opens in the parsers', () => {
  for (const f of ['csv', 'xlsx', 'docx']) {
    const t = buildTemplate(f);
    assert.ok(t.body.length > 100 && t.fileName.endsWith('.' + f));
    assert.equal(checkUpload({ buffer: t.body, fileName: t.fileName, mime: t.mime }), f);
    const p = buildPreview(parseFile(t.body, f));
    assert.deepEqual(p.fileErrors, []);
    assert.equal(p.rows.length, 5, f);
    assert.deepEqual([...new Set(p.rows.map(r => r.status))], ['ignored'], f);
  }
});

test('sample rows are individually valid when the SAMPLE- prefix is removed', () => {
  const t = buildTemplate('csv').body.toString('utf8').replace(/SAMPLE-/g, 'OK-');
  const p = buildPreview(parseFile(Buffer.from(t), 'csv'));
  assert.deepEqual(p.rows.map(r => r.status), ['new', 'new', 'new', 'new', 'new']);
  assert.deepEqual(p.rows.map(r => r.data.type), ['mcq', 'multi_select', 'mcq', 'mcq', 'descriptive']);
});

test('duplicates against the existing bank: skip, update, archived and wording clash', () => {
  const first = run('valid.xlsx', 'xlsx');
  const h = first.rows[0].data.text_hash;
  const existing = { byCode: new Map([['ext-2', { id: 'id2', code: 'EXT-2', status: 'active' }]]), byHash: new Map([[`1|${h}`, { id: 'id1', code: 'Q-00001', status: 'active' }]]) };
  const skip = run('valid.xlsx', 'xlsx', existing, 'skip');
  assert.equal(skip.rows[0].status, 'duplicate'); assert.match(skip.rows[0].warnings[0].message, /Q-00001/);
  assert.equal(skip.rows[1].status, 'duplicate');
  const upd = run('valid.xlsx', 'xlsx', existing, 'update');
  assert.equal(upd.rows[1].status, 'update'); assert.equal(upd.rows[1].existing.id, 'id2');
  existing.byCode.set('ext-2', { id: 'id2', code: 'EXT-2', status: 'archived' });
  assert.match(run('valid.xlsx', 'xlsx', existing, 'update').rows[1].errors[0].message, /archived/);
});

test('upload checks: size, extension, MIME, magic bytes, legacy formats', () => {
  const ok = fx('valid.xlsx');
  const mimeX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  assert.equal(checkUpload({ buffer: ok, fileName: 'a.XLSX', mime: mimeX }), 'xlsx');
  const bad = (o, re) => assert.throws(() => checkUpload(o), e => e instanceof UploadError && re.test(e.message), JSON.stringify(Object.keys(o)));
  bad({ buffer: Buffer.alloc(0), fileName: 'a.csv', mime: 'text/csv' }, /empty/);
  bad({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 65), fileName: 'a.csv', mime: 'text/csv' }, /larger than/);
  bad({ buffer: ok, fileName: 'a.exe', mime: 'application/octet-stream' }, /Unsupported file type/);
  bad({ buffer: ok, fileName: 'a.xlsx', mime: 'image/png' }, /does not match/);
  bad({ buffer: Buffer.from('<html>'), fileName: 'a.xlsx', mime: mimeX }, /not a valid \.xlsx/);
  bad({ buffer: ok, fileName: 'a.csv', mime: 'text/csv' }, /Office document/);
  bad({ buffer: ok, fileName: 'a.xls', mime: 'application/vnd.ms-excel' }, /\.xlsx/);
  bad({ buffer: Buffer.from('a,b\0c'), fileName: 'a.csv', mime: 'text/csv' }, /text CSV/);
  assert.throws(() => parseFile(fx('valid.docx'), 'xlsx'), /not an Excel/);
});

test('XML with a DOCTYPE/ENTITY declaration is refused', () => {
  const evil = writeZip([{ name: 'xl/workbook.xml', data: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><workbook/>' }]);
  assert.throws(() => parseFile(evil, 'xlsx'), /unsupported XML/);
});

test('validator edge cases', () => {
  const base = { question_text: 'Pick the odd one out here', question_type: 'mcq', option_a: 'a1', option_b: 'b1', correct_answer: 'A', difficulty: 'easy', round: 1, topic: 'T', marks: 2 };
  const v = o => validateQuestion({ ...base, ...o });
  assert.ok(v({}).ok);
  assert.match(v({ option_c: '', option_d: 'd1' }).errors[0].message, /in order/);
  assert.match(v({ option_b: 'A1' }).errors[0].message, /same text/);
  assert.match(v({ correct_answer: 'C' }).errors[0].message, /does not match/);
  assert.match(v({ correct_answer: 'A,B' }).errors[0].message, /exactly one/);
  assert.match(v({ question_type: 'multi_select', correct_answer: 'A' }).errors[0].message, /two or more/);
  assert.equal(v({ question_type: 'multi_select', option_c: 'c1', correct_answer: 'AC' }).data.correct_answer.join(), '0,2');
  assert.match(v({ negative_marks: 3 }).errors[0].message, /more than the question marks/);
  assert.match(v({ question_type: 'descriptive', option_a: '', option_b: '', correct_answer: '', negative_marks: 1 }).errors[0].message, /negative marks/);
  assert.match(v({ round: 6 }).errors[0].message, /not valid/);
  assert.match(v({ difficulty: 'impossible' }).errors[0].message, /Unknown difficulty/);
  assert.match(v({ job_role: 'bad role!' }).errors[0].message, /role code/);
  assert.equal(v({ job_role: 'data analyst' }).data.role_code, 'DATA_ANALYST');
  assert.equal(v({ question_type: 'Aptitude', topic: '' }).data.topic, 'Aptitude');
  assert.equal(v({ marks: '1,5' }).data.marks, 1.5);
  assert.equal(v({ option_a: 'None of the above', option_b: 'x' }).data.shuffle_options, false);
  assert.match(v({ question_text: 'x'.repeat(2001) }).errors[0].message, /too long/);
  assert.match(v({ status: 'archived' }).errors[0].message, /not valid/);
});

test('duplicate fingerprint ignores case, punctuation and spacing but not real differences', () => {
  const { norm, textHash } = require('../src/qb/schema');
  assert.equal(norm('Aptitude easy question 1: pick'), 'aptitude easy question 1 pick');
  assert.equal(textHash('What is 2+2?', 'mcq'), textHash('  what is 2 + 2 ', 'mcq'));
  assert.notEqual(textHash('Question 1: pick the right option', 'mcq'), textHash('Question 2: pick the right option', 'mcq'));
  assert.notEqual(textHash('Same words', 'mcq'), textHash('Same words', 'descriptive'));
  assert.notEqual(textHash('Café au lait', 'mcq'), textHash('Cafe au lait', 'mcq'));
});
