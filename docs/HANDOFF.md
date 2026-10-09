# Handoff: Proof of Cash app and the FY2026 tie-out

Status as of 2026-09-27. This doc is for the next person or agent. It covers what the app does, the
rules it follows (and the evidence behind each one), where the FY2026 tie-out stands, and the next steps in order.

Read `CLAUDE.md` first. It holds the bp-vibes platform rules: a static site in an iframe, no build
step, allowed file types, no secrets, and no deleting data without asking. `README.md` covers running and packaging.
Open decisions live in the shared doc "Proof of Cash — Open Decisions":
https://claude.ai/code/artifact/9eaf8980-2fb2-4ce2-bf01-6c9a8226ad56

## 1. What the app is

A bp-vibes static app for BibleProject accounting's month-end **proof of cash** and **CDARS
schedule**. Anyone signed in at BibleProject can open it, and all collections are `shared`.

- **Landing page (`#/poc`)** is the fiscal-year sheet, laid out like the "2026 Proof of Cash Summary"
  workbook. FY2026 runs from October 2025 to September 2026.
  - Rows show each account's revenue and interest, then Cass adjustments (expandable), timing
    adjustments, GL, the difference, and the % difference.
  - YTD covers the months that have **ended** (September counts from October 1st). A line above the sheet gives the YTD revenue and interest difference and % of GL, and lists months in YTD still waiting on a statement or the GL (their difference will move). Salesforce vs GL has the same line (its YTD: ended months with a Salesforce report and GL giving), its % rows (of GL, explained, not explained, tolerance) worked out on the YTD totals.
  - Drop a statement on an account's cell to attach it; the number updates in place.
  - Click a cell for detail, typed figures, confirmation, and detach.
  - On ICS, CDARS, Delap and Tschetter cells, "−" undoes an attachment or typed entry.
  - Buttons: **Export Excel** and **Print / PDF**. The export is built for an auditor
    (`app/js/poc/audit-trail.js`), five tabs: the sheet (first — `scripts/compare-to-workbook.mjs`
    reads it); *How to audit this*; *Adjustments summary* (each sheet row by kind of line, tied to
    the sheet); *Adjustments detail* (11 columns, one row per item that moves, deposits in transit
    included: Ref · Period · Sheet row · What it is · Who · Amount · Evidence · Bank statement (file
    name, section, date, amount, wording) · GL batch · GL entry · Why); *Checks*. No links to the
    statements: platform file URLs expire and anyone holding one can open it — the file name is
    given instead, and the PDFs are sent alongside.
  - **Refs are permanent** (`assignRefs`, saved in `rec.refs`): a line gets `A-YYYY-MM-NNN` the
    first time it's exported and keeps it; new lines get the next number; a line that stops being
    an adjustment is retired (listed in Checks), never reused. Keys are the adjustment id + date +
    statement wording (typed: `typed|id`; deposits in transit: the GL batch). Exporting saves the
    month when it numbers something new; if that save fails the export isn't made.
- **Month pop-up** (click the month name) — replaced the month page:
  - deposits to review (revenue / transfer / not revenue)
  - automatic and manual adjustments
  - deposits in transit
  - timing
  - GL overrides
  - notes, sign-off, and an activity log
- **CD schedule (`#/cds`)**: CDARS statements, the IntraFi export, the rolling workbook import,
  the GL 1150 tie-out, and the interest JE download.
