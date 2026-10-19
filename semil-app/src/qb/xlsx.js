'use strict';
// XLSX reader and writer for the question templates. Reads values only: formulas are never evaluated,
// they are reported so the importer can reject the row.
const { readZip, writeZip, ZipError } = require('./zip');
const { assertSafeXml, decode, escapeXml, attrs, XmlError } = require('./xml');

class XlsxError extends Error { constructor(m, code = 'bad_xlsx') { super(m); this.name = 'XlsxError'; this.code = code; } }

const MAX_ROWS = 5001, MAX_COLS = 40;

function colIndex(ref) {
  const m = /^([A-Z]{1,3})\d*$/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function colLetter(i) { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; }

const unescapeX = s => s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
function textOf(xml) {
  xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const out = [];
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] || '');
  return unescapeX(decode(out.join('')));
}
function resolveTarget(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/'), out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

function readXlsx(buf, { sheetName = 'Questions' } = {}) {
  let zip;
  try { zip = readZip(buf); } catch (e) { if (e instanceof ZipError) throw new XlsxError(e.message, e.code); throw e; }
  try {
    if (!zip.has('xl/workbook.xml')) throw new XlsxError('This is not an Excel (.xlsx) workbook.');
    if (zip.has('xl/vbaProject.bin')) throw new XlsxError('Macro-enabled workbooks are not accepted. Save the file as a plain .xlsx.', 'unsupported');
    const wb = zip.text('xl/workbook.xml'); assertSafeXml(wb);
    const rels = zip.text('xl/_rels/workbook.xml.rels') || ''; assertSafeXml(rels);
    const relTarget = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) { const a = attrs(m[0]); if (a.Id) relTarget[a.Id] = a.Target; }
    const sheets = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const target = relTarget[a['r:id']];
      if (a.name && target) sheets.push({ name: a.name, hidden: a.state === 'hidden' || a.state === 'veryHidden', path: resolveTarget('xl/', target) });
    }
    if (!sheets.length) throw new XlsxError('The workbook has no sheets.');
    const pick = sheets.find(s => s.name.toLowerCase() === sheetName.toLowerCase() && !s.hidden) || sheets.find(s => !s.hidden) || sheets[0];

    const shared = [];
    if (zip.has('xl/sharedStrings.xml')) {
      const ss = zip.text('xl/sharedStrings.xml'); assertSafeXml(ss);
      for (const m of ss.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(m[1] || ''));
    }
    const sx = zip.text(pick.path);
    if (sx === null) throw new XlsxError('The sheet could not be found in the workbook.');
    assertSafeXml(sx);

    const rows = [], formulas = [], errorsCells = [];
    let count = 0;
    for (const rm of sx.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(rm[1]);
      let rowNo = parseInt(ra.r, 10) || (rows.length ? rows[rows.length - 1].row + 1 : 1);
      if (rowNo > MAX_ROWS) {
        if (rm[2] && /<v>|<is>/.test(rm[2])) throw new XlsxError(`The sheet has more than ${MAX_ROWS - 1} rows. Split it into smaller files.`, 'too_large');
        continue;
      }
      const cells = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        let ci = colIndex(ca.r);
        if (ci < 0) ci = cells.length;
        if (ci >= MAX_COLS) { if (cm[2] && /<v>|<is>/.test(cm[2])) throw new XlsxError('The sheet has too many columns.', 'too_large'); continue; }
        const inner = cm[2] || '';
        if (/<f\b/.test(inner)) { formulas.push(`${colLetter(ci)}${rowNo}`); cells[ci] = ''; continue; }
        const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner);
        let val = '';
        switch (ca.t) {
          case 's': val = shared[parseInt(v ? v[1] : '', 10)] ?? ''; break;
          case 'inlineStr': val = textOf(inner); break;
          case 'str': val = v ? unescapeX(decode(v[1])) : ''; break;
          case 'b': val = v && v[1].trim() === '1' ? 'TRUE' : 'FALSE'; break;
          case 'e': errorsCells.push(`${colLetter(ci)}${rowNo}`); val = ''; break;
          default: {
            const raw = v ? v[1].trim() : '';
            val = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw) ? String(Number(raw)) : unescapeX(decode(raw));
          }
        }
        cells[ci] = val;
      }
      const filled = Array.from(cells, c => c === undefined ? '' : c);
      if (filled.some(c => String(c).trim() !== '')) { rows.push({ row: rowNo, cells: filled }); count++; }
    }
    return { sheet: pick.name, rows, formulas, errorCells: errorsCells, rowCount: count };
  } catch (e) {
    if (e instanceof XmlError) throw new XlsxError(e.message, 'unsupported');
    if (e instanceof ZipError) throw new XlsxError(e.message, e.code);
    throw e;
  }
}

// sheets: [{ name, rows: [[...]], widths?: [n], validations?: [{ sqref, list: [..] }], header?: true, wrapCols?: [i] }]
function writeXlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const files = [];
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  // style 0 plain, 1 header (bold white on dark), 2 wrapped text, 3 text (kept as text)
  files.push({ name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
  sheets.forEach((s, si) => {
    const rowsXml = s.rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = `${colLetter(ci)}${ri + 1}`;
        const style = s.header !== false && ri === 0 ? 1 : 2;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const cols = (s.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const dv = (s.validations || []).map(v => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Not allowed" error="Pick a value from the list." sqref="${v.sqref}"><formula1>"${escapeXml(v.list.join(','))}"</formula1></dataValidation>`).join('');
    const freeze = s.header !== false ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rowsXml}</sheetData>${dv ? `<dataValidations count="${(s.validations || []).length}">${dv}</dataValidations>` : ''}</worksheet>` });
  });
  return writeZip(files);
}

module.exports = { XlsxError, readXlsx, writeXlsx, colLetter, MAX_ROWS };
