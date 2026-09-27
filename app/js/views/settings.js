import { h, mount, field, toast, table } from '../ui.js';
import { loadConfig, saveConfig } from '../data.js';
import { DEFAULT_FA_CONFIG } from '../fa/je.js';
import { explain } from '../store.js';

export default async function (main, { rerender }) {
  const cfg = structuredClone(await loadConfig());

  const input = (obj, key, props = {}) => h('input', { type: 'text', value: obj[key] ?? '', ...props,
    oninput: (e) => { obj[key] = e.target.value.trim(); } });

  const groupsHost = h('div');
  function drawGroups() {
    mount(groupsHost, table([
      { label: 'Asset account', cell: (g) => input(g, 'asset', { size: 6 }) },
      { label: 'Accum. dep. account', cell: (g) => input(g, 'ad', { size: 6 }) },
      { label: 'Name', cell: (g) => input(g, 'name', { size: 34 }) },
      { label: '', cell: (g) => h('button', { class: 'danger', onclick: () => { cfg.groups = cfg.groups.filter((x) => x !== g); drawGroups(); } }, 'Remove') },
    ], cfg.groups), h('p', {}, h('button', { onclick: () => { cfg.groups.push({ asset: '', ad: '', name: '' }); drawGroups(); } }, 'Add asset account')));
  }

  async function reset() {
    if (!confirm('Reset the fixed asset settings to the defaults for everyone?')) return;
    try { await saveConfig({ ...structuredClone(DEFAULT_FA_CONFIG), accountNames: cfg.accountNames }); toast('Reset.'); rerender(); }
    catch (err) { toast(explain(err, 'Couldn’t reset.'), 'error'); }
  }

  async function save(btn) {
    const bad = cfg.groups.filter((g) => !/^\d{4}$/.test(g.asset) || !/^\d{4}$/.test(g.ad));
    if (bad.length) { toast('Every asset account needs a 4-digit asset account and accumulated depreciation account.', 'error'); return; }
    btn.disabled = true;
    try { await saveConfig(cfg); toast('Settings saved.'); rerender(); }
    catch (err) { toast(explain(err, 'Couldn’t save settings.'), 'error'); btn.disabled = false; }
  }

  mount(main,
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings'),
      h('div', { class: 'actions' },
        h('button', { onclick: reset }, 'Reset to defaults'),
        h('button', { class: 'primary', onclick: (e) => save(e.currentTarget) }, 'Save'))),
    h('p', { class: 'muted' }, 'Shared by everyone using the app.'),

    h('h2', {}, 'Fixed asset accounts'),
    groupsHost,

    h('h2', {}, 'Depreciation entry'),
    h('div', { class: 'form-grid' },
      field('Expense account', input(cfg.expense, 'account')),
      field('Expense subaccount', input(cfg.expense, 'sub')),
      field('Expense department', input(cfg.expense, 'dept'), 'As Acumatica shows it, e.g. “013 - Finance”.'),
      field('A/D subaccount', input(cfg, 'adSub')),
      field('A/D department', input(cfg, 'adDept')),
      field('Transaction description', input(cfg, 'tranDescription'))),

    h('h2', {}, 'Disposals'),
    h('div', { class: 'form-grid' },
      field('Gain/loss on disposal account', input(cfg.disposal, 'gainLossAccount'), cfg.disposal.gainLossAccount ? null : 'Not set yet.'),
      field('Gain/loss subaccount', input(cfg.disposal, 'gainLossSub')),
      field('Gain/loss department', input(cfg.disposal, 'gainLossDept')),
      field('Proceeds account', input(cfg.disposal, 'proceedsAccount'), 'Where sale proceeds land. Default 1100 Cass operating.'),
      field('Proceeds subaccount', input(cfg.disposal, 'proceedsSub')),
      field('Proceeds department', input(cfg.disposal, 'proceedsDept'))),
  );
  drawGroups();

}
