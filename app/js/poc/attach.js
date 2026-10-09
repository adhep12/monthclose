// Attaching statements to a month's proof of cash. Used by the fiscal-year sheet (one account at a
// time) and by the month details page (anything at once).

import { readStatementFile } from '../ingest.js';
import { BANK_SOURCES, defaultExclusions } from './calc.js';
import { applyCdarsStatement, applyIntrafiExport } from '../cd/schedule.js';
import { uploadFile, filesAvailable, explain } from '../store.js';
import { logChange, nowIso } from '../audit.js';
import { money } from '../money.js';
import { statementName, renamed, statementTags } from '../naming.js';
import { monthName } from '../fiscal.js';

const label = (id) => BANK_SOURCES.find((s) => s.id === id)?.label || id;

// Which account a parsed file belongs to.
export function accountOf(r) {
  switch (r.type) {
    case 'cass': return 'cassOp';
    case 'stripe': return 'stripe';
    case 'ics': return 'ics';
    case 'bank': return r.data.source;
    case 'cdars': case 'intrafi-export': return 'cd';
    default: return null;
  }
}

// What each account accepts, for the file picker and the hint next to it.
export const ACCOUNT_FILES = {
  cassOp: { accept: '.pdf', hint: 'The three Cass statements: Operating (…5884), Incoming Wires (…5892) and Outgoing Wires (…3410).', multiple: true },
  stripe: { accept: '.csv', hint: 'Stripe → Reports → Balance → monthly summary (CSV).' },
  paypal: { accept: '.pdf', hint: 'PayPal monthly statement (PDF).' },
  wise: { accept: '.pdf', hint: 'Wise USD statement (PDF).' },
  keyOp: { accept: '.pdf', hint: 'KeyBank Business Reward Checking statement (PDF).' },
  keyMM: { accept: '.pdf', hint: 'KeyBank Money Market statement (PDF).' },
  ics: { accept: '.pdf', hint: 'ICS monthly statement (PDF).' },
  osmOp: { accept: '.pdf', hint: 'OneStory Marshall Cass Operating statement (…4676, PDF).' },
  osmSav: { accept: '.pdf', hint: 'OneStory Marshall Cass Savings statement (…4839, PDF).' },
  cd: { accept: '.pdf,.xlsx', hint: 'CDARS statements (month-end and any maturities), or the IntraFi accounts export run on the 1st.', multiple: true },
  delap: { accept: '.png,.jpg,.jpeg,.pdf', hint: 'Type the ending value from Fidelity. A screenshot can be kept with it.', multiple: true },
  tschetter: { accept: '.pdf,.png,.jpg,.jpeg', hint: 'The Schwab statement (PDF) books the gain and the fees since they were last booked. Portal screenshots only book the gain: keep them here and type the ending value.', multiple: true },
};
const INVESTMENT_ACCOUNTS = ['tschetter', 'delap'];

