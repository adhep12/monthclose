import { h, mount, statusPill } from '../ui.js';
import { loadPocMonths, listGlActivity, loadPocConfig } from '../data.js';
import { computePoc, glFigures } from '../poc/calc.js';
import { money, round2, sum } from '../money.js';
import { fiscalYear, fyStart, addMonths, monthName } from '../fiscal.js';

export default async function (main, { month, setMonth }) {
  const fy = fiscalYear(month);
  const [recs, glActs, cfg] = await Promise.all([loadPocMonths(), listGlActivity(), loadPocConfig()]);
  const byMonth = Object.fromEntries(recs.map((r) => [r.month, r]));
  const glBy = Object.fromEntries(glActs.map((g) => [g.month, g]));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));

  const cols = months.map((m) => {
    const rec = byMonth[m];
    if (!rec || rec.source?.ditOnly) return { m, c: null };
    const gl = glFigures({ glActivity: glBy[m], month: m, config: cfg });
    return { m, rec, c: computePoc(rec, { prior: byMonth[addMonths(m, -1)], gl }) };
  });
  const have = cols.filter((x) => x.c);
  const ytd = (f) => round2(sum(have, (x) => f(x.c) || 0));

  const rows = [
    ['Bank activity', (c) => c.bankRev],
    ['Adjustments', (c) => c.adjTotal],
    ['Change in deposits in transit', (c) => c.ditChange],
    ['Bank revenue, adjusted', (c) => c.revAdjusted, 'strong'],
    ['GL revenue', (c) => c.glRev],
    ['Difference', (c) => c.diffRev, 'strong'],
    ['', null],
    ['Bank interest', (c) => c.bankInt],
    ['Interest, adjusted', (c) => c.intAdjusted, 'strong'],
    ['GL interest', (c) => c.glInt],
    ['Difference', (c) => c.diffInt, 'strong'],
  ];

  mount(main,
    h('p', { class: 'small' }, h('a', { href: '#/poc' }, '← Proof of cash')),
    h('h1', {}, `Proof of cash — FY${fy}`),
    h('p', { class: 'muted' }, 'Click a month to open it.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), cols.map(({ m, rec }) => h('th', { class: 'num' },
        h('a', { href: '#/poc', onclick: (e) => { e.preventDefault(); setMonth(m); location.hash = '#/poc'; } }, monthName(m, { short: true }).split(' ')[0]),
        rec?.reviewedBy ? h('div', {}, statusPill('Reviewed', 'good')) : rec?.preparedBy ? h('div', {}, statusPill('Prepared', 'info')) : null)),
        h('th', { class: 'num' }, 'YTD'))),
      h('tbody', {}, rows.map(([label, f, cls]) => h('tr', {},
        h('td', {}, cls ? h('strong', {}, label) : label),
        cols.map(({ c }) => h('td', { class: 'num' }, !f || !c ? '' : cls ? h('strong', {}, money(f(c))) : money(f(c)))),
        h('td', { class: 'num' }, f ? h('strong', {}, money(ytd(f))) : '')))),
    )),
    h('p', { class: 'muted small' }, `YTD revenue difference ${money(ytd((c) => c.diffRev))} on GL revenue of ${money(ytd((c) => c.glRev))}` +
      (ytd((c) => c.glRev) ? ` (${((ytd((c) => c.diffRev) / ytd((c) => c.glRev)) * 100).toFixed(2)}%).` : '.')),
  );
}
