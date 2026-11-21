'use strict';
// Cashflow module: turns each bank statement's transaction lines into tagged cashflow entries
// (Receipts / Payments by category), the same categories & keyword logic as the group's Excel
// cashflow report, but running automatically on every statement the Outlook agent / Upload pulls in.
const { db, logAudit } = require('../db');

// The tagging engine itself lives with the Cashflow Portal (sibling folder) so both apps classify a
// line identically. If that folder is not there, ingest falls back to the built-in matching below.
let sharedEngine = null;
try { sharedEngine = require('../../Cashflow/services/engine').createEngine(db); } catch { sharedEngine = null; }

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function listCategories() {
  return db.prepare('SELECT * FROM cashflow_categories WHERE active = 1 ORDER BY display_order, id').all();
}

function listRules() {
  return db.prepare(`SELECT r.*, c.name AS category_name FROM cashflow_rules r
    JOIN cashflow_categories c ON c.id = r.category_id ORDER BY r.priority DESC, r.id ASC`).all();
}

let _ruleCache = null, _ruleCacheAt = 0;
function rulesForMatching() {
  const now = Date.now();
  if (!_ruleCache || now - _ruleCacheAt > 5000) {
    _ruleCache = listRules().filter((r) => r.match_type !== 'template').map((r) => ({ ...r, needle: norm(r.phrase) })).filter((r) => r.needle);
    _ruleCacheAt = now;
  }
  return _ruleCache;
}
function invalidateRuleCache() { _ruleCache = null; }

// Longest/most-specific matching phrase wins; priority (set at creation, defaults to phrase length) breaks ties.
function matchDescription(description) {
  const hay = norm(description);
  if (!hay) return null;
  let best = null;
  for (const r of rulesForMatching()) {
    if (!hay.includes(r.needle)) continue;
    if (!best || r.needle.length > best.needle.length || (r.needle.length === best.needle.length && r.priority > best.priority)) best = r;
  }
  return best || null;
}

function txnKey(date, description, debit, credit, balance) {
  return [date || '', norm(description), Number(debit) || 0, Number(credit) || 0, balance == null ? '' : Number(balance)].join('\u0001');
}

