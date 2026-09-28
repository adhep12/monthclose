# Proof of cash: audit of the rules (2026-09-28)

A review of every rule in `HANDOFF.md` §2 against accounting and audit logic: what each rule
relies on, what could slip past it, and whether a month can be reproduced once it's signed off.

## Verdict

The accounting treatments hold up. Gross revenue with platform fees as an expense, Stripe revenue
from the CSV, the balance method for investments, deposits in transit from bank dates, and refunds
off revenue are all standard and applied the same way every month.

The gaps are in **evidence and control**, not in the arithmetic:

1. Many reconciling items are worked out *from the GL*, so a GL error of the same kind is accepted
   rather than caught (A1).
2. Matching deposits to GL entries by amount and date can pair the wrong things without saying so
   (A2).
3. A signed-off month can't be reproduced: every figure is recalculated each time the page opens
   (A3).
4. The data, including bank statements, can be read and changed by anyone signed in at BibleProject
   (A4).

## What the difference proves, and what it doesn't

The revenue difference tests **completeness and existence of cash receipts**: every deposit on the
statements is in the GL at the same amount, in the right month, and nothing is in GL revenue that
never reached a bank.

It does **not** test **classification**. Where the app decides "not revenue", "transfer" or
"recognized in another month", it usually reads that from the account the GL booked the deposit
to. A gift booked to a liability, or a transfer booked as revenue, is therefore mirrored on the
bank side and nets to zero. That's inherent in a proof of cash, but it should be said plainly to
auditors. Classification is tested separately, by vouching a sample of the GL-classified items to
source documents.

## Findings

### High

**A1. GL-derived reconciling items are accepted without independent support.**
These adjustments exist only because the GL says so:
- fees kept by giving platforms (8070);
- revenue released from a liability (2052);
- non-revenue and prior-period deposits (the account the GL booked to);
- KeyBank splits;
- Wise fees;
- chargebacks with no returned item;
- investment fees (Tschetter, Delap);
- deposits in transit named only in the GL.

If the GL is wrong in one of these ways, the proof of cash still comes to 0.00.
- *Existing mitigation:* every item carries an evidence tag, and the Checks tab totals what rests
  on the GL alone.
- *Fixed 2026-09-28:* tagged GL; GL-only lines of $500 or more are called out on each month's to-do list (confirm against a document).
- *Gap (was):* the new platform-fee and liability-release items were tagged "Statement amount · GL says
  what" but should be tagged "GL". The statement shows only the net deposit, never the fee.
- *Recommend:* tag them GL; require a Confirm (with a note) on GL-only items above a threshold; keep
  supporting documents (Overflow remittance reports showing gross, fee and net; Tschetter and Delap
  fee lines from their statements) and attach them to the month.

**A2. Matching by amount and date can pair the wrong things silently.**
January's PayPal 100 matched a vendor check to accounts payable (AP012998). April's 2,000 matched
May's grant. Each was fixed with a specific rule, but the general risk remains: same amount, nearby
date, unrelated entry. When that happens nothing looks wrong. The deposit is simply classified by
the wrong entry.
- *Recommend:* show a **match confidence** and list the weak matches for review. Weak means: the
  payee in the deposit description isn't in the batch description; the batch is AP; the match
  borrows from another month; or a group match spans more than two days. Confirming a line should
  record *which* GL batch it was confirmed against (see B1).
- *Done 2026-09-28:* every match has a confidence (High / Medium / Low) with its reasons; Low goes to
  "Matches to the GL to check". Confirm match pins the deposit to the batch and its fingerprint, and
  a pinned match is flagged if the batch changes or disappears in a later upload. Each upload is
  compared with the last one (batches added, changed, removed) and kept in the GL history.

**A3. A signed-off month isn't frozen.**
Every finding is recalculated from the statements, the GL upload and the rules each time. A new GL
register or a rule change (like today's) quietly changes prior months, including signed-off ones.
The sign-off does show "numbers changed since", but the version that was reviewed can't be
reproduced.
- *Recommend:* at sign-off, save the month's full result (every line, adjustment, evidence and GL
  batch) and the name of the GL file; lock the month (reopening needs a reason); and show what
  changed against the signed-off version.

**A4. Access: everything is `shared`.**
`vibes.json` sets every collection to `shared`, which means anyone signed in at BibleProject. Any
staff member can read the bank statements (account numbers, donor names, amounts) and can also
write to the records, including sign-offs, confirmations and decisions. "Ideally someone else
confirms / reviews" is only a hint.
- *Recommend:* `group:<accounting group>` on `poc-months`, `statements`, `gl-activity`, `soa`,
  `cds`, `trial-balances`; this is enforced by the server. Block (not just warn) the same person
  marking prepared and reviewed.

### Medium

