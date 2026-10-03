// Cash on the balance sheet, account by account: the GL balance at month end (from a trial
// balance), against the statement's ending balance where proof of cash has one. Petty cash (1025)
// should never move; Bank Transfer Cash Clearing (1200) should be empty at month end — a large
// balance there means a transfer was booked on one side only.

import { BANK_SOURCES } from '../poc/calc.js';
import { round2, sum } from '../money.js';

export const PETTY_CASH = '1025';
export const CLEARING = '1200';

// The cash lines on the balance sheet: accounts 1000–1201 (1210 on is receivables).
export const isCash = (a) => /^\d{4}$/.test(a) && Number(a) >= 1000 && Number(a) <= 1201;

// balances: every account at month end, { '1100': { description, end } }. endings: statement
// ending balances by proof of cash account id.
export function cashTieOut(balances, endings = {}, cfg = { pettyCash: 300, clearingThreshold: 50000 }) {
  const rows = Object.keys(balances).filter(isCash).sort().map((account) => {
    const { description = '', end: gl = 0 } = balances[account];
    const src = BANK_SOURCES.find((s) => s.gl === account);
    const statement = src ? endings[src.id] ?? null : null;
    const row = { account, description, gl: round2(gl), source: src?.id || null, label: src?.label || description, statement, diff: statement == null ? null : round2(statement - gl), flag: null };
    if (account === PETTY_CASH && round2(gl) !== round2(cfg.pettyCash)) row.flag = { level: 'bad', text: `Petty cash should be ${cfg.pettyCash.toFixed(2)} and never moves.` };
    if (account === CLEARING && Math.abs(gl) > cfg.clearingThreshold) row.flag = { level: 'bad', text: 'A large balance in the clearing account at month end usually means a transfer was booked on one side only (a Stripe payout without its Stripe JE, say).' };
    return row;
  }).filter((r) => r.gl || r.statement != null || r.account === PETTY_CASH || r.account === CLEARING);
  const withStatement = rows.filter((r) => r.statement != null);
  return {
    rows,
    total: round2(sum(rows, (r) => r.gl)),
    statementTotal: round2(sum(withStatement, (r) => r.statement)),
    glWithStatement: round2(sum(withStatement, (r) => r.gl)),
    missing: BANK_SOURCES.filter((s) => s.gl && !withStatement.some((r) => r.source === s.id)).map((s) => s.label),
    flags: rows.filter((r) => r.flag),
  };
}
