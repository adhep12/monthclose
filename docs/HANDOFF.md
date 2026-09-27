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
  - YTD covers the months whose Cass Operating deposits are in.
  - Drop a statement on an account's cell to attach it; the number updates in place.
  - Click a cell for detail, typed figures, confirmation, and detach.
  - On ICS, CDARS, Delap and Tschetter cells, "−" undoes an attachment or typed entry.
  - Buttons: **Export Excel** (4 tabs: the sheet, adjustment detail, sources, checks) and
    **Print / PDF**.
- **Month page (`#/poc/YYYY-MM`)** has everything for one month:
  - deposits to review (revenue / transfer / not revenue)
  - automatic and manual adjustments
  - deposits in transit
  - timing
  - GL overrides
  - notes, sign-off, and an activity log
- **CD schedule (`#/cds`)**: CDARS statements, the IntraFi export, the rolling workbook import,
  the GL 1150 tie-out, and the interest JE download.
- **Workbook import (`#/poc/import`)** reads the old workbook. For months already in the app, the
  default mode merges only deposits in transit and hand adjustments (see §4).

Fixed assets and depreciation were removed from the UI. The engine is still in `app/js/fa/` and
its tests still run.

### Where things live

| Area | Files |
| --- | --- |
| Routing, top tabs | `app/js/app.js` |
| FY sheet (most UI work happens here) | `app/js/views/poc-year.js` |
| Month page | `app/js/views/poc.js` |
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
| **Revenue GL accounts** 4010, 4012, 4015, 4017, 4018, 4075, 4077, 4081, 4083, 4084, 4085. **Interest** 4050, 8999. | `DEFAULT_POC_CONFIG`. |
| **Every statement ties before it's used.** Wise: the running balances must chain to the ending balance (`wiseTies`); Cass, PayPal, KeyBank, ICS: their own totals. A statement that doesn't shows "Doesn't tie — check" (⚠ on the FY sheet). | Wise wrapped descriptions dropped 2 × 29,993.89 (Dec), 2,228.89 (Mar), 699,993.89 (May) with no warning. Fixed in `parseWise`. |
| **Wise: only the sender makes money "ours".** "Received money from X with reference BIBLE PROJECT" is a gift from X. | Dec 9,993.89 (a donor's reference) was taken out as a transfer. |
| **Missing wire statement.** Operating shows sweeps from …5892 or …3410 but that statement isn't attached → warning, ⚠ on Cass Operating. | Feb and May: the Wise → Cass transfers sat in Incoming, which wasn't attached. |
| **Every Cass deposit is matched to the GL batch that booked it** (`gl-deposits.js`). Incoming is matched a day at a time: each day's wires equal that day's sweep, and the GL books a day as one "DAF Gifts" batch (a Wise transfer split out). Operating: 1:1, then groups (check + mobile deposits; PayPal grants), steered by the batch wording. | Feb/May/Nov: each day's Incoming credits = the day's sweep, to the cent. Match rate Feb 161/163, May 146/146, Nov 139/143, Aug 39/40. |
| **What the GL booked it to decides.** Revenue accounts → revenue. Another of our cash/investment accounts (10xx, 1150–1171) → transfer. Receivable (1210, 1220) → recognized in another month. Anything else (7220 COBRA, 8039, 2041 agency, 2042 tax) → not revenue. Stripe (1200) is left to the Stripe rule; Outgoing credits to the sweep rule. | Workbook hand lines all have a GL reason: Dec 100k agency (1020/2041), Mar 750k Murdock grant (1220), Jan 733.86 tax refund (7215), Jan 400 returned ACH (8036), Aug 7,100 Imago (8039). |
| **A hand adjustment covers the GL finding of the same amount**, so imported workbook lines and GL findings never both come out. | Merge import brings in Dec −100k, Mar −750k, etc. |
| **Revenue the GL took back** (a batch crediting cash and debiting revenue: chargebacks, a deposit reclassed) is an adjustment. A reversal with the same description, amount and accounts as another batch is a duplicate: both are dropped before matching. | Nov: three DAF batches posted twice and reversed. Dec GL017613 reclassed the 100k agency deposit. |
| **Stripe revenue = payments + refunds + disputes** (the CSV's gross). Fees are an expense (8590). | GL "Monthly Stripe Giving" credits 4015 with exactly this, every month Oct–Aug (Nov dispute 195, Dec 255, Jan 60, Feb 35, Apr 125, May 40). |
| **Stripe sales the GL moves out of revenue come off the Stripe line**, read from the GL's Stripe reclass batches: shipping (9050), sales tax (2042). Merchandise moved to 4081–4085 stays revenue. A stray Stripe transfer the GL reclasses into giving (1200 → 4015) is added. | With disputes, this explains the Stripe line vs GL to $0.00 every month Nov–Jul. Oct leaves 9.43 (that month's stray, which the GL never booked as giving). Jan's 97.50 stray was booked as giving in Feb (GL017834), so ignored strays are revenue per the GL, a month late. |
| **Deposits in transit come from the GL.** A revenue batch booked in month M whose money reached the bank in M+1 is in transit at M (the GL names the bank date: "3.3.2026 February Deposit"); one in the bank in M but booked in M+1 is a minus. The M+1 statement confirms it; until then the batch date suggests it and a person confirms (`rec.ditGl`). Typed DIT still counts unless the GL has the same amount; workbook DIT is shown for comparison only. | GL DIT = workbook DIT for Nov, Feb, Mar, Apr, Jul exactly. Dec/Jan differ by the 8,565 Cigna check the workbook put in DIT (GL: 8015, not revenue); May/Jun by a 50.00 6/11 deposit the workbook missed. Aug: 53,093.52. |

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

- **PayPal Feb:** a 15,337 gift charged back (GL017755 books "Payment Refund / Chargeback", DR 4012). The PayPal
  reader uses "Payments received", which ignores it. Needs the Feb PayPal statement to find how it shows the
  chargeback. **PayPal Mar:** GL017941 books the same 15,337 chargeback again, and the donor's 15,337 check
  (GL017858) is booked to 4012 against Cass. Unless the March PayPal statement also shows a chargeback, the GL
  double-counted it: March revenue and GL 1012 are 15,337 low. Ask the user.
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
4. **Revenue tolerance** (open decision: 0.25% of GL revenue proposed; still undecided whether to add a dollar floor). Once the
   user decides, show tied / explain / investigate status per month on the FY sheet.
5. **Confirm the November Fidelity transfer** with November's Cass statements: did the 11/03
   79,025.96 sweep from Outgoing into Operating? If not, the new rule already handles it.
6. Small outgoing items (ADP Tax, PEOPLE CENTER cents). Under the sweep rule these only matter if they swept
   back. No action unless the comparison shows otherwise.

### C. Offered, not requested
- Suggest deposits in transit from early deposits on next month's statement.
- Choose how ignored Stripe strays count (open decision 1).

## 5. Working on the app

- `npm test` runs node's test runner with no dependencies (43 tests). Run it before every commit.
- `npm run serve` previews at http://localhost:8765. Without the platform, data goes to
  localStorage and a banner says so. Clear it with `localStorage.clear()`.
- `npm run package` checks the deploy rules and writes `dist/monthclose.zip`.
- **Reading real files the way the app does.** Playwright + Chromium are preinstalled. Load the
  local server, then in `page.evaluate` import `/js/ingest.js` and call
  `readStatementFile(new File([bytes], 'x.pdf'))`. pdf.js needs a browser, so node alone won't read PDFs.
  SheetJS works in node: `import * as XLSX from './app/vendor/xlsx.mjs'` + `repairRefs`, which Acumatica
  exports need.
- **Gotchas:**
  - Native `confirm`/`prompt`/`alert` are blocked in the platform iframe. Use `ask`, `askValue`,
    `notify` and `panel` from `app/js/ui.js`.
  - A records `put` on a record the page hasn't read conflicts. Use `upsert`, or read first.
  - Hash routing only.
  - `list` returns at most 500 records (`store.listAll` pages).
- **Never commit** statements, Acumatica exports or the workbook. `.gitignore` blocks `.pdf`/`.xlsx`,
  so keep them outside the repo or in a scratch folder.
- Commit messages end with the repo's usual co-author and session lines.
