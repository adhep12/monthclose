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
//   ap-aging        AP Aged Period-Sensitive uploads, key = 'YYYY-MM' (the report's period)
//   restricted-funds  restricted funds typed in (not the language funds, which come from the GL), key = fund id
//   governance-docs   board minutes, COI disclosures, signatory lists, CC compilations; key = doc id
//   governance-files  (files) the documents themselves
//   source-files    (files) uploaded trial balances and AP agings as received, for the audit binder
//   inventory-months  the monthly inventory tie-out's inputs (warehouse units, Portland count,
//                   departments' merch, product sales), key = 'YYYY-MM'

import * as store from './store.js';
import { DEFAULT_FA_CONFIG } from './fa/je.js';
import { DEFAULT_POC_CONFIG } from './poc/calc.js';
import { DEFAULT_RESTRICTED_CONFIG } from './restricted/funds.js';
import { DEFAULT_INVENTORY_CONFIG } from './inventory/tieout.js';

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
    // Saved before the disposal accounts were set up (a trial balance upload saved the defaults of
    // the time: no gain/loss account), it takes today's.
    disposal: saved.disposal?.gainLossAccount ? { ...d.disposal, ...saved.disposal } : d.disposal,
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
  // Keep the account names the JE export uses in step with the latest TB — only the names, so
  // the rest of the settings keep whatever was saved (or the built-in defaults).
  const saved = (await store.get('settings', 'fa-config')) || {};
  const names = Object.fromEntries(Object.entries(tb.accounts).map(([a, x]) => [a, x.description]));
  const next = { ...saved, accountNames: { ...(saved.accountNames || {}), ...names } };
  await store.upsert('settings', 'fa-config', next);
  configCache = mergeConfig(next);
}

export async function removeTrialBalance(month) {
  await store.remove('trial-balances', month);
}

// ---- Proof of cash ------------------------------------------------------------------------

export async function loadPocConfig() {
  const saved = await store.get('settings', 'poc-config');
  return { ...DEFAULT_POC_CONFIG, ...(saved || {}) };
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

// ---- Balance sheet checks: AP aging, cash ---------------------------------------------------

export const SOURCE_FILES = 'source-files';

export const DEFAULT_BS_CONFIG = {
  pettyCash: 300,            // 1025 never moves
  clearingThreshold: 50000,  // 1200 holding more than this either way at month end gets a warning
};

export async function loadBsConfig() {
  return { ...DEFAULT_BS_CONFIG, ...((await store.get('settings', 'bs-config')) || {}) };
}

export async function listApAging() {
  return store.listAll('ap-aging');
}

export async function saveApAging(rec) {
  await store.upsert('ap-aging', rec.month, rec);
}

// ---- Restricted funds -----------------------------------------------------------------------

export async function loadRestrictedConfig() {
  return { ...DEFAULT_RESTRICTED_CONFIG, ...((await store.get('settings', 'restricted-config')) || {}) };
}

export async function saveRestrictedConfig(cfg) {
  await store.upsert('settings', 'restricted-config', cfg);
}

export async function listRestrictedFunds() {
  return store.listAll('restricted-funds');
}

export async function saveRestrictedFund(fund) {
  const { key, ...data } = fund;
  await store.upsert('restricted-funds', fund.id, data);
}

export async function deleteRestrictedFund(id) {
  await store.remove('restricted-funds', id);
}

// ---- Governance documents -------------------------------------------------------------------

export async function listGovernanceDocs() {
  return store.listAll('governance-docs');
}

export async function saveGovernanceDoc(doc) {
  const { key, ...data } = doc;
  await store.upsert('governance-docs', doc.id, data, { tag: doc.type });
}

export async function deleteGovernanceDoc(id) {
  await store.remove('governance-docs', id);
}

// ---- Inventory -------------------------------------------------------------------------------

export async function loadInventoryConfig() {
  const saved = await store.get('settings', 'inventory-config');
  const d = structuredClone(DEFAULT_INVENTORY_CONFIG);
  if (!saved) return d;
  // Items keep their built-in fields; what was saved (costs, method) wins.
  return { ...d, ...saved, items: d.items.map((it) => ({ ...it, ...(saved.items || []).find((x) => x.id === it.id) })) };
}

export async function saveInventoryConfig(cfg) {
  await store.upsert('settings', 'inventory-config', cfg);
}

export async function listInventoryMonths() {
  return store.listAll('inventory-months');
}

export async function saveInventoryMonth(rec) {
  await store.upsert('inventory-months', rec.month, rec);
}
