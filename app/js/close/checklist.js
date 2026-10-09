// The month-end close checklist, as the team keeps it in Slab ("2026 - July: Month Close
// Checklist"): the same sections, steps and people, ticked off here month by month (who, when),
// with what the app can show as evidence next to each step — the statement attached, AP tied to
// the GL, the inventory JE ready — and, where a step needs a file, where to get it and in what
// format. When the Slab checklist changes, change STEPS.
//
// A month's ticks (collection close-months, key 'YYYY-MM'): { ticks: { [stepId]: { [signoff]: { by, at } } } }

const AH = 'Alex Hepburn', AP = 'Alayna Phillips', JP = 'Joel Paul', MW = 'Macenzie Woodman', JK = 'Johanna Keel';
const ONE = [['done', 'Done']];
const TWO = [['prepared', 'Prepared'], ['approved', 'Approved / released']];

const who = (x) => (x ? { by: x.uploadedBy || x.attachedBy || x.enteredBy || x.typedBy || x.by || null, at: x.uploadedAt || x.attachedAt || x.enteredAt || x.typedAt || x.at || null, file: x.fileName || x.name || null } : null);
const ev = (ok, label, x = null, extra = {}) => ({ ok: !!ok, label, detail: who(x), ...extra });

// upload: { file, from, format, where, tab }. evidence(d, m): what the app shows, or null.
const bank = (id, title, upload, evidence) => ({ section: 'Cash', id, title, owner: `${AH} prepares · ${JP} approves`, signoffs: TWO, upload, evidence });
const statement = (file, from, format = 'PDF') => ({ file, from, format, where: 'Proof of cash → drop it on the account’s cell for the month', tab: '#/poc' });

