'use strict';
// Shared statement processing used by the Upload button, the email inbox watcher and "assign account".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, logAudit, decryptSecret, encryptSecret, withTransaction, getSetting, STORAGE_DIR } = require('../db');
const { processStatement } = require('../parser');
const { upsertDailyPosition, localToday } = require('../positions');

const ALLOWED = ['.xlsx', '.xls', '.xlsm', '.csv', '.pdf', '.jpg', '.jpeg', '.png'];

function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function loadAccount(accountId) {
  return db.prepare(`
    SELECT a.*, c.name AS company_name, bk.name AS bank_name, bk.parser_key
    FROM bank_accounts a JOIN companies c ON c.id = a.company_id JOIN banks bk ON bk.id = a.bank_id
    WHERE a.id = ? AND a.deleted_at IS NULL`).get(accountId);
}

// Remove a statement's posted balances, soft-delete it, and hand its days back to earlier statements.
// ---- the CURRENT day is the only day an import may change ----
// A statement's latest balance becomes today's position. Earlier days are never written or changed by an import
// (only an administrator can change a past day), and a statement older than the one already behind the account's
// figure never replaces it.
function postToToday({ accountId, statementId, balance, latestDate, actor }) {
  const today = localToday();
  const cur = db.prepare(`SELECT p.*, s.latest_statement_date AS s_latest FROM daily_positions p LEFT JOIN statements s ON s.id = p.statement_id
    WHERE p.bank_account_id = ? AND p.position_date = ?`).get(accountId, today);
  if (cur && cur.source_type === 'manual') return { keptManual: true };
  const prev = db.prepare(`SELECT s.latest_statement_date AS s_latest FROM daily_positions p JOIN statements s ON s.id = p.statement_id
    WHERE p.bank_account_id = ? AND p.position_date < ? AND p.status = 'done' AND p.source_type = 'actual' ORDER BY p.position_date DESC LIMIT 1`).get(accountId, today);
  const newest = [cur && cur.s_latest, prev && prev.s_latest].filter(Boolean).sort().pop();
  if (newest && latestDate < newest) return { skipped: true, note: `This statement ends on ${latestDate}, older than the statement already behind this account (${newest}), so it did not change today's balance.` };
  upsertDailyPosition({ accountId, date: today, balance, sourceType: 'actual', statementId, status: 'done', note: null, actor });
  return { posted: true };
}
// statements uploaded today that were parked only because they disagreed with earlier days: they now simply set today's balance
function repostToday(actor = 'system') {
  const out = { posted: 0, skipped: 0, released: 0 };
  const rows = db.prepare(`SELECT * FROM statements WHERE bank_account_id IS NOT NULL AND deleted_at IS NULL AND status IN ('processed','review')
    AND extracted_balance IS NOT NULL AND latest_statement_date IS NOT NULL AND date(uploaded_at, 'localtime') = ? ORDER BY id`).all(localToday());
  for (const st of rows) {
    const raw = safeJson(st.raw_extract_json);
    if (st.status === 'review' && !(raw.conflicts && raw.conflicts.length)) continue;           // a doubtful reading stays in the Review Queue
    const r = postToToday({ accountId: st.bank_account_id, statementId: st.id, balance: st.extracted_balance, latestDate: st.latest_statement_date, actor });
    if (r.posted) out.posted++; else out.skipped++;
    if (st.status === 'review') {
      delete raw.conflicts;
      db.prepare("UPDATE statements SET status = 'processed', raw_extract_json = ?, days_posted = ? WHERE id = ?").run(JSON.stringify(raw), r.posted ? 1 : 0, st.id);
      out.released++;
    } else db.prepare('UPDATE statements SET days_posted = ? WHERE id = ?').run(r.posted ? 1 : 0, st.id);
  }
  return out;
}

