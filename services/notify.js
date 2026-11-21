'use strict';
/**
 * "All statements are in" e-mail.
 * When every active account has a confirmed (actual / manual) balance for today, or a statement uploaded today, one summary
 * message is written to Inbox Drop/outbox. The Outlook agent turns it into a DRAFT (default, safe) or sends it
 * straight away - chosen in Settings. Nothing is sent until recipients are entered and the feature is switched on.
 */
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting, logAudit, baseDir } = require('../db');
const { getDashboard, isOffDay } = require('../positions');
const { computeFunds } = require('./funds');
const { monthlyReportPdf, dailyReportPdf, unpresentedReportPdf } = require('./reportPdf');
const INBOX = process.env.BPP_INBOX || path.join(baseDir(), 'Inbox Drop');

const OUTBOX = path.join(INBOX, 'outbox');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const iso = (d) => d.toISOString().slice(0, 10);

function cfg() {
  return {
    enabled: getSetting('notify_enabled', 'false') === 'true',
    mode: getSetting('notify_mode', 'draft') === 'send' ? 'send' : 'draft',
    to: getSetting('notify_to', ''),
    cc: getSetting('notify_cc', ''),
    subject: getSetting('notify_subject', 'Bank Position - {date}'),
    notBefore: getSetting('notify_not_before', '00:00'),
    attachDaily: getSetting('notify_attach_daily', 'true') !== 'false',
    attachMonthly: getSetting('notify_attach_monthly', 'true') !== 'false',
    attachUnpresented: getSetting('notify_attach_unpresented', 'true') !== 'false',
  };
}

// the most recent working day strictly before `from` (skips off-days / holidays)
function previousWorkingDay(from = new Date()) {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!isOffDay(iso(d))) return iso(d);
  }
  return iso(d);
}

// the e-mail reports TODAY's position (local date); bank files that arrive today are dated yesterday, so "received" means uploaded today
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function reportDate(from = new Date()) { return localISO(from); }

function completeness(date) {
  const dash = getDashboard(date);
  const missing = [];
  let total = 0;
  for (const co of dash.companies) for (const a of co.accounts) {
    total++;
    const confirmed = a.status === 'done' && (a.source_type === 'actual' || a.source_type === 'manual');
    // received = a statement was uploaded for the account that day (even one held for review), or a balance was posted / entered by hand that day
    const receivedToday = !confirmed && (
      db.prepare("SELECT 1 FROM statements WHERE bank_account_id = ? AND status IN ('processed', 'review') AND deleted_at IS NULL AND date(uploaded_at, 'localtime') = ? LIMIT 1").get(a.account_id, date) ||
      db.prepare("SELECT 1 FROM daily_positions WHERE bank_account_id = ? AND status = 'done' AND source_type IN ('actual', 'manual') AND date(updated_at, 'localtime') = ? LIMIT 1").get(a.account_id, date));
    const closed = !confirmed && !receivedToday && db.prepare('SELECT 1 FROM missing_closed WHERE bank_account_id = ? AND close_date = ?').get(a.account_id, date);
    const ok = confirmed || !!receivedToday || !!closed;
    if (!ok) missing.push({ account_id: a.account_id, company: co.company_name, bank: a.bank_name, status: a.status });
  }
  return { complete: total > 0 && missing.length === 0, total, missing, dash };
}

