'use strict';
/**
 * "Available Funds" statement, embedded under the Monthly Position and Reports sheets.
 *   FundsBlock.mount(el, { getDate: () => 'YYYY-MM-DD' })  -> { reload(), data() }
 * Finance users can add / update reserves right here; the equations themselves are edited in Settings.
 */
window.FundsBlock = (function () {
  const { api, money, fmtDate, escapeHtml } = BPP;

  function parseAmt(t) {
    let s = String(t == null ? '' : t).trim().toLowerCase().replace(/,/g, '').replace(/^pkr\s*/, ''), mult = 1;
    if (/m(n|illion)?$/.test(s)) { mult = 1e6; s = s.replace(/m(n|illion)?$/, ''); } else if (/k$/.test(s)) { mult = 1e3; s = s.replace(/k$/, ''); }
    const n = Number(s);
    return s === '' || isNaN(n) ? NaN : n * mult;
  }

  function mount(el, opts) {
    const state = { data: null, canEdit: false, isSU: false, allowed: true };
    el.classList.add('fundsblock');
    el.innerHTML = '<div class="pad muted">Loading available funds…</div>';

    async function reload() {
      try {
        state.data = await api('/api/funds?date=' + opts.getDate());
      } catch (e) { el.innerHTML = ''; return; }         // no permission / not configured: show nothing
      render();
    }

    function render() {
      const d = state.data;
      if (!d.lines.length) {
        el.innerHTML = state.isSU ? `<div class="card pad"><h3 style="margin-top:0">Available Funds</h3><div class="muted">Not set up yet. Create a pool in <a href="/settings.html#funds">Settings → Funds &amp; reserves</a> (choose which bank accounts count), then add reserves here.</div></div>` : '';
        return;
      }
      const rows = d.lines.map((l, i) => row(l, i)).join('');
      const pools = d.pools || [];
      el.innerHTML = `<div class="card" style="margin-top:18px">
        <div class="poolhead"><h2>Available Funds <span class="muted" style="font-weight:500;font-size:13px">· PKR millions · as at ${fmtDate(d.date)}</span></h2>
          <span class="rowbtns"><button class="sm" data-act="pdf">Export PDF</button><button class="sm" data-act="csv">CSV</button></span></div>
        <table class="fund"><tbody>${rows}</tbody></table>
        ${state.canEdit && pools.length ? `<div class="addrow">${pools.length > 1 ? `<select data-f="pool">${pools.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>` : `<input type="hidden" data-f="pool" value="${pools[0].id}">`}
          <input list="headNames" data-f="name" placeholder="New reserve, e.g. Lien on Export Proceeds"><input class="amt" data-f="amt" placeholder="Amount (e.g. 40m)">
          <button class="primary sm" data-act="add">+ Add reserve</button></div>` : ''}
      </div>`;
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editHead(Number(b.dataset.edit))));
      el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delHead(Number(b.dataset.del))));
      el.querySelectorAll('[data-hist]').forEach((b) => b.addEventListener('click', () => history(Number(b.dataset.hist))));
      const q = (a) => el.querySelector(`[data-act="${a}"]`);
      if (q('add')) q('add').addEventListener('click', addHead);
      q('pdf').addEventListener('click', () => BPP.printDoc(pdfDoc()));
      q('csv').addEventListener('click', exportCsv);
    }

    function row(l, idx) {
      const amt = l.error ? `<span class="muted" title="${escapeHtml(l.error)}">⚠ ${escapeHtml(l.error)}</span>` : `<span title="${money(l.value)}">${(l.value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
      if (l.kind === 'pool') {
        const p = l.pool, miss = p.accounts.filter((a) => !a.counted);
        return `<tr class="pool"><td class="k">${idx + 1}</td><td>${escapeHtml(l.label)} <span class="muted" style="font-weight:500">(${p.accounts.length} account(s))</span>
          ${miss.length ? `<div class="warnbox" style="margin:6px 0 2px;font-weight:500">${miss.length} account(s) have no confirmed balance for this date and are <b>not</b> included.</div>` : ''}</td><td class="amt">${amt}</td><td class="act"></td></tr>`;
      }
      if (l.kind === 'head') {
        const h = l.head;
        return `<tr><td class="k">${idx + 1}</td><td>${escapeHtml(l.label)}${h.as_of && h.as_of !== state.data.date ? `<span class="muted" style="font-size:12px"> · as of ${fmtDate(h.as_of)}</span>` : ''}${h.auto ? `<div class="muted" style="font-size:12px">Automatic – total of the <a href="/unpresented.html">Unpresented Cheques</a> list</div>` : (h.note ? `<div class="muted" style="font-size:12px">${escapeHtml(h.note)}</div>` : '')}</td>
          <td class="amt">${amt}</td><td class="act">${state.canEdit && !h.auto ? `<button class="sm" data-edit="${h.id}">Update</button> <button class="sm ghost" data-del="${h.id}" title="Remove this reserve">✕</button>` : ''}<button class="sm ghost" data-hist="${h.id}" title="History">⏱</button></td></tr>`;
      }
      return `<tr class="formula ${l.headline ? 'hl' : ''}"><td class="k">${idx + 1}</td><td>${escapeHtml(l.label)}</td><td class="amt">${amt}</td><td></td></tr>`;
    }

    async function addHead() {
      const f = (n) => el.querySelector(`[data-f="${n}"]`);
      const name = f('name').value.trim(), amt = f('amt').value.trim();
      if (!name) { alert('Give the reserve a name.'); return; }
      const amount = amt === '' ? undefined : parseAmt(amt);
      if (amt !== '' && isNaN(amount)) { alert('The amount is not a number. Examples: 40000000, 40,000,000, 40m, 27.5m'); return; }
      try { await api('/api/funds/heads', { method: 'POST', body: JSON.stringify({ pool_id: Number(f('pool').value), name, amount, as_of: state.data.date }) }); reload(); }
      catch (e) { alert(e.message); }
    }
    const findHead = (id) => { const l = state.data.lines.find((x) => x.kind === 'head' && x.head.id === id); return l && l.head; };
    function editHead(id) {
      const h = findHead(id);
      const dlg = BPP.makeDialog(`<form method="dialog"><div class="dlg-head"><h3>${escapeHtml(h.name)}</h3><div class="sub">Set the amount</div></div>
        <div class="dlg-body"><div class="formgrid">
          <label class="fld"><span>Amount (PKR) — e.g. 40000000, 40m</span><input name="amount" value="${h.amount}" required></label>
          <label class="fld"><span>Effective from</span><input type="date" name="as_of" value="${state.data.date}" required></label></div>
          <label class="fld"><span>Note (optional)</span><input name="note" value="${escapeHtml(h.note || '')}"></label>
          <label class="fld"><span>Name</span><input name="name" value="${escapeHtml(h.name)}"></label><div id="em"></div></div>
        <div class="dlg-foot"><button type="button" id="c">Cancel</button><button class="primary" type="submit">Save</button></div></form>`);
      dlg.querySelector('#c').onclick = () => dlg.close();
      dlg.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target).entries());
        const amount = parseAmt(f.amount);
        if (isNaN(amount) || amount < 0) { dlg.querySelector('#em').innerHTML = '<div class="msg err">The amount is not a number.</div>'; return; }
        try {
          if (f.name.trim() && f.name.trim() !== h.name) await api('/api/funds/heads/' + id, { method: 'PUT', body: JSON.stringify({ name: f.name }) });
          await api('/api/funds/heads/' + id + '/value', { method: 'PUT', body: JSON.stringify({ amount, as_of: f.as_of, note: f.note }) });
          dlg.close(); reload();
        } catch (err) { dlg.querySelector('#em').innerHTML = `<div class="msg err">${escapeHtml(err.message)}</div>`; }
      });
    }
    async function delHead(id) {
      const h = findHead(id);
      if (!confirm(`Remove the reserve "${h.name}"? Its history is kept.`)) return;
      await api('/api/funds/heads/' + id, { method: 'DELETE' }); reload();
    }
    async function history(id) {
      const h = findHead(id), rows = await api(`/api/funds/heads/${id}/history`);
      const dlg = BPP.makeDialog(`<div class="dlg-head"><h3>${escapeHtml(h.name)} — history</h3></div><div class="dlg-body">${rows.length ? `<table class="grid"><thead><tr><th>Effective from</th><th class="num">Amount</th><th>Note</th><th>By</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtDate(r.as_of)}</td><td class="num">${money(r.amount)}</td><td>${escapeHtml(r.note || '')}</td><td>${escapeHtml(r.updated_by || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No amounts entered yet.</div>'}</div><div class="dlg-foot"><button class="primary" id="c">Close</button></div>`);
      dlg.querySelector('#c').onclick = () => dlg.close();
    }
    function pdfDoc() {
      const d = state.data;
      const mil = (n) => (Number(n) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const rows = d.lines.map((l, i) => `<tr class="${l.kind === 'formula' ? (l.headline ? 'grand' : 'sub') : l.kind === 'pool' ? 'sub' : ''}"><td class="l">${i + 1}</td><td class="l">${escapeHtml(l.label)}</td><td>${l.error ? '—' : mil(l.value)}</td></tr>`).join('');
      return { title: `Available Funds — ${fmtDate(d.date)}`, subtitle: 'Amounts in PKR millions', orientation: 'portrait',
        tableHtml: `<table style="font-size:11px"><colgroup><col style="width:8%"><col style="width:62%"><col style="width:30%"></colgroup><thead><tr><th class="l">Sr</th><th class="l">Particulars</th><th>PKR millions</th></tr></thead><tbody>${rows}</tbody></table>` };
    }
    function exportCsv() {
      const d = state.data, rows = [['Code', 'Line', 'Equation', 'Amount']];
      d.lines.forEach((l) => rows.push([l.code, l.label, l.formula || '', l.error ? '' : l.value]));
      const txt = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv' })); a.download = `available-funds-${d.date}.csv`; a.click();
    }

    BPP.api('/api/me').then((me) => {
      state.isSU = me.user.role === 'super_user';
      state.canEdit = state.isSU || !!(me.permissions && me.permissions.funds_edit);
      state.allowed = state.isSU || !!(me.permissions && me.permissions.funds);
      if (!state.allowed) { el.innerHTML = ''; return; }
      reload();
    });
    return { reload, data: () => state.data, html: () => (state.data && state.data.lines.length ? pdfDoc().tableHtml : '') };
  }
  return { mount };
})();
