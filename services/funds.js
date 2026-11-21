'use strict';
/**
 * Funds statement engine.
 * The statement is a list of LINES, each with a permanent code (A, B, C ... AA):
 *   pool    - sum of the confirmed bank balances of a pool's accounts         (created with the pool)
 *   head    - a reserve / adjustment amount that finance users maintain        (created with the head)
 *   formula - a calculation written by the admin, e.g.  A - RESERVES(A)   or   A + K
 * Formula language: numbers, line codes, + - * / ( ), and
 *   SUM(B:I) / SUM(B,D,F:H)   lines by position in the statement
 *   RESERVES()  every reserve head          RESERVES(A)  the reserve heads of the pool of line A
 *   LIENS()     all liens/deductions entered under bank accounts   LIENS(A)  those of the pool of line A
 *   BALANCES()  every pool balance
 *   MIN(x,y)  MAX(x,y)  ABS(x)
 * Codes never change when lines are re-ordered, so equations keep working. New reserves are picked up by RESERVES().
 */
const { db, logAudit, getSetting } = require('../db');
const { getDashboard } = require('../positions');

const codeAt = (i) => { let s = '', n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const indexOfCode = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function nextCode() {
  const all = db.prepare('SELECT code FROM fund_lines').all();
  let mx = -1; for (const r of all) mx = Math.max(mx, indexOfCode(r.code));
  return codeAt(mx + 1);
}

// keep the statement in step with pools and reserve heads (also migrates databases that pre-date lines)
function sync() {
  const live = () => db.prepare('SELECT * FROM fund_lines WHERE deleted_at IS NULL ORDER BY display_order, id').all();
  const kill = db.prepare("UPDATE fund_lines SET deleted_at = datetime('now') WHERE id = ?");
  for (const l of live()) {
    if (l.kind === 'pool' && !db.prepare('SELECT 1 FROM fund_pools WHERE id = ? AND deleted_at IS NULL').get(l.pool_id)) kill.run(l.id);
    if (l.kind === 'head' && !db.prepare('SELECT 1 FROM reserve_heads WHERE id = ? AND deleted_at IS NULL').get(l.head_id)) kill.run(l.id);
  }
  const ins = db.prepare('INSERT INTO fund_lines (code, label, kind, pool_id, head_id, formula, headline, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const pools = db.prepare('SELECT * FROM fund_pools WHERE deleted_at IS NULL ORDER BY display_order, id').all();
  for (const p of pools) {
    let lines = live();
    let poolLine = lines.find((l) => l.kind === 'pool' && l.pool_id === p.id);
    let created = false;
    if (!poolLine) {
      const mx = lines.reduce((m, l) => Math.max(m, l.display_order), 0);
      const r = ins.run(nextCode(), null, 'pool', p.id, null, null, 0, mx + 1);
      poolLine = db.prepare('SELECT * FROM fund_lines WHERE id = ?').get(r.lastInsertRowid);
      created = true;
    }
    const heads = db.prepare('SELECT * FROM reserve_heads WHERE pool_id = ? AND deleted_at IS NULL ORDER BY display_order, id').all(p.id);
    for (const h of heads) {
      lines = live();
      if (lines.some((l) => l.kind === 'head' && l.head_id === h.id)) continue;
      const group = lines.filter((l) => (l.kind === 'pool' && l.pool_id === p.id) || (l.kind === 'head' && db.prepare('SELECT pool_id FROM reserve_heads WHERE id = ?').get(l.head_id)?.pool_id === p.id));
      const at = group.reduce((m, l) => Math.max(m, l.display_order), 0) + 0.5;
      ins.run(nextCode(), null, 'head', null, h.id, null, 0, at);
    }
    if (created) {      // a sensible starting equation; the admin can edit or delete it
      lines = live();
      const group = lines.filter((l) => (l.kind === 'pool' && l.pool_id === p.id) || (l.kind === 'head' && db.prepare('SELECT pool_id FROM reserve_heads WHERE id = ?').get(l.head_id)?.pool_id === p.id));
      const at = group.reduce((m, l) => Math.max(m, l.display_order), 0) + 0.7;
      const hasHeadline = lines.some((l) => l.headline);
      ins.run(nextCode(), 'Available to use', 'formula', null, null, `${poolLine.code} - RESERVES(${poolLine.code}) - LIENS(${poolLine.code})`, hasHeadline ? 0 : 1, at);
    }
  }
  live().forEach((l, i) => db.prepare('UPDATE fund_lines SET display_order = ? WHERE id = ?').run(i + 1, l.id));
}

// ---------------- formula parser / evaluator (no eval) ----------------
function tokenize(src) {
  const t = []; const s = String(src || '');
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ k: 'n', v: parseFloat(s.slice(i, j)) }); i = j; continue; }
    if (/[A-Za-z]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z]/.test(s[j])) j++; t.push({ k: 'id', v: s.slice(i, j).toUpperCase() }); i = j; continue; }
    if ('+-*/(),:×÷−'.includes(c)) { t.push({ k: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c === '−' ? '-' : c }); i++; continue; }
    throw new Error(`Unexpected character "${c}" in the equation.`);
  }
  return t;
}

