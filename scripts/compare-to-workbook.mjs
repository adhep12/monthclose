// Compare an "Export Excel" file from the app with the tied-out Proof of Cash workbook, month by
// month, and show which lines make up the difference between them.
//
//   node scripts/compare-to-workbook.mjs <app export.xlsx> <Proof of Cash workbook.xlsx>
//
// Both files stay local (they're .xlsx, which .gitignore blocks). Revenue and interest are
// compared line by line; each "delta" row is app minus workbook, so the deltas add up to the change
// in the Difference row (GL is shown negated, because a higher GL lowers the difference).

import fs from 'node:fs';
import * as XLSX from '../app/vendor/xlsx.mjs';
import { repairRefs } from '../app/js/xlsx-io.js';

const [appFile, wbFile] = process.argv.slice(2);
if (!appFile || !wbFile) {
  console.error('Usage: node scripts/compare-to-workbook.mjs <app export.xlsx> <Proof of Cash workbook.xlsx>');
  process.exit(1);
}

const read = (f) => { const wb = XLSX.read(fs.readFileSync(f)); repairRefs(XLSX, wb); return wb; };
const rowsOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
const n = (v) => (typeof v === 'number' ? v : 0);
const MONTHS = ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

// App export: first sheet; header row has "YTD Revenue"; columns are YTD rev, YTD int, then rev/int per month.
const app = {};
{
  const rows = rowsOf(read(appFile).Sheets[read(appFile).SheetNames[0]]);
  const h = rows.findIndex((r) => r[1] === 'YTD Revenue');
  for (const r of rows.slice(h + 1)) {
    if (!r[0]) continue;
    const label = String(r[0]).trim();
    app[label] = { rev: SHORT.map((_, i) => n(r[3 + 2 * i])), int: SHORT.map((_, i) => n(r[4 + 2 * i])) };
  }
}

// Workbook: "2026 Proof of Cash Summary"; row 1 has the month names (revenue column, interest next to it).
const wbk = {};
{
  const book = read(wbFile);
  const name = book.SheetNames.find((s) => /proof of cash summary/i.test(s)) || book.SheetNames[0];
  const rows = rowsOf(book.Sheets[name]);
  const hdr = rows[0].map((v) => (v == null ? '' : String(v).trim()));
  const cols = MONTHS.map((m) => hdr.indexOf(m));
  for (const r of rows.slice(1)) {
    const label = String(r[1] ?? r[0] ?? '').trim();
    if (!label) continue;
    let key = label;
    while (wbk[key]) key += ' #2';
    wbk[key] = { rev: cols.map((c) => (c < 0 ? 0 : n(r[c]))), int: cols.map((c) => (c < 0 ? 0 : n(r[c + 1]))) };
  }
}

const find = (src, re) => Object.entries(src).find(([k]) => re.test(k))?.[1] || { rev: SHORT.map(() => 0), int: SHORT.map(() => 0) };
const f = (v) => (Math.abs(v) < 0.005 ? '·' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const line = (label, vals) => console.log(label.padEnd(30), ...vals.map((v) => f(v).padStart(14)));

function section(title, kind, parts) {
  console.log(`\n${title} — app minus workbook`);
  line('', SHORT);
  const tot = SHORT.map(() => 0);
  for (const [label, appRe, wbRe, sign = 1, wbNegative = false] of parts) {
    const a = find(app, appRe)[kind], w = find(wbk, wbRe)[kind].map((v) => (wbNegative ? -Math.abs(v) : v));
    const d = SHORT.map((_, i) => sign * (a[i] - w[i]));
    d.forEach((v, i) => { tot[i] += v; });
    if (d.some((v) => Math.abs(v) >= 0.005)) line(label, d);
  }
  line('= change in difference', tot);
  line('app difference', find(app, /^Difference$/)[kind]);
  line('workbook difference', find(wbk, /^Difference$/)[kind]);
}

section('REVENUE', 'rev', [
  ['Wise', /^Wise$/, /^Wise$/], ['PayPal', /^PayPal$/i, /^Paypal$/i], ['Stripe', /^Stripe$/, /^Stripe$/],
  ['KeyBank Operating', /^KeyBank Operating/, /^KeyBank Operating/], ['Delap revenue', /^Delap/, /^Delap/],
  ['Cass Operating', /^Cass Operating$/, /^Cass Operating$/], ['Adjustments (total)', /^(Cass Operating - )?Total Adjustments/, /^Cass Operating - Total/],
  ['Deposits in transit (change; in the adjustments total on newer exports)', /^Plus Deposit/, /^Plus Deposit/], ['Restricted revenue', /Restricted/, /Restricted/], ['Merchandise AR', /^Merchandise/, /^Merchandise/],
  ['GL revenue (negated)', /^Total GL Revenue/, /^Total GL Revenue \/ Interest Income \(4050\) #2$/, -1],
]);
section('INTEREST', 'int', [
  ['Wise', /^Wise$/, /^Wise$/], ['KeyBank Money Market', /^KeyBank Money/, /^KeyBank Money/], ['ICS', /ICS/, /ICS/],
  ['Cass CD', /^Cass CD/, /^Cass CD/], ['Delap', /^Delap/, /^Delap/], ['Tschetter', /^Tschetter/, /^Tschetter/],
  ['Accrued interest', /^Plus Accrued/, /^Plus Accrued/], ['Less realized prior', /^Less realized/, /^Less realized/, 1, true], // the workbook shows it positive and subtracts it
  ['GL interest (negated)', /^Total GL Revenue/, /^Total GL Interest/, -1],
]);

// The adjustment lines, side by side, so a missing or different one stands out.
console.log('\nCass adjustment lines — workbook (w) vs app (a)');
line('', SHORT);
for (const [k, v] of Object.entries(wbk)) if (/^\(|plus \(minus|^less /i.test(k) && v.rev.some((x) => Math.abs(x) >= 0.005)) line(`w ${k}`.slice(0, 30), v.rev);
for (const [k, v] of Object.entries(app)) if (/^\s{2,}|^ {4}/.test(k) || /Sweep|Transfers|revenue$/i.test(k)) if (v.rev.some((x) => Math.abs(x) >= 0.005)) line(`a ${k.trim()}`.slice(0, 30), v.rev);
