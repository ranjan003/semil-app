'use strict';
// Downloadable sample templates: CSV, XLSX (with drop-downs and an instructions sheet) and DOCX.
const { COLUMNS, SAMPLE_ROWS, ENUMS } = require('./schema');
const { writeCsv } = require('./csv');
const { writeXlsx, colLetter } = require('./xlsx');
const { writeDocx } = require('./docx');

const HEAD = COLUMNS.map(c => c.label);
const MIMES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function instructionRows() {
  return [['Column', 'Required', 'What to enter'], ...COLUMNS.map(c => [c.label, c.required ? 'Yes' : 'No', c.help]),
    ['', '', ''],
    ['Notes', '', 'Rows whose question_id starts with SAMPLE- are examples and are ignored on upload. Delete them or keep them.'],
    ['', '', 'Duplicates (same question text in the same round) are detected and reported before anything is saved. Nothing is imported until you confirm the preview.'],
    ['', '', 'Do not use formulas. Aptitude and technical questions are normal mcq or multi_select questions; use the topic column to categorise them.']];
}

function buildTemplate(format) {
  switch (format) {
    case 'csv': return { body: Buffer.from(writeCsv([HEAD, ...SAMPLE_ROWS]), 'utf8'), mime: MIMES.csv, fileName: 'semil-question-template.csv' };
    case 'xlsx': {
      const at = k => colLetter(HEAD.indexOf(k));
      const dv = (k, list) => ({ sqref: `${at(k)}2:${at(k)}2000`, list });
      return {
        body: writeXlsx([
          { name: 'Questions', rows: [HEAD, ...SAMPLE_ROWS], widths: [14, 60, 14, 22, 22, 22, 22, 18, 40, 11, 16, 8, 20, 8, 15, 10],
            validations: [dv('question_type', ENUMS.question_type), dv('difficulty', ENUMS.difficulty), dv('round', ENUMS.round), dv('status', ENUMS.status)] },
          { name: 'Instructions', rows: instructionRows(), widths: [18, 10, 110] },
        ]),
        mime: MIMES.xlsx, fileName: 'semil-question-template.xlsx',
      };
    }
    case 'docx': return {
      body: writeDocx({
        title: 'Semil question upload template',
        paragraphs: [
          'Keep the table below. Replace the example rows with your questions, one question per row, keeping the headings in the first row.',
          ...COLUMNS.map(c => `${c.label}${c.required ? ' (required)' : ''}: ${c.help}`),
          'Rows whose question_id starts with SAMPLE- are examples and are ignored on upload.',
        ],
        rows: [HEAD, ...SAMPLE_ROWS.map(r => r.map(v => String(v)))],
      }),
      mime: MIMES.docx, fileName: 'semil-question-template.docx',
    };
    default: return null;
  }
}

module.exports = { buildTemplate, MIMES };
