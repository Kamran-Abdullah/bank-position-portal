'use strict';
const { db } = require('../db');
const { requireAuth, requireSection } = require('../auth');
const { getDashboard, resolvePosition, upsertDailyPosition, localToday } = require('../positions');
const { logAudit } = require('../db');
const { computeMonthly } = require('../services/monthly');

const todayISO = () => new Date().toISOString().slice(0, 10);
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

module.exports = function (app) {
  app.get('/api/dashboard', requireSection('dashboard'), (req, res) => {
    const date = isISO(req.query.date) ? req.query.date : todayISO();
    res.json(getDashboard(date));
  });

  app.get('/api/dashboard/breakdown', requireSection('dashboard'), (req, res) => {
    const date = isISO(req.query.date) ? req.query.date : todayISO();
    const status = req.query.status; // pending | review | error | done | carried_forward
    const data = getDashboard(date);
    const rows = [];
    for (const co of data.companies) {
      for (const a of co.accounts) {
        if (!status || a.status === status) {
          rows.push({ company: co.company_name, bank: a.bank_name, account_title: a.account_title,
            account_number: a.account_number, status: a.status, balance: a.balance, account_id: a.account_id });
        }
      }
    }
    res.json({ date, status: status || 'all', rows });
  });

  // which bank statements have not arrived yet for a day (same rule as the "all statements received" e-mail)
  app.get('/api/missing', requireSection('dashboard'), (req, res) => {
    const { localToday, isOffDay } = require('../positions');
    const date = isISO(req.query.date) ? req.query.date : localToday();
    const c = require('../services/notify').completeness(date);
    const last = db.prepare("SELECT MAX(position_date) AS d FROM daily_positions WHERE bank_account_id = ? AND status = 'done' AND source_type IN ('actual','manual') AND position_date <= ?");
    const missing = c.missing.map((m) => ({ ...m, last_statement_date: (last.get(m.account_id, date) || {}).d || null }));
    const closed = db.prepare(`SELECT m.bank_account_id AS account_id, m.balance, m.closed_by, m.closed_at, c.name AS company, bk.name AS bank
      FROM missing_closed m JOIN bank_accounts a ON a.id = m.bank_account_id JOIN companies c ON c.id = a.company_id JOIN banks bk ON bk.id = a.bank_id
      WHERE m.close_date = ? ORDER BY m.closed_at`).all(date);
    res.json({ date, today: localToday(), off_day: isOffDay(date), total: c.total, received: c.total - missing.length, missing, closed });
  });

  // a person closes a missing statement: the balance shown is accepted as correct for that day and the account counts as done
  app.post('/api/missing/close', requireSection('upload'), (req, res) => {
    const b = req.body || {};
    const accountId = Number(b.account_id), date = isISO(b.date) ? b.date : localToday();
    const acc = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL').get(accountId);
    if (!acc) return res.status(404).json({ error: 'Bank account not found.' });
    if (date > localToday()) return res.status(400).json({ error: 'A future day cannot be closed.' });
    const user = req.session.user.username;
    const pos = resolvePosition(accountId, date);
    if (pos.balance == null) return res.status(400).json({ error: 'There is no balance to accept for this account yet - enter one with Manual instead.' });
    if (pos.status !== 'done') {
      upsertDailyPosition({ accountId, date, balance: pos.balance, sourceType: 'manual', statementId: null, status: 'done',
        note: 'Closed as correct by ' + user + ': ' + (pos.source_type === 'carried_forward' ? 'previous balance accepted, no statement expected' : 'balance accepted') + (b.note ? ' (' + b.note + ')' : ''), actor: user });
    }
    db.prepare('INSERT OR REPLACE INTO missing_closed (bank_account_id, close_date, balance, closed_by, note) VALUES (?, ?, ?, ?, ?)').run(accountId, date, pos.balance, user, b.note || null);
    logAudit(user, 'missing_closed', 'daily_positions', accountId + '@' + date, { balance: pos.balance, note: b.note || null });
    res.json({ ok: true, balance: pos.balance });
  });
  // undo a close (only a close made the same day, or any day for an administrator)
  app.delete('/api/missing/close', requireSection('upload'), (req, res) => {
    const accountId = Number(req.query.account_id), date = req.query.date;
    const row = db.prepare('SELECT * FROM missing_closed WHERE bank_account_id = ? AND close_date = ?').get(accountId, date);
    if (!row) return res.status(404).json({ error: 'This account was not closed for that day.' });
    if (date < localToday() && req.session.user.role !== 'super_user') return res.status(403).json({ error: 'A closed day can only be re-opened by an administrator.' });
    const p = db.prepare("SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ? AND source_type = 'manual' AND note LIKE 'Closed as correct by %'").get(accountId, date);
    if (p) db.prepare('DELETE FROM daily_positions WHERE id = ?').run(p.id);
    db.prepare('DELETE FROM missing_closed WHERE bank_account_id = ? AND close_date = ?').run(accountId, date);
    logAudit(req.session.user.username, 'missing_reopened', 'daily_positions', accountId + '@' + date, { balance: row.balance });
    res.json({ ok: true });
  });

  // month grid: every day of the month per account, carry-forward filled up to today
  app.get('/api/monthly', requireSection('monthly'), (req, res) => {
    const y = Number(req.query.year), m = Number(req.query.month); // m = 1..12
    if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: 'year and month (1-12) required' });
    res.json(computeMonthly(y, m));
  });
};
