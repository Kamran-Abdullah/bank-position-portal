'use strict';
/**
 * Per-bank adjustments (Lien, RTGS in transit, Clearing cheques ...).
 * Nothing exists by default: a Super User adds an adjustment type under any bank account, finance users enter its
 * amount (dated - a day uses the latest amount entered on or before it). "deduct" types reduce the bank's balance
 * (a lien), "add" types increase it. Net balance = ledger balance - deductions + additions.
 */
const { db } = require('../db');

function allTypes() {
  return db.prepare(`SELECT a.* FROM account_adjustments a JOIN bank_accounts b ON b.id = a.bank_account_id
    WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY a.bank_account_id, a.display_order, a.id`).all();
}

// Map accountId -> [{id, name, effect, amount, delta, as_of, note}]  as at `date`
function adjustmentsAt(date) {
  const valueAt = db.prepare('SELECT amount, as_of, note FROM adjustment_values WHERE adjustment_id = ? AND as_of <= ? ORDER BY as_of DESC LIMIT 1');
  const map = new Map();
  for (const t of allTypes()) {
    const v = valueAt.get(t.id, date);
    const amount = v ? v.amount : 0;
    const row = { id: t.id, name: t.name, effect: t.effect === 'add' ? 'add' : 'deduct', amount, delta: t.effect === 'add' ? amount : -amount, as_of: v ? v.as_of : null, note: v ? v.note : null };
    if (!map.has(t.bank_account_id)) map.set(t.bank_account_id, []);
    map.get(t.bank_account_id).push(row);
  }
  return map;
}

// Per-day amounts for a whole month: Map typeId -> [amount for day 1..n]
function monthSeries(year, month, days) {
  const mm = String(month).padStart(2, '0');
  const last = `${year}-${mm}-${String(days).padStart(2, '0')}`;
  const out = new Map();
  for (const t of allTypes()) {
    const vals = db.prepare('SELECT as_of, amount FROM adjustment_values WHERE adjustment_id = ? AND as_of <= ? ORDER BY as_of ASC').all(t.id, last);
    const arr = [];
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      let amt = 0, seen = false;
      for (const v of vals) { if (v.as_of <= iso) { amt = v.amount; seen = true; } else break; }
      arr.push(seen ? amt : 0);
    }
    out.set(t.id, { type: t, amounts: arr });
  }
  return out;
}

const sumDelta = (list) => (list || []).reduce((s, a) => s + a.delta, 0);

module.exports = { allTypes, adjustmentsAt, monthSeries, sumDelta };
