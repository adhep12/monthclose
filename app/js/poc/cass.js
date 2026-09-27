// Cass Commercial Bank e-statements (Operating …5884, Incoming Wires …5892, Outgoing Wires …3410).
//
// Layout: a summary (beginning balance, "Deposits / Misc Credits  N  total", "Withdrawals / Misc
// Debits  N  total", ending balance), then sections introduced by dashed headers:
//   DEPOSITS AND OTHER CREDITS / OTHER DEBITS AND WITHDRAWALS — "M/DD  amount  description",
//     with the description sometimes continuing onto the next line
//   CHECKS — up to three "M/DD  check#  amount" per line
//   DAILY BALANCE SUMMARY — ignored
// Every parse is checked against the summary counts and totals, so a layout change shows up as a
// failed check rather than a quietly wrong number.

import { round2 } from '../money.js';

const AMT = '[\\d,]*\\.\\d{2}';
const amount = (s) => Number(s.replace(/,/g, ''));

export const CASS_ACCOUNTS = {
  5884: { kind: 'operating', label: 'Cass Operating' },
  5892: { kind: 'incoming', label: 'Cass Incoming Wires' },
  3410: { kind: 'outgoing', label: 'Cass Outgoing Wires' },
};

export function looksLikeCass(lines) {
  return lines.some((l) => /DEPOSITS AND OTHER CREDITS|OTHER DEBITS AND WITHDRAWALS/.test(l.text))
    && lines.some((l) => /Statement Date:/.test(l.text));
}

export function parseCassStatement(lines) {
  const all = lines.map((l) => l.text);
  const joined = all.join('\n');
  const grab = (re) => (joined.match(re) || [])[1];

  const accountNumber = grab(/Account Number:\s*(\d+)/);
  const stmt = grab(/Statement Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!accountNumber || !stmt) throw new Error('This doesn’t look like a Cass statement (no account number or statement date).');
  const [sm, sd, syRaw] = stmt.split('/').map(Number);
  const sy = syRaw < 100 ? 2000 + syRaw : syRaw;
  const statementDate = `${sy}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
  const last4 = accountNumber.slice(-4);
  const known = CASS_ACCOUNTS[last4];
  const kind = known?.kind || (/INCOMING WIRES/.test(joined) ? 'incoming' : /OUTGOING WIRES/.test(joined) ? 'outgoing' : 'operating');

  const summary = {
    beginning: amount(grab(new RegExp(`Beginning Balance \\S+ (-?${AMT})`)) || '0'),
    ending: amount(grab(new RegExp(`Ending Balance \\S+ (-?${AMT})`)) || '0'),
    credits: { count: Number(grab(/Deposits \/ Misc Credits (\d+)/) || 0), total: amount(grab(new RegExp(`Deposits / Misc Credits \\d+ (${AMT})`)) || '0') },
    debits: { count: Number(grab(/Withdrawals \/ Misc Debits (\d+)/) || 0), total: amount(grab(new RegExp(`Withdrawals / Misc Debits \\d+ (${AMT})`)) || '0') },
  };

  const dateOf = (md) => {
    const [m, d] = md.split('/').map(Number);
    const y = m > sm ? sy - 1 : sy; // a December item on a January statement
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const txns = [];
  let section = null;
  let inPageHeader = false;
  let last = null;
  const txRe = new RegExp(`^(\\d{1,2}/\\d{2}) (${AMT}) (.*)$`);
  const checkRe = new RegExp(`(\\d{1,2}/\\d{2}) (\\d+\\*?) (${AMT})`, 'g');

  for (const text of all) {
    if (/^- - -/.test(text) || /- - - -/.test(text)) {
      if (/DEPOSITS AND OTHER CREDITS/.test(text)) section = 'credit';
      else if (/OTHER DEBITS AND WITHDRAWALS/.test(text)) section = 'debit';
      else if (/CHECKS/.test(text)) section = 'check';
      else section = null;
      inPageHeader = false;
      last = null;
      continue;
    }
    if (/^Page:/.test(text)) { inPageHeader = true; last = null; continue; }
    if (inPageHeader || !section) continue;
    if (/^Date /.test(text) || /indicates skip/.test(text)) continue;

    if (section === 'check') {
      for (const m of text.matchAll(checkRe)) {
        txns.push({ section: 'check', date: dateOf(m[1]), amount: amount(m[3]), desc: `Check ${m[2].replace('*', '')}` });
      }
      continue;
    }
    const m = text.match(txRe);
    if (m) {
      last = { section, date: dateOf(m[1]), amount: amount(m[2]), desc: m[3].trim() };
      txns.push(last);
    } else if (last && last.detail == null) {
      last.detail = text.slice(0, 80);
    }
  }

  txns.forEach((t, i) => { t.id = `${last4}-${i}`; });
  const credits = txns.filter((t) => t.section === 'credit');
  const debits = txns.filter((t) => t.section !== 'credit');
  const check = {
    credits: { count: credits.length, total: round2(credits.reduce((s, t) => s + t.amount, 0)) },
    debits: { count: debits.length, total: round2(debits.reduce((s, t) => s + t.amount, 0)) },
  };
  check.creditsOk = check.credits.count === summary.credits.count && check.credits.total === round2(summary.credits.total);
  check.debitsOk = check.debits.count === summary.debits.count && check.debits.total === round2(summary.debits.total);
  check.balanceOk = round2(summary.beginning + summary.credits.total - summary.debits.total) === round2(summary.ending);

  return {
    bank: 'cass', accountNumber, last4, kind, label: known?.label || `Cass …${last4}`,
    statementDate, month: statementDate.slice(0, 7), summary, check, transactions: txns,
  };
}
