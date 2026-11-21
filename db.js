const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
let sea;
try { sea = require('node:sea'); } catch { sea = null; }

function isSea() {
  return !!(sea && sea.isSea && sea.isSea());
}

function baseDir() {
  return isSea() ? path.dirname(process.execPath) : __dirname;
}

const DATA_DIR = path.join(baseDir(), 'data');
const STORAGE_DIR = path.join(baseDir(), 'storage', 'statements');
const BACKUP_DIR = path.join(baseDir(), 'backups');
const SESSION_SECRET_PATH = path.join(baseDir(), '.session-secret');
const DB_PATH = path.join(DATA_DIR, 'bankposition.db');

for (const d of [DATA_DIR, STORAGE_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

function getSessionSecret() {
  if (fs.existsSync(SESSION_SECRET_PATH)) {
    return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

// ---- Local secret box for at-rest encryption of stored PDF passwords ----
function secretKey() {
  return crypto.createHash('sha256').update('bpp::' + getSessionSecret()).digest();
}
function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'finance_user',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER
);

CREATE TABLE IF NOT EXISTS access_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  section TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  UNIQUE(role, section)
);

CREATE TABLE IF NOT EXISTS user_company_scope (
  user_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_log(table_name, record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER
);

CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT,
  parser_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  bank_id INTEGER NOT NULL REFERENCES banks(id),
  account_number TEXT,
  account_title TEXT,
  currency TEXT NOT NULL DEFAULT 'PKR',
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  display_order INTEGER NOT NULL DEFAULT 0,
  statement_password_enc TEXT,
  match_hints_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_company ON bank_accounts(company_id, deleted_at);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  company_id INTEGER,
  bank_id INTEGER,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_hash TEXT,
  stored_path TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  statement_from TEXT,
  statement_to TEXT,
  latest_statement_date TEXT,
  opening_balance REAL,
  closing_balance_reported REAL,
  extracted_balance REAL,
  currency TEXT,
  confidence REAL,
  parser TEXT,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  error_message TEXT,
  warnings_json TEXT,
  raw_extract_json TEXT,
  page_count INTEGER,
  txn_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_statements_account ON statements(bank_account_id, latest_statement_date DESC);
CREATE INDEX IF NOT EXISTS idx_statements_hash ON statements(file_hash);

CREATE TABLE IF NOT EXISTS daily_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  position_date TEXT NOT NULL,
  balance REAL,
  source_type TEXT NOT NULL DEFAULT 'pending',
  statement_id INTEGER REFERENCES statements(id),
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(bank_account_id, position_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_positions(position_date);

CREATE TABLE IF NOT EXISTS balance_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER REFERENCES statements(id),
  daily_position_id INTEGER REFERENCES daily_positions(id),
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  position_date TEXT,
  original_balance REAL,
  corrected_balance REAL,
  reason TEXT,
  corrected_by TEXT,
  corrected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS off_days (
  weekday INTEGER PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT UNIQUE NOT NULL,
  name TEXT
);

CREATE TABLE IF NOT EXISTS fund_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS fund_pool_accounts (
  pool_id INTEGER NOT NULL REFERENCES fund_pools(id),
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  PRIMARY KEY (pool_id, bank_account_id)
);

CREATE TABLE IF NOT EXISTS reserve_heads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL REFERENCES fund_pools(id),
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS reserve_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  head_id INTEGER NOT NULL REFERENCES reserve_heads(id),
  as_of TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(head_id, as_of)
);

CREATE TABLE IF NOT EXISTS account_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  name TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'deduct',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS adjustment_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_id INTEGER NOT NULL REFERENCES account_adjustments(id),
  as_of TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(adjustment_id, as_of)
);

CREATE TABLE IF NOT EXISTS fund_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  label TEXT,
  kind TEXT NOT NULL,
  pool_id INTEGER,
  head_id INTEGER,
  formula TEXT,
  headline INTEGER NOT NULL DEFAULT 0,
  display_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS parser_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER REFERENCES banks(id),
  name TEXT,
  rule_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Cashflow module: categorised bank transactions ----------
CREATE TABLE IF NOT EXISTS cashflow_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  direction TEXT NOT NULL DEFAULT 'either',
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cashflow_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',
  category_id INTEGER NOT NULL REFERENCES cashflow_categories(id),
  source TEXT NOT NULL DEFAULT 'seed',
  priority INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_cf_rules_phrase ON cashflow_rules(phrase);

CREATE TABLE IF NOT EXISTS cashflow_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER REFERENCES statements(id),
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  company_id INTEGER NOT NULL,
  bank_id INTEGER NOT NULL,
  txn_date TEXT,
  description TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  balance REAL,
  seq INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES cashflow_categories(id),
  tag_method TEXT,
  tag_rule_id INTEGER REFERENCES cashflow_rules(id),
  tagged_by TEXT,
  tagged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(statement_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cf_txn_account_date ON cashflow_transactions(bank_account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_cf_txn_category ON cashflow_transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_cf_txn_company_date ON cashflow_transactions(company_id, txn_date);

-- GL cross-reference tagging (the Excel's most reliable tier): a cheque/reference number extracted from
-- the bank description is looked up in the company's GL extract to find the real offset account, whose
-- first 3 letters (a business-partner-type code, e.g. VNI/DSD/VEM) decide the category.
CREATE TABLE IF NOT EXISTS gl_code_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT UNIQUE NOT NULL,
  category_id INTEGER NOT NULL REFERENCES cashflow_categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Internal chart-of-accounts names (e.g. "FSA", "CEO Current Account", "Bank Charges") whose offset
-- account prefix isn't a business-partner code at all (gl_code_rules only covers those) - matched by the
-- GL entry's own Offset Acct Name instead, which SAP/accounting exports use consistently.
-- category_id is used when the transaction is a credit (or always, if debit_category_id is NULL);
-- debit_category_id, when set, overrides it for a debit - e.g. "Leopards Courier" is a receipt
-- (From Distributors) on a credit but a fee payment (Vendor Payments) on a debit.
CREATE TABLE IF NOT EXISTS gl_name_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category_id INTEGER NOT NULL REFERENCES cashflow_categories(id),
  debit_category_id INTEGER REFERENCES cashflow_categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gl_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  trans_no TEXT NOT NULL,
  offset_acct TEXT,
  offset_acct_name TEXT,
  remarks TEXT,
  posting_date TEXT,
  amount REAL,
  source_file TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gl_entries_company_trans ON gl_entries(company_id, trans_no);
`);

addColumnIfMissing('cashflow_transactions', 'ref_no', 'TEXT');
addColumnIfMissing('gl_name_rules', 'debit_category_id', 'INTEGER REFERENCES cashflow_categories(id)');
addColumnIfMissing('companies', 'cashflow_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('gl_entries', 'trans_no2', 'TEXT');
addColumnIfMissing('cashflow_rules', 'bank_account_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_gl_entries_company_trans2 ON gl_entries(company_id, trans_no2)');

db.exec(`
CREATE TABLE IF NOT EXISTS bp_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  bp_code TEXT NOT NULL,
  name TEXT,
  type TEXT,
  group_name TEXT,
  category_id INTEGER REFERENCES cashflow_categories(id),
  source_file TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, bp_code)
);
`);
addColumnIfMissing('companies', 'aliases', 'TEXT');
addColumnIfMissing('statements', 'deleted_at', 'TEXT');
addColumnIfMissing('statements', 'deleted_by', 'TEXT');
addColumnIfMissing('statements', 'delete_reason', 'TEXT');
addColumnIfMissing('statements', 'days_posted', 'INTEGER');
addColumnIfMissing('statements', 'daily_json', 'TEXT');

// ---------- seed ----------
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
    const hash = bcrypt.hashSync('123', 10);
    db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('123', 'Super User', hash, 'super_user');
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM access_permissions').get().c === 0) {
    const sections = ['dashboard', 'upload', 'monthly', 'reports', 'review', 'corrections', 'config', 'users', 'settings'];
    const grants = {
      super_user: () => 1,
      finance_user: (s) => ['dashboard', 'upload', 'monthly', 'reports', 'review'].includes(s) ? 1 : 0,
      viewer: (s) => ['dashboard', 'monthly', 'reports'].includes(s) ? 1 : 0,
    };
    const ins = db.prepare('INSERT OR IGNORE INTO access_permissions (role, section, allowed) VALUES (?, ?, ?)');
    for (const role of Object.keys(grants)) for (const s of sections) ins.run(role, s, grants[role](s));
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM off_days').get().c === 0) {
    const ins = db.prepare('INSERT INTO off_days (weekday, active) VALUES (?, ?)');
    // 0=Sun .. 6=Sat ; default off = Sunday only
    for (let w = 0; w <= 6; w++) ins.run(w, w === 0 ? 1 : 0);
  }

  const defaults = {
    working_date_default: 'today',
    confidence_threshold: '0.75',
    carry_forward_offdays: 'true',
    group_name: 'Demo Group of Companies',
  };
  const su = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) su.run(k, v);

  if (db.prepare('SELECT COUNT(*) AS c FROM companies').get().c === 0) {
    seedOrgStructure();
  }
}

// Example cashflow categories and keyword rules so the portal can start tagging on day one.
// Edit them in Setup to suit your own group.
const CASHFLOW_RECEIPT_CATEGORIES = [
  'From Distributors', 'From Trading Distributors', 
  'From Institutes', 'Against Exports', 'Loan from Affiliate', 'Income Tax Refund',
  'From Provident Fund', 'Other Receipts',
];
const CASHFLOW_PAYMENT_CATEGORIES = [
  'Import (Raw and Packaging)', 'Vendor Payments', 'Salaries, Incentive, Expenses, PF & FSA',
  'Sales, Marketing & Business Promotion', 'Office Expenses (incl. Factory Utility Bills)',
  'Institutional Security Deposits', 'Payment to and on behald of CE & Directors', 'Export Expense',
  'Transfer to Locker', 'Payment of Taxes', 'Civil Works', 'Donations', 'Bank Charges',
  'Internal A/C Transfer', 'Land Payment', 'Transfer to Directors', 'Lease Payments',
  'Affiliate A', 'Affiliate B', 'Investment', 'Transfer to Fund Trustee',
  'Withdrawal for PF investment', 'Loan to Affiliate', 'Registration, R & D Payments', 'Retention Account',
];
const CASHFLOW_KEYWORD_RULES = [
  ['Commission/Charges Recovered', 'Import (Raw and Packaging)'], ['Commission Recovered On Import', 'Import (Raw and Packaging)'],
  ['PAD Retired', 'Import (Raw and Packaging)'], ['BRANCH UBPS to 1-BILL INVOICE', 'Import (Raw and Packaging)'],
  ['Cash deposited', 'From Distributors'], ['16% Punjab Sales Tax on Services', 'Import (Raw and Packaging)'],
  ['LFT:', 'Salaries, Incentive, Expenses, PF & FSA'], ['SDR Cancellation Charges', 'From Institutes'],
  ['Margin Recovered, LC', 'Import (Raw and Packaging)'], ['PO Realized', 'From Institutes'],
  ['Service Charges, DO Issue', 'Import (Raw and Packaging)'], ['Margin Reversed, LC #', 'Import (Raw and Packaging)'],
  ['Margin Recovered, DO Issue,', 'Import (Raw and Packaging)'], ['Doc. Recvd Sight Cont. Retired,', 'Import (Raw and Packaging)'],
  ['ADV/2/36/', 'Import (Raw and Packaging)'], ['Imp. Adv. Payment #', 'Import (Raw and Packaging)'],
  ['GFT :', 'Bank Charges'], ['Punjab Sales Tax on Services', 'Payment of Taxes'],
  ['BRANCH UBPS to FBR/CUSTOM', 'Payment of Taxes'], ['Margin Reversed, Contract #', 'Import (Raw and Packaging)'],
  ['INTBRN FT CR', 'From Distributors'], ['IBFT CR BAH', 'From Distributors'],
  ['RAAST P2P FT RAAST - IBFT', 'From Distributors'], ['FT-IB', 'From Distributors'],
  ['RTGS-INWARD WTS', 'From Distributors'], ['FED/SALESTAX DR SG:', 'Import (Raw and Packaging)'],
  ['IMP/EXP/MKP DR SG:', 'Import (Raw and Packaging)'], ['MARGIN AMT DR SG:', 'Import (Raw and Packaging)'],
  ['BANK CHARGES', 'Bank Charges'], ['FED/SALSTAX Credit Rept', 'Payment of Taxes'],
['FED/SALESTAX DR PRC:', 'Import (Raw and Packaging)'],
  ['ADVANCE PAYMENT PRC:', 'Import (Raw and Packaging)'], ['FED/SALESTAX DR ADV:', 'Import (Raw and Packaging)'],
  ['MARGIN AMT DR LC:', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP DR LC:', 'Import (Raw and Packaging)'],
  ['FED/SALESTAX DR LC:', 'Import (Raw and Packaging)'], ['FED/SALESTAX DR PAD:', 'Import (Raw and Packaging)'],
  ['IMP/EXP/MKP DR PAD:', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP DR ADV:', 'Import (Raw and Packaging)'],
  ['RTGS-Direct-Cr', 'From Distributors'], ['Foreign CCY-CR PAD:', 'Import (Raw and Packaging)'],
  ['TRANSFER DEBIT AIMP ADV PAY', 'Import (Raw and Packaging)'], ['FT CR', 'From Distributors'],
  ['INTBRN RECDP CR', 'From Distributors'], ['TRANSFER DEBIT', 'Bank Charges'], ['TRANSFER CREDIT', 'From Distributors'],
  ['ONL OWD CLG CR', 'From Distributors'], ['TIP - FUND TRANSFER', 'Import (Raw and Packaging)'],
  ['EFT Rec from Bank', 'From Distributors'], ['IMP/EXP/MKP IFDBC', 'Import (Raw and Packaging)'],
  ['FED/SALESTAX 16.00%', 'Import (Raw and Packaging)'], ['INTBRN', 'From Distributors'], ['IBFT', 'From Distributors'],
  ['IMP/EXP/MKP Contract Vo', 'Import (Raw and Packaging)'], ['FED/SALESTAX DR IFDB', 'Import (Raw and Packaging)'],
  ['IMP/EXP/MKP DR IFDB', 'Import (Raw and Packaging)'], ['FED/SALESTAX DR EF', 'Import (Raw and Packaging)'],
  ['EFORM EF', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP DR LCAD', 'Import (Raw and Packaging)'],
  ['FED/SALESTAX DR CONT:', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP DR CONT:', 'Import (Raw and Packaging)'],
  ['EPG*', 'From Distributors'], ['Commission, Amend Imp', 'Import (Raw and Packaging)'],
  ['CREDITED REPORT CHARGES RECOVERD', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP DR FDBC', 'Import (Raw and Packaging)'],
  ['FDBC REAL DR FDBC', 'Import (Raw and Packaging)'], ['FDBC REAL CR FDBC:', 'Import (Raw and Packaging)'],
  ['FED/SALESTAX DR FDBC:', 'Import (Raw and Packaging)'], ['UBL', 'From Distributors'], ['SCBLPKKA', 'From Distributors'],
  ['OTB', 'From Distributors'], ['ASCMPKKA', 'From Distributors'], ['MBMB', 'From Distributors'],
  ['FAYSPKKA', 'From Distributors'], ['Pay Order Cancellation', 'Bank Charges'], ['PO Cancelled', 'Sales, Marketing & Business Promotion'],
  ['BAHLPKKA', 'From Distributors'], ['EGIBPKKA', 'From Distributors'], ['Outward Chq#', 'From Distributors'],
  ['Foreign Lodge', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP Lodge', 'Import (Raw and Packaging)'],
  ['IMP/EXP/MKP Doc.Retirement', 'Import (Raw and Packaging)'], ['IMP/EXP/MKP Amend', 'Import (Raw and Packaging)'],
  ['FED/SALSTAX', 'Import (Raw and Packaging)'], ['TRANSFER CHARGES', 'Bank Charges'], ['Foreign CCY', 'Import (Raw and Packaging)'],
  ['IMP/EXP/MKP', 'Import (Raw and Packaging)'], ['FT ALHABIB INTERNT', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['FED/SALESTAX Amend', 'Import (Raw and Packaging)'], ['RAAST Web from', 'From Distributors'],
  ['SYMMETRY Funds Transfer', 'From Distributors'], ['MARGIN Issuance', 'Import (Raw and Packaging)'],
  ['Foreign Contract', 'Import (Raw and Packaging)'], ['CMS//', 'Import (Raw and Packaging)'],
  ['(Purpose : ) -', 'Salaries, Incentive, Expenses, PF & FSA'],
];

// GL offset-account prefix -> category (the Excel's Tier-1 / most reliable tagging rule: a cheque number
// from the bank statement is matched to the same cheque number in the GL extract, giving the real offset
// account; its first 3 letters are a business-partner-type code this table resolves to a category).
const GL_CODE_RULES = [
  // ['ABC', 'Vendor Payments'],   // add your own business-partner prefixes here
];

// Offset-account NAME -> category (internal chart-of-accounts entries, not business-partner codes).
// Only the unambiguous ones - anything whose real category is a judgment call is left for a person to tag.
const GL_NAME_RULES = [
  ['FSA', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Salary Payable', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Salaries, Wages & Benefits', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Incentive', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Over Time Payable', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Provident Fund Payable', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Bank Charges', 'Bank Charges'],
  ['CEO Current Account', 'Payment to and on behald of CE & Directors'],
  ['Sales Tax-Output', 'Payment of Taxes'],
  ['Import PSID’s', 'Import (Raw and Packaging)'],
  ['Import PSIDs', 'Import (Raw and Packaging)'],
  ['Cash In Hand', 'Internal A/C Transfer'],
  ['Current Account With Affiliate', 'Internal A/C Transfer'],
  ['Donations', 'Donations'],
  ['Marketing Activity', 'Sales, Marketing & Business Promotion'],
  ['Sales Tax With Held - Services', 'Payment of Taxes'],
  ['Income Tax Payable-Services', 'Payment of Taxes'],
  ['Field Force Travelling Expense', 'Salaries, Incentive, Expenses, PF & FSA'],
  ['Prize Bonds', 'Transfer to Locker'],
  ['Dr. Requisition/ Obligation', 'Sales, Marketing & Business Promotion'],
];
// Direction-aware rules: [name, creditCategory, debitCategory] - courier accounts that both collect
// COD cash from customers (a receipt) and charge their own delivery fee (a payment).
const GL_NAME_RULES_DIRECTIONAL = [
  ['TCS (Cash on Delivery)', 'From Distributors', 'Vendor Payments'],
  ['Leopards Courier Services Pvt.', 'From Distributors', 'Vendor Payments'],
  ['PostEx', 'From Distributors', 'Vendor Payments'],
];

function seedCashflow() {
  if (db.prepare('SELECT COUNT(*) AS c FROM cashflow_categories').get().c === 0) {
    const ins = db.prepare('INSERT INTO cashflow_categories (name, direction, display_order) VALUES (?, ?, ?)');
    let order = 0;
    CASHFLOW_RECEIPT_CATEGORIES.forEach((name) => ins.run(name, 'in', ++order));
    CASHFLOW_PAYMENT_CATEGORIES.forEach((name) => ins.run(name, 'out', ++order));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM cashflow_rules').get().c === 0) {
    const catId = (name) => db.prepare('SELECT id FROM cashflow_categories WHERE name = ?').get(name)?.id;
    const ins = db.prepare('INSERT INTO cashflow_rules (phrase, match_type, category_id, source, priority) VALUES (?, ?, ?, ?, ?)');
    CASHFLOW_KEYWORD_RULES.forEach(([phrase, cat], i) => {
      const cid = catId(cat);
      if (cid) ins.run(phrase, 'contains', cid, 'seed', phrase.length);   // longer/more specific phrases win ties
    });
  }
}

function seedOrgStructure() {
  const bankByName = {};
  const bankSpec = [
    ['Habib Metropolitan Bank', 'HMB', 'hmb'],
    ['Bank Al Habib', 'BAHL', 'bahl'],
    ['Askari Bank', 'AKBL', 'askari'],
    ['Meezan Bank', 'MBL', 'meezan'],
  ];
  const insBank = db.prepare('INSERT INTO banks (name, code, parser_key, display_order) VALUES (?, ?, ?, ?)');
  bankSpec.forEach((b, i) => { bankByName[b[0]] = Number(insBank.run(b[0], b[1], b[2], i + 1).lastInsertRowid); });

  const companies = [
    ['Acme Pharma Pvt Limited', 'ACM', ['Habib Metropolitan Bank', 'Bank Al Habib', 'Askari Bank', 'Meezan Bank']],
    ['Acme Pharma (Trade)', 'ACT', ['Habib Metropolitan Bank']],
    ['Northwind Health Pvt Limited', 'NWH', ['Habib Metropolitan Bank', 'Bank Al Habib', 'Askari Bank', 'Meezan Bank']],
    ['Contoso Aesthetics Pvt Limited', 'CNT', ['Bank Al Habib']],
    ['Globex Laboratories', 'GLX', ['Bank Al Habib', 'Meezan Bank']],
  ];
  const insCo = db.prepare('INSERT INTO companies (name, code, display_order) VALUES (?, ?, ?)');
  const insAcc = db.prepare(
    'INSERT INTO bank_accounts (company_id, bank_id, account_number, account_title, currency, display_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  companies.forEach((c, ci) => {
    const companyId = Number(insCo.run(c[0], c[1], ci + 1).lastInsertRowid);
    c[2].forEach((bn, bi) => {
      insAcc.run(companyId, bankByName[bn], null, c[0], 'PKR', bi + 1);
    });
  });
}

// ---------- accounts closed by a person as "no statement expected - this balance is correct" ----------
db.exec(`
CREATE TABLE IF NOT EXISTS missing_closed (
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  close_date TEXT NOT NULL,
  balance REAL,
  closed_by TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  PRIMARY KEY (bank_account_id, close_date)
);
`);

// ---------- unpresented cheques (issued + dispatched, not yet cleared by the bank) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS unpresented_cheques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  cheque_no TEXT NOT NULL,
  party TEXT,
  amount REAL NOT NULL,
  cheque_date TEXT,
  dispatch_date TEXT,
  dispatch_note TEXT,
  company_label TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  presented_date TEXT,
  presented_statement_id INTEGER,
  presented_amount REAL,
  presented_by TEXT,
  flag TEXT,
  flag_detail TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_unpresented_cheque ON unpresented_cheques (COALESCE(bank_account_id, 0), cheque_no);
CREATE INDEX IF NOT EXISTS ix_unpresented_status ON unpresented_cheques (status, bank_account_id);
`);

seedIfEmpty();

{
  const ins = db.prepare('INSERT OR IGNORE INTO access_permissions (role, section, allowed) VALUES (?, ?, ?)');
  const grants = { super_user: [1, 1], finance_user: [1, 1], viewer: [1, 0] };       // [funds view, funds edit]
  for (const [role, [view, edit]] of Object.entries(grants)) { ins.run(role, 'funds', view); ins.run(role, 'funds_edit', edit); }
  for (const [role, v] of Object.entries({ super_user: 1, finance_user: 1, viewer: 0 })) ins.run(role, 'adjust_edit', v);   // enter lien / adjustment amounts
  const cfGrants = { super_user: [1, 1], finance_user: [1, 1], viewer: [1, 0] };       // [cashflow view, cashflow tag/edit]
  for (const [role, [view, edit]] of Object.entries(cfGrants)) { ins.run(role, 'cashflow', view); ins.run(role, 'cashflow_edit', edit); }
}

seedCashflow();

// pick up any seed rule a later version of this file adds, without touching existing/learned rules
{
  const catId = (name) => db.prepare('SELECT id FROM cashflow_categories WHERE name = ?').get(name)?.id;
  const have = (phrase) => db.prepare("SELECT 1 FROM cashflow_rules WHERE phrase = ? AND source = 'seed'").get(phrase);
  const ins = db.prepare(`INSERT INTO cashflow_rules (phrase, match_type, category_id, source, priority) VALUES (?, 'contains', ?, 'seed', ?)`);
  CASHFLOW_KEYWORD_RULES.forEach(([phrase, cat]) => {
    if (have(phrase)) return;
    const cid = catId(cat);
    if (cid) ins.run(phrase, cid, phrase.length);
  });
  const insGl = db.prepare('INSERT OR IGNORE INTO gl_code_rules (prefix, category_id) VALUES (?, ?)');
  GL_CODE_RULES.forEach(([prefix, cat]) => { const cid = catId(cat); if (cid) insGl.run(prefix, cid); });
  const insGlName = db.prepare('INSERT OR IGNORE INTO gl_name_rules (name, category_id) VALUES (?, ?)');
  GL_NAME_RULES.forEach(([name, cat]) => { const cid = catId(cat); if (cid) insGlName.run(name, cid); });
  const insGlNameDir = db.prepare('INSERT OR IGNORE INTO gl_name_rules (name, category_id, debit_category_id) VALUES (?, ?, ?)');
  GL_NAME_RULES_DIRECTIONAL.forEach(([name, creditCat, debitCat]) => {
    const cid = catId(creditCat), did = catId(debitCat);
    if (cid && did) insGlNameDir.run(name, cid, did);
  });
}

// The last demo company is tracked in the portal but is out of scope for the group Cashflow report.
db.prepare("UPDATE companies SET cashflow_enabled = 0 WHERE code = 'GLX'").run();

// short names used in e-mail subjects / file names (editable in Setup); only filled where blank
{
  const defaults = { ACM: 'ACM, ACME', ACT: 'ACT, TRADE', NWH: 'NWH, NORTHWIND, HEALTH', CNT: 'CNT, CONTOSO', GLX: 'GLX, GLOBEX' };
  const up = db.prepare("UPDATE companies SET aliases = ? WHERE code = ? AND (aliases IS NULL OR aliases = '')");
  for (const [code, al] of Object.entries(defaults)) up.run(al, code);
}

// Meezan statements carry no account number, only a "Generated By" user code (for example DEMO1; digits ignored)
{
  const add = { GLX: 'GLOBX', NWH: 'NORTHW', ACM: 'ACMEX' };
  const get = db.prepare('SELECT id, aliases FROM companies WHERE code = ?');
  const set = db.prepare('UPDATE companies SET aliases = ? WHERE id = ?');
  for (const [code, alias] of Object.entries(add)) {
    const c = get.get(code);
    if (!c) continue;
    const have = String(c.aliases || '').split(/[,;]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!have.includes(alias)) set.run([...have, alias].join(', '), c.id);
  }
}

// ---------- helpers ----------
function logAudit(actor, action, tableName, recordId, details) {
  db.prepare(
    'INSERT INTO audit_log (actor, action, table_name, record_id, details_json) VALUES (?, ?, ?, ?, ?)'
  ).run(actor || 'system', action, tableName, recordId != null ? String(recordId) : null,
    details ? JSON.stringify(details) : null);
}

function getRecentAudit(tableName, recordId, limit = 15) {
  return db.prepare(
    'SELECT * FROM audit_log WHERE table_name = ? AND record_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(tableName, String(recordId), limit);
}

function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function runBackup(keep = 14) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `bankposition-${stamp}.db`);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('bankposition-') && f.endsWith('.db')).sort();
  while (files.length > keep) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  return dest;
}

module.exports = {
  db, isSea, baseDir,
  DATA_DIR, STORAGE_DIR, BACKUP_DIR, DB_PATH,
  getSessionSecret, encryptSecret, decryptSecret,
  addColumnIfMissing, logAudit, getRecentAudit, withTransaction,
  getSetting, setSetting, runBackup,
};
