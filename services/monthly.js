'use strict';
const { db } = require('../db');
const { resolvePosition, isOffDay } = require('../positions');
const { monthSeries } = require('./adjustments');

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Month grid: every day per account (carry-forward filled up to today), company subtotals, grand totals,
 *  plus per-bank adjustment rows (lien etc.) and net figures when adjustments exist. */
function computeMonthly(y, m) {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  const dateOf = (i) => `${y}-${mm}-${String(i + 1).padStart(2, '0')}`;
  const today = todayISO();

  const accounts = db.prepare(`
    SELECT a.id, a.account_title, a.account_number, c.id AS company_id, c.name AS company_name, bk.name AS bank_name
    FROM bank_accounts a JOIN companies c ON c.id = a.company_id JOIN banks bk ON bk.id = a.bank_id
    WHERE a.deleted_at IS NULL AND a.status = 'active' AND c.deleted_at IS NULL AND c.status = 'active'
    ORDER BY c.display_order, c.name, a.display_order, bk.display_order`).all();

  const offdays = Array.from({ length: days }, (_, i) => isOffDay(dateOf(i)));
  const holidays = db.prepare('SELECT holiday_date, name FROM holidays WHERE holiday_date BETWEEN ? AND ?').all(dateOf(0), dateOf(days - 1));
  const series = monthSeries(y, m, days);
  const adjByAccount = new Map();
  for (const { type, amounts } of series.values()) {
    if (!adjByAccount.has(type.bank_account_id)) adjByAccount.set(type.bank_account_id, []);
    // no projection into the future (same rule as balances)
    adjByAccount.get(type.bank_account_id).push({ id: type.id, name: type.name, effect: type.effect === 'add' ? 'add' : 'deduct', cells: amounts.map((v, i) => (dateOf(i) > today ? null : v)) });
  }
  const trusted = (c) => c && c.balance != null && ['done', 'carried_forward', 'manual'].includes(c.status);

  const rows = accounts.map((a) => {
    const cells = Array.from({ length: days }, (_, i) => {
      const d = dateOf(i);
      if (d > today) return null;
      const p = resolvePosition(a.id, d);
      if (p.balance == null && p.status === 'pending') return null;
      return { balance: p.balance, source: p.source_type, status: p.status };
    });
    // a lien type with no amount in this month is not shown
    const adjustments = (adjByAccount.get(a.id) || []).filter((x) => x.cells.some((v) => v));
    const net_cells = adjustments.length ? cells.map((c, i) => (trusted(c) ? c.balance + adjustments.reduce((s, x) => s + (x.effect === 'add' ? (x.cells[i] || 0) : -(x.cells[i] || 0)), 0) : null)) : null;
    return { account_id: a.id, company_id: a.company_id, company: a.company_name, bank: a.bank_name, account_title: a.account_title, cells, adjustments, net_cells };
  });

  const companyTotals = {}, companyNet = {};
  for (const r of rows) {
    const t = companyTotals[r.company_id] || (companyTotals[r.company_id] = { company: r.company, cells: Array(days).fill(null) });
    const n = companyNet[r.company_id] || (companyNet[r.company_id] = { company: r.company, cells: Array(days).fill(null) });
    r.cells.forEach((c, i) => {
      if (trusted(c)) {
        t.cells[i] = (t.cells[i] || 0) + c.balance;
        n.cells[i] = (n.cells[i] || 0) + (r.net_cells ? r.net_cells[i] : c.balance);
      }
    });
  }
  const grandTotals = Array(days).fill(null), grandNet = Array(days).fill(null);
  Object.values(companyTotals).forEach((t) => t.cells.forEach((v, i) => { if (v != null) grandTotals[i] = (grandTotals[i] || 0) + v; }));
  Object.values(companyNet).forEach((t) => t.cells.forEach((v, i) => { if (v != null) grandNet[i] = (grandNet[i] || 0) + v; }));
  const hasAdjustments = rows.some((r) => r.adjustments.length);
  return { year: y, month: m, days, today, offdays, holidays, rows, companyTotals, grandTotals, companyNet, grandNet, hasAdjustments };
}

module.exports = { computeMonthly };
