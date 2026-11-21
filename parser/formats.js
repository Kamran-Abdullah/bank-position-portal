'use strict';

const { parseAmount, parseBalanceCell, parseDate, mapColumns, norm } = require('./normalize');

const S = (v) => (v == null ? '' : String(v).trim());
const isDateCell = (v) => !!parseDate(v);

// find first row index whose cells resolve to at least `date` + `balance` columns
function findHeaderRow(rows, { need = ['date', 'balance'], startAt = 0, maxScan = 60 } = {}) {
  const limit = Math.min(rows.length, startAt + maxScan);
  for (let i = startAt; i < limit; i++) {
    const cols = mapColumns((rows[i] || []).map(S));
    if (need.every((k) => cols[k] >= 0)) return { index: i, cols };
  }
  return null;
}

function collectTxns(rows, headerIndex, cols) {
  const out = [];
  let seq = 0;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = (rows[i] || []).map(S);
    if (!r.some((c) => c !== '')) continue;
    const dateRaw = cols.date >= 0 ? r[cols.date] : '';
    const label = norm(r.join(' '));
    if (/closing balance|opening balance|total[s]?\b|brought forward|carried forward|statement of account|page \d+ of/.test(label)
        && !isDateCell(dateRaw)) continue;
    const date = parseDate(dateRaw);
    const bal = cols.balance >= 0 ? parseBalanceCell(r[cols.balance]) : { value: null };
    const debit = cols.debit >= 0 ? parseAmount(r[cols.debit]) : null;
    const credit = cols.credit >= 0 ? parseAmount(r[cols.credit]) : null;
    if (!date && bal.value == null && debit == null && credit == null) continue;
    out.push({
      date,
      valueDate: cols.valueDate >= 0 ? parseDate(r[cols.valueDate]) : null,
      description: cols.description >= 0 ? r[cols.description] : '',
      debit: debit != null ? Math.abs(debit) : 0,
      credit: credit != null ? Math.abs(credit) : 0,
      balance: bal.value,
      seq: seq++,
    });
  }
  return out;
}

// ---------------- Habib Metropolitan Bank : HTML table saved as .xls ----------------
function parseHMB(htmlDoc) {
  const rows = htmlDoc.allRows.map((r) => r.map(S));
  const flatText = norm(rows.map((r) => r.join(' ')).join(' '));
  const res = base('hmb', 'Habib Metropolitan Bank');

  // account number: row labelled "A/C NUMBER" then the next row's first non-empty cell
  for (let i = 0; i < rows.length; i++) {
    if (/^a\/?c\s*(number|no)/i.test(rows[i][0] || '')) {
      for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
        const cand = (rows[j].find((c) => /\d{6,}/.test(c)) || '').replace(/\s+/g, '');
        if (cand) { res.accountNumber = cand; break; }
      }
    }
    if (/branch name/i.test(rows[i].join(' ')) && rows[i + 1]) res.branch = S(rows[i + 1][0]) || res.branch;
  }
  // company / title: the row right under the bank name line
  const bankLine = rows.findIndex((r) => /habib metropolitan bank/i.test(r.join(' ')));
  if (bankLine >= 0 && rows[bankLine + 1]) res.accountTitle = S(rows[bankLine + 1][0]) || null;

  // period: CURRENCY | FROM | TO | PRINTED ON  -> values in the next row
  const perHead = rows.findIndex((r) => /from/i.test(r.join(' ')) && /to/i.test(r.join(' ')) && /print/i.test(r.join(' ')));
  if (perHead >= 0 && rows[perHead + 1]) {
    const vals = rows[perHead + 1];
    res.currency = S(vals[0]) || 'PKR';
    res.periodFrom = parseDate(vals[1]);
    res.periodTo = parseDate(vals[2]);
  }

  const hdr = findHeaderRow(rows, { need: ['date', 'balance'] });
  if (hdr) {
    res.txns = collectTxns(rows, hdr.index, hdr.cols);
  }
  // Opening / Closing balance rows ("Opening Balance:" , amount in next cell or next row)
  res.explicitOpening = labelledAmount(rows, /opening balance/i);
  res.explicitClosing = labelledAmount(rows, /closing balance/i);
  res.fileOrderReliable = true;
  if (res.txns.length) {
    res.explicitClosingDate = res.txns[res.txns.length - 1].date || res.periodTo;
  }
  res.raw = { rowCount: rows.length, headerAt: hdr ? hdr.index : -1, sample: flatText.slice(0, 160) };
  return res;
}

