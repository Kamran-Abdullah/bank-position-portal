'use strict';
const { db, logAudit, encryptSecret } = require('../db');
const { requireAuth, requireSection } = require('../auth');

module.exports = function (app) {
  const canConfig = requireSection('config');
  const A = (req) => req.session.user.username;

  // ---------------- companies ----------------
  app.get('/api/companies', requireAuth, (req, res) => {
    res.json(db.prepare(`SELECT * FROM companies WHERE deleted_at IS NULL ORDER BY display_order, name`).all());
  });
  app.post('/api/companies', canConfig, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Company name required' });
    const info = db.prepare(`INSERT INTO companies (name, code, status, display_order, aliases) VALUES (?, ?, ?, ?, ?)`)
      .run(b.name, b.code || null, b.status || 'active', b.display_order || 0, b.aliases || null);
    logAudit(A(req), 'create', 'companies', info.lastInsertRowid, b);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/companies/:id', canConfig, (req, res) => {
    const b = req.body || {};
    db.prepare(`UPDATE companies SET name = ?, code = ?, status = ?, display_order = ?, aliases = ? WHERE id = ?`)
      .run(b.name, b.code || null, b.status || 'active', b.display_order || 0, b.aliases || null, req.params.id);
    logAudit(A(req), 'update', 'companies', req.params.id, b);
    res.json({ ok: true });
  });
  app.delete('/api/companies/:id', canConfig, (req, res) => {
    const used = db.prepare(`SELECT COUNT(*) c FROM bank_accounts WHERE company_id = ? AND deleted_at IS NULL`).get(req.params.id).c;
    if (used) return res.status(409).json({ error: `Company has ${used} active bank account(s). Remove them first.` });
    db.prepare(`UPDATE companies SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(req.session.user.id, req.params.id);
    logAudit(A(req), 'delete', 'companies', req.params.id, null);
    res.json({ ok: true });
  });

  // ---------------- banks ----------------
  app.get('/api/banks', requireAuth, (req, res) => {
    res.json(db.prepare(`SELECT * FROM banks WHERE deleted_at IS NULL ORDER BY display_order, name`).all());
  });
  app.post('/api/banks', canConfig, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Bank name required' });
    const info = db.prepare(`INSERT INTO banks (name, code, parser_key, status, display_order) VALUES (?, ?, ?, ?, ?)`)
      .run(b.name, b.code || null, b.parser_key || null, b.status || 'active', b.display_order || 0);
    logAudit(A(req), 'create', 'banks', info.lastInsertRowid, b);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/banks/:id', canConfig, (req, res) => {
    const b = req.body || {};
    db.prepare(`UPDATE banks SET name = ?, code = ?, parser_key = ?, status = ?, display_order = ? WHERE id = ?`)
      .run(b.name, b.code || null, b.parser_key || null, b.status || 'active', b.display_order || 0, req.params.id);
    logAudit(A(req), 'update', 'banks', req.params.id, b);
    res.json({ ok: true });
  });
  app.delete('/api/banks/:id', canConfig, (req, res) => {
    const used = db.prepare(`SELECT COUNT(*) c FROM bank_accounts WHERE bank_id = ? AND deleted_at IS NULL`).get(req.params.id).c;
    if (used) return res.status(409).json({ error: `Bank is used by ${used} active account(s).` });
    db.prepare(`UPDATE banks SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(req.session.user.id, req.params.id);
    logAudit(A(req), 'delete', 'banks', req.params.id, null);
    res.json({ ok: true });
  });

  // ---------------- bank accounts ----------------
  app.get('/api/accounts', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT a.*, c.name AS company_name, bk.name AS bank_name, bk.parser_key,
             (a.statement_password_enc IS NOT NULL) AS has_password
      FROM bank_accounts a
      JOIN companies c ON c.id = a.company_id
      JOIN banks bk ON bk.id = a.bank_id
      WHERE a.deleted_at IS NULL
      ${req.query.company_id ? 'AND a.company_id = @cid' : ''}
      ORDER BY c.display_order, a.display_order, bk.display_order
    `).all(req.query.company_id ? { cid: Number(req.query.company_id) } : {});
    rows.forEach((r) => { delete r.statement_password_enc; });
    res.json(rows);
  });
  app.post('/api/accounts', canConfig, (req, res) => {
    const b = req.body || {};
    if (!b.company_id || !b.bank_id) return res.status(400).json({ error: 'Company and bank are required' });
    const info = db.prepare(`INSERT INTO bank_accounts
      (company_id, bank_id, account_number, account_title, currency, branch, status, display_order, statement_password_enc, match_hints_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.company_id, b.bank_id, b.account_number || null, b.account_title || null, b.currency || 'PKR',
        b.branch || null, b.status || 'active', b.display_order || 0,
        b.statement_password ? encryptSecret(b.statement_password) : null,
        b.match_hints ? JSON.stringify(b.match_hints) : null);
    logAudit(A(req), 'create', 'bank_accounts', info.lastInsertRowid, { ...b, statement_password: b.statement_password ? '***' : undefined });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  app.put('/api/accounts/:id', canConfig, (req, res) => {
    const b = req.body || {};
    const cur = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    let pwEnc = cur.statement_password_enc;
    if (b.statement_password === '') pwEnc = null;
    else if (b.statement_password) pwEnc = encryptSecret(b.statement_password);
    db.prepare(`UPDATE bank_accounts SET company_id = ?, bank_id = ?, account_number = ?, account_title = ?,
      currency = ?, branch = ?, status = ?, display_order = ?, statement_password_enc = ?, match_hints_json = ? WHERE id = ?`)
      .run(b.company_id, b.bank_id, b.account_number || null, b.account_title || null, b.currency || 'PKR',
        b.branch || null, b.status || 'active', b.display_order || 0, pwEnc,
        b.match_hints ? JSON.stringify(b.match_hints) : cur.match_hints_json, req.params.id);
    logAudit(A(req), 'update', 'bank_accounts', req.params.id, { ...b, statement_password: b.statement_password ? '***' : undefined });
    res.json({ ok: true });
  });
  app.delete('/api/accounts/:id', canConfig, (req, res) => {
    db.prepare(`UPDATE bank_accounts SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(req.session.user.id, req.params.id);
    logAudit(A(req), 'delete', 'bank_accounts', req.params.id, null);
    res.json({ ok: true });
  });
};
