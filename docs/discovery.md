# Month Close — Discovery Notes

What the current spreadsheets do, how they connect to Acumatica, and what the app needs to
replace them. Written from the FY2026 workbooks and the GL Register export (2026-09-26).

## Shared conventions

- **Fiscal year runs Oct–Sep.** Acumatica period `01-2026` = October 2025, `10-2026` = July 2026,
  `12-2026` = September 2026. JEs are dated the last day of the calendar month.
- **Account format:** `AAAA` account + `DDD-PPP` subaccount. The first segment of the subaccount is
  the department (`013` = the dept depreciation hits, `020` = merch/perks, `021` = ops, etc.).
  The spreadsheets write this as `7999-013`.
- **GL Register Detailed export** (Acumatica report) is a batch-grouped report: a batch header row
  (period, module, batch #, date, status, description) followed by line rows (account, subaccount,
  ref, description, debit, credit, identifier like `GL GL018616 3`). ~26k lines for a full year.
  It parses cleanly into flat lines — the app can read it directly in the browser.

## 1. Proof of Cash (`Proof_of_Cash_-_2026.xlsx`)

Ties **cash received per bank** to **revenue/interest per GL**, monthly, with a YTD column.
Two columns per month: revenue and interest.

**Bank side (manual entry from statements):** Wise, PayPal, Stripe, KeyBank Operating,
KeyBank Money Market, Cass Money Market/ICS, Cass CD, Delap Fidelity, Tschetter Group,
Cass Operating.

**Adjustments to bank activity (non-revenue cash movement), mostly manual:**
Wise transfers, PayPal transfers, Stripe weekly transfers (from Supporting Details — ~2 lines per
Monday), ICS/CD/Fidelity transfers, Cass operating net activity, reimbursements, CC rewards,
returned wires, incoming/outgoing wire sweeps.

**Timing adjustments:** change in check deposits-in-transit (DIT list per month on Supporting
Details), plus accrued interest / less prior-period realized interest (comes from the CD sheet),
change in restricted revenue, merchandise AR.

**GL side:** Revenue = sum of 4010, 4012, 4015, 4017, 4018 **plus** 4075, 4081, 4083, 4084, 4085
(verified: Oct = 2,381,987 + 16,972; Nov = 2,349,035 + 18,721). Interest = 4050 plus investment
activity. **This can be pulled automatically from the GL Register upload.**

**Output:** Difference and % difference by month. Secondary check: Salesforce gifts vs GL revenue,
and a YTD revenue-by-source check (CC rewards, checks, PayPal, Stripe, translation, wire, merch).

Things noticed:
- YTD revenue difference is –43,335 (–0.15%); monthly swings from –7.5k to +17.3k.
- August column already shows –56,983 because the DIT rolls in before August bank data is entered.
- Several bank cells are typed formulas (`=699993.89+1764.62`) — the app should keep line-item
  detail with a note instead of arithmetic in a cell.

## 2. Fixed Asset Depreciation (`Fixed_Asset_Listing.xlsx`)

One sheet per fiscal year (FY26 is current), assets grouped by asset account. Straight-line,
monthly. Cap threshold raised to **$7,500 as of Oct 2023** (prospective).

| Asset acct | Group | Accum. dep. acct |
| --- | --- | --- |
| 1540 | Equipment (5 yr) | 1541 |
| 1552 | CIP – Imago Facility Improvements (not yet depreciating) | 1553 |
| 1555 | Office Space & Commons A (7 yr) | 1556 |
| 1560 | Recording Studio | 1561 |
| 1570 | Commons B, Breezeway & Leasehold Improvements | 1571 |
| 1572 | Sound Stage (7 yr) | 1573 |
| 1574 | Meeting Room B | 1575 |
| 1576 | Studio | 1577 |
| 1580 | Server Grant (5 yr) | 1581 |

**Monthly JE (true-up style):** for each accum-dep account,
`credit = computed cumulative depreciation through this month − accum. dep. per balance sheet`.
Total goes to a single debit on **7999 / 013-000**. Posted as one GL batch,
"Fixed Assets - Accumulated Depreciation". July 2026: 34,677.22 (matches GL018616 exactly).
Because it's a true-up, a missed or wrong month self-corrects next month.

Things noticed:
- Month counts are hard-coded per cell (`K12*3`, `K85*1-0.03`, `K28*($S$4-8)`), and FY25
  additions use a fractional-year formula (`E/I*H`) while everything else uses months. The app
  should use one rule: months in service, with an explicit in-service convention (full month in
  the month placed in service, or next month — **needs a decision**).
- Leasehold improvement life = lease term (Imago Kitchen, 400,000.48 through 4/30/2028).
- "FA Clean Up Edited" tracks disposals (keep/delete, proof of disposal, proceeds) — the app needs
  a disposal flow that computes gain/loss and a disposal JE.
- NBV reconciliation to the balance sheet is off by 128,811.21 (marked "NM").

## 3. CD Interest (`CDARS_Interest_Calculation_-_Rolling.xlsx`)

CDARS CDs roll on a ~4-week ladder in two chains (A and C; B retired). Each CD: account ID,
effective date, maturity, rate, opening balance. At maturity principal + interest rolls into the
next CD in the chain (`next opening = prior opening + realized interest [+ added principal]`).

