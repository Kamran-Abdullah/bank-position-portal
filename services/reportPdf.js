'use strict';
/**
 * Server-side Monthly Bank Position PDF (for the notification e-mail attachment).
 * Same layout as the on-screen "Export PDF": whole PKR millions, company groups, liens/net rows, grand totals,
 * then the Available Funds statement on a new page. Printed to PDF with the browser that ships with Windows (Edge).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { computeMonthly } = require('./monthly');
const { computeFunds } = require('./funds');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const m1 = (n) => (n == null ? '' : (n / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function fundsTableHtml(f) {
  const rows = f.lines.map((l, i) => `<tr class="${l.kind === 'formula' ? (l.headline ? 'grand' : 'sub') : l.kind === 'pool' ? 'sub' : ''}"><td class="l">${i + 1}</td><td class="l">${esc(l.label)}</td><td>${l.error ? '—' : m1(l.value)}</td></tr>`).join('');
  return `<table style="font-size:11px;width:70%"><colgroup><col style="width:8%"><col style="width:62%"><col style="width:30%"></colgroup><thead><tr><th class="l">Sr</th><th class="l">Particulars</th><th>PKR millions</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function monthlyReportHtml(year, month, fundsDate) {
  const d = computeMonthly(year, month), days = d.days;
  const labelW = 17, colw = ((100 - labelW) / days).toFixed(3);
  const cols = `<col style="width:${labelW}%">` + Array.from({ length: days }, () => `<col style="width:${colw}%">`).join('');
  const wd = (i) => new Date(Date.UTC(year, month - 1, i + 1)).getUTCDay();
  const head = `<tr><th class="l">Bank</th>${Array.from({ length: days }, (_, i) => `<th class="${d.offdays[i] ? 'off' : ''}">${i + 1}<br>${WD[wd(i)]}</th>`).join('')}</tr>`;
  const sub = (t, cls, label) => (t ? `<tr class="${cls}"><td class="l">${label}</td>${t.cells.map((v, i) => `<td class="${d.offdays[i] ? 'off' : ''}">${v == null ? '' : m1(v)}</td>`).join('')}</tr>` : '');
  let body = '', last = null;
  const foot = (cid) => sub(d.companyTotals[cid], 'sub', 'Company total');
  for (const r of d.rows) {
    if (r.company_id !== last) {
      if (last !== null) body += foot(last) + `<tr class="gap"><td colspan="${days + 1}"></td></tr>`;
      body += `<tr class="co"><td class="l" colspan="${days + 1}">${esc(r.company)}</td></tr>`;
      last = r.company_id;
    }
    body += `<tr><td class="l">${esc(r.bank)}</td>${r.cells.map((c, i) => {
      if (!c) return `<td class="${d.offdays[i] ? 'off' : ''}"></td>`;
      const cls = c.source === 'carried_forward' ? 'cf' : c.source === 'manual' ? 'mn' : '';
      // a bank with a lien shows its balance after the lien; totals below still count the full bank balance
      const shown = r.net_cells && r.net_cells[i] != null ? r.net_cells[i] : c.balance;
      return `<td class="${cls} ${d.offdays[i] ? 'off' : ''}">${m1(shown)}</td>`;
    }).join('')}</tr>`;
    if (r.adjustments.length) {
      r.adjustments.forEach((a) => { body += `<tr><td class="l" style="color:#8a5d10">&nbsp;&nbsp;&#8627; ${esc(a.name)}</td>${a.cells.map((v, i) => `<td class="${d.offdays[i] ? 'off' : ''}">${v ? m1(v) : ''}</td>`).join('')}</tr>`; });
    }
  }
  if (last !== null) body += foot(last) + `<tr class="gap"><td colspan="${days + 1}"></td></tr>`;
  // the lien is a reserve inside the bank balance: listed on its own line, totals are the regular bank balances
  body += sub({ cells: d.grandTotals }, 'grand', 'GRAND TOTAL');
  const gen = new Date().toLocaleString('en-GB');
  let funds = '';
  // the funds statement belongs to the Daily Bank Position only; it is not part of the monthly report
  if (false) try { const f = computeFunds(fundsDate); if (f.lines.length) funds = `<div style="page-break-before:always"></div><div class="ph"><h1>Available Funds &mdash; ${esc(fundsDate)}</h1><div class="m">Demo Group of Companies<br>Amounts in PKR millions</div></div>${fundsTableHtml(f)}`; } catch {}
  return `<!doctype html><html><head><meta charset="utf-8"><title>Monthly Bank Position ${MON[month - 1]} ${year}</title><style>
    @page{size:A4 landscape;margin:6mm} *{box-sizing:border-box} html,body{margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1f2733;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #12507b;padding-bottom:5px;margin-bottom:8px}
    .ph h1{margin:0;font-size:15px;color:#12507b} .ph .m{font-size:9px;color:#333;text-align:right;line-height:1.4}
    table{width:100%;border-collapse:collapse;table-layout:fixed} thead{display:table-header-group} tr,td,th{page-break-inside:avoid}
    th,td{border:1px solid #b9c4d2;padding:3px 4px;font-size:8px;text-align:right;overflow:hidden;white-space:nowrap}
    th{background:#e9eef4;font-weight:700} td.l,th.l{text-align:left} tr.co td{background:#dbe6f1;font-weight:700;color:#0d3c5c;text-align:left}
    tr.gap td{border:0;background:#fff;padding:0;height:7px} tr.sub td{background:#eef2f6;font-weight:700} tr.grand td{background:#12507b;color:#fff;font-weight:700;font-size:9px} td.off{background:#f2ead9} td.cf{color:#5b6472} td.mn{color:#0d3c5c;font-weight:700}
  </style></head><body>
    <div class="ph"><h1>Monthly Bank Position &mdash; ${MON[month - 1]} ${year}</h1><div class="m">Demo Group of Companies<br>Daily closing balance per account &middot; PKR millions &middot; shaded = off-day<br>Generated ${esc(gen)}</div></div>
    <style>.mpdf th,.mpdf td{padding:3px 1px;font-size:7px;overflow:visible;text-overflow:clip}.mpdf td.l,.mpdf th.l{padding-left:4px}.mpdf tr.grand td{font-size:7px}</style><table class="mpdf" style="font-size:7px"><colgroup>${cols}</colgroup><thead>${head}</thead><tbody>${body}</tbody></table>${funds}
  </body></html>`;
}

function findBrowser() {
  const c = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return c.find((p) => fs.existsSync(p)) || null;
}

function htmlToPdf(html, outPath) {
  return new Promise((resolve, reject) => {
    const exe = findBrowser();
    if (!exe) return reject(new Error('No Edge/Chrome found to create the PDF.'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpp-pdf-'));
    const htmlFile = path.join(tmp, 'report.html');
    fs.writeFileSync(htmlFile, html, 'utf8');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--print-to-pdf-no-header', `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--print-to-pdf=${outPath}`, 'file:///' + htmlFile.replace(/\\/g, '/')];
    // msedge.exe hands the job to a child process and may return before the PDF is written: wait for the file
    execFile(exe, args, { timeout: 90000, windowsHide: true }, (err) => {
      let waited = 0, lastSize = -1;
      const tick = () => {
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        if (size > 1000 && size === lastSize) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} return resolve(outPath); }
        lastSize = size; waited += 500;
        if (waited > 45000) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} return reject(err || new Error('The PDF was not created.')); }
        setTimeout(tick, 500);
      };
      tick();
    });
  });
}

async function monthlyReportPdf(date, outDir) {
  const [y, m] = date.split('-').map(Number);
  const out = path.join(outDir, `Monthly Bank Position - ${MON[m - 1]} ${y}.pdf`);
  return htmlToPdf(monthlyReportHtml(y, m, date), out);
}


// ---------------------------------------------------------------- Daily Bank Position + Unpresented Cheques (portrait A4)
const dmy = (iso) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const STATUS_LABEL = { done: 'Done', pending: 'Pending', review: 'Review Required', error: 'Processing Error', carried_forward: 'Carried Forward' };
const amt0 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function portraitDoc(title, subtitle, tableHtml, extraHtml = '') {
  const gen = new Date().toLocaleString('en-GB');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{size:A4 portrait;margin:6mm} *{box-sizing:border-box} html,body{margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1f2733;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{display:flex;flex-direction:row-reverse;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #12507b;padding-bottom:5px;margin-bottom:8px}
    .ph h1{margin:0;font-size:15px;color:#12507b} .ph .m{font-size:9px;color:#333;text-align:left;line-height:1.4}
    table{width:100%;border-collapse:collapse;table-layout:fixed} thead{display:table-header-group} tr,td,th{page-break-inside:avoid}
    th,td{border:1px solid #b9c4d2;padding:3px 4px;font-size:8px;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    th{background:#e9eef4;font-weight:700} td.l,th.l{text-align:left} tr.co td{background:#dbe6f1;font-weight:700;color:#0d3c5c;text-align:left}
    tr.gap td{border:0;background:#fff;padding:0;height:10px} tr.sub td{background:#eef2f6;font-weight:700}
    tr.grand td{background:#12507b;color:#fff;font-weight:700;font-size:11px}
  </style></head><body>
    <div class="ph"><h1>${esc(title)}</h1><div class="m">Demo Group of Companies<br>${esc(subtitle)}<br>Generated ${esc(gen)}</div></div>
    ${tableHtml}${extraHtml}
  </body></html>`;
}

function dailyReportHtml(date) {
  const { getDashboard } = require('../positions');
  const d = getDashboard(date);
  const shown = (a) => (a.balance != null && (a.adjustments || []).some((x) => x.amount) && a.net_balance != null ? a.net_balance : a.balance);
  let rows = '', first = true;
  for (const co of d.companies) {
    if (!first) rows += '<tr class="gap"><td colspan="4"></td></tr>';
    first = false;
    rows += `<tr class="co"><td class="l" colspan="3">${esc(co.company_name)}</td><td style="text-align:right">${money(co.company_total)}</td></tr>`;
    for (const a of co.accounts) {
      rows += `<tr><td class="l">${esc(a.bank_name)}</td><td class="l">${esc(a.account_number || a.account_title || '—')}</td><td class="l">${STATUS_LABEL[a.status] || a.status}</td><td>${a.balance == null ? '—' : money(shown(a))}</td></tr>`;
      (a.adjustments || []).filter((x) => x.amount).forEach((x) => { rows += `<tr><td class="l" colspan="3" style="color:#8a5d10">&nbsp;&nbsp;&#8627; ${esc(x.name)}</td><td>${money(x.amount)}</td></tr>`; });
    }
    rows += `<tr class="sub"><td class="l" colspan="3">${esc(co.company_name)} &mdash; total (${co.accounts_known}/${co.accounts_total})</td><td>${money(co.company_total)}</td></tr>`;
  }
  rows += `<tr class="grand"><td class="l" colspan="3">${esc(d.group_name)} &mdash; Group Position</td><td>${money(d.group_total)}</td></tr>`;
  const table = `<table><colgroup><col style="width:22%"><col style="width:30%"><col style="width:20%"><col style="width:28%"></colgroup>
    <thead><tr><th class="l">Bank</th><th class="l">Account</th><th class="l">Status</th><th>Balance (PKR)</th></tr></thead><tbody>${rows}</tbody></table>`;
  let funds = '';
  try { const f = computeFunds(date); if (f.lines.length) funds = `<h2 style="color:#12507b;font-size:14px;margin:18px 0 6px">Available Funds &mdash; ${esc(dmy(date))}</h2>${fundsTableHtml(f).replace('width:70%', 'width:100%')}`; } catch {}
  return portraitDoc(`Daily Bank Position — ${dmy(date)}`, d.is_off_day ? 'OFF DAY · amounts in PKR' : 'Amounts in PKR', table, funds);
}

function unpresentedReportHtml(date) {
  const data = require('./unpresented').list({ status: 'open' });
  let rows = '';
  for (const g of data.sections) {
    rows += `<tr class="co"><td class="l" colspan="5">${esc(g.title)}</td></tr>`;
    g.rows.forEach((r, i) => { rows += `<tr><td class="l">${i + 1}</td><td class="l">${esc(r.cheque_no)}</td><td class="l">${esc(r.party || '')}</td><td>${amt0(r.amount)}</td><td class="l">${esc(dmy(r.dispatch_date))}</td></tr>`; });
    rows += `<tr class="sub"><td class="l" colspan="3">Total (${g.rows.length})</td><td>${amt0(g.total)}</td><td></td></tr><tr class="gap"><td colspan="5"></td></tr>`;
  }
  rows += `<tr class="grand"><td class="l" colspan="3">GRAND TOTAL (${data.count})</td><td>${amt0(data.total)}</td><td></td></tr>`;
  const table = `<table><colgroup><col style="width:7%"><col style="width:16%"><col style="width:45%"><col style="width:17%"><col style="width:15%"></colgroup>
    <thead><tr><th class="l">Sr.</th><th class="l">Chq #</th><th class="l">Party name</th><th>Amount</th><th class="l">Dispatched date</th></tr></thead><tbody>${rows}</tbody></table>`;
  return portraitDoc(`Un-Presented Cheques as on ${dmy(date)}`, 'Amounts in PKR', table);
}

async function dailyReportPdf(date, outDir) { return htmlToPdf(dailyReportHtml(date), path.join(outDir, `Daily Bank Position - ${dmy(date)}.pdf`)); }
async function unpresentedReportPdf(date, outDir) { return htmlToPdf(unpresentedReportHtml(date), path.join(outDir, `Unpresented Cheques - ${dmy(date)}.pdf`)); }

module.exports = { dailyReportHtml, dailyReportPdf, unpresentedReportHtml, unpresentedReportPdf, monthlyReportHtml, monthlyReportPdf, fundsTableHtml, htmlToPdf };
