// The monthly inventory tie-out and its two JEs, as the "Monthly Inventory Tie Out" workbook does
// them.
//
// 1. Adjusting inventory: each inventory item (coffee table books, poster collection books, mugs)
//    is counted — units at the warehouse (Extensiv) plus units on hand in Portland — and valued at
//    cost. The difference from the GL is booked: inventory down (Cr 1500), the item's expense up.
//    What the Merch Distribution Sheet says departments took goes to their subaccounts; the rest is
//    Patron Care perks (020-320). Non-inventory merch departments took (apparel, accessories…) is
//    moved out of Merchandise (009-000) into their subaccounts the same way.
// 2. Reclass Stripe purchases: merch bought on the website lands in Stripe Donations (4015). The
//    Salesforce product report says how much; it moves to the merch sales accounts (and shipping
//    to Shipping - COGS). Discounts and coupons come off poster collection book sales.

import { round2, sum } from '../money.js';

export const ADJUST_JE = { batch: 7, description: 'Inventory - Adjusting Inventory Numbers' };
export const RECLASS_JE = { batch: 8, description: 'Inventory - Reclass Stripe Purchases from Sales' };

// Layers are purchases, oldest first: { units, total } (or { unitCost } for a cost with no
// purchase on record). FIFO: what's left is the newest. Average: total cost over total units.
export const DEFAULT_INVENTORY_CONFIG = {
  items: [
    { id: 'ctb', name: 'Coffee table books (How to Read)', short: 'CTB', skus: ['5100'], account: '1500', expense: '9000', perksText: 'Coffee Table Book - Perks', method: 'fifo', layers: [{ units: 10090, total: 135169.73, note: '135,169.73 / 10,090' }] },
    { id: 'pcb', name: 'Poster collection books', short: 'PCB', skus: ['4001'], account: '1505', expense: '9004', perksText: 'PCB - Perks', method: 'fifo', layers: [{ unitCost: 4.45, note: 'cost per unit' }] },
    { id: 'mug', name: 'Miir travel mugs', short: 'Mugs', skus: ['8000-TM-WHT'], account: '1506', expense: '9005', perksText: 'Mugs - Perks', method: 'fifo', layers: [{ units: 10008, total: 166466.66, note: 'first order' }, { units: 5016, total: 86854.48, note: 'new mugs' }] },
  ],
  perksSub: '020-320',
  merchSub: '009-000',
  inventorySub: '000-000',
  // Salesforce product → account for the Stripe reclass. `match` is the start of the product name
  // ("(HQ STOCK)" sales count too). Discounts come off `discountsTo`.
  stripe: { account: '4015', sub: '000-000', label: 'Stripe Donations' },
  products: [
    { id: 'ctb', match: 'How to Read the Bible: Literary Styles in Scripture', account: '4081', sub: '000-000', label: 'Coffee Table Book Sales' },
    { id: 'pcb', match: 'BibleProject Read Scripture Poster Collection Book', account: '4084', sub: '000-000', label: 'Poster Book Sales' },
    { id: 'thumb', match: 'BibleProject Video Thumb Drive', account: '4083', sub: '000-000', label: 'Thumb Drive Sales' },
    { id: 'shipping', match: 'SHIPPING', account: '9050', sub: '009-000', label: 'Shipping - COGS', exact: true },
    { id: 'mug', match: 'BibleProject Travel Mug', account: '4085', sub: '000-000', label: 'Mug Sales' },
  ],
  discounts: { match: 'DISCOUNT', to: 'pcb' },
  // A merch purchase this large is inventory, not an expense.
  inventoryThreshold: 15000,
};

// Value of `units` on hand. Returns { value, unitCost, note } — note says when there are more
// units than the purchases on record (the extra is valued at the oldest cost).
export function valueUnits(units, layers = [], method = 'fifo') {
  if (!layers.length) return { value: null, unitCost: null, note: 'No cost set up.' };
  const cost = (l) => (l.unitCost != null ? l.unitCost : l.total / l.units);
  if (method === 'average') {
    const known = layers.filter((l) => l.units);
    const c = known.length ? sum(known, (l) => l.total) / sum(known, (l) => l.units) : cost(layers[0]);
    return { value: round2(units * c), unitCost: c, note: null };
  }
  let left = units, value = 0, note = null;
  for (let i = layers.length - 1; i >= 0 && left > 0; i--) {
    const l = layers[i];
    const take = l.units == null ? left : Math.min(left, l.units);
    value += take * cost(l);
    left -= take;
  }
  if (left > 0) { value += left * cost(layers[0]); note = `${left} more units than the purchases on record; valued at the oldest cost.`; }
  return { value: round2(value), unitCost: units ? value / units : cost(layers[layers.length - 1]), note };
}

