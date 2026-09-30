# Month Close

BibleProject accounting's proof of cash and CDARS schedule, as a bp-vibes app. The landing page
is the fiscal-year proof of cash sheet (FY2026 = October 2025 – September 2026): click an
account's cell for a month to attach its statement or type its figures. The fixed asset module
(depreciation engine, FA listing import, JE export) is parked — its views were removed from the
app in favor of a focused proof of cash tool; the engine in `app/js/fa/` and its tests remain, and
the views are in git history. See `docs/discovery.md` for how each process works
and `CLAUDE.md` for the platform rules. **Picking this up? Start with `docs/HANDOFF.md`** — the rules, the FY2026 tie-out status and the next tasks.

- `app/` — everything that gets deployed (static HTML + ES modules, no build step).
  SheetJS is vendored at `app/vendor/xlsx.mjs` (Apache-2.0).
- `tests/` — `npm test` (node's built-in runner, no dependencies).
- `npm run serve` — preview at http://localhost:8765. Without the platform, data is kept in this
  browser's localStorage and a banner says so.
- `npm run package` — checks the deploy rules and writes `dist/monthclose.zip` for HAL's Deploy card. In the zip, `css/`, `js/` and `vendor/` sit in a folder named for the build, so a new deploy never runs with a browser's cached scripts from the last one.
- `node scripts/compare-to-workbook.mjs <app export.xlsx> <workbook.xlsx>` — month-by-month breakdown of how the app's numbers differ from the old workbook.

Never commit Acumatica exports or bank statements — `.gitignore` blocks `.xlsx` and `.pdf`.