**Monthly:** interest earned per CD is entered from the statement (it's not recomputed from rate).
- **Accrued** (sum of all CDs' monthly interest) → Proof of Cash "Plus accrued interest", and the
  JE **Dr 1150 / Cr 4050** per CD, described `Interest Earned - {last 4 of CD #}`.
- **Realized** (CDs that matured that month) → Proof of Cash "Cass CD" interest line and
  "Less realized accrued interest from prior period".
- Verified: 1150 monthly activity in GL matches the sheet's accrued totals (Oct 30,554.44;
  Nov 28,603.88; Dec 29,556.98).

Things noticed:
- FY26 "Per Acumatica" / "Per Bank Stmt" check cells are blank so the Acumatica diff shows
  –160k; the reconciliation isn't completed for FY26 yet.
- The app can compute *expected* interest from rate × balance × days as a sanity check against
  the statement figure.

## 4. Inventory (not yet provided — separate process)

From the GL: monthly "Adjusting Inventory Numbers" batch credits inventory 1500 (books),
1505 (posters/PCB), 1506 (mugs) and debits COGS 9000–9014 **by subaccount** — the department
breakout (e.g. `020-320` Perks, `005-000`, `021-817` new-hire gifts). Line descriptions carry
item, reason, and quantity.

## Other processes visible in the GL (candidates)

| Area | Accounts | What a close step would do |
| --- | --- | --- |
| Investment mark-to-market | 1170 Delap, 1171 Tschetter, 8999 | Enter statement market value → unrealized gain/loss JE. Pairs naturally with CD tracking. |
| Payroll clearing | 2050 | ADP funding vs Cass debits vs taxes — should net to ~0 each month. |
| 401(k) liability | 2055 | Withholdings vs funding. |
| FSA liability | 2043 | Deductions accumulating (–70k YTD, never drawn down) — worth a look. |
| Credit card (Divvy) | 2046 | Statement balance vs GL. |
| Agency / pass-through | 2041 | Track gifts received vs paid out to partners. |
| Sales tax | 2042 | By state, due dates. |
| Stripe clearing | 1200 | Payouts vs transfers to Cass should clear. |
| Petty cash / cash on hand | 1061 | Cheers club, generosity cash, rent. |

A generic **"liability rollforward"** module — beginning balance (GL), activity (GL upload),
ending balance, compare to a supporting number entered from a statement/report, flag variance —
covers most of these with one screen.

## How this fits the bp-vibes platform (see `CLAUDE.md`)

- Static site, no build on the platform. Plan: plain HTML + ES modules, no framework; vendor
  SheetJS as a local `.js`/`.mjs` file for reading `.xlsx` uploads in the browser.
- **Data access:** financial data should live in `group:<accounting group>` collections, not
  `shared` (which is anyone signed in at BibleProject). Need the exact group name.
- **Nothing financial goes in the bundle** — every staff member can download it. Asset lists,
  CD details, and balances all go in the records store.
- Records `list()` returns at most 500 — store *summaries* of a GL upload (per account per period),
  not 26k raw lines. Optionally keep the uploaded `.xlsx` in file storage for audit.
- Two people may close together → handle `err.conflict` on shared close records.
- Hash routing (`#/proof-of-cash/2026-07`), never path routing.

## Decisions so far (Sept 27)

- Data access: collections are `shared` (anyone signed in at BibleProject) — no group restriction.
- JE export mirrors Acumatica's Journal Transactions grid (Department ID, Grant / Program ID,
  Account, Description, Subaccount, Ref. Number, Quantity, UOM, Debit Amount, Credit Amount,
  Transaction Description, Inventory ID, Customer/Vendor, DTF Anchor, Redistribution, DTF Entry,
  Indirect Expense). Department is written like `013 - Finance`.
- New assets default to the **month-after** convention; full-month and mid-month are options per
  asset. Methods: straight-line, 200% and 150% declining balance (switching to SL).
- Trial Balance Summary works for opening balances: its Beginning Balance column is always the
  prior period's close, whenever it's run. The FA import ties to the 12-2026 TB within a cent on
  every account except CIP 1552 ($48,381.49 on the listing, $0 in the GL — expensed to 8041 in
  period 07-2026). The old $128,811 NBV gap no longer exists against the current TB.
- Bank statements: Cass e-statement PDFs are text-based; pdf.js extracts every transaction and the
  totals tie to the statement header (checks are listed separately on operating).

## Cass statements → Proof of Cash (as described, Aug 2026 test)

Three Cass accounts: Operating (…5884), Incoming Wires (…5892), Outgoing Wires (…3410).
Incoming and Outgoing sweep to/from Operating daily and end each month at $0.

- **Incoming**: all deposits are treated as revenue deposits. Anything leaving Incoming that is
  *not* the sweep to Operating reduces deposits. (Aug: 120 deposits, $2,291,334.14; all 21
  withdrawals were sweeps.)
- **Outgoing**: anything coming *into* Outgoing that is not the sweep from Operating isn't
  revenue (usually a refund) and reduces deposits. (Aug: $385.00 Plane refund + $630.52 WEX COBRA
  = $1,015.52.)
- **Stripe → Cass** transfers come from the Operating statement (Aug: 5 transfers,
  $1,883,519.85) and go on the Supporting Details page with the deposits in transit.
- Other Operating credits in Aug: check deposits (Deposit Connection) $227,499.18, mobile
  deposits $950, counter deposit $20,000, PayPal $6,141, Paramount $600.
- Worth confirming: a $400.03 State of Ohio tax refund landed in Incoming — not revenue.

## Open questions

1. What's the BibleProject group name for accounting (for `group:` access)?
2. Acumatica JE import format — do you use the Journal Transactions Excel upload (Branch, Account,
   Subaccount, Ref, Qty, Debit, Credit, Description)? A sample export of one JE would lock this.
3. Depreciation in-service convention for new assets (full month vs. next month)?
4. Should the app pull opening balances from a Trial Balance export (needed for true-up and
   liability rollforwards — the GL Register only has FY activity)?
5. Proof of Cash bank figures: entered by hand each month, or are there bank CSV exports we could
   read (Stripe, PayPal, Wise all have them)?
6. Is there a close checklist / sign-off (preparer + reviewer "MW") you want tracked per month?