// month: { warehouse: { units: { sku } }, pdx: { [itemId]: units }, prior: { [itemId]: GL },
//          additions: { [itemId]: amount }, distribution: [lines] }
export function tieOut(month, cfg = DEFAULT_INVENTORY_CONFIG) {
  const dist = month.distribution || [];
  const inventoryAccounts = new Set(cfg.items.map((i) => i.expense));
  const items = cfg.items.map((it) => {
    const warehouse = it.skus.reduce((t, s) => t + (month.warehouse?.units?.[s] || 0), 0);
    const pdx = Number(month.pdx?.[it.id]) || 0;
    const units = warehouse + pdx;
    const v = valueUnits(units, it.layers, it.method);
    const prior = month.prior?.[it.id] ?? null;
    const additions = Number(month.additions?.[it.id]) || 0;
    const book = prior == null ? null : round2(prior + additions);
    const diff = v.value == null || book == null ? null : round2(v.value - book);
    const lines = dist.filter((d) => d.account === it.expense);
    const allocated = round2(sum(lines, (d) => d.cost));
    return { ...it, warehouse, pdx, units, value: v.value, unitCost: v.unitCost, valueNote: v.note, prior, additions, book, diff,
      unitChange: diff == null || !v.unitCost ? null : Math.round(diff / v.unitCost), allocated, perks: diff == null ? null : round2(-diff - allocated), lines };
  });
  const other = dist.filter((d) => d.account && !inventoryAccounts.has(d.account));
  const unmapped = dist.filter((d) => !d.account);
  const byAccount = {};
  for (const d of other) (byAccount[d.account] ||= { account: d.account, category: d.category, lines: [] }).lines.push(d);
  return { items, other: Object.values(byAccount).map((g) => ({ ...g, total: round2(sum(g.lines, (d) => d.cost)) })), unmapped,
    distributionTotal: round2(sum(dist, (d) => d.cost)), ready: items.every((i) => i.diff != null) };
}

const desc = (d) => `${d.item}${d.info ? ` - ${d.info}` : ''} - ${d.qty}`;
const dr = (account, sub, amount, tran) => ({ account, sub, debit: amount > 0 ? round2(amount) : 0, credit: amount < 0 ? round2(-amount) : 0, tranDescription: tran });

// The adjusting JE: per item, inventory, its perks line, then what departments took; then each
// non-inventory account moved out of Merchandise to the departments.
export function adjustingJe(t, cfg = DEFAULT_INVENTORY_CONFIG) {
  if (!t.ready) return [];
  const lines = [];
  for (const it of t.items) {
    if (it.diff) lines.push(dr(it.account, cfg.inventorySub, it.diff, 'Adjusting Inventory Numbers'));
    if (it.perks) lines.push(dr(it.expense, cfg.perksSub, it.perks, it.perksText || 'Perks'));
  }
  for (const it of t.items) for (const d of it.lines) lines.push(dr(it.expense, d.sub, d.cost, desc(d)));
  for (const g of t.other) {
    lines.push(dr(g.account, cfg.merchSub, -g.total, g.category));
    for (const d of g.lines) lines.push(dr(g.account, d.sub, d.cost, desc(d)));
  }
  return lines.filter((l) => l.debit || l.credit);
}

// The Stripe reclass for one month of the product report: { lines, groups, unmatched }.
export function stripeReclass(products = {}, cfg = DEFAULT_INVENTORY_CONFIG) {
  const groups = cfg.products.map((p) => ({ ...p, sales: 0, names: [] }));
  const matches = (p, name) => (p.exact ? name.toUpperCase() === p.match.toUpperCase() : name.toLowerCase().startsWith(p.match.toLowerCase()));
  let discounts = 0;
  for (const [name, x] of Object.entries(products)) {
    if (name.toUpperCase() === cfg.discounts.match.toUpperCase()) { discounts += x.total; continue; }
    const g = groups.find((p) => matches(p, name));
    if (g) { g.sales = round2(g.sales + x.total); g.names.push(name); }
  }
  const to = groups.find((g) => g.id === cfg.discounts.to);
  if (to) to.discounts = round2(discounts);
  for (const g of groups) g.amount = round2(g.sales + (g.discounts || 0));
  const total = round2(sum(groups, (g) => g.amount));
  if (!total) return { lines: [], groups, total, discounts };
  const lines = [dr(cfg.stripe.account, cfg.stripe.sub, total, cfg.stripe.label), ...groups.filter((g) => g.amount).map((g) => dr(g.account, g.sub, -g.amount, g.label))];
  return { lines, groups, total, discounts };
}

// Merch purchases big enough to be inventory (the GL's large merch lines, kept by gl.js).
export function largePurchases(gl, cfg = DEFAULT_INVENTORY_CONFIG) {
  return (gl?.largeMerch || []).filter((l) => Math.abs(l.amount) >= cfg.inventoryThreshold);
}

// A month's inputs for tieOut: the saved month, with the GL balances before the adjustment taken
// from the trial balance (each account at the end of the month before), or typed when there's none.
//   balances: { '1500': { end } } at the end of the prior month, or null
export function monthInputs(rec = {}, balances = null, cfg = DEFAULT_INVENTORY_CONFIG) {
  const prior = {}, priorFrom = {};
  for (const it of cfg.items) {
    const gl = balances?.[it.account]?.end;
    if (gl != null) { prior[it.id] = gl; priorFrom[it.id] = 'tb'; }
    else if (rec.priorTyped?.[it.id] != null) { prior[it.id] = rec.priorTyped[it.id]; priorFrom[it.id] = 'typed'; }
  }
  return { ...rec, prior, priorFrom };
}

// The month's JEs in the shape je/month.js imports: { batch, id, label, description, date, lines }.
export function inventoryJes(t, reclass, date, cfg = DEFAULT_INVENTORY_CONFIG) {
  const out = [];
  const adj = adjustingJe(t, cfg);
  if (adj.length) out.push({ ...ADJUST_JE, id: 'inventory', label: 'Inventory adjustment', date, lines: adj, problems: [] });
  if (reclass?.lines?.length) out.push({ ...RECLASS_JE, id: 'inventory-reclass', label: 'Reclass Stripe purchases', date, lines: reclass.lines, problems: [] });
  return out;
}
