// Calendar months are written 'YYYY-MM' everywhere in the app. Acumatica periods are 'PP-YYYY'
// where the fiscal year runs October–September: October 2025 is '01-2026', September 2026 is
// '12-2026'.

export const FY_START_MONTH = 10;

export function toMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return { year: y, month: mo };
}

export function addMonths(m, n) {
  const { year, month } = parseMonth(m);
  const idx = year * 12 + (month - 1) + n;
  return toMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

// Whole months from a to b (b - a). Same month is 0.
export function monthDiff(a, b) {
  const A = parseMonth(a), B = parseMonth(b);
  return (B.year - A.year) * 12 + (B.month - A.month);
}

export function monthOfDate(isoDate) {
  return isoDate.slice(0, 7);
}

export function lastDayOfMonth(m) {
  const { year, month } = parseMonth(m);
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

export function fiscalYear(m) {
  const { year, month } = parseMonth(m);
  return month >= FY_START_MONTH ? year + 1 : year;
}

export function toPeriod(m) {
  const { month } = parseMonth(m);
  const pp = ((month - FY_START_MONTH + 12) % 12) + 1;
  return `${String(pp).padStart(2, '0')}-${fiscalYear(m)}`;
}

export function fromPeriod(p) {
  const [pp, fy] = p.split('-').map(Number);
  return addMonths(toMonth(fy - 1, FY_START_MONTH), pp - 1);
}

export function fyStart(fy) {
  return toMonth(fy - 1, FY_START_MONTH);
}

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export function monthName(m, { short = false } = {}) {
  const { year, month } = parseMonth(m);
  const n = NAMES[month - 1];
  return short ? `${n.slice(0, 3)} ${year}` : `${n} ${year}`;
}

export function currentMonth(now = new Date()) {
  return toMonth(now.getFullYear(), now.getMonth() + 1);
}