// Pull the cheque/reference number out of a bank (or GL remarks) description - the key the Excel uses to
// match a bank line to its GL entry. Deliberately requires a '#', or the word chq/cheque, before the digits
// (never a bare number in parentheses) so an account/sender number quoted elsewhere in the text is not
// mistaken for a cheque number.
function extractRefNo(description) {
  const s = String(description || '');
  let m = s.match(/#\s*(\d{5,})/);
  if (m) return m[1];
  m = s.match(/\bchq\.?\s*no\.?\s*:?\s*(\d{5,})/i);
  if (m) return m[1];
  m = s.match(/\bchq\.?\s*(\d{5,})\b/i);
  if (m) return m[1];
  m = s.match(/\bcheque\s+(\d{5,})\b/i);
  if (m) return m[1];
  m = s.match(/\bcheque\b[^0-9(]{0,20}\(\s*#?\s*(\d{5,})\s*\)/i);
  if (m) return m[1];
  // "Vo:12345/2026" - a voucher number; when several appear (e.g. a PRC: ref followed by the real
  // voucher), the GL consistently keys off the LAST one in the line, not the first.
  const voMatches = [...s.matchAll(/\bvo:?\s*(\d{5,})/gi)];
  if (voMatches.length) return voMatches[voMatches.length - 1][1];
  // Bank Al Habib / RAAST-style exports put the transaction's own reference at the very start of the
  // line, before any description text (e.g. "10176540 TRNSFERS CHQ DR, ..." or a long RAAST txn ID).
  m = s.match(/^(\d{5,})\b/);
  if (m) return m[1];
  return null;
}

let _glCache = null, _glNameCache = null, _glCacheAt = 0;
function glCodeRules() {
  const now = Date.now();
  if (!_glCache || now - _glCacheAt > 5000) {
    _glCache = db.prepare('SELECT prefix, category_id FROM gl_code_rules').all();
    _glNameCache = new Map(db.prepare('SELECT name, category_id, debit_category_id FROM gl_name_rules').all()
      .map((r) => [norm(r.name), { category_id: r.category_id, debit_category_id: r.debit_category_id }]));
    _glCacheAt = now;
  }
  return _glCache;
}
function glNameRules() { glCodeRules(); return _glNameCache; }
function invalidateGlCache() { _glCache = null; _glNameCache = null; }

/**
 * GL cross-reference match: the cheque number on the bank line is looked up in that company's GL
 * extract to find the real offset account. Two ways that can resolve to a category:
 *  (a) the offset account's first 3 letters are a business-partner-type code (gl_code_rules) - e.g. a
 *      vendor or distributor code;
 *  (b) failing that, the GL's own Offset Acct Name (an internal chart-of-accounts entry like "FSA" or
 *      "CEO Current Account" - never a business-partner code, so (a) can't see it) matches gl_name_rules.
 *      A name rule can also be direction-aware (debit_category_id set): e.g. "Leopards Courier" is a
 *      receipt (From Distributors) on a credit but a fee payment (Vendor Payments) on a debit.
 * A third, more precise way wins over both when it's available: the offset account's FULL code (not
 * just its 3-letter prefix) found exactly in that company's uploaded Master Data (bp_master - the
 * business-partner-to-category master list, e.g. "DSD00001" -> Donations). Checked first, since an
 * exact code match is more reliable than a generic 3-letter class.
 * Returns null if there's no cheque number, no matching GL entry, or nothing recognises it - that
 * last case means a person needs to decide the category (and add it to one of the tables for next time).
 */
// Shared by the cheque-based and amount-based tiers: given a GL entry's offset account, resolve its
// category via (a) Master Data exact code match, (b) the 3-letter business-partner prefix, (c) the
// account's own name. Returns null if none of the three recognise it.
function resolveOffsetCategory(companyId, offsetAcct, offsetAcctName, debit) {
  if (offsetAcct) {
    const bp = db.prepare('SELECT category_id FROM bp_master WHERE company_id = ? AND bp_code = ? AND category_id IS NOT NULL').get(companyId, offsetAcct);
    if (bp) return bp.category_id;
    const prefix = String(offsetAcct).slice(0, 3).toUpperCase();
    const rule = glCodeRules().find((r) => r.prefix === prefix);
    if (rule) return rule.category_id;
  }
  if (offsetAcctName) {
    const rule = glNameRules().get(norm(offsetAcctName));
    if (rule) return (debit && rule.debit_category_id) ? rule.debit_category_id : rule.category_id;
  }
  return null;
}

/**
 * A reference number is sometimes not unique across the GL (e.g. a bank's routing/branch code that
 * recurs on every remittance through it) - different postings sharing it can resolve to DIFFERENT
 * categories. Picking the first one blindly would silently mistag some of them. So: resolve every GL
 * row sharing this trans_no, and only commit if either (a) they all agree on one category, or (b) the
 * bank line's own amount exactly matches exactly one of those rows' amount, which settles which one
 * applies. Anything still ambiguous after that returns null rather than guessing.
 */
function matchGL(description, companyId, refNo, debit, credit) {
  const ref = refNo !== undefined ? refNo : extractRefNo(description);
  if (!ref || !companyId) return null;
  const rows = db.prepare('SELECT offset_acct, offset_acct_name, amount FROM gl_entries WHERE company_id = ? AND (trans_no = ? OR trans_no2 = ?)').all(companyId, ref, ref);
  if (!rows.length) return null;

  const byOffset = new Map();
  for (const r of rows) {
    const key = r.offset_acct || `name:${r.offset_acct_name}`;
    if (!byOffset.has(key)) {
      const cid = resolveOffsetCategory(companyId, r.offset_acct, r.offset_acct_name, debit);
      byOffset.set(key, { category_id: cid, amounts: [] });
    }
    byOffset.get(key).amounts.push(r.amount);
  }
  const resolved = [...byOffset.values()].filter((v) => v.category_id != null);
  const distinctCats = new Set(resolved.map((v) => v.category_id));
  if (distinctCats.size === 1) return { category_id: [...distinctCats][0], ref_no: ref };
  if (distinctCats.size > 1) {
    const amt = Number(debit) || Number(credit) || 0;
    const cents = Math.round(amt * 100);
    const hit = resolved.find((v) => v.amounts.some((a) => a != null && Math.round(Math.abs(a) * 100) === cents));
    if (hit) return { category_id: hit.category_id, ref_no: ref };
    return null; // genuinely ambiguous - a person needs to decide
  }
  return null;
}

/**
 * Tier-4 fallback (last resort, after cheque number, code pattern and narration all fail): if this
 * exact amount appears on exactly ONE GL entry for this company - genuinely unique, not just today's
 * transactions - and that entry resolves to a category, use it. Two unrelated payments sharing a round
 * number would make the amount non-unique and this correctly returns null rather than guessing.
 */
function matchByAmount(companyId, debit, credit) {
  const amt = Number(debit) || Number(credit) || 0;
  if (!amt || !companyId) return null;
  const cents = Math.round(amt * 100);
  const rows = db.prepare(`SELECT offset_acct, offset_acct_name FROM gl_entries WHERE company_id = ? AND ROUND(ABS(amount) * 100) = ?`).all(companyId, cents);
  if (rows.length !== 1) return null;
  const cid = resolveOffsetCategory(companyId, rows[0].offset_acct, rows[0].offset_acct_name, !!debit);
  return cid ? { category_id: cid } : null;
}

/**
 * Ingest a statement's parsed transaction lines (date/description/debit/credit) into cashflow_transactions,
 * auto-tagging each from the learned/seed keyword rules.
 *
 * Several banks (HMB in particular) e-mail a CUMULATIVE statement every day - "1st of the month to today" -
 * so the same real transaction shows up again in every later statement for that account. Re-inserting those
 * verbatim would multiply every balance by however many overlapping statements have been received. Instead,
 * de-dupe against everything already on file for this bank account (by date+description+debit+credit+balance,
 * which uniquely identifies a real line - two genuinely separate transactions never share a running balance):
 * a line already present is left exactly as it is (so an earlier manual/rule tag survives), only a line that
 * has never been seen for this account gets inserted.
 */
function ingestStatementTransactions({ statementId, bankAccountId, companyId, bankId, txns }) {
  if (!statementId || !bankAccountId || !Array.isArray(txns)) return { inserted: 0, skipped: 0 };
  const existing = new Set(
    db.prepare('SELECT txn_date, description, debit, credit, balance FROM cashflow_transactions WHERE bank_account_id = ?').all(bankAccountId)
      .map((r) => txnKey(r.txn_date, r.description, r.debit, r.credit, r.balance))
  );
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM cashflow_transactions WHERE statement_id = ?').get(statementId).n;
  const ins = db.prepare(`INSERT INTO cashflow_transactions
    (statement_id, bank_account_id, company_id, bank_id, txn_date, description, debit, credit, balance, seq, ref_no, category_id, tag_method, tag_rule_id, tagged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const bumpHit = db.prepare('UPDATE cashflow_rules SET hit_count = hit_count + 1 WHERE id = ?');
  if (sharedEngine) sharedEngine.invalidate();
  const otherStmt = new Map(), sameStmtCount = new Map();
  for (const r of db.prepare('SELECT txn_date, debit, credit FROM cashflow_transactions WHERE bank_account_id = ? AND statement_id != ?').all(bankAccountId, statementId)) {
    const dk = `${r.txn_date}|${Math.round(r.debit * 100)}|${Math.round(r.credit * 100)}`;
    otherStmt.set(dk, (otherStmt.get(dk) || 0) + 1);
  }
  db.exec('BEGIN');
  try {
    let inserted = 0, skipped = 0, seq = nextSeq;
    for (const t of txns) {
      const debit = Number(t.debit) || 0, credit = Number(t.credit) || 0;
      if (!debit && !credit) continue;
      const k = txnKey(t.date, t.description, debit, credit, t.balance);
      if (existing.has(k)) { skipped++; continue; }
      // the same bank line can arrive in a second statement format (PDF + xls) worded differently: if the
      // account already holds as many lines with this date and amount from OTHER statements as this
      // statement has, they are the same lines
      const dk = `${t.date}|${Math.round(debit * 100)}|${Math.round(credit * 100)}`;
      if (!sameStmtCount.has(dk)) {
        sameStmtCount.set(dk, { thisFile: txns.filter((x) => `${x.date}|${Math.round((Number(x.debit) || 0) * 100)}|${Math.round((Number(x.credit) || 0) * 100)}` === dk).length,
          other: otherStmt.get(dk) || 0, used: 0 });
      }
      const dc = sameStmtCount.get(dk);
      if (dc.used < dc.other) { dc.used++; skipped++; continue; }
      existing.add(k);
      let refNo, categoryId, method, ruleId;
      if (sharedEngine) {
        const c = sharedEngine.classify({ description: t.description, company_id: companyId, bank_account_id: bankAccountId, debit, credit });
        refNo = c.ref_no; categoryId = c.category_id; method = c.method; ruleId = c.rule_id;
      } else {
        refNo = extractRefNo(t.description);
        const gl = matchGL(t.description, companyId, refNo, debit, credit);
        const hit = gl ? null : matchDescription(t.description);
        const amt = (gl || hit) ? null : matchByAmount(companyId, debit, credit);
        categoryId = gl ? gl.category_id : hit ? hit.category_id : amt ? amt.category_id : null;
        method = gl ? 'gl' : hit ? 'rule' : amt ? 'amount' : null;
        ruleId = hit ? hit.id : null;
      }
      ins.run(statementId, bankAccountId, companyId, bankId, t.date || null, t.description || '', debit, credit,
        t.balance != null ? Number(t.balance) : null, seq++, refNo, categoryId, method,
        ruleId, method ? new Date().toISOString() : null);
      if (ruleId) bumpHit.run(ruleId);
      inserted++;
    }
    db.exec('COMMIT');
    return { inserted, skipped };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Manually tag one transaction, and learn its exact description as a high-priority rule for next time. */
function tagTransaction(txnId, categoryId, actor) {
  const txn = db.prepare('SELECT * FROM cashflow_transactions WHERE id = ?').get(txnId);
  if (!txn) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  const cat = db.prepare('SELECT * FROM cashflow_categories WHERE id = ?').get(categoryId);
  if (!cat) throw Object.assign(new Error('Category not found'), { status: 400 });

  db.prepare(`UPDATE cashflow_transactions SET category_id = ?, tag_method = 'manual', tag_rule_id = NULL, tagged_by = ?, tagged_at = datetime('now') WHERE id = ?`)
    .run(categoryId, actor, txnId);

  const phrase = norm(txn.description).slice(0, 180);
  let learned = null;
  if (phrase.length >= 6) {
    const existing = db.prepare('SELECT * FROM cashflow_rules WHERE phrase = ? AND match_type = ?').get(phrase, 'exact');
    if (existing) {
      if (existing.category_id !== categoryId) db.prepare('UPDATE cashflow_rules SET category_id = ? WHERE id = ?').run(categoryId, existing.id);
    } else {
      const r = db.prepare(`INSERT INTO cashflow_rules (phrase, match_type, category_id, source, priority, created_by) VALUES (?, 'exact', ?, 'learned', ?, ?)`)
        .run(phrase, categoryId, 1000 + phrase.length, actor);
      learned = Number(r.lastInsertRowid);
    }
    invalidateRuleCache();
  }
  logAudit(actor, 'tag', 'cashflow_transactions', txnId, { category_id: categoryId, learned_rule: learned });
  return { ok: true, learned_rule: learned };
}

/** Re-run GL-match then keyword rules against every untagged transaction (or all, if includeAlreadyTagged). */
function retag({ includeAlreadyTagged = false } = {}) {
  invalidateRuleCache();
  invalidateGlCache();
  const rows = db.prepare(`SELECT id, description, company_id, ref_no, debit, credit FROM cashflow_transactions WHERE ${includeAlreadyTagged ? '1=1' : "category_id IS NULL"}`).all();
  const updGl = db.prepare(`UPDATE cashflow_transactions SET category_id = ?, tag_method = 'gl', tag_rule_id = NULL, ref_no = ?, tagged_at = datetime('now') WHERE id = ?`);
  const updRule = db.prepare(`UPDATE cashflow_transactions SET category_id = ?, tag_method = 'rule', tag_rule_id = ?, tagged_at = datetime('now') WHERE id = ?`);
  const updAmt = db.prepare(`UPDATE cashflow_transactions SET category_id = ?, tag_method = 'amount', tag_rule_id = NULL, tagged_at = datetime('now') WHERE id = ?`);
  const bumpHit = db.prepare('UPDATE cashflow_rules SET hit_count = hit_count + 1 WHERE id = ?');
  let tagged = 0, byGl = 0, byAmount = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const refNo = r.ref_no || extractRefNo(r.description);
      const gl = matchGL(r.description, r.company_id, refNo, r.debit, r.credit);
      if (gl) { updGl.run(gl.category_id, refNo, r.id); tagged++; byGl++; continue; }
      const hit = matchDescription(r.description);
      if (hit) { updRule.run(hit.category_id, hit.id, r.id); bumpHit.run(hit.id); tagged++; continue; }
      const amt = matchByAmount(r.company_id, r.debit, r.credit);
      if (amt) { updAmt.run(amt.category_id, r.id); tagged++; byAmount++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { scanned: rows.length, tagged, byGl, byAmount };
}

/** Load GL ledger entries for a company (cheque number -> offset account), for the Tier-1 GL cross-reference match. */
function importGlEntries({ companyId, entries, sourceFile, actor }) {
  if (!companyId || !Array.isArray(entries)) return { inserted: 0 };
  const ins = db.prepare(`INSERT INTO gl_entries (company_id, trans_no, offset_acct, offset_acct_name, remarks, posting_date, amount, source_file, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    let inserted = 0;
    for (const e of entries) {
      if (!e.transNo) continue;
      ins.run(companyId, e.transNo, e.offsetAcct || null, e.offsetAcctName || null, e.remarks || null,
        e.postingDate || null, e.amount != null ? Number(e.amount) : null, sourceFile || null, actor || null);
      inserted++;
    }
    db.exec('COMMIT');
    return { inserted };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
function glEntryCount(companyId) {
  return db.prepare('SELECT COUNT(*) AS n FROM gl_entries WHERE company_id = ?').get(companyId).n;
}
function listGlCodeRules() {
  return db.prepare(`SELECT g.*, c.name AS category_name FROM gl_code_rules g JOIN cashflow_categories c ON c.id = g.category_id ORDER BY g.prefix`).all();
}
function listGlNameRules() {
  return db.prepare(`SELECT g.*, c.name AS category_name, dc.name AS debit_category_name
    FROM gl_name_rules g JOIN cashflow_categories c ON c.id = g.category_id
    LEFT JOIN cashflow_categories dc ON dc.id = g.debit_category_id ORDER BY g.name`).all();
}
function addGlNameRule({ name, categoryId, debitCategoryId }) {
  const n = String(name || '').trim();
  if (!n) throw Object.assign(new Error('Name is required'), { status: 400 });
  const r = db.prepare('INSERT OR REPLACE INTO gl_name_rules (name, category_id, debit_category_id) VALUES (?, ?, ?)')
    .run(n, categoryId, debitCategoryId || null);
  invalidateGlCache();
  return Number(r.lastInsertRowid);
}
function deleteGlNameRule(id) { db.prepare('DELETE FROM gl_name_rules WHERE id = ?').run(id); invalidateGlCache(); }

// Offset-account names seen in the GL that neither gl_code_rules nor gl_name_rules can resolve - the
// bigger-ticket ones a person should look at and decide, since every future cheque with that same
// internal account name will keep landing in Review until it's added to gl_name_rules.
function unmappedGlNames({ limit = 25 } = {}) {
  return db.prepare(`
    SELECT offset_acct_name AS name, COUNT(*) AS n, SUM(ABS(amount)) AS amount
    FROM gl_entries
    WHERE offset_acct_name IS NOT NULL AND offset_acct_name != ''
      AND substr(offset_acct, 1, 3) NOT IN (SELECT prefix FROM gl_code_rules)
      AND lower(trim(offset_acct_name)) NOT IN (SELECT lower(trim(name)) FROM gl_name_rules)
    GROUP BY offset_acct_name ORDER BY n DESC LIMIT ?
  `).all(limit);
}

/** Load a company's business-partner master list (bp_code -> category), the Excel's most precise tagging tier. */
function importBpMaster({ companyId, entries, sourceFile, actor }) {
  if (!companyId || !Array.isArray(entries)) return { inserted: 0 };
  const ins = db.prepare(`INSERT INTO bp_master (company_id, bp_code, name, type, group_name, category_id, source_file, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, bp_code) DO UPDATE SET name=excluded.name, type=excluded.type, group_name=excluded.group_name,
      category_id=excluded.category_id, source_file=excluded.source_file, uploaded_by=excluded.uploaded_by, uploaded_at=datetime('now')`);
  db.exec('BEGIN');
  try {
    let inserted = 0;
    for (const e of entries) {
      if (!e.bpCode) continue;
      ins.run(companyId, e.bpCode, e.name || null, e.type || null, e.group || null, e.categoryId || null, sourceFile || null, actor || null);
      inserted++;
    }
    db.exec('COMMIT');
    return { inserted };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
function bpMasterCount(companyId) { return db.prepare('SELECT COUNT(*) AS n FROM bp_master WHERE company_id = ?').get(companyId).n; }

function addRule({ phrase, categoryId, matchType = 'contains', actor }) {
  const p = String(phrase || '').trim();
  if (!p) throw Object.assign(new Error('Phrase is required'), { status: 400 });
  const r = db.prepare(`INSERT INTO cashflow_rules (phrase, match_type, category_id, source, priority, created_by) VALUES (?, ?, ?, 'manual', ?, ?)`)
    .run(p, matchType, categoryId, p.length, actor);
  invalidateRuleCache();
  return Number(r.lastInsertRowid);
}
function deleteRule(id) {
  db.prepare('DELETE FROM cashflow_rules WHERE id = ?').run(id);
  invalidateRuleCache();
}

// ---------------- Report: categories (Receipts/Payments) x companies, for a date range ----------------
function buildReport({ from, to, companyId } = {}) {
  const companies = db.prepare(`SELECT id, name, code FROM companies WHERE deleted_at IS NULL AND status='active' AND cashflow_enabled=1 ${companyId ? 'AND id = ?' : ''} ORDER BY display_order`)
    .all(...(companyId ? [companyId] : []));
  const categories = listCategories();

  const where = ['txn_date IS NOT NULL'];
  const params = [];
  if (from) { where.push('txn_date >= ?'); params.push(from); }
  if (to) { where.push('txn_date <= ?'); params.push(to); }
  if (companyId) { where.push('company_id = ?'); params.push(companyId); }
  const rows = db.prepare(`SELECT company_id, category_id, SUM(debit) AS debit, SUM(credit) AS credit, COUNT(*) AS n
     FROM cashflow_transactions WHERE ${where.join(' AND ')} GROUP BY company_id, category_id`).all(...params);

  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category_id)) byCat.set(r.category_id, new Map());
    byCat.get(r.category_id).set(r.company_id, { debit: r.debit || 0, credit: r.credit || 0, n: r.n });
  }
  const untaggedRow = db.prepare(`SELECT COUNT(*) AS n, SUM(debit) AS debit, SUM(credit) AS credit FROM cashflow_transactions
     WHERE category_id IS NULL AND ${where.join(' AND ')}`).all(...params)[0] || { n: 0, debit: 0, credit: 0 };

  const net = (c) => (c.credit || 0) - (c.debit || 0);
  const section = (list, direction) => list.map((cat) => {
    const perCompany = companies.map((co) => {
      const cell = (byCat.get(cat.id) || new Map()).get(co.id) || { debit: 0, credit: 0, n: 0 };
      return { company_id: co.id, amount: direction === 'in' ? net(cell) : -net(cell), n: cell.n };
    });
    const total = perCompany.reduce((s, c) => s + c.amount, 0);
    return { id: cat.id, name: cat.name, perCompany, total };
  });

  const receipts = section(categories.filter((c) => c.direction === 'in'), 'in');
  const payments = section(categories.filter((c) => c.direction === 'out'), 'out');
  const totalReceipts = receipts.reduce((s, r) => s + r.total, 0);
  const totalPayments = payments.reduce((s, r) => s + r.total, 0);

  // opening/closing balance per account, rolled up by company, from daily_positions (already maintained by the app)
  const companyFilter = companyId ? `AND a.company_id = ${Number(companyId)}` : '';
  const opening = from ? (db.prepare(`SELECT a.company_id, p.position_date, p.balance FROM daily_positions p JOIN bank_accounts a ON a.id=p.bank_account_id
      WHERE a.deleted_at IS NULL ${companyFilter} AND p.position_date < ? ORDER BY p.position_date DESC`).all(from)
      .reduce((map, r) => { if (!map.has(r.company_id)) map.set(r.company_id, r.balance); return map; }, new Map())) : new Map();
  const closing = to ? (db.prepare(`SELECT a.company_id, p.position_date, p.balance FROM daily_positions p JOIN bank_accounts a ON a.id=p.bank_account_id
      WHERE a.deleted_at IS NULL ${companyFilter} AND p.position_date <= ? ORDER BY p.position_date DESC`).all(to)
      .reduce((map, r) => { if (!map.has(r.company_id)) map.set(r.company_id, r.balance); return map; }, new Map())) : new Map();
  const sumMap = (m) => [...m.values()].reduce((s, v) => s + (Number(v) || 0), 0);

  return {
    companies, from: from || null, to: to || null,
    receipts, payments,
    totalReceipts, totalPayments, net: totalReceipts - totalPayments,
    openingBalance: sumMap(opening) || null, closingBalance: sumMap(closing) || null,
    untagged: { count: untaggedRow.n || 0, amount: (untaggedRow.credit || 0) - (untaggedRow.debit || 0) },
  };
}

function listTransactions({ from, to, companyId, bankAccountId, categoryId, status, q, limit = 200, offset = 0 } = {}) {
  const where = ['1=1'], params = [];
  if (from) { where.push('t.txn_date >= ?'); params.push(from); }
  if (to) { where.push('t.txn_date <= ?'); params.push(to); }
  if (companyId) { where.push('t.company_id = ?'); params.push(companyId); }
  if (bankAccountId) { where.push('t.bank_account_id = ?'); params.push(bankAccountId); }
  if (categoryId) { where.push('t.category_id = ?'); params.push(categoryId); }
  if (status === 'untagged') where.push('t.category_id IS NULL');
  if (status === 'tagged') where.push('t.category_id IS NOT NULL');
  if (q) { where.push('t.description LIKE ?'); params.push(`%${q}%`); }
  const rows = db.prepare(`SELECT t.*, c.name AS category_name, co.name AS company_name, bk.name AS bank_name, a.account_title
      FROM cashflow_transactions t
      JOIN bank_accounts a ON a.id = t.bank_account_id
      JOIN companies co ON co.id = t.company_id
      JOIN banks bk ON bk.id = t.bank_id
      LEFT JOIN cashflow_categories c ON c.id = t.category_id
      WHERE ${where.join(' AND ')} ORDER BY t.txn_date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cashflow_transactions t WHERE ${where.join(' AND ')}`).get(...params).n;
  return { rows, total };
}

// Backfill: re-run the parser against every already-processed statement's stored file and ingest its
// transactions. Used once when the module is first switched on, so history isn't lost.
async function backfillFromStatements({ limit } = {}) {
  const { processStatement } = require('../parser');
  const { decryptSecret, STORAGE_DIR } = require('../db');
  const path = require('path');
  const stmts = db.prepare(`SELECT s.*, a.statement_password_enc FROM statements s JOIN bank_accounts a ON a.id = s.bank_account_id
    WHERE s.deleted_at IS NULL AND s.status IN ('processed','review') AND s.stored_path IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM cashflow_transactions t WHERE t.statement_id = s.id)
    ORDER BY s.id ASC ${limit ? 'LIMIT ' + Number(limit) : ''}`).all();
  let done = 0, failed = 0, totalTxns = 0;
  for (const s of stmts) {
    try {
      const filePath = path.join(STORAGE_DIR, s.stored_path);
      const password = decryptSecret(s.statement_password_enc) || undefined;
      const result = await processStatement({ filePath, originalName: s.file_name, password, expected: {}, confidenceThreshold: 0 });
      if (!result.txnList || !result.txnList.length) continue;
      const r = ingestStatementTransactions({
        statementId: s.id, bankAccountId: s.bank_account_id, companyId: s.company_id, bankId: s.bank_id, txns: result.txnList,
      });
      totalTxns += r.inserted;
      done++;
    } catch (e) { failed++; }
  }
  return { statements: stmts.length, done, failed, totalTxns };
}

module.exports = {
  listCategories, listRules, matchDescription, invalidateRuleCache,
  extractRefNo, matchGL, matchByAmount, invalidateGlCache, importGlEntries, glEntryCount, listGlCodeRules,
  listGlNameRules, addGlNameRule, deleteGlNameRule, unmappedGlNames,
  ingestStatementTransactions, tagTransaction, retag, addRule, deleteRule,
  buildReport, listTransactions, backfillFromStatements,
};
