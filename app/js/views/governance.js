// Governance documents: board minutes, COI disclosures, the signatory list and the CC compilation,
// in one place, with what's current for the fiscal year at a glance.

import { h, mount, table, toast, panel, ask, field, select, statusPill } from '../ui.js';
import { listGovernanceDocs, saveGovernanceDoc, deleteGovernanceDoc } from '../data.js';
import { DOC_TYPES, typeLabel, governanceStatus, docFy, docName, ccPeriods } from '../governance/docs.js';
import { uploadFile, fileUrl, removeFile, filesAvailable, explain } from '../store.js';
import { renamed } from '../naming.js';
import { nowIso, when } from '../audit.js';
import { monthName, fiscalYear, currentMonth } from '../fiscal.js';

const FY_KEY = 'monthclose:gov-fy';
const TYPE_KEY = 'monthclose:gov-type';
const COL = 'governance-files';
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* ignore */ } return null; };
const today = () => new Date().toISOString().slice(0, 10);
const short = (m) => monthName(m, { short: true });

export default async function (main, { user, rerender }) {
  const docs = await listGovernanceDocs();
  const nowFy = fiscalYear(currentMonth());
  const fy = Number(pref(FY_KEY)) || nowFy;
  const type = pref(TYPE_KEY) || '';
  const years = [...new Set([nowFy, fy, ...docs.map(docFy).filter(Boolean)])].sort((a, b) => b - a);
  const s = governanceStatus(docs, fy, today());
  const set = (k, v) => { pref(k, v); rerender(); };

  const shown = docs.filter((d) => docFy(d) === fy || (d.type === 'signatory-list' && d === s.signatories.current))
    .filter((d) => !type || d.type === type)
    .sort((a, b) => (b.date || b.period || '').localeCompare(a.date || a.period || ''));

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Governance — FY${fy}`),
        h('p', { class: 'muted' }, 'Board minutes, conflict of interest disclosures, the signatory list and the CC compilation, kept together for the audit.')),
      h('div', { class: 'actions' },
        h('label', { class: 'month-pick' }, h('span', {}, 'Fiscal year'), select(years.map((y) => [String(y), `FY${y}`]), String(fy), { onchange: (e) => set(FY_KEY, e.target.value) })),
        h('button', { class: 'primary', onclick: () => addDoc({ user, fy, rerender }) }, 'Add a document…'))),
    filesAvailable() ? null : h('div', { class: 'notice warn' }, 'File storage isn’t available here (local preview), so documents are listed without their files.'),

    h('div', { class: 'cards wide' },
      card('Board minutes', s.minutes.length ? statusPill(`${s.minutes.length} meeting${s.minutes.length === 1 ? '' : 's'}`, 'good') : statusPill('None yet', 'neutral'),
        s.minutes.length ? h('p', { class: 'small' }, `Latest: ${s.minutes[0].date}.`) : h('p', { class: 'small muted' }, 'No minutes for this year yet.'),
        s.monthsWithout.length ? h('p', { class: 'small muted' }, `No minutes dated in ${s.monthsWithout.map(short).join(', ')}.`) : null),
      card('COI disclosures', !s.coi.length ? statusPill('None yet', 'neutral') : s.coiCurrent === s.coi.length ? statusPill('All filed', 'good') : statusPill(`${s.coi.length - s.coiCurrent} not filed`, 'warn'),
        s.coi.length ? h('p', { class: 'small' }, `${s.coiCurrent} of ${s.coi.length} filed for FY${fy}.`) : h('p', { class: 'small muted' }, 'Everyone who has filed in any year is expected again each year.'),
        s.coi.filter((c) => !c.current).length ? h('p', { class: 'small muted' }, `Not yet: ${s.coi.filter((c) => !c.current).map((c) => `${c.person}${c.latest ? ` (last FY${c.latest})` : ''}`).join(', ')}.`) : null),
      card('Signatory list', s.signatories.current ? statusPill(`Current as of ${s.signatories.current.date}`, 'good') : statusPill('None yet', 'neutral'),
        s.signatories.history.length ? h('p', { class: 'small muted' }, `Replaces ${s.signatories.history.length} earlier version${s.signatories.history.length === 1 ? '' : 's'} (${s.signatories.history.map((d) => d.date).join(', ')}).`) : null),
      card('CC compilation', null, h('div', { class: 'recon' }, s.cc.map((c) => h('div', { class: 'recon-row' },
        h('span', {}, `Through ${short(c.period)}`),
        c.state === 'done' ? statusPill('Done', 'good') : c.state === 'due' ? statusPill('Due', 'warn') : statusPill('Not yet', 'neutral')))))),

    h('div', { class: 'row', style: { marginTop: '1rem' } }, h('h2', {}, 'Documents'), h('span', { class: 'spacer' }),
      select([['', 'All types'], ...DOC_TYPES.map((t) => [t.id, t.label])], type, { onchange: (e) => set(TYPE_KEY, e.target.value) })),
    table([
      { label: 'Type', cell: (d) => typeLabel(d.type) },
      { label: 'For', cell: (d) => (d.type === 'coi' ? `${d.person} · FY${d.fy}` : d.type === 'cc-compilation' ? `Through ${short(d.period)}` : d.date) },
      { label: 'File', cell: (d) => (d.fileKey ? h('button', { class: 'link', onclick: () => openDoc(d) }, d.fileName) : h('span', { class: 'muted' }, d.fileName || 'no file')) },
      { label: 'Note', cell: (d) => d.note || '' },
      { label: 'Added', cell: (d) => h('span', { class: 'muted small' }, `${d.uploadedBy || ''} · ${when(d.uploadedAt)}`) },
      { label: '', cell: (d) => h('button', { class: 'small-btn', onclick: () => removeDoc(d, rerender) }, 'Remove') },
    ], shown, { empty: `Nothing for FY${fy} yet.` }));
}

function card(title, pill, ...body) {
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, title), h('span', { class: 'spacer' }), pill), ...body);
}

async function openDoc(d) {
  try {
    const url = await fileUrl(COL, d.fileKey);
    if (url) window.open(url, '_blank', 'noopener'); else toast('That file isn’t available.', 'error');
  } catch (err) { toast(explain(err, 'Couldn’t open the file.'), 'error'); }
}

async function removeDoc(d, rerender) {
  if (!(await ask('Remove this document?', `${typeLabel(d.type)} ${d.fileName || ''} is deleted from the app, file and all. This can’t be undone.`, { ok: 'Remove', danger: true }))) return;
  try {
    await deleteGovernanceDoc(d.id);
    if (d.fileKey) await removeFile(COL, d.fileKey).catch(() => {});
    toast('Removed.'); rerender();
  } catch (err) { toast(explain(err, 'Couldn’t remove it.'), 'error'); }
}

function addDoc({ user, fy, rerender }) {
  panel('Add a governance document', (body, close) => {
    let file = null;
    const kind = select(DOC_TYPES.map((t) => [t.id, t.label]), 'board-minutes');
    const date = h('input', { type: 'date', value: today() });
    const person = h('input', { placeholder: 'Full name' });
    const coiFy = h('input', { type: 'number', value: fy, min: 2000, max: 2100 });
    const period = select(ccPeriods(fy).map((m) => [m, `Four months through ${monthName(m)}`]), ccPeriods(fy).find((m) => m < currentMonth()) || ccPeriods(fy)[0]);
    const note = h('input', { placeholder: 'Optional' });
    const input = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', onchange: () => { file = input.files[0] || null; } });
    const dateField = field('Date', date), personField = field('Person', person), fyField = field('Fiscal year it covers', coiFy), periodField = field('Period', period);
    const show = () => {
      const t = kind.value;
      dateField.style.display = t === 'cc-compilation' ? 'none' : '';
      dateField.querySelector('.field-label').textContent = { 'board-minutes': 'Meeting date', coi: 'Date signed', 'signatory-list': 'Effective date' }[t] || 'Date';
      personField.style.display = fyField.style.display = t === 'coi' ? '' : 'none';
      periodField.style.display = t === 'cc-compilation' ? '' : 'none';
    };
    kind.addEventListener('change', show);
    body.append(
      h('div', { class: 'form-grid' }, field('Type', kind), dateField, personField, fyField, periodField, field('Note', note)),
      field('File', input, 'A PDF (Word documents can’t be stored here, so save them as PDF first). Stored as e.g. BoardMinutes_2026-03-12.pdf.'),
      h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: async (e) => {
        const t = kind.value;
        const doc = { id: `gov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: t, category: 'governance', note: note.value.trim(), uploadedBy: user, uploadedAt: nowIso() };
        if (t === 'cc-compilation') doc.period = period.value; else doc.date = date.value;
        if (t === 'coi') { doc.person = person.value.trim(); doc.fy = Number(coiFy.value); }
        if (t !== 'cc-compilation' && !doc.date) { toast('Give it a date.', 'error'); return; }
        if (t === 'coi' && (!doc.person || !doc.fy)) { toast('A COI disclosure needs the person and the fiscal year it covers.', 'error'); return; }
        if (!file) { toast('Choose the file.', 'error'); return; }
        e.target.disabled = true;
        try {
          doc.fileName = docName(doc, file.name);
          doc.originalName = file.name;
          if (filesAvailable()) doc.fileKey = (await uploadFile(COL, renamed(file, doc.fileName)))?.key || null;
          await saveGovernanceDoc(doc);
          toast(`Saved as ${doc.fileName}.`); close(); rerender();
        } catch (err) { e.target.disabled = false; toast(explain(err, 'Couldn’t save it.'), 'error'); }
      } }, 'Save')));
    show();
  });
}