export const STEPS = [
  { section: 'Open the month', id: 'open', title: 'Open the next month in Acumatica (Finance → Manage Financial Periods → Open)', owner: MW, signoffs: ONE },

  bank('cass-op', 'Cass Operating', statement('The three Cass statements: Operating (…5884), Incoming Wires (…5892), Outgoing Wires (…3410)', 'Cass online banking → statements'),
    (d) => ev(d.rec.statements?.operating && d.rec.statements?.incoming && d.rec.statements?.outgoing, `${['operating', 'incoming', 'outgoing'].filter((k) => d.rec.statements?.[k]).length} of 3 statements attached`, d.rec.statements?.operating)),
  bank('cass-cd', 'Cass Certificate of Deposit', { file: 'CDARS month-end and maturity statements, or the IntraFi accounts export run on the 1st', from: 'IntraFi', format: 'PDF, or Excel (export)', where: 'CD schedule → Upload CDARS statements / IntraFi export', tab: '#/cds' },
    (d) => { const cd = d.cds.find((c) => c.earned?.[d.m]); return ev(cd, cd ? 'Interest in the CD schedule' : 'No CD interest for the month yet', cd ? { by: cd.earned[d.m].by, at: cd.earned[d.m].at } : null); }),
  bank('cass-ics', 'Cass ICS account', statement('ICS monthly statement', 'IntraFi (Joel or Macenzie pulls it)'), (d) => ev(d.rec.ics, d.rec.ics ? 'Statement attached' : 'No statement yet', d.rec.ics)),
  bank('key-mm', 'KeyBank Money Market', statement('KeyBank Money Market statement', 'KeyBank online banking'), (d) => ev(d.rec.bankStatements?.keyMM, d.rec.bankStatements?.keyMM ? 'Statement attached' : 'No statement yet', d.rec.bankStatements?.keyMM)),
  bank('key-op', 'KeyBank Checking', statement('KeyBank Business Reward Checking statement', 'KeyBank online banking'), (d) => ev(d.rec.bankStatements?.keyOp, d.rec.bankStatements?.keyOp ? 'Statement attached' : 'No statement yet', d.rec.bankStatements?.keyOp)),
  bank('stripe', 'Stripe Checking', statement('Stripe monthly balance summary', 'Stripe → Reports → Balance → monthly summary', 'CSV'), (d) => ev(d.rec.stripe, d.rec.stripe ? 'CSV attached' : 'No CSV yet', d.rec.stripe)),
  bank('paypal', 'PayPal Checking', statement('PayPal monthly statement', 'PayPal → Statements'), (d) => ev(d.rec.bankStatements?.paypal, d.rec.bankStatements?.paypal ? 'Statement attached' : 'No statement yet', d.rec.bankStatements?.paypal)),
  bank('divvy', 'Divvy CC', null, null),
  bank('wise', 'Wise', statement('Wise USD statement', 'Wise → Statements → USD'), (d) => ev(d.rec.bankStatements?.wise, d.rec.bankStatements?.wise ? 'Statement attached' : 'No statement yet', d.rec.bankStatements?.wise)),
  bank('delap', 'Fidelity – Delap Wealth Advisory', { file: 'The ending value (type it); keep a screenshot with it', from: 'Fidelity portal', format: 'Typed + screenshot', where: 'Proof of cash → Delap cell for the month', tab: '#/poc' },
    (d) => ev(d.rec.bank?.delap?.ending != null, d.rec.bank?.delap?.ending != null ? 'Ending value entered' : 'No ending value yet', d.rec.bank?.delap)),
  bank('tschetter', 'Invest – Tschetter Group', statement('Schwab statement (or a portal screenshot, then type the ending value)', 'Schwab'),
    (d) => { const x = d.rec.bankStatements?.tschetter || (d.rec.bank?.tschetter?.ending != null ? d.rec.bank.tschetter : null); return ev(x, x ? 'Statement / ending value in' : 'Nothing yet', x); }),

  { section: 'AR', id: 'ar-bol', title: 'Upload any BOL to the AR invoices', owner: JK, signoffs: ONE },
  { section: 'AR', id: 'ar-release', title: 'Review Receivables entries; release true sales JREs by the BOL ship date (not Koorong unless it’s an actual royalties payment)', owner: AH, signoffs: ONE },
  { section: 'AR', id: 'ar-intl', title: 'Close international shipping invoices (Koorong, 10ofThose) with a 100% credit once Merchandise has sent them', owner: AH, signoffs: ONE },
  { section: 'AR', id: 'ar-tax', title: 'Monthly Tax Payable Liability JRE', owner: MW, signoffs: ONE },

  { section: 'Inventory', id: 'inv-reports', title: 'Send the Renewal Logistics inventory reports to the Finance channel (2 business days after month end)', owner: JK, signoffs: ONE,
    upload: { file: 'Extensiv InventoryGridExport, run on the 1st', from: 'Extensiv (Renewal Logistics)', format: 'Excel', where: 'Inventory → Warehouse export', tab: '#/inventory' },
    evidence: (d) => ev(d.inv?.warehouse, d.inv?.warehouse ? 'Warehouse count uploaded' : 'Not uploaded yet', d.inv?.warehouse) },
  { section: 'Inventory', id: 'inv-dist', title: 'Update the weekly merch distribution sheet for the month', owner: JK, signoffs: ONE,
    upload: { file: 'Merch Distribution Sheet', from: 'Google Sheets → File → Download → Microsoft Excel (.xlsx)', format: 'Excel', where: 'Inventory → Merch distribution sheet', tab: '#/inventory' },
    evidence: (d) => ev(d.inv?.distribution, d.inv?.distribution ? `${d.inv.distribution.length} lines for the month` : 'Not uploaded yet', d.inv?.distributionFile) },
  { section: 'Inventory', id: 'inv-tieout', title: 'Prepare the monthly inventory tie-out and JREs (incl. reclassifying merchandise into teams)', owner: AP, signoffs: ONE,
    upload: { file: 'Salesforce Product Sales By Product & Month (v2), for the fiscal year', from: 'Salesforce reports', format: 'Excel', where: 'Inventory → Product sales report', tab: '#/inventory' },
    evidence: (d) => ev(d.inv?.warehouse && d.inv?.distribution && d.inv?.sales, d.inv?.warehouse && d.inv?.distribution && d.inv?.sales ? 'Tie-out and both JEs on the Inventory tab' : `Missing: ${[!d.inv?.warehouse && 'warehouse count', !d.inv?.distribution && 'distribution sheet', !d.inv?.sales && 'product sales'].filter(Boolean).join(', ')}`, d.inv?.salesFile) },
  { section: 'Inventory', id: 'inv-release', title: 'Review and release the inventory JREs', owner: AH, signoffs: ONE },
  { section: 'Inventory', id: 'inv-koorong', title: 'Pull the Koorong and 10ofThose inventory reports', owner: JK, signoffs: ONE },

  { section: 'Fixed assets', id: 'fa-listing', title: 'Update the fixed asset listing (new purchases ≥ $7,500, disposals)', owner: AP, signoffs: ONE,
    upload: { file: 'Once: the Fixed Asset Listing workbook; after that add assets on the tab', from: 'Fixed Asset Listing.xlsx', format: 'Excel', where: 'Fixed assets → Import FA listing / Add an asset', tab: '#/assets' },
    evidence: (d) => ev(d.hasAssets, d.hasAssets ? 'Listing in the app' : 'Not imported yet') },
  { section: 'Fixed assets', id: 'fa-je', title: 'Enter the depreciation JRE into Acumatica', owner: AP, signoffs: ONE,
    upload: { file: 'Nothing to upload: download the JE', from: '', format: '', where: 'Fixed assets → Download for Acumatica', tab: '#/assets' } },
  { section: 'Fixed assets', id: 'fa-release', title: 'Review and release the depreciation JRE', owner: AH, signoffs: ONE },

  { section: 'Liabilities', id: 'divvy-reimb', title: 'Review and upload Divvy reimbursements into Acumatica', owner: AP, signoffs: ONE },
  { section: 'Liabilities', id: 'ap-aging', title: 'Run AP Aged Period Sensitive for the period; problem-solve balances > 60 days; tie to the BS', owner: AH, signoffs: ONE,
    upload: { file: 'AP Aged Period-Sensitive (Detailed), Financial Period = the month', from: 'Acumatica', format: 'Excel', where: 'Balance sheet → Upload AP aging', tab: '#/balance-sheet' },
    evidence: (d) => (!d.aging ? ev(false, 'Not uploaded yet') : ev(d.apTies === true && !d.apLate, d.apTies == null ? 'Uploaded; needs the trial balance to tie' : `${d.apTies ? 'Ties to GL 2010' : 'Doesn’t tie to GL 2010'}${d.apLate ? ` · ${d.apLate} over 60 days` : ''}`, d.aging)) },
  { section: 'Liabilities', id: 'bill-reimb', title: 'Approve bill reimbursements on the 16th and the 1st', owner: MW, signoffs: ONE },
  { section: 'Liabilities', id: 'payroll-15', title: 'Payroll & 401(k) entries — pay period ending the 15th (payroll register reviewed, BS agrees)', owner: `${MW} prepares · ${JP} reviews`, signoffs: [['prepared', 'Prepared'], ['approved', 'Reviewed']] },
  { section: 'Liabilities', id: 'payroll-eom', title: 'Payroll & 401(k) entries — pay period ending the last day of the month', owner: `${MW} prepares · ${JP} reviews`, signoffs: [['prepared', 'Prepared'], ['approved', 'Reviewed']] },

  { section: 'Revenue', id: 'looker', title: 'Check for reasonableness between Looker revenue and the P&L', owner: JP, signoffs: ONE },
  { section: 'Revenue', id: 'restricted', title: 'Restricted revenue: language gifts and Bolthouse/Murdock, reclass to net assets', owner: AH, signoffs: ONE,
    upload: { file: 'GL Register Detailed, fiscal year to date, unposted included', from: 'Acumatica', format: 'Excel', where: 'Restricted funds (or Proof of cash) → Upload GL register', tab: '#/restricted' },
    evidence: (d) => ev(d.gl?.grants, d.gl?.grants ? 'GL loaded with grant codes; JE on the Restricted funds tab' : d.gl ? 'GL loaded before grant codes were kept: load it again' : 'No GL for the month yet', d.gl) },
  { section: 'Salesforce', id: 'sf-imports', title: 'Import bulk uploads into Salesforce: Benevity, GCF, Stewardship', owner: AH, signoffs: ONE },
  { section: 'Salesforce', id: 'check-deposit', title: 'End of month check deposit', owner: `${AH} / ${AP}`, signoffs: ONE },

  { section: 'Review', id: 'bs-review', title: 'Balance sheet review: cash JREs in, inventory and FA tied, AP tied, month over month reasonable', owner: `${AH} / ${JP}`, signoffs: TWO,
    upload: { file: 'Trial Balance Summary, Financial Period = the month (e.g. 12-2026 for September)', from: 'Acumatica', format: 'PDF or Excel', where: 'Balance sheet → Upload trial balance', tab: '#/balance-sheet' },
    evidence: (d) => ev(d.tb && !d.cashFlags, !d.tb ? 'No trial balance yet' : d.cashFlags ? `${d.cashFlags} cash check(s) to look at` : 'Trial balance in; cash checks clear', d.tb) },
  { section: 'Review', id: 'pl-review', title: 'P&L review: end-of-month payroll included, compare with PMoEnd', owner: `${AH} / ${JP}`, signoffs: TWO },

  { section: 'Post close', id: 'cc', title: 'Compile Steve’s CC transactions for the next board meeting (periods ending January, May, September)', owner: `${JP} / ${MW}`, signoffs: ONE, months: [1, 5, 9],
    upload: { file: 'The CC compilation', from: '', format: 'PDF', where: 'Governance → Add a document → CC compilation', tab: '#/governance' },
    evidence: (d) => { const x = d.govDocs.find((g) => g.type === 'cc-compilation' && g.period === d.m); return ev(x, x ? 'In the governance vault' : 'Not in the vault yet', x); } },

  { section: 'Supplemental', id: 'poc', title: 'Proof of cash (prepared, then reviewed by someone else)', owner: `${AH} / ${JP}`, signoffs: TWO,
    upload: { file: 'Salesforce giving summary (opportunities by close date and payment method)', from: 'Salesforce', format: 'Excel', where: 'Proof of cash → Salesforce vs GL → Upload Salesforce reports', tab: '#/poc' },
    evidence: (d) => { const s = d.rec.signoff; return ev(s?.reviewed, s?.reviewed ? `Reviewed in the app${s.reviewed.by === s.prepared?.by ? ' (by the person who prepared it)' : ''}` : s?.prepared ? 'Prepared in the app, not reviewed' : 'Not signed off in the app', s?.reviewed || s?.prepared); } },
  { section: 'Supplemental', id: 'video', title: 'Video production worksheets (video cost and designers’ time)', owner: `${MW} prepares · ${JP} or Patrick Ramos reviews`, signoffs: [['prepared', 'Prepared'], ['approved', 'Reviewed']] },
  { section: 'Supplemental', id: 'budget', title: 'Go over the TB month over month against budget; message department leads', owner: JP, signoffs: ONE },
  { section: 'Supplemental', id: 'close-acumatica', title: 'Close the month in Acumatica (Payables, Bank, Receivables, then Finance) — the 18th, after reclasses', owner: MW, signoffs: ONE },
  { section: 'Supplemental', id: 'analysis', title: 'Update analysis documents: 5-year giving forecast, department summary, giving rails, cash flow projection, ELT presentation', owner: `${JP} or ${AH}`, signoffs: ONE },
  { section: 'Supplemental', id: 'ncf', title: 'Quarterly: Overflow & National Christian Foundation', owner: AP, signoffs: TWO, months: [3, 6, 9, 12] },
];