function removeStatement(st, actor, reason) {
  let removed = 0, restored = 0;
  withTransaction(() => {
    const ids = db.prepare('SELECT id FROM daily_positions WHERE statement_id = ? AND source_type != ?').all(st.id, 'manual').map((r) => r.id);
    for (const id of ids) db.prepare('UPDATE balance_corrections SET daily_position_id = NULL WHERE daily_position_id = ?').run(id);
    removed = db.prepare('DELETE FROM daily_positions WHERE statement_id = ? AND source_type != ?').run(st.id, 'manual').changes;
    db.prepare('DELETE FROM cashflow_transactions WHERE statement_id = ?').run(st.id);
    db.prepare(`UPDATE statements SET status = 'deleted', deleted_at = datetime('now'), deleted_by = ?, delete_reason = ? WHERE id = ?`).run(actor, reason, st.id);
    if (st.bank_account_id) {          // only today's figure is restored; earlier days are never rewritten
      const today = localToday();
      const has = db.prepare('SELECT 1 FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(st.bank_account_id, today);
      if (!has) {
        const r = db.prepare(`SELECT * FROM statements WHERE bank_account_id = ? AND status = 'processed' AND deleted_at IS NULL AND extracted_balance IS NOT NULL
          ORDER BY latest_statement_date DESC, id DESC LIMIT 1`).get(st.bank_account_id);
        if (r) { upsertDailyPosition({ accountId: st.bank_account_id, date: today, balance: r.extracted_balance, sourceType: 'actual', statementId: r.id, status: 'done', actor }); restored++; }
      }
    }
  });
  return { removed: Number(removed), restored };
}

function storeFile(buffer, ext) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const storedName = hash + ext;
  const storedPath = path.join(STORAGE_DIR, storedName);
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buffer);
  return { hash, storedName, storedPath };
}

/**
 * Process a file against a known bank account and post the result.
 * opts: { buffer, originalName, accountId, password, actor, skipIfDuplicate, source, meta }
 */
