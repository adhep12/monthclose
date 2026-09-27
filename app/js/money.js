// Round half away from zero to cents. The EPSILON nudge keeps 1.005 from rounding to 1.00.
export function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Accounting style: negatives in parentheses, zero as a dash.
export function money(n, { dash = true } = {}) {
  if (n == null || Number.isNaN(n)) return '';
  const r = round2(n);
  if (r === 0) return dash ? '–' : '0.00';
  return r < 0 ? `(${fmt.format(-r)})` : fmt.format(r);
}

export function sum(arr, f = (x) => x) {
  return arr.reduce((t, x) => t + (f(x) || 0), 0);
}

// Parse a number the way someone would type it: "1,234.50", "(12.00)", "$5".
export function parseAmount(s) {
  if (typeof s === 'number') return s;
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[$,\s]/g, '');
  if (!t) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  const n = Number(t);
  return neg ? -n : n;
}
