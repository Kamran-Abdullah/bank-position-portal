'use strict';

const path = require('path');
const { readXlsx, readHtmlTables, readPdfText, readCsvRows, looksLikeHtml, isZipXlsx } = require('./readers');
const { parseHMB, parseMeezan, parseAskari, parseAskariPdf, parseBAHL, parseBahlCsv, parseBahlSoa, looksLikeBahlSoa, parseGenericGrid, parseOcrText } = require('./formats');
const { ocrImage } = require('./ocr');
const { parsePhoto } = require('./photo');
const { decideBalance, endOfDayBalances } = require('./balance');
const { norm } = require('./normalize');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'];

/**
 * @param {Object} o
 *  - filePath, originalName
 *  - expected: { bankName, bankParserKey, accountNumber, matchHints }
 *  - password: optional PDF password
 *  - confidenceThreshold: 0..1 (default 0.75)
 * @returns {Object} result
 */
async function processStatement(o) {
  const { filePath, originalName } = o;
  const expected = o.expected || {};
  const threshold = o.confidenceThreshold != null ? Number(o.confidenceThreshold) : 0.75;
  const ext = path.extname(originalName || filePath).toLowerCase();

  const result = {
    status: 'error',
    parser: null,
    method: null,
    fileType: ext.replace('.', '') || 'unknown',
    bankGuess: null,
    accountNumber: null,
    accountTitle: null,
    branch: null,
    currency: null,
    periodFrom: null,
    periodTo: null,
    openingBalance: null,
    closingBalanceReported: null,
    latestStatementDate: null,
    extractedBalance: null,
    confidence: 0,
    txnCount: 0,
    pageCount: null,
    warnings: [],
    error: null,
    checks: {},
  };

  let parsed;
  try {
    if (IMAGE_EXT.includes(ext)) {
      // 1) column-aware reader with arithmetic verification (screen photos of a ledger)
      let photo = null;
      try {
        photo = await Promise.race([parsePhoto(filePath), new Promise((_, rej) => setTimeout(() => rej(new Error('photo reader timed out')), 240000))]);
      } catch (e) { result.warnings.push('Column reader failed: ' + (e.message || e)); }
      if (photo && photo.ok && photo.balances.length) return finishPhoto(result, photo, expected);
      // 2) fall back to plain-text OCR heuristics
      let ocr;
      try {
        ocr = await ocrImage(filePath);
      } catch (e) {
        result.status = 'review';
        result.parser = 'image_ocr';
        result.error = 'OCR failed: ' + (e.message || String(e));
        result.warnings.push('The image could not be read by OCR — enter the balance manually.');
        return result;
      }
      parsed = parseOcrText(ocr);
      // OCR of a photo is never trustworthy enough to auto-post — force a human check
      const dec = decideBalance({
        txns: [], explicitClosing: parsed.explicitClosing, explicitClosingDate: parsed.explicitClosingDate,
        explicitOpening: null, fileOrderReliable: false, periodTo: parsed.periodTo,
      });
      result.parser = 'image_ocr';
      result.method = parsed._ocrMethod || dec.method;
      result.bankGuess = parsed.bankGuess;
      result.latestStatementDate = parsed.explicitClosingDate;
      result.extractedBalance = parsed.explicitClosing != null ? Math.abs(parsed.explicitClosing) : null;
      result.closingBalanceReported = result.extractedBalance;
      result.currency = 'PKR';
      result.confidence = Math.min(0.5, Math.max(0.1, (ocr.meanConfidence || 0.3) * 0.6));
      result.ocrText = parsed.ocrText;
      result.checks = { ocrMeanConfidence: Math.round((ocr.meanConfidence || 0) * 100) / 100 };
      const how = {
        ocr_closing_label: 'found a "closing balance" label',
        ocr_latest_date_row: 'took the balance on the last row of the most recent date',
        ocr_last_amount_after_balance: 'took the last amount under the balance column',
        ocr_largest_amount: 'used the largest amount on the image',
      }[parsed._ocrMethod] || 'best guess';
      result.warnings.push(
        result.extractedBalance != null
          ? `Read from a photo by OCR (${how}). OCR is not exact — check this figure against the image and confirm or correct it.`
          : 'OCR could not find a balance figure on the image. Open the image and enter the balance manually.'
      );
      // verify bank if OCR picked one up
      const v = verifyAgainstExpected(parsed, expected);
      result.warnings.push(...v.warnings);
      if (v.hardMismatch) result.mismatch = true;
      result.status = 'review';
      return result;
    }

    const isPdf = ext === '.pdf' || (!ext && looksLikeHtml(filePath) === false && !isZipXlsx(filePath));
    if (ext === '.pdf') {
      let pdf;
      try {
        pdf = await readPdfText(filePath, o.password);
      } catch (e) {
        if (e.code === 'NEED_PASSWORD' || e.code === 'BAD_PASSWORD') {
          result.status = 'need_password';
          result.error = e.message;
          return result;
        }
        throw e;
      }
      result.pageCount = pdf.numPages;
      const fullText = norm(pdf.pages.join(' '));
      const textLen = pdf.pages.join('').replace(/\s/g, '').length;
      if (textLen < 40) {
        result.status = 'review';
        result.parser = 'pdf_scanned';
        result.warnings.push('This PDF has no readable text layer (likely scanned). OCR is not enabled in this build — enter the balance manually via Review.');
        return result;
      }
      if (/closing balance/.test(fullText) && /opening balance/.test(fullText) && /particulars/.test(fullText) && (/askari|akbl/.test(fullText) || expected.bankParserKey === 'askari')) {
        parsed = parseAskariPdf(pdf);
      } else if (expected.bankParserKey === 'bahl' || /bank al habib/.test(fullText)) {
        parsed = parseBAHL(pdf);
      } else {
        const rows = pdf.linesPerPage.flat();
        parsed = parseGenericGrid(rows, 'pdf');
      }
    } else if (ext === '.xlsx' || ext === '.xlsm' || isZipXlsx(filePath)) {
      const xlsx = await readXlsx(filePath);
      parsed = pickXlsxParser(xlsx, expected);
    } else if (ext === '.csv') {
      const rows = readCsvRows(filePath);
      parsed = /^\d{10,}$/.test(String((rows[0] || [])[0] || '').trim()) && rows.some((r) => /^opening balance/i.test(String(r[0] || ''))) ? parseBahlCsv(rows) : parseGenericGrid(rows, 'csv');
      if (!parsed.txns.length) {
        result.status = 'review';
        result.parser = 'csv';
        result.warnings.push('This CSV does not look like a bank statement (no date + balance columns found). Open it and enter the balance manually, or send a sample so a reader can be added.');
        return result;
      }
    } else if (ext === '.xls' && looksLikeHtml(filePath)) {
      const htmlDoc = readHtmlTables(filePath);
      const t = norm(htmlDoc.text);
      if (looksLikeBahlSoa(htmlDoc.allRows)) {
        parsed = parseBahlSoa(htmlDoc);
      } else if (expected.bankParserKey === 'hmb' || /habib metropolitan bank/.test(t)) {
        parsed = parseHMB(htmlDoc);
      } else {
        parsed = parseGenericGrid(htmlDoc.allRows, 'html');
      }
    } else if (ext === '.xls') {
      result.status = 'review';
      result.parser = 'xls_binary';
      result.warnings.push('Legacy binary .xls is not supported. Re-save the statement as .xlsx (or export as PDF) and upload again.');
      return result;
    } else if (looksLikeHtml(filePath)) {
      const htmlDoc = readHtmlTables(filePath);
      parsed = parseGenericGrid(htmlDoc.allRows, 'html');
    } else {
      result.status = 'error';
      result.error = `Unsupported file type: ${ext || 'unknown'}`;
      return result;
    }
  } catch (e) {
    result.status = 'error';
    result.error = 'Could not read the file: ' + (e.message || String(e));
    return result;
  }

  if (!parsed.accountNumber) { const m = String(originalName || '').match(/(?:^|[^0-9])(\d{12,20})(?:[^0-9]|$)/); if (m) parsed.accountNumber = m[1]; }
  result.parser = parsed.parser;
  result.bankGuess = parsed.bankGuess;
  result.accountNumber = parsed.accountNumber;
  result.accountTitle = parsed.accountTitle;
  result.branch = parsed.branch;
  result.currency = parsed.currency;
  result.periodFrom = parsed.periodFrom;
  result.periodTo = parsed.periodTo;
  result.openingBalance = parsed.explicitOpening;
  result.closingBalanceReported = parsed.explicitClosing;
  result.txnCount = parsed.txns.length;
  result.txnList = parsed.txns.map((t) => ({ date: t.date, description: t.description || '', debit: t.debit || 0, credit: t.credit || 0, balance: t.balance }));   // used to match unpresented cheques + cashflow tagging
  result.matchHints = parsed.matchHints || {};

  const decision = decideBalance({
    txns: parsed.txns,
    explicitClosing: parsed.explicitClosing,
    explicitClosingDate: parsed.explicitClosingDate,
    explicitOpening: parsed.explicitOpening,
    fileOrderReliable: parsed.fileOrderReliable,
    periodTo: parsed.periodTo,
  });
  result.method = decision.method;
  result.latestStatementDate = decision.latestDate;
  result.extractedBalance = decision.balance;
  result.confidence = decision.confidence;
  result.checks = decision.checks;
  result.warnings.push(...decision.warnings);

  // ---- end-of-day balance for every date in the statement ----
  if (decision.ok) {
    const eod = endOfDayBalances(parsed.txns, parsed.fileOrderReliable, decision.latestDate, decision.balance);
    const days = eod.days.map((d) => ({ ...d }));
    // days before the first transaction carry the opening balance
    const first = days.length ? days[0].date : null;
    if (parsed.explicitOpening != null && parsed.periodFrom && first && parsed.periodFrom < first) {
      const pre = [];
      for (let d = new Date(parsed.periodFrom + 'T00:00:00Z'); d.toISOString().slice(0, 10) < first; d.setUTCDate(d.getUTCDate() + 1)) {
        pre.push({ date: d.toISOString().slice(0, 10), balance: parsed.explicitOpening, opening: true });
        if (pre.length > 400) break;
      }
      days.unshift(...pre);
    }
    result.dailyBalances = days;
    if (eod.skipped.length) result.warnings.push(`Could not determine the end-of-day balance for ${eod.skipped.length} date(s) (${eod.skipped.slice(0, 3).join(', ')}${eod.skipped.length > 3 ? '…' : ''}); those days carry forward.`);
  }

  // ---- verification against the account the upload was launched from ----
  const verify = verifyAgainstExpected(parsed, expected);
  result.warnings.push(...verify.warnings);
  if (verify.hardMismatch) {
    result.status = 'review';
    result.confidence = Math.min(result.confidence, 0.4);
    result.mismatch = true;
    return result;
  }
  result.confidence = Math.max(0, result.confidence - verify.penalty);

  if (!decision.ok || result.extractedBalance == null) {
    result.status = 'review';
  } else if (result.confidence >= threshold && result.warnings.length === 0) {
    result.status = 'processed';
  } else if (result.confidence >= threshold) {
    result.status = 'processed';        // extracted with warnings, still above bar
  } else {
    result.status = 'review';
  }
  return result;
}