async function processUpload(opts) {
  const { buffer, originalName, accountId, actor = 'system', skipIfDuplicate = false, source = 'upload' } = opts;
  const account = loadAccount(accountId);
  if (!account) throw httpError(404, 'Bank account not found');
  const ext = path.extname(originalName || '').toLowerCase();
  if (!ALLOWED.includes(ext)) throw httpError(400, `Unsupported file type "${ext}". Allowed: Excel, CSV, PDF, JPG, PNG.`);

  const { hash, storedName, storedPath } = storeFile(buffer, ext);
  const dup = db.prepare(`SELECT * FROM statements WHERE file_hash = ? AND bank_account_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT 1`).get(hash, accountId);
  if (dup && skipIfDuplicate) return { skipped: true, reason: 'duplicate', statement_id: dup.id };

  const password = opts.password || decryptSecret(account.statement_password_enc) || undefined;
  const result = await processStatement({
    filePath: storedPath, originalName, password,
    expected: { bankName: account.bank_name, bankParserKey: account.parser_key, accountNumber: account.account_number, matchHints: safeJson(account.match_hints_json) },
    confidenceThreshold: Number(getSetting('confidence_threshold', '0.75')),
  });
  if (result.status === 'need_password') {
    return { needPassword: true, badPassword: !!password,
      message: password ? 'The stored/entered PDF password did not work.' : 'This PDF is password protected. Enter its password to continue.' };
  }

  // Askari: the PDF statement is authoritative. A NexCash spreadsheet is ignored when a PDF already covers its dates.
  if (result.parser === 'askari' && ext !== '.pdf' && result.latestStatementDate) {
    const pdf = db.prepare(`SELECT id FROM statements WHERE bank_account_id = ? AND parser = 'askari' AND file_type = 'pdf' AND status = 'processed'
      AND deleted_at IS NULL AND latest_statement_date >= ? LIMIT 1`).get(accountId, result.latestStatementDate);
    if (pdf) return { skipped: true, reason: 'Askari PDF statement already covers these dates - the spreadsheet is ignored', statement_id: pdf.id };
  }

  let replacedPrevious = false;
  if (dup) { removeStatement(dup, actor, 'Replaced by re-upload'); replacedPrevious = true; }
  if (opts.password && ext === '.pdf') db.prepare('UPDATE bank_accounts SET statement_password_enc = ? WHERE id = ?').run(encryptSecret(opts.password), accountId);

  const info = db.prepare(`INSERT INTO statements
    (bank_account_id, company_id, bank_id, file_name, file_type, file_hash, stored_path, uploaded_by, uploaded_at,
     statement_from, statement_to, latest_statement_date, opening_balance, closing_balance_reported, extracted_balance,
     currency, confidence, parser, method, status, error_message, warnings_json, raw_extract_json, page_count, txn_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, account.company_id, account.bank_id, originalName, result.fileType, hash, storedName, actor,
      result.periodFrom, result.periodTo, result.latestStatementDate, result.openingBalance, result.closingBalanceReported,
      result.extractedBalance, result.currency || account.currency, result.confidence, result.parser, result.method, result.status, result.error,
      JSON.stringify(result.warnings || []),
      JSON.stringify({ checks: result.checks, bankGuess: result.bankGuess, accountNumber: result.accountNumber, mismatch: result.mismatch || false,
        ocrText: result.ocrText ? String(result.ocrText).slice(0, 4000) : undefined, photoRows: result.photoRows, dailyBalances: result.dailyBalances,
        source: opts.meta || undefined }),
      result.pageCount, result.txnCount);
  const statementId = Number(info.lastInsertRowid);
  logAudit(actor, source === 'email' ? 'email_import' : 'upload', 'statements', statementId, {
    account: accountId, status: result.status, balance: result.extractedBalance, confidence: result.confidence, file: originalName, meta: opts.meta || undefined });

  let daysPosted = 0, daysKeptManual = 0, firstDay = null, lastDay = null;
  const conflicts = [];
  let finalStatus = result.status;
  // Only the CURRENT day takes impact: the statement's latest balance becomes today's position.
  if (result.status === 'processed' && result.extractedBalance != null && result.latestStatementDate) {
    const o = postToToday({ accountId, statementId, balance: result.extractedBalance, latestDate: result.latestStatementDate, actor });
    if (o.posted) { daysPosted = 1; firstDay = lastDay = localToday(); }
    if (o.keptManual) daysKeptManual = 1;
    db.prepare('UPDATE statements SET days_posted = ?, daily_json = ? WHERE id = ?').run(daysPosted, JSON.stringify(result.dailyBalances || []), statementId);
    if (o.note) { result.warnings = [...(result.warnings || []), o.note]; db.prepare('UPDATE statements SET warnings_json = ? WHERE id = ?').run(JSON.stringify(result.warnings), statementId); }
  } else if (result.status === 'review' && result.latestStatementDate) {
    // a doubtful reading is only ever a "review" figure for today and never replaces a confirmed one
    const have = db.prepare('SELECT status FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(accountId, localToday());
    if (!(have && have.status === 'done')) upsertDailyPosition({ accountId, date: localToday(), balance: result.extractedBalance, sourceType: 'review', statementId, status: 'review',
      note: (result.warnings || []).join(' | '), actor });
  }

  if (result.parser === 'askari' && ext === '.pdf' && finalStatus === 'processed' && result.latestStatementDate) {
    const waiting = db.prepare(`SELECT * FROM statements WHERE bank_account_id = ? AND parser = 'askari' AND file_type != 'pdf' AND status = 'review'
      AND deleted_at IS NULL AND latest_statement_date <= ?`).all(accountId, result.latestStatementDate);
    for (const w of waiting) removeStatement(w, actor, 'Superseded by the Askari PDF statement');
  }

  // cashflow module: tag every transaction line into Receipts/Payments categories
  try {
    if (result.txnList && result.txnList.length) {
      require('./cashflow').ingestStatementTransactions({
        statementId, bankAccountId: accountId, companyId: account.company_id, bankId: account.bank_id, txns: result.txnList,
      });
    }
  } catch (e) { console.error('[cashflow] ingest', e.message); }

  // unpresented cheques: a debit with the same cheque number and amount closes the cheque
  try {
    const U = require('./unpresented');
    if (finalStatus !== 'unrouted') {
      const mt = U.matchTransactions(accountId, result.txnList || [], { statementId, fileName: originalName });
      if (mt.presented || mt.flagged) logAudit(actor, 'cheques_matched', 'statements', statementId, mt);
      if (['.jpg', '.jpeg', '.png'].includes(ext)) U.matchPhotoFile(accountId, storedPath, { statementId, fileName: originalName, date: result.latestStatementDate }).catch((e) => console.error('[unpresented] photo', e.message));
    }
  } catch (e) { console.error('[unpresented] match', e.message); }
  return {
    ok: true, replaced_previous: replacedPrevious, statement_id: statementId,
    result: {
      status: finalStatus, company: account.company_name, bank: account.bank_name, account_title: account.account_title, file_name: originalName,
      latest_statement_date: result.latestStatementDate, extracted_balance: result.extractedBalance, opening_balance: result.openingBalance,
      closing_balance_reported: result.closingBalanceReported, currency: result.currency || account.currency, confidence: result.confidence,
      method: result.method, parser: result.parser, txn_count: result.txnCount,
      days_posted: daysPosted, days_kept_manual: daysKeptManual, first_day: firstDay, last_day: lastDay, conflicts: conflicts.length,
      warnings: result.warnings, error: result.error, checks: result.checks, mismatch: result.mismatch || false,
    },
  };
}

module.exports = { processUpload, postToToday, repostToday, removeStatement, storeFile, loadAccount, ALLOWED, safeJson, httpError };