export const SECTIONS = [...new Set(STEPS.map((s) => s.section))];

// d: { rec, cds, gl, tb, aging, apTies, apLate, cashFlags, inv, hasAssets, govDocs, close (the
// month's ticks) }. A step is done when every sign-off is ticked.
export function closeChecklist(m, d = {}) {
  const data = { rec: {}, cds: [], govDocs: [], ...d, rec: d.rec || {}, m };
  const mo = Number(m.slice(5, 7));
  const ticks = d.close?.ticks || {};
  const steps = STEPS.filter((s) => !s.months || s.months.includes(mo)).map((s) => {
    const t = ticks[s.id] || {};
    const signed = s.signoffs.map(([k, label]) => ({ key: k, label, ...(t[k] || {}), done: !!t[k] }));
    return { ...s, signed, done: signed.every((x) => x.done), evidence: s.evidence ? s.evidence(data) : null };
  });
  return { month: m, steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

// The checklist for a set of months as workbook rows: one row per step per month, with the
// sign-offs and the app's evidence.
export function checklistRows(lists) {
  const rows = [['Month', 'Section', 'Step', 'Owner', 'Done', 'Signed off', 'In the app', 'Evidence file', 'File to upload', 'Where from', 'Format', 'Uploaded on']];
  const t = (x) => (x?.at ? x.at.slice(0, 16).replace('T', ' ') : '');
  for (const l of lists) for (const s of l.steps) {
    rows.push([l.month, s.section, s.title, s.owner, s.done ? 'Yes' : 'NO', s.signed.filter((x) => x.done).map((x) => `${x.label}: ${x.by} ${t(x)}`).join('; '),
      s.evidence ? `${s.evidence.ok ? '✓ ' : ''}${s.evidence.label}` : '', s.evidence?.detail?.file || '', s.upload?.file || '', s.upload?.from || '', s.upload?.format || '', s.upload?.where || '']);
  }
  return rows;
}