// Returns { changed, messages }. `ask` is an async yes/no (the in-page dialog).
export async function attachFiles({ files, rec, cds, month, user, expectAccount = null, ask, saveCd }) {
  const messages = [];
  let changed = false;
  rec.statements ||= {}; rec.bankStatements ||= {}; rec.excluded ||= {}; rec.adjustments ||= [];

  for (const file of files) {
    let r;
    try { r = await readStatementFile(file); }
    catch (err) { messages.push({ bad: true, text: `${file.name}: ${err.message}` }); continue; }
    if (r.type === 'skip') { messages.push({ text: `${file.name}: ${r.why}` }); continue; }
    // A screenshot or photographed statement: kept as the evidence for typed Tschetter / Delap figures.
    if (r.type === 'picture') {
      if (!INVESTMENT_ACCOUNTS.includes(expectAccount)) { messages.push({ bad: true, text: `${file.name}: ${r.why}` }); continue; }
      let fileKey = null;
      const stored = statementName({ account: expectAccount, period: month, original: file.name, extra: r.scanned ? 'scan' : 'screenshot' });
      if (filesAvailable()) {
        try { fileKey = (await uploadFile('statements', renamed(file, stored)))?.key || null; }
        catch (err) { messages.push({ bad: true, text: explain(err, `Couldn’t store ${file.name}.`) }); continue; }
      }
      rec.bankFiles ||= {};
      rec.bankFiles[expectAccount] = [...(rec.bankFiles[expectAccount] || []), { fileName: stored, originalName: file.name, ...statementTags(expectAccount, month), fileKey, attachedBy: user, attachedAt: nowIso(), scanned: !!r.scanned }];
      logChange(rec, user, `Attached ${label(expectAccount)} ${r.scanned ? 'scanned statement' : 'screenshot'} ${file.name}`);
      messages.push({ text: `${file.name} kept with ${label(expectAccount)}. Type the figures from it below${expectAccount === 'tschetter' && r.scanned ? ', including the year-to-date expenses so its fees are booked' : ''}.` });
      changed = true;
      continue;
    }
    const d = r.data;
    const acct = accountOf(r);
    if (expectAccount && acct !== expectAccount
      && !(await ask('Different account', `${file.name} is a ${label(acct)} statement, not ${label(expectAccount)}. Attach it to ${label(acct)} instead?`, { ok: `Attach to ${label(acct)}` }))) continue;
    const fileMonth = r.type === 'stripe' || r.type === 'intrafi-export' ? month : d.month;
    if (fileMonth && fileMonth !== month
      && !(await ask('Different month', `${file.name} is dated ${monthName(fileMonth)}, but this is ${monthName(month)}. Use it for ${monthName(month)} anyway?`, { ok: 'Use it anyway' }))) continue;

    let fileKey = null;
    // Stored as {Account}_{YYYY-MM}: CDARS by statement date (a maturity statement can come mid-month).
    const stored = r.type === 'intrafi-export' ? statementName({ account: 'IntraFiExport', period: month, original: file.name })
      : statementName({ account: acct, period: r.type === 'cdars' ? d.date : month, kind: d.kind, original: file.name });
    if (filesAvailable()) {
      try { fileKey = (await uploadFile('statements', renamed(file, stored)))?.key || null; }
      catch (err) { messages.push({ bad: true, text: explain(err, `Couldn’t store ${file.name}; its numbers are still used.`) }); }
    }
    const meta = { fileName: stored, originalName: file.name, ...statementTags(acct, month), fileKey, attachedBy: user, attachedAt: nowIso() };

    if (r.type === 'cass') {
      rec.statements[d.kind] = { ...d, ...meta };
      // Workbook lines that the statements now calculate would double count.
      rec.adjustments = rec.adjustments.filter((a) => !(a.note === 'From the workbook' && /stripe transfers|wire sweep/i.test(a.label)));
      if (!d.check.creditsOk || !d.check.debitsOk) messages.push({ bad: true, text: `${file.name}: what I read doesn’t add up to the statement’s totals — please check it.` });
      logChange(rec, user, `Attached Cass ${d.kind} statement ${file.name}`);
      messages.push({ text: `Cass ${d.kind}: ${d.summary.credits.count} deposits, ${money(d.summary.credits.total)}` });
    } else if (r.type === 'stripe') {
      const m = d.months.find((x) => x.month === month);
      if (!m) { messages.push({ bad: true, text: `${file.name} has no ${monthName(month)} column.` }); continue; }
      if (d.partialMonthEnding && d.partialMonthEnding.slice(0, 7) === month) messages.push({ bad: true, text: `Stripe marks ${monthName(month)} as a partial month in this file — download it again after month end.` });
      rec.stripe = { ...m, ...meta };
      logChange(rec, user, `Attached Stripe CSV ${file.name}: revenue ${money(m.revenue)}, payouts ${money(m.payouts)}`);
      messages.push({ text: `Stripe: revenue ${money(m.revenue)} (payments ${money(m.payments)}, refunds ${money(m.refunds)}${m.disputes ? `, disputes ${money(m.disputes)}` : ''})` });
    } else if (r.type === 'ics') {
      rec.ics = { ...d, ...meta };
      logChange(rec, user, `Attached ICS statement ${file.name}: interest ${money(d.interest)}`);
      messages.push({ text: `ICS: interest ${money(d.interest)}, ending ${money(d.ending)}` });
    } else if (r.type === 'bank' && d.source === 'tschetter') {
      rec.bankStatements.tschetter = { ...d, ...meta };
      // The statement's ending value and year-to-date expenses are the account's figures now.
      rec.bank ||= {};
      const b = (rec.bank.tschetter ||= {});
      b.ending = d.ending; delete b.feesYtd;
      logChange(rec, user, `Attached Tschetter statement ${file.name}: ending ${money(d.ending)}, expenses ${money(d.fees)} (year to date ${money(d.feesYtd)})`);
      messages.push({ text: `Tschetter: ending ${money(d.ending)}, expenses ${money(d.fees)}, year to date ${money(d.feesYtd)}` });
      if (!d.ties) messages.push({ bad: true, text: `${file.name}: the Account Summary doesn’t add up to the ending value — please check it.` });
    } else if (r.type === 'bank') {
      rec.bankStatements[d.source] = { ...d, ...meta };
      logChange(rec, user, `Attached ${label(d.source)} statement ${file.name}`);
      messages.push({ text: `${label(d.source)}: revenue ${money(d.revenue)}, interest ${money(d.interest)}, ending ${money(d.ending)}` });
    } else if (r.type === 'cdars') {
      const touched = applyCdarsStatement(cds, d, { user, file: file.name });
      for (const cd of touched) { cd.files = { ...(cd.files || {}), [d.date]: { name: stored, originalName: file.name, ...statementTags('cd', d.month), key: fileKey, by: user, at: nowIso() } }; await saveCd(cd); }
      logChange(rec, user, `Attached CDARS statement ${file.name} (${touched.map((c) => `…${c.last4}`).join(', ')})`);
      messages.push({ text: `CD schedule: ${touched.map((c) => `…${c.last4} ${money(c.earned?.[d.month]?.amount || 0)}`).join(', ')}` });
    } else if (r.type === 'intrafi-export') {
      const notes = applyIntrafiExport(cds, { ...d, fileName: file.name }, month, { user });
      for (const cd of cds.filter((c) => c.earned?.[month]?.source === 'export')) await saveCd(cd);
      logChange(rec, user, `Applied IntraFi export ${file.name} to ${monthName(month)} CD accruals`);
      messages.push({ text: `IntraFi export applied to ${monthName(month)}` }, ...notes.map((n) => ({ bad: true, text: n })));
    }
    changed = true;
  }

  if (changed) {
    const found = defaultExclusions(rec);
    for (const [id, v] of Object.entries(found)) {
      if (id in rec.excluded) continue;
      rec.excluded[id] = v;
      if (v.type === 'transfer') messages.push({ text: `Treated as a transfer, not revenue: ${v.note}` });
    }
  }
  return { changed, messages };
}
