import { h, mount, table, toast, statusPill } from '../ui.js';
import { loadAssets, loadConfig, loadTrialBalance, loadClose, saveClose, removeClose } from '../data.js';
import { buildDepreciationJE, jeRows, isBalanced } from '../fa/je.js';
import { isDisposedBefore } from '../fa/engine.js';
import { balanceAtEndOf } from '../tb.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { money, round2, sum } from '../money.js';
import { addMonths, toPeriod, lastDayOfMonth } from '../fiscal.js';
import { explain } from '../store.js';
import { jeTable } from './fa-asset.js';

// The TB that tells us GL balances at the end of the prior month: this month's TB (its Beginning
// Balance), or failing that, the prior month's TB (its Ending Balance).
export async function priorMonthTB(month) {
  const prior = addMonths(month, -1);
  const tb = (await loadTrialBalance(month)) || (await loadTrialBalance(prior));
  return tb ? { tb, prior, column: tb.month === month ? 'Beginning Balance' : 'Ending Balance' } : null;
}

export default async function (main, { month, monthName, user, rerender: render }) {
  const [assets, cfg, tbInfo, saved] = await Promise.all([loadAssets(), loadConfig(), priorMonthTB(month), loadClose(month)]);
  const prior = addMonths(month, -1);

  const priorBalances = tbInfo
    ? Object.fromEntries(cfg.groups.map((g) => [g.ad, -balanceAtEndOf(tbInfo.tb, g.ad, prior)]))
    : null;
  const je = buildDepreciationJE({ month, assets, config: cfg, priorBalances });

  // Cost per asset account: the register vs the GL at the end of the prior month. A mismatch
  // means an addition or disposal is in one place but not the other.
  const costCheck = tbInfo ? cfg.groups.map((g) => {
    const list = assets.filter((a) => a.group === g.asset && !isDisposedBefore(a, month));
    const reg = round2(sum(list, (a) => a.cost));
    const gl = round2(balanceAtEndOf(tbInfo.tb, g.asset, prior));
    return { g, reg, gl, diff: round2(reg - gl) };
  }).filter((r) => r.reg || r.gl) : [];
  // Pennies are rounding in the old spreadsheet; don't cry wolf over them.
  const costIssues = costCheck.filter((r) => Math.abs(r.diff) >= 0.05);

  const changed = saved && round2(saved.total) !== je.total;

  async function download() {
    await downloadWorkbook(`Depreciation JE - ${month}.xlsx`,
      [{ name: 'Journal Transactions', rows: jeRows(je.lines), cols: [16, 10, 9, 30, 11, 10, 8, 6, 13, 13, 26] }]);
  }

  async function markPrepared(btn) {
    btn.disabled = true;
    try {
      await saveClose(month, {
        month, period: toPeriod(month), date: lastDayOfMonth(month), status: 'prepared',
        total: je.total, basis: je.basis, lines: je.lines, perGroup: je.perGroup,
        tbPeriod: tbInfo?.tb.period || null, preparedBy: user, preparedAt: new Date().toISOString(),
        batch: saved?.batch || '',
      });
      toast('Saved as prepared.');
      render();
    } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); btn.disabled = false; }
  }

  async function markPosted(btn, batchInput) {
    btn.disabled = true;
    try {
      await saveClose(month, { ...saved, status: 'posted', batch: batchInput.value.trim(), postedBy: user, postedAt: new Date().toISOString() });
      toast('Marked as posted.');
      render();
    } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); btn.disabled = false; }
  }

  async function reopen(btn) {
    if (!confirm('Clear the saved entry for this month? You can prepare it again.')) return;
    btn.disabled = true;
    try { await removeClose(month); toast('Cleared.'); render(); }
    catch (err) { toast(explain(err, 'Couldn’t clear.'), 'error'); btn.disabled = false; }
  }

  const batchInput = h('input', { type: 'text', placeholder: 'Acumatica batch, e.g. GL018616', value: saved?.batch || '' });

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Depreciation JE — ${monthName(month)}`),
        h('p', { class: 'muted' }, `Period ${toPeriod(month)} · dated ${lastDayOfMonth(month)}`)),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: download, disabled: !assets.length }, 'Download for Acumatica'))),

    !assets.length ? h('div', { class: 'notice warn' }, 'There are no assets yet. ', h('a', { href: '#/fa/import' }, 'Import the FA listing'), ' first.') : null,

    tbInfo
      ? h('div', { class: 'notice good' }, `Trued up to the GL: accumulated depreciation at the end of ${monthName(prior)} comes from the ${tbInfo.tb.period} trial balance (${tbInfo.column}${tbInfo.tb.runAt ? `, run ${tbInfo.tb.runAt.slice(0, 16)}` : ''}).`)
      : h('div', { class: 'notice warn' }, `No trial balance for ${monthName(month)} or ${monthName(prior)}, so this entry is the scheduled amount only, not trued up to the GL. `,
        h('a', { href: '#/tb' }, 'Upload a trial balance'), ' to true it up.'),

    saved ? h('div', { class: 'notice' }, statusPill(saved.status === 'posted' ? 'Posted' : 'Prepared', saved.status === 'posted' ? 'good' : 'info'), ' ',
      `${money(saved.total)} saved by ${saved.preparedBy || 'someone'} on ${(saved.preparedAt || '').slice(0, 10)}`,
      saved.batch ? ` · batch ${saved.batch}` : '',
      changed ? h('strong', { class: 'error' }, ` — the entry has changed since (now ${money(je.total)}). Assets or balances were edited after it was saved.`) : null) : null,

    h('h2', {}, 'By account'),
    table([
      { label: 'A/D account', cell: (g) => `${g.ad} · ${g.name}` },
      { label: 'Assets', num: true, cell: (g) => g.count },
      { label: 'Scheduled', num: true, cell: (g) => money(g.scheduled) },
      { label: 'Expected A/D, month end', num: true, cell: (g) => money(g.expected) },
      { label: 'GL A/D, prior month end', num: true, cell: (g) => (g.prior == null ? '—' : money(g.prior)) },
      { label: 'JE amount', num: true, cell: (g) => h('strong', {}, money(g.amount)) },
      { label: 'True-up vs schedule', num: true, cell: (g) => (g.variance ? h('span', { class: Math.abs(g.variance) > 1 ? 'error' : 'muted' }, money(g.variance)) : '–') },
    ], je.perGroup.filter((g) => g.count || g.prior), {
      foot: (c) => ({ 'A/D account': 'Total', Scheduled: money(sum(je.perGroup, (g) => g.scheduled)), 'JE amount': money(je.total),
        'True-up vs schedule': money(sum(je.perGroup, (g) => g.variance)) })[c.label] ?? '',
    }),
    h('p', { class: 'muted small' }, 'JE amount = expected accumulated depreciation at month end − the GL balance at the prior month end. When they match the schedule, the true-up column is blank. Differences over $1 are shown in red: something was posted to the GL that the register doesn’t know about, or the other way round.'),

    costIssues.length ? h('div', { class: 'notice warn' }, h('strong', {}, 'Asset cost doesn’t match the GL:'),
      h('ul', {}, costIssues.map((r) => h('li', {}, `${r.g.asset} ${r.g.name}: register ${money(r.reg)}, GL ${money(r.gl)} (difference ${money(r.diff)})`)))) : null,

    h('h2', {}, 'Journal entry'),
    jeTable(je.lines),

    h('h2', {}, 'Sign-off'),
    h('div', { class: 'row' },
      !saved || changed ? h('button', { onclick: (e) => markPrepared(e.currentTarget), disabled: !assets.length || !isBalanced(je.lines) }, saved ? 'Re-save as prepared' : 'Save as prepared') : null,
      saved ? batchInput : null,
      saved && saved.status !== 'posted' ? h('button', { class: 'primary', onclick: (e) => markPosted(e.currentTarget, batchInput) }, 'Mark as posted') : null,
      saved ? h('button', { class: 'danger', onclick: (e) => reopen(e.currentTarget) }, 'Clear') : null),
  );
}