function evaluate(formula, env) {
  const toks = tokenize(formula); let p = 0;
  const peek = () => toks[p], eat = () => toks[p++];
  const isOp = (v) => peek() && peek().k === 'op' && peek().v === v;
  const need = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}" in the equation.`); p++; };
  function expr() { let v = term(); while (isOp('+') || isOp('-')) { const o = eat().v; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  function term() { let v = factor(); while (isOp('*') || isOp('/')) { const o = eat().v; const r = factor(); if (o === '/' && r === 0) throw new Error('Division by zero.'); v = o === '*' ? v * r : v / r; } return v; }
  function factor() {
    const t = peek();
    if (!t) throw new Error('The equation ends too early.');
    if (isOp('-')) { p++; return -factor(); }
    if (isOp('+')) { p++; return factor(); }
    if (t.k === 'n') { p++; return t.v; }
    if (isOp('(')) { p++; const v = expr(); need(')'); return v; }
    if (t.k === 'id') {
      p++;
      if (isOp('(')) { p++; const v = call(t.v); need(')'); return v; }
      return env.value(t.v);
    }
    throw new Error(`Unexpected "${t.v}" in the equation.`);
  }
  function call(name) {
    if (name === 'RESERVES') { if (isOp(')')) return env.reserves(null); const c = eat(); if (!c || c.k !== 'id') throw new Error('RESERVES needs a line code, e.g. RESERVES(A).'); return env.reserves(c.v); }
    if (name === 'BALANCES') return env.balances();
    if (name === 'LIENS') { if (isOp(')')) return env.liens(null); const c = eat(); if (!c || c.k !== 'id') throw new Error('LIENS needs a line code, e.g. LIENS(A).'); return env.liens(c.v); }
    if (name === 'SUM') {
      let tot = 0;
      for (;;) {
        const a = eat(); if (!a || a.k !== 'id') throw new Error('SUM needs line codes, e.g. SUM(B:I).');
        if (isOp(':')) { p++; const b = eat(); if (!b || b.k !== 'id') throw new Error('SUM range needs an end code.'); tot += env.range(a.v, b.v); } else tot += env.value(a.v);
        if (isOp(',')) { p++; continue; } break;
      }
      return tot;
    }
    if (name === 'MIN' || name === 'MAX') { const a = expr(); need(','); const b = expr(); return name === 'MIN' ? Math.min(a, b) : Math.max(a, b); }
    if (name === 'ABS') return Math.abs(expr());
    throw new Error(`Unknown function ${name}.`);
  }
  if (!toks.length) throw new Error('The equation is empty.');
  const v = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}" in the equation.`);
  return v;
}

