'use strict';
const fs = require('fs');
const path = require('path');
const { db, logAudit, STORAGE_DIR, setSetting, getSetting } = require('../db');
const { requireAuth, requireSection, requireRole } = require('../auth');
const { status, scan } = require('../services/ingest');
const { processUpload, loadAccount, safeJson } = require('../services/statements');
const { loadAccounts } = require('../services/routing');
const notify = require('../services/notify');

module.exports = function (app) {
  // status of the e-mail agent + inbox watcher (shown on the dashboard / settings)
  app.get('/api/ingest/status', requireAuth, (req, res) => {
    const s = status();
    const today = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'email_import' AND date(created_at) = date('now')`).get().c;
    res.json({ ...s, imported_today: today, enabled: getSetting('ingest_enabled', 'true') !== 'false' });
  });
  app.post('/api/ingest/scan', requireSection('upload'), async (req, res) => { await scan(); res.json(status()); });
  app.put('/api/ingest/enabled', requireRole('super_user'), (req, res) => {
    setSetting('ingest_enabled', req.body && req.body.enabled === false ? 'false' : 'true');
    res.json({ ok: true });
  });

  // accounts to pick from when assigning an unrouted file
  app.get('/api/ingest/accounts', requireSection('review'), (req, res) => {
    res.json(loadAccounts().map((a) => ({ id: a.id, label: `${a.company_name} · ${a.bank_name}`, account_number: a.account_number })));
  });

  // a person tells the system which account an unrouted e-mailed file belongs to
  app.post('/api/statements/:id/assign', requireSection('review'), async (req, res) => {
    try {
      const st = db.prepare(`SELECT * FROM statements WHERE id = ? AND status = 'unrouted' AND deleted_at IS NULL`).get(req.params.id);
      if (!st) return res.status(404).json({ error: 'This file is no longer waiting for an account.' });
      const accountId = Number((req.body || {}).account_id);
      const acc = accountId && loadAccount(accountId);
      if (!acc) return res.status(400).json({ error: 'Choose an account.' });
      const file = path.join(STORAGE_DIR, path.basename(st.stored_path || ''));
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'The stored file is missing.' });
      const detail = safeJson(st.raw_extract_json);
      const out = await processUpload({ buffer: fs.readFileSync(file), originalName: st.file_name, accountId, password: (req.body || {}).password,
        actor: req.session.user.username, meta: { ...(detail.source || {}), assignedBy: req.session.user.username } });
      if (out.needPassword) return res.json(out);
      db.prepare(`UPDATE statements SET status = 'deleted', deleted_at = datetime('now'), deleted_by = ?, delete_reason = 'Assigned to an account' WHERE id = ?`).run(req.session.user.username, st.id);
      // remember the account number printed in the file so the next one routes itself
      const printed = detail.fileInfo && detail.fileInfo.accountNumber;
      // only learn from a clean match: a file the system flagged as a different bank must not teach an account a wrong number
      if (printed && !/x/i.test(printed) && !acc.account_number && out.result && !out.result.mismatch) {
        db.prepare('UPDATE bank_accounts SET account_number = ? WHERE id = ?').run(String(printed).replace(/\s+/g, ''), accountId);
        logAudit(req.session.user.username, 'learn_account_number', 'bank_accounts', accountId, { account_number: printed });
      }
      logAudit(req.session.user.username, 'assign_statement', 'statements', st.id, { account: accountId });
      res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('assign error', e);
      res.status(500).json({ error: 'Processing failed: ' + (e.message || String(e)) });
    }
  });

  // ---- "all statements received" e-mail ----
  app.get('/api/notify/status', requireAuth, (req, res) => res.json(notify.status()));
  app.get('/api/notify/preview', requireRole('super_user'), (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : notify.reportDate();
    const comp = notify.completeness(date);
    let funds = null; try { funds = require('../services/funds').computeFunds(date); } catch {}
    res.json({ date, subject: notify.subjectFor(date), complete: comp.complete, missing: comp.missing, html: notify.buildMessage(date, comp.dash, funds, notify.attachmentNames()) });
  });
  app.post('/api/notify/queue', requireRole('super_user'), async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).date || '') ? req.body.date : notify.reportDate();
    const r = await notify.queue(date, { force: !!(req.body || {}).force, reason: 'queued manually by ' + req.session.user.username });
    if (r.queued) {            // run the Outlook agent now (it sends / saves the draft); otherwise it would wait for the next morning run
      try { require('child_process').execFile('schtasks', ['/run', '/tn', 'BankPositionOutlookAgent'], { windowsHide: true }, (err) => { if (err) console.error('[notify] could not start the agent:', err.message); }); r.agentStarted = true; } catch (e) { console.error('[notify] agent start', e.message); }
    }
    res.json(r);
  });
};
