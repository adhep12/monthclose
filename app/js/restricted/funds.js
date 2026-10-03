// Restricted funds: a sub-ledger per fund, month by month — opening + gifts − released = ending —
// and the JE that moves the change into net assets with donor restrictions.
//
// Language funds come from the GL (gl.js keeps `grants` on each month): every Translation Support
// gift (4017) is restricted to the language its grant code names, and spending on that language's
// codes releases it. A gift with no language (grant 000, or a code that isn't a language) is
// restricted to general localization, which releases against translation spending the language's
// own fund didn't cover. Releases never take a fund below zero; spending beyond what's restricted
// is the organization's own money.
//
// Other funds (Bolthouse, Murdock…) are typed in (collection restricted-funds), each with an
// opening balance, gifts by month, and how it's released: as spent on its grant codes, or on a
// schedule (a fixed amount each month).

import { round2, sum } from '../money.js';
import { addMonths } from '../fiscal.js';

// Translation grant codes, and the language each one is restricted to. Portuguese, Spanish, French
// and Arabic have several codes (video, podcast, website, reading plans; dialects); a gift on any
// of them is for the language. 609 (department development) and 622 (Luke/Acts) are translation
// work without a language, so they're general localization.
export const TRANSLATION = {
  601: 'Afrikaans', 602: 'Arabic', 603: 'Arabic', 604: 'Arabic', 605: 'Arabic', 606: 'Arabic', 607: 'Bengali',
  608: 'Cantonese', 609: null, 610: 'Dutch', 611: 'Portuguese', 612: 'Farsi', 613: 'French', 614: 'German', 615: 'Hindi',
  616: 'Hungarian', 617: 'Indonesian', 618: 'Portuguese', 619: 'Italian', 620: 'Japanese', 621: 'Korean', 622: null,
  623: 'Malayalam', 624: 'Mandarin', 625: 'Mongolian', 626: 'Polish', 627: 'Portuguese', 628: 'Punjabi', 629: 'Romanian',
  630: 'Russian', 631: 'Slovak', 632: 'Spanish', 633: 'Swahili', 634: 'Swedish', 635: 'Tamil', 636: 'Telugu', 637: 'Thai',
  638: 'Turkish', 639: 'Vietnamese', 640: 'Urdu', 641: 'Czech', 642: 'Greek', 643: 'Marathi', 644: 'Nepali', 645: 'Kannada',
  646: 'Gujarati', 647: 'Burmese', 648: 'Finnish', 649: 'Lithuanian', 650: 'Ukrainian', 651: 'Tagalog', 652: 'Khmer',
  653: 'Norwegian', 654: 'French', 656: 'Zulu', 657: 'Bulgarian', 658: 'Amharic', 659: 'Croatian', 660: 'Kinyarwanda',
  661: 'Sinhala', 662: 'Spanish', 663: 'Spanish', 664: 'Spanish', 665: 'Portuguese', 667: 'French',
};
export const GENERAL = 'general';
export const GENERAL_NAME = 'General localization';
const isTranslation = (code) => code in TRANSLATION;
export const languageOf = (code) => TRANSLATION[code] || null;
export const codesFor = (language) => Object.keys(TRANSLATION).filter((c) => TRANSLATION[c] === language);

export const DEFAULT_RESTRICTED_CONFIG = {
  restrictedAccount: '3200',   // Net Assets Restricted - Temporarily
  offsetAccount: '3001',       // Net Assets (without donor restrictions)
  sub: '000-000',
};

// What the month's GL holds for the schedule, or null if it was loaded before grants were kept.
export const grantActivity = (gl) => (gl?.grants ? gl.grants : null);

// A typed fund's release for a month: on a schedule, `monthly` from `from` to `to` (either open).
function scheduled(fund, m) {
  if (fund.release !== 'schedule') return 0;
  if (fund.from && m < fund.from) return 0;
  if (fund.to && m > fund.to) return 0;
  return Number(fund.monthly) || 0;
}