**B1. Confirmations don't record the evidence behind them.**
A confirmed line is keyed by adjustment, date, amount and description, not by the GL batch it was
matched to. If a re-match changes the batch behind a line (today's fixes did this), the
confirmation still shows ✓ for evidence nobody looked at.
- *Recommend:* include the GL batch in the key, so the line goes back to "To check" when its match
  changes.

**B2. Changing how a deposit counts needs no reason.**
Overriding a statement-settled deposit in transit requires a note. Changing a deposit to revenue or
not revenue, leaving out a GL finding, or switching a Stripe line doesn't. The log records who and
when, but not why.
- *Recommend:* require a short reason whenever a person goes against the GL or a rule, and show it
  in the export.

**B3. A typed adjustment covers a GL finding by amount alone.**
A typed or workbook adjustment of the same amount suppresses a GL finding (so they don't double
count), even if they're about different things. A 100 typed for one reason can hide an unrelated
100 chargeback.
- *Recommend:* also require the same account and kind, and show the pairing ("covers GL …").

**B4. Transfers between our accounts found by amount (≥ 1,000, within 5 days).**
A donor gift that happens to equal a payment out of another of our accounts is taken out as a
transfer. It's caught when the GL booked it as revenue (it goes to "to decide"), but not when the
other account's statement isn't attached, or the GL booked it the same wrong way.
- *Recommend:* show these as weak matches (A2) unless the sender names us.

**B5. The Stripe "timing" link matches by amount.**
A non-payout Stripe transfer and a later "clearing to giving" reclass are linked by the same amount
within two months. Two strays of the same amount would link arbitrarily.
- *Recommend:* acceptable at today's volumes; list it as a weak match (A2).

**B6. KeyBank cash spent before deposit** (Nov: 400 of 555 cash gifts).
The reconciliation handles it correctly, but auditors will see it as a **control finding**: cash
receipts not deposited intact. It should be reported as such, not just netted.

**B7. The June 3,018.70 release from 2052.**
January moved this Overflow gift to a liability because it "should have been sent to a different
NFP". June released it back to revenue. The reconciliation handles it, but the accounting needs
documentation: why is it BibleProject's revenue after all? An auditor will ask.

**B8. Year boundaries.**
October's opening deposits in transit are unknown (September 2025 isn't in this GL), so October
counts its own in full. That's disclosed. September 2026's closing deposits in transit need
October 2026's statements. Until they're in, September's figures are provisional and should be
marked so.

### Low

**C1. "Deposits the GL doesn't have" default to revenue.**
That's the right default: it makes a difference appear. But *Confirm revenue* clears the ⚠ while
the difference remains. The Checks tab should keep listing confirmed ones until the GL has them.

**C2. Stripe revenue comes from the Stripe CSV, a third-party report, not a bank statement.**
The payout check (CSV payouts = Stripe credits into Cass) is the right corroboration. Keep the CSV
as evidence each month.

**C3. Investment gains (balance method) depend on typed ending values.**
The app shows the working and ties to what the GL booked. Attach the statements, and use the
statement's fee rather than the GL's when they differ.

**C4. PDF reading.**
Every statement must tie to its own totals before it's used, which is good. Scanned PDFs (April)
can't be read, and figures typed instead carry the tag "typed". Keep the PDF attached.

**C5. The Wise "from BibleProject" rule and the tax-refund rule** are wording rules. They're
sound, and each is checked against the GL (to decide).

## Rules that hold up as they are

- **Cass structure:** Operating credits; Incoming added back where it wasn't swept; Outgoing only
  what swept.
- **Stripe line:** payments + refunds, with disputes and shipping/tax reclasses taken off.
- **PayPal line:** payments received, with refunds from the GL's "Payment Refund" lines and
  evidence from the statement.
- **Wise:** money out is never revenue; fees added back.
- **CDs:** interest from the schedule.
- **Investments:** Delap and Tschetter on the balance method, with fees added back.
- **Deposits in transit:** from the GL's bank dates, confirmed by the next statement; overrides
  need a reason.
- **Duplicates:** duplicate/reversal pairs dropped.
- **Chargebacks:** corroborated by the returned item.
- **Statements must tie** before they're used.
- **Every adjustment carries** its source, reason and evidence.
- **Nothing is final:** confirmations and decisions can be undone, and each is logged.

## Suggested order

1. A4: restrict access. Small change, and the biggest exposure.
2. A1: correct the evidence tags on the platform-fee and liability-release items; require Confirm
   on GL-only items above a threshold.
3. B1 and B2: confirmation tied to the GL batch; reasons for decisions.
4. A2: match confidence and the weak-match list.
5. A3: freeze at sign-off.
6. B3: coverage by amount and kind.
7. Process: B6 and B7 go to the controller; B8 goes on the September close checklist.
