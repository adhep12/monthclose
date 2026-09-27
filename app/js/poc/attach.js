// Attaching statements to a month's proof of cash. Used by the fiscal-year sheet (one account at a
// time) and by the month details page (anything at once).

import { readStatementFile } from '../ingest.js';
import { BANK_SOURCES, defaultExclusions } from './calc.js';
import { applyCdarsStatement, applyIntrafiExport } from '../cd/schedule.js';
import { uploadFile, filesAvailable, explain } from '../store.js';
import { logChange, nowIso } from '../audit.js';
import { money } from '../money.js';
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
  cd: { accept: '.pdf,.xlsx', hint: 'CDARS statements (month-end and any maturities), or the IntraFi accounts export run on the 1st.', multiple: true },
  delap: { accept: '', hint: 'Type the ending value from the Fidelity statement.' },
  tschetter: { accept: '', hint: 'Type the ending value from the Tschetter statement.' },
};

// Returns { changed, messages }. `ask` is an async yes/no (the in-page dialog).
export async function attachFiles({ files, rec, cds, month, user, expectAccount = null, ask, saveCd }) {
  const messages = [];
  let changed = false;
  rec.statements ||= {}; rec.bankStatements ||= {}; rec.excluded ||= {}; rec.adjustments ||= [];

  for (const file of files) {
    let r;
    try { r = await readStatementFile(file); }
    catch (err) { messages.push({ bad: true, text: `${file.name}: ${err.message}` }); continue; }
    const d = r.data;
    const acct = accountOf(r);
    if (expectAccount && acct !== expectAccount
      && !(await ask('Different account', `${file.name} is a ${label(acct)} statement, not ${label(expectAccount)}. Attach it to ${label(acct)} instead?`, { ok: `Attach to ${label(acct)}` }))) continue;
    const fileMonth = r.type === 'stripe' || r.type === 'intrafi-export' ? month : d.month;
    if (fileMonth && fileMonth !== month
      && !(await ask('Different month', `${file.name} is dated ${monthName(fileMonth)}, but this is ${monthName(month)}. Use it for ${monthName(month)} anyway?`, { ok: 'Use it anyway' }))) continue;

    let fileKey = null;
    if (filesAvailable()) {
      try { fileKey = (await uploadFile('statements', file))?.key || null; }
      catch (err) { messages.push({ bad: true, text: explain(err, `Couldn’t store ${file.name}; its numbers are still used.`) }); }
    }
    const meta = { fileName: file.name, fileKey, attachedBy: user, attachedAt: nowIso() };

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
      messages.push({ text: `Stripe: revenue ${money(m.revenue)} (payments ${money(m.payments)}, refunds ${money(m.refunds)})` });
    } else if (r.type === 'ics') {
      rec.ics = { ...d, ...meta };
      logChange(rec, user, `Attached ICS statement ${file.name}: interest ${money(d.interest)}`);
      messages.push({ text: `ICS: interest ${money(d.interest)}, ending ${money(d.ending)}` });
    } else if (r.type === 'bank') {
      rec.bankStatements[d.source] = { ...d, ...meta };
      logChange(rec, user, `Attached ${label(d.source)} statement ${file.name}`);
      messages.push({ text: `${label(d.source)}: revenue ${money(d.revenue)}, interest ${money(d.interest)}, ending ${money(d.ending)}` });
    } else if (r.type === 'cdars') {
      const touched = applyCdarsStatement(cds, d, { user, file: file.name });
      for (const cd of touched) { cd.files = { ...(cd.files || {}), [d.date]: { name: file.name, key: fileKey, by: user, at: nowIso() } }; await saveCd(cd); }
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
