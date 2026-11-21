'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { db, logAudit, decryptSecret, withTransaction, STORAGE_DIR } = require('../db');
const { requireAuth, requireSection } = require('../auth');
const { upsertDailyPosition, closedDayError, localToday } = require('../positions');
const { processUpload, removeStatement } = require('../services/statements');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

module.exports = function (app) {
  app.post('/api/upload', requireSection('upload'), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const accountId = Number(req.body.account_id);
      if (!accountId) return res.status(400).json({ error: 'account_id is required' });
      const out = await processUpload({ buffer: req.file.buffer, originalName: req.file.originalname, accountId,
        password: req.body.password, actor: req.session.user.username });
      res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('upload error', e);
      res.status(500).json({ error: 'Processing failed: ' + (e.message || String(e)) });
    }
  });

  app.get('/api/statements', requireAuth, (req, res) => {
    const { account_id, limit } = req.query;
    const rows = account_id
      ? db.prepare(`SELECT * FROM statements WHERE bank_account_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT ?`).all(Number(account_id), Number(limit) || 50)
      : db.prepare(`SELECT * FROM statements WHERE deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT ?`).all(Number(limit) || 100);
    res.json(rows.map(publicStatement));
  });

  app.get('/api/statements/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM statements WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(publicStatement(row, true));
  });

  // ---- delete an uploaded statement (soft delete + removes the balances it posted) ----
  app.delete('/api/statements/:id', requireSection('upload'), (req, res) => {
    const st = db.prepare('SELECT * FROM statements WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!st) return res.status(404).json({ error: 'Statement not found' });
    if (String(st.uploaded_at || '').slice(0, 10) < localToday() && req.session.user.role !== 'super_user') return res.status(403).json({ error: 'This statement belongs to an earlier day: only an administrator can delete it.' });
    const reason = (req.body && req.body.reason) || req.query.reason || null;
    const { removed, restored } = removeStatement(st, req.session.user.username, reason);
    logAudit(req.session.user.username, 'delete_statement', 'statements', st.id, { file: st.file_name, account: st.bank_account_id, removed_positions: removed, restored_days: restored, reason });
    res.json({ ok: true, removed_positions: removed, restored_days: restored });
  });

  // ---- manual entry of a balance for one account + date ----
  app.post('/api/positions/manual', requireSection('upload'), (req, res) => {
    const b = req.body || {};
    const accountId = Number(b.bank_account_id);
    const balance = Number(String(b.balance).replace(/,/g, ''));
    if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(b.position_date || '') || b.balance === '' || b.balance == null || !isFinite(balance))
      return res.status(400).json({ error: 'Account, date and a numeric balance are required.' });
    if (!b.reason || !String(b.reason).trim()) return res.status(400).json({ error: 'Please give a reason for the manual entry.' });
    const acc = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL').get(accountId);
    if (!acc) return res.status(404).json({ error: 'Bank account not found' });
    const cur = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(accountId, b.position_date);
    const lockMsg = closedDayError(req.session.user, accountId, [b.position_date]);
    if (lockMsg) return res.status(403).json({ error: lockMsg });
    withTransaction(() => {
      db.prepare(`INSERT INTO balance_corrections (statement_id, daily_position_id, bank_account_id, position_date, original_balance, corrected_balance, reason, corrected_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cur ? cur.statement_id : null, cur ? cur.id : null, accountId, b.position_date, cur ? cur.balance : null, balance, 'Manual entry: ' + b.reason, req.session.user.username);
      upsertDailyPosition({ accountId, date: b.position_date, balance, sourceType: 'manual', statementId: null, status: 'done', note: 'Manual entry: ' + b.reason, actor: req.session.user.username });
    });
    logAudit(req.session.user.username, 'manual_entry', 'daily_positions', `${accountId}@${b.position_date}`, { balance, reason: b.reason, previous: cur ? cur.balance : null });
    res.json({ ok: true });
  });

  // remove a manual entry (reverts the day to the statement figure / carry-forward)
  app.delete('/api/positions/manual', requireSection('upload'), (req, res) => {
    const accountId = Number(req.query.bank_account_id), date = req.query.position_date;
    const cur = db.prepare(`SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ? AND source_type = 'manual'`).get(accountId, date);
    if (!cur) return res.status(404).json({ error: 'No manual entry on that day.' });
    if (date < localToday() && req.session.user.role !== 'super_user') return res.status(403).json({ error: 'Past days are closed: only an administrator can remove a manual balance from a past day.' });
    db.prepare('UPDATE balance_corrections SET daily_position_id = NULL WHERE daily_position_id = ?').run(cur.id);
    db.prepare('DELETE FROM daily_positions WHERE id = ?').run(cur.id);
    // fall back to the statement figure for that day, if any statement covers it
    const rest = db.prepare(`SELECT * FROM statements WHERE bank_account_id = ? AND status = 'processed' AND deleted_at IS NULL ORDER BY uploaded_at ASC, id ASC`).all(accountId);
    for (const r of rest) {
      let days = []; try { days = JSON.parse(r.daily_json || '[]'); } catch {}
      const d = days.find((x) => x.date === date);
      if (d) upsertDailyPosition({ accountId, date, balance: d.balance, sourceType: 'actual', statementId: r.id, status: 'done', actor: req.session.user.username });
    }
    logAudit(req.session.user.username, 'delete_manual_entry', 'daily_positions', `${accountId}@${date}`, { balance: cur.balance });
    res.json({ ok: true });
  });

  app.get('/api/statements/:id/file', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM statements WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const p = path.join(STORAGE_DIR, path.basename(row.stored_path || ''));
    if (!row.stored_path || !fs.existsSync(p)) return res.status(404).json({ error: 'Original file not on disk' });
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.sendFile(p);
  });
};


function getSetting(k, d) {
  const r = require('../db').db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
}
function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function publicStatement(row, full) {
  const o = {
    id: row.id, bank_account_id: row.bank_account_id, file_name: row.file_name, file_type: row.file_type,
    uploaded_by: row.uploaded_by, uploaded_at: row.uploaded_at, statement_from: row.statement_from,
    statement_to: row.statement_to, latest_statement_date: row.latest_statement_date,
    opening_balance: row.opening_balance, closing_balance_reported: row.closing_balance_reported,
    extracted_balance: row.extracted_balance, currency: row.currency, confidence: row.confidence,
    parser: row.parser, method: row.method, status: row.status, error_message: row.error_message,
    txn_count: row.txn_count, page_count: row.page_count, days_posted: row.days_posted,
    warnings: safeJson(row.warnings_json),
  };
  if (full) o.detail = safeJson(row.raw_extract_json);
  return o;
}