- **Toolbar:** *Export* (Excel workbook or Print / PDF), *Download for Acumatica* (pick a month, default the latest with anything attached; warns which JEs can't be made yet and why), *Upload GL register*, *Payer names*.
- **Workbook import (`#/poc/import`)**, no longer on the toolbar (open the address directly), reads the old workbook. For months already in the app, the
  default mode merges only deposits in transit and hand adjustments (see §4).

Fixed assets and depreciation were removed from the UI. The engine is still in `app/js/fa/` and
its tests still run.

### Where things live

| Area | Files |
| --- | --- |
| Routing, top tabs | `app/js/app.js` |
| FY sheet (most UI work happens here) | `app/js/views/poc-year.js` |
| Month pop-up (statements, timing, notes, sign-off, activity) and every other pop-up | `app/js/views/poc-year.js` (there is no separate month page any more; `#/poc/YYYY-MM` opens the sheet with that month's pop-up) |
| Stripe payout check UI | `app/js/views/stripe-check.js` |
| CD schedule UI | `app/js/views/cds.js` |
| Workbook import UI + merge | `app/js/views/poc-import.js` |
| All proof-of-cash maths and rules | `app/js/poc/calc.js` |
| Attaching statements (any account) | `app/js/poc/attach.js` |
| Deposits checked against the GL; deposits in transit from the GL | `app/js/poc/gl-deposits.js` (batches kept by `app/js/gl.js`) |
| Statement readers | `app/js/poc/cass.js`, `app/js/poc/banks.js` (Wise, PayPal, KeyBank), `app/js/poc/stripe.js`, `app/js/cd/intrafi.js` (CDARS, ICS, IntraFi export), `app/js/gl.js` (GL register, statement of activities) |
| Which reader a file gets | `app/js/ingest.js` |
| CD schedule maths | `app/js/cd/schedule.js` |
| Storage (platform or localStorage preview) | `app/js/store.js`, `app/js/data.js` |
| Who/when stamps, confirmations, log | `app/js/audit.js` |
| Excel writer | `app/js/xlsx-io.js` (vendored SheetJS in `app/vendor/`) |
| PDF text | `app/js/pdf-text.js` (vendored pdf.js **legacy** build, since the modern build breaks in Chromium) |
| Tie-out comparison | `scripts/compare-to-workbook.mjs` |

## 2. The rules, and why

Every rule below lives in `app/js/poc/calc.js` unless another file is named.

| Rule | Evidence |
| --- | --- |
| **Cass bank activity = Operating (…5884) total credits.** Incoming (…5892) and Outgoing (…3410) reach Operating only through the daily sweeps ("Trnsfr from Checking Acct Ending in …"). | Statement structure. |
| **Stripe transfers into Cass come out.** Stripe revenue is on the Stripe line (CSV: payments + refunds). | Workbook. |
| **Stripe payout check.** CSV payouts must equal the STRIPE credits in Cass. A mismatch is flagged (⚠) and can be explained with a note. Stray small transfers can be *ignored*: they leave the check but still come out of Cass deposits. | User request. Whether ignored strays should count as revenue is an open decision. |
| **Incoming: add back what wasn't swept.** Incoming deposits are all revenue, but Operating only sees the sweeps. Adjustment = Incoming deposits − sweeps from …5892. It is positive when something was paid out of Incoming first, such as a Brotherhood insurance premium. | Workbook Dec (+6,027.25) and Jun (+6,111.67). Changed 2026-09-27; the app used to subtract these. |
| **Outgoing: only what swept back comes out.** Money landing in Outgoing (refunds, Fidelity transfers) isn't revenue, but most of it just reduces Operating's transfers out. Only sweeps from …3410 into Operating's credits are removed. | July statements: $7,487.42 landed in Outgoing and only $4,658.66 swept into Operating. Aug: $1,015.52 landed and $630.52 swept. Changed 2026-09-27; the app and workbook used to remove it all. |
| **Transfers between our own accounts aren't revenue.** A deposit matches money leaving another of our accounts: the same amount within 5 days (≥ $1,000). When the sender names BibleProject or Cass, any amount matches and a fee up to $100 and 7 days are allowed. Wise money "from BibleProject" is a transfer. Automatic findings are recomputed live; `rec.dismissed` records ones a person overruled. | User rule. |
| **Tax refunds (State of Ohio, IRS) aren't revenue** and are excluded automatically. | User rule. |
| **Wise: money out is never revenue.** A minus sign or "Sent money…" wording means out. Money in that isn't interest is revenue. The "Money out of Wise" check flags own-account transfers with no matching deposit. | User. The October statement had −39.26 read as revenue before the fix. |
| **Delap / Tschetter use the balance method.** Gain = ending − prior ending − net deposits + fees. | User. |
| **Fidelity MoneyLine transfers are Delap withdrawals.** Credits "FID BKG SVC LLC/MONEYLINE" into any Cass account are used as Delap's net deposits (negative) unless someone typed net deposits. `FIDELITY INVESTM/GrantPaymt` is a donor grant (revenue) and deliberately does **not** match. | GL register: every one is booked Dr 1100 / Cr 1170 ("Transfer Fidelity Investment Fund to Cass …"). |
| **Tschetter fees are added back** (new "Fees taken out" field). | GL books quarterly "Unrealized Gains - Tschetter Group (Expenses Quarterly)" as Dr 8070 / Cr 8999: the gain is grossed up and the fee expensed. |
| **CDs:** interest comes from the CD schedule; accrued and realized-prior come from the schedule too. | Matched the workbook every month. |
| **GL precedence:** a figure typed in the app (`gl.typedAt`), then the GL register / statement of activities, then the workbook import. | |
| **Revenue GL accounts** 4010, 4012, 4015, 4017, 4018, 4030 (OneStory rent), 4075, 4077, 4081, 4083, 4084, 4085. **Interest** 4050, 8999. | `DEFAULT_POC_CONFIG`. |
| **Every statement ties before it's used.** Wise: the running balances must chain to the ending balance (`wiseTies`); Cass, PayPal, KeyBank, ICS: their own totals. A statement that doesn't shows "Doesn't tie — check" (⚠ on the FY sheet). | Wise wrapped descriptions dropped 2 × 29,993.89 (Dec), 2,228.89 (Mar), 699,993.89 (May) with no warning. Fixed in `parseWise`. |
| **Wise: only the sender makes money "ours".** "Received money from X with reference BIBLE PROJECT" is a gift from X. | Dec 9,993.89 (a donor's reference) was taken out as a transfer. |
| **Missing wire statement.** Operating shows sweeps from …5892 or …3410 but that statement isn't attached → warning, ⚠ on Cass Operating. | Feb and May: the Wise → Cass transfers sat in Incoming, which wasn't attached. |
| **OneStory Marshall LLC** (a disregarded entity of BibleProject; the building at 810 NW Marshall, from September 2026) has its own Cass accounts and sheet rows: *OneStory Marshall - Cass Operating* (…4676, GL 1110) and *Savings* (…4839, GL 1111). Their statements are told apart by account number before anything else (`osmAccountOf`), so they never replace BibleProject's Cass Operating; read like KeyBank (`osmStatement`: deposits, interest credits, ending, ties). Its rent (4030) is revenue. A GL entry that moves 4030 with no cash is "Revenue the GL moved with no cash" on the OneStory line. | Sep 2026: 27,204.20 Ticor Title closing credit = GL019102 (Dr 1110 / Cr 4030); GL019115 moves it to 2033 Prepaid Rent and books 316.84 of prorated rent: 27,204.20 − 26,887.36 = 316.84 = 4030's net, so revenue's difference doesn't move. The other "Rental Income 9/30 Prorated" line, 576.13, was coded to 4050 (interest): September's whole interest difference. |
| **Every Cass deposit is matched to the GL batch that booked it** (`gl-deposits.js`). Incoming is matched a day at a time: each day's wires equal that day's sweep, and the GL books a day as one "DAF Gifts" batch (a Wise transfer split out). Operating: close matches first (1:1 by nearest date, then groups, within a day or two), then the wider window (1:1 within a week; a "PayPal Grant(s)" batch can cover several PayPal deposits up to a week apart), steered by the batch wording. A PayPal deposit only matches a batch that is about PayPal (says PayPal, or books to 1012); a PayPal grant or a “<date> <Month> Deposit” batch only matches Operating deposits, never an Incoming day or a Stripe transfer. | Feb/May/Nov: each day's Incoming credits = the day's sweep, to the cent. Oct: 500 + 15 PayPal were one 515 batch (GL016962, 10/7); a second 500 was its own batch 10/15. Jan: a 100 PayPal grant took AP012998 (a 100 vendor check, 1/12, Cr 2010) — the whole −100 January difference. Match rate Feb 163/163, May 146/146, Nov 142/143, Aug 39/40. |
| **What the GL booked it to decides.** Revenue accounts → revenue. Another of our cash/investment accounts (10xx, 1150–1171) → transfer. Receivable (1210, 1220) → recognized in another month. Anything else (7220 COBRA, 8039, 2041 agency, 2042 tax) → not revenue. Stripe (1200) is left to the Stripe rule; Outgoing credits to the sweep rule. | Workbook hand lines all have a GL reason: Dec 100k agency (1020/2041), Mar 750k Murdock grant (1220), Jan 733.86 tax refund (7215), Jan 400 returned ACH (8036), Aug 7,100 Imago (8039). |
| **A hand adjustment covers the GL finding of the same amount**, so imported workbook lines and GL findings never both come out. | Merge import brings in Dec −100k, Mar −750k, etc. |
| **Revenue the GL took back** (a batch crediting cash and debiting revenue: chargebacks, a deposit reclassed) is an adjustment. A reversal with the same description, amount and accounts as another batch is a duplicate: both are dropped before matching. | Nov: three DAF batches posted twice and reversed. Dec GL017613 reclassed the 100k agency deposit. |
| **When a statement rule and the GL disagree, a person decides.** A deposit a rule takes out (a matching payment out of another account, a tax refund, Fidelity wording) that the GL booked as revenue is listed under "to decide" in the Cass Operating pop-up (⚠ on the FY sheet), counted as revenue meanwhile. "It's a transfer" stores it in `rec.excluded`; "It's revenue" in `rec.dismissed`. Automatic findings stored on older records (`auto: true`) are ignored and worked out fresh. | User rule: the GL is booked by people, a coincidence of amounts isn't proof. None in the FY2026 months with statements. |
| **KeyBank Operating deposits are cash giving** unless the GL booked a KeyBank (1061) deposit from another of our accounts (taken out as a transfer). A statement total that differs from what the GL put into 1061 is flagged, with a button to take the difference out as a transfer. | User rule. Nov 155 and Apr 945 = GL. |
| **PayPal, Tschetter, Delap: transfers are called out by hand** until better statements are available. PayPal money in isn't revenue unless it's a payment received; Tschetter/Delap net deposits are typed (Delap's Fidelity transfers into Cass fill in automatically). | User. |
| **Confirmations are per line** (each sweep, each transfer; stored in `rec.autoConfirm` under the adjustment id + date + amount + description), with **Confirm all** on each section. A whole adjustment confirmed before this still counts while its amount is unchanged. | User: confirming one Outgoing line confirmed them all. |
| **Changes don't reload the page**: `softRender` in `app.js` draws the new page hidden on top of the old one and swaps it in, keeping scroll. A decision's pop-up is replaced in place (`ui.js` `carryScroll` / `nextDialog`): the reopened one opens at the same scroll position with the same sections open, over the old one without a second dimming layer, and the old one goes once the new one is showing. | User: the whole page refreshing on every change. |
| **Everything is done from the fiscal-year sheet's pop-ups; the month page is gone.** Month name → statements (drop any), restricted revenue / merchandise AR, notes, sign-off, activity. Cass Operating → every deposit (Treat as, per the GL), to decide, GL doesn't have. Each adjustment row → its items (Treat as / Leave out / Confirm) and adding, editing, removing typed adjustments. Timing / DIT → every row decidable, including statement-settled ones (override needs a reason, shown with *, listed in Checks), typed DIT add/remove. GL → typed overrides. | User: imports and documents live on the sheet, so decisions do too. |
| **Decisions can be made from the fiscal-year pop-ups** (saved to the month, logged "from the fiscal year sheet", pop-up reopens): deposits in transit (hit the bank in / confirm all), how a deposit counts (Treat as), leaving out a GL finding, and in the Cass Operating pop-up the "to decide" and "GL doesn't have" deposits. | User: control without going to each month page. |
| **A Stripe transfer that isn't one of our payouts and that the GL books as a gift stays in revenue** (someone else's Stripe account paying us), and is left out of the payout check as a gift. | Oct 2025 9.43: GL017137 "DAF Gifts – Every.org via Stripe Transfer" (Cr 4018). That was October's whole remaining difference. |
| **The sheet shows five adjustment rows by what they are** — Transfers between our accounts · Wire sweeps · Deposits that aren't revenue · Fees, refunds & reclasses · Timing (deposits in transit included) — whichever account or report they came from (`adjGroup`). Opening one lists every item under a subheading per kind (`adjDetail`), each with its reason, subtotal, evidence and note. The export keeps both (Group, Line). | User: fewer, clearer rows; detail on click. |
| **Delap / Tschetter: the gain is shown step by step** in their pop-up (ending value, less last month's, money moved, fees added back with the GL batch), against what the GL booked from its "Unrealized Gains" batches (`investmentGl`), with a Ties / different flag. | Tschetter Oct: 5,051,641.68 − 5,026,211.77 + 3,135.59 (GL017184) = 28,565.50 = GL. |
| **Every adjustment says what its evidence is**: Statement · Statement + GL (both agree) · Statement (GL says what) · GL (no bank document) · Typed. Where the GL is corroborated, the statement line is shown with it: PayPal refunds from the statement's transaction history (date, payee, amount), chargebacks from the returned-item debit on the Cass statement (this month or next), transfers from the payment out of our other account or the statement naming us as sender ("From BibleProject Via WISE"), non-revenue deposits from a named payer (WEX COBRA, ADP, CIGNA, Divvy reimbursement, tax refunds). The export's Checks tab totals what rests on the GL alone each month. No figure depends on the tag. | User: the statements and the GL should agree wherever both can speak; GL-only items identified. Layout deliberately left as the workbook's. |
| **A statement line is what the statement says; every change to it is its own labelled adjustment** with its source (GL batch or CSV line) and a why. Account adjustments wait until that account's figure is in. | User: auditors must be able to follow it without digging. |
| **Investment fees come from the GL**: 8070 in a batch touching 1170/1171 fills "Fees taken out" when it's blank (a typed fee wins). | Tschetter Oct 3,135.59, Jan 3,186.16, Apr 9,697.84, Jun 16,139.40: interest then ties to 0.00 every month. |
| **PayPal: line = "Payments received"; money given back to donors is an adjustment from the GL's "Payment Refund" lines.** Not from "Payments sent", which also holds payments to others, and not from a whole batch reversed out of the wrong period. | Feb/Mar 15,337 refunds, Aug 10.00. Jun 1,000 sent was a harvest-share payment (GL018412), not a refund. Apr GL018363 reverses a mis-posted batch. |
| **Stripe: line = payments + refunds (the CSV); disputes are an adjustment** ("Stripe disputes"). | = GL 4015 to the cent. |
| **Wise fees on incoming gifts are added back** (the GL books the gift gross, fee to expense). | 6.11 per wire: Dec 24.44, Mar/Apr/May/Aug 6.11. |
| **KeyBank: GL revenue vs deposit, per batch.** Less → a transfer or a non-giving deposit; more → cash gifts spent before the deposit. | Nov: 555 of gifts, 155 deposited, 400 spent (Cheers Club, honorarium). Apr: 50 of the 945 was a phone reimbursement. |
| **Revenue with no cash this month (per the GL)**: merchandise sold on account (Dr 1210 → timing, collected later as "recognized in another month"), a gift moved to a liability (Jan: Overflow 3,018.70 to 2052). | Oct/Dec 26, Jan 520, Feb 52, Jul 708.95 air orders. |
| **Last month's deposits in transit unknown** (the first month of the GL, nothing entered for the month before): this month's DIT counts in full and the month says so; the deposits clearing last month's are marked "Recognized in another month". If last month's list is entered as well, those marked deposits are flagged as counted twice. | Oct 2025: September isn't in this GL. With 133,829.22 marked and 152,862.12 counted, Oct = −9.43 (the Stripe stray). |
| **Deposits the GL doesn't match** are listed on Cass Operating with what the bank's wording usually means (a PayPal Giving Fund grant, Divvy rewards, a mobile check). *Confirm revenue* (or *Confirm all*) records who checked it and clears the ⚠; one a statement rule already takes out is confirmed as that instead. | Nov: Divvy reimbursement 324.08. |
| **Stripe transfers: payout, gift or timing.** Each Stripe transfer into Cass is one of our payouts (a transfer), a gift through another Stripe account (the GL books it as revenue — stays in revenue), or Stripe money the GL holds in clearing (1200) and moves to giving in a later month ("reclass of stripe clearing account to giving") — timing: out the month it arrives, counted the month the GL recognizes it, both ends linked. A person can switch payout ↔ gift (`rec.stripeAs`). | Oct: Every.org 9.43 (GL017137) — gift. Jan: 97.50 in (GL017570), moved to giving in Feb (GL017834) — timing. |
| **Revenue above the cash deposited.** A Cass deposit's GL entry can book more revenue than the cash, with the rest a non-cash debit: a fee the giving platform kept (Overflow — Dr 8070, the GL grosses up the gift) → *Fees kept by giving platforms*; or revenue released from a liability (Dr 2052, a gift held back earlier) → *Revenue released from a liability* (Timing), linked to the entry that held it back. | Every month Feb–Aug: Overflow fees (Feb 141.84, Mar 25.00, Apr 11.26, May 62.22, Jun 533.36, Jul 552.44, Aug 372.95). Jun: 3,018.70 held back in Jan (GL017932), released in GL018378. |
| **GL lines keep their identifiers; uploads are compared, not replaced blind.** Each cash-receipt batch keeps its lines (Acumatica's Identifier "GL GL017661 2", account, customer/vendor, description — the payer on a gift line — ref, amount), a fingerprint, and each month an index of every batch. A new upload lists batches added, changed (before → after) and removed, kept in the month's GL history (GL pop-up). | `gl.js` `fingerprint`, `glChanges`. |
| **Match confidence.** Every deposit's match says why: names agree (bank payer vs GL line payer, with platform aliases — BBGF = Your Cause, American/UK Online Giving = Benevity, AMRCNENDWMNTFUND = AEF), its own GL line in a group entry (identifier kept), a check deposit to the day's deposit batch, Stripe to clearing, the bank date the GL names; against: another free entry of the same amount nearby, names that differ, an AP entry, borrowing across the month end without a named bank date, a group spread over days. High / Medium / Low; Low goes to *Matches to the GL to check* (⚠). **Confirm match** pins it (`rec.glMatch`: batch + fingerprint) — taken before any rule, flagged if the entry changes or disappears; **Not this entry** (`rec.glNot`) rematches without it. | FY2026 sandbox months: Nov 142 high; Feb 163 high; May 145 high, 1 medium; Aug 38 high, 1 medium (Imago check), 1 low (Paramount, AP014203). |
| **A month's to-do list** (the badge under each month on the sheet): statements missing, matches to check, rule-vs-GL, deposits the GL doesn't have, deposits in transit to confirm, each adjustment group's lines to confirm (GL-only lines of `cfg.glOnlyThreshold`, default $500, or more called out — confirm against a document), Stripe payout mismatch, Wise money out not found, account figures to confirm, sign-off. Each item opens in place with its rows and the same Status / Confirm / Change… as its own pop-up (`adjKit`, `cassSummary(…, { only })`, `ditBlock(…, { onlyTodo })`), plus Confirm figures, Explain (Stripe), Mark prepared / reviewed; decided items drop off (the badge reaches 0) and live in their rows on the sheet. "Open the full pop-up →" for the wider view. | User: one place per month for everything left, decided there. |
| **Payer names** (toolbar): the built-in aliases (`BUILT_IN_ALIASES` in gl-deposits.js) and any added in the app (`cfg.aliases`: statement words = GL words), used by match confidence. | |
| **Matching across month end:** last month's *non-revenue* batch with no bank date in its name (a refund or reimbursement check) can match a deposit up to 12 days later early in the month — not a gift or grant, which is booked the day it arrives (a 4/27 PayPal grant of 2,000 must not take a 5/8 one); AP batches that put money into Cass are matched (a vendor refund) but never listed as GL-only; one deposit can be several batches of the same kind. | Cigna 8,565 booked 12/31, deposited 1/7. MA PFML 181.25 booked 2/25, deposited 3/3. Paramount 600 (AP014203). Koorong 595 = 520 + 75 receivable payments. |
| **PayPal revenue = payments received less USD payments sent** *(superseded by the rule above)* (money given back to donors). The tie check includes Transfers. | Feb/Mar 2026: 15,337 returned to a donor each month, booked by the GL as "Payment Refund" DR 4012. Feb 1,021.48 and Mar 17,829.08 = GL 4012 (less the check to Cass). |
| **Stripe revenue = payments + refunds + disputes** (the CSV's gross). Fees are an expense (8590). | GL "Monthly Stripe Giving" credits 4015 with exactly this, every month Oct–Aug (Nov dispute 195, Dec 255, Jan 60, Feb 35, Apr 125, May 40). |
| **Stripe sales the GL moves out of revenue come off the Stripe line**, read from the GL's Stripe reclass batches: shipping (9050), sales tax (2042). Merchandise moved to 4081–4085 stays revenue. A stray Stripe transfer the GL reclasses into giving (1200 → 4015) is added. | With disputes, this explains the Stripe line vs GL to $0.00 every month Nov–Jul. Oct leaves 9.43 (that month's stray, which the GL never booked as giving). Jan's 97.50 stray was booked as giving in Feb (GL017834), so ignored strays are revenue per the GL, a month late. |
| **Deposits in transit come from the GL.** A revenue batch booked in month M whose money reached the bank in M+1 is in transit at M (the GL names the bank date: "3.3.2026 February Deposit"); one in the bank in M but booked in M+1 is a minus. The M+1 statement confirms it; until then the batch date suggests it and a person confirms (`rec.ditGl`). Typed DIT still counts unless the GL has the same amount; workbook DIT is shown for comparison only. | GL DIT = workbook DIT for Nov, Feb, Mar, Apr, Jul exactly. Dec/Jan differ by the 8,565 Cigna check the workbook put in DIT (GL: 8015, not revenue); May/Jun by a 50.00 6/11 deposit the workbook missed. Aug: 53,093.52. |

## Salesforce vs GL (giving), below the proof of cash

`app/js/sf/salesforce.js`, section `sfSection` in `poc-year.js`, records in `sf-giving` (one per month).

| Rule | Evidence |
| --- | --- |
| **Salesforce side:** the opportunity summary by close date and payment method (Record Type ≠ Purchase), month × method: amount and count. | Report "Opportunity Proof of Cash". |
| **Salesforce uploads: gift-level or summary, several at once.** `parseSalesforceReport` reads either the summary report or the gift-level one (Amount, Close Date, Payment Method, Donor-Advised, contact, card transaction id), totalling gifts by month × method. Each file replaces exactly the months its date filter covers (`coveredMonths`: every month the "Close Date equals … (m/d/yyyy to m/d/yyyy)" range touches, up to the month it was run; a covered month with no gifts is saved as zero; a partly covered month is flagged). Without a date range, only the months with gifts are replaced. Two files covering the same month: the one run later wins. Check and wire gifts are kept per month (`gifts`: [date, amount, donor-advised fund, contact id, C/W]) for matching gift by gift later; Stripe gifts are totals only. | User export "Opportunity 2025 Account and tranxn" Oct–Dec 2025: 95,846 gifts, 11,663,660.29, about 8 s to read in Chromium. Salesforce's formatted export stops near 100,000 rows, so busy periods need a report per month or two. |
| **A report that leaves out refunded / disputed Stripe gifts** ("Stripe Transaction Status not equal to Disputed,Refunded,…", `reportExcludes`) means the GL's Stripe refunds and disputes don't explain a difference, so they aren't counted. | Dec 2025 Stripe: summary report 4,185,562.13 (30,673 gifts), gift-level report 4,169,577.13 (30,645): 15,985.00 and 28 gifts are the refunded and disputed ones. |
| **GL side: giving** = 4010, 4012, 4015, 4017, 4018 (not merchandise 408x, Amazon 4075, card rewards 4077), split into Salesforce's channels line by line at GL upload (`gl.js` `givingChannel`): Stripe 4015; PayPal 4012 + "PayPal Grant" lines; Patreon lines; Cash = KeyBank (1061) batches; Check = 4010 (customer PATROC001 is patrons, not Patreon); Wire = 4018. Restricted 4017 goes to the channel it came in by and is listed. | FY2026 Oct: Check 346,068 incl. a 100k restricted gift. |
| **Explained, automatically:** Stripe refunds and disputes (Salesforce keeps the gift, the GL takes them off); money received for revenue the GL recognized earlier (the proof of cash's "recognized in another month" deposits); GL revenue with no cash (grants recognized when pledged, gifts moved to/from a liability); releases from a liability in a deposit; month-end timing — a channel's leftover one month cancelled (within 10%) by the next month's. | Stripe Dec +308,547 / Jan −307,908: year-end gifts, Salesforce Pacific vs Stripe UTC. Mar Wire: 750,595 Murdock grant (receivable). |
| **Deposits in transit don't explain Salesforce vs GL.** The GL books a check deposited early next month in the month it was received ("3.3.2026 **February** Deposit", posted in February), the same month Salesforce dates it; deposits in transit are a bank-vs-GL item. FY2026: June DIT +116k, Check + Wire not explained +11k; February DIT −0.4k, −134k. What does show is year-end giving: Salesforce ahead Nov–Dec (+381k Check + Wire), the GL catching up Jan–Feb (−187k) — read on the *running total* row. Received-earlier items count only when collected on a grant/pledge receivable (1220), not merchandise AR (1210, air orders) or card rewards. Check and Wire are read together too (DAF grants paid by check: Salesforce Check, GL 4018). | User export 2026-09-28. |
| **Flagged:** a GL channel far above Salesforce's (5×, over $5,000), with its largest lines. | Feb: GL017631 "Patreon" 100,478.47 vs Salesforce Patreon 2,285.08. |
| **YTD** covers the months that have ended (as the proof of cash) with a Salesforce report and GL giving; a month not yet ended is greyed. | |
| **Wires are compared sponsor by sponsor** (`sponsorOf`: Salesforce's donor-advised fund, the GL line's payer: "National Christian Foundation" = "NCF"). The GL upload keeps each month's giving by payer (`giving.payers`, gl.js); older uploads need the GL register uploaded again. A sponsor's leftover one month cancelled (within 10%) in the next month or the one after is timing on that sponsor. | FY2026: Benevity Dec +58,162 / Jan −62,158; Overflow May +37,511 / Jun −41,310; AEF Apr/May 10,375. |
| **Platforms that pay in lumps** (`LUMP_PLATFORMS`: Great Commission Foundation, Stewardship, Patreon): a running balance of gifts Salesforce has and the GL hasn't been paid yet. While owed, the difference is timing; a payout pays it down; a payout larger than what's owed pays for gifts from before these months. Flagged when a platform goes 3 months without a payout (was 6; shortened so a missing gift can't sit as "owed" for long). | GCF paid 181,170.64 in Feb (GL017685) for Oct–Feb plus 27,328 from before; nothing since (133k owed at Aug, flagged). Stewardship paid Dec 58,869 and Apr 94,393. Patreon's first withdrawal 2/6/2026 (GL017631, 100,478.47) cleared a balance the GL had never recorded: 88,849 from before Oct 2025 (user confirmed). |
| **Gifts the GL took back out of revenue** (the proof of cash's "Revenue the GL took back", gift accounts 4010–4018 only): Salesforce still has the gift. | Dec: Indian Localization 100,000 deposited 12/18 (GL017385), moved to agency as a pass-through (GL017613); Salesforce has it as a 12/9 check gift. |
| **A check booked to PayPal revenue** ("BP receiving check" in 4012) counts as a Check. | GL017858, March 15,337. |
| **Open (FY2026):** NCF 100,000 on 11/12/2025 in Salesforce (contact 003PC00000LaDSyYAN) has no GL entry in any account and no bank deposit; the same contact's 12/11 100,000 is GL017377 (12/15, 110,000). User getting outside verification. Stripe −45k for the year (Salesforce's report drops gifts by Stripe status; a report grouped by status would show which). No PayPal refund rule: the 15,337 returned-PayPal donor isn't in Salesforce as a gift. | With these rules, FY2026 Oct–Aug unexplained goes from 231,331 to about 24,800 (Nov's 114k is the NCF gift). |
| **A person can explain a difference themselves** (Salesforce vs GL month pop-up, "Explain a difference yourself"): giving type, optional sponsor, what it is (`SF_ADJ_TYPES`: timing, restricted, agency, not received, not in Salesforce, another period, different giving type, other), the amount of the Salesforce − GL difference it accounts for (starts at what's left for that giving type) and why. Kept on the sf-giving month (`adjustments`, stamped who/when, `updatedAt`), carried over when Salesforce is uploaded again, removable. Counts as explained (evidence Typed). | User request 2026-09-28. |
| **Running totals** (`toDate` on each reconciled month): each giving type and each wire sponsor, Salesforce against the GL from the first month to this one, in the month pop-up and the export's "Running totals" tab, so a lump payout reads against what built up before it. | Patreon Feb 2026: Salesforce Oct–Feb 11,629.54, GL 100,478.47: 88,848.93 not in Salesforce for these months (about 38 months at 2,338 a month). |
| **Tolerance, not zero.** Salesforce and the GL can't tie to zero as things are kept (different dates, detail and rules, no shared key), so what's held to a limit is the unexplained difference (`withinTolerance`, `ytdTolerance`): each month at most 1% of GL giving, year to date at most 0.25%. A month over shows "Investigate". Any giving type with more than $10,000 unexplained is listed to look at (not a fail: a giving type's leftover is many small things). Limits in settings (Salesforce vs GL → Tolerance…, `cfg.sfTolerance`). | User decision 2026-09-28. FY2026 with the rules: Oct 0.68%, Nov 4.59% (NCF 100k), Dec 0.72%, Jan 1.75%, Feb 0.23%, Mar 2.13%, Apr 0.01%, May 0.63%, Jun 1.01%, Jul 1.46%, Aug 0.59%; YTD 0.08%. |
| **Salesforce gifts the GL doesn't seem to have** (`suspectGifts`): each Salesforce wire gift of $5,000+ (settings) is looked for in the GL's wire lines (`giving.wireLines`, lines of 1,000+; needs the GL register uploaded again) from 3 days before to 45 days after: same sponsor (same amount, or inside a larger line), a processor (Chariot, iPay, Cybergrants, YourCause), or the same amount under another name, which is only a *possible match* shown next to the gift (it stays to look at: Nov 2025's NCF 100,000 otherwise matched December's unrelated Indian Localization 100,000, GL017385). Biggest gifts first, each at the nearest line. The pop-up also lists how every other wire gift was found (line and batch) or why it wasn't looked for (a lump platform, or explained by a receivable or a typed explanation of the same amount). Lump-payout platforms and gifts already explained (receivables, a typed explanation for that sponsor and amount) are skipped. Shown only in the month pop-up when there are any, and in the export's "Gifts to look at" tab. Each gift is decided on the spot ("Say what it is…"): not received (duplicate or pledge), received into another account (e.g. stock not sold yet), or something else — each an explanation of the gift's amount tied to it (`adjustments[].gift` = `giftKey`), counting as explained — or "it's in the GL" (`giftChecks[key]`, no amount). A note is required; decided gifts move to "Looked at" with who, when and Undo. Checks can't be matched (GL deposits don't name donors). | FY2026: 157 looked for, 2 not found: NCF 100,000 on 11/12/2025 (contact 003PC00000LaDSyYAN; the same donor's 12/11 gift is GL017377's 110,000 on 12/15; user: may have gone to a barely-tracked account, e.g. stock not yet sold) and Morgan Stanley 5,000 on 1/14/2026 (0036R00003VPwx2QAD). |
| **Explained is split by what backs it**: *by the GL or a person* (GL entries, receivables, typed explanations) and *by a pattern only* (`byPattern`: month-to-month timing, a lump platform's balance still owed), which nothing has checked, so it isn't read as verified. | User 2026-09-30. |
| **Next:** match the kept check gifts by deposit date. | |

## Monthly JEs

`app/js/je/` (`month.js`: batch numbers and the import file; one file per process), shown by
`app/js/views/month-jes.js` in the month pop-up (every JE, one download) and each account's pop-up.
The download is laid out like the Acumatica tab of the user's "Month Close Bank Recs" workbook:
BatchNbr · Transaction Date (month end) · Document Description · Account · Subaccount · Debit ·
Credit · Transaction Description. Each process has a fixed batch number (Stripe 1, PayPal 2, …).

| JE | Rule | Evidence |
| --- | --- | --- |
| **1 Monthly Stripe Giving** | Every Stripe CSV figure booked with the sign Stripe prints (credit when it added to the balance): gross to 4015, fees to 8590 (013-000), disputes net of reversals, payouts Dr 1200, balance change to 1015. Same lines and descriptions as the workbook; zero lines left out. The CSV must add up (activity = Net Activity, balance rolls forward). | August 2026 = the posted batch to the cent; every month in the CSV back to 2015 balances. The workbook's dispute formulas are replaced by the netting (they errored with no disputes). |
| **2 Paypal Giving** (`je/paypal.js`) | From the statement's Activity Summary: Cr 4012 payments received; Dr 8590 fees; Dr 1012 received less fees; payments sent Dr 8030 / Cr 1012 (software), each listed in a note; chargebacks Dr 4012 "Payment Refund" / Cr 1012 "Chargeback". Withdrawals, deposits and transfers aren't in the entry (noted). The reader now reads "Chargeback" and the tie check includes it. | August 2026 = the posted batch to the cent. Before the fix August showed "doesn't tie" by the 10.00 chargeback. A payment sent is software (8030) or a refund to a donor (with the chargebacks: Dr 4012 "Payment Refund" / Cr 1012 "Chargeback"), chosen per payment in the PayPal pop-up (`rec.paypalSentAs`; wording with "refund" starts as one). Feb 2026 (15,337 refund) = the posted batch. Withdrawals, deposits and transfers are booked by the entry on the other side (user). "Payment Refund Fee" (8030) is always zero so far, not built. |
| **3 Unrealized Gains - Tschetter Group** (`je/investments.js`) | One entry: 1171 = ending − the latest earlier ending the app has (a skipped month is picked up) − money moved (booked by its own entry); 8070 = fees since last booked; 8999 = both. Fees only from a statement: the Schwab PDF (`parseSchwab`: Account Summary, this period and calendar YTD) or a scanned one kept as evidence with *Expenses year to date* typed. Fees = YTD − the YTD on the last statement this calendar year; with none in the app, − what the GL booked to 8070 this calendar year. Screenshot months book the gain only (the next statement catches the fees up). The fee months go in the transaction description. A beginning value (statement, or typed from a screenshot) that isn't the last ending booked is flagged, not used. | April 2026 statement: YTD 12,844.00 − Jan 3,186.16 = 9,657.84 (Feb–Apr). The GL's April fee entry is 9,697.84: 40.00 more, not explained yet. March screenshot starts 5,164,013.51 but February's ends 5,154,602.05. |
| **4 Unrealized Gains - Delap** | Same, no fees; typed ending (a screenshot can be kept). Fidelity → Cass transfers are the net withdrawals, as in proof of cash. | User's format (1170 / 8999, 8070 line zero). |

| JE | Rule | Evidence |
| --- | --- | --- |
| **5 CD Interest** | The CD schedule's interest for the month (`cdInterestJE`, the same as its own download): Dr 1150 / Cr 4050 "Interest Earned - 1234" per CD. Line edits apply to every CD; `{cd}` is the last four digits. | |

**Downloads:** the month pop-up's *Journal entries* section downloads every ready JE in one file, Excel
(an "Acumatica" sheet) or CSV (same columns, dates m/d/yyyy); each account pop-up downloads its own.

**Editing the lines:** *Edit lines…* on any JE preview changes a batch's document description and
each line's account, subaccount and transaction description. Saved to the shared settings
(`config.jeDefaults[batch id]`: only what differs from built in, with who and when) as the default
for every month, until reset. Line keys come from each builder's template (`STRIPE_TEMPLATE`,
`PAYPAL_TEMPLATE`, `investmentTemplate`); descriptions keep `{date}` / `{fees}` placeholders.

## 3. FY2026 tie-out: where it stands

Source: the user's export `Proof of Cash FY2026 2026-09-27.xlsx` compared with the tied-out workbook
`Proof of Cash - 2026.xlsx` using `scripts/compare-to-workbook.mjs`. The export was made
**before** the 2026-09-27 fixes. Every month's difference is fully accounted for below.

### Interest: all explained; ties to $0 once two things are done

| Month | App difference | Cause | Status |
| --- | ---: | --- | --- |
| Oct | −3,135.59 | Tschetter quarterly fee | Enter in Tschetter "Fees taken out" |
| Nov | −79,025.96 | Fidelity → Cass transfer not treated as a Delap withdrawal | **Fixed in code** (automatic) |
| Dec | −84,706.53 | Same (57.14 + 84,649.39) | **Fixed in code** |
| Jan | −3,186.16 | Tschetter quarterly fee | Enter the fee |
| Feb | −86,170.59 | Fidelity → Cass | **Fixed in code** |
| Mar | −51.58 | Fidelity → Cass (51.56 + 0.02) | **Fixed in code** |
| Apr | −9,697.84 | Tschetter fee, posted after the workbook was tied out | Enter the fee |
| May | 0 | | |
| Jun | −16,139.40 | Tschetter fee | Enter the fee |
| Jul | 0 | | |
| Aug | 0 | | |

The Delap fix only applies where Delap's net deposits field is **blank**. If someone typed 0, clear it.

### Revenue: app difference by cause (from the pre-fix export)

App differences: Oct −9,667.55 · Nov −112,190.60 · Dec −99,689.82 · Jan 277,300.81 · Feb 205,877.28 ·
Mar 701,299.22 · Apr −620,752.18 · May −30,950.23 · Jun −134,423.96 · Jul 94,431.12 · Aug 7,352.59.

| Cause | Months and amounts (app minus workbook) | Fix |
| --- | --- | --- |
| Deposits in transit not in the app | Oct −19,032.90 · Nov −30,698.01 · Dec −117,710.90 · Jan +255,952.82 · Feb +405.19 · Mar −49,296.53 · Apr +44,234.94 · May +11,944.35 · Jun −116,485.84 · Jul +97,533.04 | Re-run the workbook import in **merge** mode |
| Hand adjustments only in the workbook | Dec −100,000 and Mar −750,000 ("Cass Operating Net Activity", transfers into Operating) · Oct −10,479.69 (CC rewards for prior month) · Jan −733.86 (reimbursements), −400 (returned wires) | Merge import brings them in. Don't also mark the same deposits as transfers, or they'll double count. |
| Incoming payments subtracted instead of added back | Dec −12,054.50 · Mar −11,572.50 · Jun −12,223.34 (twice the Brotherhood premium each) | **Fixed in code.** Mar will now show +5,786.25 against a workbook that has nothing for it; the workbook missed it that month. |
| Outgoing money removed even when it never reached Operating | Every month; July over-removed 2,828.76. Nov's 79,025.96 Fidelity transfer is probably the same: the workbook effectively left it in, and GL books it as a transfer. | **Fixed in code.** Confirm Nov with its statements (task B5). |
| Wise → Cass transfers not matched | Feb +200,000 · May +660,000 (still counted as Cass revenue) | Task B2 |
| Wise money in, lower than the workbook | Dec −59,987.78 · Mar −2,228.89 · May −39,993.89 | Task B1 (linked to B2: the workbook counts May's 660k as money into Wise) |
| April Cass statements are scanned images (no text) | Apr −620,752.18 (Cass Operating and its adjustments missing) | User to download electronic statements |
| Stripe strays | Oct 9.43 · Jan 97.50 | Ignore on the payout check |
| GL posted after the workbook was tied out | Jan +3,018.68 · May +65.69 | None: a real later posting |
| August | Workbook not done for August. The app has no August deposits in transit yet. | Enter August DIT from September's early deposits |

The workbook's own remaining differences are the floor: Oct −640.39 · Nov 839 · Dec −7,475.48 ·
Jan 17,322.22 · Feb 5,472.36 · Mar 8,661.90 · Apr 1,251.12 · May −2,966.38 · Jun −5,714.58 · Jul −3,101.67.
The Outgoing fix should improve some of these: July is expected to go from −3,101.67 to about −273.

## 4. Next steps

**2026-09-27, latest export (after deploy):** interest differences were only the four Tschetter fees (now from the GL).
Revenue by month, and what explains it (source split with the GL, `scratchpad floor2` method: each GL revenue batch
assigned to the bank account on its other side):
Oct −8,588.64: October's DIT change is blank because September 2025 isn't in this GL (the workbook had 133,829.22 → change
+19,032.90), and the 10/14 Divvy CC rewards 10,479.69 were booked in FY25; with both, −9.43 (the October Stripe stray).
Nov −75.92: KeyBank cash spent 400 (now automatic); a 324.08 Divvy reimbursement the GL has as 648.16 — mark not revenue.
Dec −50.44: Wise fees 24.44 + air order 26 (both now automatic) → 0.00. Jan +11,115.70: Cigna 8,565 (now matched), Overflow
3,018.70 and air order 520 (now automatic) → about +52. Jun: 1,000 no longer taken off PayPal. Apr: Cass statements missing.


**Since the tie-out above (2026-09-27, later):** the Wise reader, the GL deposit check and GL deposits in transit
are built (rules in §2). The workbook's small monthly differences look like two larger errors cancelling: the
Stripe CSV line is 10–31k above GL 4015 every month, offset elsewhere. February's difference rises by 10,126.31
under the Outgoing sweep rule (on 2/2 only 76,044.28 of the 86,170.59 Fidelity transfer swept into Operating); that
gap was real and hidden by the workbook.

**Stripe, taken apart (later still):** the Stripe line is *not* a big error. The 10–31k gap to 4015 is the GL
moving merchandise sales out of 4015 into 4081–4085, which stays inside total revenue. What really leaves revenue
is disputes, shipping and sales tax (under 1,200 a month), now handled (rules in §2). The workbook's monthly
difference, broken down by source with the GL, sums to the workbook's own figure within cents (Jan and May
differ only by later GL postings):

| | Oct | Nov | Dec | Jan | Feb | Mar | Apr | May | Jun | Jul |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stripe (now 0) | 597 | 815 | 755 | 1,142 | 323 | 173 | 815 | 384 | 117 | 663 |
| PayPal | | | | | 15,337 | 15,337 | | | | |
| Cass | −1,211 | 424 | −8,181 | 16,700 | −10,135 | −6,841 | 393 | −3,278 | −5,832 | −3,056 |
| Other (Wise fees, KeyBank, AR) | −26 | −400 | −50 | 2,499 | −52 | −6 | 44 | −6 | | −709 |

- **PayPal (solved):** not a chargeback and not a GL error. The PayPal statements show 15,337 *sent back* to a
  donor on 2/13, received again 3/9, sent back again 3/23; she gave by check to Cass in March (GL017858). The GL
  books each return as "Payment Refund", DR 4012. Rule: PayPal revenue = payments received + USD payments sent
  (`paypalRevenue`); Feb 1,021.48 and Mar 17,829.08 = GL. The tie check now includes Transfers (currency
  conversion for BRL vendor payments). With PayPal, Stripe and the sweep rule, **Feb comes to about −61**.
- **Cass:** Feb −10,135 is the 10,126.31 Fidelity over-removal (the sweep rule fixes it); Jul −3,056 is mostly
  the 2,828.76 Outgoing over-removal. Dec/Jan include the 8,565 Cigna check the workbook ran through DIT. The rest
  needs each month's Cass statements attached, then the GL deposit check lists what's left.

After deploying: **upload the GL register again** (older uploads don't have the deposit batches), re-attach
Wise for Dec, Mar and May, and attach Incoming for Feb and May.

### A. The user does these (the agent can't)
1. Deploy the latest `dist/monthclose.zip` (run `npm run package`) on the app's Deploy card in HAL.
2. **Import workbook** → choose the old workbook → leave "Months already in the app" on the default
   merge option → Import. This adds deposits in transit (months with none entered) and hand
   adjustments, and leaves out Stripe transfers, wire sweeps, Wise transfers and Fidelity transfers.
3. Tschetter → **Fees taken out**: Oct 3,135.59 · Jan 3,186.16 · Apr 9,697.84 · Jun 16,139.40.
   Also check Delap's net deposits are blank for Nov, Dec, Feb and Mar.
4. Re-download the **April** Cass statements (…5884, …5892, …3410) as electronic PDFs and attach them.
5. Enter **August** deposits in transit.
6. On Oct and Jan, **Ignore** the Stripe strays in the payout check.
7. **Export Excel** again and give it to the agent.

### B. Agent tasks
1. **Wise money-in gaps (Dec, Mar, May).** Get those Wise PDFs from the user. Run them through
   `readStatementFile` (see §5) and compare the items with the workbook's Wise revenue (Dec 160,128.41,
   Mar 2,228.89, May 701,758.51). The likely cause is a line format `parseWise` / `classifyWiseItems`
   in `app/js/poc/banks.js` doesn't handle. Candidates are currency conversions, "Received money from…"
   with the amount on a different line, or card refunds. Fix the reader and add a test with the real
   line shapes (anonymized).
2. **Wise → Cass transfers (Feb 200,000; May 660,000).** Get the Feb and May Cass Incoming and
   Operating statements. Find the matching deposit and why `detectTransfers` / `wiseOutgoingCheck`
   missed it: a date gap over 7 days, a fee over $100, a split deposit, or wording. Fix it and test it.
   Do this together with B1 so May's 660k is counted exactly once (as money into Wise), not
   zero or two times.
3. **Re-run the comparison** on the new export:
   `node scripts/compare-to-workbook.mjs "<export>.xlsx" "<Proof of Cash - 2026>.xlsx"`.
   Explain whatever remains beyond the workbook's own differences, month by month.
4. **Revenue tolerance** for the proof of cash (open decision: 0.25% of GL revenue proposed; still undecided whether to add a dollar floor). Once the
   user decides, show tied / explain / investigate status per month on the FY sheet. (Salesforce vs GL has its own, decided: see its rules.)
5. **Confirm the November Fidelity transfer** with November's Cass statements: did the 11/03
   79,025.96 sweep from Outgoing into Operating? If not, the new rule already handles it.
6. Small outgoing items (ADP Tax, PEOPLE CENTER cents). Under the sweep rule these only matter if they swept
   back. No action unless the comparison shows otherwise.

### C. Offered, not requested
- Suggest deposits in transit from early deposits on next month's statement.
- Choose how ignored Stripe strays count (open decision 1).

## 5. Working on the app

- `npm test` runs node's test runner with no dependencies (53 tests). Run it before every commit.
- `npm run serve` previews at http://localhost:8765. Without the platform, data goes to
  localStorage and a banner says so. Clear it with `localStorage.clear()`.
- `npm run package` checks the deploy rules and writes `dist/monthclose.zip`.
- **Reading real files the way the app does.** Playwright + Chromium are preinstalled. Load the
  local server, then in `page.evaluate` import `/js/ingest.js` and call
  `readStatementFile(new File([bytes], 'x.pdf'))`. pdf.js needs a browser, so node alone won't read PDFs.
  SheetJS works in node: `import * as XLSX from './app/vendor/xlsx.mjs'` + `repairRefs`, which Acumatica
  exports need.
- **Pop-ups check lines one way** (`poc-year.js`: `statusCell`, `actionsCell`, `changeSelect`,
  `reviewHead`). Every checkable line has Date · Description (what it is, with who/source under it)
  · Amount · Evidence · **Status** (To check / ✓ Confirmed, who, when / Changed / Overridden* / ✓
  Statement shows it, plus how it counts) · then the actions, always in this order: **Confirm**
  (keeps how it counts now), **Change…** (a menu of the other ways it can count), then Undo, Leave
  out, Edit or Remove. Every section heading shows what's left to check, *Confirm all* and the
  subtotal; each pop-up opens with a bar counting everything left, with one *Confirm all*. Going
  from one pop-up to another closes the first. Nothing is final: a confirmed line has *Undo
  confirm*; a line decided out of a group (counted as revenue, left out, moved) stays listed in
  that pop-up under *Changed here* (decisions record `from`, the group) with Undo; and Cass
  Operating's *Decisions made this month* lists every decision on the month, wherever it was made.
  Keep new pop-ups to this.
- **Stale reads (the 409s):** straight after a save the platform can hand back the month as it was,
  and a save based on that copy is refused (409). So once this page has saved a month it works from
  its own copy (`readMonth` / `recentSaves`; a fresh read only to retry after a conflict), the sheet
  redraws after a decision from the list it already has (`listed`, relisted on open or after five
  minutes), GL uploads the same (`recentGl`), and reads from the records API skip the browser cache
  (`store.js` `noStaleReads`).
- **Saving a month:** a decision reads the month fresh, changes it and saves (`decide`, one retry on
  a conflict). A pop-up that stays open (an account) saves what it changed onto the month as it is
  now (`saveMerged` → `merge.js`), so it never writes an old copy over someone else's save. Right
  after a save the sheet uses what this page saved (`recentSaves`) until the platform's list catches
  up — before this, a confirmation looked like it hadn't stuck.
- **Gotchas:**
  - Native `confirm`/`prompt`/`alert` are blocked in the platform iframe. Use `ask`, `askValue`,
    `notify` and `panel` from `app/js/ui.js`.
  - A records `put` on a record the page hasn't read conflicts. Use `upsert`, or read first.
  - Hash routing only.
  - `list` returns at most 500 records (`store.listAll` pages).
- **Never commit** statements, Acumatica exports or the workbook. `.gitignore` blocks `.pdf`/`.xlsx`,
  so keep them outside the repo or in a scratch folder.
- Commit messages end with the repo's usual co-author and session lines.
