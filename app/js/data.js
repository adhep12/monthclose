// Collections (declared in vibes.json):
//   fa-assets       one record per asset, key = asset id
//   fa-closes       saved monthly depreciation JEs, key = 'YYYY-MM'
//   trial-balances  uploaded Trial Balance Summary exports, key = 'YYYY-MM' (the TB's period)
//   settings        app configuration, keys 'fa-config', 'poc-config'
//   poc-months      proof of cash, key = 'YYYY-MM'
//   gl-activity     net activity per account from a GL register upload, key = 'YYYY-MM'
//   statements      (files) the bank statement PDFs behind each proof of cash
//   soa             Statement of Activities uploads, key = 'YYYY-MM'
//   cds             the CDARS schedule, one record per CD, key = CD account ID

import * as store from './store.js';
import { DEFAULT_FA_CONFIG } from './fa/je.js';
import { DEFAULT_POC_CONFIG } from './poc/calc.js';

let assetsCache = null;
let configCache = null;

export async function loadAssets({ fresh = false } = {}) {
  if (!assetsCache || fresh) assetsCache = await store.listAll('fa-assets');
  return assetsCache;
}

export async function saveAsset(asset) {
  const { key, ...data } = asset;
  const id = asset.id || key;
  await store.upsert('fa-assets', id, { ...data, id }, { tag: data.disposal ? 'disposed' : 'active' });
  if (assetsCache) {
    const i = assetsCache.findIndex((a) => a.id === id);
    const rec = { key: id, ...data, id };
    if (i >= 0) assetsCache[i] = rec; else assetsCache.push(rec);
  }
}

export async function deleteAsset(id) {
  await store.remove('fa-assets', id);
  if (assetsCache) assetsCache = assetsCache.filter((a) => a.id !== id);
}

export async function loadConfig() {
  if (!configCache) {
    const saved = await store.get('settings', 'fa-config');
    configCache = mergeConfig(saved);
  }
  return configCache;
}

function mergeConfig(saved) {
  const d = structuredClone(DEFAULT_FA_CONFIG);
  if (!saved) return d;
  return {
    ...d, ...saved,
    expense: { ...d.expense, ...saved.expense },
    disposal: { ...d.disposal, ...saved.disposal },
    accountNames: { ...d.accountNames, ...saved.accountNames },
    groups: saved.groups?.length ? saved.groups : d.groups,
  };
}

export async function saveConfig(cfg) {
  await store.upsert('settings', 'fa-config', cfg);
  configCache = cfg;
}

export async function loadCloses() {
  return store.listAll('fa-closes');
}

export async function loadClose(month) {
  return store.get('fa-closes', month);
}

export async function saveClose(month, data) {
  await store.upsert('fa-closes', month, data);
}

export async function removeClose(month) {
  await store.remove('fa-closes', month);
}

export async function loadTrialBalances() {
  return store.listAll('trial-balances');
}

export async function loadTrialBalance(month) {
  return store.get('trial-balances', month);
}

export async function saveTrialBalance(tb) {
  await store.upsert('trial-balances', tb.month, tb);
  // Keep the account names the JE export uses in step with the latest TB.
  const cfg = await loadConfig();
  const names = Object.fromEntries(Object.entries(tb.accounts).map(([a, x]) => [a, x.description]));
  await saveConfig({ ...cfg, accountNames: { ...cfg.accountNames, ...names } });
}

export async function removeTrialBalance(month) {
  await store.remove('trial-balances', month);
}

// ---- Proof of cash ------------------------------------------------------------------------

export async function loadPocConfig() {
  const saved = await store.get('settings', 'poc-config');
  const cfg = { ...DEFAULT_POC_CONFIG, ...(saved || {}) };
  // Settings saved earlier carry a copy of the account lists; an account added to the built-in
  // list (4030, OneStory rent) counts whatever the copy says.
  for (const k of ['revenueAccounts', 'interestAccounts']) cfg[k] = [...new Set([...(DEFAULT_POC_CONFIG[k] || []), ...(saved?.[k] || [])])];
  return cfg;
}

export async function savePocConfig(cfg) {
  await store.upsert('settings', 'poc-config', cfg);
}

export async function loadPocMonth(month) {
  return store.get('poc-months', month);
}

export async function loadPocMonths() {
  return store.listAll('poc-months');
}

// Plain put, not upsert: the page read this record when it opened, so if someone else saved it
// since, the platform rejects this write (err.conflict) instead of silently overwriting them.
export async function savePocMonth(rec) {
  await store.put('poc-months', rec.month, rec);
}

// For imports, where overwriting what's there is the point.
export async function replacePocMonth(rec) {
  await store.upsert('poc-months', rec.month, rec);
}

export async function loadGlActivity(month) {
  return store.get('gl-activity', month);
}

export async function listGlActivity() {
  return store.listAll('gl-activity');
}

export async function saveGlActivity(rec) {
  await store.upsert('gl-activity', rec.month, rec);
}

// ---- CD schedule ----------------------------------------------------------------------------

export async function loadCds() {
  return store.listAll('cds');
}

export async function saveCd(cd) {
  const { key, ...data } = cd;
  await store.upsert('cds', cd.id, data, { tag: cd.status || 'active' });
}

export async function deleteCd(id) {
  await store.remove('cds', id);
}

export async function loadSoa(month) {
  return store.get('soa', month);
}

export async function listSoa() {
  return store.listAll('soa');
}

export async function saveSoa(rec) {
  await store.upsert('soa', rec.month, rec);
}

// ---- Salesforce giving (the opportunity summary by close date and payment method), by month ----

export async function listSfGiving() {
  return store.listAll('sf-giving');
}

export async function saveSfGiving(rec) {
  await store.upsert('sf-giving', rec.month, rec);
}
