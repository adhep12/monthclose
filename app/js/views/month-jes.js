// The month's journal entries: a preview of each, and one Acumatica import file with all of them.

import { h, mount, table, statusPill, toast, panel, ask } from '../ui.js';
import { monthJes, jeReady, importRows, importCsv, IMPORT_COL_WIDTHS, JE_BATCHES } from '../je/month.js';
import { noLongDashes } from '../xlsx-io.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { money } from '../money.js';
import { monthName } from '../fiscal.js';

export async function downloadJes(m, jes, { csv = false } = {}) {
  const ready = jes.filter(jeReady);
  if (!ready.length) { toast('No journal entries are ready for this month yet.', 'error'); return; }
  const name = `${ready.length === 1 ? `${ready[0].label} JE` : 'JEs'} - ${monthName(m)}`;
  if (!csv) { await downloadWorkbook(`${name}.xlsx`, [{ name: 'Acumatica', rows: importRows(ready), cols: IMPORT_COL_WIDTHS }]); return; }
  const text = importCsv(ready.map((je) => ({ ...je, description: noLongDashes(je.description), lines: je.lines.map((l) => ({ ...l, tranDescription: noLongDashes(l.tranDescription) })) })));
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `${name}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function jeStatus(je) {
  if (je.missing) return statusPill(je.missing, 'neutral');
  if (je.problems.length) return statusPill('Check the file', 'bad');
  if (!je.balanced) return statusPill('Doesn’t balance', 'bad');
  if (!je.lines.length) return statusPill('Nothing to book', 'neutral');
  return statusPill('Ready', 'good');
}

// How an investment JE was worked out, from where the last booking left off.
function working(je) {
  const w = je.working;
  if (!w) return null;
  const from = w.from ? `${monthName(w.from)} ending` : 'Last month’s ending (typed)';
  return h('div', { class: 'recon' },
    h('div', { class: 'recon-row' }, h('span', {}, 'Ending value'), h('span', { class: 'num' }, money(w.ending, { dash: false }))),
    w.prior != null ? h('div', { class: 'recon-row' }, h('span', {}, `Less ${from}, last booked`), h('span', { class: 'num' }, money(-w.prior))) : null,
    w.net ? h('div', { class: 'recon-row' }, h('span', {}, 'Less money moved in (out), booked by its own entry'), h('span', { class: 'num' }, money(-w.net))) : null,
    h('div', { class: 'recon-row' }, h('strong', {}, 'Change in value'), h('strong', { class: 'num' }, money(w.change, { dash: false }))),
    w.ytd != null
      ? h('div', { class: 'recon-row' }, h('span', {}, `Fees ${w.feeMonths || ''}: ${w.feeBasis}`), h('span', { class: 'num' }, money(w.fees, { dash: false })))
      : je.id === 'tschetter' ? h('div', { class: 'recon-row' }, h('span', { class: 'muted' }, 'No statement this month (screenshots): fees wait for the next statement'), h('span', { class: 'num' }, '–')) : null);
}

// PayPal payments sent: software (8030) or a refund to a donor (4012, with the chargebacks).
// Changed from the PayPal pop-up (`setSentAs`); elsewhere just shown.
const SENT_AS = { software: 'Software (8030)', refund: 'Refund to a donor (4012)' };
function sentTable(je, setSentAs) {
  if (!je.sent?.length) return null;
  return h('div', {}, h('p', { class: 'small' }, 'Payments sent: how each is booked.'),
    table([
      { label: 'Date', cell: (x) => x.date },
      { label: 'Paid to', cell: (x) => h('span', { class: 'wrap' }, x.desc) },
      { label: 'Amount', num: true, cell: (x) => money(x.amount) },
      { label: 'Booked as', cell: (x) => (setSentAs
        ? h('select', { onchange: (e) => setSentAs(x, e.target.value) }, Object.entries(SENT_AS).map(([k, v]) => h('option', { value: k, selected: x.as === k }, v)))
        : SENT_AS[x.as]) },
    ], je.sent));
}

// Change a batch's accounts, subaccounts and descriptions. What's saved is the new default for
// every month (config.jeDefaults), until reset.
export function openJeDefaults(id, { jeDefaults = {}, save }) {
  const b = JE_BATCHES.find((x) => x.id === id);
  const cur = jeDefaults[id] || {};
  return panel(`Edit JE lines: batch ${b.batch}, ${b.description}`, (body, close) => {
    const doc = h('input', { type: 'text', size: 40, value: cur.description || b.description });
    const rows = b.template.map((t) => {
      const o = cur.lines?.[t.key] || {};
      return { t, o,
        account: h('input', { type: 'text', size: 7, value: o.account || t.account }),
        sub: h('input', { type: 'text', size: 9, value: o.sub || t.sub }),
        desc: h('input', { type: 'text', size: 44, value: o.desc || t.desc }) };
    });
    const onSave = async () => {
      const lines = {};
      for (const r of rows) {
        const v = { account: r.account.value.trim(), sub: r.sub.value.trim(), desc: r.desc.value.trim() };
        if (!/^\d+$/.test(v.account)) { toast(`“${v.account}” isn’t an account number.`, 'error'); return; }
        if (!/^\d{3}-\d{3}$/.test(v.sub)) { toast(`“${v.sub}” isn’t a subaccount (like 000-000).`, 'error'); return; }
        if (!v.desc) { toast('A line needs a transaction description.', 'error'); return; }
        const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== r.t[k]));
        if (Object.keys(changed).length) lines[r.t.key] = changed;
      }
      const description = doc.value.trim() && doc.value.trim() !== b.description ? doc.value.trim() : undefined;
      try { await save(id, description || Object.keys(lines).length ? { description, lines } : null); close(true); }
      catch (err) { toast(err.message || 'Couldn’t save.', 'error'); }
    };
    mount(body,
      h('p', { class: 'muted small' }, 'What you save here is the default for every month’s JE, for everyone using the app, until you change it again or reset it. Lines that are zero in a month are left out of that month’s entry.',
        b.template.some((t) => /\{\w+\}/.test(t.desc)) ? ' In descriptions, {date} is the month end (4-30-2026), {fees} adds “, fees Feb-Apr 2026” when fees are booked, and {cd} is the CD’s last four digits.' : ''),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Document description (the batch)'), doc)),
      table([
        { label: 'Built in', cell: (r) => h('span', { class: 'small muted wrap' }, `${r.t.account} ${r.t.sub} · ${r.t.desc}${r.t.note ? ` (${r.t.note})` : ''}`) },
        { label: 'Account', cell: (r) => r.account },
        { label: 'Subaccount', cell: (r) => r.sub },
        { label: 'Transaction description', cell: (r) => r.desc },
        { label: '', cell: (r) => h('button', { class: 'small-btn', onclick: () => { r.account.value = r.t.account; r.sub.value = r.t.sub; r.desc.value = r.t.desc; } }, 'Built in') },
      ], rows),
      h('div', { class: 'row', style: { marginTop: '.75rem' } },
        h('button', { class: 'primary', onclick: onSave }, 'Save as the default'),
        jeDefaults[id] ? h('button', { class: 'danger', onclick: async () => {
          if (!(await ask('Reset to built in', `Put every line of batch ${b.batch} back to the built-in accounts and descriptions?`, { ok: 'Reset', danger: true }))) return;
          try { await save(id, null); close(true); } catch (err) { toast(err.message || 'Couldn’t save.', 'error'); }
        } }, 'Reset all to built in') : null));
  }, { wide: true });
}

export function jePreview(je, { setSentAs, editDefaults } = {}) {
  return h('div', {},
    editDefaults ? h('div', { class: 'row' }, h('span', { class: 'spacer' }),
      h('button', { class: 'small-btn', onclick: () => editDefaults(je.id), title: 'Change accounts, subaccounts or descriptions; saved as the default for every month' }, 'Edit lines…')) : null,
    je.problems.length ? h('div', { class: 'notice warn' }, h('ul', {}, je.problems.map((p) => h('li', {}, p)))) : null,
    je.notes?.length ? h('div', { class: 'notice' }, h('ul', {}, je.notes.map((p) => h('li', {}, p)))) : null,
    working(je),
    sentTable(je, setSentAs),
    je.lines.length ? table([
      { label: 'Account', cell: (l) => l.account },
      { label: 'Subaccount', cell: (l) => l.sub },
      { label: 'Debit', num: true, cell: (l) => money(l.debit) },
      { label: 'Credit', num: true, cell: (l) => money(l.credit) },
      { label: 'Transaction description', cell: (l) => (l.edited ? h('span', { title: 'Edited default' }, l.tranDescription, ' *') : l.tranDescription) },
    ], je.lines, { foot: (c) => (c.label === 'Debit' ? money(je.debits) : c.label === 'Credit' ? money(je.credits) : c.label === 'Account' ? 'Total' : '') }) : null,
    je.lines.length && !je.balanced ? h('p', { class: 'error' }, 'This entry doesn’t balance.') : null);
}

// One process's JE, for its account pop-up.
export function accountJeBlock(rec, id, ctx) {
  const je = monthJes(rec, ctx).find((x) => x.id === id);
  if (!je || je.missing) return null;
  return h('div', {},
    h('h3', {}, `Journal entry: batch ${je.batch}, ${je.description}`),
    h('div', { class: 'row' }, jeStatus(je), h('span', { class: 'small muted' }, ` dated ${je.date}`), h('span', { class: 'spacer' }),
      h('button', { class: 'small-btn', disabled: !jeReady(je), onclick: () => downloadJes(rec.month, [je]) }, 'Download for Acumatica'),
      h('button', { class: 'small-btn', disabled: !jeReady(je), onclick: () => downloadJes(rec.month, [je], { csv: true }) }, 'CSV')),
    jePreview(je, ctx));
}

// Every JE for the month, for the month pop-up.
export function monthJeBlock(rec, ctx) {
  const jes = monthJes(rec, ctx);
  const ready = jes.filter(jeReady);
  return h('div', {},
    h('h3', {}, 'Journal entries'),
    h('p', { class: 'muted small' }, 'Built from the statements attached to this month. The download is one file for Acumatica’s import, each entry its own batch number.'),
    table([
      { label: 'Batch', cell: (je) => String(je.batch) },
      { label: 'Entry', cell: (je) => je.description },
      { label: 'Amount', num: true, cell: (je) => (je.lines.length ? money(je.debits) : '') },
      { label: 'Status', cell: jeStatus },
    ], jes),
    jes.filter((je) => je.lines.length).map((je) => h('details', { class: 'small' }, h('summary', {}, `Batch ${je.batch}: ${je.description}`), jePreview(je, { editDefaults: ctx?.editDefaults }))),
    h('div', { class: 'row', style: { marginTop: '.5rem' } },
      h('button', { class: 'primary', disabled: !ready.length, onclick: () => downloadJes(rec.month, jes) },
        ready.length ? `Download ${ready.length === 1 ? 'the JE' : `all ${ready.length} JEs`} for Acumatica` : 'No JEs ready yet'),
      h('button', { disabled: !ready.length, onclick: () => downloadJes(rec.month, jes, { csv: true }) }, 'As CSV')));
}