function computeFunds(date) {
  sync();
  const dash = getDashboard(date);
  const accMap = new Map();
  for (const co of dash.companies) for (const a of co.accounts) accMap.set(a.account_id, { ...a, company: co.company_name });

  const pools = db.prepare('SELECT * FROM fund_pools WHERE deleted_at IS NULL ORDER BY display_order, id').all();
  const valueAt = db.prepare('SELECT amount, as_of, note, updated_by FROM reserve_values WHERE head_id = ? AND as_of <= ? ORDER BY as_of DESC LIMIT 1');
  const poolData = new Map(), headData = new Map();
  for (const p of pools) {
    const ids = db.prepare('SELECT bank_account_id FROM fund_pool_accounts WHERE pool_id = ?').all(p.id).map((r) => r.bank_account_id);
    const accounts = ids.map((id) => accMap.get(id)).filter(Boolean).map((a) => ({
      account_id: a.account_id, company: a.company, bank: a.bank_name, balance: a.balance, status: a.status,
      counted: a.balance != null && ['done', 'carried_forward'].includes(a.status),
      adjust: (a.adjustments || []).reduce((t, x) => t + x.delta, 0), adjustments: a.adjustments || [] }));
    const balance = accounts.filter((a) => a.counted).reduce((s, a) => s + a.balance, 0);
    poolData.set(p.id, { id: p.id, name: p.name, account_ids: ids, accounts, balance, missing_accounts: accounts.filter((a) => !a.counted).length });
    for (const h of db.prepare('SELECT * FROM reserve_heads WHERE pool_id = ? AND deleted_at IS NULL ORDER BY display_order, id').all(p.id)) {
      const v = valueAt.get(h.id, date);
      headData.set(h.id, { auto: String(h.id) === String(getSetting('unpresented_head_id', '')), id: h.id, pool_id: p.id, name: h.name, amount: v ? v.amount : 0, as_of: v ? v.as_of : null, note: v ? v.note : null, updated_by: v ? v.updated_by : null });
    }
  }

  const lines = db.prepare('SELECT * FROM fund_lines WHERE deleted_at IS NULL ORDER BY display_order, id').all();
  const byCode = new Map(lines.map((l, i) => [l.code, { ...l, pos: i }]));
  const cache = new Map(), busy = new Set();
  const valueOf = (code) => {
    const l = byCode.get(code);
    if (!l) throw new Error(`There is no line "${code}".`);
    if (cache.has(code)) return cache.get(code);
    if (busy.has(code)) throw new Error(`Line ${code} refers to itself (circular equation).`);
    let v = 0;
    if (l.kind === 'pool') v = (poolData.get(l.pool_id) || { balance: 0 }).balance;
    else if (l.kind === 'head') v = (headData.get(l.head_id) || { amount: 0 }).amount;
    else { busy.add(code); try { v = evaluate(l.formula, env); } finally { busy.delete(code); } }
    cache.set(code, v); return v;
  };
  const env = {
    value: valueOf,
    range: (a, b) => { const x = byCode.get(a), y = byCode.get(b); if (!x || !y) throw new Error(`Unknown line in SUM(${a}:${b}).`);
      const lo = Math.min(x.pos, y.pos), hi = Math.max(x.pos, y.pos); let t = 0;
      for (let i = lo; i <= hi; i++) t += valueOf(lines[i].code); return t; },
    reserves: (code) => {
      let poolId = null;
      if (code) { const l = byCode.get(code); if (!l || l.kind !== 'pool') throw new Error(`RESERVES(${code}) needs the code of a bank-balance line.`); poolId = l.pool_id; }
      let t = 0; for (const h of headData.values()) if (poolId == null || h.pool_id === poolId) t += h.amount; return t;
    },
    balances: () => { let t = 0; for (const p of poolData.values()) t += p.balance; return t; },
    // liens / deductions entered under the bank accounts of a pool (additions count negatively)
    liens: (code) => {
      let poolId = null;
      if (code) { const l = byCode.get(code); if (!l || l.kind !== 'pool') throw new Error(`LIENS(${code}) needs the code of a bank-balance line.`); poolId = l.pool_id; }
      let t = 0; for (const p of poolData.values()) if (poolId == null || p.id === poolId) t -= p.accounts.filter((a) => a.counted).reduce((s, a) => s + a.adjust, 0); return t;
    },
  };

  const out = lines.map((l) => {
    let value = null, error = null;
    try { value = valueOf(l.code); } catch (e) { error = e.message; }
    const pd = l.kind === 'pool' ? poolData.get(l.pool_id) : null, hd = l.kind === 'head' ? headData.get(l.head_id) : null;
    return { id: l.id, code: l.code, kind: l.kind, label: l.kind === 'pool' ? `Balance in ${pd ? pd.name : '?'}` : l.kind === 'head' ? (hd ? hd.name : '?') : (l.label || 'Calculation'),
      formula: l.formula, headline: !!l.headline, value, error, pool: pd, head: hd };
  });
  const headlines = out.filter((l) => l.headline && l.value != null);
  return { date, lines: out, headlines, pools: [...poolData.values()], head_pool_ids: [...poolData.keys()], missing_accounts: [...poolData.values()].reduce((s, p) => s + p.missing_accounts, 0) };
}

