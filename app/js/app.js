import { h, mount, toast } from './ui.js';
import { initStore, storeMode } from './store.js';
import { monthName } from './fiscal.js';

// Proof of cash (the fiscal-year sheet; everything about a month opens in pop-ups on it), the CD
// schedule, and the audit prep pages, each on its own tab. An old month link (#/poc/2026-07) opens
// the sheet with that month open.
const routes = [
  [/^#?\/?$/, () => import('./views/poc-year.js')],
  [/^#\/poc$/, () => import('./views/poc-year.js')],
  [/^#\/poc\/(\d{4}-\d{2})$/, () => import('./views/poc-year.js')],
  [/^#\/poc\/import$/, () => import('./views/poc-import.js')],
  [/^#\/cds$/, () => import('./views/cds.js')],
  [/^#\/checklist$/, () => import('./views/checklist.js')],
  [/^#\/balance-sheet$/, () => import('./views/balance-sheet.js')],
  [/^#\/restricted$/, () => import('./views/restricted.js')],
  [/^#\/governance$/, () => import('./views/governance.js')],
  [/^#\/inventory$/, () => import('./views/inventory.js')],
  [/^#\/assets$/, () => import('./views/assets.js')],
  [/^#\/binder$/, () => import('./views/binder.js')],
];

const TABS = [
  ['#/checklist', 'Checklist', (hash) => hash.startsWith('#/checklist')],
  ['#/poc', 'Proof of cash', (hash) => hash === '' || hash === '#/' || hash.startsWith('#/poc')],
  ['#/cds', 'CD schedule', (hash) => hash.startsWith('#/cds')],
  ['#/balance-sheet', 'Balance sheet', (hash) => hash.startsWith('#/balance-sheet')],
  ['#/restricted', 'Restricted funds', (hash) => hash.startsWith('#/restricted')],
  ['#/governance', 'Governance', (hash) => hash.startsWith('#/governance')],
  ['#/inventory', 'Inventory', (hash) => hash.startsWith('#/inventory')],
  ['#/assets', 'Fixed assets', (hash) => hash.startsWith('#/assets')],
  ['#/binder', 'Audit binder', (hash) => hash.startsWith('#/binder')],
];

let user = null;

async function greet() {
  try {
    const auth = await import('/_shared/auth.js');
    await auth.loadPermissions();
    user = { name: auth.getFullName(), first: auth.getFirstName(), email: auth.getEmail() };
  } catch { /* no platform (local preview) — carry on */ }
}

export function currentUser() {
  return user?.name || user?.email || 'Unknown user';
}

let renderSeq = 0;
let shown = { hash: null, main: null };

// Redraw the page after a change without it flashing: the new page is drawn out of sight on top of
// the old one and swapped in when it's ready, so scroll position and anything open stay put.
async function softRender() {
  const hash = location.hash || '#/';
  if (shown.hash !== hash || !shown.main?.isConnected) return render();
  const seq = ++renderSeq;
  const match = routes.find(([re]) => re.test(hash));
  if (!match) return render();
  const params = hash.match(match[0]).slice(1).map(decodeURIComponent);
  const next = h('main', { class: 'content' });
  Object.assign(next.style, { position: 'absolute', left: '0', right: '0', top: `${shown.main.offsetTop}px`, visibility: 'hidden', pointerEvents: 'none' });
  shown.main.parentNode.append(next);
  const y = window.scrollY;
  try {
    const mod = await match[1]();
    await mod.default(next, { params, month: params[0], rerender: softRender, monthName, user: currentUser() });
    if (seq !== renderSeq) { next.remove(); return; }
    const x = [...shown.main.querySelectorAll('.sheet')].map((el) => el.scrollLeft);
    next.removeAttribute('style');
    shown.main.replaceWith(next);
    shown.main = next;
    const put = () => { next.querySelectorAll('.sheet').forEach((el, i) => { if (x[i] != null && el.scrollLeft !== x[i]) el.scrollLeft = x[i]; }); };
    put();
    window.scrollTo(0, y);
    // Once more after layout settles (the frame can reflow as the swap lands).
    requestAnimationFrame(() => { put(); window.scrollTo(0, y); });
  } catch (err) {
    next.remove();
    console.error(err);
    toast(err?.message || String(err), 'error');
  }
}

export async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const root = document.getElementById('app');
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'Month Close'), h('span', { class: 'muted' }, 'BibleProject Accounting')),
    h('nav', { class: 'tabs-top' }, TABS.map(([href, label, active]) => h('a', { href, class: active(hash) ? 'active' : '' }, label))),
    h('span', { class: 'who muted' }, user?.first ? `Hi, ${user.first}` : ''));
  const banner = storeMode() === 'local'
    ? h('div', { class: 'banner warn' }, 'Preview mode: the platform storage isn’t reachable, so anything you save stays in this browser only. Deploy to bp-vibes to share data.')
    : null;
  const main = h('main', { class: 'content' }, h('p', { class: 'muted' }, 'Loading…'));
  mount(root, header, banner, main);
  shown = { hash, main };

  const match = routes.find(([re]) => re.test(hash));
  if (!match) { mount(main, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/poc' }, 'Back to proof of cash'))); return; }
  const params = hash.match(match[0]).slice(1).map(decodeURIComponent);
  try {
    const mod = await match[1]();
    if (seq !== renderSeq) return;
    await mod.default(main, { params, month: params[0], rerender: softRender, monthName, user: currentUser() });
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    mount(main, h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, err?.message || String(err)),
      h('p', {}, h('button', { class: 'btn', onclick: render }, 'Try again')));
    if (err?.signedOut) toast('Signing you in again…');
  }
}

window.addEventListener('hashchange', render);
// A file dropped anywhere that isn't a drop target shouldn't make the browser open it and leave
// the app.
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
await Promise.all([greet(), initStore()]);
render();
