// Loading a GL Register Detailed export: each month it covers is saved (gl-activity), compared with
// its last upload batch by batch, and what changed is reported. Used by the proof of cash sheet and
// the restricted funds page, so both keep the same history.

import { ask, notify, toast } from './ui.js';
import { readWorkbook } from './xlsx-io.js';
import { parseGlRegister, glChanges } from './gl.js';
import { saveGlActivity } from './data.js';
import { explain } from './store.js';
import { nowIso } from './audit.js';
import { money } from './money.js';
import { monthName } from './fiscal.js';

const short = (m) => monthName(m, { short: true });

// glBy: the months already loaded, by month. onSaved(g) is called with each month as it's saved.
export async function uploadGlRegister(file, { user, glBy = {}, onSaved = () => {} }) {
  try {
    toast(`Reading ${file.name}… a full year takes a few seconds.`);
    const { XLSX, wb } = await readWorkbook(file);
    const res = parseGlRegister(XLSX, wb);
    if (!(await ask('Load GL register', `${res.lines.toLocaleString()} journal lines for ${res.periods.map((p) => short(p.month)).join(', ')}. Each month is compared with its last upload, batch by batch: anything added, changed or removed is listed and kept in the month's GL history.`, { ok: `Load ${res.periods.length} months` }))) return false;
    const report = [];
    for (const p of res.periods) {
      const before = glBy[p.month];
      const ch = glChanges(before, p);
      const entry = { at: nowIso(), by: user, file: file.name, runAt: res.runAt, batches: Object.keys(p.index).length,
        ...(ch ? { added: ch.added.map((x) => x.batch), changed: ch.changed, removed: ch.removed } : { first: true }) };
      const g = { ...p, fileName: file.name, runAt: res.runAt, uploadedBy: user, uploadedAt: nowIso(), history: [...(before?.history || []), entry].slice(-24) };
      await saveGlActivity(g); glBy[p.month] = g; onSaved(g);
      if (ch && (ch.added.length || ch.changed.length || ch.removed.length)) {
        report.push(`${monthName(p.month)}: ${[ch.added.length ? `${ch.added.length} new` : '', ch.changed.length ? `${ch.changed.length} changed (${ch.changed.slice(0, 4).map((x) => `${x.batch} ${money(x.was, { dash: false })} → ${money(x.now, { dash: false })}`).join(', ')}${ch.changed.length > 4 ? '…' : ''})` : '', ch.removed.length ? `${ch.removed.length} removed (${ch.removed.slice(0, 4).map((x) => `${x.batch} ${x.desc}`).join(', ')}${ch.removed.length > 4 ? '…' : ''})` : ''].filter(Boolean).join(' · ')}`);
      }
    }
    if (report.length) await notify('GL loaded — what changed since the last upload', report);
    else toast(`GL loaded for ${res.periods.length} months — nothing changed in months uploaded before.`);
    return true;
  } catch (err) { notify('Couldn’t load the GL register', [explain(err, '')]); return false; }
}
