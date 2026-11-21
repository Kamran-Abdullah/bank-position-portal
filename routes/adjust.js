'use strict';
const { db, logAudit } = require('../db');
const { requireAuth, requireSection, requireRole } = require('../auth');
const { adjustmentsAt } = require('../services/adjustments');

const todayISO = () => new Date().toISOString().slice(0, 10);
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const A = (req) => req.session.user.username;
const num = (v) => {
  let t = String(v == null ? '' : v).trim().toLowerCase().replace(/,/g, '').replace(/^pkr\s*/, ''), mult = 1;
  if (/m(n|illion)?$/.test(t)) { mult = 1e6; t = t.replace(/m(n|illion)?$/, ''); } else if (/k$/.test(t)) { mult = 1e3; t = t.replace(/k$/, ''); }
  const n = Number(t);
  return t === '' || !isFinite(n) ? NaN : n * mult;
};

module.exports = function (app) {
  const SU = requireRole('super_user');
  const canEdit = requireSection('adjust_edit');

  // every adjustment type with its amount as at a date
  app.get('/api/adjustments', requireAuth, (req, res) => {
    const date = isISO(req.query.date) ? req.query.date : todayISO();
    const m = adjustmentsAt(date);
    res.json([...m.entries()].map(([account_id, list]) => ({ account_id, adjustments: list })));
  });

  // Super User: add / rename / remove a type under a bank account
  app.post('/api/adjustments', SU, (req, res) => {
    const b = req.body || {};
    const acc = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL').get(b.bank_account_id);
    if (!acc) return res.status(400).json({ error: 'Choose a bank account.' });
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the adjustment a name, e.g. Lien.' });
    const effect = b.effect === 'add' ? 'add' : 'deduct';
    const order = db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM account_adjustments WHERE bank_account_id = ?').get(acc.id).n;
    const info = db.prepare('INSERT INTO account_adjustments (bank_account_id, name, effect, display_order, created_by) VALUES (?, ?, ?, ?, ?)').run(acc.id, name, effect, order, A(req));
    logAudit(A(req), 'create', 'account_adjustments', info.lastInsertRowid, { account: acc.id, name, effect });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/adjustments/:id', SU, (req, res) => {
    const b = req.body || {};
    const t = db.prepare('SELECT * FROM account_adjustments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE account_adjustments SET name = ?, effect = ? WHERE id = ?').run(String(b.name || t.name).trim(), b.effect === 'add' ? 'add' : b.effect === 'deduct' ? 'deduct' : t.effect, t.id);
    logAudit(A(req), 'update', 'account_adjustments', t.id, b);
    res.json({ ok: true });
  });
  app.delete('/api/adjustments/:id', SU, (req, res) => {
    db.prepare("UPDATE account_adjustments SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);   // amounts are kept
    logAudit(A(req), 'delete', 'account_adjustments', req.params.id, null);
    res.json({ ok: true });
  });

  // finance users: enter the amount (dated)
  app.put('/api/adjustments/:id/value', canEdit, (req, res) => {
    const b = req.body || {};
    const amt = num(b.amount);
    if (isNaN(amt) || amt < 0) return res.status(400).json({ error: 'Amount must be a number (0 or more).' });
    const t = db.prepare('SELECT * FROM account_adjustments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const asOf = isISO(b.as_of) ? b.as_of : todayISO();
    const before = db.prepare('SELECT amount FROM adjustment_values WHERE adjustment_id = ? AND as_of <= ? ORDER BY as_of DESC LIMIT 1').get(t.id, asOf);
    db.prepare(`INSERT INTO adjustment_values (adjustment_id, as_of, amount, note, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(adjustment_id, as_of) DO UPDATE SET amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(t.id, asOf, amt, b.note || null, A(req));
    logAudit(A(req), 'adjustment_value', 'account_adjustments', t.id, { name: t.name, as_of: asOf, from: before ? before.amount : null, to: amt, note: b.note || null });
    res.json({ ok: true });
  });
  app.get('/api/adjustments/:id/history', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT as_of, amount, note, updated_by, updated_at FROM adjustment_values WHERE adjustment_id = ? ORDER BY as_of DESC LIMIT 60').all(req.params.id));
  });
};
