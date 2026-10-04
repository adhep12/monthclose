// Records store. Uses the platform's /_shared/data.js when it's there; otherwise (opening the
// file locally, a preview) falls back to this browser's localStorage so the app still works —
// with a banner saying the data isn't saved anywhere else.

let backend = null;
let filesBackend = null;
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

// Reads from the records API skip the browser's HTTP cache: a cached copy of a record from before
// this page saved it would be taken for the current one, and the next save refused (409).
function noStaleReads() {
  if (typeof window === 'undefined' || !window.fetch || window.fetch.__noStale) return;
  const base = window.fetch.bind(window);
  const f = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init.method || input?.method || 'GET').toUpperCase();
    return base(input, method === 'GET' && /\/api\/data\//.test(url) && !init.cache ? { ...init, cache: 'no-store' } : init);
  };
  f.__noStale = true;
  window.fetch = f;
}

export async function initStore() {
  try {
    noStaleReads();
    const mod = await import('/_shared/data.js');
    backend = mod.records;
    filesBackend = mod.files || null;
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

// File storage (statement PDFs). Not available in local preview — callers carry on without it.
export function filesAvailable() { return !!filesBackend; }

export async function uploadFile(col, file) {
  if (!filesBackend) return null;
  return filesBackend.upload(col, file);
}

export async function fileUrl(col, key) {
  if (!filesBackend || !key) return null;
  return filesBackend.url(col, key);
}

export async function removeFile(col, key) {
  if (!filesBackend || !key) return;
  return filesBackend.remove(col, key);
}

export function explain(err, fallback = 'Something went wrong.') {
  if (err?.signedOut) return 'Signing you in again…';
  if (err?.full) return 'This app is out of storage space. Nothing was deleted — ask the app owner to free space in HAL.';
  if (err?.conflict) return 'Someone else changed this at the same time. Reload to see their version, then try again.';
  return `${fallback} ${err?.message || ''}`.trim();
}
