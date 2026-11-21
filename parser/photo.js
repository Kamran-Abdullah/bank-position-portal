'use strict';
/**
 * Photo / screenshot statements (ledger screen shots: Date | Particulars | Debit | Credit | Balance).
 *
 * Plain full-page OCR mangles skewed phone photos, so this reads the *columns*:
 *  1. find money tokens with word boxes; numbers are right-aligned, so the right edge of every
 *     token is stable per column even when Tesseract drops leading digits;
 *  2. cluster right edges -> Debit / Credit / Balance columns (Balance = right-most);
 *  3. re-read every cell on its own (single-line mode, several scales, digits only);
 *  4. read the date column the same way;
 *  5. VERIFY: balance[k+1] must equal balance[k] + credits - debits of the rows in between.
 *     A balance is only trusted when it takes part in a passing check, so a mis-read digit
 *     can never slip through silently.
 */
const Jimp = require('jimp');
const { recognizeWords } = require('./ocr');

const MONEY_END = /\d{2}\.\d{2}$/;             // tolerant of dropped leading digits
const MONEY_FULL = /^\d{1,3}(,\d{3})*\.\d{2}$/;
const cleanNum = (t) => String(t || '').replace(/[^0-9,.]/g, '');
const num = (s) => parseFloat(String(s).replace(/,/g, ''));

async function prep(img, scale) {
  const c = img.clone().scale(scale).greyscale().contrast(0.3).normalize();
  return c.getBufferAsync(Jimp.MIME_PNG);
}

async function readRegion(img, box, scale, params) {
  const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
  const w = Math.min(img.bitmap.width - x, Math.round(box.w)), h = Math.min(img.bitmap.height - y, Math.round(box.h));
  if (w < 10 || h < 10) return [];
  const buf = await prep(img.clone().crop(x, y, w, h), scale);
  const words = await recognizeWords(buf, params);
  return words.map((t) => ({ text: t.text, x0: x + t.x0 / scale, x1: x + t.x1 / scale, y: y + (t.y0 + t.y1) / 2 / scale }));
}

