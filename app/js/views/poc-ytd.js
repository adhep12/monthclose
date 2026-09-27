import { h, mount, statusPill } from '../ui.js';
import { loadPocMonths, listGlActivity, loadPocConfig, loadCds } from '../data.js';
import { monthSummary } from '../cd/schedule.js';
import { computePoc, glFigures, BANK_SOURCES } from '../poc/calc.js';
import { confirmationState } from '../audit.js';
import { money, round2, sum } from '../money.js';
import { fiscalYear, fyStart, addMonths, monthName } from '../fiscal.js';

export default async function (main, { month, setMonth }) {
  const fy = fiscalYear(month);
  const [recs, glActs, cfg, cds] = await Promise.all([loadPocMonths(), listGlActivity(), loadPocConfig(), loadCds()]);
  const byMonth = Object.fromEntries(recs.map((r) => [r.month, r]));
  const glBy = Object.fromEntries(glActs.map((g) => [g.month, g]));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));

  const cols = months.map((m) => {
    const rec = byMonth[m];
    if (!rec || rec.source?.ditOnly) return { m, c: null };
    const gl = glFigures({ glActivity: glBy[m], month: m, config: cfg });
    const cd = { ...monthSummary(cds, m), hasData: cds.some((x) => x.earned?.[m]) };
    return { m, rec, c: computePoc(rec, { prior: byMonth[addMonths(m, -1)], gl, cd }) };
  });
  const have = cols.filter((x) => x.c);
  const ytd = (f) => round2(sum(have, (x) => f(x.c) || 0));

  // One row per account for deposits (revenue) and for interest, adding up to the statement
  // totals, then the adjustments and the comparison with the GL. Each account cell is marked
  // with where the figure came from and whether it's been confirmed.
  const line = (c, id) => c.lines.find((l) => l.id === id);
  const acctRow = (id, k) => ({
    label: BANK_SOURCES.find((s) => s.id === id).label, indent: true,
    f: (c) => line(c, id)[k],
    meta: (c, rec) => {
      const l = line(c, id);
      if (l[k] == null) return null;
      const st = confirmationState(rec.bank?.[id], l.values);
      return { mark: st === 'confirmed' ? '✓' : st === 'stale' ? '!' : '', title: `${l.from === 'typed' ? 'Typed' : `From ${l.from || 'the workbook'}`}${st === 'confirmed' ? ` · confirmed by ${rec.bank[id].confirmation.by}` : st === 'stale' ? ' · changed since confirmed' : ' · not confirmed'}` };
    },
  });
  const used = (k) => BANK_SOURCES.filter((s) => have.some((x) => line(x.c, s.id)[k] != null)).map((s) => s.id);
  const rows = [
    { label: 'Deposits per statements', section: true },
    ...used('rev').map((id) => acctRow(id, 'rev')),
    { label: 'Total deposits per statements', f: (c) => c.bankRev, strong: true },
    { label: 'Adjustments (transfers, refunds, not revenue…)', f: (c) => c.adjTotal },
    { label: 'Change in deposits in transit', f: (c) => c.ditChange },
    { label: 'Bank revenue, adjusted', f: (c) => c.revAdjusted, strong: true },
    { label: 'GL revenue', f: (c) => c.glRev },
    { label: 'Difference', f: (c) => c.diffRev, strong: true },
    { label: 'Interest per statements', section: true },
    ...used('int').map((id) => acctRow(id, 'int')),
    { label: 'Total interest per statements', f: (c) => c.bankInt, strong: true },
    { label: 'Plus accrued CD interest', f: (c) => c.timing.accrued || 0 },
    { label: 'Less prior accrual realized', f: (c) => -(c.timing.realizedPrior || 0) },
    { label: 'Interest, adjusted', f: (c) => c.intAdjusted, strong: true },
    { label: 'GL interest', f: (c) => c.glInt },
    { label: 'Difference', f: (c) => c.diffInt, strong: true },
    { label: 'Ending balances per statements', section: true },
    ...used('ending').map((id) => ({ ...acctRow(id, 'ending'), noYtd: true })),
  ];
  const nCols = cols.length + 2;

  mount(main,
    h('p', { class: 'small' }, h('a', { href: '#/poc' }, '← Proof of cash')),
    h('h1', {}, `Proof of cash — FY${fy}`),
    h('p', { class: 'muted' }, 'Each account’s deposits and interest per its statement, adding up to the totals. ✓ = confirmed, ! = changed since confirmed; hover a figure for its source. Click a month to open it.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), cols.map(({ m, rec }) => h('th', { class: 'num' },
        h('a', { href: '#/poc', onclick: (e) => { e.preventDefault(); setMonth(m); location.hash = '#/poc'; } }, monthName(m, { short: true }).split(' ')[0]),
        rec?.signoff?.reviewed || rec?.reviewedBy ? h('div', {}, statusPill('Reviewed', 'good')) : rec?.signoff?.prepared || rec?.preparedBy ? h('div', {}, statusPill('Prepared', 'info')) : null)),
        h('th', { class: 'num' }, 'YTD'))),
      h('tbody', {}, rows.map((r) => (r.section
        ? h('tr', { class: 'section-row' }, h('td', { colspan: nCols }, r.label))
        : h('tr', { class: r.strong ? 'strong-row' : '' },
          h('td', { class: r.indent ? 'indent' : '' }, r.label),
          cols.map(({ c, rec }) => {
            if (!c) return h('td');
            const v = r.f(c);
            const m = r.meta ? r.meta(c, rec) : null;
            return h('td', { class: 'num', title: m?.title || '' }, v == null ? '' : money(v), m?.mark ? h('span', { class: m.mark === '✓' ? 'good-text' : 'warn-text' }, ` ${m.mark}`) : null);
          }),
          h('td', { class: 'num' }, r.noYtd ? '' : h('strong', {}, money(ytd(r.f)))))))),
    )),
    h('p', { class: 'muted small' }, `YTD revenue difference ${money(ytd((c) => c.diffRev))} on GL revenue of ${money(ytd((c) => c.glRev))}` +
      (ytd((c) => c.glRev) ? ` (${((ytd((c) => c.diffRev) / ytd((c) => c.glRev)) * 100).toFixed(2)}%).` : '.')),
  );
}
