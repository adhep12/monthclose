// Records store. Uses the platform's /_shared/data.js when it's there; otherwise (opening the
// file locally, a preview) falls back to this browser's localStorage so the app still works —
// with a banner saying the data isn't saved anywhere else.

let backend = null;
let mode = 'loading';

const LOCAL_PREFIX = 'monthclose:local:';

const local = {
  _read(col) {
    try { return JSON.parse(localStorage.getItem(LOCAL_PREFIX + col) || '{}'); } catch { return {}; }
  },
  _write(col, obj) { localStorage.setItem(LOCAL_PREFIX + col, JSON.stringify(obj)); },
  async get(col, key) { return this._read(col)[key] || null; },
  async list(col, opts = {}) {
    const all = Object.values(this._read(col));
    const filtered = opts.tag ? all.filter((r) => r.tag === opts.tag) : all;
    const off = opts.offset || 0;
    return filtered.slice(off, off + (opts.limit || 500));
  },
  async put(col, key, rec) {
    const all = this._read(col);
    all[key] = { key, ...rec, updatedAt: new Date().toISOString() };
    this._write(col, all);
    return all[key];
  },
  async remove(col, key) {
    const all = this._read(col);
    delete all[key];
    this._write(col, all);
  },
};

export async function initStore() {
  try {
    const mod = await import('/_shared/data.js');
    backend = mod.records;
    mode = 'platform';
  } catch {
    backend = local;
    mode = 'local';
  }
  return mode;
}

export function storeMode() { return mode; }

export async function get(col, key) {
  const r = await backend.get(col, key);
  return r ? r.data ?? null : null;
}

// Pages through list() — the platform returns at most 500 per call.
export async function listAll(col, opts = {}) {
  const out = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await backend.list(col, { ...opts, limit, offset });
    out.push(...page);
    if (page.length < limit) break;
  }
  return out.map((r) => ({ key: r.key, ...r.data }));
}

export async function put(col, key, data, extra = {}) {
  return backend.put(col, key, { data, ...extra });
}

export async function remove(col, key) {
  return backend.remove(col, key);
}

// Read-then-write so a record we haven't loaded on this page doesn't trip the platform's
// conflict check, which treats "never read" as "might overwrite someone".
export async function upsert(col, key, data, extra = {}) {
  try { await backend.get(col, key); } catch { /* ignore — put will surface real errors */ }
  return put(col, key, data, extra);
}

export function explain(err, fallback = 'Something went wrong.') {
  if (err?.signedOut) return 'Signing you in again…';
  if (err?.full) return 'This app is out of storage space. Nothing was deleted — ask the app owner to free space in HAL.';
  if (err?.conflict) return 'Someone else changed this at the same time. Reload to see their version, then try again.';
  return `${fallback} ${err?.message || ''}`.trim();
}
