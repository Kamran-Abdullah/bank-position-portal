'use strict';
/**
 * Inbox watcher. The Outlook agent drops statement attachments (plus a small .json sidecar with the
 * e-mail subject / sender) into "Inbox Drop". This picks them up, decides which bank account each one
 * belongs to, and posts the balances. It also runs once at start-up, so anything that arrived while the
 * portal was switched off is processed as soon as it comes back.
 */
const fs = require('fs');
const path = require('path');
const { db, logAudit, baseDir, getSetting } = require('../db');
const fsx = require('fs');
const { routeFile } = require('./routing');
const { processUpload, storeFile, ALLOWED } = require('./statements');

const INBOX = process.env.BPP_INBOX || path.join(baseDir(), 'Inbox Drop');
const DONE = path.join(INBOX, 'processed');
const FAILED = path.join(INBOX, 'failed');
const ACTOR = 'email-agent';

const stats = { running: false, lastScan: null, lastError: null, imported: 0, review: 0, unrouted: 0, skipped: 0, failed: 0, recent: [] };

function ensureDirs() { for (const d of [INBOX, DONE, FAILED]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } }
function note(entry) { stats.recent.unshift({ at: new Date().toISOString(), ...entry }); stats.recent.length = Math.min(stats.recent.length, 30); }

function moveTo(dir, file) {
  const base = path.basename(file);
  let target = path.join(dir, base);
  if (fs.existsSync(target)) target = path.join(dir, Date.now() + '_' + base);
  fs.renameSync(file, target);
  const side = file + '.json';
  if (fs.existsSync(side)) { try { fs.renameSync(side, target + '.json'); } catch {} }
}

async function handleFile(file) {
  const name = path.basename(file);
  const side = readJson(file + '.json') || {};
  const originalName = side.originalName || name.replace(/^\d{8}-\d{4,6}_[0-9a-f]{4,12}_/, '');
  const meta = { subject: side.subject || null, from: side.from || null, received: side.received || null, mailbox: side.mailbox || null, file: originalName };
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED.includes(ext)) { moveTo(FAILED, file); note({ file: originalName, outcome: 'ignored', detail: 'unsupported file type' }); return; }

  const buffer = fs.readFileSync(file);
  const route = await routeFile({ filePath: file, originalName, subject: meta.subject, sender: meta.from });

  if (route.accountId) {
    // a confident match on bank + company teaches the account its printed number, so later files match by number
    const printed = route.fileInfo && route.fileInfo.accountNumber;
    if (route.learn && printed && !/x/i.test(printed) && /^\d{9,}$/.test(String(printed).replace(/\s+/g, ''))) {
      const acc = db.prepare('SELECT id, account_number FROM bank_accounts WHERE id = ?').get(route.accountId);
      if (acc && !acc.account_number) {
        db.prepare('UPDATE bank_accounts SET account_number = ? WHERE id = ?').run(String(printed).replace(/\s+/g, ''), route.accountId);
        logAudit(ACTOR, 'learn_account_number', 'bank_accounts', route.accountId, { account_number: printed });
        stats.learned = true;
      }
    }
    const out = await processUpload({ buffer, originalName, accountId: route.accountId, actor: ACTOR, source: 'email', skipIfDuplicate: true, meta: { ...meta, routed: route.reason } });
    if (out.skipped) { stats.skipped++; note({ file: originalName, outcome: 'skipped', detail: out.reason === 'duplicate' ? 'already imported' : out.reason }); }
    else if (out.needPassword) { await parkUnrouted(buffer, originalName, ext, meta, route, 'PDF password missing or wrong'); }
    else if (out.result.status === 'processed') { stats.imported++; note({ file: originalName, outcome: 'posted', detail: `${out.result.company} · ${out.result.bank} · ${out.result.days_posted} day(s)` }); }
    else { stats.review++; note({ file: originalName, outcome: 'review', detail: `${out.result.company} · ${out.result.bank}` }); }
    moveTo(DONE, file);
    return;
  }
  await parkUnrouted(buffer, originalName, ext, meta, route, route.reason);
  moveTo(DONE, file);
}

