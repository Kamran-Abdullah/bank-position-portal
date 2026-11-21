'use strict';

// ---------- number parsing ----------
function parseAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^[-–—.\s]*$/.test(s)) return null;           // "-", "–", "." placeholders
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const up = s.toUpperCase();
  if (/\bDR\b|DEBIT/.test(up)) neg = neg || false;   // sign handled by caller; keep magnitude
  s = s.replace(/\b(CR|DR)\b/gi, '').replace(/PKR|RS\.?|USD|EUR|GBP/gi, '');
  s = s.replace(/[,\s ']/g, '');
  s = s.replace(/[–—]/g, '-');
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// balance cell may carry an explicit CR/DR marker → returns {value, marker}
function parseBalanceCell(raw) {
  if (raw == null) return { value: null, marker: null };
  const s = String(raw).trim();
  const up = s.toUpperCase();
  let marker = null;
  if (/\bCR\b/.test(up)) marker = 'CR';
  else if (/\bDR\b/.test(up)) marker = 'DR';
  const mag = parseAmount(s.replace(/\b(CR|DR)\b/gi, ''));
  if (mag == null) return { value: null, marker };
  return { value: marker === 'DR' ? -Math.abs(mag) : Math.abs(mag), marker };
}

// ---------- date parsing ----------
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

// Returns 'YYYY-MM-DD' or null. dayFirst controls ambiguous d/m vs m/d.
function parseDate(raw, opts = {}) {
  if (raw == null) return null;
  if (raw instanceof Date && !isNaN(raw)) return toISO(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate());
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const dayFirst = opts.dayFirst !== false; // default day-first (PK banks)

  let m;
  // 31-Aug-2026 / 31 Aug 2026 / 31/Aug/26  (also Aug-31-2026)
  m = s.match(/^(\d{1,2})[\s\-\/.]([A-Za-z]{3,9})[\s\-\/.](\d{2,4})$/);
  if (m) return fromParts(+m[1], monthNum(m[2]), +m[3]);
  m = s.match(/^([A-Za-z]{3,9})[\s\-\/.](\d{1,2})[\s\-\/.](\d{2,4})$/);
  if (m) return fromParts(+m[2], monthNum(m[1]), +m[3]);

  // 2026-08-31 / 2026/08/31
  m = s.match(/^(\d{4})[\-\/.](\d{1,2})[\-\/.](\d{1,2})$/);
  if (m) return fromParts(+m[3], +m[2] - 1, +m[1]);

  // 31/08/2026 or 08/31/2026 or 31-8-26
  m = s.match(/^(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2];
    let dd, mm;
    if (a > 12 && b <= 12) { dd = a; mm = b; }
    else if (b > 12 && a <= 12) { dd = b; mm = a; }
    else { if (dayFirst) { dd = a; mm = b; } else { dd = b; mm = a; } }
    return fromParts(dd, mm - 1, +m[3]);
  }

  // 31 August 2026 handled by first regex (month 3-9 letters). 20260831
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return fromParts(+m[3], +m[2] - 1, +m[1]);

  const d = new Date(s);
  if (!isNaN(d)) return toISO(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

function monthNum(str) {
  return MONTHS[String(str).toLowerCase().slice(0, 4)] ?? MONTHS[String(str).toLowerCase().slice(0, 3)];
}
function fromParts(dd, mm, yy) {
  if (mm == null || isNaN(mm)) return null;
  if (yy < 100) yy += yy >= 70 ? 1900 : 2000;
  if (dd < 1 || dd > 31 || mm < 0 || mm > 11) return null;
  return toISO(yy, mm, dd);
}
function toISO(y, m0, d) {
  const dt = new Date(Date.UTC(y, m0, d));
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------- header synonym matching ----------
const SYN = {
  date: ['transaction date', 'tran date', 'txn date', 'value date', 'posting date', 'post date', 'booking date',
    'effective date', 'date', 'trn date', 'entry date'],
  valueDate: ['value date', 'val date', 'value dt'],
  description: ['description', 'details', 'narration', 'particulars', 'transaction description', 'remarks', 'transaction details'],
  debit: ['debit', 'dr', 'withdrawal', 'withdrawals', 'withdrawl', 'paid out', 'dr amount', 'debit amount', 'withdraw', 'payments'],
  credit: ['credit', 'cr', 'deposit', 'deposits', 'paid in', 'cr amount', 'credit amount', 'receipts'],
  balance: ['balance', 'closing balance', 'available balance', 'running balance', 'ledger balance', 'current balance',
    'closing available balance', 'balance (pkr)', 'running bal', 'available bal', 'book balance', 'balance amount', 'bal'],
  docno: ['doc no', 'document no', 'instrument no', 'cheque no', 'chq no', 'reference', 'ref no', 'inst no', 'instrument/doc no'],
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// score how well a header string matches a field key
function fieldScore(headerText, key) {
  const h = norm(headerText);
  if (!h) return 0;
  let best = 0;
  for (const syn of SYN[key]) {
    if (h === syn) best = Math.max(best, 100);
    else if (h.replace(/\s/g, '') === syn.replace(/\s/g, '')) best = Math.max(best, 95);
    else if (h.startsWith(syn + ' ') || h.endsWith(' ' + syn)) best = Math.max(best, 80);
    else if (h.includes(syn)) best = Math.max(best, 60);
  }
  return best;
}

// given an array of header cells, return {date, description, debit, credit, balance, docno} -> column index or -1
function mapColumns(headerCells) {
  const keys = ['date', 'description', 'debit', 'credit', 'balance', 'docno', 'valueDate'];
  const result = {};
  const used = new Set();
  // greedy: for each key take the highest-scoring unused column above threshold
  for (const key of keys) {
    let bestIdx = -1, bestScore = 40;
    headerCells.forEach((cell, idx) => {
      if (used.has(idx)) return;
      const sc = fieldScore(cell, key === 'valueDate' ? 'valueDate' : key);
      if (sc > bestScore) { bestScore = sc; bestIdx = idx; }
    });
    result[key] = bestIdx;
    if (bestIdx >= 0) used.add(bestIdx);
  }
  // if both date and valueDate resolved to same, keep date
  return result;
}

module.exports = {
  parseAmount, parseBalanceCell, parseDate, mapColumns, fieldScore, norm, SYN,
};