function cluster(items, tol) {
  const s = [...items].sort((a, b) => a.v - b.v);
  const groups = [];
  for (const it of s) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.v - g.mean) <= tol) { g.items.push(it); g.mean = g.items.reduce((a, b) => a + b.v, 0) / g.items.length; }
    else groups.push({ items: [it], mean: it.v });
  }
  return groups;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseLooseDate(t) {
  const m = String(t).match(/(\d{1,2})\s*[-–]\s*([A-Za-z]{3})\w*\s*[-–]\s*(\d{2,4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return null;
  return { d: +m[1], m: mi, yr: +m[3] < 100 ? 2000 + +m[3] : +m[3] };
}

// one-line OCR of a single cell at several crop widths / scales, plus earlier full readings.
// Returns every distinct reading ranked by votes (the arithmetic check picks the right one).
async function readCell(img, R, y, width, vals, wide) {
  const votes = new Map();
  const add = (t) => { if (MONEY_FULL.test(t) && num(t) >= 1) votes.set(num(t), (votes.get(num(t)) || 0) + 1); };
  const variants = wide
    ? [[0, 0], [0, 16], [0, 32], [0, 52], [6, 0], [6, 24], [6, 48], [-5, 24]]
    : [[0, 0], [0, 14], [4, 0]];
  for (const [dy, dw] of variants) {
    const words = await readRegion(img, { x: R - width - dw, y: y - 24 + dy, w: width + dw + 10, h: 48 }, 4, { psm: '7', whitelist: '0123456789,.' });
    add(cleanNum(words.map((w) => w.text).join('')));
  }
  for (const v of vals) votes.set(v, (votes.get(v) || 0) + 1);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return ranked.length ? { v: ranked[0][0], votes: ranked[0][1], cands: ranked.map((r) => r[0]).slice(0, 6), alts: ranked.slice(1, 4).map((r) => r[0]) } : null;
}

async function parsePhoto(filePath) {
  const img = await Jimp.read(filePath);
  const W = img.bitmap.width, H = img.bitmap.height;
  const S = W < 1800 ? 2 : 1;
  const out = { ok: false, reason: null, balances: [], notes: [], checks: [] };

  // ---- pass A: whole image, several page-segmentation modes ----
  const base = await prep(img, S);
  const money = [], dateToks = [], hintToks = [];
  for (const psm of ['11', '6', '3']) {
    const words = await recognizeWords(base, { psm });
    for (const w of words) {
      const t = cleanNum(w.text);
      const rec = { text: t, x0: w.x0 / S, x1: w.x1 / S, y: (w.y0 + w.y1) / 2 / S };
      if (MONEY_END.test(t) && t.length >= 5) money.push(rec);
      if (/\d{1,2}\s*-\s*[A-Za-z]{3}/.test(w.text)) dateToks.push({ ...rec, raw: w.text });
      const hm = String(w.text).match(/DT[:;.\-]\s?(\d{2})(\d{2})/i);
      if (hm && +hm[1] >= 1 && +hm[1] <= 12 && +hm[2] >= 1 && +hm[2] <= 31) hintToks.push({ y: rec.y, m: +hm[1] - 1, d: +hm[2] });
    }
  }
  if (money.length < 3) { out.reason = 'too few amounts recognised'; return out; }
  // dates quoted inside descriptions ("Chq Dt. 07-Sep-2026") are not row dates: keep the left-most column only
  if (dateToks.length > 1) {
    const cl = cluster(dateToks.map((d) => ({ v: d.x0, d })), 40).filter((g) => g.items.length >= 2).sort((a, b) => a.mean - b.mean);
    if (cl.length) { const keep = new Set(cl[0].items.map((z) => z.d)); for (let i = dateToks.length - 1; i >= 0; i--) if (!keep.has(dateToks[i])) dateToks.splice(i, 1); }
  }

  // ---- columns: numbers are right-aligned, so cluster the RIGHT edges ----
  const edge = cluster(money.map((m) => ({ v: m.x1, m })), 24).filter((g) => g.items.length >= 2).sort((a, b) => a.mean - b.mean);
  if (!edge.length) { out.reason = 'could not find the balance column'; return out; }
  const balR = edge[edge.length - 1].mean;
  const prevR = edge.length >= 2 ? edge[edge.length - 2].mean : null;
  const gap = prevR ? Math.min(Math.max(balR - prevR, 100), 180) : 120;
  const colR = [balR - 2 * gap, balR - gap, balR];               // Debit, Credit, Balance (expected slots)
  const width = Math.max(gap, 122) + 4;
  const colTokens = colR.map((R) => money.filter((m) => Math.abs(m.x1 - R) <= 26));
  const present = colR.map((R, i) => (i === 2 ? true : colTokens[i].length >= 1));

  // ---- read every column: whole-strip OCR (best for amounts) + per-cell OCR (best for the balance) ----
  const cells = [[], [], []];
  for (let ci = 0; ci < 3; ci++) {
    if (!present[ci]) continue;
    const extra = ci === 2 ? 40 : 6;
    const sx = colR[ci] - width - extra;
    // (a) strip reads
    const stripHits = [];
    for (const psm of ['6', '4']) {
      const words = await readRegion(img, { x: sx, y: 0, w: width + extra + 12, h: H }, 3, { psm, whitelist: '0123456789,.' });
      for (const w of words) { const t = cleanNum(w.text); if (MONEY_FULL.test(t) && num(t) >= 1) stripHits.push({ y: w.y, v: num(t), wt: 2 }); }
    }
    // (b) full readings from the whole-image passes
    const passHits = colTokens[ci].filter((m) => MONEY_FULL.test(m.text) && num(m.text) >= 1).map((m) => ({ y: m.y, v: num(m.text), wt: 1 }));
    // (c) row positions: every y where anything (even a partial number) was seen
    const rows = [];
    const seen = [...stripHits, ...passHits, ...colTokens[ci].map((m) => ({ y: m.y, v: null, wt: 0 }))].sort((a, b) => a.y - b.y);
    for (const h of seen) {
      const r = rows.find((x) => Math.abs(x.ys.reduce((a, b) => a + b, 0) / x.ys.length - h.y) <= 14);
      if (r) { r.ys.push(h.y); r.hits.push(h); } else rows.push({ ys: [h.y], hits: [h] });
    }
    for (const r of rows) {
      const y = r.ys.reduce((a, b) => a + b, 0) / r.ys.length;
      const votes = new Map();
      for (const h of r.hits) if (h.v != null) votes.set(h.v, (votes.get(h.v) || 0) + h.wt);
      const strong = [...votes.values()].some((v) => v >= 3);
      if (ci === 2 || !strong) {
        const cell = await readCell(img, colR[ci], y, width, [], ci === 2);
        if (cell) cell.cands.forEach((v) => votes.set(v, (votes.get(v) || 0) + 1));
      }
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
      if (ranked.length) cells[ci].push({ y, v: ranked[0][0], votes: ranked[0][1], cands: ranked.map((q) => q[0]).slice(0, 6), alts: ranked.slice(1, 4).map((q) => q[0]) });
    }
  }
  // rows where an amount exists but nothing was detected (e.g. a lone 3,774.00) : interpolate the row grid
  {
    const ys = [...new Set([].concat(...cells).map((c) => Math.round(c.y)))].sort((a, b) => a - b);
    const diffs = ys.slice(1).map((y, i) => y - ys[i]).filter((d) => d > 30);
    const small = diffs.filter((d) => d < 70);
    const pitch = small.length ? [...small].sort((a, b) => a - b)[Math.floor(small.length / 2)] : 0;
    if (pitch) {
      const slots = [];
      for (let i = 0; i < ys.length - 1; i++) {
        const d = ys[i + 1] - ys[i], k = Math.round(d / pitch);
        if (k >= 2 && k <= 4 && Math.abs(d / k - pitch) < pitch * 0.14) for (let j = 1; j < k; j++) slots.push(ys[i] + (d * j) / k);
      }
      for (let ci = 0; ci < 2; ci++) {
        if (!present[ci]) continue;
        for (const y of slots) {
          if (cells[ci].some((c) => Math.abs(c.y - y) <= 14)) continue;
          const cell = await readCell(img, colR[ci], y, width, [], true);
          if (cell && cell.v >= 1) cells[ci].push({ y, v: cell.v, votes: cell.votes, cands: cell.cands, alts: cell.alts, slot: true });
        }
      }
    }
  }
  const bal = cells[2].sort((a, b) => a.y - b.y);
  if (!bal.length) { out.reason = 'no balance values read'; return out; }

  // ---- verification by arithmetic ----
  // balance[k+1] must equal balance[k] + credits - debits of the rows in between. Every balance
  // has several candidate readings; pick the sequence that maximises passing checks.
  const TOL = 14;
  const flowCols = [cells[0].sort((a, b) => a.y - b.y), cells[1].sort((a, b) => a.y - b.y)];
  const flowSum = (y0, y1, sign, subst) => flowCols.reduce((s, list, idx) => s + list
    .filter((c) => c.y > y0 + TOL && c.y <= y1 + TOL)
    .reduce((a, c) => a + (subst.has(c) ? subst.get(c) : c.v), 0) * (sign[idx] || 0), 0);
  let orientations;
  if (present[0] && present[1]) orientations = [[-1, 1], [1, -1]];
  else if (present[1]) orientations = [[0, 1], [0, -1]];
  else orientations = [[1, 0], [-1, 0]];
  const close = (a, b) => Math.abs(a - b) < 0.005;
  const edgeOk = (k, vi, vj, sign, subst) => close(bal[k].cands[vi] + flowSum(bal[k].y, bal[k + 1].y, sign, subst), bal[k + 1].cands[vj]);

  // A reading that lost its leading digits ("819,168.52" for 19,819,168.52) is completed when the
  // amount columns give an exact expected value whose trailing digits equal that reading.
  const digitsOf = (v) => v.toFixed(2).replace('.', '');
  function complete(sign) {
    let added = 0;
    for (let k = 0; k < bal.length; k++) {
      const expect = [];
      if (k > 0) bal[k - 1].cands.forEach((c) => expect.push(c + flowSum(bal[k - 1].y, bal[k].y, sign, new Map())));
      if (k < bal.length - 1) bal[k + 1].cands.forEach((c) => expect.push(c - flowSum(bal[k].y, bal[k + 1].y, sign, new Map())));
      for (const e of expect) {
        if (e < 1 || bal[k].cands.some((c) => close(c, e))) continue;
        const de = digitsOf(e);
        if (bal[k].cands.some((c) => c < e && digitsOf(c).length >= 6 && de.endsWith(digitsOf(c)))) { bal[k].cands.push(Math.round(e * 100) / 100); bal[k].completed = true; added++; }
      }
    }
    return added;
  }
  for (let pass = 0; pass < 2; pass++) if (!complete(orientations[0]) && !complete(orientations[1])) break;

  function solve(sign, subst) {
    const n = bal.length;
    const dp = bal.map((b) => b.cands.map(() => ({ s: -1e9, prev: -1 })));
    dp[0].forEach((c, i) => { c.s = -i * 0.001; });
    for (let k = 0; k < n - 1; k++) {
      for (let j = 0; j < bal[k + 1].cands.length; j++) {
        for (let i = 0; i < bal[k].cands.length; i++) {
          const sc = dp[k][i].s + (edgeOk(k, i, j, sign, subst) ? 1 : 0) - j * 0.001;
          if (sc > dp[k + 1][j].s) dp[k + 1][j] = { s: sc, prev: i };
        }
      }
    }
    let j = 0; dp[n - 1].forEach((c, i) => { if (c.s > dp[n - 1][j].s) j = i; });
    const pick = new Array(n); pick[n - 1] = j;
    for (let k = n - 1; k > 0; k--) pick[k - 1] = dp[k][pick[k]].prev;
    const edges = [];
    for (let k = 0; k < n - 1; k++) edges.push({ k, ok: edgeOk(k, pick[k], pick[k + 1], sign, subst) });
    return { pick, edges, passes: edges.filter((e) => e.ok).length };
  }

  let best = null;
  for (const sign of orientations) {
    const r = solve(sign, new Map());
    if (!best || r.passes > best.passes) best = { sign, ...r };
  }
  // failing intervals: try the alternate readings of the amount cells in that interval
  const subst = new Map();
  let repaired = 0;
  for (const e of best.edges.filter((x) => !x.ok)) {
    const lo = bal[e.k].y, hi = bal[e.k + 1].y;
    const cand = [];
    flowCols.forEach((list) => list.forEach((c) => { if (c.y > lo + TOL && c.y <= hi + TOL && c.alts.length) cand.push(c); }));
    if (!cand.length || cand.length > 6) continue;
    let done = false;
    for (let mask = 1; mask < (1 << cand.length) && !done; mask++) {
      const trial = new Map(subst);
      cand.forEach((c, i) => { if (mask & (1 << i)) trial.set(c, c.alts[0]); });
      for (let vi = 0; vi < bal[e.k].cands.length && !done; vi++) {
        for (let vj = 0; vj < bal[e.k + 1].cands.length && !done; vj++) {
          if (edgeOk(e.k, vi, vj, best.sign, trial)) { trial.forEach((v, c) => subst.set(c, v)); repaired++; done = true; }
        }
      }
    }
  }
  const fin = solve(best.sign, subst);
  const verified = new Array(bal.length).fill(false);
  fin.edges.forEach((e) => { if (e.ok) { verified[e.k] = true; verified[e.k + 1] = true; } });
  out.checks = fin.edges.map((e) => ({ k: e.k, ok: e.ok }));
  out.orientation = best.sign.join(',');
  bal.forEach((b, i) => { b.v = b.cands[fin.pick[i]]; });

  // ---- dates: read the date cell beside every balance row ----
  const dx0 = dateToks.length ? Math.min(...dateToks.map((d) => d.x0)) - 22 : null;
  const dx1 = dateToks.length ? Math.max(...dateToks.map((d) => d.x1)) + 34 : null;
  const dateRead = [];
  for (const d of dateToks) { const p = parseLooseDate(d.raw); if (p) dateRead.push({ y: d.y, ...p }); }
  const perBal = [];
  if (dx0 != null) {
    for (const b of bal) {
      const found = [];
      for (const sc of [4, 3]) {
        const words = await readRegion(img, { x: dx0, y: b.y - 34, w: dx1 - dx0, h: 72 }, sc, { psm: '6', whitelist: '0123456789-*ADFJMNOSacegnopruvbltyk ' });
        const p = parseLooseDate(words.map((w) => w.text).join(' '));
        if (p) found.push(p);
      }
      perBal.push(found);
    }
  }
  const yc = {};
  dateRead.forEach((d) => { yc[d.yr] = (yc[d.yr] || 0) + 1; });
  perBal.flat().forEach((d) => { yc[d.yr] = (yc[d.yr] || 0) + 1; });
  const top = Object.entries(yc).sort((a, b) => b[1] - a[1])[0];
  const year = top ? +top[0] : null;   // OCR often turns 2026 into 2021/2028: take the most common year
  const toIso = (p) => (year && p.d >= 1 && p.d <= 31 ? `${year}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null);
  const nearest = (y) => {
    let bestD = null;
    for (const d of dateRead) { const dy = Math.abs(d.y - y); if (dy <= 48 && (!bestD || dy < bestD.dy)) bestD = { p: d, dy }; }
    return bestD ? toIso(bestD.p) : null;
  };
  // rows of one date share a background colour (blue / pink bands): segment by colour so a date read on
  // any row of the band applies to every row in it
  const bandX = dateToks.length ? Math.max(4, Math.min(...dateToks.map((d) => d.x0)) - 10) : 6;
  const cls = [];
  for (let y = 0; y < H; y++) {
    let r = 0, bl = 0, n = 0;
    for (let x = Math.round(bandX); x < Math.round(bandX) + 6 && x < W; x++) { const c = Jimp.intToRGBA(img.getPixelColor(x, y)); r += c.r; bl += c.b; n++; }
    cls.push(n ? (r / n - bl / n > 6 ? 'p' : bl / n - r / n > 6 ? 'b' : 'x') : 'x');
  }
  const segs = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    if (cls[y] === 'x') continue;
    if (!cur || cur.c !== cls[y]) { cur = { c: cls[y], y0: y, y1: y }; segs.push(cur); } else cur.y1 = y;
  }
  const bandSegs = segs.filter((sg) => sg.y1 - sg.y0 >= 25);
  const segOf = (y) => bandSegs.find((sg) => y >= sg.y0 - 6 && y <= sg.y1 + 6);
  const segDates = new Map();
  const noteDate = (y, iso, weight) => { const sg = segOf(y); if (!sg || !iso) return; const t = segDates.get(sg) || {}; t[iso] = (t[iso] || 0) + weight; segDates.set(sg, t); };
  dateRead.forEach((d) => noteDate(d.y, toIso(d), 1));
  bal.forEach((b, i) => { (perBal[i] || []).forEach((p) => noteDate(b.y, toIso(p), 2)); });
  const segDate = (y) => { const sg = segOf(y); const t = sg && segDates.get(sg); const e = t && Object.entries(t).sort((a, c) => c[1] - a[1])[0]; return e ? e[0] : null; };
  out.balances = bal.map((b, i) => {
    const ev = {};
    const vote = (iso, w) => { if (iso) ev[iso] = (ev[iso] || 0) + w; };
    dateRead.forEach((d) => { const dy = Math.abs(d.y - b.y); if (dy <= 44) vote(toIso(d), dy <= 30 ? 3 : 2); });
    (perBal[i] || []).forEach((p) => vote(toIso(p), 3));
    hintToks.forEach((h) => { const dy = Math.abs(h.y - b.y); if (dy <= 36) vote(toIso({ d: h.d, m: h.m }), 2); });
    vote(segDate(b.y), 1);
    // dates only move forward down the screen: drop a reading earlier than a (repeated) date seen above
    const seenAbove = {};
    dateRead.forEach((d) => { if (d.y < b.y - 10) { const iso = toIso(d); if (iso) seenAbove[iso] = (seenAbove[iso] || 0) + 1; } });
    const floor = Object.keys(seenAbove).filter((k) => seenAbove[k] >= 2).sort().pop();
    if (floor) Object.keys(ev).forEach((k) => { if (k < floor) delete ev[k]; });
    const ranked = Object.entries(ev).sort((x, y2) => y2[1] - x[1]);
    const top = ranked[0];
    // 'read' needs two agreeing sources: one OCR'd date digit is never trusted on its own
    const conf = top && top[1] >= 5 && (!ranked[1] || ranked[1][1] <= top[1] - 2) ? 'read' : top ? 'weak' : null;
    return { y: b.y, value: b.v, votes: b.votes, verified: verified[i], completed: !!b.completed, date: top ? top[0] : null, dateConf: conf };
  });
  out.bands = bandSegs.length;
  out.repaired = repaired;
  out.debug = { cells: cells.map((c) => c.map((z) => Math.round(z.y) + ':' + z.v + (z.cands.length > 1 ? '(' + z.cands.slice(1).join('/') + ')' : ''))), colR: colR.map(Math.round), gap: Math.round(gap) };
  out.ok = true;
  out.notes.push(`amount columns: ${present.filter(Boolean).length}, balances: ${bal.length}`);
  return out;
}

module.exports = { parsePhoto };
