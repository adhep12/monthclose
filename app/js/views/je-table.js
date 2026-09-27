import { h, table } from '../ui.js';
import { isBalanced } from '../fa/je.js';
import { money, sum } from '../money.js';

export function jeTable(lines) {
  const ok = isBalanced(lines);
  return h('div', {},
    table([
      { label: 'Department', cell: (l) => l.dept },
      { label: 'Account', cell: (l) => l.account },
      { label: 'Description', cell: (l) => l.description },
      { label: 'Subaccount', cell: (l) => l.sub },
      { label: 'Debit', num: true, cell: (l) => money(l.debit) },
      { label: 'Credit', num: true, cell: (l) => money(l.credit) },
      { label: 'Transaction description', cell: (l) => l.tranDescription },
    ], lines, { foot: (c) => (c.label === 'Debit' ? money(sum(lines, (l) => l.debit)) : c.label === 'Credit' ? money(sum(lines, (l) => l.credit)) : c.label === 'Department' ? 'Total' : '') }),
    ok ? null : h('p', { class: 'error' }, 'This entry doesn’t balance.'));
}