// file could not be matched to an account: keep it in the Review Queue for a person to assign
async function parkUnrouted(buffer, originalName, ext, meta, route, reason) {
  const { hash, storedName } = storeFile(buffer, ext);
  const exists = db.prepare(`SELECT id FROM statements WHERE file_hash = ? AND deleted_at IS NULL AND (status = 'unrouted' OR bank_account_id IS NOT NULL) LIMIT 1`).get(hash);
  if (exists) { stats.skipped++; note({ file: originalName, outcome: 'skipped', detail: 'already in the system' }); return; }
  const info = db.prepare(`INSERT INTO statements (bank_account_id, file_name, file_type, file_hash, stored_path, uploaded_by, uploaded_at, confidence, parser, status, error_message, warnings_json, raw_extract_json)
    VALUES (NULL, ?, ?, ?, ?, ?, datetime('now'), 0, 'unrouted', 'unrouted', ?, ?, ?)`)
    .run(originalName, ext.replace('.', ''), hash, storedName, ACTOR, reason, JSON.stringify([reason]),
      JSON.stringify({ unrouted: true, reason, candidates: route.candidates || [], fileInfo: route.fileInfo || {}, source: meta, needPassword: !!route.needPassword }));
  logAudit(ACTOR, 'email_unrouted', 'statements', Number(info.lastInsertRowid), { file: originalName, reason, subject: meta.subject });
  stats.unrouted++;
  note({ file: originalName, outcome: 'needs account', detail: reason });
}

// files that were parked earlier may match now (new account numbers / aliases learned)
async function retryUnrouted() {
  const rows = db.prepare(`SELECT * FROM statements WHERE status = 'unrouted' AND deleted_at IS NULL ORDER BY id`).all();
  for (const st of rows) {
    const file = path.join(require('../db').STORAGE_DIR, path.basename(st.stored_path || ''));
    if (!fs.existsSync(file)) continue;
    let detail = {}; try { detail = JSON.parse(st.raw_extract_json || '{}'); } catch {}
    const src = detail.source || {};
    try {
      const route = await routeFile({ filePath: file, originalName: st.file_name, subject: src.subject, sender: src.from });
      if (!route.accountId) continue;
      const out = await processUpload({ buffer: fs.readFileSync(file), originalName: st.file_name, accountId: route.accountId, actor: ACTOR, source: 'email', skipIfDuplicate: true, meta: { ...src, routed: route.reason, retried: true } });
      if (out.needPassword) continue;
      db.prepare(`UPDATE statements SET status = 'deleted', deleted_at = datetime('now'), deleted_by = ?, delete_reason = 'Matched to an account automatically' WHERE id = ?`).run(ACTOR, st.id);
      stats.unrouted = Math.max(0, stats.unrouted - 1);
      if (out.result && out.result.status === 'processed') stats.imported++; else if (out.result) stats.review++;
      note({ file: st.file_name, outcome: out.result && out.result.status === 'processed' ? 'posted' : 'review', detail: `matched later: ${route.reason}` });
    } catch (e) { console.error('[ingest] retry', st.file_name, e.message); }
  }
}

let busy = false;
async function scan() {
  if (busy) return;
  if (getSetting('ingest_enabled', 'true') === 'false') return;
  busy = true; stats.running = true;
  try {
    ensureDirs();
    const now = Date.now();
    const files = fs.readdirSync(INBOX, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.endsWith('.json') && !d.name.endsWith('.part') && !d.name.startsWith('agent-'))
      .map((d) => path.join(INBOX, d.name))
      .filter((f) => now - fs.statSync(f).mtimeMs > 2500)
      .sort((a, b) => (/\.(pdf|csv)$/i.test(b) ? 1 : 0) - (/\.(pdf|csv)$/i.test(a) ? 1 : 0) || fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    for (const f of files) {
      try { await handleFile(f); }
      catch (e) {
        stats.failed++; stats.lastError = `${path.basename(f)}: ${e.message}`;
        note({ file: path.basename(f), outcome: 'failed', detail: e.message });
        console.error('[ingest]', path.basename(f), e);
        try { moveTo(FAILED, f); } catch {}
      }
    }
    try { const d = require('./unpresented').scanDispatchFolder(INBOX); if (d.files) { stats.dispatch = d; note({ file: 'Payment Dispatched Details', outcome: 'cheques', detail: `${d.added} new, ${d.excluded} excluded, ${d.known} already known` }); } } catch (e) { console.error('[ingest] dispatch', e.message); }
    if (stats.learned || stats.firstScan !== false) { stats.learned = false; stats.firstScan = false; await retryUnrouted(); }
    stats.lastScan = new Date().toISOString();
  } finally { busy = false; stats.running = false; }
}

function agentHeartbeat() { return readJson(path.join(INBOX, 'agent-heartbeat.json')); }
function status() { return { inbox: INBOX, ...stats, agent: agentHeartbeat(), waiting: fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter((n) => !n.endsWith('.json') && !n.endsWith('.part') && !n.startsWith('agent-') && fs.statSync(path.join(INBOX, n)).isFile()).length : 0 }; }

function start() {
  ensureDirs();
  setTimeout(() => scan().catch((e) => console.error('[ingest] scan', e)), 1500);   // catch-up on start
  setInterval(() => scan().catch((e) => console.error('[ingest] scan', e)), 20000);
}

module.exports = { start, scan, status, INBOX };
