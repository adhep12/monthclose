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

const WISE_DATE = '(?:[A-Za-z]+ \\d{1,2}, \\d{4}|\\d{1,2} [A-Za-z]+ \\d{4})';
function wiseDate(text) {
  const md = text.match(/([A-Za-z]+) (\d{1,2}), (\d{4})/);
  const dm = text.match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  const [mon, day, year] = md ? [md[1], md[2], md[3]] : [dm[2], dm[1], dm[3]];
  return iso(Number(year), MONTHS.indexOf(mon.toLowerCase()) + 1, Number(day));
}

export function parseWise(lines) {
  const all = lines.map((l) => l.text);
  const j = all.join('\n');
  // Wise writes dates either way round depending on the account's locale: "July 1, 2026" or "1 June 2026".
  const period = j.match(new RegExp(`${WISE_DATE} \\[[^\\]]*\\] - ${WISE_DATE}`));
  if (!period) throw new Error('Couldn’t find the Wise statement period.');
  const date = wiseDate(period[0].split(' - ')[1]);
  const ending = amt((j.match(new RegExp(`USD on [^\\n]*? (${AMT}) USD`)) || [])[1]);

  // Each transaction: a description, its amount and running balance (on the same line or the
  // next), then a line starting with its date. A long description wraps, and its second line
  // sits between the amount and the date ("…with reference Fundacao Bom" / "Pelicano - Donation").
  const items = [];
  const bothRe = new RegExp(`^(.*?) ?(${AMT}) (${AMT})$`);
  const dateRe = new RegExp(`^${WISE_DATE}`);
  const start = all.findIndex((x) => /^Description/.test(x));
  for (let i = start + 1; i > 0 && i < all.length; i++) {
    const m = all[i].match(bothRe);
    if (!m) continue;
    let k = i + 1;
    while (k < all.length && k <= i + 3 && !dateRe.test(all[k]) && !bothRe.test(all[k])) k++;
    const dm = (all[k] || '').match(dateRe);
    if (!dm) continue;
    const desc = [m[1].trim() || (all[i - 1] || '').trim(), ...all.slice(i + 1, k)].join(' ').trim();
    items.push({ id: `wise-${items.length}`, desc, amount: amt(m[2]), balance: amt(m[3]), date: wiseDate(dm[0]) });
  }
  classifyWiseItems(items);
  return { source: 'wise', date, month: date.slice(0, 7), ...wiseTotals(items), beginning: round(wiseBeginning(items, ending)), ending, items, ties: wiseTies(items, ending) };
}

// Every transaction was read: the newest running balance is the statement's ending balance, and
// each balance is the one before it plus money in or less money out. A line the reader missed
// breaks the chain.
export function wiseTies(items, ending) {
  if (!items.length) return true;
  if (ending != null && Math.abs(items[0].balance - ending) >= 0.005) return false;
  for (let i = 0; i + 1 < items.length; i++) {
    const a = Math.abs(items[i].amount) * (items[i].direction === 'out' ? -1 : 1);
    if (Math.abs(items[i + 1].balance + a - items[i].balance) >= 0.005) return false;
  }
  return true;
}

// Who sent money into Wise: "Received money from X with reference Y" → X. The reference is the
// sender's own note, and donors often write "BIBLE PROJECT" there.
export function wiseSender(desc) {
  return (String(desc).match(/^Received money from (.+?)(?: with reference\b|$)/i) || [])[1] || '';
}

// Wise prints money out with a minus sign ("-39.26"); money in has none. Where the sign is missing
// the running balance decides, then the wording. Items are newest first. Revenue is money received
// that isn't interest; anything sent is never revenue.
export function classifyWiseItems(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const older = items[i + 1];
    const a = Math.abs(it.amount);
    if (it.amount < 0 || OUT_WORDS.test(it.desc)) it.direction = 'out';
    else if (older && Math.abs(older.balance + a - it.balance) < 0.005) it.direction = 'in';
    else if (older && Math.abs(older.balance - a - it.balance) < 0.005) it.direction = 'out';
    else it.direction = 'in';
    it.kind = it.direction === 'out' ? 'sent' : /^interest/i.test(it.desc) ? 'interest' : 'received';
  }
  return items;
}
const OUT_WORDS = /^(sent|paid|sending|transfer to|withdraw|card transaction)/i;

export function wiseTotals(items) {
  const total = (k) => round(items.filter((x) => x.kind === k).reduce((s, x) => s + Math.abs(x.amount), 0));
  return { revenue: total('received'), interest: total('interest'), withdrawals: total('sent') };
}

function wiseBeginning(items, ending) {
  const last = items[items.length - 1];
  return last ? last.balance + (last.direction === 'in' ? -1 : 1) * Math.abs(last.amount) : ending;
}

export function parsePaypal(lines) {
  const j = lines.map((l) => l.text).join('\n');
  const p = j.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}) - (\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (!p) throw new Error('Couldn’t find the PayPal statement period.');
  const date = iso(2000 + Number(p[6]), Number(p[4]), Number(p[5]));
  const g = (label) => amt((j.match(new RegExp(`${label} (${AMT})`)) || [])[1]) ?? 0;
  // The first figure on each Activity Summary line is USD (other currencies follow).
  const res = {
    source: 'paypal', date, month: date.slice(0, 7),
    beginning: g('Beginning Available Balance'), ending: g('Ending Available Balance'),
    received: g('Payments received'), interest: 0,
    paymentsSent: g('Payments sent'), withdrawals: Math.abs(g('Withdrawals and Debits')),
    depositsCredits: g('Deposits and Credits'), fees: g('Fees'), transfers: g('Transfers'),
  };
  res.revenue = paypalRevenue(res);
  res.ties = paypalTies(res);
  res.sent = paypalSent(lines);
  return res;
}

// Each USD payment out, from the statement's transaction history: "General Payment <name>" then
// "2/13/26 -15,337.00 0.00 -15,337.00". Used to show a refund the GL books is on the statement too.
function paypalSent(lines) {
  const sent = [];
  let usd = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    const sec = t.match(/^Transaction History - (\w+)/);
    if (sec) { usd = sec[1] === 'USD'; continue; }
    if (!usd) continue;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}) (-[\d,]+\.\d{2}) (-?[\d,]+\.\d{2}) (-?[\d,]+\.\d{2})$/);
    if (!m) continue;
    const desc = (lines[i - 1]?.text || '').trim();
    if (/currency conversion/i.test(desc)) continue;
    sent.push({ date: iso(2000 + Number(m[3]), Number(m[1]), Number(m[2])), desc, amount: Math.abs(amt(m[4])) });
  }
  return sent;
}

// The PayPal line is what the statement calls "Payments received". Money given back to donors is
// an adjustment, taken from the GL's "Payment Refund" lines — the statement's "Payments sent"
// can't tell a refund from a payment to someone else (June 2026: 1,000 paid out, not a refund).
export function paypalRevenue(b) {
  return b.received ?? b.revenue ?? null;
}
export function paypalTies(b) {
  if (b.transfers == null) return b.ties;
  return round(b.beginning + (b.received ?? b.revenue) - Math.abs(b.paymentsSent) - b.withdrawals + b.depositsCredits + b.fees + b.transfers) === round(b.ending);
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