function labelledAmount(rows, re) {
  for (let i = 0; i < rows.length; i++) {
    const idx = rows[i].findIndex((c) => re.test(c || ''));
    if (idx >= 0) {
      for (let j = idx + 1; j < rows[i].length; j++) {
        const a = parseAmount(rows[i][j]);
        if (a != null) return a;
      }
      // amount may sit in the following row
      if (rows[i + 1]) {
        for (const c of rows[i + 1]) { const a = parseAmount(c); if (a != null) return a; }
      }
    }
  }
  return null;
}

// ---------------- Meezan Bank : real .xlsx (sheet AccountSummary) ----------------
function parseMeezan(xlsx) {
  const sheet = xlsx.sheets.find((s) => /accountsummary|account summary/i.test(s.name)) || xlsx.sheets[0];
  const rows = sheet.rows.map((r) => r.map(S));
  const res = base('meezan', 'Meezan Bank');

  const meta = (labelRe) => {
    for (const r of rows) {
      if (labelRe.test(S(r[0]))) {
        for (let j = 1; j < r.length; j++) if (S(r[j])) return S(r[j]);
      }
    }
    return null;
  };
  res.explicitOpening = parseAmount(meta(/opening balance/i));
  res.explicitClosing = parseAmount(meta(/closing balance/i));
  res.periodFrom = parseDate(meta(/from date/i));
  res.periodTo = parseDate(meta(/to date/i));
  res.currency = meta(/^currency$/i) || 'PKR';
  res.branch = meta(/branch name/i);
  const product = meta(/^product$/i);
  const genBy = meta(/generated by/i);
  res.matchHints = { product, generatedBy: genBy };

  const hdr = findHeaderRow(rows, { need: ['date', 'balance'] });
  if (hdr) res.txns = collectTxns(rows, hdr.index, hdr.cols);
  res.fileOrderReliable = true;
  if (res.txns.length) res.explicitClosingDate = res.txns[res.txns.length - 1].date || res.periodTo;
  res.raw = { sheet: sheet.name, headerAt: hdr ? hdr.index : -1, product, generatedBy: genBy };
  return res;
}

// ---------------- Askari Bank : AskariNexCash "Dashboard" .xlsx ----------------
function parseAskari(xlsx) {
  const sheet = xlsx.sheets[0];
  const rows = sheet.rows.map((r) => r.map(S));
  const res = base('askari', 'Askari Bank');

  const hdr = findHeaderRow(rows, { need: ['date', 'balance'] });
  if (!hdr) { res.raw = { note: 'no header row' }; return res; }
  const cols = hdr.cols;
  // account number column (not in the synonym map) — look for a header cell like "Account No."
  const acctCol = (rows[hdr.index] || []).findIndex((c) => /account\s*(no|number)/i.test(c || ''));
  res.txns = collectTxns(rows, hdr.index, cols);
  if (acctCol >= 0) {
    for (let i = hdr.index + 1; i < rows.length; i++) {
      const v = S(rows[i][acctCol]).replace(/\s+/g, '');
      if (/\d{6,}/.test(v)) { res.accountNumber = v; break; }
    }
  }
  // title row 0 often "AskariNexCash Dashboard"
  res.explicitClosing = null;          // this export carries no labelled closing balance
  res.fileOrderReliable = false;       // rows are NOT in chronological order
  res.raw = { sheet: sheet.name, headerAt: hdr.index, rows: res.txns.length, unsorted: true };
  return res;
}

