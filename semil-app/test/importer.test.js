const test = require('node:test'); const assert = require('node:assert/strict');
const { impParse, impParseCsv } = require('../src/importer');

const HEAD = 'round,type,question,option_a,option_b,option_c,option_d,correct,marks,difficulty\n';

test('parses quoted commas, escaped quotes, line breaks inside quotes and CRLF', () => {
  const p = impParseCsv('a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n');
  assert.deepEqual(p.rows, [['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
  assert.equal(p.unclosed, false);
  assert.equal(impParseCsv('a\n"open').unclosed, true);
});
test('valid questions for every round are accepted and counted', () => {
  const csv = HEAD +
    '1,mcq,"Which HTTP method is idempotent?",POST,PUT,PATCH,CONNECT,B,2,medium\n' +
    '1,multi,"Select all valid duplicate-order defences.","Idempotency key","Client-side button only","Unique constraint","Retry blindly","A;C",3,medium\n' +
    '2,long,"Describe how your team will split the marketplace prototype.",,,,,,10,\n' +
    '3,scenario,"Orders are low with 100 sellers. What do you do first?",,,,,,20,hard\n' +
    '4,upload,"Upload your feature as a ZIP with a README.",,,,,,40,\n' +
    '5,short,"Why do you want this role?",,,,,,5,easy\n';
  const r = impParse(csv, 'q.csv');
  assert.equal(r.fatal, null); assert.equal(r.summary.valid, 6); assert.equal(r.summary.invalid, 0);
  assert.deepEqual(r.summary.byRound, { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1 });
  const mc = r.rows[0].q; assert.equal(mc.k, 'mc'); assert.deepEqual(mc.a, [1]); assert.equal(mc.o.length, 4);
  assert.deepEqual(r.rows[1].q.a, [0, 2]); assert.equal(r.rows[1].q.k, 'ms');
  assert.equal(r.rows[2].q.k, 'la'); assert.equal(r.rows[4].q.k, 'fu'); assert.equal(r.rows[2].q.m, 10);
});
test('bad rows are reported by line number and good rows still import', () => {
  const csv = HEAD +
    '9,mcq,"Round out of range",A,B,,,A,1,\n' +
    '1,essay,"Unknown type here",,,,,,1,\n' +
    '1,mcq,"No correct answer given",A,B,,,,1,\n' +
    '1,mcq,"Two answers on a single choice",A,B,C,,AB,1,\n' +
    '1,multi,"Only one answer on multi",A,B,C,,A,1,\n' +
    '1,mcq,"Correct points to empty option",A,B,,,D,1,\n' +
    '1,mcq,"Gap in options",A,,C,,A,1,\n' +
    '1,short,"Marks are wrong",,,,,,abc,\n' +
    '1,short,"Difficulty is wrong",,,,,,1,extreme\n' +
    '1,short,Hi,,,,,,1,\n' +
    '1,short,"This one is fine",,,,,,2,easy\n';
  const r = impParse(csv, 'q.csv');
  assert.equal(r.summary.valid, 1); assert.equal(r.summary.invalid, 10);
  const lines = r.rows.filter(x => !x.ok).map(x => x.line);
  assert.deepEqual(lines, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(r.rows[0].errors[0], /Round must be 1 to 5/);
  assert.match(r.rows[2].errors[0], /correct answer/i);
  assert.ok(r.rows.at(-1).ok);
});
test('duplicates within one file are flagged, the same text in another round is allowed', () => {
  const csv = HEAD + '1,short,"Explain an index.",,,,,,1,\n1,short,"explain   an index.",,,,,,1,\n2,short,"Explain an index.",,,,,,1,\n';
  const r = impParse(csv, 'q.csv');
  assert.equal(r.rows[1].ok, false); assert.match(r.rows[1].errors[0], /Duplicate of row 2/); assert.ok(r.rows[2].ok);
});
test('file-level problems stop the import with a clear message', () => {
  assert.match(impParse('', 'a.csv').fatal, /empty/i);
  assert.match(impParse('question,type\nA,B\n', 'a.csv').fatal, /Missing column.*round/);
  assert.match(impParse('round,type,question\n1,short,"open', 'a.csv').fatal, /not closed/);
  assert.match(impParse(HEAD, 'a.csv').fatal, /No questions/);
  assert.match(impParse('x'.repeat(1048577), 'a.csv').fatal, /larger than 1 MB/);
  assert.match(impParse('{not json', 'a.json').fatal, /valid JSON/);
  assert.match(impParse('{"a":1}', 'a.json').fatal, /list of questions/);
});
test('row limit is enforced', () => {
  const rows = Array.from({ length: 501 }, (_, i) => `1,short,"Question number ${i} here",,,,,,1,`).join('\n');
  assert.match(impParse(HEAD + rows, 'a.csv').fatal, /limit is 500/);
});
test('JSON import accepts the same fields and an options array', () => {
  const json = JSON.stringify({ questions: [
    { round: 1, type: 'mcq', question: 'Pick the prime number', options: ['4', '6', '7', '9'], correct: 'C', marks: 2 },
    { round: 3, type: 'multi', question: 'Select healthy debugging habits', options: ['Reproduce first', 'Guess', 'Read logs'], correct: ['A', 'C'] },
  ] });
  const r = impParse(json, 'q.json');
  assert.equal(r.summary.valid, 2, JSON.stringify(r.rows.map(x => x.errors)));
  assert.deepEqual(r.rows[0].q.a, [2]); assert.deepEqual(r.rows[1].q.a, [0, 2]); assert.equal(r.rows[1].q.m, 1);
});
test('a spreadsheet-style BOM and padded headers are tolerated', () => {
  const csv = '﻿Round , Type , Question ,option a,option b\n1,mcq,"Pick the larger number",5,9\n';
  const r = impParse(csv, 'x.csv');
  assert.equal(r.fatal, null); assert.equal(r.rows[0].ok, false);   // no correct answer given, but headers were understood
  assert.deepEqual(r.rows[0].q.o, ['5', '9']);
});
