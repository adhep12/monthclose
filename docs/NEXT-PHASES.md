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

## Assumptions built in, not yet confirmed

Each of these is how the app works today. If one is wrong, the fix is usually a setting or a few
lines — but until someone confirms it, treat the numbers it drives as provisional.

### Restricted funds (`restricted/funds.js`)
1. **Every Translation Support (4017) gift is restricted.** (Confirmed: to its language, or general
   localization if none.) No other revenue account carries restricted gifts.
2. **The language comes from the grant code** on the gift's subaccount (005-**627**). Codes are
   grouped by language: Portuguese 611/618/627/665, Spanish 632/662/663/664, French 613/654/667,
   Arabic 602–606 (dialects together). 609 (Department Dev) and 622 (Luke/Acts) count as general
   localization. A gift coded to Portuguese *video* can be released by Portuguese *podcast* spending.
3. **Released automatically as it's spent:** spending = any expense line (accounts 5000 and up) on
   that language's grant codes, in the month it's booked. Nothing is released by a person deciding
   to; there's no review of whether the spending actually met the donor's purpose.
4. **A release never takes a fund below zero.** Spending beyond what's restricted is treated as the
   organization's own money; nothing carries forward to be released by later gifts.
5. **Gifts come in before spending in the same month**, so a gift and spending in one month release
   against each other.
6. **General localization pays for what a language's own fund didn't cover** — any language,
   after that language's fund is used up.
7. **Refunds or reclasses (debits to 4017) reduce the fund** they're coded to.
8. **Every fund starts at zero in October 2024** (the first GL register loaded). No opening
   balances from the audited financials; the page lists funds an older balance could still affect.
9. **The gifts are restricted, not conditional:** they post to 3200 (Net Assets Restricted), not
   2060 (Restricted Deferred Revenue).
10. **The reclass JE** each month is the net change per fund: Dr 3001 / Cr 3200 when restricted
    money grows, the reverse when released, subaccount 000-000. 3001 is assumed to be the right
    "without donor restrictions" account (3100 is the current-year net income line).
11. **Bolthouse and Murdock are typed in by hand** (opening balance, gifts, schedule or grant codes).
    The Slab checklist says these are already booked as a receivable — 1220 Contributions
    Receivable carries $750,000 at September 2025 — and the app doesn't yet look at the receivable:
    whether a pledge is restricted when booked or when received isn't modeled.
12. **Spending that's capitalized** (an asset bought with restricted money) doesn't release
    anything — only expense accounts count.

### Balance sheet checks (`bs/`)
13. **Cash on the balance sheet is accounts 1000–1201** (1210 on is receivables; 1250 isn't cash).
14. **Petty cash is always $300.00** (confirmed) and is never reconciled to anything else.
15. **Cash Clearing (1200) over $50,000 either way** at month end is a problem; under it isn't.
16. **A difference between a statement and the GL is timing** (outstanding checks, deposits in
    transit); the balance sheet page shows it but doesn't explain it — proof of cash does.
17. **AP exceptions are the 61–90 and Over 90 columns** of the aging; the tie is the company total
    against 2010's month-end balance.
18. **A month's balances come from its own TB**, or from the next month's TB beginning balances.

### Inventory (`inventory/`)
19. **Only three items are inventory:** SKU 5100 (How to Read → 1500), 4001 (poster collection →
    1505), 8000-TM-WHT (mugs → 1506). Everything else in the warehouse (apparel, caps, packaging,
    Welcome Books, thumb drives…) is expensed.
20. **Units are "Available Primary"**, including items on hold (the mugs are on hold in the export).
21. **The Portland count carries forward** until someone types a new one.
22. **Costs:** coffee table books 135,169.73 / 10,090 units; poster books $4.45 a unit; mugs two
    orders (10,008 at 166,466.66; 5,016 at 86,854.48), valued as the workbook did — to change.
23. **The GL before adjusting** is last month's TB ending balance, plus additions typed for the month.
24. **The distribution sheet's cost is right as saved** (cost per item × quantity, plus shipping and
    storage for inventory items). Patron Care with no grant is 020-320; categories marked "None"
    are left out of the JE.
25. **What departments didn't take is Patron Care perks** (020-320).
26. **Stripe reclass:** the products and accounts are How to Read → 4081, Poster Collection Book →
    4084, Video Thumb Drive → 4083, Travel Mug → 4085, SHIPPING → 9050 009-000. "(HQ STOCK)" sales
    count; "BibleProject Coffee Table Book" doesn't (as in September's workbook); **all discounts
    come off poster book sales**; apparel and other merch stay in Stripe Donations.
27. **A warehouse export run on the 1st is the previous month's count** (the upload asks which month).
28. **A merch purchase of $15,000 or more is inventory** — the app lists GL lines that size on
    9000–9099 and 1500–1509 but doesn't act on them.

### Fixed assets (`fa/`)
29. **The FY26 listing is the truth at September 2026:** each asset's "Remaining" and monthly amount
    carry forward unchanged (the old sheet's monthly amounts aren't recalculated).
30. **Assets named "Delete" were disposed at September 2026** and their disposal JE is already booked.
31. **New assets default to straight-line, 60 months, starting the month after** they're placed in
    service; the capitalization threshold is $7,500.
32. **The depreciation JE trues each A/D account up to the schedule** using last month's TB — so if the
    GL drifted, the JE corrects it without anyone deciding to.
33. **Disposal proceeds were booked to 8049 (010-000) when received**; the disposal JE moves them
    out, and gain/loss goes to 8990 (as the FY26 disposal JE did).
34. **Construction in progress isn't depreciated**; the "2020 Total Asset" subtotal depreciates as one
    asset (its detail rows are folded into it).

### Everything else
35. **Statements are named for the account and month of the cell they're attached to**; CDARS by
    statement date.
36. **COI disclosures:** anyone who has ever filed is expected to file every year. CC compilations
    are due for the periods ending January, May and September.
37. **All data is readable by anyone signed in at BibleProject** (every collection is `shared`),
    including governance documents — decided, noted here for the auditors.
38. **The audit binder makes schedules from the figures as they are now**, not as they were at
    close, until Phase A (lock) is built.
39. **JE batch numbers 1–10** in the Acumatica downloads are the app's own (1 Stripe, 2 PayPal,
    3 Tschetter, 4 Delap, 5 CD interest, 6 restricted funds, 7 inventory adjustment, 8 Stripe merch
    reclass, 9 depreciation, 10 disposals); assumed not to clash with anything in Acumatica.
40. **Checklist owners** are as in the July 2026 Slab checklist; the same person preparing and
    approving is flagged, not blocked.
41. **The fiscal year is October–September** (confirmed).

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