// ---------------- Bank Al Habib : text PDF (vertical token layout) ----------------
function parseBAHL(pdf) {
  const tokens = pdf.pages.join('\n').split('\n').map((t) => t.trim()).filter(Boolean);
  const res = base('bahl', 'Bank Al Habib');
  const joined = tokens.join(' ␟ ');

  const per = joined.match(/From\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+To\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (per) { res.periodFrom = parseDate(per[1]); res.periodTo = parseDate(per[2]); }

  const acct = tokens.find((t) => /^\d{3,4}-\d{3,4}-[X\d]{3,}-\d{2}-\d$/i.test(t));
  if (acct) res.accountNumber = acct;

  const addrIdx = tokens.findIndex((t) => /^address:?$/i.test(t));
  if (addrIdx >= 0 && tokens[addrIdx + 1]) res.accountTitle = tokens[addrIdx + 1];
  if (/pakistani rupees/i.test(joined)) res.currency = 'PKR';

  // Opening Balance: <amount> follows the label
  const oIdx = tokens.findIndex((t) => /^opening balance$/i.test(t));
  if (oIdx >= 0) {
    for (let j = oIdx + 1; j < Math.min(oIdx + 4, tokens.length); j++) {
      const a = parseAmount(tokens[j]); if (a != null) { res.explicitOpening = a; break; }
    }
  }
  // ... <date> <amount> "Closing Balance"  (amount + date precede the label)
  const cIdx = tokens.findIndex((t) => /^closing balance$/i.test(t));
  if (cIdx > 1) {
    const amt = parseAmount(tokens[cIdx - 1]);
    const dt = parseDate(tokens[cIdx - 2]);
    if (amt != null) res.explicitClosing = amt;
    if (dt) res.explicitClosingDate = dt;
  }
  // Transaction rows. A row starts at a date token; the NEXT token may be its value date. A row ends at
  // its last two money tokens: [amount, running balance]. Doc numbers / descriptions are ignored.
  const MONEY = /^-?\d{1,3}(,\d{3})*\.\d{2}$|^-?\d+\.\d{2}$/;
  const DATE_T = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  const oIdx2 = tokens.findIndex((t) => /^opening balance$/i.test(t));
  let cIdx2 = tokens.findIndex((t, i) => i > oIdx2 && /^closing balance$/i.test(t));
  if (cIdx2 < 0) cIdx2 = tokens.length;
  const txns = [];
  let seq = 0;
  let prevBal = res.explicitOpening;
  let cur = null;
  const flush = () => {
    if (cur && cur.money.length >= 2) {
      const balance = cur.money[cur.money.length - 1];
      const amount = cur.money[cur.money.length - 2];
      let debit = 0, credit = 0;
      if (prevBal != null) {
        const delta = Math.round((balance - prevBal) * 100) / 100;
        if (delta < 0) debit = -delta; else if (delta > 0) credit = delta;
        else if (/\bdr\b|debit|withdraw/i.test(cur.desc.join(' '))) debit = amount; else credit = amount;
      } else if (/\bdr\b|debit|withdraw/i.test(cur.desc.join(' '))) debit = amount; else credit = amount;
      txns.push({ date: parseDate(cur.date), valueDate: cur.value ? parseDate(cur.value) : null, description: cur.desc.join(' ').replace(/\s+/g, ' ').slice(0, 200), debit, credit, balance, seq: seq++ });
      prevBal = balance;
    }
    cur = null;
  };
  for (let i = Math.max(0, oIdx2 + 1); i < cIdx2; i++) {
    const t = tokens[i];
    if (DATE_T.test(t)) {
      if (cur && cur.money.length === 0 && cur.desc.length === 0 && !cur.value && i === cur.at + 1) { cur.value = t; continue; }   // value date
      flush();
      cur = { date: t, value: null, money: [], desc: [], at: i };
      continue;
    }
    if (/^totals:?$/i.test(t)) { flush(); break; }
    if (!cur) continue;
    if (MONEY.test(t)) cur.money.push(parseAmount(t)); else cur.desc.push(t);
  }
  flush();
  res.txns = txns;
  res.fileOrderReliable = true;
  if (!res.explicitClosingDate && txns.length) res.explicitClosingDate = txns[txns.length - 1].date || res.periodTo;
  // zero-activity statement: closing = opening
  if (res.explicitClosing == null && !txns.length && res.explicitOpening != null) {
    res.explicitClosing = res.explicitOpening;
    res.explicitClosingDate = res.explicitClosingDate || res.periodTo;
  }
  res.raw = { tokenCount: tokens.length, txns: txns.length, closingLabelIdx: cIdx };
  return res;
}


// ---------------- Askari Bank : "Statement of Account" PDF (both layouts) ----------------
// Opening/closing rows are marked "** Opening Balance **" / "** Closing Balance **". Amounts are plain for
// deposits and carry "DB" for withdrawals; a printed balance may or may not follow each row. The running
// balance is rebuilt from the opening balance and accepted only if it lands exactly on the printed closing.
function parseAskariPdf(pdf) {
  const rows = pdf.linesPerPage.flat().map((r) => r.map(S));
  const res = base('askari', 'Askari Bank');
  const MONEY = /^(-?\d{1,3}(?:,\d{3})*\.\d{2})(?:\s*(DB|CR|DR))?$/i;
  const moneyCells = (r) => r.map((c, i) => ({ c, i, m: MONEY.exec(c) })).filter((x) => x.m);
  const dateOf = (c) => { if (!/\d{1,2}[-\/ ][A-Za-z]{3}[-\/ ]\d{2,4}/.test(c)) return null; return parseDate(c); };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.some((c) => /^account\s*(#|number|no)/i.test(c))) {
      const same = r.find((c) => /^\d{9,}$/.test(c));
      const next = (rows[i + 1] || []).find((c) => /^\d{9,}$/.test(c));
      if (!res.accountNumber) res.accountNumber = same || next || null;
      const first = r[0] || '';
      if (!res.accountTitle && /[A-Za-z]{3}/.test(first) && !/^account\s*(#|number|no)/i.test(first)) res.accountTitle = first;   // "<TITLE>  Account #  <no>"

    }
    const ni = r.findIndex((c) => /^name:?$/i.test(c));
    if (ni >= 0 && r[ni + 1] && !res.accountTitle) res.accountTitle = r[ni + 1];
    
    if (r.some((c) => /^from:?$/i.test(c) || /^from:/i.test(c)) && r.some((c) => /^to\b/i.test(c))) {
      const ds = r.map((c) => parseDate(c.replace(/^(from|to):?\s*/i, ''))).filter(Boolean);
      if (ds.length >= 2) { res.periodFrom = ds[0]; res.periodTo = ds[1]; }
    }
  }
  const oi = rows.findIndex((r) => r.some((c) => /\*\*\s*opening balance\s*\*\*/i.test(c)));
  const ci = rows.findIndex((r) => r.some((c) => /\*\*\s*closing balance\s*\*\*/i.test(c)));
  if (oi >= 0) { const m = moneyCells(rows[oi]); if (m.length) res.explicitOpening = parseAmount(m[m.length - 1].m[1]); }
  if (ci >= 0) {
    const m = moneyCells(rows[ci]);
    if (m.length) res.explicitClosing = parseAmount(m[m.length - 1].m[1]);
    res.explicitClosingDate = rows[ci].map(dateOf).find(Boolean) || null;
  }

  if (oi >= 0 && ci > oi && res.explicitOpening != null) {
    const txns = [];
    let run = res.explicitOpening, seq = 0, curDate = rows[oi].map(dateOf).find(Boolean) || null, lastDesc = '';
    for (let i = oi + 1; i < ci; i++) {
      const r = rows[i];
      if (/total (withdrawals|deposits)|uncollected|available balance/i.test(r.join(' '))) continue;
      const d = r.map(dateOf).find(Boolean);
      if (d) curDate = d;
      const desc = r.filter((c) => /[A-Za-z]/.test(c) && !MONEY.test(c) && !dateOf(c) && !/^(DB|CR|DR)$/i.test(c)).join(' ');
      if (desc) lastDesc = desc;
      const cells = moneyCells(r);
      cells.forEach((x, k) => {
        const flag = x.m[2] ? x.m[2].toUpperCase() : (r[x.i + 1] && /^(DB|DR)$/i.test(r[x.i + 1]) ? 'DB' : null);
        const v = parseAmount(x.m[1]);
        if (v == null) return;
        const rr = (n) => Math.round(n * 100) / 100;
        if (flag === 'DB' || flag === 'DR' || v < 0) { const av = Math.abs(v); run = rr(run - av); txns.push({ date: curDate, description: lastDesc.slice(0, 120), debit: av, credit: 0, balance: run, seq: seq++ }); }
        else if (Math.abs(v - run) < 0.005) { /* a printed running balance, not an amount */ }
        else if (cells.length === 1 || k === 0 || Math.abs(cells[cells.length - 1].m[1] && parseAmount(cells[cells.length - 1].m[1]) - rr(run + v)) < 0.005) { run = rr(run + v); txns.push({ date: curDate, description: lastDesc.slice(0, 120), debit: 0, credit: v, balance: run, seq: seq++ }); }
      });
    }
    if (txns.length && res.explicitClosing != null && Math.abs(txns[txns.length - 1].balance - res.explicitClosing) < 0.005) {
      res.txns = txns;
    } else {
      res.raw = { note: 'running balance did not reach the printed closing balance', reached: txns.length ? txns[txns.length - 1].balance : null };
    }
  }
  res.fileOrderReliable = true;
  res.raw = Object.assign({ rows: rows.length, txns: res.txns.length }, res.raw);
  return res;
}

// ---------------- Bank Al Habib : internet-banking CSV ----------------
// Row 1: "<17-digit account no>,<COMPANY TITLE>"; "Opening Balance,PKR x"; "Closing Balance,PKR y";
// header "Date,Description,Reference Number,Currency,Amount,Cr/Dr,Currency,Balance"; newest first.
function parseBahlCsv(rows) {
  const R = rows.map((r) => r.map(S));
  const res = base('bahl', 'Bank Al Habib');
  const first = R[0] || [];
  if (/^\d{10,}$/.test(first[0] || '')) { res.accountNumber = first[0]; res.accountTitle = first[1] || null; }
  const lab = (re) => { const r = R.find((x) => re.test(x[0] || '')); return r ? parseAmount(r.slice(1).find((c) => parseAmount(c) != null)) : null; };
  res.explicitOpening = lab(/^opening balance/i);
  res.explicitClosing = lab(/^closing balance/i);
  const hi = R.findIndex((r) => /^date$/i.test(r[0] || '') && r.some((c) => /^balance$/i.test(c)));
  if (hi >= 0) {
    const H = R[hi].map((c) => c.toLowerCase());
    const iAmt = H.indexOf('amount'), iCd = H.indexOf('cr/dr'), iBal = H.lastIndexOf('balance');
    let seq = 0;
    for (let i = hi + 1; i < R.length; i++) {
      const r = R[i];
      const date = parseDate(r[0]);
      const bal = parseBalanceCell(r[iBal]).value;
      const amt = parseAmount(r[iAmt]);
      if (!date || bal == null || amt == null) continue;
      const dr = /^dr/i.test(r[iCd] || '');
      res.txns.push({ date, description: r[1] || '', debit: dr ? Math.abs(amt) : 0, credit: dr ? 0 : Math.abs(amt), balance: bal, seq: seq++ });
    }
  }
  res.fileOrderReliable = false;                       // newest first
  if (res.txns.length) res.explicitClosingDate = res.txns.reduce((m, t) => (t.date > m ? t.date : m), res.txns[0].date);
  res.raw = { rows: R.length, txns: res.txns.length, descending: true };
  return res;
}

// ---------------- Bank Al Habib : internet-banking SOA (.xls that is really an HTML table) ----------------
function looksLikeBahlSoa(rows) {
  const h = (rows.find((r) => r.some((c) => /^post date$/i.test(S(c)))) || []).map((c) => norm(S(c)));
  return h.includes('post date') && h.includes('value date') && h.some((x) => x.startsWith('inst')) && !h.some((x) => x.startsWith('account no'));
}
function parseBahlSoa(htmlDoc) {
  const rows = htmlDoc.allRows.map((r) => r.map(S));
  const res = base('bahl', 'Bank Al Habib');
  const hdr = findHeaderRow(rows, { need: ['date', 'balance'] });
  if (hdr) {
    res.txns = collectTxns(rows, hdr.index, hdr.cols);
    // the first line carries only the opening balance
    const first = res.txns[0];
    if (first && !first.date && first.balance != null) { res.explicitOpening = first.balance; res.txns.shift(); }
  }
  res.fileOrderReliable = true;
  if (res.txns.length) res.explicitClosingDate = res.txns[res.txns.length - 1].date;
  res.raw = { rows: rows.length, txns: res.txns.length };
  return res;
}

// ---------------- generic fallbacks ----------------
function parseGenericGrid(rowsOrSheets, kind) {
  const res = base('generic_' + kind, null);
  let bestRows = null, bestHdr = null;
  const sheets = Array.isArray(rowsOrSheets[0]) ? [{ name: kind, rows: rowsOrSheets }] : rowsOrSheets;
  for (const s of sheets) {
    const rows = (s.rows || s).map((r) => r.map(S));
    const hdr = findHeaderRow(rows, { need: ['date', 'balance'] }) || findHeaderRow(rows, { need: ['date', 'credit'] });
    if (hdr) {
      const t = collectTxns(rows, hdr.index, hdr.cols);
      if (!bestHdr || t.length > bestRows) { bestHdr = { rows, hdr }; bestRows = t.length; res.txns = t; }
    }
  }
  const allText = norm(sheets.map((s) => (s.rows || s).map((r) => r.join(' ')).join(' ')).join(' '));
  res.explicitOpening = null;
  res.fileOrderReliable = true;
  if (bestHdr) {
    res.explicitClosing = labelledAmount(bestHdr.rows, /closing balance|closing bal|ending balance/i);
    res.explicitOpening = labelledAmount(bestHdr.rows, /opening balance|opening bal|beginning balance|b\/f/i);
    if (res.txns.length) res.explicitClosingDate = res.txns[res.txns.length - 1].date;
  }
  res.raw = { headerFound: !!bestHdr, sample: allText.slice(0, 160) };
  return res;
}

// ---------------- OCR text (photos / scanned statements) ----------------
// Free-form OCR output — no reliable columns. Pull a best-effort balance + date
// so the reviewer has something to confirm instead of a blank form.
function parseOcrText(ocr) {
  const res = base('ocr', null);
  const lines = ocr.lines || String(ocr.text || '').split(/\r?\n/);
  res.raw = { ocrConfidence: ocr.meanConfidence, textPreview: (ocr.text || '').slice(0, 400), lineCount: lines.length };
  res.ocrText = ocr.text || lines.join('\n');

  const bigText = norm(lines.join(' '));
  if (/habib metropolitan/.test(bigText)) res.bankGuess = 'Habib Metropolitan Bank';
  else if (/bank al habib|al habib/.test(bigText)) res.bankGuess = 'Bank Al Habib';
  else if (/meezan/.test(bigText)) res.bankGuess = 'Meezan Bank';
  else if (/askari/.test(bigText)) res.bankGuess = 'Askari Bank';

  const MONEY_RE = /-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d{4,}(?:\.\d{1,2})?|\d+\.\d{2}/g;
  const moneyOnLine = (s) => (s.match(MONEY_RE) || []).map((x) => parseAmount(x)).filter((n) => n != null && Math.abs(n) >= 1);

  // dates per line (sane window only — drops OCR misreads like "2070")
  const yMax = String(new Date().getFullYear() + 1);
  const DATE_RE = /(\d{1,2}[-\/. ][A-Za-z]{3,9}[-\/. ]\d{2,4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/g;
  const lineDate = lines.map((ln) => {
    let best = null;
    for (const m of ln.match(DATE_RE) || []) {
      const d = parseDate(m);
      if (d && d >= '2015-01-01' && d.slice(0, 4) <= yMax) best = (!best || d > best) ? d : best;
    }
    return best;
  });
  const allDates = lineDate.filter(Boolean);
  const latest = allDates.length ? allDates.slice().sort().slice(-1)[0] : null;
  res.explicitClosingDate = latest;
  res.periodTo = latest;

  const moneyNearLine = (i) => {
    for (let j = i; j <= i + 2 && j < lines.length; j++) {
      const m = moneyOnLine(lines[j]);
      if (m.length) return m[m.length - 1];
    }
    for (let j = i - 1; j >= i - 2 && j >= 0; j--) {
      const m = moneyOnLine(lines[j]);
      if (m.length) return m[m.length - 1];
    }
    return null;
  };

  let candidate = null;
  let method = null;

  // 1) an explicit "closing / ending balance" label (but never "opening balance")
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (/opening\s+bal/.test(l)) continue;
    if (/(closing|ending|end)\s*(available\s*)?bal(ance)?|balance\s*(c\/f|carried\s*forward)/.test(l)) {
      const v = moneyNearLine(i);
      if (v != null) { candidate = v; method = 'ocr_closing_label'; break; }
    }
  }

  // 2) the last (right-most) money value on the row carrying the latest date —
  //    for a statement with a running Balance column this is the closing balance.
  if (candidate == null && latest) {
    const dateRows = [];
    lineDate.forEach((d, i) => { if (d === latest) dateRows.push(i); });
    const i = dateRows.length ? dateRows[dateRows.length - 1] : -1;
    if (i >= 0) {
      const money = [];
      for (let j = i; j <= i + 3 && j < lines.length; j++) {
        if (j > i && lineDate[j]) break;           // stop at the next dated row
        for (const v of moneyOnLine(lines[j])) money.push(v);
      }
      if (money.length) { candidate = money[money.length - 1]; method = 'ocr_latest_date_row'; }
    }
  }

  // 3) otherwise the LAST money value that appears at or after the first "balance" header
  if (candidate == null) {
    let start = lines.findIndex((l) => /\bbalance\b/i.test(l) && !/opening\s+bal/i.test(l));
    if (start < 0) start = 0;
    let last = null;
    for (let i = start; i < lines.length; i++) for (const v of moneyOnLine(lines[i])) last = v;
    if (last != null) { candidate = last; method = 'ocr_last_amount_after_balance'; }
  }

  // 3) fallback: largest money value anywhere
  if (candidate == null) {
    const all = [];
    for (const ln of lines) for (const v of moneyOnLine(ln)) all.push(v);
    if (all.length) { candidate = all.sort((a, b) => Math.abs(b) - Math.abs(a))[0]; method = 'ocr_largest_amount'; }
  }

  // opening balance (for the reviewer's context only)
  for (const ln of lines) {
    if (/opening\s+bal/i.test(ln)) { const m = moneyOnLine(ln); if (m.length) { res.explicitOpening = m[m.length - 1]; break; } }
  }
  res.explicitClosing = candidate;
  res.txns = [];
  res.fileOrderReliable = false;
  res._ocrMethod = method;
  return res;
}

function base(parser, bankGuess) {
  return {
    parser,
    bankGuess,
    accountNumber: null,
    accountTitle: null,
    branch: null,
    currency: 'PKR',
    periodFrom: null,
    periodTo: null,
    explicitOpening: null,
    explicitClosing: null,
    explicitClosingDate: null,
    fileOrderReliable: false,
    matchHints: {},
    txns: [],
    raw: {},
  };
}

module.exports = { parseBahlCsv, parseBahlSoa, looksLikeBahlSoa, parseHMB, parseMeezan, parseAskari, parseAskariPdf, parseBAHL, parseGenericGrid, parseOcrText, findHeaderRow, collectTxns };
