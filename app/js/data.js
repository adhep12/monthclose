// Collections (declared in vibes.json):
//   fa-assets       one record per asset, key = asset id
//   fa-closes       saved monthly depreciation JEs, key = 'YYYY-MM'
//   trial-balances  uploaded Trial Balance Summary exports, key = 'YYYY-MM' (the TB's period)
//   settings        app configuration, key = 'fa-config'

import * as store from './store.js';
import { DEFAULT_FA_CONFIG } from './fa/je.js';

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
