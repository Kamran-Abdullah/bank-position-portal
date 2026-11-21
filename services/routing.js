'use strict';
/**
 * Works out WHICH bank account an emailed file belongs to.
 * Evidence, strongest first:
 *   1. account number printed in the file matches a configured account
 *   2. bank (from the file's own format) x company (from title / subject / file name / aliases)
 * Anything not clearly decided is left "unrouted" for a person to assign — nothing is guessed.
 */
const { db, decryptSecret } = require('../db');
const { processStatement } = require('../parser');

const STOP = new Set(['pvt', 'private', 'limited', 'ltd', 'the', 'of', 'and', 'co', 'company', 'statement', 'statements', 'soa', 'bank', 'account', 'estatement', 'pk', 'llc']);
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/s$/, '');
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const distinctive = (s) => new Set(tokens(s).filter((w) => w.length > 1 && !STOP.has(w)).map(stem));

const BANK_WORDS = [
  ['bahl', /\bbahl\b|\bbank\s*al\s*habib\b|\bal\s*habib\b/i],
  ['hmb', /\bhmb\b|habib\s*metropolitan|\bhbl\s*metro/i],
  ['meezan', /meezan|\bmbl\b/i],
  ['askari', /askari|\bakbl\b|nexcash/i],
];

function bankKeyFromText(text) {
  const t = String(text || '').replace(/[_./-]+/g, ' ');
  for (const [k, re] of BANK_WORDS) if (re.test(t)) return k;
  return null;
}

function loadAccounts() {
  return db.prepare(`
    SELECT a.id, a.account_number, a.statement_password_enc, a.company_id, a.bank_id,
           c.name AS company_name, c.code AS company_code, c.aliases AS company_aliases,
           bk.name AS bank_name, bk.parser_key
    FROM bank_accounts a JOIN companies c ON c.id = a.company_id JOIN banks bk ON bk.id = a.bank_id
    WHERE a.deleted_at IS NULL AND a.status = 'active' AND c.deleted_at IS NULL AND c.status = 'active'`).all();
}

function digits(s) { return String(s || '').replace(/\D/g, ''); }
function numbersMatch(a, b) {
  const x = digits(a), y = digits(b);
  if (!x || !y || Math.min(x.length, y.length) < 6) return false;
  return x.endsWith(y) || y.endsWith(x) || x.slice(-8) === y.slice(-8);
}

