// Governance documents: board minutes, conflict of interest disclosures, the signatory list and the
// credit card compilation. Pure storage and tagging; this works out what's current.
//
// A document (collection governance-docs):
//   { id, type, date: 'YYYY-MM-DD', person, period: 'YYYY-MM', fileKey, fileName, originalName,
//     note, uploadedBy, uploadedAt, category: 'governance' }
//   board-minutes: date = the meeting · coi: person, date = signed (its fiscal year is the year it
//   covers) · signatory-list: date = effective · cc-compilation: period = the month it runs through.

import { fiscalYear, monthOfDate, toMonth, fyStart, addMonths } from '../fiscal.js';
import { storedName } from '../naming.js';

export const DOC_TYPES = [
  { id: 'board-minutes', label: 'Board minutes', file: 'BoardMinutes' },
  { id: 'coi', label: 'COI disclosure', file: 'COI' },
  { id: 'signatory-list', label: 'Signatory list', file: 'SignatoryList' },
  { id: 'cc-compilation', label: 'CC compilation', file: 'CCCompilation' },
];
export const typeLabel = (id) => DOC_TYPES.find((t) => t.id === id)?.label || id;

// The CC compilation is done three times a year, for the four months ending January, May and September.
export const CC_MONTHS = [1, 5, 9];
export function ccPeriods(fy) {
  return CC_MONTHS.map((mo) => toMonth(fy, mo));
}

// The fiscal year a document counts toward.
export function docFy(doc) {
  if (doc.type === 'cc-compilation' && doc.period) return fiscalYear(doc.period);
  if (doc.type === 'coi' && doc.fy) return Number(doc.fy);
  return doc.date ? fiscalYear(monthOfDate(doc.date)) : null;
}

export function docName(doc, original) {
  const t = DOC_TYPES.find((x) => x.id === doc.type);
  if (doc.type === 'coi') return storedName(t.file, `FY${doc.fy}`, original, doc.person);
  if (doc.type === 'cc-compilation') return storedName(t.file, doc.period, original);
  return storedName(t.file, doc.date, original);
}

// At a glance for one fiscal year, as of `today` ('YYYY-MM-DD'):
//   minutes:     the year's meetings, newest first, and months so far with none
//   coi:         everyone who has ever filed, and whether they've filed for this year
//   signatories: the current list and the ones it replaced
//   cc:          each of the three periods: done, due (ended, none yet) or not yet ended
export function governanceStatus(docs, fy, today) {
  const now = today.slice(0, 7);
  const inFy = docs.filter((d) => docFy(d) === fy);
  const minutes = inFy.filter((d) => d.type === 'board-minutes').sort((a, b) => b.date.localeCompare(a.date));
  const months = [];
  for (let m = fyStart(fy); m <= now && m <= addMonths(fyStart(fy), 11); m = addMonths(m, 1)) months.push(m);
  const withMinutes = new Set(minutes.map((d) => monthOfDate(d.date)));

  const people = [...new Set(docs.filter((d) => d.type === 'coi' && d.person).map((d) => d.person.trim()))].sort();
  const coi = people.map((person) => {
    const mine = docs.filter((d) => d.type === 'coi' && d.person?.trim() === person);
    const doc = mine.find((d) => docFy(d) === fy) || null;
    const latest = mine.map(docFy).filter(Boolean).sort().pop() || null;
    return { person, doc, latest, current: !!doc };
  });

  const lists = docs.filter((d) => d.type === 'signatory-list').sort((a, b) => b.date.localeCompare(a.date));
  const cc = ccPeriods(fy).map((period) => {
    const doc = docs.find((d) => d.type === 'cc-compilation' && d.period === period) || null;
    return { period, doc, state: doc ? 'done' : period < now ? 'due' : 'open' };
  });

  return {
    minutes, monthsWithout: months.filter((m) => !withMinutes.has(m)),
    coi, coiCurrent: coi.filter((c) => c.current).length,
    signatories: { current: lists[0] || null, history: lists.slice(1) },
    cc,
  };
}