// check an equation as the admin types it (never changes any data)
function validateFormula(formula, forLineId) {
  try {
    const r = computeFunds(new Date().toISOString().slice(0, 10));
    const me = forLineId ? r.lines.find((l) => l.id === Number(forLineId)) : null;
    if (me) {
      // would this equation (directly or through other calculation lines) end up depending on itself?
      const codes = r.lines.map((l) => l.code), formulas = new Map(r.lines.filter((l) => l.kind === 'formula').map((l) => [l.code, l.formula]));
      const depsOf = (f) => { const t = tokenize(f), out = new Set();
        for (let i = 0; i < t.length; i++) { if (t[i].k !== 'id' || !codes.includes(t[i].v)) continue;
          if (t[i + 1] && t[i + 1].v === ':' && t[i + 2] && codes.includes(t[i + 2].v)) { const a = codes.indexOf(t[i].v), b = codes.indexOf(t[i + 2].v); for (let k = Math.min(a, b); k <= Math.max(a, b); k++) out.add(codes[k]); i += 2; }
          else out.add(t[i].v); }
        return out; };
      const seen = new Set(), stack = [...depsOf(formula)];
      while (stack.length) { const c = stack.pop(); if (c === me.code) return { ok: false, error: `This equation would make line ${me.code} depend on itself (circular).` };
        if (seen.has(c)) continue; seen.add(c); if (formulas.has(c)) depsOf(formulas.get(c)).forEach((d) => stack.push(d)); }
    }
    return { ok: true, value: dryEval(formula, r) };
  } catch (e) { return { ok: false, error: e.message }; }
}
function dryEval(formula, r) {
  const byCode = new Map(r.lines.map((l, i) => [l.code, { ...l, pos: i }]));
  const env = {
    value: (c) => { const l = byCode.get(c); if (!l) throw new Error(`There is no line "${c}".`); if (l.error) throw new Error(`Line ${c} has an error: ${l.error}`); return l.value; },
    range: (a, b) => { const x = byCode.get(a), y = byCode.get(b); if (!x || !y) throw new Error(`Unknown line in SUM(${a}:${b}).`); let t = 0; for (let i = Math.min(x.pos, y.pos); i <= Math.max(x.pos, y.pos); i++) t += r.lines[i].value || 0; return t; },
    reserves: (code) => { let pid = null; if (code) { const l = byCode.get(code); if (!l || l.kind !== 'pool') throw new Error(`RESERVES(${code}) needs the code of a bank-balance line.`); pid = l.pool.id; } return r.lines.filter((l) => l.kind === 'head' && (pid == null || l.head.pool_id === pid)).reduce((s, l) => s + l.value, 0); },
    balances: () => r.lines.filter((l) => l.kind === 'pool').reduce((s, l) => s + l.value, 0),
    liens: (code) => { let pid = null; if (code) { const l = byCode.get(code); if (!l || l.kind !== 'pool') throw new Error(`LIENS(${code}) needs the code of a bank-balance line.`); pid = l.pool.id; }
      return -r.lines.filter((l) => l.kind === 'pool' && (pid == null || l.pool.id === pid)).reduce((s, l) => s + l.pool.accounts.filter((a) => a.counted).reduce((t, a) => t + a.adjust, 0), 0); },
  };
  return evaluate(formula, env);
}

module.exports = { sync, computeFunds, validateFormula, nextCode, evaluate };