function finishPhoto(result, photo, expected) {
  const bal = photo.balances;                       // top -> bottom = oldest -> newest
  const last = bal[bal.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (iso) => Math.round((new Date(today) - new Date(iso)) / 86400000);
  const byDate = new Map();
  bal.forEach((b) => { if (b.date) byDate.set(b.date, b); });          // later rows overwrite: last balance of the day
  const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, b]) => ({ date, balance: b.value, verified: b.verified }));
  const datedAll = bal.filter((b) => b.date);
  const problems = [];
  if (!last.verified) problems.push('the latest balance could not be verified against the debit/credit amounts');
  if (!last.date) problems.push('the date of the latest balance could not be read');
  else if (last.dateConf !== 'read') problems.push('the date of the latest balance is uncertain');
  else if (daysAgo(last.date) > 60 || daysAgo(last.date) < -1) problems.push('the date read from the photo is far from today');
  if (datedAll.some((b) => !b.verified)) problems.push('some day balances could not be verified');
  const verifiedCount = bal.filter((b) => b.verified).length;

  result.parser = 'photo';
  result.method = problems.length ? 'photo_unverified' : 'photo_verified';
  result.currency = 'PKR';
  result.latestStatementDate = last.date || (days.length ? days[days.length - 1].date : null);
  result.extractedBalance = last.value;
  result.closingBalanceReported = null;
  result.txnCount = 0;
  result.checks = { photoBalances: bal.length, verified: verifiedCount, orientation: photo.orientation, repaired: photo.repaired || 0 };
  result.photoRows = bal.map((b) => ({ date: b.date, value: b.value, verified: b.verified, dateConf: b.dateConf, completed: b.completed }));
  result.dailyBalances = days;
  const v = verifyAgainstExpected({ parser: 'photo', bankGuess: null, matchHints: {} }, expected);
  if (!problems.length) {
    result.status = 'processed';
    result.confidence = 0.93;
    result.warnings.push(`Read from a photo: ${verifiedCount} balance(s) checked against the debit/credit amounts (each balance = previous balance + credits - debits).`);
  } else {
    result.status = 'review';
    result.confidence = Math.min(0.6, 0.2 + 0.1 * verifiedCount);
    result.warnings.push('Read from a photo — please confirm before posting: ' + problems.join('; ') + '. Amounts and dates below are pre-filled; correct any that are wrong.');
  }
  return result;
}

