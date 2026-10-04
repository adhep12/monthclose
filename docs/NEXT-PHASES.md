# Month Close app — scope for the next phases

**Status:** scoped, not started. Built so far: proof of cash, CD schedule, Salesforce vs GL,
balance sheet checks (cash, AP), restricted funds, governance vault, inventory tie-out, fixed
assets, month-end checklist, audit binder. See `docs/HANDOFF.md` for how each works.

The aim of every phase is the same: each number the auditors see can be traced to its source
file, shows who prepared and reviewed it and when, and can't change quietly after it's approved.

---

## Phase A — Lock a closed month

**Problem:** once a month is reviewed, nothing stops a statement being re-attached, a figure
retyped or an upload replaced. The activity log records it, but the month's numbers can still move
after sign-off — and the audit binder is made from the numbers as they are now.

**Build:**
- A month is **locked** when the checklist's Review steps (balance sheet review, P&L review, proof of
  cash) are approved. The lock is recorded on `close-months` (`lockedBy`, `lockedAt`).
- While locked, every page refuses changes to that month: attaching or removing statements, typed
  figures, confirmations, uploads that cover the month (GL register, TB, AP aging, inventory reports,
  Salesforce), asset changes dated in the month, restricted fund entries. Each refusal says the month
  is locked and by whom.
- **Reopen** needs a reason, is logged on the month (who, when, why), clears the review sign-offs,
  and shows on the checklist and in the binder's checklist export.
- A snapshot of the month's figures at lock time (proof of cash totals, tie-out results, JE totals)
  is kept with the lock, so a later difference can be shown against what was approved.

**Touches:** `close/checklist.js`, `data.js` (a single `isLocked(month)` check used by every save),
each view's save path, `binder/make.js` (note in the index when a month was reopened).

**Decisions needed:** which sign-offs lock the month (proposed: proof of cash reviewed + balance
sheet review approved); who may reopen (anyone, or Joel only — note `inGroup()` is a UI check only,
not enforced by the server).

---

## Phase B — Monthly review summary

**Problem:** the tie-outs live on separate tabs. A reviewer has to visit each to know whether the
month is clean.

**Build:** one page per month (and one sheet in the binder) listing every tie-out with its result
and any open difference, each linking to its tab:

| Check | Source |
| --- | --- |
| Proof of cash: revenue and interest difference, % of GL | `poc/calc.js` |
| Salesforce vs GL giving | `sf/salesforce.js` |
| Cash accounts: statement vs GL, petty cash, clearing account | `bs/cash.js` |
| AP aging vs 2010, items > 60 days | `bs/ap-aging.js` |
| CD schedule vs 1150 | `cd/schedule.js` |
| Inventory: ending value vs GL after the JE | `inventory/tieout.js` |
| Fixed assets: cost and A/D vs GL by account | `views/assets.js` |
| Restricted funds: roll-forward, JE ready | `restricted/funds.js` |
| JEs: which batches (1–10) are ready, which are missing and why | `je/month.js` + the others |
| Balance sheet month over month: accounts that moved more than a set % / $ | new — two TBs |

The reviewer approves from this page (it ticks the checklist's review steps). Thresholds for "moved
a lot" are settings.

**Decisions needed:** the month-over-month thresholds (e.g. > 10% and > $25,000).

---

## Phase C — Liabilities

From the original scope (§6), now with the accounts confirmed from the chart of accounts and TB.

| Account | Schedule | Source each month |
| --- | --- | --- |
| 2050 Accrued Payroll | Roll-forward; ties to the payroll register (PPE 15th and last day) | Payroll register export — **format unknown until the new provider is live** |
| 2055 Accrued 401(k) | Roll-forward vs the provider's contribution report | Provider report |
| 2051 Accrued Contractor Payments, 2052 Accrued Search Time & Other | Listing of what's accrued and when it reverses | Typed / supporting detail |
| 2046 Divvy CC (and 2020 Umpqua, 2030 KeyBank, 2040 Key2Purchase, 2045 Cassbank if active) | Statement balance vs GL, like the cash accounts | Card statements (PDF/CSV) |
| 2100 Long-Term Lease Liability | Amortization schedule from the lease terms | Lease agreement (once) |
| 2110 Long-Term Sabbatical Liability | Accrual schedule by person | HR listing |
| 2041 Agency Funds Payable, 2042 Sales Tax Payable, 2043 FSA Withholdings | Balance with the supporting listing; sales tax ties to the monthly tax payable JRE | Typed / reports |
| 2060 Restricted Deferred Revenue | Shares the restricted funds engine (conditional grants) | Grant terms |

Note from the September 2026 TB (mid-close): Accrued Payroll −901,298.14, Accrued 401(k)
−61,667.45 and Divvy −124,363.73 — debit balances on liability accounts, which a schedule would
flag until the month-end entries are in.

**Needs from you:** the new payroll provider's register and 401(k) exports (one month each), a
Divvy statement, the lease agreement terms, the sabbatical listing.

---

## Phase D — Koorong and 10ofThose inventory

The Slab checklist has Johanna pull both reports monthly; the tie-out today covers only Renewal
Logistics (Extensiv). Add each as a warehouse on the Inventory tab, units by item into the same
valuation.

**Needs from you:** one month of each report, and whether stock there is BibleProject's inventory
(on our books) or consigned/sold to them.

---

## Open items carried forward

- **Mug valuation:** the app values mugs as the workbook does today; switch to first-in-first-out or
  average under Inventory → Costs when you decide.
- **Restricted funds:** whether any grant is conditional (2060 instead of 3200); confirm the reclass
  offset account (3001 assumed, since 3100 is the current-year net income line).
- **Governance:** the list of people who file a COI each year; how often the board meets.
- **Fixed asset listing:** remove the two Axis Design rows under 1552 (reclassed to 1570 in July
  2026, GL018299); fix Point Monitor's date to 8/21/2019.
- **Audit binder on the platform:** confirm stored files (statements, documents) come through in a
  download — Index.csv says if any couldn't be fetched.
- **Checklist:** update `STEPS` in `app/js/close/checklist.js` when the Slab checklist changes.
