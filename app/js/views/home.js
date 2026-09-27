import { h, mount, statusPill } from '../ui.js';
import { loadAssets, loadClose, loadConfig } from '../data.js';
import { buildDepreciationJE } from '../fa/je.js';
import { priorMonthTB } from './fa-je.js';
import { money } from '../money.js';
import { addMonths, toPeriod } from '../fiscal.js';

export default async function (main, { month, monthName }) {
  const [assets, cfg, close, tbInfo] = await Promise.all([loadAssets(), loadConfig(), loadClose(month), priorMonthTB(month)]);
  const je = assets.length ? buildDepreciationJE({ month, assets, config: cfg }) : null;

  const faStatus = close?.status === 'posted' ? statusPill('Posted', 'good')
    : close ? statusPill('Prepared', 'info')
      : assets.length ? statusPill('To do', 'warn') : statusPill('Set up', 'neutral');

  const card = (title, status, body, href, cta) => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', {}, title), h('span', { class: 'spacer' }), status),
    body, href ? h('p', {}, h('a', { href }, cta)) : null);

  mount(main,
    h('h1', {}, `Closing ${monthName(month)}`),
    h('p', { class: 'muted' }, `Acumatica period ${toPeriod(month)}. Change the month at the top right.`),
    h('div', { class: 'cards', style: { marginTop: '1rem' } },
      card('Trial balance', tbInfo ? statusPill('Uploaded', 'good') : statusPill('Needed', 'warn'),
        h('p', { class: 'muted' }, tbInfo
          ? `Using ${tbInfo.tb.period} for balances at the end of ${monthName(addMonths(month, -1))}.`
          : 'Upload the Trial Balance Summary for this month so entries can be trued up to the GL.'),
        '#/tb', tbInfo ? 'Manage trial balances' : 'Upload trial balance'),
      card('Fixed asset depreciation', faStatus,
        assets.length
          ? h('p', {}, h('span', { class: 'big' }, money(close?.total ?? je.total)), h('br'),
            h('span', { class: 'muted small' }, close?.batch ? `Batch ${close.batch}` : `${assets.length} assets in the register`))
          : h('p', { class: 'muted' }, 'Import the FA listing to get started.'),
        assets.length ? '#/fa/je' : '#/fa/import', assets.length ? 'Open the JE' : 'Import FA listing'),
      card('CD interest', statusPill('Coming next', 'neutral'), h('p', { class: 'muted' }, 'CDARS ladder, monthly accrued and realized interest, and the 1150/4050 entry.')),
      card('Proof of cash', statusPill('Coming next', 'neutral'), h('p', { class: 'muted' }, 'Bank activity vs GL revenue, with the Cass statements read from PDF.')),
      card('Inventory', statusPill('Later', 'neutral'), h('p', { class: 'muted' }, 'Cost of goods by department.')),
    ),
  );
}
