import { h, mount, table, toast, fileButton } from '../ui.js';
import { loadTrialBalances, saveTrialBalance, removeTrialBalance, listGlActivity, saveGlActivity, listSoa, saveSoa } from '../data.js';
import { parseGlRegister, parseStatementOfActivities } from '../gl.js';
import { readWorkbook } from '../xlsx-io.js';
import { parseTrialBalance } from '../tb.js';
import { money, round2, sum } from '../money.js';
import { addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';

export default async function (main, { user, rerender }) {
  const [tbsRaw, glActs, soas] = await Promise.all([loadTrialBalances(), listGlActivity(), listSoa()]);
  const soaOut = h('div');
  const tbs = tbsRaw.sort((a, b) => b.month.localeCompare(a.month));
  const out = h('div');
  const glOut = h('div');

  async function onGlFile(file) {
    mount(glOut, h('p', { class: 'muted' }, `Reading ${file.name}… (a full year takes a few seconds)`));
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const res = parseGlRegister(XLSX, wb);
      const save = h('button', { class: 'primary' }, `Save ${res.periods.length} months`);
      save.addEventListener('click', async () => {
        save.disabled = true;
        let n = 0;
        try {
          for (const p of res.periods) {
            await saveGlActivity({ ...p, fileName: file.name, runAt: res.runAt, uploadedBy: user, uploadedAt: new Date().toISOString() });
            n++;
          }
          toast(`Saved GL activity for ${n} months.`);
          rerender();
        } catch (err) { toast(explain(err, `Stopped after ${n} months.`), 'error'); save.disabled = false; }
      });
      mount(glOut, h('div', { class: 'card' },
        h('h3', {}, `${res.fromPeriod || ''} to ${res.toPeriod || ''}`),
        h('p', {}, `${res.lines.toLocaleString()} journal lines across ${res.periods.length} months${res.runAt ? `, run ${res.runAt.slice(0, 16)}` : ''}. Each month replaces any earlier upload for that month.`),
        h('div', { class: 'row' }, save)));
    } catch (err) {
      mount(glOut, h('div', { class: 'notice bad' }, err.message || String(err)));
    }
  }

  async function onSoaFile(file) {
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const soa = parseStatementOfActivities(XLSX, wb);
      await saveSoa({ ...soa, fileName: file.name, uploadedBy: user, uploadedAt: new Date().toISOString() });
      toast(`Saved the ${monthName(soa.month)} statement of activities.`);
      rerender();
    } catch (err) { mount(soaOut, h('div', { class: 'notice bad' }, err.message || String(err))); }
  }

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
    h('h1', {}, 'Acumatica uploads'),
    h('h2', {}, 'GL register'),
    h('p', { class: 'muted' }, 'Upload the GL Register Detailed export (any range of periods). Proof of cash reads each month’s revenue and interest from it. Re-upload after late postings to refresh.'),
    h('div', { class: 'row' }, fileButton('Upload GL register…', '.xlsx,.xls', onGlFile, { class: 'primary' })),
    glOut,
    table([
      { label: 'Month', cell: (g) => monthName(g.month) },
      { label: 'Journal lines', num: true, cell: (g) => g.lines },
      { label: 'From', cell: (g) => g.fileName || '' },
      { label: 'Uploaded', cell: (g) => `${(g.uploadedAt || '').slice(0, 10)} · ${g.uploadedBy || ''}` },
    ], glActs.sort((a, b) => b.month.localeCompare(a.month)), { empty: 'None yet.' }),
    h('h2', {}, 'Statement of activities'),
    h('p', { class: 'muted' }, 'Upload the Statement of Activities – Comparative (Excel) for the month. Proof of cash checks its revenue and interest against the report.'),
    h('div', { class: 'row' }, fileButton('Upload statement of activities…', '.xlsx,.xls', onSoaFile, { class: 'primary' })),
    soaOut,
    table([
      { label: 'Month', cell: (x) => monthName(x.month) },
      { label: 'Revenue', num: true, cell: (x) => money(x.revenueTotal) },
      { label: 'Net interest', num: true, cell: (x) => money(x.interestTotal) },
      { label: 'Uploaded', cell: (x) => `${(x.uploadedAt || '').slice(0, 10)} · ${x.uploadedBy || ''}` },
    ], soas.sort((a, b) => b.month.localeCompare(a.month)), { empty: 'None yet.' }),
    h('h2', {}, 'Trial balances'),
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
