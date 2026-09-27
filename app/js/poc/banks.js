// Readers for the smaller bank statements: Wise, PayPal, KeyBank (checking and money market).
// Each returns the figures proof of cash needs for its line:
//   { source, month, date, revenue, interest, beginning, ending, withdrawals, items, notes }
// Revenue is money received that isn't interest. Transfers out are listed so they can be seen,
// but they don't touch revenue.

const AMT = '-?[\\d,]*\\.\\d{2}';
const amt = (s) => (s == null ? null : Number(String(s).replace(/[$,+\s]/g, '')));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function detectBank(lines) {
  const t = lines.slice(0, 40).map((l) => l.text).join('\n');
  if (/Wise US Inc\./.test(t) && /statement/i.test(t)) return 'wise';
  if (/Merchant Account ID:.*PayPal ID/.test(t)) return 'paypal';
  if (/KeyBank/.test(t) && /Business Banking Statement/.test(t)) return 'keybank';
  return null;
}

export function parseWise(lines) {
  const all = lines.map((l) => l.text);
  const j = all.join('\n');
  const period = j.match(/(\w+) (\d{1,2}), (\d{4}) \[[^\]]*\] - (\w+) (\d{1,2}), (\d{4})/);
  if (!period) throw new Error('Couldn’t find the Wise statement period.');
  const endMonth = MONTHS.indexOf(period[4].toLowerCase()) + 1;
  const date = iso(Number(period[6]), endMonth, Number(period[5]));
  const ending = amt((j.match(new RegExp(`USD on [^\\n]*? (${AMT}) USD`)) || [])[1]);

  // Each transaction: a description, its amount and running balance (on the same line or the
  // next), then a line starting with its date.
  const items = [];
  const bothRe = new RegExp(`^(.*?) ?(${AMT}) (${AMT})$`);
  const start = all.findIndex((x) => /^Description/.test(x));
  for (let i = start + 1; i > 0 && i < all.length; i++) {
    const m = all[i].match(bothRe);
    if (!m) continue;
    const desc = m[1].trim() || (all[i - 1] || '').trim();
    const dm = (all[i + 1] || '').match(/^(\w+) (\d{1,2}), (\d{4})/);
    if (!dm) continue;
    items.push({ id: `wise-${items.length}`, desc, amount: amt(m[2]), balance: amt(m[3]), date: iso(Number(dm[3]), MONTHS.indexOf(dm[1].toLowerCase()) + 1, Number(dm[2])) });
  }
  // Newest first. Direction from the running balance where we can, else from the wording.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const older = items[i + 1];
    if (older) it.direction = Math.abs(older.balance + it.amount - it.balance) < 0.005 ? 'in' : 'out';
    else it.direction = it.amount < 0 || /^(sent|paid|sending|transfer to|withdraw)/i.test(it.desc) ? 'out' : 'in';
    it.kind = /^interest/i.test(it.desc) ? 'interest' : it.direction === 'in' ? 'received' : 'sent';
  }
  const total = (k) => items.filter((x) => x.kind === k).reduce((s, x) => s + Math.abs(x.amount), 0);
  const beginning = items.length ? items[items.length - 1].balance + (items[items.length - 1].direction === 'in' ? -1 : 1) * Math.abs(items[items.length - 1].amount) : ending;
  return { source: 'wise', date, month: date.slice(0, 7), revenue: round(total('received')), interest: round(total('interest')),
    withdrawals: round(total('sent')), beginning: round(beginning), ending, items };
}

export function parsePaypal(lines) {
  const j = lines.map((l) => l.text).join('\n');
  const p = j.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}) - (\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (!p) throw new Error('Couldn’t find the PayPal statement period.');
  const date = iso(2000 + Number(p[6]), Number(p[4]), Number(p[5]));
  const g = (label) => amt((j.match(new RegExp(`${label} (${AMT})`)) || [])[1]) ?? 0;
  const res = {
    source: 'paypal', date, month: date.slice(0, 7),
    beginning: g('Beginning Available Balance'), ending: g('Ending Available Balance'),
    revenue: g('Payments received'), interest: 0,
    paymentsSent: g('Payments sent'), withdrawals: Math.abs(g('Withdrawals and Debits')),
    depositsCredits: g('Deposits and Credits'), fees: g('Fees'),
  };
  res.ties = round(res.beginning + res.revenue - Math.abs(res.paymentsSent) - res.withdrawals + res.depositsCredits + res.fees) === round(res.ending);
  return res;
}

export function parseKeybank(lines) {
  const j = lines.map((l) => l.text).join('\n');
  const acct = (j.match(/\n(3\d{11})\n/) || j.match(/(\d{12})/) || [])[1] || '';
  const mm = /Money Market/i.test(j);
  const dm = j.match(/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/);
  const date = dm ? iso(Number(dm[3]), MONTHS.indexOf(dm[1].toLowerCase()) + 1, Number(dm[2])) : null;
  if (!date) throw new Error('Couldn’t find the KeyBank statement date.');
  const beginning = amt((j.match(/Beginning balance \S+ \$?([\d,]+\.\d{2})/) || [])[1]);
  const ending = amt((j.match(/Ending balance \S+ \$?([\d,]+\.\d{2})/) || [])[1]);
  const interest = amt((j.match(/Interest paid \+\$?([\d,]+\.\d{2})/) || [])[1]) || 0;
  const additions = amt((j.match(/\d+ Additions? \+?\$?([\d,]+\.\d{2})/) || [])[1]) || 0;
  const subtractions = Math.abs(amt((j.match(/\d+ Subtractions? -?\$?([\d,]+\.\d{2})/) || [])[1]) || 0);
  const res = { source: mm ? 'keyMM' : 'keyOp', account: acct, date, month: date.slice(0, 7), beginning, ending,
    revenue: round(additions), interest, withdrawals: subtractions };
  res.ties = round((beginning || 0) + additions + interest - subtractions) === round(ending || 0);
  return res;
}

function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