function pickXlsxParser(xlsx, expected) {
  const names = xlsx.sheets.map((s) => norm(s.name)).join(' ');
  const text = norm(xlsx.sheets.map((s) => s.rows.slice(0, 6).map((r) => r.join(' ')).join(' ')).join(' '));
  if (expected.bankParserKey === 'meezan') return parseMeezan(xlsx);
  if (expected.bankParserKey === 'askari') return parseAskari(xlsx);
  if (/askarinexcash|askari bank/.test(text)) return parseAskari(xlsx);
  if (/accountsummary/.test(names) || /meezan/.test(text)) return parseMeezan(xlsx);
  return parseGenericGrid(xlsx.sheets, 'xlsx');
}

function verifyAgainstExpected(parsed, expected) {
  const warnings = [];
  let penalty = 0;
  let hardMismatch = false;

  // 1) canonical bank identity from the format that actually parsed the file.
  // This is reliable for the four known banks and avoids name-string collisions
  // (e.g. "Habib Metropolitan Bank" vs "Bank Al Habib" both contain "Habib").
  const KNOWN = { hmb: 'Habib Metropolitan Bank', bahl: 'Bank Al Habib', askari: 'Askari Bank', meezan: 'Meezan Bank' };
  const detectedKey = KNOWN[parsed.parser] ? parsed.parser : null;
  const expectedKey = KNOWN[expected.bankParserKey] ? expected.bankParserKey : null;
  if (detectedKey && expectedKey && detectedKey !== expectedKey) {
    warnings.push(`Statement is a ${KNOWN[detectedKey]} statement but was uploaded against ${KNOWN[expectedKey]}.`);
    hardMismatch = true;
  } else if (!hardMismatch && expected.bankName && parsed.bankGuess && !(detectedKey && expectedKey)) {
    // 2) fall back to a name-token check only when we can't compare canonical keys
    const STOP = new Set(['bank', 'limited', 'ltd', 'pvt', 'private', 'co', 'company', 'the', 'of', 'plc', 'inc', 'al']);
    const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
    const a = toks(expected.bankName), b = toks(parsed.bankGuess);
    const overlap = [...a].some((w) => b.has(w));
    if (a.size && b.size && !overlap) {
      warnings.push(`Statement looks like "${parsed.bankGuess}" but was uploaded against "${expected.bankName}".`);
      hardMismatch = true;
    }
  }

  const digits = (s) => String(s || '').replace(/\D/g, '');
  const ea = digits(expected.accountNumber);
  const rawParsed = String(parsed.accountNumber || '');
  const pa = digits(rawParsed);
  if (ea && pa && /x/i.test(rawParsed)) {
    // masked number (e.g. 0000-0000-XXXXXX-00-0): compare only the visible positions
    const m = rawParsed.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (m.length === ea.length) {
      const ok = [...m].every((ch, i) => ch === 'X' || ch === ea[i]);
      if (!ok) { warnings.push(`Account number in file (${parsed.accountNumber}) does not match the configured account (${expected.accountNumber}).`); hardMismatch = true; }
    }
  } else if (ea && pa) {
    const tail = (x) => x.slice(-Math.min(6, x.length));
    if (!(ea.includes(pa) || pa.includes(ea) || tail(ea) === tail(pa))) {
      warnings.push(`Account number in file (${parsed.accountNumber}) does not match the configured account (${expected.accountNumber}).`);
      hardMismatch = true;
    }
  } else if (!pa && parsed.parser === 'meezan' && expected.matchHints && expected.matchHints.generatedBy && parsed.matchHints.generatedBy) {
    if (norm(expected.matchHints.generatedBy) !== norm(parsed.matchHints.generatedBy)) {
      warnings.push(`Meezan "Generated By" code ${parsed.matchHints.generatedBy} does not match the configured hint ${expected.matchHints.generatedBy}.`);
      penalty += 0.15;
    }
  } else if (!pa && !parsed.accountTitle) {
    // nothing to cross-check; small penalty so it leans toward a glance
    penalty += 0.05;
  }
  return { warnings, penalty, hardMismatch };
}

module.exports = { processStatement };
