'use strict';
/**
 * Available funds = bank balances of the accounts in a pool  -  the reserves held against it.
 * Pools (which bank accounts count) are set up by a Super User in Settings; reserve heads and their amounts
 * are maintained by finance users. Reserve amounts are dated: a day uses the latest value entered on or before it.
 */
const { db, logAudit } = require('../db');
const { requireAuth, requireSection, requireRole } = require('../auth');
const { computeFunds, validateFormula, sync } = require('../services/funds');

const todayISO = () => new Date().toISOString().slice(0, 10);
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const A = (req) => req.session.user.username;

module.exports = function (app) {
  const canView = requireSection('funds');
  const canEdit = requireSection('funds_edit');
  const SU = requireRole('super_user');

  app.get('/api/funds', canView, (req, res) => res.json(computeFunds(isISO(req.query.date) ? req.query.date : todayISO())));

  // ---- pools: which bank accounts make up a group balance (Super User) ----
  app.get('/api/funds/pools', canView, (req, res) => {
    const pools = db.prepare('SELECT * FROM fund_pools WHERE deleted_at IS NULL ORDER BY display_order, id').all();
    res.json(pools.map((p) => ({ ...p, account_ids: db.prepare('SELECT bank_account_id FROM fund_pool_accounts WHERE pool_id = ?').all(p.id).map((r) => r.bank_account_id) })));
  });
  function setAccounts(poolId, ids) {
    db.prepare('DELETE FROM fund_pool_accounts WHERE pool_id = ?').run(poolId);
    const ins = db.prepare('INSERT OR IGNORE INTO fund_pool_accounts (pool_id, bank_account_id) VALUES (?, ?)');
    for (const id of [...new Set((ids || []).map(Number).filter(Boolean))]) {
      if (db.prepare('SELECT 1 FROM bank_accounts WHERE id = ? AND deleted_at IS NULL').get(id)) ins.run(poolId, id);
    }
  }
  app.post('/api/funds/pools', SU, (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Give the pool a name.' });
    const info = db.prepare('INSERT INTO fund_pools (name, display_order, created_by) VALUES (?, ?, ?)')
      .run(String(b.name).trim(), Number(b.display_order) || 0, A(req));
    setAccounts(Number(info.lastInsertRowid), b.account_ids);
    logAudit(A(req), 'create', 'fund_pools', info.lastInsertRowid, { name: b.name, accounts: b.account_ids });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/funds/pools/:id', SU, (req, res) => {
    const b = req.body || {};
    const p = db.prepare('SELECT * FROM fund_pools WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pool not found' });
    db.prepare('UPDATE fund_pools SET name = ?, display_order = ? WHERE id = ?').run(String(b.name || p.name).trim(), b.display_order != null ? Number(b.display_order) : p.display_order, p.id);
    if (Array.isArray(b.account_ids)) setAccounts(p.id, b.account_ids);
    logAudit(A(req), 'update', 'fund_pools', p.id, { name: b.name, accounts: b.account_ids });
    res.json({ ok: true });
  });
  app.delete('/api/funds/pools/:id', SU, (req, res) => {
    db.prepare("UPDATE fund_pools SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    db.prepare("UPDATE reserve_heads SET deleted_at = datetime('now') WHERE pool_id = ? AND deleted_at IS NULL").run(req.params.id);
    logAudit(A(req), 'delete', 'fund_pools', req.params.id, null);
    res.json({ ok: true });
  });

  // ---- reserve heads + their dated amounts (finance users) ----
  function setValue(headId, asOf, amount, note, actor) {
    db.prepare(`INSERT INTO reserve_values (head_id, as_of, amount, note, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(head_id, as_of) DO UPDATE SET amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(headId, asOf, amount, note || null, actor);
  }
  // accepts 40000000, 40,000,000, 40m, 27.5m, 250k
  const num = (v) => {
    let t = String(v == null ? '' : v).trim().toLowerCase().replace(/,/g, '').replace(/^pkr\s*/, ''), mult = 1;
    if (/m(n|illion)?$/.test(t)) { mult = 1e6; t = t.replace(/m(n|illion)?$/, ''); } else if (/k$/.test(t)) { mult = 1e3; t = t.replace(/k$/, ''); }
    const n = Number(t);
    return t === '' || !isFinite(n) ? NaN : n * mult;
  };

  app.post('/api/funds/heads', canEdit, (req, res) => {
    const b = req.body || {};
    const pool = db.prepare('SELECT id FROM fund_pools WHERE id = ? AND deleted_at IS NULL').get(b.pool_id);
    if (!pool) return res.status(400).json({ error: 'Choose a pool.' });
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Give the reserve a name.' });
    const hasAmt = b.amount !== undefined && b.amount !== '' && b.amount !== null;
    const amt = hasAmt ? num(b.amount) : 0;
    if (hasAmt && (isNaN(amt) || amt < 0)) return res.status(400).json({ error: 'Amount must be a number.' });   // validate BEFORE creating anything
    const order = db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM reserve_heads WHERE pool_id = ?').get(pool.id).n;
    const info = db.prepare('INSERT INTO reserve_heads (pool_id, name, display_order, created_by) VALUES (?, ?, ?, ?)').run(pool.id, String(b.name).trim(), order, A(req));
    const id = Number(info.lastInsertRowid);
    if (hasAmt) setValue(id, isISO(b.as_of) ? b.as_of : todayISO(), amt, b.note, A(req));
    logAudit(A(req), 'create', 'reserve_heads', id, { name: b.name, pool: pool.id, amount: b.amount });
    res.json({ ok: true, id });
  });
  app.put('/api/funds/heads/:id', canEdit, (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required.' });
    db.prepare('UPDATE reserve_heads SET name = ? WHERE id = ? AND deleted_at IS NULL').run(name, req.params.id);
    logAudit(A(req), 'update', 'reserve_heads', req.params.id, { name });
    res.json({ ok: true });
  });
  app.delete('/api/funds/heads/:id', canEdit, (req, res) => {
    db.prepare("UPDATE reserve_heads SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);   // history is kept
    logAudit(A(req), 'delete', 'reserve_heads', req.params.id, null);
    res.json({ ok: true });
  });
  app.put('/api/funds/heads/:id/value', canEdit, (req, res) => {
    const b = req.body || {};
    const amt = num(b.amount);
    if (isNaN(amt) || amt < 0) return res.status(400).json({ error: 'Amount must be a number (0 or more).' });
    const asOf = isISO(b.as_of) ? b.as_of : todayISO();
    const head = db.prepare('SELECT * FROM reserve_heads WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!head) return res.status(404).json({ error: 'Reserve not found' });
    if (String(head.id) === String(require('../db').getSetting('unpresented_head_id', ''))) return res.status(400).json({ error: 'This reserve follows the Unpresented Cheques list automatically - add or clear cheques in that list.' });
    const before = db.prepare('SELECT amount FROM reserve_values WHERE head_id = ? AND as_of <= ? ORDER BY as_of DESC LIMIT 1').get(head.id, asOf);
    setValue(head.id, asOf, amt, b.note, A(req));
    logAudit(A(req), 'reserve_value', 'reserve_heads', head.id, { as_of: asOf, from: before ? before.amount : null, to: amt, note: b.note || null });
    res.json({ ok: true });
  });
  app.get('/api/funds/heads/:id/history', canView, (req, res) => {
    res.json(db.prepare('SELECT as_of, amount, note, updated_by, updated_at FROM reserve_values WHERE head_id = ? ORDER BY as_of DESC LIMIT 60').all(req.params.id));
  });

  // ---- statement layout: lines and equations (Super User) ----
  app.post('/api/funds/formula/check', SU, (req, res) => res.json(validateFormula((req.body || {}).formula, (req.body || {}).line_id)));
  app.post('/api/funds/lines', SU, (req, res) => {
    const b = req.body || {};
    const label = String(b.label || '').trim(), formula = String(b.formula || '').trim();
    if (!label) return res.status(400).json({ error: 'Give the line a name.' });
    const chk = validateFormula(formula, null);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    sync();
    const { nextCode } = require('../services/funds');
    const lines = db.prepare('SELECT * FROM fund_lines WHERE deleted_at IS NULL ORDER BY display_order, id').all();
    let order = lines.length + 1;
    if (b.after_code) { const a = lines.find((l) => l.code === String(b.after_code).toUpperCase()); if (a) order = a.display_order + 0.5; }
    const info = db.prepare('INSERT INTO fund_lines (code, label, kind, formula, headline, display_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nextCode(), label, 'formula', formula, b.headline ? 1 : 0, order);
    sync();
    logAudit(A(req), 'create', 'fund_lines', info.lastInsertRowid, { label, formula });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/funds/lines/:id', SU, (req, res) => {
    const l = db.prepare("SELECT * FROM fund_lines WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Line not found' });
    const b = req.body || {};
    if (l.kind === 'formula') {
      const formula = String(b.formula != null ? b.formula : l.formula).trim(), label = String(b.label != null ? b.label : l.label).trim();
      if (!label) return res.status(400).json({ error: 'Give the line a name.' });
      const chk = validateFormula(formula, l.id);
      if (!chk.ok) return res.status(400).json({ error: chk.error });
      db.prepare('UPDATE fund_lines SET label = ?, formula = ? WHERE id = ?').run(label, formula, l.id);
    }
    if (b.headline !== undefined) db.prepare('UPDATE fund_lines SET headline = ? WHERE id = ?').run(b.headline ? 1 : 0, l.id);
    logAudit(A(req), 'update', 'fund_lines', l.id, b);
    res.json({ ok: true });
  });
  app.post('/api/funds/lines/:id/move', SU, (req, res) => {
    sync();
    const lines = db.prepare('SELECT * FROM fund_lines WHERE deleted_at IS NULL ORDER BY display_order, id').all();
    const i = lines.findIndex((l) => l.id === Number(req.params.id));
    const j = (req.body || {}).dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= lines.length) return res.json({ ok: true });
    const a = lines[i], c = lines[j];
    db.prepare('UPDATE fund_lines SET display_order = ? WHERE id = ?').run(c.display_order, a.id);
    db.prepare('UPDATE fund_lines SET display_order = ? WHERE id = ?').run(a.display_order, c.id);
    res.json({ ok: true });
  });
  app.delete('/api/funds/lines/:id', SU, (req, res) => {
    const l = db.prepare("SELECT * FROM fund_lines WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Line not found' });
    if (l.kind !== 'formula') return res.status(400).json({ error: 'Bank-balance and reserve lines are removed by deleting the pool / reserve itself.' });
    db.prepare("UPDATE fund_lines SET deleted_at = datetime('now') WHERE id = ?").run(l.id);
    logAudit(A(req), 'delete', 'fund_lines', l.id, { label: l.label, formula: l.formula });
    res.json({ ok: true });
  });
};
