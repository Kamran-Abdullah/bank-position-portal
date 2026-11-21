'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const cheerio = require('cheerio');

// ---------- real .xlsx / .xlsm ----------
async function readXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const arr = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        arr[cell.col - 1] = cellText(cell);
      });
      rows.push(arr);
    });
    sheets.push({ name: ws.name, rows });
  });
  return { sheets };
}

function cellText(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return typeof v.result === 'object' ? '' : String(v.result);
    if (v.formula) return '';
    if (v.hyperlink && v.text) return String(v.text);
    return '';
  }
  return v;
}

// ---------- HTML table saved with an .xls extension ----------
function readHtmlTables(filePath) {
  const html = fs.readFileSync(filePath, 'latin1');
  const $ = cheerio.load(html);
  const tables = [];
  $('table').each((_, t) => {
    const rows = [];
    $(t).find('tr').each((__, tr) => {
      const cells = [];
      $(tr).find('td,th').each((___, td) => {
        cells.push($(td).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim());
      });
      rows.push(cells);
    });
    tables.push(rows);
  });
  // also expose a flat list of all rows (some bank exports use one giant table, others many)
  const allRows = tables.flat();
  return { tables, allRows, text: $('body').text() };
}

function looksLikeHtml(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(512);
  fs.readSync(fd, buf, 0, 512, 0);
  fs.closeSync(fd);
  const head = buf.toString('latin1').toLowerCase();
  return head.includes('<html') || head.includes('<table') || head.includes('<style') || head.includes('<!doctype html');
}

function isZipXlsx(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
}

// ---------- PDF (text layer) with optional password ----------
async function readPdfText(filePath, password) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = pdfjs.getDocument({
    data,
    password: password || undefined,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) {
      const err = new Error(password ? 'PDF password is incorrect.' : 'PDF is password protected.');
      err.code = password ? 'BAD_PASSWORD' : 'NEED_PASSWORD';
      throw err;
    }
    throw e;
  }
  const pages = [];
  const linesPerPage = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => (i.str || '')).join('\n'));
    linesPerPage.push(groupIntoLines(content.items));
  }
  await doc.destroy();
  return { numPages: doc.numPages, pages, linesPerPage };
}

// group text items into visual rows (by y), each row cells sorted by x
function groupIntoLines(items) {
  const rows = [];
  const tol = 3;
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) <= tol);
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.s));
}

let _pdfjs = null;
async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  try {
    _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    _pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  }
  return _pdfjs;
}

// ---------- CSV ----------
function readCsvRows(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

module.exports = {
  readCsvRows,
  readXlsx, readHtmlTables, readPdfText,
  looksLikeHtml, isZipXlsx, cellText,
};
