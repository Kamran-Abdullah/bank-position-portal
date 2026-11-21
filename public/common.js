'use strict';
window.BPP = (function () {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  const NAV = [
    ['dashboard', 'Dashboard', 'dashboard.html'],
    ['monthly', 'Monthly Position', 'monthly.html'],
    ['review', 'Review Queue', 'review.html'],
    ['reports', 'Reports', 'reports.html'],
    ['funds', 'Unpresented Cheques', 'unpresented.html'],
    ['config', 'Setup', 'config.html'],
    ['settings', 'Settings', 'settings.html'],
  ];

  async function mountChrome(activeKey) {
    let me;
    try { me = await api('/api/me'); }
    catch { location.href = '/login.html'; return null; }
    const perms = me.permissions || {};
    const isSU = me.user.role === 'super_user';
    const links = NAV.filter(([key]) => isSU || perms[key])
      .map(([key, label, href]) => `<a href="/${href}" class="${key === activeKey ? 'active' : ''}">${label}</a>`).join('');
    const roleLabel = { super_user: 'Super User', finance_user: 'Finance User', viewer: 'Viewer' }[me.user.role] || me.user.role;
    document.body.insertAdjacentHTML('afterbegin', `
      <header class="top"><div class="wrap">
        <div class="brand">🏦 Bank Position Portal</div>
        <nav>${links}</nav>
        <div class="who">${escapeHtml(me.user.full_name || me.user.username)} · ${roleLabel}
          <a href="#" id="logoutLink">Sign out</a></div>
      </div></header>`);
    document.getElementById('logoutLink').addEventListener('click', async (e) => {
      e.preventDefault(); await api('/api/logout', { method: 'POST' }); location.href = '/login.html';
    });
    return me;
  }

  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (n, cur) => (n == null || n === '' || isNaN(n)) ? '—' : `${cur ? cur + ' ' : ''}${nf.format(Number(n))}`;
  const moneyShort = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return nf0.format(n);
    return nf.format(n);
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const todayISO = () => new Date().toISOString().slice(0, 10);
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const STATUS_LABEL = { done: 'Done', pending: 'Pending', review: 'Review Required', error: 'Processing Error', carried_forward: 'Carried Forward' };

  // Open a clean, full-bleed print document in a new window and trigger the print dialog.
  // Used for "Export PDF" so the output is edge-to-edge and independent of screen CSS.
  function printDoc({ title, subtitle, orientation = 'portrait', tableHtml, titleRight = false }) {
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups for this site to export the PDF.'); return; }
    const gen = new Date().toLocaleString('en-GB');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page{size:A4 ${orientation};margin:6mm}
      *{box-sizing:border-box}
      html,body{margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;color:#1f2733;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .ph{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #12507b;padding-bottom:5px;margin-bottom:8px}
      .ph h1{margin:0;font-size:15px;color:#12507b}
      .ph .m{font-size:9px;color:#333;text-align:right;line-height:1.4}
      ${titleRight ? '.ph{flex-direction:row-reverse}.ph .m{text-align:left}' : ''}
      tr.gap td{border:0;background:#fff;padding:0;height:10px}
      table{width:100%;border-collapse:collapse;table-layout:fixed}
      thead{display:table-header-group}
      tr,td,th{page-break-inside:avoid}
      th,td{border:1px solid #b9c4d2;padding:3px 4px;font-size:8px;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      th{background:#e9eef4;font-weight:700}
      td.l,th.l{text-align:left}
      tr.co td{background:#dbe6f1;font-weight:700;color:#0d3c5c;text-align:left}
      tr.sub td{background:#eef2f6;font-weight:700}
      tr.grand td{background:#12507b;color:#fff;font-weight:700;font-size:11px}
      td.off{background:#f2ead9}
      td.cf{color:#5b6472}
      td.mn{color:#0d3c5c;font-weight:700}
    </style></head><body>
      <div class="ph"><h1>${escapeHtml(title)}</h1>
        <div class="m">Demo Group of Companies${subtitle ? '<br>' + escapeHtml(subtitle) : ''}<br>Generated ${gen}</div></div>
      ${tableHtml}
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 300);
  }

  function makeDialog(html) {
    const d = document.createElement('dialog');
    d.innerHTML = html;
    document.body.appendChild(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    return d;
  }

  // Manual balance entry for one account + date (exception mechanism; always audited).
  function manualDialog({ accountId, title, date, balance, isManual, onSaved }) {
    const d = makeDialog(`
      <form method="dialog" id="mf">
        <div class="dlg-head"><h3>Manual entry</h3><div class="sub">${escapeHtml(title || '')}</div></div>
        <div class="dlg-body">
          <div class="formgrid">
            <label class="fld"><span>Date</span><input type="date" name="position_date" value="${escapeHtml(date || todayISO())}" required></label>
            <label class="fld"><span>Closing balance (PKR)</span><input name="balance" inputmode="decimal" value="${balance != null ? escapeHtml(String(balance)) : ''}" placeholder="e.g. 12,500,000.00" required></label>
          </div>
          <label class="fld"><span>Reason (required — kept in the audit trail)</span><input name="reason" placeholder="e.g. statement not available, balance confirmed by phone" required></label>
          <div class="muted" style="font-size:12px">A manual entry overrides the statement figure for that day and is never overwritten by later uploads.</div>
          <div id="mmsg"></div>
        </div>
        <div class="dlg-foot">
          ${isManual ? '<button type="button" id="mdel" style="margin-right:auto">Remove manual entry</button>' : ''}
          <button type="button" id="mcancel">Cancel</button>
          <button class="primary" type="submit">Save</button>
        </div>
      </form>`);
    const f = d.querySelector('#mf');
    d.querySelector('#mcancel').onclick = () => d.close();
    const msg = (t) => { d.querySelector('#mmsg').innerHTML = `<div class="msg err">${escapeHtml(t)}</div>`; };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f).entries());
      try {
        await api('/api/positions/manual', { method: 'POST', body: JSON.stringify({ bank_account_id: accountId, ...fd }) });
        d.close(); if (onSaved) onSaved();
      } catch (err) { msg(err.message); }
    });
    if (isManual) d.querySelector('#mdel').onclick = async () => {
      const day = f.position_date.value;
      if (!confirm(`Remove the manual entry for ${fmtDate(day)}?`)) return;
      try { await api(`/api/positions/manual?bank_account_id=${accountId}&position_date=${day}`, { method: 'DELETE' }); d.close(); if (onSaved) onSaved(); }
      catch (err) { msg(err.message); }
    };
  }

  // List of uploaded statements for an account, with View / Delete.
  async function statementsDialog({ accountId, title, canDelete, onChanged }) {
    const d = makeDialog(`<div class="dlg-head"><h3>Uploaded statements</h3><div class="sub">${escapeHtml(title || '')}</div></div>
      <div class="dlg-body" id="sbody"><div class="muted">Loading…</div></div>
      <div class="dlg-foot"><button class="primary" id="sclose">Close</button></div>`);
    d.style.maxWidth = '760px';
    d.querySelector('#sclose').onclick = () => d.close();
    async function load() {
      const rows = await api('/api/statements?account_id=' + accountId + '&limit=50');
      d.querySelector('#sbody').innerHTML = rows.length ? `<table class="grid"><thead><tr><th>File</th><th>Covers</th><th class="num">Closing</th><th>Days</th><th></th></tr></thead><tbody>${
        rows.map((r) => `<tr>
          <td>${escapeHtml(r.file_name)}<div class="acct">${fmtDate(r.uploaded_at)} · ${escapeHtml(r.uploaded_by || '')}${r.status !== 'processed' ? ' · ' + escapeHtml(r.status) : ''}</div></td>
          <td>${fmtDate(r.statement_from)} → ${fmtDate(r.latest_statement_date)}</td>
          <td class="num">${money(r.extracted_balance)}</td>
          <td>${r.days_posted != null ? r.days_posted : '—'}</td>
          <td class="num"><span class="rowbtns"><button class="sm" data-v="${r.id}">View</button>${canDelete ? `<button class="sm" data-d="${r.id}">Delete</button>` : ''}</span></td>
        </tr>`).join('')}</tbody></table>` : '<div class="muted">No statements uploaded for this account.</div>';
      d.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => window.open('/api/statements/' + b.dataset.v + '/file', '_blank'));
      d.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => {
        const reason = prompt('Delete this statement and the daily balances it posted?\nOptional reason:', '');
        if (reason === null) return;
        try {
          const r = await api('/api/statements/' + b.dataset.d + '?reason=' + encodeURIComponent(reason), { method: 'DELETE' });
          alert(`Deleted. ${r.removed_positions} daily balance(s) removed${r.restored_days ? ', ' + r.restored_days + ' restored from earlier statements' : ''}.`);
          await load(); if (onChanged) onChanged();
        } catch (err) { alert(err.message); }
      });
    }
    load();
  }

  // Liens / adjustments under one bank account. Super User defines the types; finance users enter amounts (dated).
  async function adjustmentsDialog({ accountId, title, date, onChanged }) {
    const me = await api('/api/me');
    const isSU = me.user.role === 'super_user', canEdit = isSU || !!(me.permissions && me.permissions.adjust_edit);
    const d = makeDialog('<div class="dlg-body muted">Loading…</div>');
    d.style.maxWidth = '640px';
    async function load() {
      const all = await api('/api/adjustments?date=' + (date || todayISO()));
      const mine = (all.find((x) => x.account_id === accountId) || { adjustments: [] }).adjustments;
      d.innerHTML = `<div class="dlg-head"><h3>Liens &amp; adjustments</h3><div class="sub">${escapeHtml(title || '')} · as at ${fmtDate(date || todayISO())}</div></div>
        <div class="dlg-body">
          ${mine.length ? `<table class="grid"><thead><tr><th>Name</th><th>Effect on balance</th><th class="num">Amount</th><th></th></tr></thead><tbody>${mine.map((a) => `<tr>
            <td>${escapeHtml(a.name)}${a.note ? `<div class="acct">${escapeHtml(a.note)}</div>` : ''}</td><td>${a.effect === 'add' ? '＋ adds to balance' : '− deducted from balance'}</td>
            <td class="num">${money(a.amount)}${a.as_of && a.as_of !== (date || todayISO()) ? `<div class="acct">as of ${fmtDate(a.as_of)}</div>` : ''}</td>
            <td class="num"><span class="rowbtns">${canEdit ? `<button class="sm" data-v="${a.id}">Set amount</button>` : ''}<button class="sm ghost" data-h="${a.id}" title="History">⏱</button>${isSU ? `<button class="sm ghost" data-r="${a.id}" title="Rename / change effect">✎</button><button class="sm ghost" data-x="${a.id}" title="Remove this line">✕</button>` : ''}</span></td></tr>`).join('')}</tbody></table>` : '<div class="muted">No liens or adjustments are set up for this bank account.</div>'}
          ${isSU ? `<div class="addrow" style="margin:12px -20px -18px;border-radius:0"><input id="aname" placeholder="New line under this bank, e.g. Lien, RTGS, Clearing cheques"><select id="aeff" style="max-width:230px"><option value="deduct">− deducted from balance (lien)</option><option value="add">＋ added to balance</option></select><button class="primary sm" id="aadd">+ Add</button></div>` : (mine.length ? '' : '<div class="muted" style="margin-top:6px">A Super User can add lien lines under this bank.</div>')}
        </div><div class="dlg-foot"><button class="primary" id="aclose">Close</button></div>`;
      d.querySelector('#aclose').onclick = () => d.close();
      const done = () => { load(); if (onChanged) onChanged(); };
      d.querySelectorAll('[data-v]').forEach((b) => b.onclick = async () => {
        const a = mine.find((x) => x.id === Number(b.dataset.v));
        const v = prompt(`${a.name} — amount (PKR). Examples: 6000000, 6m, 10.08m`, a.amount);
        if (v === null) return;
        const note = prompt('Note (optional):', a.note || '');
        try { await api(`/api/adjustments/${a.id}/value`, { method: 'PUT', body: JSON.stringify({ amount: v, as_of: date || todayISO(), note: note || '' }) }); done(); } catch (e) { alert(e.message); }
      });
      d.querySelectorAll('[data-h]').forEach((b) => b.onclick = async () => {
        const rows = await api(`/api/adjustments/${b.dataset.h}/history`);
        alert(rows.length ? rows.map((r) => `${fmtDate(r.as_of)}   ${money(r.amount)}   ${r.updated_by || ''}${r.note ? '   ' + r.note : ''}`).join('\n') : 'No amounts entered yet.');
      });
      d.querySelectorAll('[data-x]').forEach((b) => b.onclick = async () => { if (confirm('Remove this line from the bank? Past amounts are kept in the audit trail.')) { await api('/api/adjustments/' + b.dataset.x, { method: 'DELETE' }); done(); } });
      d.querySelectorAll('[data-r]').forEach((b) => b.onclick = async () => {
        const a = mine.find((x) => x.id === Number(b.dataset.r));
        const name = prompt('Name:', a.name); if (name === null) return;
        const eff = confirm('Should this line be DEDUCTED from the bank balance?\nOK = deduct (like a lien)   Cancel = add to balance') ? 'deduct' : 'add';
        await api('/api/adjustments/' + a.id, { method: 'PUT', body: JSON.stringify({ name, effect: eff }) }); done();
      });
      const add = d.querySelector('#aadd');
      if (add) add.onclick = async () => {
        try { await api('/api/adjustments', { method: 'POST', body: JSON.stringify({ bank_account_id: accountId, name: d.querySelector('#aname').value, effect: d.querySelector('#aeff').value }) }); done(); } catch (e) { alert(e.message); }
      };
    }
    load();
  }

  return { makeDialog, api, mountChrome, money, moneyShort, fmtDate, todayISO, escapeHtml, STATUS_LABEL, printDoc, manualDialog, statementsDialog, adjustmentsDialog };
})();
