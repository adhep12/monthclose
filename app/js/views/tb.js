import { h, mount, table, toast, fileButton } from '../ui.js';
import { loadTrialBalances, saveTrialBalance, removeTrialBalance } from '../data.js';
import { readWorkbook } from '../xlsx-io.js';
import { parseTrialBalance } from '../tb.js';
import { money, round2, sum } from '../money.js';
import { addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';

export default async function (main, { user, rerender }) {
  const tbs = (await loadTrialBalances()).sort((a, b) => b.month.localeCompare(a.month));
  const out = h('div');

  async function onFile(file) {
    mount(out, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const tb = parseTrialBalance(XLSX, wb);
      const accts = Object.entries(tb.accounts);
      const byType = (t, k) => round2(sum(accts.filter(([, x]) => x.type === t), ([, x]) => x[k]));
      const replacing = tbs.find((x) => x.month === tb.month);
      const save = h('button', { class: 'primary' }, replacing ? `Replace the ${tb.period} trial balance` : 'Save trial balance');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await saveTrialBalance({ ...tb, fileName: file.name, uploadedBy: user, uploadedAt: new Date().toISOString() });
          toast('Trial balance saved.');
          rerender();
        } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); save.disabled = false; }
      });
      mount(out, h('div', { class: 'card' },
        h('h3', {}, `${tb.period} — ${monthName(tb.month)}`),
        h('p', {}, `${accts.length} accounts. Beginning Balance = balances at the end of ${monthName(addMonths(tb.month, -1))}.`),
        h('p', { class: 'muted small' }, `Assets ${money(byType('Asset', 'begin'))} · Liabilities & net assets ${money(byType('Liability', 'begin'))} (beginning).`),
        replacing ? h('p', { class: 'muted small' }, `Replaces the one uploaded ${replacing.uploadedAt?.slice(0, 10) || ''} by ${replacing.uploadedBy || 'someone'}.`) : null,
        h('div', { class: 'row' }, save)));
    } catch (err) {
      mount(out, h('div', { class: 'notice bad' }, err.message || String(err)));
    }
  }

  async function remove(tb, btn) {
    if (!confirm(`Delete the ${tb.period} trial balance?`)) return;
    btn.disabled = true;
    try { await removeTrialBalance(tb.month); toast('Deleted.'); rerender(); }
    catch (err) { toast(explain(err, 'Couldn’t delete.'), 'error'); btn.disabled = false; }
  }

  mount(main,
    h('h1', {}, 'Trial balances'),
    h('p', { class: 'muted' }, 'Upload Acumatica’s Trial Balance Summary for the month you’re closing. Its Beginning Balance column is the prior month’s closing balance no matter when in the month it’s run, which is what the true-ups compare against. Re-upload any time to refresh it.'),
    h('div', { class: 'row' }, fileButton('Upload trial balance…', '.xlsx,.xls', onFile, { class: 'primary' })),
    out,
    h('h2', {}, 'Uploaded'),
    table([
      { label: 'Period', cell: (t) => t.period },
      { label: 'Month', cell: (t) => monthName(t.month) },
      { label: 'Accounts', num: true, cell: (t) => Object.keys(t.accounts || {}).length },
      { label: 'Run in Acumatica', cell: (t) => (t.runAt || '').slice(0, 16) },
      { label: 'Uploaded', cell: (t) => `${(t.uploadedAt || '').slice(0, 10)} · ${t.uploadedBy || ''}` },
      { label: '', cell: (t) => h('button', { class: 'danger', onclick: (e) => remove(t, e.currentTarget) }, 'Delete') },
    ], tbs, { empty: 'None yet.' }),
  );
}
