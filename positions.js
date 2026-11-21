'use strict';
const { db, getSetting, logAudit } = require('./db');
const { adjustmentsAt, sumDelta } = require('./services/adjustments');

function offDayWeekdays() {
  const rows = db.prepare('SELECT weekday FROM off_days WHERE active = 1').all();
  return new Set(rows.map((r) => r.weekday));
}
function isHoliday(dateStr) {
  return !!db.prepare('SELECT 1 FROM holidays WHERE holiday_date = ?').get(dateStr);
}
function isOffDay(dateStr) {
  const wd = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return offDayWeekdays().has(wd) || isHoliday(dateStr);
}

function upsertDailyPosition(o) {
  const { accountId, date, balance, sourceType, statementId = null, status, note = null, actor = 'system' } = o;
  const existing = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(accountId, date);
  if (existing) {
    db.prepare(`UPDATE daily_positions SET balance = ?, source_type = ?, statement_id = ?, status = ?, note = ?,
      updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
      .run(balance, sourceType, statementId, status, note, actor, existing.id);
    logAudit(actor, 'update', 'daily_positions', existing.id, { date, balance, sourceType, status });
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO daily_positions
    (bank_account_id, position_date, balance, source_type, statement_id, status, note, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, date, balance, sourceType, statementId, status, note, actor);
  logAudit(actor, 'create', 'daily_positions', info.lastInsertRowid, { date, balance, sourceType, status });
  return Number(info.lastInsertRowid);
}

// Resolve the position shown for one account on one working date.
function resolvePosition(accountId, date) {
  const exact = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(accountId, date);
  if (exact && exact.balance != null && ['actual', 'manual'].includes(exact.source_type) && exact.status === 'done') {
    return { balance: exact.balance, source_type: exact.source_type, status: 'done', statement_id: exact.statement_id, note: exact.note, position_date: date };
  }
  if (exact && exact.status === 'review') {
    return { balance: exact.balance, source_type: exact.source_type, status: 'review', statement_id: exact.statement_id, note: exact.note, position_date: date };
  }
  // pending statement in error/review state for this date?
  const st = db.prepare(`SELECT id, status FROM statements WHERE bank_account_id = ? AND latest_statement_date = ?
    ORDER BY uploaded_at DESC LIMIT 1`).get(accountId, date);
  if (st && st.status === 'error') return { balance: null, source_type: 'pending', status: 'error', statement_id: st.id, position_date: date };
  if (st && st.status === 'review') return { balance: null, source_type: 'review', status: 'review', statement_id: st.id, position_date: date };

  const carry = getSetting('carry_forward_offdays', 'true') === 'true';
  if (carry) {
    const prev = db.prepare(`SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date < ?
      AND balance IS NOT NULL AND status = 'done' ORDER BY position_date DESC LIMIT 1`).get(accountId, date);
    if (prev && (isOffDay(date) || true)) {
      return {
        balance: prev.balance,
        source_type: 'carried_forward',
        status: isOffDay(date) ? 'carried_forward' : 'carried_forward',
        statement_id: prev.statement_id,
        carried_from: prev.position_date,
        position_date: date,
      };
    }
  }
  return { balance: null, source_type: 'pending', status: 'pending', position_date: date };
}

function getDashboard(date) {
  const companies = db.prepare(`SELECT * FROM companies WHERE deleted_at IS NULL AND status = 'active'
    ORDER BY display_order, name`).all();
  const accStmt = db.prepare(`SELECT a.*, b.name AS bank_name, b.parser_key, b.display_order AS bank_order
    FROM bank_accounts a JOIN banks b ON b.id = a.bank_id
    WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.status = 'active'
    ORDER BY a.display_order, b.display_order, b.name`);

  const counters = { total: 0, done: 0, pending: 0, review: 0, error: 0, carried_forward: 0 };
  const adjMap = adjustmentsAt(date);
  let groupTotal = 0, groupAdjust = 0, anyAdjust = false;
  const out = companies.map((co) => {
    const accounts = accStmt.all(co.id).map((a) => {
      const pos = resolvePosition(a.id, date);
      counters.total++;
      counters[pos.status] = (counters[pos.status] || 0) + 1;
      return {
        account_id: a.id,
        bank_id: a.bank_id,
        bank_name: a.bank_name,
        parser_key: a.parser_key,
        account_number: a.account_number,
        account_title: a.account_title,
        currency: a.currency,
        has_password: !!a.statement_password_enc,
        balance: pos.balance,
        status: pos.status,
        source_type: pos.source_type,
        statement_id: pos.statement_id || null,
        carried_from: pos.carried_from || null,
        adjustments: adjMap.get(a.id) || [],
      };
    });
    // only trusted statuses roll up into company / group totals
    const known = accounts.filter((x) => x.balance != null && ['done', 'carried_forward'].includes(x.status));
    const companyTotal = known.reduce((s, x) => s + x.balance, 0);
    known.forEach((x) => { x.net_balance = x.balance + sumDelta(x.adjustments); });
    accounts.forEach((x) => { if (x.net_balance === undefined) x.net_balance = x.balance != null && x.adjustments.length ? x.balance + sumDelta(x.adjustments) : x.balance; if (x.adjustments.length) anyAdjust = true; });
    const companyAdjust = known.reduce((s, x) => s + sumDelta(x.adjustments), 0);
    groupTotal += companyTotal; groupAdjust += companyAdjust;
    return {
      company_id: co.id, company_name: co.name, company_code: co.code,
      accounts,
      company_total: companyTotal,
      company_adjust: companyAdjust,
      company_net: companyTotal + companyAdjust,
      accounts_known: known.length,
      accounts_total: accounts.length,
    };
  });

  return {
    date,
    is_off_day: isOffDay(date),
    group_name: getSetting('group_name', 'Group'),
    group_total: groupTotal,
    group_adjust: groupAdjust,
    group_net: groupTotal + groupAdjust,
    has_adjustments: anyAdjust || adjMap.size > 0,
    counters,
    companies: out,
  };
}

// ---- closed days ----
// Once a day has passed, its confirmed balance is closed: statement imports never change it (a different figure is held for review)
// and only a Super User may correct it. Anything that is not confirmed yet (carried forward / missing) can still be filled in.
// The one exception is an intraday figure: a statement fetched ON the day itself shows the balance at that moment, so the first
// statement that arrives afterwards may replace it once.
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function lockedValue(accountId, date) {
  if (!date || date >= localToday()) return null;
  const cur = db.prepare('SELECT * FROM daily_positions WHERE bank_account_id = ? AND position_date = ?').get(accountId, date);
  if (!cur || cur.status !== 'done' || cur.balance == null || !['actual', 'manual'].includes(cur.source_type)) return null;
  if (cur.source_type === 'actual') {
    const setOn = db.prepare("SELECT date(?, 'localtime') AS d").get(cur.updated_at || cur.created_at).d;
    if (setOn === date) return null;                      // intraday figure, not final yet
  }
  return cur;
}
// returns an error message when a non-admin tries to change closed days, otherwise null
function closedDayError(user, accountId, dates) {
  if (user && user.role === 'super_user') return null;
  const past = [...new Set((dates || []).filter((d) => d && d < localToday()))];
  return past.length ? `${past.join(', ')} ${past.length > 1 ? 'are past days' : 'is a past day'}: only today's balance can be entered. Past days can only be changed by an administrator.` : null;
}

module.exports = { isOffDay, offDayWeekdays, upsertDailyPosition, resolvePosition, getDashboard, lockedValue, closedDayError, localToday };
