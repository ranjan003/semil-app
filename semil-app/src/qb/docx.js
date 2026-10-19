'use strict';
// DOCX support: reads the first table of a Word document (header row + one question per row)
// and writes a template document containing such a table.
const { readZip, writeZip, ZipError } = require('./zip');
const { assertSafeXml, decode, escapeXml, XmlError } = require('./xml');

class DocxError extends Error { constructor(m, code = 'bad_docx') { super(m); this.name = 'DocxError'; this.code = code; } }
const MAX_ROWS = 5001, MAX_COLS = 40;

function cellText(xml) {
  const t = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(t).replace(/\n+$/, '').trim();
}

// outermost <w:tbl> blocks, in document order; nested tables are rejected
function topTables(xml) {
  const out = [];
  const re = /<w:tbl>|<\/w:tbl>/g;
  let depth = 0, start = 0, m, nested = false;
  while ((m = re.exec(xml))) {
    if (m[0] === '<w:tbl>') { if (depth === 0) start = m.index + m[0].length; else nested = true; depth++; }
    else { depth--; if (depth === 0) out.push({ xml: xml.slice(start, m.index), nested }), nested = false; if (depth < 0) throw new DocxError('The document is damaged.'); }
  }
  return out;
}

function readDocx(buf) {
  let zip;
  try { zip = readZip(buf); } catch (e) { if (e instanceof ZipError) throw new DocxError(e.message, e.code); throw e; }
  try {
    if (!zip.has('word/document.xml')) throw new DocxError('This is not a Word (.docx) document.');
    if (zip.has('word/vbaProject.bin')) throw new DocxError('Macro-enabled documents are not accepted. Save the file as a plain .docx.', 'unsupported');
    const doc = zip.text('word/document.xml'); assertSafeXml(doc);
    const tables = topTables(doc);
    if (!tables.length) throw new DocxError('No table found. Put the questions in a Word table with the column headings in the first row (download the Word template).');
    const t = tables[0];
    if (t.nested) throw new DocxError('Tables inside tables are not supported.', 'unsupported');
    const rows = [];
    let n = 0;
    for (const rm of t.xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
      n++;
      if (n > MAX_ROWS) throw new DocxError(`The table has more than ${MAX_ROWS - 1} rows. Split it into smaller files.`, 'too_large');
      const cells = [...rm[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(c => cellText(c[1]));
      if (cells.length > MAX_COLS) throw new DocxError('The table has too many columns.', 'too_large');
      if (cells.some(c => c !== '')) rows.push({ row: n, cells });
    }
    return { rows, tableCount: tables.length };
  } catch (e) {
    if (e instanceof XmlError) throw new DocxError(e.message, 'unsupported');
    if (e instanceof ZipError) throw new DocxError(e.message, e.code);
    throw e;
  }
}

// paragraphs: [string] shown above the table; rows: [[...]] with the header first
function writeDocx({ title, paragraphs = [], rows }) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const para = (t, { bold, size } = {}) => `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r></w:p>`;
  const cell = (t, hdr, w) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${hdr ? '<w:shd w:val="clear" w:color="auto" w:fill="1F3A5F"/>' : ''}</w:tcPr>${String(t ?? '').split('\n').map(line => `<w:p><w:r><w:rPr>${hdr ? '<w:b/><w:color w:val="FFFFFF"/>' : ''}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('')}</w:tc>`;
  const w = Math.floor(15000 / rows[0].length);
  const tbl = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="888888"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${rows[0].map(() => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.map((r, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${r.map(c => cell(c, i === 0, w)).join('')}</w:tr>`).join('')}</w:tbl>`;
  const body = `${para(title, { bold: true, size: 32 })}${paragraphs.map(p => para(p)).join('')}${tbl}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>` },
  ]);
}

module.exports = { DocxError, readDocx, writeDocx };
