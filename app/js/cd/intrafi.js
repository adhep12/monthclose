// IntraFi documents from Cass: CDARS customer statements, ICS monthly statements, and the
// "accounts" portfolio export.
//
// CDARS statements are issued at each maturity and at month end. Each shows, per CD, the
// interest earned since the previous statement — so a month's interest for a CD is the sum of
// "Interest Earned Since Last Statement" on the statements dated in that month. A maturity
// statement also lists each bank's "Interest Payment"; together they're the interest paid out
// and rolled into the next CD.

import { cellAt, text, num, isoDate } from '../xlsx-io.js';
import { round2 } from '../money.js';

const AMT = '[\\d,]*\\.\\d{2}';
const amt = (s) => (s == null ? null : Number(String(s).replace(/[$,]/g, '')));
const mdY = (s) => { const [m, d, y] = s.split('/').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

export function detectIntrafi(lines) {
  const t = lines.slice(0, 60).map((l) => l.text).join('\n');
  if (/CDARS Customer Statement/.test(t)) return 'cdars';
  if (/CDARS New Account Notice/.test(t)) return 'cdars-notice';
  if (/IntraFi Cash Service/.test(t) && /Monthly Statement/.test(t)) return 'ics';
  return null;
}

function statementDate(all) {
  const i = all.findIndex((x) => /^Date$/.test(x));
  if (i >= 0 && /^\d{2}\/\d{2}\/\d{4}$/.test(all[i + 1])) return mdY(all[i + 1]);
  const m = all.join('\n').match(/Date\s+(\d{2}\/\d{2}\/\d{4})/);
  if (!m) throw new Error('Couldn’t find the statement date.');
  return mdY(m[1]);
}

export function parseCdarsStatement(lines) {
  const all = lines.map((l) => l.text);
  const date = statementDate(all);

  const accounts = {};
  const sumRe = new RegExp(`^(\\d{8,12}) (\\d{2}/\\d{2}/\\d{4}) (\\d{2}/\\d{2}/\\d{4}) ([\\d.]+)% \\$?(${AMT}) \\$?(${AMT})$`);
  for (const x of all) {
    const m = x.match(sumRe);
    if (m) accounts[m[1]] = { accountId: m[1], effective: mdY(m[2]), maturity: mdY(m[3]), rate: Number(m[4]) / 100, opening: amt(m[5]), ending: amt(m[6]) };
  }
  if (!Object.keys(accounts).length) throw new Error('No accounts in the CDARS summary table.');

  // Detail blocks: everything after "Account ID: N" until the next one belongs to N.
  let cur = null;
  const blocks = {};
  for (const x of all) {
    const m = x.match(/^Account ID: (\d+)/);
    if (m) { cur = m[1]; blocks[cur] ||= []; continue; }
    if (cur) blocks[cur].push(x);
  }
  for (const [id, bl] of Object.entries(blocks)) {
    const a = accounts[id] || (accounts[id] = { accountId: id });
    const j = bl.join('\n');
    const first = (re) => { const m = j.match(re); return m ? m[1] : null; };
    a.term = first(/Product Term (.+?) Effective Date/);
    a.balance = amt(first(new RegExp(`Account Balance \\$?(${AMT})`)));
    a.earnedSinceLast = amt(first(new RegExp(`Interest Earned Since Last Statement \\$?(${AMT})`))) ?? 0;
    a.accrued = amt(first(new RegExp(`Annual Percentage Yield [\\d.]+% Interest Accrued (${AMT})`)));
    a.ytdPaid = amt(first(new RegExp(`Account Balance \\$?${AMT} YTD Interest Paid \\$?(${AMT})`)));
    const payments = [...j.matchAll(new RegExp(`Interest Payment (${AMT})`, 'g'))].map((m) => amt(m[1]));
    a.interestPaid = payments.length ? round2(payments.reduce((s, v) => s + v, 0)) : 0;
    a.matured = /Maturity Payout/.test(j) || (a.ending === 0 && a.opening > 0);
  }
  return { kind: 'cdars', date, month: date.slice(0, 7), accounts: Object.values(accounts) };
}

export function parseIcsStatement(lines) {
  const all = lines.map((l) => l.text);
  const j = all.join('\n');
  const date = statementDate(all);
  const g = (re) => { const m = j.match(re); return m ? m[1] : null; };
  const res = {
    kind: 'ics', date, month: date.slice(0, 7),
    opening: amt(g(new RegExp(`Previous Period Ending Balance \\$?(${AMT})`))),
    deposits: amt(g(new RegExp(`Total Program Deposits \\$?(${AMT})`))) || 0,
    withdrawals: amt(g(new RegExp(`Total Program Withdrawals \\(?\\$?(${AMT})`))) || 0,
    interest: amt(g(new RegExp(`Interest Capitalized \\$?(${AMT})`))) || 0,
    ending: amt(g(new RegExp(`Current Period Ending Balance \\$?(${AMT})`))),
    rate: Number(g(/Interest Rate at End of Statement Period ([\d.]+)%/)) / 100 || null,
  };
  if (res.ending == null) throw new Error('Couldn’t read the ICS ending balance.');
  // Transaction detail: "07/31/2026 Interest Capitalization $9,215.38 $3,621,600.72"
  res.items = [];
  const txRe = new RegExp(`^(\\d{2}/\\d{2}/\\d{4}) (.+?) (\\(?)\\$?(${AMT})\\)? \\$?(${AMT})$`);
  for (const x of all) {
    const m = x.match(txRe);
    if (m) res.items.push({ date: mdY(m[1]), type: m[2], amount: amt(m[4]), withdrawal: !!m[3] || /withdraw/i.test(m[2]) });
  }
  res.ties = round2((res.opening || 0) + res.deposits - res.withdrawals + res.interest) === round2(res.ending);
  return res;
}

// IntraFi portfolio export ("accounts.xlsx"): one row per CD with principal and accrued interest
// as of the day it's run. Run it on the 1st and the accruals are through month end.
export function parseIntrafiExport(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  const col = {};
  for (let c = range.s.c; c <= range.e.c; c++) col[text(at(0, c)).toLowerCase()] = c;
  if (col.service == null || col['principal balance'] == null) throw new Error('This doesn’t look like the IntraFi accounts export.');
  const rows = [];
  for (let r = 1; r <= range.e.r; r++) {
    const service = text(at(r, col.service));
    if (!service) continue;
    rows.push({
      service,
      last4: (text(at(r, col['account id'])) || text(at(r, col['transaction account no.']))).padStart(4, '0').slice(-4),
      term: text(at(r, col['product term'])),
      principal: num(at(r, col['principal balance'])) || 0,
      accrued: num(at(r, col['accrued interest'])) || 0,
      status: text(at(r, col['account status'])),
      maturity: isoDate(at(r, col['maturity date'])),
    });
  }
  return { kind: 'intrafi-export', rows };
}
