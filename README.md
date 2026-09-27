# Month Close

BibleProject accounting's month-end processes as a bp-vibes app: fixed asset depreciation today;
CD interest, proof of cash and inventory next. See `docs/discovery.md` for how each process works
and `CLAUDE.md` for the platform rules.

- `app/` — everything that gets deployed (static HTML + ES modules, no build step).
  SheetJS is vendored at `app/vendor/xlsx.mjs` (Apache-2.0).
- `tests/` — `npm test` (node's built-in runner, no dependencies).
- `npm run serve` — preview at http://localhost:8765. Without the platform, data is kept in this
  browser's localStorage and a banner says so.
- `npm run package` — checks the deploy rules and writes `dist/monthclose.zip` for HAL's Deploy card.

Never commit Acumatica exports or bank statements — `.gitignore` blocks `.xlsx` and `.pdf`.
