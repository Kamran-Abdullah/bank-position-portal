'use strict';
/**
 * Unpresented cheques: cheques that were issued and dispatched but have not yet cleared the bank.
 *   - the list is fed from the daily "Payment Dispatched Details" e-mail (picked up by the Outlook agent) or typed in
 *   - every processed bank statement is searched for them: a debit that carries the same cheque number AND the same
 *     amount marks the cheque as presented (it leaves the open list; the history is kept)
 *   - a cheque number found with a DIFFERENT amount is never closed automatically: it is flagged for a person
 *   - a one-off import of the existing Excel list ("Un-Presented Cheques ...") brings today's open cheques in
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const { db, getSetting, setSetting, logAudit, decryptSecret, STORAGE_DIR } = require('../db');

const SECTION_DEFAULT = { 'habib metro': 1, 'northwind health hmb': 6, 'bank al habib': 2, 'contoso aesthetic': 10, 'askari bank': 3 };
const LABEL_DEFAULT = { health: 6, 'abcd pharma pvt ltd': 1 };

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : NaN; };
const stripZ = (s) => String(s).replace(/^0+/, '');
const round2 = (n) => Math.round(n * 100) / 100;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const jsetting = (key, dflt) => { try { return { ...dflt, ...JSON.parse(getSetting(key, '{}') || '{}') }; } catch { return { ...dflt }; } };

// "30/6/2026", "30-06-2026" (day first) -> 2026-06-30
function dmyToISO(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) { const iso = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return iso ? iso[0] : null; }
  const d = +m[1], mo = +m[2], y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Excel turned some day-first dates (typed 01/10/2026) into month-first dates (Jan 10): swap them back
function excelDateToISO(dt) {
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
  if (d <= 12) return `${y}-${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function accounts() {
  return db.prepare(`SELECT a.id, a.account_number, c.name AS company, bk.name AS bank, bk.parser_key, a.display_order
    FROM bank_accounts a JOIN companies c ON c.id = a.company_id JOIN banks bk ON bk.id = a.bank_id
    WHERE a.deleted_at IS NULL AND a.status = 'active' ORDER BY c.display_order, a.display_order, a.id`).all();
}
function accountLabel(id) { const a = accounts().find((x) => x.id === Number(id)); return a ? `${a.bank} · ${a.company}` : 'Not assigned'; }
function labelToAccount(label) {
  const map = jsetting('unpresented_label_map', LABEL_DEFAULT);
  const k = norm(label);
  // the e-mail has no company column (or it is empty): these belong to the default company account (HMB)
  if (!k) return Number(getSetting('unpresented_default_account', '1')) || null;
  return map[k] != null ? Number(map[k]) : null;
}

// ---------------------------------------------------------------- the daily e-mail
function parseDispatchHtml(html) {
  const $ = cheerio.load(html);
  const rows = []; let col = null;
  $('tr').each((_, tr) => {
    if ($(tr).find('tr').length) return;                         // only innermost rows
    const cells = $(tr).children('td,th').map((i, td) => $(td).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 5) return;
    const lc = cells.map((c) => c.toLowerCase());
    if (lc.some((c) => /chq\s*(number|no)|cheque\s*(number|no)/.test(c))) {
      col = {
        company: lc.findIndex((c) => /company/.test(c)), chqDate: lc.findIndex((c) => /(chq|cheque)\s*date/.test(c)),
        no: lc.findIndex((c) => /(chq|cheque)\s*(number|no)/.test(c)), party: lc.findIndex((c) => /party/.test(c)),
        amount: lc.findIndex((c) => /^amount/.test(c)), status: lc.findIndex((c) => /^status/.test(c)),
        method: lc.findIndex((c) => /^dispatched$/.test(c)), dispDate: lc.findIndex((c) => /dispatch\s*date/.test(c)),
      };
      if (col.party < 0 && col.no >= 0) { const blank = lc.findIndex((c, i) => c === '' && i > col.no); col.party = blank >= 0 ? blank : col.no + 1; }
      return;
    }
    if (!col || col.no < 0) return;
    const no = String(cells[col.no] || '').replace(/\D/g, '');
    const amount = num(cells[col.amount]);
    if (no.length < 5 || !isFinite(amount) || amount <= 0) return;
    rows.push({
      company: col.company >= 0 ? cells[col.company] : '', cheque_no: no, party: col.party >= 0 ? cells[col.party] : '', amount,
      cheque_date: col.chqDate >= 0 ? dmyToISO(cells[col.chqDate]) : null,
      dispatch_date: col.dispDate >= 0 ? dmyToISO(cells[col.dispDate]) : null,
      method: col.method >= 0 ? cells[col.method] : '', status: col.status >= 0 ? cells[col.status] : '',
    });
  });
  return rows;
}

const insStmt = () => db.prepare(`INSERT OR IGNORE INTO unpresented_cheques
  (bank_account_id, cheque_no, party, amount, cheque_date, dispatch_date, dispatch_note, company_label, source, source_ref, status, note, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// rows from an e-mail: only cheques that were really "Dispatched" are outstanding; by-hand / office pick-ups are kept aside as excluded
function ingestDispatchRows(rows, { ref, received } = {}) {
  const ins = insStmt(), after = getSetting('unpresented_email_after', '');
  // emails that arrived before the Excel list was imported are already inside it; every email after that is taken in full, whatever dates its rows carry
  if (after && received && String(received) <= after) { return { added: 0, excluded: 0, known: 0, old: rows.length, unassigned: 0 }; }
  const out = { added: 0, excluded: 0, known: 0, old: 0, unassigned: 0 };
  for (const r of rows) {
    const acc = labelToAccount(r.company);
    const dispatched = /^dispatched$/i.test(String(r.method || '').trim());
    const status = dispatched ? 'open' : 'excluded';
    const note = dispatched ? null : `Dispatch: ${r.method || 'n/a'} (not counted as outstanding)`;
    const info = ins.run(acc, r.cheque_no, r.party || null, r.amount, r.cheque_date || null, r.dispatch_date || null, r.method || null, r.company || null, 'email', ref || null, status, note, 'email-agent');
    if (!info.changes) { out.known++; continue; }
    if (dispatched) { out.added++; if (acc == null) out.unassigned++; } else out.excluded++;
  }
  if (out.added) syncFundsHead();
  if (out.added || out.excluded) logAudit('email-agent', 'unpresented_email', 'unpresented_cheques', ref || null, { ...out, received });
  return out;
}

// Inbox Drop\dispatch\*.html  (+ .json sidecar written by the Outlook agent)
function scanDispatchFolder(inbox) {
  const dir = path.join(inbox, 'dispatch'), done = path.join(inbox, 'processed');
  if (!fs.existsSync(dir)) return { files: 0 };
  let files = 0; const total = { added: 0, excluded: 0, known: 0, old: 0, unassigned: 0 };
  for (const f of fs.readdirSync(dir).filter((n) => /\.html?$/i.test(n))) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs < 2500) continue;
    let side = {}; try { side = JSON.parse(fs.readFileSync(p + '.json', 'utf8').replace(/^﻿/, '')); } catch {}
    try {
      const html = fs.readFileSync(p, 'utf8');
      const rows = parseDispatchHtml(html);
      const r = ingestDispatchRows(rows, { ref: side.entryShort || f, received: side.received });
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
      files++;
      if (!fs.existsSync(done)) fs.mkdirSync(done, { recursive: true });
      fs.renameSync(p, path.join(done, f));
      if (fs.existsSync(p + '.json')) fs.renameSync(p + '.json', path.join(done, f + '.json'));
    } catch (e) { console.error('[unpresented] dispatch file', f, e.message); }
  }
  return { files, ...total };
}

// ---------------------------------------------------------------- the existing Excel list (one-off import)
async function importWorkbook(buffer, actor = 'system') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((w) => w.name !== 'BS') || wb.worksheets[0];
  const secMap = jsetting('unpresented_section_map', SECTION_DEFAULT);
  const val = (c) => {
    let x = c.value;
    if (x && typeof x === 'object' && !(x instanceof Date)) { if (x.result !== undefined) x = x.result; else if (x.richText) x = x.richText.map((t) => t.text).join(''); else if (x.text) x = x.text; else return null; }
    return x;
  };
  const ins = insStmt(); let section = null, acc = null;
  const out = { added: 0, known: 0, skipped: 0, sections: {}, maxDispatch: null };
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r), a = val(row.getCell(1)), b = val(row.getCell(2));
    if (typeof a === 'string' && !/^un-?presented/i.test(a) && !/^sr/i.test(a) && !/grand total/i.test(a) && secMap[norm(a)] !== undefined) { section = a; acc = Number(secMap[norm(a)]); continue; }
    if (acc == null) continue;
    const no = typeof b === 'number' ? String(b) : (typeof b === 'string' ? b.replace(/\D/g, '') : '');
    const amount = num(val(row.getCell(4)));
    if (no.length < 5 || !isFinite(amount) || amount <= 0) { if (no || amount) out.skipped++; continue; }
    const dv = val(row.getCell(5));
    const dispatch = dv instanceof Date ? excelDateToISO(dv) : dmyToISO(dv);
    const info = ins.run(acc, no, String(val(row.getCell(3)) || '').trim() || null, amount, null, dispatch, null, section, 'import', path.basename(ws.name || 'workbook'), 'open', null, actor);
    if (info.changes) { out.added++; out.sections[section] = (out.sections[section] || 0) + 1; } else out.known++;
    if (dispatch && (!out.maxDispatch || dispatch > out.maxDispatch)) out.maxDispatch = dispatch;
  }
  if (!getSetting('unpresented_email_after', '')) { const n = new Date(); setSetting('unpresented_email_after', `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}T${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}:${String(n.getSeconds()).padStart(2, '0')}`); }
  logAudit(actor, 'unpresented_import', 'unpresented_cheques', null, { added: out.added, known: out.known, baseline: getSetting('unpresented_email_after', '') });
  syncFundsHead();
  // the workbook's second sheet ("BS") is the bank statement of the first section's account: use it to close what already cleared
  const bs = wb.worksheets.find((w) => w.name === 'BS');
  if (bs && secMap['habib metro']) {
    const txns = [];
    for (let r = 2; r <= bs.rowCount; r++) {
      const row = bs.getRow(r), d = val(row.getCell(1));
      const date = d instanceof Date ? d.toISOString().slice(0, 10) : dmyToISO(String(d || '').replace(/-/g, ' ').replace(/(\d+) ([A-Za-z]{3}) (\d+)/, (m, dd, mon, yy) => `${dd}/${['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(mon.toLowerCase()) + 1}/${yy}`));
      txns.push({ date, description: String(val(row.getCell(2)) || ''), debit: num(val(row.getCell(3))) || 0, credit: num(val(row.getCell(4))) || 0 });
    }
    out.bs = matchTransactions(Number(secMap['habib metro']), txns, { fileName: 'BS sheet of the workbook', by: actor });
  }
  return out;
}

// ---------------------------------------------------------------- matching against bank statements
function markPresented(c, date, { statementId, amount, by = 'auto', fileName } = {}) {
  db.prepare(`UPDATE unpresented_cheques SET status = 'presented', presented_date = ?, presented_statement_id = ?, presented_amount = ?, presented_by = ?,
    flag = NULL, flag_detail = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'open'`)
    .run(date || todayISO(), statementId || null, amount != null ? amount : c.amount, by, c.id);
  logAudit(by, 'cheque_presented', 'unpresented_cheques', c.id, { cheque: c.cheque_no, amount: c.amount, date, statement: fileName || statementId || null });
  syncFundsHead();
}
function setFlag(c, flag, detail) {
  if (c.flag === flag && c.flag_detail === detail) return false;
  db.prepare("UPDATE unpresented_cheques SET flag = ?, flag_detail = ?, updated_at = datetime('now') WHERE id = ?").run(flag, detail, c.id);
  return true;
}
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// cheque numbers are unique per bank, so a statement of ANY account of that bank can close a cheque (number AND amount must agree)
const openForBank = (accountId) => db.prepare(`SELECT u.* FROM unpresented_cheques u LEFT JOIN bank_accounts a ON a.id = u.bank_account_id
    WHERE u.status = 'open' AND (u.bank_account_id = ? OR u.bank_account_id IS NULL OR a.bank_id = (SELECT bank_id FROM bank_accounts WHERE id = ?))`).all(accountId, accountId);

// txns: [{date, description, debit, credit}]
function matchTransactions(accountId, txns, ctx = {}) {
  const res = { presented: 0, flagged: 0, checked: 0 };
  if (!accountId || !Array.isArray(txns) || !txns.length) return res;
  const open = openForBank(accountId);
  if (!open.length) return res;
  const byNo = new Map(open.map((c) => [stripZ(c.cheque_no), c]));
  res.checked = open.length;
  for (const t of txns) {
    const debit = Number(t.debit) || 0;
    if (debit <= 0) continue;
    const nums = (String(t.description || '').match(/(?<!\d)\d{5,10}(?!\d)/g) || []).map(stripZ);
    for (const n of nums) {
      const c = byNo.get(n);
      if (!c) continue;
      if (Math.abs(round2(c.amount) - round2(debit)) < 0.005) {
        markPresented(c, t.date, { statementId: ctx.statementId, amount: debit, by: ctx.by || 'auto', fileName: ctx.fileName });
        byNo.delete(n); res.presented++;
      } else if (setFlag(c, 'amount_mismatch', `Bank statement${ctx.fileName ? ' (' + ctx.fileName + ')' : ''} shows this cheque number for ${fmt(debit)} on ${t.date || '?'}; the list says ${fmt(c.amount)}`)) res.flagged++;
      break;
    }
  }
  return res;
}

// photo statements have no table, and the amounts sit in their own column away from the description:
// the cheque number must be read somewhere in the text AND the exact amount must appear among the amounts of the same photo
function matchOcrText(accountId, text, ctx = {}) {
  const res = { presented: 0, flagged: 0, checked: 0 };
  if (!accountId || !text) return res;
  const open = openForBank(accountId);
  if (!open.length) return res;
  res.checked = open.length;
  const lines = String(text).split(/\r?\n/);
  const amountsIn = (s) => (String(s).match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}/g) || []).map((x) => round2(Number(x.replace(/,/g, ''))));
  const allAmounts = new Set(amountsIn(text));
  for (const c of open) {
    const no = stripZ(c.cheque_no);
    const i = lines.findIndex((l) => new RegExp(`(?<!\\d)0*${no}(?!\\d)`).test(l));
    if (i < 0) continue;
    if (allAmounts.has(round2(c.amount))) markPresented(c, ctx.date, { statementId: ctx.statementId, by: ctx.by || 'auto (photo)', fileName: ctx.fileName }), res.presented++;
    else if (setFlag(c, 'photo_unconfirmed', `Cheque number seen in the photo ${ctx.fileName || ''} but its amount ${fmt(c.amount)} was not found among the amounts in the photo - check it`)) res.flagged++;
  }
  return res;
}

// a photo statement: read its text once (slow) and look for open cheques; runs in the background
async function matchPhotoFile(accountId, file, ctx = {}) {
  const open = openForBank(accountId).length;
  if (!open) return { presented: 0, flagged: 0, checked: 0 };
  const { ocrImage } = require('../parser/ocr');
  const o = await ocrImage(file);
  return matchOcrText(accountId, o.text, { ...ctx, by: 'auto (photo)' });
}

// re-check recent stored statements (after an import, or on demand)
async function rematchRecent({ days = 45, photos = false } = {}) {
  const { processStatement } = require('../parser');
  const banks = db.prepare("SELECT DISTINCT a.bank_id FROM unpresented_cheques u JOIN bank_accounts a ON a.id = u.bank_account_id WHERE u.status = 'open'").all().map((r) => r.bank_id);
  const ids = banks.length ? db.prepare(`SELECT id FROM bank_accounts WHERE deleted_at IS NULL AND bank_id IN (${banks.map(() => '?').join(',')})`).all(...banks).map((r) => r.id) : [];
  const out = { statements: 0, presented: 0, flagged: 0 };
  for (const id of ids) {
    const acc = db.prepare('SELECT a.*, bk.name AS bank_name, bk.parser_key FROM bank_accounts a JOIN banks bk ON bk.id = a.bank_id WHERE a.id = ?').get(id);
    if (!acc) continue;
    const sts = db.prepare(`SELECT * FROM statements WHERE bank_account_id = ? AND deleted_at IS NULL AND status IN ('processed','review')
      AND date(uploaded_at) >= date('now', ?) ORDER BY id`).all(id, `-${Number(days) || 45} days`);
    for (const st of sts) {
      const file = path.join(STORAGE_DIR, path.basename(st.stored_path || ''));
      if (!fs.existsSync(file)) continue;
      const isPhoto = /^(jpe?g|png)$/i.test(st.file_type || '');
      try {
        if (isPhoto) {
          if (!photos) continue;
          const { ocrImage } = require('../parser/ocr');
          const o = await ocrImage(file);
          const r = matchOcrText(id, o.text, { statementId: st.id, fileName: st.file_name, date: st.latest_statement_date, by: 'auto (photo)' });
          out.statements++; out.presented += r.presented; out.flagged += r.flagged;
        } else {
          const r0 = await processStatement({ filePath: file, originalName: st.file_name, password: decryptSecret(acc.statement_password_enc) || undefined,
            expected: { bankName: acc.bank_name, bankParserKey: acc.parser_key, accountNumber: acc.account_number }, confidenceThreshold: 0.5 });
          const r = matchTransactions(id, r0.txnList || [], { statementId: st.id, fileName: st.file_name });
          out.statements++; out.presented += r.presented; out.flagged += r.flagged;
        }
      } catch (e) { console.error('[unpresented] rematch', st.file_name, e.message); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the "Unpresented Cheques" reserve of Available Funds follows the open list
function linkedHeadId() {
  let id = Number(getSetting('unpresented_head_id', '')) || null;
  if (id && !db.prepare('SELECT 1 FROM reserve_heads WHERE id = ? AND deleted_at IS NULL').get(id)) id = null;
  if (!id) {
    const h = db.prepare("SELECT id FROM reserve_heads WHERE deleted_at IS NULL AND lower(name) LIKE 'unpresented%' ORDER BY id LIMIT 1").get();
    if (h) { id = h.id; setSetting('unpresented_head_id', String(id)); }
  }
  return id;
}
function syncFundsHead() {
  try {
    const id = linkedHeadId();
    if (!id) return;
    const t = db.prepare("SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM unpresented_cheques WHERE status = 'open'").get();
    db.prepare(`INSERT INTO reserve_values (head_id, as_of, amount, note, updated_by) VALUES (?, ?, ?, ?, 'unpresented list')
      ON CONFLICT(head_id, as_of) DO UPDATE SET amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(id, todayISO(), round2(t.t), `Automatic: ${t.n} open cheque(s) in the Unpresented Cheques list`);
  } catch (e) { console.error('[unpresented] funds link', e.message); }
}

// ---------------------------------------------------------------- reading / editing
const ORDER = [1, 6, 2, 10, 3];          // the order of the sections in the Excel list: HMB, Health HMB, BAHL, Aesthetic, Askari
function sectionTitle(id) {
  return ({ 1: 'HABIB METRO', 6: 'NORTHWIND HEALTH HMB', 2: 'BANK AL HABIB', 10: 'CONTOSO AESTHETIC', 3: 'ASKARI BANK' })[id] || null;
}
function list({ status = 'open' } = {}) {
  const rows = db.prepare(`SELECT * FROM unpresented_cheques WHERE status = ? ORDER BY COALESCE(dispatch_date, '9999'), id`).all(status);
  const accs = accounts(), byId = new Map(accs.map((a) => [a.id, a]));
  const groups = new Map();
  const sec = (id) => {
    if (!groups.has(id)) { const a = byId.get(id); groups.set(id, { account_id: id, title: id ? (sectionTitle(id) || (a ? `${a.bank} · ${a.company}` : `Account ${id}`)) : 'NOT ASSIGNED TO A BANK ACCOUNT', label: id ? accountLabel(id) : 'Not assigned', rows: [], total: 0 }); }
    return groups.get(id);
  };
  if (status === 'open') ORDER.forEach((id) => sec(id));
  for (const r of rows) { const g = sec(r.bank_account_id || 0); g.rows.push(r); g.total += r.amount; }
  const sections = [...groups.values()].sort((a, b) => {
    const ia = ORDER.indexOf(a.account_id), ib = ORDER.indexOf(b.account_id);
    return (ia < 0 ? 99 + a.account_id : ia) - (ib < 0 ? 99 + b.account_id : ib);
  }).filter((g) => g.rows.length || status === 'open');
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM unpresented_cheques GROUP BY status').all().map((r) => [r.status, r.n]));
  return { status, sections, total: sections.reduce((s, g) => s + g.total, 0), count: rows.length, counts,
    flagged: db.prepare("SELECT COUNT(*) AS n FROM unpresented_cheques WHERE status = 'open' AND flag IS NOT NULL").get().n,
    accounts: accs.map((a) => ({ id: a.id, label: `${a.bank} · ${a.company}` })), baseline: getSetting('unpresented_email_after', '') };
}
function openTotal() { return db.prepare("SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM unpresented_cheques WHERE status = 'open'").get(); }

function add(b, actor) {
  const no = String(b.cheque_no || '').replace(/\D/g, ''), amount = num(b.amount);
  if (no.length < 5) throw Object.assign(new Error('Enter the cheque number.'), { status: 400 });
  if (!isFinite(amount) || amount <= 0) throw Object.assign(new Error('Enter the amount.'), { status: 400 });
  const info = insStmt().run(b.bank_account_id ? Number(b.bank_account_id) : null, no, String(b.party || '').trim() || null, amount, null,
    dmyToISO(b.dispatch_date) || (/^\d{4}-\d{2}-\d{2}$/.test(b.dispatch_date || '') ? b.dispatch_date : todayISO()), null, null, 'manual', null, 'open', String(b.note || '').trim() || null, actor);
  if (!info.changes) throw Object.assign(new Error('This cheque number is already in the list for that bank account.'), { status: 409 });
  logAudit(actor, 'cheque_add', 'unpresented_cheques', Number(info.lastInsertRowid), { cheque: no, amount });
  syncFundsHead();
  return Number(info.lastInsertRowid);
}
function update(id, b, actor) {
  const c = db.prepare('SELECT * FROM unpresented_cheques WHERE id = ?').get(id);
  if (!c) throw Object.assign(new Error('Not found'), { status: 404 });
  const amount = b.amount !== undefined ? num(b.amount) : c.amount;
  if (!isFinite(amount) || amount <= 0) throw Object.assign(new Error('Enter a valid amount.'), { status: 400 });
  const disp = b.dispatch_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.dispatch_date) ? b.dispatch_date : dmyToISO(b.dispatch_date)) : c.dispatch_date;
  const acc = b.bank_account_id !== undefined ? (b.bank_account_id ? Number(b.bank_account_id) : null) : c.bank_account_id;
  const no = b.cheque_no !== undefined ? String(b.cheque_no).replace(/\D/g, '') : c.cheque_no;
  try {
    db.prepare(`UPDATE unpresented_cheques SET bank_account_id = ?, cheque_no = ?, party = ?, amount = ?, dispatch_date = ?, note = ?,
      flag = CASE WHEN ? <> amount THEN NULL ELSE flag END, flag_detail = CASE WHEN ? <> amount THEN NULL ELSE flag_detail END, updated_at = datetime('now') WHERE id = ?`)
      .run(acc, no, b.party !== undefined ? String(b.party).trim() : c.party, amount, disp, b.note !== undefined ? b.note : c.note, amount, amount, id);
  } catch (e) { throw Object.assign(new Error('That cheque number already exists for this bank account.'), { status: 409 }); }
  logAudit(actor, 'cheque_edit', 'unpresented_cheques', id, b);
  syncFundsHead();
}
function present(id, date, actor) {
  const c = db.prepare("SELECT * FROM unpresented_cheques WHERE id = ? AND status = 'open'").get(id);
  if (!c) throw Object.assign(new Error('This cheque is not open.'), { status: 404 });
  markPresented(c, /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todayISO(), { by: actor });
}
function reopen(id, actor) {
  db.prepare("UPDATE unpresented_cheques SET status = 'open', presented_date = NULL, presented_statement_id = NULL, presented_amount = NULL, presented_by = NULL, flag = NULL, flag_detail = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  logAudit(actor, 'cheque_reopen', 'unpresented_cheques', id, null);
  syncFundsHead();
}
function remove(id, actor) {
  db.prepare("UPDATE unpresented_cheques SET status = 'removed', updated_at = datetime('now') WHERE id = ?").run(id);
  logAudit(actor, 'cheque_remove', 'unpresented_cheques', id, null);
  syncFundsHead();
}
function dismissFlag(id, actor) {
  db.prepare("UPDATE unpresented_cheques SET flag = NULL, flag_detail = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  logAudit(actor, 'cheque_flag_dismiss', 'unpresented_cheques', id, null);
}

// ---------------------------------------------------------------- Excel export, same layout as the hand-kept sheet
async function exportWorkbook(asOf) {
  const data = list({ status: 'open' });
  const wb = new ExcelJS.Workbook();
  const d = new Date((asOf || todayISO()) + 'T00:00:00');
  const title = `Un-Presented Cheques as on ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  const ws = wb.addWorksheet(`${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`);
  ws.columns = [{ width: 10 }, { width: 14 }, { width: 55 }, { width: 18 }, { width: 16 }];
  const bold = { bold: true };
  const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const fmtN = '_(* #,##0_);_(* (#,##0);_(* "-"??_);_(@_)';
  const dd = (iso) => { if (!iso) return ''; const [y, m, dy] = iso.split('-'); return `${dy}/${m}/${y}`; };
  let grand = 0; const totalCells = [];
  for (const g of data.sections) {
    ws.addRow([title]).font = { bold: true, size: 13 };
    ws.addRow([g.title]).font = bold;
    const h = ws.addRow(['Sr. No.', 'Chq #', 'Party Name', 'Amount', 'Dispatched Date']); h.font = bold; h.eachCell((c) => { c.border = border; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } }; });
    const first = ws.rowCount + 1;
    g.rows.forEach((r, i) => {
      const row = ws.addRow([i + 1, Number(r.cheque_no), r.party || '', r.amount, dd(r.dispatch_date)]);
      row.getCell(4).numFmt = fmtN; row.eachCell((c) => { c.border = border; });
    });
    const last = ws.rowCount;
    const t = ws.addRow([null, null, 'Total', g.rows.length ? { formula: `SUM(D${first}:D${last})`, result: g.total } : 0]);
    t.font = bold; t.getCell(4).numFmt = fmtN; t.getCell(3).alignment = { horizontal: 'right' };
    totalCells.push(`D${t.number}`); grand += g.total;
    ws.addRow([]); ws.addRow([]);
  }
  const gt = ws.addRow(['GRAND TOTAL', null, null, { formula: totalCells.length ? totalCells.join('+') : '0', result: grand }]);
  gt.font = bold; gt.getCell(4).numFmt = fmtN;
  return wb.xlsx.writeBuffer();
}

module.exports = {
  syncFundsHead, linkedHeadId, parseDispatchHtml, ingestDispatchRows, scanDispatchFolder, importWorkbook, matchTransactions, matchOcrText, matchPhotoFile, rematchRecent,
  list, openTotal, add, update, present, reopen, remove, dismissFlag, exportWorkbook, accounts, accountLabel, dmyToISO,
};
