// What a stored file is called. Statements are renamed on upload to {Account}_{YYYY-MM}, whatever
// the bank called them, so the audit binder lists them the same way every month. The record that
// points at the file keeps the original name too, and tags the file { category, account, period }
// so the binder can find it without reading names.

export const STATEMENT_ACCOUNTS = {
  cassOp: 'CassOperating', stripe: 'Stripe', paypal: 'PayPal', wise: 'Wise', keyOp: 'KeyBankOperating',
  keyMM: 'KeyBankMoneyMarket', ics: 'CassICS', cd: 'CassCDARS', delap: 'DelapFidelity', tschetter: 'Tschetter',
};
// The three Cass statements are three bank accounts.
const CASS = { operating: 'CassOperating', incoming: 'CassIncomingWires', outgoing: 'CassOutgoingWires' };

const ext = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || 'pdf';
const clean = (s) => String(s).replace(/[^A-Za-z0-9-]+/g, '');

export function storedName(base, period, original, extra = '') {
  return `${clean(base)}_${period}${extra ? `_${clean(extra)}` : ''}.${ext(original)}`;
}

// account: the proof of cash account id; period: 'YYYY-MM' (or a statement date for CDARS, which
// can have a maturity statement mid-month); kind: the Cass statement's kind.
export function statementName({ account, period, kind, original, extra = '' }) {
  const base = account === 'cassOp' && CASS[kind] ? CASS[kind] : STATEMENT_ACCOUNTS[account] || account || 'Statement';
  return storedName(base, period, original, extra);
}

export function renamed(file, name) {
  if (typeof File === 'undefined' || file.name === name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export const statementTags = (account, period) => ({ category: 'statement', account, period });
