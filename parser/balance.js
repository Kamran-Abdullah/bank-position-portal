'use strict';

const EPS = 0.02;
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= EPS;

/**
 * Decide the reporting balance from normalized statement data.
 *
 * @param {Object} input
 *  - txns: [{date:'YYYY-MM-DD'|null, debit:Number, credit:Number, balance:Number|null, seq:Number}]
 *  - explicitClosing: Number|null   (labelled "Closing Balance")
 *  - explicitClosingDate: 'YYYY-MM-DD'|null
 *  - explicitOpening: Number|null
 *  - fileOrderReliable: Boolean      (rows are in true chronological order in the file)
 *  - periodTo: 'YYYY-MM-DD'|null
 * @returns {Object} { ok, balance, latestDate, method, confidence, warnings, checks }
 */
function decideBalance(input) {
  const {
    txns = [], explicitClosing = null, explicitClosingDate = null,
    explicitOpening = null, fileOrderReliable = false, periodTo = null,
  } = input;

  const warnings = [];
  const checks = {};
  const withDates = txns.filter((t) => t.date);
  const latestDate = withDates.length
    ? withDates.reduce((mx, t) => (t.date > mx ? t.date : mx), withDates[0].date)
    : (explicitClosingDate || periodTo || null);

  // ----- running-balance chain reconstruction -----
  const chain = reconstructChain(txns);
  if (chain.terminal) checks.chainTerminalBalance = round2(chain.terminal.balance);
  checks.chainUnique = chain.unique;

  // last row of latest date, by file order (only trustworthy if fileOrderReliable)
  let lastRowLatest = null;
  if (latestDate) {
    const onLatest = txns.filter((t) => t.date === latestDate && t.balance != null);
    if (onLatest.length) lastRowLatest = onLatest[onLatest.length - 1];
  }
  const lastRowAny = [...txns].reverse().find((t) => t.balance != null) || null;

  // arithmetic validation: opening + credits - debits == closing
  const sumCr = round2(txns.reduce((s, t) => s + (t.credit || 0), 0));
  const sumDr = round2(txns.reduce((s, t) => s + (t.debit || 0), 0));
  checks.sumCredit = sumCr;
  checks.sumDebit = sumDr;
  let arithClosing = null;
  if (explicitOpening != null) {
    arithClosing = round2(explicitOpening + sumCr - sumDr);
    checks.openingPlusFlows = arithClosing;
  }

  const candidates = [];
  if (explicitClosing != null) candidates.push({ v: round2(explicitClosing), src: 'explicit_closing', w: 1.0 });
  if (chain.unique && chain.terminal && chain.terminal.balance != null)
    candidates.push({ v: round2(chain.terminal.balance), src: 'chain_terminal', w: 0.9 });
  if (fileOrderReliable && lastRowLatest && lastRowLatest.balance != null)
    candidates.push({ v: round2(lastRowLatest.balance), src: 'last_row_latest_date', w: 0.8 });
  if (arithClosing != null) candidates.push({ v: arithClosing, src: 'opening_plus_flows', w: 0.7 });
  if (fileOrderReliable && lastRowAny && lastRowAny.balance != null)
    candidates.push({ v: round2(lastRowAny.balance), src: 'last_row_file', w: 0.5 });

  if (!candidates.length && chain.terminal && chain.terminals && chain.terminals.length > 1 && latestDate) {
    const onLatest = chain.terminals.filter((t) => t.raw.date === latestDate).map((t) => round2(t.balance));
    const uniq = [...new Set(onLatest)];
    if (uniq.length) {
      warnings.push(`The file has gaps, so the closing balance on ${latestDate} is ambiguous. Possible values: ${uniq.map(fmt).join(' or ')}. Check against the bank.`);
      return { ok: true, balance: round2(chain.terminal.balance), latestDate, method: 'chain_ambiguous', confidence: 0.35, warnings, checks, candidates: [] };
    }
  }
  if (!candidates.length) {
    return {
      ok: false, balance: null, latestDate, method: 'none', confidence: 0,
      warnings: ['No balance could be located in the statement.'], checks,
    };
  }

  // pick the highest-weight candidate, then measure agreement
  candidates.sort((a, b) => b.w - a.w);
  const primary = candidates[0];
  const agree = candidates.filter((c) => near(c.v, primary.v));
  const disagree = candidates.filter((c) => !near(c.v, primary.v));

  // Strong corroboration: an explicit labelled closing balance AND a unique
  // running-balance chain terminal that point at the same number. That pair is
  // authoritative — a disagreeing opening+flows figure then only means some
  // debit/credit cell was misread, not that the closing balance is wrong.
  const explicitAgreesWithChain = chain.unique && chain.terminal &&
    explicitClosing != null && near(round2(chain.terminal.balance), round2(explicitClosing)) &&
    near(primary.v, round2(explicitClosing));

  let confidence = primary.w;
  // corroboration bumps confidence
  if (agree.length >= 3) confidence = Math.min(1, confidence + 0.08);
  else if (agree.length === 2) confidence = Math.min(1, confidence + 0.04);
  // contradiction from an independent method drops it
  for (const d of disagree) {
    const soft = explicitAgreesWithChain && d.src === 'opening_plus_flows';
    warnings.push(
      (soft ? 'Note: ' : '') +
      `Method "${d.src}" gave ${fmt(d.v)} vs "${primary.src}" ${fmt(primary.v)}.` +
      (soft ? ' Closing balance and running-balance chain agree, so a debit/credit cell was likely misread.' : '')
    );
    if (soft) confidence -= 0.03;
    else confidence -= d.w >= 0.7 ? 0.35 : 0.15;
  }
  if (explicitAgreesWithChain) confidence = Math.max(confidence, 0.9);
  // explicit closing but chain contradicts strongly => needs eyes
  if (primary.src === 'explicit_closing' && chain.unique && chain.terminal &&
      !near(chain.terminal.balance, primary.v)) {
    confidence -= 0.1;
  }
  if (explicitClosingDate && latestDate && explicitClosingDate < latestDate) {
    warnings.push(`Closing-balance date ${explicitClosingDate} is before the latest transaction date ${latestDate}.`);
    confidence -= 0.2;
  }
  if (!latestDate) { warnings.push('No transaction date could be identified.'); confidence -= 0.2; }
  if (periodTo && latestDate && latestDate > periodTo) {
    warnings.push(`Latest transaction date ${latestDate} is after the statement period end ${periodTo}.`);
  }

  confidence = Math.max(0, Math.min(1, round2(confidence)));

  return {
    ok: true,
    balance: primary.v,
    latestDate: explicitClosingDate && (!latestDate || explicitClosingDate >= latestDate) ? explicitClosingDate : latestDate,
    method: primary.src,
    confidence,
    warnings,
    checks,
    candidates,
  };
}