function buildMessage(date, dash, funds, attachNames = []) {
  const names = Array.isArray(attachNames) ? attachNames : (attachNames ? ['Monthly Bank Position'] : []);
  const td = 'padding:4px 10px;border:1px solid #cfd8e3';
  const COLW = [380, 170, 150];                 // label / amount / millions: the same in both tables so they line up
  const TBL = `width="${COLW[0] + COLW[1] + COLW[2]}" style="border-collapse:collapse;table-layout:fixed;width:${COLW[0] + COLW[1] + COLW[2]}px"`;
  const mil = (n) => (n == null ? '—' : (Number(n) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const two = (label, full, million, style = '', lstyle = '') => `<tr><td style="${td};${style}${lstyle}">${label}</td><td style="${td};${style}text-align:right">${full}</td><td style="${td};${style}text-align:right">${million}</td></tr>`;
  const rows = dash.companies.map((co) => {
    const lines = co.accounts.map((a) => {
      let h = two(esc(a.bank_name), money(a.balance), mil(a.balance));
      (a.adjustments || []).forEach((x) => { const sign = x.effect === 'add' ? '' : '&minus; '; h += two('&#8627; ' + esc(x.name), sign + money(x.amount), sign + mil(x.amount), 'color:#e0463a;', 'padding-left:26px;'); });
      if ((a.adjustments || []).length && a.balance != null) h += two('&#8627; Net balance', money(a.net_balance), mil(a.net_balance), 'font-weight:bold;', 'padding-left:26px;');
      return h;
    }).join('');
    return `<tr><td colspan="3" style="padding:5px 10px;background:#dbe6f1;font-weight:bold;border:1px solid #cfd8e3">${esc(co.company_name)}</td></tr>${lines}` +
      two('Total', money(co.company_total), mil(co.company_total), 'background:#eef2f6;font-weight:bold;') +
      (co.company_adjust ? two('Net of liens', money(co.company_net), mil(co.company_net), 'background:#eef2f6;font-weight:bold;') : '');
  }).join('');
  const dt = new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const head = `<tr><td width="${COLW[0]}" style="${td};background:#e9eef4;font-weight:bold">Bank</td><td width="${COLW[1]}" style="${td};background:#e9eef4;font-weight:bold;text-align:right">Amount (PKR)</td><td width="${COLW[2]}" style="${td};background:#e9eef4;font-weight:bold;text-align:right">PKR millions</td></tr>`;
  const big = (label, full, million, bg) => `<tr><td style="padding:6px 10px;background:${bg};color:#fff;font-weight:bold;border:1px solid ${bg}">${label}</td><td style="padding:6px 10px;background:${bg};color:#fff;font-weight:bold;text-align:right;border:1px solid ${bg}">${full}</td><td style="padding:6px 10px;background:${bg};color:#fff;font-weight:bold;text-align:right;border:1px solid ${bg}">${million}</td></tr>`;
  let fundsHtml = '';
  if (funds && funds.lines && funds.lines.length) {
    const fhead = `<tr><td width="${COLW[0]}" style="${td};background:#e9eef4;font-weight:bold">Particulars</td><td width="${COLW[1]}" style="${td};background:#e9eef4;font-weight:bold;text-align:right">Amount (PKR)</td><td width="${COLW[2]}" style="${td};background:#e9eef4;font-weight:bold;text-align:right">PKR millions</td></tr>`;
    const fr = funds.lines.map((l, i) => {
      const hl = l.kind === 'formula' && l.headline, f = l.kind === 'formula' || l.kind === 'pool';
      const st = `${hl ? 'background:#12507b;color:#fff;' : f ? 'background:#eef2f6;' : ''}font-weight:${f ? 'bold' : 'normal'};`;
      const lien = /^lien/i.test(l.label || '') && !hl ? 'color:#e0463a;' : '';
      return `<tr><td style="${td};${st}${lien}">${esc(l.label)}</td><td style="${td};${st}${lien}text-align:right">${l.error ? '—' : money(l.value)}</td><td style="${td};${st}${lien}text-align:right">${l.error ? '—' : mil(l.value)}</td></tr>`;
    }).join('');
    fundsHtml = `<p style="margin-top:18px"><b>Available funds</b> as at ${esc(dt)}:</p><table ${TBL}>${fhead}${fr}</table>`;
  }
  const attachLine = names.length ? `<p>Attached as PDF: ${names.map((n) => '<b>' + esc(n) + '</b>').join(', ')}.</p>` : '';
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1f2733">
    <p>Dear All,</p>
    <p>All bank statements have been received and processed. Bank position as at <b>${esc(dt)}</b> (PKR):</p>
    <table ${TBL}>${head}${rows}
      ${big(esc(dash.group_name || 'Group') + ' - Total', money(dash.group_total), mil(dash.group_total), '#12507b')}
      ${dash.group_adjust ? big('Net of liens / adjustments', money(dash.group_net), mil(dash.group_net), '#0d3c5c') : ''}
    </table>${fundsHtml}
    ${attachLine}
    <p style="color:#6b7688;font-size:12px">Sent automatically by the Bank Position Portal.</p></div>`;
}

function attachmentNames() {
  const c = cfg(); const n = [];
  if (c.attachDaily) n.push('Daily Bank Position');
  if (c.attachMonthly) n.push('Monthly Bank Position');
  if (c.attachUnpresented) n.push('Unpresented Cheques');
  return n;
}

function subjectFor(date) {
  const dt = new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return cfg().subject.replace(/\{date\}/g, dt);
}

async function queue(date, { force = false, reason = 'all statements received' } = {}) {
  const c = cfg();
  if (!c.to.trim()) return { queued: false, why: 'No recipients entered (Settings -> E-mail notification).' };
  const comp = completeness(date);
  if (!comp.complete && !force) return { queued: false, why: `${comp.missing.length} account(s) still missing`, missing: comp.missing };
  if (!fs.existsSync(OUTBOX)) fs.mkdirSync(OUTBOX, { recursive: true });
  const already = fs.readdirSync(OUTBOX).filter((n) => n.startsWith(date + '_') && n.endsWith('.json'));
  if (already.length) return { queued: false, waiting: true, why: 'This e-mail is already prepared and is waiting for the Outlook agent to send it. It will not be prepared twice.' };
  const name = `${date}_${Date.now()}.json`;
  let funds = null; try { funds = computeFunds(date); } catch {}
  // the PDFs chosen in Settings (needs Edge/Chrome, present on Windows); the e-mail is still prepared without any that fail
  const attachments = [], attachedNames = []; const notes = [];
  const outDir = path.join(OUTBOX, 'attach');
  const jobs = [];
  if (c.attachDaily) jobs.push(['Daily Bank Position', () => dailyReportPdf(date, outDir)]);
  if (c.attachMonthly) jobs.push(['Monthly Bank Position', () => monthlyReportPdf(date, outDir)]);
  if (c.attachUnpresented) jobs.push(['Unpresented Cheques', () => unpresentedReportPdf(date, outDir)]);
  for (const [label, make] of jobs) {
    try { attachments.push(await make()); attachedNames.push(label); } catch (e) { notes.push(label + ': ' + e.message); console.error('[notify] PDF ' + label + ':', e.message); }
  }
  const attachNote = notes.length ? notes.join(' | ') : null;
  const msg = { kind: 'bank-position-summary', date, mode: c.mode, to: c.to, cc: c.cc, subject: subjectFor(date), html: buildMessage(date, comp.dash, funds, attachedNames), attachments, attachNote, created: new Date().toISOString(), reason };
  fs.writeFileSync(path.join(OUTBOX, name + '.part'), JSON.stringify(msg));
  fs.renameSync(path.join(OUTBOX, name + '.part'), path.join(OUTBOX, name));
  setSetting('notify_sent_' + date, new Date().toISOString());
  logAudit('system', 'notify_queued', 'settings', date, { mode: c.mode, to: c.to, cc: c.cc, forced: force, attachments: attachments.length });
  return { queued: true, file: name, mode: c.mode, attachments: attachments.length, attachNote };
}

// run from the ingest loop: sends once per working day, as soon as everything is in
async function check() {
  try {
    const c = cfg();
    if (!c.enabled || !c.to.trim()) return;
    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5);
    if (hhmm < c.notBefore) return;
    const date = reportDate(now);
    if (isOffDay(date)) return;          // no statements are expected on a weekend / holiday
    if (getSetting('notify_sent_' + date)) return;
    const r = await queue(date);
    if (r.queued) {
      console.log('[notify] summary for', date, 'queued as', c.mode);
      // the Outlook agent is the one that sends it: start it now, otherwise an e-mail prepared after 11:00 would wait until the next morning
      try { require('child_process').execFile('schtasks', ['/run', '/tn', 'BankPositionOutlookAgent'], { windowsHide: true }, (err) => { if (err) console.error('[notify] could not start the agent:', err.message); }); } catch (e) { console.error('[notify] agent start', e.message); }
    }
  } catch (e) { console.error('[notify]', e.message); }
}

function status() {
  const c = cfg();
  const date = reportDate();
  const comp = completeness(date);
  const out = fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((n) => n.endsWith('.json')).length : 0;
  return { ...c, date, complete: comp.complete, missing: comp.missing, total: comp.total, alreadySent: getSetting('notify_sent_' + date) || null, waitingInOutbox: out };
}

module.exports = { check, queue, status, buildMessage, attachmentNames, completeness, previousWorkingDay, reportDate, subjectFor, cfg };
