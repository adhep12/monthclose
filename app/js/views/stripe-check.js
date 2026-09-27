// The Stripe payouts vs Cass check, as shown in the account panels and on the month page.

import { h, table, askValue } from '../ui.js';
import { money } from '../money.js';
import { logChange, nowIso, when } from '../audit.js';

export function stripeFlagText(chk) {
  return `Stripe payouts per the CSV (${money(chk.csv, { dash: false })}) don’t match the Stripe transfers into Cass (${money(chk.cass, { dash: false })}) — difference ${money(chk.diff, { dash: false })}.`;
}

// onChange(rec) is called after the explanation changes, so the caller can save and redraw.
export function stripeCheckBox(chk, { rec, user, onChange }) {
  if (chk.state === 'incomplete') {
    return h('div', { class: 'check-box' }, h('strong', {}, 'Stripe payouts vs Cass: '),
      h('span', { class: 'muted' }, chk.csv == null && chk.cass == null ? 'attach the Stripe CSV and the Cass Operating statement to check.'
        : chk.csv == null ? 'attach the Stripe CSV to check against the Cass transfers.' : 'attach the Cass Operating statement to check against Stripe’s payouts.'));
  }
  const explain = async () => {
    const note = await askValue('Explain the difference', `${stripeFlagText(chk)} What explains it? (e.g. “7/31 payout landed in Cass 8/3”)`, { ok: 'Mark explained' });
    if (!note) return;
    rec.stripeCheck = { diff: chk.diff, note, by: user, at: nowIso() };
    logChange(rec, user, `Explained Stripe payout difference ${money(chk.diff, { dash: false })}: ${note}`);
    onChange(rec);
  };
  const unexplain = () => {
    delete rec.stripeCheck;
    logChange(rec, user, 'Removed the Stripe payout explanation');
    onChange(rec);
  };
  const cls = chk.state === 'match' ? 'good' : chk.state === 'explained' ? 'info' : 'bad';
  return h('div', { class: `check-box ${cls}` },
    h('div', { class: 'row' },
      h('strong', {}, chk.state === 'match' ? '✓ Stripe payouts match Cass' : chk.state === 'explained' ? 'Stripe payouts vs Cass — explained' : '⚠ Stripe payouts don’t match Cass'),
      h('span', { class: 'spacer' }),
      chk.state === 'mismatch' ? h('button', { class: 'small-btn', onclick: explain }, 'Explain…') : null,
      chk.state === 'explained' ? h('button', { class: 'small-btn', onclick: unexplain }, 'Remove explanation') : null),
    h('div', { class: 'recon small' },
      row('Payouts per Stripe CSV', money(chk.csv, { dash: false })),
      row(`Stripe transfers into Cass (${chk.transfers.length})`, money(chk.cass, { dash: false })),
      row('Difference', money(chk.diff, { dash: false }))),
    chk.state === 'explained' ? h('p', { class: 'small' }, `“${chk.explained.note}” — ${chk.explained.by} · ${when(chk.explained.at)}`) : null,
    chk.state === 'mismatch' && chk.early?.length ? h('p', { class: 'small' },
      `Often timing: ${chk.early.map((t) => `${t.date} ${money(t.amount)}`).join(', ')} arrived in the first days of the month and may be last month’s payout. A payout at the end of this month may show up in next month’s Cass.`) : null,
    chk.transfers.length || chk.ignored.length ? h('details', { class: 'small', open: chk.state === 'mismatch' || chk.ignored.length ? '' : null }, h('summary', {}, `Cass transfers${chk.ignored.length ? ` · ${chk.ignored.length} ignored` : ''}`),
      h('p', { class: 'muted' }, 'Ignore a transfer that isn’t a Stripe payout (a small stray Stripe payment, say) to leave it out of this check.'),
      table([
        { label: 'Date', cell: (t) => t.date },
        { label: 'Description', cell: (t) => h('span', { class: 'wrap' }, `${t.desc}${t.detail ? ` ${t.detail}` : ''}`, t.ignored ? h('div', { class: 'muted' }, t.ignored.gift ? t.ignored.note : `Ignored${t.ignored.note ? `: “${t.ignored.note}”` : ''} — ${t.ignored.by} · ${when(t.ignored.at)}`) : null) },
        { label: 'Amount', num: true, cell: (t) => (t.ignored ? h('s', { class: 'muted' }, money(t.amount)) : money(t.amount)) },
        { label: '', cell: (t) => (t.ignored?.gift ? h('span', { class: 'pill good' }, 'Gift — revenue')
          : t.ignored
          ? h('button', { class: 'small-btn', onclick: () => include(t) }, 'Include')
          : h('button', { class: 'small-btn', onclick: () => ignore(t) }, 'Ignore…')) },
      ], [...chk.transfers, ...chk.ignored].sort((a, b) => a.date.localeCompare(b.date)))) : null);

  async function ignore(t) {
    const note = await askValue('Ignore this transfer', `Leave ${t.date} ${t.desc} ${money(t.amount, { dash: false })} out of the Stripe payout check? Add a reason (optional).`, { ok: 'Ignore' });
    if (note == null) return;
    rec.stripeIgnored = { ...(rec.stripeIgnored || {}), [t.id]: { note: note.trim(), amount: t.amount, date: t.date, by: user, at: nowIso() } };
    logChange(rec, user, `Ignored Stripe transfer ${t.date} ${money(t.amount, { dash: false })} in the payout check${note.trim() ? `: ${note.trim()}` : ''}`);
    onChange(rec);
  }
  function include(t) {
    delete rec.stripeIgnored[t.id];
    logChange(rec, user, `Put Stripe transfer ${t.date} ${money(t.amount, { dash: false })} back into the payout check`);
    onChange(rec);
  }
}

function row(k, v) {
  return h('div', { class: 'recon-row' }, h('span', {}, k), h('span', { class: 'num' }, v));
}