// Build predecessor links via balance[i] == balance[j] + delta[i]; return unique terminal if any.
function reconstructChain(txns) {
  const rows = txns
    .map((t, i) => ({ i, balance: t.balance, delta: round2((t.credit || 0) - (t.debit || 0)), seq: t.seq ?? i, raw: t }))
    .filter((r) => r.balance != null);
  if (rows.length < 2) {
    return { unique: rows.length === 1, terminal: rows[0] || null };
  }
  const hasSuccessor = new Array(rows.length).fill(false);
  for (let a = 0; a < rows.length; a++) {
    for (let b = 0; b < rows.length; b++) {
      if (a === b) continue;
      if (near(round2(rows[a].balance + rows[b].delta), rows[b].balance)) {
        hasSuccessor[a] = true;
      }
    }
  }
  const terminals = rows.filter((_, idx) => !hasSuccessor[idx]);
  if (terminals.length === 1) return { unique: true, terminal: terminals[0], terminals };
  if (terminals.length > 1) {
    // prefer terminal on the max date, else the latest by seq
    const withDate = terminals.filter((r) => r.raw.date);
    let pool = terminals;
    if (withDate.length) {
      const mx = withDate.reduce((m, r) => (r.raw.date > m ? r.raw.date : m), withDate[0].raw.date);
      const onMax = withDate.filter((r) => r.raw.date === mx);
      if (onMax.length === 1) return { unique: true, terminal: onMax[0], terminals };
      pool = onMax.length ? onMax : terminals;
    }
    pool = [...pool].sort((a, b) => b.seq - a.seq);
    return { unique: false, terminal: pool[0], terminals };
  }
  return { unique: false, terminal: null, terminals: [] };
}

/**
 * End-of-day balance for EVERY date present in the statement.
 * - chronological files: last row of each date
 * - unsorted files: the row of that date with no successor inside the same date
 *   (running-balance chain); ambiguous dates are skipped
 * The latest date is forced to the decided closing balance.
 */
function endOfDayBalances(txns, fileOrderReliable, latestDate, latestBalance) {
  const byDate = new Map();
  for (const t of txns) {
    if (!t.date || t.balance == null) continue;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }
  const out = [];
  const skipped = [];
  for (const [date, rows] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let pick = null;
    if (fileOrderReliable || rows.length === 1) {
      pick = rows[rows.length - 1];
    } else {
      const chain = reconstructChain(rows);
      if (chain.unique && chain.terminal) pick = chain.terminal.raw;
    }
    if (pick) out.push({ date, balance: round2(pick.balance) });
    else skipped.push(date);
  }
  if (latestDate && latestBalance != null) {
    const i = out.findIndex((d) => d.date === latestDate);
    if (i >= 0) out[i].balance = round2(latestBalance);
    else out.push({ date: latestDate, balance: round2(latestBalance) });
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return { days: out, skipped };
}

function round2(n) { return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100; }
function fmt(n) { return n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2 }); }

module.exports = { decideBalance, reconstructChain, endOfDayBalances, round2 };
