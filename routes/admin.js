'use strict';
const bcrypt = require('bcryptjs');
const { db, logAudit, getRecentAudit, getSetting, setSetting } = require('../db');
const { requireAuth, requireRole, requireSection } = require('../auth');
const { upsertDailyPosition, closedDayError, localToday } = require('../positions');

const SU = requireRole('super_user');

module.exports = function (app) {
  const A = (req) => req.session.user.username;

  // ---------------- users ----------------
  app.get('/api/users', SU, (req, res) => {
    res.json(db.prepare(`SELECT id, username, full_name, role, locked_until, created_at FROM users WHERE deleted_at IS NULL ORDER BY username`).all());
  });
  app.post('/api/users', SU, (req, res) => {
    const b = req.body || {};
    if (!b.username || !b.password || !b.role) return res.status(400).json({ error: 'username, password, role required' });
    if (!['super_user', 'finance_user', 'viewer'].includes(b.role)) return res.status(400).json({ error: 'invalid role' });
    try {
      const info = db.prepare(`INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)`)
        .run(b.username, b.full_name || null, bcrypt.hashSync(b.password, 10), b.role);
      logAudit(A(req), 'create', 'users', info.lastInsertRowid, { username: b.username, role: b.role });
      res.json({ ok: true, id: Number(info.lastInsertRowid) });
    } catch { res.status(409).json({ error: 'Username already exists' }); }
  });
  app.put('/api/users/:id', SU, (req, res) => {
    const b = req.body || {};
    db.prepare(`UPDATE users SET full_name = ?, role = ? WHERE id = ? AND deleted_at IS NULL`).run(b.full_name || null, b.role, req.params.id);
    logAudit(A(req), 'update', 'users', req.params.id, { role: b.role });
    res.json({ ok: true });
  });
  app.put('/api/users/:id/password', SU, (req, res) => {
    if (!req.body || !req.body.password) return res.status(400).json({ error: 'password required' });
    db.prepare(`UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?`)
      .run(bcrypt.hashSync(req.body.password, 10), req.params.id);
    logAudit(A(req), 'password_reset', 'users', req.params.id, null);
    res.json({ ok: true });
  });
  app.delete('/api/users/:id', SU, (req, res) => {
    if (Number(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    db.prepare(`UPDATE users SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`).run(req.session.user.id, req.params.id);
    logAudit(A(req), 'delete', 'users', req.params.id, null);
    res.json({ ok: true });
  });
  app.get('/api/access-permissions', SU, (req, res) => {
    res.json(db.prepare('SELECT role, section, allowed FROM access_permissions ORDER BY role, section').all());
  });
  app.post('/api/access-permissions', SU, (req, res) => {
    const { role, section, allowed } = req.body || {};
    if (!role || !section) return res.status(400).json({ error: 'role and section required' });
    db.prepare(`INSERT INTO access_permissions (role, section, allowed) VALUES (?, ?, ?)
      ON CONFLICT(role, section) DO UPDATE SET allowed = excluded.allowed`).run(role, section, allowed ? 1 : 0);
    logAudit(A(req), 'update', 'access_permissions', `${role}:${section}`, { allowed });
    res.json({ ok: true });
  });

  // ---------------- settings ----------------
  app.get('/api/settings', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const o = {};
    for (const r of rows) o[r.key] = r.value;
    o.off_days = db.prepare('SELECT weekday, active FROM off_days ORDER BY weekday').all();
    o.holidays = db.prepare('SELECT * FROM holidays ORDER BY holiday_date').all();
    res.json(o);
  });
  app.put('/api/settings', SU, (req, res) => {
    const allowed = ['working_date_default', 'confidence_threshold', 'carry_forward_offdays', 'group_name', 'notify_enabled', 'notify_mode', 'notify_to', 'notify_cc', 'notify_subject', 'notify_not_before', 'notify_attach_daily', 'notify_attach_monthly', 'notify_attach_unpresented'];
    for (const k of allowed) if (req.body[k] !== undefined) setSetting(k, req.body[k]);
    logAudit(A(req), 'update', 'settings', null, req.body);
    res.json({ ok: true });
  });
  app.put('/api/off-days', SU, (req, res) => {
    const list = req.body.off_days || []; // [{weekday, active}]
    const up = db.prepare(`INSERT INTO off_days (weekday, active) VALUES (?, ?) ON CONFLICT(weekday) DO UPDATE SET active = excluded.active`);
    for (const d of list) up.run(Number(d.weekday), d.active ? 1 : 0);
    logAudit(A(req), 'update', 'off_days', null, list);
    res.json({ ok: true });
  });
  app.post('/api/holidays', SU, (req, res) => {
    const { holiday_date, name } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday_date || '')) return res.status(400).json({ error: 'holiday_date YYYY-MM-DD required' });
    db.prepare(`INSERT INTO holidays (holiday_date, name) VALUES (?, ?) ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name`).run(holiday_date, name || null);
    logAudit(A(req), 'create', 'holidays', holiday_date, { name });
    res.json({ ok: true });
  });
  app.delete('/api/holidays/:date', SU, (req, res) => {
    db.prepare('DELETE FROM holidays WHERE holiday_date = ?').run(req.params.date);
    logAudit(A(req), 'delete', 'holidays', req.params.date, null);
    res.json({ ok: true });
  });

  // ---------------- review queue ----------------
  app.get('/api/review-queue', requireSection('review'), (req, res) => {
    res.json(db.prepare(`
      SELECT s.*, a.account_title, a.account_number, c.name AS company_name, bk.name AS bank_name
      FROM statements s
      LEFT JOIN bank_accounts a ON a.id = s.bank_account_id
      LEFT JOIN companies c ON c.id = s.company_id
      LEFT JOIN banks bk ON bk.id = s.bank_id
      WHERE s.status IN ('review','error','unrouted') AND s.deleted_at IS NULL
      ORDER BY s.uploaded_at DESC LIMIT 200`).all().map((r) => ({
      ...r, warnings: safe(r.warnings_json), detail: safe(r.raw_extract_json), warnings_json: undefined, raw_extract_json: undefined,
    })));
  });

  // confirm or correct a reviewed statement's balance
  app.post('/api/review/:id/resolve', requireSection('review'), (req, res) => {
    const st = db.prepare('SELECT * FROM statements WHERE id = ?').get(req.params.id);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const b0 = req.body || {};
    if (req.session.user.role !== 'super_user') {   // only today's balance can be confirmed by a non-admin: a past-dated figure is posted to today instead
      const today = localToday();
      if (b0.conflict_action) return res.status(403).json({ error: 'Only an administrator can replace the balance of a past day.' });
      if (Array.isArray(b0.days) && b0.days.length) {
        const valid = b0.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') && d.balance !== '' && d.balance != null && isFinite(Number(d.balance))).sort((x, y) => (x.date < y.date ? -1 : 1));
        if (valid.some((d) => d.date < today)) b0.days = [{ date: today, balance: valid[valid.length - 1].balance }];
      } else if ((b0.statement_date || st.latest_statement_date) < today) b0.statement_date = today;
    }
    const b = req.body || {};
    const finalBalance = b.corrected_balance != null && b.corrected_balance !== ''
      ? Number(b.corrected_balance) : st.extracted_balance;
    // two statements disagree about a closed day: keep what is on file, or let this newer file replace it
    if (b.conflict_action) {
      let raw = {}; try { raw = JSON.parse(st.raw_extract_json || '{}'); } catch {}
      const conflicts = raw.conflicts || [];
      if (!conflicts.length) return res.status(400).json({ error: 'This statement has no conflicting days.' });
      db.exec('BEGIN');
      try {
        if (b.conflict_action === 'use_new') {
          for (const c of conflicts) {
            const cur = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(st.bank_account_id, c.date);
            db.prepare(`INSERT INTO balance_corrections (statement_id, daily_position_id, bank_account_id, position_date, original_balance, corrected_balance, reason, corrected_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(st.id, cur ? cur.id : null, st.bank_account_id, c.date, c.existing, c.incoming, b.reason || 'Newer statement replaces the earlier balance', req.session.user.username);
            upsertDailyPosition({ accountId: st.bank_account_id, date: c.date, balance: c.incoming, sourceType: 'actual', statementId: st.id, status: 'done',
              note: 'Replaced earlier balance ' + c.existing + (b.reason ? ': ' + b.reason : ''), actor: req.session.user.username });
          }
        }
        delete raw.conflicts; raw.conflictResolved = b.conflict_action;
        db.prepare(`UPDATE statements SET status = 'processed', raw_extract_json = ? WHERE id = ?`).run(JSON.stringify(raw), st.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
      logAudit(req.session.user.username, 'resolve_conflict', 'statements', st.id, { action: b.conflict_action, days: conflicts.length });
      return res.json({ ok: true });
    }
    // photo statements: several confirmed day balances at once
    if (Array.isArray(b.days) && b.days.length) {
      const days = b.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') && d.balance !== '' && d.balance != null && isFinite(Number(d.balance)))
        .map((d) => ({ date: d.date, balance: Number(d.balance) })).sort((x, y) => (x.date < y.date ? -1 : 1));
      if (!days.length) return res.status(400).json({ error: 'Enter at least one date with a balance.' });
      let orig = [];
      try { orig = (JSON.parse(st.raw_extract_json || '{}').photoRows || []); } catch {}
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM daily_positions WHERE statement_id = ? AND source_type = 'review'`).run(st.id);
        let posted = 0;
        for (const d of days) {
          const cur = db.prepare('SELECT source_type FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(st.bank_account_id, d.date);
          if (cur && cur.source_type === 'manual') continue;
          const same = orig.some((o) => o.date === d.date && Math.abs(o.value - d.balance) < 0.005);
          if (!same) {
            db.prepare(`INSERT INTO balance_corrections (statement_id, bank_account_id, position_date, original_balance, corrected_balance, reason, corrected_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(st.id, st.bank_account_id, d.date, (orig.find((o) => o.date === d.date) || {}).value ?? null, d.balance, b.reason || 'Confirmed from photo review', req.session.user.username);
          }
          upsertDailyPosition({ accountId: st.bank_account_id, date: d.date, balance: d.balance, sourceType: same ? 'actual' : 'manual', statementId: st.id, status: 'done',
            note: b.reason || 'Confirmed from photo review', actor: req.session.user.username });
          posted++;
        }
        const last = days[days.length - 1];
        db.prepare(`UPDATE statements SET status = 'processed', latest_statement_date = ?, extracted_balance = ?, days_posted = ?, daily_json = ?, error_message = NULL WHERE id = ?`)
          .run(last.date, last.balance, posted, JSON.stringify(days), st.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
      logAudit(req.session.user.username, 'resolve_review', 'statements', st.id, { days: days.length, reason: b.reason });
      return res.json({ ok: true, days_posted: days.length });
    }
    const finalDate = b.statement_date || st.latest_statement_date;
    if (finalBalance == null || !finalDate) return res.status(400).json({ error: 'A balance and a statement date are required to resolve.' });

    db.exec('BEGIN');
    try {
      if (b.corrected_balance != null && b.corrected_balance !== '' && Number(b.corrected_balance) !== st.extracted_balance) {
        db.prepare(`INSERT INTO balance_corrections
          (statement_id, bank_account_id, position_date, original_balance, corrected_balance, reason, corrected_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(st.id, st.bank_account_id, finalDate, st.extracted_balance, Number(b.corrected_balance), b.reason || null, req.session.user.username);
      }
      db.prepare(`DELETE FROM daily_positions WHERE statement_id = ? AND source_type = 'review'`).run(st.id);
      db.prepare(`UPDATE statements SET status = 'processed', latest_statement_date = ?, error_message = NULL WHERE id = ?`).run(finalDate, st.id);
      upsertDailyPosition({
        accountId: st.bank_account_id, date: finalDate, balance: finalBalance,
        sourceType: b.corrected_balance != null && b.corrected_balance !== '' ? 'manual' : 'actual',
        statementId: st.id, status: 'done',
        note: b.reason || 'Resolved from review', actor: req.session.user.username,
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
    logAudit(req.session.user.username, 'resolve_review', 'statements', st.id, { finalBalance, finalDate, reason: b.reason });
    res.json({ ok: true });
  });

  // ---------------- manual correction of an already-posted position ----------------
  app.post('/api/positions/correct', requireSection('corrections'), requireRole('super_user'), (req, res) => {
    const b = req.body || {};
    const { bank_account_id, position_date, corrected_balance, reason } = b;
    if (!bank_account_id || !/^\d{4}-\d{2}-\d{2}$/.test(position_date || '') || corrected_balance == null || !reason)
      return res.status(400).json({ error: 'bank_account_id, position_date, corrected_balance and reason are all required.' });
    const cur = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(bank_account_id, position_date);
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO balance_corrections
        (statement_id, daily_position_id, bank_account_id, position_date, original_balance, corrected_balance, reason, corrected_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cur ? cur.statement_id : null, cur ? cur.id : null, bank_account_id, position_date,
          cur ? cur.balance : null, Number(corrected_balance), reason, req.session.user.username);
      upsertDailyPosition({
        accountId: Number(bank_account_id), date: position_date, balance: Number(corrected_balance),
        sourceType: 'manual', statementId: cur ? cur.statement_id : null, status: 'done',
        note: 'Manual correction: ' + reason, actor: req.session.user.username,
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
    logAudit(req.session.user.username, 'correct', 'daily_positions', `${bank_account_id}@${position_date}`, { corrected_balance, reason });
    res.json({ ok: true });
  });

  app.get('/api/corrections', requireSection('corrections'), (req, res) => {
    res.json(db.prepare(`SELECT bc.*, a.account_title, bk.name AS bank_name, c.name AS company_name
      FROM balance_corrections bc
      JOIN bank_accounts a ON a.id = bc.bank_account_id
      JOIN banks bk ON bk.id = a.bank_id JOIN companies c ON c.id = a.company_id
      ORDER BY bc.corrected_at DESC LIMIT 200`).all());
  });

  // ---------------- audit ----------------
  app.get('/api/audit-log', SU, (req, res) => {
    const { table_name, record_id, limit } = req.query;
    if (table_name && record_id) return res.json(getRecentAudit(table_name, record_id, Number(limit) || 20));
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?').all(Number(limit) || 400));
  });
};

function safe(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