// Runs every fund from `start` through `end`.
//   activity: { 'YYYY-MM': { gifts: { code: amt }, spend: { code: amt } } }  (missing month = no data)
//   others:   typed funds [{ id, name, opening, openingMonth, gifts: [{ month, amount, note }],
//             release: 'spend' | 'schedule', codes: ['131'], monthly, from, to }]
// Returns { months, funds: [{ id, name, kind, codes, rows: { m: { open, add, rel, end, spend } },
// unmet, ran }], gaps }. `unmet` is spending on the fund's codes that found nothing left to release,
// summed — which is how much of an opening balance from before `start` would already be spent.
export function runFunds({ activity = {}, others = [], start, end }) {
  const months = [];
  for (let m = start; m <= end; m = addMonths(m, 1)) months.push(m);
  const funds = new Map();
  const fund = (id, name, kind, codes = []) => {
    if (!funds.has(id)) funds.set(id, { id, name, kind, codes, rows: {}, bal: 0, unmet: 0, ran: false });
    return funds.get(id);
  };
  fund(GENERAL, GENERAL_NAME, 'general');
  for (const o of others) {
    const f = fund(`other:${o.id}`, o.name, 'other', o.release === 'spend' ? (o.codes || []) : []);
    f.def = o;
  }
  const gaps = months.filter((m) => !activity[m]);

  for (const m of months) {
    const a = activity[m] || { gifts: {}, spend: {} };
    const add = {};
    const plus = (id, v) => { add[id] = round2((add[id] || 0) + v); };
    for (const [code, amt] of Object.entries(a.gifts || {})) {
      const lang = languageOf(code);
      if (lang) { fund(`lang:${lang}`, lang, 'language', codesFor(lang)); plus(`lang:${lang}`, amt); }
      else plus(GENERAL, amt);
    }
    // (Anything typed for before the schedule starts comes in with its first month.)
    const at = (x) => (x && x < start ? start : x);
    for (const f of funds.values()) {
      if (f.kind !== 'other') continue;
      const o = f.def;
      // The opening balance is there at the start of its month, before that month's gifts.
      if (at(o.openingMonth) === m) f.bal = round2(f.bal + (Number(o.opening) || 0));
      for (const g of o.gifts || []) if (at(g.month) === m) plus(f.id, Number(g.amount) || 0);
    }
    // Spending by language; translation spending with no language goes to general localization.
    const spendLang = {};
    let generalSpend = 0;
    for (const [code, amt] of Object.entries(a.spend || {})) {
      if (!isTranslation(code)) continue;
      const lang = languageOf(code);
      if (lang) spendLang[lang] = (spendLang[lang] || 0) + amt; else generalSpend += amt;
    }
    for (const lang of Object.keys(spendLang)) fund(`lang:${lang}`, lang, 'language', codesFor(lang));

    const release = (f, wanted) => {
      const avail = round2(f.bal + (add[f.id] || 0));
      const rel = round2(Math.max(0, Math.min(Math.max(wanted, 0), avail)));
      if (wanted > rel) f.unmet = round2(f.unmet + wanted - rel);
      return rel;
    };
    let uncovered = generalSpend;
    for (const f of funds.values()) {
      const open = f.bal;
      let rel = 0, spend = 0;
      if (f.kind === 'language') {
        spend = round2(spendLang[f.name] || 0);
        rel = release(f, spend);
        uncovered += spend - rel;
      } else if (f.kind === 'other') {
        spend = f.def.release === 'spend' ? round2(sum(f.codes, (c) => a.spend?.[c] || 0)) : scheduled(f.def, m);
        rel = release(f, spend);
      } else continue;
      f.bal = round2(open + (add[f.id] || 0) - rel);
      if (open || add[f.id] || rel || spend) f.ran = true;
      f.rows[m] = { open, add: add[f.id] || 0, rel, end: f.bal, spend };
    }
    const g = funds.get(GENERAL);
    const gOpen = g.bal, gSpend = round2(uncovered);
    const gRel = release(g, gSpend);
    g.bal = round2(gOpen + (add[GENERAL] || 0) - gRel);
    if (gOpen || add[GENERAL] || gRel) g.ran = true;
    g.rows[m] = { open: gOpen, add: add[GENERAL] || 0, rel: gRel, end: g.bal, spend: gSpend };
  }

  // Months before a fund first appears have nothing in them.
  for (const f of funds.values()) for (const m of months) f.rows[m] ||= { open: 0, add: 0, rel: 0, end: 0, spend: 0 };
  const order = { language: 0, general: 1, other: 2 };
  const list = [...funds.values()].map(({ bal, ...f }) => f)
    .sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name));
  return { months, funds: list, gaps };
}

// Opening, gifts, released and ending over a span of months (a month, or a fiscal year to date).
export function span(f, from, to) {
  const ms = Object.keys(f.rows).filter((m) => m >= from && m <= to).sort();
  if (!ms.length) return { open: 0, add: 0, rel: 0, end: 0, spend: 0 };
  return {
    open: f.rows[ms[0]].open, end: f.rows[ms[ms.length - 1]].end,
    add: round2(sum(ms, (m) => f.rows[m].add)), rel: round2(sum(ms, (m) => f.rows[m].rel)), spend: round2(sum(ms, (m) => f.rows[m].spend)),
  };
}

export function totals(funds, from, to) {
  const s = funds.map((f) => span(f, from, to));
  const t = (k) => round2(sum(s, (x) => x[k]));
  return { open: t('open'), add: t('add'), rel: t('rel'), end: t('end'), spend: t('spend') };
}

const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The month's reclass: the change in what's restricted (gifts less releases), moved between net
// assets without and with donor restrictions. One pair of lines per fund that moved.
export function restrictedJe(result, month, cfg = DEFAULT_RESTRICTED_CONFIG, names = {}) {
  const lines = [];
  const desc = (a) => names[a] || '';
  for (const f of result.funds) {
    const r = f.rows[month];
    if (!r) continue;
    const change = round2(r.add - r.rel);
    if (!change) continue;
    const what = `${f.kind === 'language' ? `${f.name} translation` : f.name}: ${[r.add ? `gifts ${fmt(r.add)}` : '', r.rel ? `released ${fmt(r.rel)}` : ''].filter(Boolean).join(', ')}`;
    const up = change > 0;
    lines.push({ account: cfg.offsetAccount, description: desc(cfg.offsetAccount), sub: cfg.sub, debit: up ? change : 0, credit: up ? 0 : -change, tranDescription: what });
    lines.push({ account: cfg.restrictedAccount, description: desc(cfg.restrictedAccount), sub: cfg.sub, debit: up ? 0 : -change, credit: up ? change : 0, tranDescription: what });
  }
  return lines;
}

// How far back the schedule reaches, and what that leaves unknown: a fund that never ran short
// (every dollar spent on it found restricted money) would carry any balance from before `start`
// straight through to today. Months with no GL break the chain.
export function openingNotes(result) {
  const notes = [];
  for (const f of result.funds) {
    if (!f.ran || f.kind === 'other') continue;
    if (f.unmet > 0) continue;
    notes.push({ fund: f.name, text: `${f.name} never ran short since ${result.months[0]}, so any balance it had before then would still be here — it isn’t counted.` });
  }
  return notes;
}