// score each company against free text; returns [{company_id, score}] sorted
function scoreCompanies(accounts, haystack) {
  const H = distinctive(haystack);
  const words = new Set(tokens(haystack));
  const byCo = new Map();
  accounts.forEach((a) => { if (!byCo.has(a.company_id)) byCo.set(a.company_id, a); });
  const all = [...byCo.values()].map((a) => ({ a, D: distinctive(a.company_name) }));
  const out = [];
  for (const { a, D } of all) {
    let score = 0;
    if (D.size) score = [...D].filter((t) => H.has(t)).length / D.size;
    const aliasList = String(a.company_aliases || '').split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (a.company_code) aliasList.push(String(a.company_code).toLowerCase());
    const norm = ' ' + tokens(haystack).join(' ') + ' ';
    const aliasHit = aliasList.some((al) => { const t = tokens(al).join(' '); return t.length >= 2 && norm.includes(' ' + t + ' '); });
    if (aliasHit) score += 1;
    // words that belong only to ANOTHER company (e.g. "trade") count against this one
    for (const o of all) {
      if (o.a.company_id === a.company_id) continue;
      for (const t of o.D) if (!D.has(t) && H.has(t)) score -= 0.5;
    }
    out.push({ company_id: a.company_id, score });
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * @param {{filePath:string, originalName:string, subject?:string, sender?:string}} f
 * @returns {Promise<{accountId:number|null, reason:string, candidates:Array, needPassword?:boolean, fileInfo:Object}>}
 */
async function routeFile(f) {
  const accounts = loadAccounts();
  const subject = f.subject || '';
  const hay = `${subject} ${f.originalName || ''}`;
  const info = { bank: null, accountNumber: null, title: null };

  // read the file itself (try every saved PDF password if it is protected). Photos are NOT read here
  // (slow, and the real read happens once after routing) — they route from the subject / file name.
  const isImage = /\.(jpe?g|png|bmp|tiff?|webp)$/i.test(f.originalName || '');
  let parsedInfo = null;
  const passwords = [undefined, ...accounts.map((a) => decryptSecret(a.statement_password_enc)).filter(Boolean)];
  for (const pw of (isImage ? [] : [...new Set(passwords)])) {
    let r;
    try { r = await processStatement({ filePath: f.filePath, originalName: f.originalName, password: pw, expected: {}, confidenceThreshold: 0.75 }); }
    catch { break; }
    if (r.status === 'need_password') { parsedInfo = { needPassword: true }; continue; }
    parsedInfo = r; break;
  }
  if (parsedInfo && parsedInfo.needPassword) {
    return { accountId: null, reason: 'PDF is password protected and none of the saved passwords opened it', needPassword: true, candidates: [], fileInfo: info };
  }
  if (parsedInfo) {
    info.accountNumber = parsedInfo.accountNumber || null;
    info.title = parsedInfo.accountTitle || null;
    const gb = parsedInfo.matchHints && parsedInfo.matchHints.generatedBy;
    if (gb) info.generatedBy = String(gb).replace(/[^A-Za-z]/g, '');     // DEMO1 -> DEMO (trailing digits ignored)
    const k = ['hmb', 'bahl', 'askari', 'meezan'].includes(parsedInfo.parser) ? parsedInfo.parser : bankKeyFromText(`${parsedInfo.bankGuess || ''}`);
    info.bank = k;
  }
  if (!info.accountNumber) { const m = String(f.originalName || '').match(/(?:^|[^0-9])(\d{12,20})(?:[^0-9]|$)/); if (m) info.accountNumber = m[1]; }
  if (!info.bank) info.bank = bankKeyFromText(hay);

  // 1) full account number printed in the file. (Masked numbers such as 0000-0000-XXXXXX-00-0 are NOT used:
  //    several accounts share the same visible digits, so they cannot identify one.)
  if (info.accountNumber && !/x/i.test(info.accountNumber)) {
    const hits = accounts.filter((a) => numbersMatch(a.account_number, info.accountNumber));
    if (hits.length === 1) return { accountId: hits[0].id, reason: `account number ${info.accountNumber} matches`, candidates: [hits[0].id], fileInfo: info };
  }

  // 2) bank x company
  const pool = info.bank ? accounts.filter((a) => a.parser_key === info.bank) : accounts;
  if (!pool.length) return { accountId: null, reason: 'no configured account for this bank', candidates: [], fileInfo: info };
  const text = `${hay} ${info.title || ''} ${info.generatedBy || ''}`;
  const ranked = scoreCompanies(pool, text);
  const top = ranked[0], second = ranked[1];
  const cand = ranked.filter((r) => r.score > 0).map((r) => pool.find((a) => a.company_id === r.company_id).id);
  if (top && top.score >= 0.99 && (!second || top.score - second.score >= 0.3)) {
    const acc = pool.filter((a) => a.company_id === top.company_id);
    if (acc.length === 1 && info.accountNumber && /x/i.test(info.accountNumber) && acc[0].account_number) {
      const m = info.accountNumber.replace(/[^0-9Xx]/g, '').toUpperCase(), d = digits(acc[0].account_number);
      if (m.length === d.length && ![...m].every((ch, i) => ch === 'X' || ch === d[i]))
        return { accountId: null, reason: 'company recognised but the masked account number in the file does not fit that account', candidates: [acc[0].id], fileInfo: info };
    }
    if (acc.length === 1) return { accountId: acc[0].id, reason: `${info.bank || 'bank'} + company "${acc[0].company_name}" recognised`, candidates: cand, fileInfo: info, learn: true };
  }
  return { accountId: null, reason: info.bank ? `could not tell which ${info.bank.toUpperCase()} account this is` : 'could not tell which bank / company this is', candidates: cand, fileInfo: info };
}

module.exports = { routeFile, bankKeyFromText, scoreCompanies, loadAccounts };
